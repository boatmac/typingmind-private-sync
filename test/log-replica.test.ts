import assert from "node:assert/strict";
import test from "node:test";
import { Vault } from "../src/crypto";
import { ImmutableLog } from "../src/immutable-log";
import { LogReplica, ReplicaConflictError } from "../src/log-replica";
import { recordId } from "../src/model";
import { MemoryData, MemoryImmutableStore, MemoryReplicaSlot, records } from "./helpers";

const password = "replica-test-passphrase";
const approve = async () => true;
function device(remote: MemoryImmutableStore, data: MemoryData, slot = new MemoryReplicaSlot(), target = "test-target") {
  const vault = new Vault(password);
  const log = new ImmutableLog(remote, vault, "replica-dataset");
  return { replica: new LogReplica(log, data, slot, vault, target, "replica-dataset"), log, slot, data };
}

test("confirmed causal state survives reload and offline edits use applied rather than fetched parents", async () => {
  const remote = new MemoryImmutableStore();
  const original = await records({ CHAT_one: "base" });
  const a = device(remote, new MemoryData(original));
  await a.replica.publishLocal();
  const b = device(remote, new MemoryData({}));
  await b.replica.applyRemote(await b.replica.review(), approve);
  assert.equal(b.replica.reloadRequired, true);
  await assert.rejects(b.replica.review(), /Reload/);
  const reloadedB = device(remote, b.data, b.slot);
  a.data.values = {};
  await a.replica.publishLocal();
  const fetched = await reloadedB.replica.review();
  assert.deepEqual(fetched.deleted, [recordId("idb", "CHAT_one")]);
  b.data.values = await records({ CHAT_one: "offline edit" });
  const conflict = await reloadedB.replica.publishLocal();
  assert.equal(conflict.records, null);
  await assert.rejects(reloadedB.replica.applyRemote(conflict, approve), ReplicaConflictError);
  assert.deepEqual(b.data.values, await records({ CHAT_one: "offline edit" }));
  assert.equal(typeof b.slot.value, "string");
  assert.ok(!String(b.slot.value).includes("CHAT_one"));
  assert.ok(!String(b.slot.value).includes(password));
});

test("independent device edits merge and applied causal views preserve future deletion semantics", async () => {
  const remote = new MemoryImmutableStore();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "base" })));
  await a.replica.publishLocal();
  const b = device(remote, new MemoryData({}));
  await b.replica.applyRemote(await b.replica.review(), approve);
  const freshB = device(remote, b.data, b.slot);
  a.data.values = await records({ CHAT_one: "base", CHAT_left: "left" });
  b.data.values = await records({ CHAT_one: "base", CHAT_right: "right" });
  await Promise.all([a.replica.publishLocal(), freshB.replica.publishLocal()]);
  const expected = await records({ CHAT_one: "base", CHAT_left: "left", CHAT_right: "right" });
  await a.replica.applyRemote(await a.replica.review(), approve);
  await freshB.replica.applyRemote(await freshB.replica.review(), approve);
  assert.deepEqual(a.data.values, expected);
  assert.deepEqual(b.data.values, expected);
});

test("upload lost-response retry reuses persisted ciphertext before capturing newer edits", async () => {
  const remote = new MemoryImmutableStore();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "first" })));
  remote.failAfterWrite = true;
  await assert.rejects(a.replica.publishLocal(), /Connection lost/);
  const pendingId = [...remote.objects.keys()][0]!;
  const pendingText = remote.objects.get(pendingId);
  a.data.values = await records({ CHAT_one: "newer" });
  remote.failAfterWrite = false;
  const reloaded = device(remote, a.data, a.slot);
  await reloaded.replica.publishLocal();
  assert.equal(remote.objects.size, 2);
  assert.equal(remote.objects.get(pendingId), pendingText);
  assert.equal(remote.writes, 2);
  assert.deepEqual((await reloaded.replica.review()).records, a.data.values);
});

test("interrupted local application blocks operations across reload until explicit rollback", async () => {
  const remote = new MemoryImmutableStore();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "remote" })));
  await a.replica.publishLocal();
  const b = device(remote, new MemoryData({}));
  b.data.failApply = true;
  await assert.rejects(b.replica.applyRemote(await b.replica.review(), approve), /Simulated crash/);
  const reloaded = device(remote, b.data, b.slot);
  await assert.rejects(reloaded.replica.publishLocal(), /Interrupted/);
  b.data.failApply = false;
  await reloaded.replica.recover(approve);
  assert.deepEqual(b.data.values, {});
  const recovered = device(remote, b.data, b.slot);
  await recovered.replica.applyRemote(await recovered.replica.review(), approve);
  assert.deepEqual(b.data.values, a.data.values);
});

test("unpublished edits, stale reviews and approval-time edits cannot overwrite local data", async () => {
  const remote = new MemoryImmutableStore();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "remote" })));
  await a.replica.publishLocal();
  const b = device(remote, new MemoryData(await records({ CHAT_local: "local" })));
  await assert.rejects(b.replica.applyRemote(await b.replica.review(), approve), /unpublished/);
  b.data.values = {};
  const stale = await b.replica.review();
  a.data.values = await records({ CHAT_one: "new remote" });
  await a.replica.publishLocal();
  await assert.rejects(b.replica.applyRemote(stale, approve), /changed after review/);
  await assert.rejects(b.replica.applyRemote(await b.replica.review(), async () => {
    b.data.values = await records({ CHAT_local: "during approval" });
    return true;
  }), /changed during approval/);
  assert.deepEqual(b.data.values, await records({ CHAT_local: "during approval" }));
});

test("device state failures, target mismatch and vanished known history stop before publishing", async () => {
  const remote = new MemoryImmutableStore();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "safe" })));
  a.slot.failNextWrite = true;
  await assert.rejects(a.replica.publishLocal(), /State write/);
  assert.equal(remote.writes, 0);
  await a.replica.publishLocal();
  await assert.rejects(device(remote, a.data, a.slot, "different-target").replica.review(), /another target/);
  remote.objects.clear();
  await assert.rejects(a.replica.publishLocal(), /Previously observed/);
  assert.equal(remote.writes, 1);
  a.slot.value = { invalid: true };
  await assert.rejects(a.replica.review(), /Corrupt encrypted/);
});
