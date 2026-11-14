import assert from "node:assert/strict";
import test from "node:test";
import { Vault } from "../src/crypto";
import { ApprovalRequired } from "../src/engine";
import { ImmutableEngine } from "../src/immutable-engine";
import { ImmutableLog } from "../src/immutable-log";
import { LogReplica, ReplicaConflictError } from "../src/log-replica";
import { recordId, validateHead } from "../src/model";
import { MemoryData, MemoryImmutableStore, MemoryReplicaSlot, records } from "./helpers";

const passphrase = "immutable-engine-test-passphrase";
const approve = async () => true;
function device(commits: MemoryImmutableStore, archives: MemoryImmutableStore, data: MemoryData,
  slot = new MemoryReplicaSlot(), archiveSlot = new MemoryReplicaSlot()) {
  const vault = new Vault(passphrase);
  const replica = new LogReplica(new ImmutableLog(commits, vault, "engine-dataset"), data, slot,
    vault, "engine-target", "engine-dataset");
  return { engine: new ImmutableEngine(replica, data, archives, archiveSlot, vault, "engine-dataset", "engine-target"),
    slot, archiveSlot, vault, data };
}

test("immutable session requires incoming approval and exposes the existing sync/rollback surface", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const a = device(commits, archives, new MemoryData(await records({ CHAT_one: "base" })));
  await a.engine.sync();
  const b = device(commits, archives, new MemoryData({}));
  await assert.rejects(b.engine.sync(), ApprovalRequired);
  assert.equal(b.data.writes, 0);
  await b.engine.sync({ approve });
  assert.deepEqual(b.data.values, a.data.values);
  assert.equal(b.engine.reloadRequired, true);
  const rollback = validateHead(await b.vault.open(await b.engine.exportRollback()));
  assert.deepEqual(rollback.records, {});
  const reloaded = device(commits, archives, b.data, b.slot, b.archiveSlot);
  await reloaded.engine.rollback(approve);
  assert.deepEqual(b.data.values, {});
  assert.equal(commits.objects.size, 1);
});

test("reviewed conflict choices resolve edits and deletions without discarding original versions", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const original = await records({ CHAT_one: "base" });
  const a = device(commits, archives, new MemoryData(original));
  await a.engine.sync();
  const b = device(commits, archives, new MemoryData({}));
  await b.engine.sync({ approve });
  const reloaded = device(commits, archives, b.data, b.slot, b.archiveSlot);
  a.data.values = {};
  await a.engine.sync();
  b.data.values = await records({ CHAT_one: "offline", CHAT_other: "keep" });
  let conflict: ReplicaConflictError | undefined;
  try { await reloaded.engine.sync({ approve }); } catch (error) {
    assert.ok(error instanceof ReplicaConflictError);
    conflict = error;
  }
  assert.ok(conflict);
  await reloaded.engine.resolve(conflict.view, { [recordId("idb", "CHAT_one")]: null }, approve, { approve });
  assert.deepEqual(b.data.values, await records({ CHAT_other: "keep" }));
  assert.equal(commits.objects.size, 4);
  assert.equal(archives.objects.size, 0);
});

test("interrupted conflict publication retries exact ciphertext without advancing an unapplied causal view", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const a = device(commits, archives, new MemoryData(await records({ CHAT_one: "base" })));
  await a.engine.sync();
  const b = device(commits, archives, new MemoryData({}));
  await b.engine.sync({ approve });
  const reloaded = device(commits, archives, b.data, b.slot, b.archiveSlot);
  a.data.values = await records({ CHAT_one: "left" });
  await a.engine.sync();
  b.data.values = await records({ CHAT_one: "right" });
  let conflict: ReplicaConflictError | undefined;
  try { await reloaded.engine.sync({ approve }); } catch (error) {
    assert.ok(error instanceof ReplicaConflictError);
    conflict = error;
  }
  assert.ok(conflict);
  const choice = await records({ CHAT_one: "left" });
  commits.failAfterWrite = true;
  await assert.rejects(reloaded.engine.resolve(conflict.view, choice, approve, { approve }), /Connection lost/);
  const objects = [...commits.objects];
  commits.failAfterWrite = false;
  const retried = device(commits, archives, b.data, b.slot, b.archiveSlot);
  await retried.engine.sync({ approve });
  assert.deepEqual([...commits.objects], objects);
  assert.deepEqual(b.data.values, choice);
});

