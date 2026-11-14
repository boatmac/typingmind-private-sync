import { Vault } from "../src/crypto";
import { BrowserData, BrowserStateSlot } from "../src/data";
import { ImmutableLog, type LogView } from "../src/immutable-log";
import { ImmutableS3Store } from "../src/immutable-s3";
import { LogReplica } from "../src/log-replica";
import { binding, type Config } from "../src/provider";

let replica: LogReplica;
let data: BrowserData;
let slot: BrowserStateSlot;
let loseUploadResponse = false;
let interruptApply = false;

export function connect(endpoint: string, prefix: string): void {
  const config: Config = {
    provider: "s3", endpoint, prefix, bucket: "test-bucket", region: "us-east-1", username: "", exclusions: [],
  };
  const fetcher = globalThis.fetch.bind(globalThis);
  const store = new ImmutableS3Store(config, {
    password: "", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", sessionToken: "",
  }, async (input, init) => {
    const request = new Request(input, init);
    const response = await fetcher(request);
    if (request.method === "PUT" && response.ok && loseUploadResponse) {
      loseUploadResponse = false;
      throw new Error("Fixture connection lost after upload.");
    }
    return response;
  });
  const vault = new Vault("browser-replica-passphrase");
  data = new BrowserData(indexedDB, localStorage, []);
  const target = binding(config) + ":fixture-dataset";
  slot = new BrowserStateSlot(indexedDB, "immutable:" + target);
  replica = new LogReplica(new ImmutableLog(store, vault, "fixture-dataset"), {
    snapshot: () => data.snapshot(), validate: (records) => data.validate(records),
    apply: async (before, after) => {
      await data.apply(before, after);
      if (interruptApply) {
        interruptApply = false;
        throw new Error("Fixture interrupted after application.");
      }
    },
  }, slot, vault, target, "fixture-dataset", navigator.locks);
}

async function mutate(work: (store: IDBObjectStore) => void): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("keyval-store", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keyval");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction("keyval", "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    work(tx.objectStore("keyval"));
    await done;
  } finally { db.close(); }
}

export async function edit(key: string, message: string): Promise<void> {
  await mutate((store) => store.put({
    messages: [message], attachment: new Blob(["fixture-image"], { type: "image/png" }),
  }, key));
}
export async function remove(key: string): Promise<void> { await mutate((store) => store.delete(key)); }
export async function reset(): Promise<void> { await mutate((store) => store.clear()); }
export async function publish(): Promise<LogView> { return replica.publishLocal(); }
export async function review(): Promise<LogView> { return replica.review(); }
export async function apply(view: LogView): Promise<void> { await replica.applyRemote(view, async () => true); }
export async function recover(): Promise<void> { await replica.recover(async () => true); }
export async function snapshot() { return data.snapshot(); }
export async function state(): Promise<unknown> { return slot.read(); }
export function failUpload(): void { loseUploadResponse = true; }
export function failApply(): void { interruptApply = true; }
