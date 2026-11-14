import { pack, unpack } from "./codec";
import { equal, recordId, recordKey, type Records, type State } from "./model";

const privatePrefix = "tmps:";
const protectedKey = /(?:api.?key|license|token|secret|password|credential|cloud|sync|extension)/i;
const excluded = new Set(["TM_useStateUpdateHistory", "INSTANCE_ID"]);

export function allowed(source: "idb" | "ls", key: string, exclusions: string[]): boolean {
  if (key.startsWith(privatePrefix) || key.startsWith("tcs_") ||
      key.startsWith("gsi_") || key.startsWith("TM_MIGRATE_") ||
      excluded.has(key) || exclusions.includes(key) ||
      protectedKey.test(key)) return false;
  return source === "idb" || key.startsWith("TM_");
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

export interface AppData {
  snapshot(): Promise<Records>;
  validate(records: Records): Promise<void>;
  apply(expected: Records, target: Records): Promise<void>;
}

export class BrowserData implements AppData {
  constructor(private idb: IDBFactory, private storage: Storage,
    private exclusions: string[]) {}

  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.idb.open("keyval-store");
      request.onupgradeneeded = () => {
        request.transaction?.abort();
        reject(new Error("TypingMind keyval-store does not exist. Open the app and create test data first."));
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("App database is blocked. Close other tabs."));
      request.onsuccess = () => {
        const db = request.result;
        if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains("keyval")) {
          db.close();
          reject(new Error("Unrecognized app database schema; sync blocked."));
          return;
        }
        resolve(db);
      };
    });
  }

  private local(): Records {
    const records: Records = {};
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key !== null && allowed("ls", key, this.exclusions)) {
        const value = this.storage.getItem(key);
        if (value !== null) records[recordId("ls", key)] = value;
      }
    }
    return records;
  }

  private async encodeIDB(entries: [IDBValidKey, unknown][]): Promise<Records> {
    const records: Records = {};
    for (const [key, value] of entries) {
      if (typeof key !== "string") {
        throw new Error("Non-string app database key found; schema needs review before syncing.");
      }
      if (allowed("idb", key, this.exclusions)) records[recordId("idb", key)] = await pack(value);
    }
    return records;
  }

  async snapshot(): Promise<Records> {
    const db = await this.open();
    let entries: [IDBValidKey, unknown][] = [];
    try {
      const tx = db.transaction("keyval", "readonly");
      const completed = done(tx);
      const items: [IDBValidKey, unknown][] = [];
      const request = tx.objectStore("keyval").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          items.push([cursor.key, cursor.value]);
          cursor.continue();
        }
      };
      await completed;
      entries = items;
    } finally {
      db.close();
    }
    const local = this.local();
    const records = await this.encodeIDB(entries);
    for (const [id, value] of Object.entries(local)) records[id] = await pack(value);
    if (!equal(local, this.local())) throw new Error("App settings changed while reading. Stop editing and retry.");
    return records;
  }

  async validate(records: Records): Promise<void> {
    for (const [id, value] of Object.entries(records)) {
      const [source, key] = recordKey(id);
      if (!allowed(source, key, this.exclusions)) {
        throw new Error(`Snapshot contains a protected or excluded key: ${key}. Check matching exclusion settings.`);
      }
      const decoded = await unpack(value);
      if (source === "ls" && typeof decoded !== "string") throw new Error("Invalid Local Storage value.");
    }
  }

  async apply(expected: Records, target: Records): Promise<void> {
    await this.validate(target);
    const decoded = new Map<string, unknown>();
    for (const [id, value] of Object.entries(target)) decoded.set(id, await unpack(value));
    if (!equal(await this.snapshot(), expected)) {
      throw new Error("Local data changed during sync; nothing applied. Stop editing and retry.");
    }
    const expectedLocal: Records = {};
    for (const [id, value] of Object.entries(expected)) {
      if (recordKey(id)[0] === "ls") expectedLocal[id] = String(await unpack(value));
    }
    const expectedIDB = Object.fromEntries(
      Object.entries(expected).filter(([id]) => recordKey(id)[0] === "idb"));
    const db = await this.open();
    try {
      const tx = db.transaction("keyval", "readwrite");
      const completion = done(tx);
      const store = tx.objectStore("keyval");
      const entries: [IDBValidKey, unknown][] = [];
      let prepared: Records | undefined;
      let failure: unknown;
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (cursor.result) {
          entries.push([cursor.result.key, cursor.result.value]);
          cursor.result.continue();
          return;
        }
        void this.encodeIDB(entries).then((value) => { prepared = value; }, (error) => { failure = error; });
        // Keep the write transaction active while Blob bytes are hashed/encoded.
        const pulse = () => {
          const ping = store.get("tmps:read-only-keepalive");
          ping.onsuccess = () => {
            if (failure) { tx.abort(); return; }
            if (!prepared) { pulse(); return; }
            if (!equal(prepared, expectedIDB) || !equal(this.local(), expectedLocal)) {
              failure = new Error("Local data changed before the write transaction; apply aborted.");
              tx.abort();
              return;
            }
            for (const id of new Set([...Object.keys(expectedIDB), ...Object.keys(target)])) {
              const [source, key] = recordKey(id);
              if (source !== "idb" || target[id] === expected[id]) continue;
              if (Object.hasOwn(target, id)) store.put(decoded.get(id), key);
              else store.delete(key);
            }
          };
        };
        pulse();
      };
      try {
        await completion;
      } catch (error) {
        throw failure ?? error;
      }
      if (!equal(this.local(), expectedLocal)) {
        throw new Error("Settings changed during database commit. Use the saved local rollback before continuing.");
      }
      for (const id of new Set([...Object.keys(expected), ...Object.keys(target)])) {
        const [source, key] = recordKey(id);
        if (source !== "ls" || target[id] === expected[id]) continue;
        if (Object.hasOwn(target, id)) this.storage.setItem(key, String(decoded.get(id)));
        else this.storage.removeItem(key);
      }
    } finally {
      db.close();
    }
    if (!equal(await this.snapshot(), target)) {
      throw new Error("Post-write verification failed. Automatic sync is blocked; use local rollback.");
    }
  }
}

