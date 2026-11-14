import { Vault } from "./crypto";
import type { AppData } from "./data";
import { ImmutableLog, type LogView, type PreparedCommit } from "./immutable-log";
import { equal, recordKey, type Records } from "./model";

export interface ReplicaSlot {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
type ReplicaState = {
  format: "tmps-replica-v1";
  target: string;
  confirmed: LogView | null;
  seen: string[];
  pending: { commit: PreparedCommit; confirmed: LogView | null } | null;
  application: { before: Records; after: Records; view: LogView | null } | null;
  recovery: Records | null;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid causal device state.");
  return value as Record<string, unknown>;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) ||
      new Set(value).size !== value.length) throw new Error("Invalid causal device IDs.");
  return [...value].sort();
}

function records(value: unknown): Records {
  const result: Records = {};
  for (const [id, text] of Object.entries(object(value))) {
    recordKey(id);
    if (typeof text !== "string") throw new Error("Invalid causal device record.");
    result[id] = text;
  }
  return result;
}

function confirmed(value: unknown, dataset: string): LogView {
  const view = object(value);
  if (view.dataset !== dataset || !Array.isArray(view.conflicts) || view.conflicts.length ||
      !Array.isArray(view.deleted)) throw new Error("Invalid confirmed causal view.");
  const all = ids(view.ids);
  const tips = ids(view.tips);
  const data = records(view.records);
  const deleted: string[] = [];
  for (const id of view.deleted) {
    if (typeof id !== "string") throw new Error("Invalid causal deletion.");
    recordKey(id);
    if (Object.hasOwn(data, id) || deleted.includes(id)) throw new Error("Invalid causal deletion.");
    deleted.push(id);
  }
  if (tips.some((id) => !all.includes(id))) throw new Error("Invalid confirmed causal frontier.");
  return { dataset, ids: all, tips, records: data, deleted: deleted.sort(), conflicts: [] };
}

export class ReplicaConflictError extends Error {
  constructor(public view: LogView) {
    super("Concurrent record variants require explicit resolution; no local data was applied.");
  }
}

export class LogReplica {
  reloadRequired = false;
  private running = false;

