import { sha256 } from "./codec";
import { Vault } from "./crypto";
import { recordKey, type Records } from "./model";

export interface ImmutableStore {
  list(): Promise<string[]>;
  get(id: string): Promise<string | null>;
  put(id: string, text: string): Promise<void>;
}

type Changes = Record<string, string | null>;
type Commit = {
  format: "tmps-log-v1";
  dataset: string;
  parents: string[];
  changes: Changes;
};
export type PreparedCommit = { id: string; text: string };
export type LogConflict = {
  id: string;
  versions: { commits: string[]; value: string | null }[];
};
export type LogView = {
  dataset: string;
  ids: string[];
  tips: string[];
  records: Records | null;
  deleted: string[];
  conflicts: LogConflict[];
};

const objectId = /^[0-9a-f]{64}$/;
const maxCommits = 1000;

function validateIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !objectId.test(id)) ||
      new Set(ids).size !== ids.length) throw new Error("Invalid immutable commit IDs.");
  return [...ids].sort();
}

function validateChanges(value: unknown): Changes {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error("A commit must contain explicit record changes.");
  }
  const changes: Changes = {};
  for (const [id, data] of Object.entries(value)) {
    recordKey(id);
    if (typeof data !== "string" && data !== null) throw new Error("Invalid commit record value.");
    changes[id] = data;
  }
  return changes;
}

function validateCommit(value: unknown, dataset: string): Commit {
  if (!value || typeof value !== "object" ||
      !("format" in value) || value.format !== "tmps-log-v1" ||
      !("dataset" in value) || value.dataset !== dataset ||
      !("parents" in value) || !("changes" in value)) {
    throw new Error("Invalid commit or wrong dataset.");
  }
  return {
    format: "tmps-log-v1", dataset,
    parents: validateIds(value.parents), changes: validateChanges(value.changes),
  };
}

function materialize(dataset: string, commits: Map<string, Commit>): LogView {
  const ids = [...commits.keys()].sort();
  const ancestors = new Map<string, Set<string>>();
  const pending = new Set(ids);
  const tips = new Set(ids);
  for (const commit of commits.values()) {
    for (const parent of commit.parents) {
      if (!commits.has(parent)) throw new Error("Missing parent commit; refusing incomplete history.");
      tips.delete(parent);
    }
  }
  while (pending.size) {
    let progressed = false;
    for (const id of pending) {
      const commit = commits.get(id)!;
      if (commit.parents.some((parent) => !ancestors.has(parent))) continue;
      const lineage = new Set<string>();
      for (const parent of commit.parents) {
        lineage.add(parent);
        for (const ancestor of ancestors.get(parent)!) lineage.add(ancestor);
      }
      ancestors.set(id, lineage);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) throw new Error("Cyclic commit history.");
  }
  const candidates = new Map<string, { commit: string; value: string | null }[]>();
  for (const [commit, node] of commits) {
    for (const [id, value] of Object.entries(node.changes)) {
      const versions = candidates.get(id) ?? [];
      versions.push({ commit, value });
      candidates.set(id, versions);
    }
  }
  const records: Records = {};
  const deleted: string[] = [];
  const conflicts: LogConflict[] = [];
  for (const id of [...candidates.keys()].sort()) {
    const versions = candidates.get(id)!;
    const maximal = versions.filter((version) =>
      !versions.some((other) => ancestors.get(other.commit)!.has(version.commit)));
    const groups = new Map<string | null, string[]>();
    for (const version of maximal) {
      const group = groups.get(version.value) ?? [];
      group.push(version.commit);
      groups.set(version.value, group);
    }
    if (groups.size > 1) {
      conflicts.push({ id, versions: [...groups].map(([value, commits]) => ({
        value, commits: commits.sort(),
      })).sort((a, b) => {
        const left = JSON.stringify(a.value);
        const right = JSON.stringify(b.value);
        return left < right ? -1 : left > right ? 1 : 0;
      }) });
    } else {
      const value = maximal[0]!.value;
      if (value === null) deleted.push(id);
      else records[id] = value;
    }
  }
  return { dataset, ids, tips: [...tips].sort(), records: conflicts.length ? null : records, deleted, conflicts };
}

// The log itself never applies application data or deletes commit history.
export class ImmutableLog {
  constructor(private store: ImmutableStore, private vault: Vault, private dataset: string) {
    if (!dataset.trim()) throw new Error("A shared dataset identity is required.");
  }

  async read(knownIds: string[] = []): Promise<LogView> {
    const ids = validateIds(await this.store.list());
    if (ids.length > maxCommits) throw new Error("Prototype history limit exceeded; no history was discarded.");
    const available = new Set(ids);
    for (const id of validateIds(knownIds)) {
      if (!available.has(id)) throw new Error("Previously observed commit disappeared; refusing incomplete history.");
    }
    const commits = new Map<string, Commit>();
    for (const id of ids) {
      const text = await this.store.get(id);
      if (text === null) throw new Error("Listed commit is missing; refusing incomplete history.");
      if (await sha256(text) !== id) throw new Error("Commit content hash mismatch.");
      commits.set(id, validateCommit(await this.vault.open(text), this.dataset));
    }
    return materialize(this.dataset, commits);
  }

  async prepare(view: LogView, changes: Changes): Promise<PreparedCommit> {
    if (view.dataset !== this.dataset) throw new Error("Cannot publish into another dataset.");
    const ids = new Set(validateIds(view.ids));
    const parents = validateIds(view.tips);
    if (parents.some((parent) => !ids.has(parent))) throw new Error("Invalid causal frontier.");
    const commit: Commit = {
      format: "tmps-log-v1", dataset: this.dataset, parents, changes: validateChanges(changes),
    };
    const text = await this.vault.seal(commit);
    return { id: await sha256(text), text };
  }

  async publish(prepared: PreparedCommit): Promise<void> {
    if (!objectId.test(prepared.id) || await sha256(prepared.text) !== prepared.id) {
      throw new Error("Prepared commit content hash mismatch.");
    }
    validateCommit(await this.vault.open(prepared.text), this.dataset);
    const existing = await this.store.get(prepared.id);
    if (existing !== null && existing !== prepared.text) throw new Error("Immutable object was replaced.");
    if (existing === null) await this.store.put(prepared.id, prepared.text);
    if (await this.store.get(prepared.id) !== prepared.text) {
      throw new Error("Commit upload readback failed; retain the prepared commit for retry.");
    }
  }
}
