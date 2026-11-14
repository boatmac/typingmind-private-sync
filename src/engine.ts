import { Vault } from "./crypto";
import type { AppData, LocalState, StateStore } from "./data";
import {
  equal, hashes, merge, validateHead, type Backup, type Conflict, type Head, type Records,
} from "./model";
import type { ObjectStore } from "./provider";

export class ApprovalRequired extends Error {
  constructor() {
    super("Incoming changes are ready. Stop editing, close other app tabs, and run manual sync to review/apply.");
  }
}

export type SyncOptions = {
  approve?: (before: Records, after: Records) => Promise<boolean>;
  resolve?: (conflicts: Conflict[]) => Promise<"local" | "remote">;
};

export class Engine {
  reloadRequired = false;
  private probed = false;
  constructor(
    private remote: ObjectStore, private data: AppData,
    private states: StateStore, private vault: Vault,
  ) {}

  private async ready(allowPending = false): Promise<LocalState> {
    if (this.reloadRequired) throw new Error("Reload TypingMind before further sync or restore operations.");
    const state = await this.states.read();
    if (state.pending && !allowPending) {
      throw new Error("An interrupted local apply needs rollback. Download local rollback and restore it before syncing.");
    }
    return state;
  }

  private async load(): Promise<{ head: Head | null; etag: string | null }> {
    const object = await this.remote.get("head.json");
    if (!object) return { head: null, etag: null };
    const head = validateHead(await this.vault.open(object.text));
    await this.data.validate(head.records);
    return { head, etag: object.etag };
  }

  private async probe(): Promise<void> {
    if (!this.probed) {
      await this.remote.probe();
      this.probed = true;
    }
  }

  private async archive(records: Records, dataset: string, label: string): Promise<Backup> {
    const backup = { id: crypto.randomUUID(), created: new Date().toISOString(), label };
    await this.remote.put(`backup-${backup.id}.json`,
      await this.vault.seal({ format: 1, dataset, records, deleted: [], backups: [] }), null);
    return backup;
  }

  async sync(options: SyncOptions = {}): Promise<string> {
    const state = await this.ready();
    await this.probe();
    const { head, etag } = await this.load();
    if (state.base && (!head || state.base.dataset !== head.dataset)) {
      throw new Error("Remote dataset disappeared or changed identity. Check endpoint/prefix; automatic reinitialization is blocked.");
    }
    const local = await this.data.snapshot();
    await this.data.validate(local);
    const merged = await merge(state.base?.hashes ?? {}, local, head?.records ?? {},
      options.resolve, head?.deleted ?? []);
    const incoming = !equal(local, merged);
    if (incoming && (!options.approve || !await options.approve(local, merged))) throw new ApprovalRequired();
    const dataset = head?.dataset ?? crypto.randomUUID();
    const deleted = [...new Set([
      ...(head?.deleted ?? []), ...Object.keys(head?.records ?? {}),
      ...Object.keys(state.base?.hashes ?? {}),
    ])].filter((id) => !Object.hasOwn(merged, id)).sort();
    const next: Head = { format: 1, dataset, records: merged, deleted, backups: [...(head?.backups ?? [])] };
    const base = { dataset, hashes: {
      ...await hashes(merged), ...Object.fromEntries(deleted.map((id) => [id, "-"])),
    } };
    let recovery = state.recovery;
    if (incoming) {
      recovery = await this.vault.seal({ format: 1, dataset, records: local, deleted: [], backups: [] });
      await this.states.write({ ...state, recovery });
    }
    if (!equal(await this.data.snapshot(), local)) throw new Error("Local data changed. Stop editing and retry sync.");
    if (!head || !equal(head.records, merged) || JSON.stringify(head.deleted) !== JSON.stringify(deleted)) {
      if (head) next.backups.push(await this.archive(head.records, dataset, "Before sync"));
      await this.remote.put("head.json", await this.vault.seal(next), etag);
    }
    if (incoming) {
      await this.states.write({ ...state, recovery, pending: true });
      await this.data.apply(local, merged);
      await this.states.write({ base, recovery, pending: false });
      this.reloadRequired = true;
      return "Synced and verified. Reload TypingMind now before editing.";
    }
    if (!equal(await this.data.snapshot(), local)) {
      throw new Error("Local data changed during upload. Remote snapshot is saved; retry sync to include newer edits.");
    }
    await this.states.write({ base, recovery, pending: false });
    return "Sync complete. No local reload needed.";
  }

  async backup(label: string): Promise<string> {
    const state = await this.ready();
    await this.probe();
    const { head, etag } = await this.load();
    if (!head) throw new Error("Run initial sync before creating a remote backup.");
    if (state.base && state.base.dataset !== head.dataset) throw new Error("Remote dataset identity changed.");
    const local = await this.data.snapshot();
    await this.data.validate(local);
    const backup = await this.archive(local, head.dataset, label.trim() || "Manual backup");
    head.backups.push(backup);
    await this.remote.put("head.json", await this.vault.seal(head), etag);
    return `Backup saved: ${backup.id}`;
  }

  async list(): Promise<Backup[]> {
    await this.ready();
    return (await this.load()).head?.backups ?? [];
  }

  async restore(id: string, approve: () => Promise<boolean>): Promise<string> {
    const state = await this.ready();
    const { head } = await this.load();
    if (!head || !head.backups.some((backup) => backup.id === id)) throw new Error("Backup not found in current dataset.");
    if (state.base && state.base.dataset !== head.dataset) throw new Error("Remote dataset identity changed.");
    const object = await this.remote.get(`backup-${id}.json`);
    if (!object) throw new Error("Backup object is missing. Nothing restored.");
    const snapshot = validateHead(await this.vault.open(object.text));
    if (snapshot.dataset !== head.dataset) throw new Error("Backup belongs to a different dataset.");
    await this.data.validate(snapshot.records);
    if (!await approve()) throw new Error("Restore cancelled.");
    return this.applyRestore(snapshot, state);
  }

  async rollback(approve: () => Promise<boolean>): Promise<string> {
    const state = await this.ready(true);
    if (!state.recovery) throw new Error("No saved local rollback exists.");
    const snapshot = validateHead(await this.vault.open(state.recovery));
    await this.data.validate(snapshot.records);
    if (!await approve()) throw new Error("Rollback cancelled.");
    return this.applyRestore(snapshot, state);
  }

  private async applyRestore(snapshot: Head, state: LocalState): Promise<string> {
    const local = await this.data.snapshot();
    const recovery = state.pending ? state.recovery :
      await this.vault.seal({ ...snapshot, records: local, deleted: [], backups: [] });
    await this.states.write({ ...state, recovery, pending: true });
    await this.data.apply(local, snapshot.records);
    await this.states.write({ ...state, recovery, pending: false });
    this.reloadRequired = true;
    return "Local restore verified. Reload now. Remote data is unchanged; a later sync publishes restored changes.";
  }

  async exportLocal(): Promise<string> {
    const records = await this.data.snapshot();
    await this.data.validate(records);
    return this.vault.seal({ format: 1, dataset: "local-export", records, deleted: [], backups: [] });
  }

  async exportRollback(): Promise<string> {
    const state = await this.states.read();
    if (!state.recovery) throw new Error("No local rollback exists.");
    return state.recovery;
  }

  async importLocal(text: string, approve: () => Promise<boolean>): Promise<string> {
    const state = await this.ready(true);
    const snapshot = validateHead(await this.vault.open(text));
    await this.data.validate(snapshot.records);
    if (!await approve()) throw new Error("Import cancelled.");
    return this.applyRestore(snapshot, state);
  }
}
