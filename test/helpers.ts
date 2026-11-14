import assert from "node:assert/strict";
import { pack } from "../src/codec";
import type { AppData, LocalState, StateStore } from "../src/data";
import { equal, recordId, type Records } from "../src/model";
import { PreconditionError, type ObjectStore, type RemoteObject } from "../src/provider";
import type { ImmutableStore } from "../src/immutable-log";
import type { ReplicaSlot } from "../src/log-replica";

export async function records(values: Record<string, unknown>, source: "idb" | "ls" = "idb"): Promise<Records> {
  return Object.fromEntries(await Promise.all(
    Object.entries(values).map(async ([key, value]) => [recordId(source, key), await pack(value)])));
}

export class MemoryData implements AppData {
  failApply = false;
  writes = 0;
  values: Records;
  constructor(values: Records) { this.values = { ...values }; }
  async snapshot(): Promise<Records> { return { ...this.values }; }
  async validate(): Promise<void> {}
  async apply(expected: Records, target: Records): Promise<void> {
    assert.ok(equal(this.values, expected), "Expected local snapshot");
    this.writes++;
    if (this.failApply) {
      this.values = { ...target };
      throw new Error("Simulated crash after partial apply");
    }
    this.values = { ...target };
  }
}

export class MemoryState implements StateStore {
  value: LocalState = {};
  failNextWrite = false;
  async read(): Promise<LocalState> { return structuredClone(this.value); }
  async write(value: LocalState): Promise<void> {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error("State write failed"); }
    this.value = structuredClone(value);
  }
}

export class MemoryRemote implements ObjectStore {
  objects = new Map<string, RemoteObject>();
  counter = 0;
  headWrites = 0;
  probes = 0;
  failHeadWrite = false;
  beforeHeadWrite?: () => Promise<void>;
  async get(key: string): Promise<RemoteObject | null> {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, text: string, expected: string | null): Promise<void> {
    if (key === "head.json") {
      const hook = this.beforeHeadWrite;
      this.beforeHeadWrite = undefined;
      if (hook) await hook();
      if (this.failHeadWrite) throw new Error("Network unavailable");
    }
    const old = this.objects.get(key);
    if ((old?.etag ?? null) !== expected) throw new PreconditionError();
    if (key === "head.json") this.headWrites++;
    this.objects.set(key, { text, etag: `"${++this.counter}"` });
  }
  async probe(): Promise<void> { this.probes++; }
}

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  failWrites = false;
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

export class MemoryImmutableStore implements ImmutableStore {
  objects = new Map<string, string>();
  writes = 0;
  failAfterWrite = false;
  hidden = new Set<string>();
  async list() { return [...this.objects.keys()].filter((id) => !this.hidden.has(id)); }
  async get(id: string) { return this.objects.get(id) ?? null; }
  async put(id: string, text: string) {
    this.objects.set(id, text);
    this.writes++;
    if (this.failAfterWrite) throw new Error("Connection lost after upload.");
  }
}

export class MemoryReplicaSlot implements ReplicaSlot {
  value: unknown;
  failNextWrite = false;
  async read(): Promise<unknown> { return structuredClone(this.value); }
  async write(value: unknown): Promise<void> {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error("State write failed"); }
    this.value = structuredClone(value);
  }
}