test("stale, invalid and cancelled conflict choices never publish a resolution", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const a = device(commits, archives, new MemoryData(await records({ CHAT_one: "left" })));
  const b = device(commits, archives, new MemoryData(await records({ CHAT_one: "right" })));
  await a.engine.sync();
  let conflict: ReplicaConflictError | undefined;
  try { await b.engine.sync(); } catch (error) {
    assert.ok(error instanceof ReplicaConflictError);
    conflict = error;
  }
  assert.ok(conflict);
  const before = commits.writes;
  await assert.rejects(b.engine.resolve(conflict.view, {}, approve, {}), /Choose one/);
  const choices = await records({ CHAT_one: "left" });
  await assert.rejects(b.engine.resolve(conflict.view, choices, async () => false, {}), /cancelled/);
  assert.equal(commits.writes, before);
  a.data.values = await records({ CHAT_one: "left", CHAT_new: "new" });
  await assert.rejects(a.engine.sync(), ReplicaConflictError);
  await assert.rejects(b.engine.resolve(conflict.view, choices, approve, {}), /history changed/);
  assert.equal(commits.writes, before + 1);
});

test("immutable backups restore locally and restored changes publish only on a later sync", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const original = await records({ CHAT_one: "original" });
  const a = device(commits, archives, new MemoryData(original));
  await a.engine.sync();
  await a.engine.backup("named backup");
  const backups = await a.engine.list();
  assert.equal(backups.length, 1);
  assert.equal(backups[0]!.label, "named backup");
  a.data.values = await records({ CHAT_one: "new" });
  await a.engine.sync();
  const before = [...commits.objects];
  await a.engine.restore(backups[0]!.id, approve);
  assert.deepEqual(a.data.values, original);
  assert.deepEqual([...commits.objects], before);
  const reloaded = device(commits, archives, a.data, a.slot, a.archiveSlot);
  await reloaded.engine.sync();
  assert.equal(commits.objects.size, 3);
});

test("pending backup retries retain the original snapshot and explicitly report resumption", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const first = await records({ CHAT_one: "first" });
  const a = device(commits, archives, new MemoryData(first));
  archives.failAfterWrite = true;
  await assert.rejects(a.engine.backup("first snapshot"), /Connection lost/);
  const old = [...archives.objects];
  a.data.values = await records({ CHAT_one: "newer" });
  archives.failAfterWrite = false;
  const reloaded = device(commits, archives, a.data, a.slot, a.archiveSlot);
  assert.match(await reloaded.engine.backup("new snapshot"), /Pending backup completed; current data may be newer/);
  assert.deepEqual([...archives.objects], old);
  const backup = (await reloaded.engine.list())[0]!;
  await reloaded.engine.restore(backup.id, approve);
  assert.deepEqual(a.data.values, first);
});

test("local encrypted export/import needs no remote operations and invalid archives fail explicitly", async () => {
  const commits = new MemoryImmutableStore();
  const archives = new MemoryImmutableStore();
  const a = device(commits, archives, new MemoryData(await records({ CHAT_one: "safe" })));
  const exported = await a.engine.exportLocal();
  a.data.values = {};
  await a.engine.importLocal(exported, approve);
  assert.deepEqual(a.data.values, await records({ CHAT_one: "safe" }));
  assert.equal(commits.writes, 0);
  assert.equal(archives.writes, 0);
  const reloaded = device(commits, archives, a.data, a.slot, a.archiveSlot);
  await reloaded.engine.backup("safe");
  const id = [...archives.objects.keys()][0]!;
  archives.objects.set(id, "{}");
  await assert.rejects(reloaded.engine.list(), /hash mismatch/);
});