  constructor(private log: ImmutableLog, private data: AppData, private slot: ReplicaSlot,
    private vault: Vault, private target: string, private dataset: string, private locks?: LockManager) {
    if (!target || !dataset) throw new Error("Replica target and dataset are required.");
  }

  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.reloadRequired) throw new Error("Reload TypingMind before further replica operations.");
    if (this.running) throw new Error("A replica operation is already running.");
    this.running = true;
    try {
      return this.locks ? await this.locks.request("tmps:immutable:" + this.target, work) : await work();
    } finally { this.running = false; }
  }

  private async read(): Promise<ReplicaState> {
    const text = await this.slot.read();
    if (text === undefined) return {
      format: "tmps-replica-v1", target: this.target, confirmed: null, seen: [], pending: null,
      application: null, recovery: null,
    };
    if (typeof text !== "string") throw new Error("Corrupt encrypted causal device state.");
    const value = object(await this.vault.open(text));
    if (value.format !== "tmps-replica-v1" || value.target !== this.target) {
      throw new Error("Causal device state belongs to another target or format.");
    }
    const state: ReplicaState = {
      format: "tmps-replica-v1", target: this.target,
      confirmed: value.confirmed === null ? null : confirmed(value.confirmed, this.dataset),
      seen: ids(value.seen), pending: null, application: null,
      recovery: value.recovery === undefined || value.recovery === null ? null : records(value.recovery),
    };
    if (value.pending !== null) {
      const pending = object(value.pending);
      const commit = object(pending.commit);
      if (typeof commit.id !== "string" || typeof commit.text !== "string" || ids([commit.id]).length !== 1) {
        throw new Error("Invalid pending immutable commit.");
      }
      state.pending = {
        commit: { id: commit.id, text: commit.text },
        confirmed: pending.confirmed === null ? null : confirmed(pending.confirmed, this.dataset),
      };
      if (state.pending.confirmed && (!state.pending.confirmed.ids.includes(commit.id) ||
          state.pending.confirmed.tips.length !== 1 || state.pending.confirmed.tips[0] !== commit.id)) {
        throw new Error("Pending commit frontier does not match its object ID.");
      }
    }
    if (value.application !== null) {
      const application = object(value.application);
      state.application = {
        before: records(application.before), after: records(application.after),
        view: application.view === null ? null : confirmed(application.view, this.dataset),
      };
    }
    return state;
  }

  private async save(state: ReplicaState): Promise<void> { await this.slot.write(await this.vault.seal(state)); }

  private check(state: ReplicaState): void {
    if (state.application) throw new Error("Interrupted local application needs recovery before further operations.");
  }

  private async remote(state: ReplicaState): Promise<LogView> {
    const view = await this.log.read([...new Set([...state.seen, ...(state.confirmed?.ids ?? [])])]);
    if (view.records) await this.data.validate(view.records);
    for (const conflict of view.conflicts) {
      for (const version of conflict.versions) {
        if (version.value !== null) await this.data.validate({ [conflict.id]: version.value });
      }
    }
    state.seen = view.ids;
    await this.save(state);
    return view;
  }

  private async flush(state: ReplicaState): Promise<void> {
    if (!state.pending) return;
    await this.log.publish(state.pending.commit);
    if (state.pending.confirmed) state.confirmed = state.pending.confirmed;
    state.seen = [...new Set([...state.seen, state.pending.commit.id])].sort();
    state.pending = null;
    await this.save(state);
  }

  async publishLocal(): Promise<LogView> {
    return this.operation(async () => {
      const state = await this.read();
      this.check(state);
      await this.remote(state);
      await this.flush(state);
      const local = await this.data.snapshot();
      await this.data.validate(local);
      const base = state.confirmed ?? {
        dataset: this.dataset, ids: [], tips: [], records: {}, deleted: [], conflicts: [],
      };
      const previous = base.records!;
      const changes: Record<string, string | null> = {};
      for (const id of new Set([...Object.keys(previous), ...Object.keys(local)])) {
        if (local[id] !== previous[id]) changes[id] = local[id] ?? null;
      }
      if (Object.keys(changes).length) {
        // Fetching remote commits must not rebase edits made against an older applied view.
        const commit = await this.log.prepare(base, changes);
        state.pending = { commit, confirmed: {
          dataset: this.dataset, ids: [...base.ids, commit.id].sort(), tips: [commit.id],
          records: local, conflicts: [],
          deleted: [...new Set([...base.deleted, ...Object.keys(previous)])]
            .filter((id) => !Object.hasOwn(local, id)).sort(),
        } };
        await this.save(state);
        await this.flush(state);
      }
      return this.remote(state);
    });
  }

  async review(): Promise<LogView> {
    return this.operation(async () => {
      const state = await this.read();
      this.check(state);
      if (state.pending) throw new Error("Retry pending immutable upload before reviewing incoming changes.");
      return this.remote(state);
    });
  }

  async applyRemote(reviewed: LogView, approve: () => Promise<boolean>): Promise<void> {
    await this.operation(async () => {
      const state = await this.read();
      this.check(state);
      if (state.pending) throw new Error("Retry pending immutable upload before applying changes.");
      const latest = await this.remote(state);
      if (latest.dataset !== reviewed.dataset || JSON.stringify(latest.ids) !== JSON.stringify(reviewed.ids)) {
        throw new Error("Remote commits changed after review; review the new view before applying.");
      }
      if (latest.records === null) throw new ReplicaConflictError(latest);
      const local = await this.data.snapshot();
      if (!equal(local, state.confirmed?.records ?? {})) {
        throw new Error("Local edits are unpublished; publish them before applying remote changes.");
      }
      await this.data.validate(latest.records);
      if (!equal(local, latest.records)) {
        if (!await approve()) throw new Error("Incoming causal changes cancelled.");
        if (!equal(await this.data.snapshot(), local)) throw new Error("Local data changed during approval; nothing applied.");
        state.recovery = local;
        state.application = { before: local, after: latest.records, view: latest };
        await this.save(state);
        await this.data.apply(local, latest.records);
        state.confirmed = latest;
        state.application = null;
        await this.save(state);
        this.reloadRequired = true;
      } else {
        state.confirmed = latest;
        await this.save(state);
      }
    });
  }

  async resolveReviewed(reviewed: LogView, choices: Record<string, string | null>,
    approve: () => Promise<boolean>): Promise<void> {
    await this.operation(async () => {
      const state = await this.read();
      this.check(state);
      if (state.pending) throw new Error("Retry pending immutable upload before resolving conflicts.");
      const latest = await this.remote(state);
      if (latest.dataset !== reviewed.dataset || JSON.stringify(latest.ids) !== JSON.stringify(reviewed.ids) ||
          !latest.conflicts.length) throw new Error("Conflict history changed; review current versions again.");
      if (Object.keys(choices).length !== latest.conflicts.length ||
          latest.conflicts.some((conflict) => !Object.hasOwn(choices, conflict.id) ||
            !conflict.versions.some((version) => version.value === choices[conflict.id]))) {
        throw new Error("Choose one reviewed version for every conflicting record.");
      }
      const local = await this.data.snapshot();
      if (!equal(local, state.confirmed?.records ?? {})) {
        throw new Error("Local edits changed after conflict review; sync them before resolving.");
      }
      if (!await approve()) throw new Error("Conflict resolution cancelled.");
      if (!equal(await this.data.snapshot(), local)) throw new Error("Local data changed during conflict approval.");
      const commit = await this.log.prepare(latest, choices);
      state.pending = { commit, confirmed: null };
      await this.save(state);
      await this.flush(state);
    });
  }

  async restoreLocal(target: Records, approve: () => Promise<boolean>): Promise<void> {
    await this.operation(async () => {
      const state = await this.read();
      this.check(state);
      if (state.pending) throw new Error("Retry pending immutable upload before restoring data.");
      await this.data.validate(target);
      const local = await this.data.snapshot();
      if (!await approve()) throw new Error("Local restore cancelled.");
      if (!equal(await this.data.snapshot(), local)) throw new Error("Local data changed during restore approval.");
      state.recovery = local;
      state.application = { before: local, after: target, view: null };
      await this.save(state);
      await this.data.apply(local, target);
      state.application = null;
      await this.save(state);
      this.reloadRequired = true;
    });
  }

  async recoverySnapshot(): Promise<Records> {
    const state = await this.read();
    const snapshot = state.application?.before ?? state.recovery;
    if (!snapshot) throw new Error("No saved local rollback exists.");
    return snapshot;
  }

  async rollback(approve: () => Promise<boolean>): Promise<void> {
    const state = await this.read();
    if (state.application) await this.recover(approve);
    else await this.restoreLocal(await this.recoverySnapshot(), approve);
  }

  async recover(approve: () => Promise<boolean>): Promise<void> {
    await this.operation(async () => {
      const state = await this.read();
      if (!state.application) throw new Error("No interrupted causal application to recover.");
      if (!await approve()) throw new Error("Causal recovery cancelled.");
      const current = await this.data.snapshot();
      await this.data.apply(current, state.application.before);
      state.application = null;
      await this.save(state);
      this.reloadRequired = true;
    });
  }
}
