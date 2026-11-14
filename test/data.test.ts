import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { pack } from "../src/codec";
import { allowed, BrowserData, BrowserState } from "../src/data";
import { recordId } from "../src/model";
import { MemoryStorage, records } from "./helpers";

async function seed(idb: IDBFactory, values: [IDBValidKey, unknown][] = []): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open("keyval-store", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keyval");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction("keyval", "readwrite");
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  for (const [key, value] of values) tx.objectStore("keyval").put(value, key);
  await completion;
  db.close();
}

test("browser adapter reads, applies and verifies blobs, same-key namespaces and deletions", async () => {
  const idb = new IDBFactory();
  const ls = new MemoryStorage();
  await seed(idb, [["CHAT_one", { messages: ["hello"], image: new Blob(["abc"]) }],
    ["TM_theme", "database-theme"], ["TM_apiKey", "do-not-sync"]]);
  ls.setItem("TM_theme", "dark");
  ls.setItem("TM_licenseKey", "protected");
  ls.setItem("TM_MIGRATE_BLOB", "true");
  ls.setItem("other-application", "untouched");
  ls.setItem("tmps:config", "credentials-never-sync");
  const data = new BrowserData(idb, ls, []);
  const before = await data.snapshot();
  assert.equal(Object.keys(before).length, 3);
  assert.notEqual(before[recordId("idb", "TM_theme")], before[recordId("ls", "TM_theme")]);
  const target = {
    ...await records({ CHAT_two: { data: new Uint8Array([1, 2, 3]) }, attachment: new Blob(["new"]) }),
    ...await records({ TM_theme: "light" }, "ls"),
  };
  await data.apply(before, target);
  assert.deepEqual(await data.snapshot(), target);
  assert.equal(ls.getItem("TM_licenseKey"), "protected");
  assert.equal(ls.getItem("TM_MIGRATE_BLOB"), "true");
  assert.equal(ls.getItem("other-application"), "untouched");
});

test("missing and unfamiliar database keys fail closed", async () => {
  const idb = new IDBFactory();
  const data = new BrowserData(idb, new MemoryStorage(), []);
  await assert.rejects(data.snapshot(), /does not exist/);
  await seed(idb, [[42, "unsupported key"]]);
  await assert.rejects(data.snapshot(), /Non-string/);
});

test("additional object stores fail closed rather than pretending to sync unknown schema", async () => {
  const idb = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = idb.open("keyval-store", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("keyval");
      request.result.createObjectStore("new-attachment-schema");
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  await assert.rejects(new BrowserData(idb, new MemoryStorage(), []).snapshot(), /Unrecognized/);
});

test("stale expected snapshot and protected incoming keys cannot overwrite app data", async () => {
  const idb = new IDBFactory();
  await seed(idb, [["CHAT_one", "base"]]);
  const data = new BrowserData(idb, new MemoryStorage(), []);
  const before = await data.snapshot();
  await seed(idb, [["CHAT_one", "edited"]]);
  await assert.rejects(data.apply(before, {}), /Local data changed/);
  await assert.rejects(data.validate({
    [recordId("ls", "TM_secretKey")]: await pack("secret"),
  }), /protected/);
  await assert.rejects(data.validate({
    [recordId("ls", "TM_theme")]: await pack({ invalid: true }),
  }), /Invalid Local/);
  assert.deepEqual(await data.snapshot(), await records({ CHAT_one: "edited" }));
});

test("the write transaction rechecks app edits racing after the initial snapshot check", async () => {
  const idb = new IDBFactory();
  await seed(idb, [["CHAT_one", "base"]]);
  class RacingData extends BrowserData {
    mutateOnRead = false;
    override async snapshot() {
      const result = await super.snapshot();
      if (this.mutateOnRead) {
        this.mutateOnRead = false;
        await seed(idb, [["CHAT_one", "racing edit"]]);
      }
      return result;
    }
  }
  const data = new RacingData(idb, new MemoryStorage(), []);
  const expected = await data.snapshot();
  data.mutateOnRead = true;
  await assert.rejects(data.apply(expected, {}), /write transaction/);
  assert.deepEqual(await data.snapshot(), await records({ CHAT_one: "racing edit" }));
});

test("Local Storage write errors are surfaced, not reported as successful sync", async () => {
  const idb = new IDBFactory();
  await seed(idb, [["CHAT_one", "base"]]);
  const ls = new MemoryStorage();
  ls.setItem("TM_theme", "dark");
  const data = new BrowserData(idb, ls, []);
  const before = await data.snapshot();
  ls.failWrites = true;
  await assert.rejects(data.apply(before, {
    ...await records({ CHAT_one: "new" }), ...await records({ TM_theme: "light" }, "ls"),
  }), /Quota/);
});

test("per-target state and rollback survive reopening; exclusions protect extension credentials", async () => {
  const idb = new IDBFactory();
  const first = new BrowserState(idb, "first");
  await first.write({ pending: true, recovery: "encrypted", base: { dataset: "a", hashes: {} } });
  assert.deepEqual(await new BrowserState(idb, "first").read(), await first.read());
  assert.deepEqual(await new BrowserState(idb, "second").read(), {});
  assert.equal(allowed("idb", "tcs_aws_secretkey", []), false);
  assert.equal(allowed("ls", "TM_MIGRATE_BLOB", []), false);
  assert.equal(allowed("ls", "TM_MIGRATE_MESSAGE_ANNOTATIONS", []), false);
  assert.equal(allowed("ls", "TM_useLastVerifiedToken", []), false);
  assert.equal(allowed("idb", "CHAT_one", ["CHAT_one"]), false);
  assert.equal(allowed("ls", "non-TypingMind", []), false);
});

test("damaged local sync state is reported instead of silently resetting deletion history", async () => {
  const idb = new IDBFactory();
  const state = new BrowserState(idb, "target");
  await state.write({ base: { dataset: "a", hashes: { invalid: "not-a-hash" } } });
  await assert.rejects(state.read());
});
