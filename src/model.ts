import { sha256 } from "./codec";

export type Records = Record<string, string>;
export type Hashes = Record<string, string>;
export type Source = "idb" | "ls";
export type Backup = { id: string; created: string; label: string };
export type Head = {
  format: 1;
  dataset: string;
  records: Records;
  deleted: string[];
  backups: Backup[];
};
export type State = { dataset: string; hashes: Hashes };

export function recordId(source: Source, key: string): string {
  return JSON.stringify([source, key]);
}

export function recordKey(id: string): [Source, string] {
  const value: unknown = JSON.parse(id);
  if (!Array.isArray(value) || value.length !== 2 ||
      (value[0] !== "idb" && value[0] !== "ls") || typeof value[1] !== "string" ||
      JSON.stringify(value) !== id) throw new Error("Invalid record identity.");
  return [value[0], value[1]];
}

export function validateHead(value: unknown): Head {
  if (!value || typeof value !== "object" ||
      !("format" in value) || value.format !== 1 ||
      !("dataset" in value) || typeof value.dataset !== "string" || !value.dataset ||
      !("records" in value) || !value.records || typeof value.records !== "object" ||
      Array.isArray(value.records) ||
      !("deleted" in value) || !Array.isArray(value.deleted) ||
      !("backups" in value) || !Array.isArray(value.backups)) {
    throw new Error("Invalid snapshot; refusing to write app data.");
  }
  for (const [id, data] of Object.entries(value.records)) {
    recordKey(id);
    if (typeof data !== "string") throw new Error("Invalid record payload.");
  }
  const deleted = new Set<string>();
  for (const id of value.deleted) {
    if (typeof id !== "string" || deleted.has(id) || Object.hasOwn(value.records, id)) {
      throw new Error("Invalid deletion history.");
    }
    recordKey(id);
    deleted.add(id);
  }
  const ids = new Set<string>();
  for (const backup of value.backups) {
    if (!backup || typeof backup !== "object" || typeof backup.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(backup.id) ||
        typeof backup.label !== "string" || typeof backup.created !== "string" ||
        !Number.isFinite(Date.parse(backup.created)) || ids.has(backup.id)) {
      throw new Error("Invalid backup index.");
    }
    ids.add(backup.id);
  }
  return value as Head;
}

export async function hashes(records: Records): Promise<Hashes> {
  return Object.fromEntries(await Promise.all(
    Object.entries(records).map(async ([id, value]) => [id, await sha256(value)])));
}

export function equal(a: Records, b: Records): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export type Conflict = { id: string; localDeleted: boolean; remoteDeleted: boolean };
export class ConflictError extends Error {
  constructor(public conflicts: Conflict[]) {
    super(`Conflicting changes in ${conflicts.length} record(s). Nothing was overwritten.`);
  }
}

export async function merge(
  base: Hashes, local: Records, remote: Records,
  resolve?: (conflicts: Conflict[]) => Promise<"local" | "remote">,
  remoteDeleted: string[] = [],
): Promise<Records> {
  const [left, right] = await Promise.all([hashes(local), hashes(remote)]);
  const result: Records = {};
  const conflicts: Conflict[] = [];
  const tombstones = new Set(remoteDeleted);
  for (const id of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote), ...remoteDeleted])) {
    const l = left[id] ?? "-";
    const r = right[id] ?? "-";
    const previous = base[id] ?? (tombstones.has(id) ? undefined : "-");
    let choice: string | undefined;
    if (l === r || r === previous) choice = local[id];
    else if (l === previous) choice = remote[id];
    else {
      conflicts.push({ id, localDeleted: l === "-", remoteDeleted: r === "-" });
      continue;
    }
    if (choice !== undefined) result[id] = choice;
  }
  if (conflicts.length) {
    if (!resolve) throw new ConflictError(conflicts);
    const side = await resolve(conflicts);
    for (const { id } of conflicts) {
      const choice = (side === "local" ? local : remote)[id];
      if (choice !== undefined) result[id] = choice;
    }
  }
  return result;
}