export type LocalState = { base?: State; recovery?: string; pending?: boolean };
export interface StateStore {
  read(): Promise<LocalState>;
  write(value: LocalState): Promise<void>;
}

function validateState(value: unknown): LocalState {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ("pending" in value && typeof value.pending !== "boolean") ||
      ("recovery" in value && value.recovery !== undefined && typeof value.recovery !== "string") ||
      ("pending" in value && value.pending === true && !("recovery" in value && value.recovery))) {
    throw new Error("Private Sync local state is damaged. Restore an independent backup; do not reset the baseline blindly.");
  }
  if ("base" in value && value.base !== undefined) {
    const base = value.base;
    if (!base || typeof base !== "object" ||
        !("dataset" in base) || typeof base.dataset !== "string" || !base.dataset ||
        !("hashes" in base) || !base.hashes || typeof base.hashes !== "object" || Array.isArray(base.hashes)) {
      throw new Error("Invalid local sync baseline.");
    }
    for (const [id, hash] of Object.entries(base.hashes)) {
      recordKey(id);
      if (typeof hash !== "string" || (hash !== "-" && !/^[0-9a-f]{64}$/.test(hash))) {
        throw new Error("Invalid local sync baseline hash.");
      }
    }
  }
  return value as LocalState;
}

export class BrowserStateSlot {
  constructor(private idb: IDBFactory, private key: string) {}

  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.idb.open("typingmind-private-sync", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Private Sync state database is blocked."));
    });
  }

  async read(): Promise<unknown> {
    const db = await this.open();
    try {
      const tx = db.transaction("state", "readonly");
      const completion = done(tx);
      const request = tx.objectStore("state").get(this.key);
      await completion;
      return request.result;
    } finally {
      db.close();
    }
  }

  async write(value: unknown): Promise<void> {
    const db = await this.open();
    try {
      const tx = db.transaction("state", "readwrite");
      const completion = done(tx);
      tx.objectStore("state").put(value, this.key);
      await completion;
    } finally {
      db.close();
    }
  }

}

export class BrowserState implements StateStore {
  private slot: BrowserStateSlot;
  constructor(idb: IDBFactory, key: string) { this.slot = new BrowserStateSlot(idb, key); }
  async read(): Promise<LocalState> { return validateState(await this.slot.read()); }
  async write(value: LocalState): Promise<void> { await this.slot.write(value); }
}
