import assert from "node:assert/strict";
import test from "node:test";
import { Vault } from "../src/crypto";
import { ImmutableLog } from "../src/immutable-log";
import { recordId } from "../src/model";
import { MemoryImmutableStore as MemoryLog, records } from "./helpers";

const password = "immutable-prototype-passphrase";
function device(store: MemoryLog, dataset = "shared-test-dataset") {
  return new ImmutableLog(store, new Vault(password), dataset);
}

test("simultaneous roots and independent edits converge without shared-head overwrites", async () => {
  const store = new MemoryLog();
  const a = device(store);
  const b = device(store);
  const initialA = await a.read();
  const initialB = await b.read();
  const left = await records({ CHAT_left: "left" });
  const right = await records({ CHAT_right: "right" });
  const [ca, cb] = await Promise.all([a.prepare(initialA, left), b.prepare(initialB, right)]);
  await Promise.all([a.publish(ca), b.publish(cb)]);
  assert.equal(store.objects.size, 2);
  assert.equal(store.writes, 2);
  const viewA = await a.read();
  assert.deepEqual(viewA, await b.read());
  assert.deepEqual(viewA.records, { ...left, ...right });
  assert.equal(viewA.tips.length, 2);
  const unrelated = await a.prepare(viewA, await records({ CHAT_other: "other" }));
  await a.publish(unrelated);
  assert.deepEqual((await b.read()).records, { ...left, ...right, ...await records({ CHAT_other: "other" }) });
  assert.equal((await b.read()).tips.length, 1);
});

test("concurrent same-record edits retain both variants until an explicit causal resolution", async () => {
  const store = new MemoryLog();
  const a = device(store);
  const b = device(store);
  const original = await a.prepare(await a.read(), await records({ CHAT_one: "base" }));
  await a.publish(original);
  const baseline = await a.read();
  const [left, right] = await Promise.all([
    a.prepare(baseline, await records({ CHAT_one: "left" })),
    b.prepare(baseline, await records({ CHAT_one: "right", CHAT_unrelated: "keep" })),
  ]);
  await Promise.all([a.publish(left), b.publish(right)]);
  const conflicted = await a.read();
  assert.equal(conflicted.records, null);
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(conflicted.conflicts[0]!.versions.length, 2);
  const resolve = await a.prepare(conflicted, await records({ CHAT_one: "chosen" }));
  await a.publish(resolve);
  const resolved = await b.read();
  assert.deepEqual(resolved.records, await records({ CHAT_one: "chosen", CHAT_unrelated: "keep" }));
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(store.objects.size, 4);
});

test("offline stale edit cannot silently resurrect a deleted record", async () => {
  const store = new MemoryLog();
  const a = device(store);
  const b = device(store);
  const id = recordId("idb", "CHAT_one");
  await a.publish(await a.prepare(await a.read(), await records({ CHAT_one: "base" })));
  const offline = await b.read();
  await a.publish(await a.prepare(await a.read(), { [id]: null }));
  const deleted = await a.read();
  assert.deepEqual(deleted.records, {});
  assert.deepEqual(deleted.deleted, [id]);
  await b.publish(await b.prepare(offline, await records({ CHAT_one: "offline edit" })));
  const conflict = await a.read();
  assert.equal(conflict.records, null);
  assert.deepEqual(new Set(conflict.conflicts[0]!.versions.map((version) => version.value)),
    new Set([null, (await records({ CHAT_one: "offline edit" }))[id]]));
  await a.publish(await a.prepare(conflict, { [id]: null }));
  assert.deepEqual((await b.read()).deleted, [id]);
  await b.publish(await b.prepare(await b.read(), await records({ CHAT_one: "explicit recreation" })));
  assert.deepEqual((await a.read()).records, await records({ CHAT_one: "explicit recreation" }));
});

test("unseen concurrent edit remains a conflict even after another device resolves known versions", async () => {
  const store = new MemoryLog();
  const log = device(store);
  await log.publish(await log.prepare(await log.read(), await records({ CHAT_one: "base" })));
  const baseline = await log.read();
  const late = await log.prepare(baseline, await records({ CHAT_one: "late" }));
  const first = await log.prepare(baseline, await records({ CHAT_one: "first" }));
  const second = await log.prepare(baseline, await records({ CHAT_one: "second" }));
  await Promise.all([log.publish(first), log.publish(second)]);
  await log.publish(await log.prepare(await log.read(), await records({ CHAT_one: "resolved" })));
  await log.publish(late);
  const view = await log.read();
  assert.equal(view.records, null);
  assert.equal(view.conflicts[0]!.versions.length, 2);
});

test("identical concurrent values converge and ambiguous upload retries reuse the same encrypted object", async () => {
  const store = new MemoryLog();
  const log = device(store);
  const baseline = await log.read();
  const same = await records({ CHAT_one: "same" });
  const first = await log.prepare(baseline, same);
  const second = await log.prepare(baseline, same);
  store.failAfterWrite = true;
  await assert.rejects(log.publish(first), /Connection lost/);
  store.failAfterWrite = false;
  await log.publish(first);
  assert.equal(store.writes, 1);
  await log.publish(second);
  assert.equal(store.objects.size, 2);
  assert.deepEqual((await log.read()).records, same);
  assert.deepEqual((await log.read()).conflicts, []);
  assert.ok(!first.text.includes("CHAT_one"));
});

test("missing causal parents, disappeared known commits, corruption and foreign datasets fail closed", async () => {
  const store = new MemoryLog();
  const log = device(store);
  const root = await log.prepare(await log.read(), await records({ CHAT_one: "root" }));
  await log.publish(root);
  const known = await log.read();
  const child = await log.prepare(known, await records({ CHAT_one: "child" }));
  await log.publish(child);
  store.hidden.add(root.id);
  await assert.rejects(log.read(), /Missing parent/);
  await assert.rejects(log.read(known.ids), /Previously observed/);
  store.hidden.clear();
  store.objects.set(child.id, "{}");
  await assert.rejects(log.read(), /content hash mismatch/);
  store.objects.set(child.id, child.text);
  await assert.rejects(device(store, "different-dataset").read(), /wrong dataset/);
  await assert.rejects(new ImmutableLog(store, new Vault("incorrect-passphrase"), "shared-test-dataset").read(),
    /Decryption failed/);
});
