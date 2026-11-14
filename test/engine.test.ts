import assert from "node:assert/strict";
import test from "node:test";
import { Vault } from "../src/crypto";
import { ApprovalRequired, Engine } from "../src/engine";
import { ConflictError, recordId, validateHead } from "../src/model";
import { PreconditionError } from "../src/provider";
import { MemoryData, MemoryRemote, MemoryState, records } from "./helpers";

const password = "test-passphrase-not-a-secret";
const approve = async () => true;
function device(remote: MemoryRemote, data: MemoryData, state = new MemoryState(), vault = new Vault(password)) {
  return { engine: new Engine(remote, data, state, vault), state, vault, data };
}

test("two devices sync edits, attachments, deletions and remote backups", async () => {
  const remote = new MemoryRemote();
  const original = await records({
    CHAT_one: { messages: ["one"], attachment: new Blob(["image"], { type: "image/png" }) },
    CHAT_two: "two",
  });
  const a = device(remote, new MemoryData(original));
  await a.engine.sync();
  const b = device(remote, new MemoryData({}));
  await assert.rejects(b.engine.sync(), ApprovalRequired);
  assert.equal(b.data.writes, 0);
  await b.engine.sync({ approve });
  assert.deepEqual(b.data.values, original);
  await assert.rejects(b.engine.sync(), /Reload/);
  const reloaded = device(remote, b.data, b.state, b.vault);
  delete a.data.values[recordId("idb", "CHAT_two")];
  await a.engine.sync();
  await reloaded.engine.sync({ approve });
  assert.deepEqual(reloaded.data.values, a.data.values);
  assert.equal((await a.engine.list()).length, 1);
  const head = validateHead(await a.vault.open((await remote.get("head.json"))!.text));
  assert.deepEqual(head.deleted, [recordId("idb", "CHAT_two")]);
  const stale = device(remote, new MemoryData(original));
  await assert.rejects(stale.engine.sync({ approve }), ConflictError);
});

test("conflicts do not overwrite either device; explicit resolution leaves backup", async () => {
  const remote = new MemoryRemote();
  const original = await records({ CHAT_one: "base" });
  const a = device(remote, new MemoryData(original));
  const b = device(remote, new MemoryData(original));
  await a.engine.sync();
  await b.engine.sync();
  a.data.values = await records({ CHAT_one: "left" });
  b.data.values = await records({ CHAT_one: "right" });
  await a.engine.sync();
  const before = (await remote.get("head.json"))!.text;
  await assert.rejects(b.engine.sync({ approve }), ConflictError);
  assert.equal((await remote.get("head.json"))!.text, before);
  await b.engine.sync({ approve, resolve: async () => "local" });
  assert.equal((await b.engine.list()).length, 2);
});

test("CAS prevents an interleaved device from overwriting the winner", async () => {
  const remote = new MemoryRemote();
  const original = await records({ CHAT_one: "base" });
  const a = device(remote, new MemoryData(original));
  const b = device(remote, new MemoryData(original));
  await a.engine.sync();
  await b.engine.sync();
  a.data.values = await records({ CHAT_one: "left" });
  b.data.values = await records({ CHAT_one: "right" });
  remote.beforeHeadWrite = () => b.engine.sync().then(() => undefined);
  await assert.rejects(a.engine.sync(), PreconditionError);
  const head = validateHead(await a.vault.open((await remote.get("head.json"))!.text));
  assert.deepEqual(head.records, b.data.values);
  assert.deepEqual(a.data.values, await records({ CHAT_one: "left" }));
});

test("wrong password and remote disappearance never trigger an empty overwrite", async () => {
  const remote = new MemoryRemote();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "safe" })));
  await a.engine.sync();
  const wrong = device(remote, new MemoryData({}), undefined, new Vault("incorrect-password"));
  const count = remote.headWrites;
  await assert.rejects(wrong.engine.sync({ approve }), /Decryption failed/);
  assert.equal(remote.headWrites, count);
  remote.objects.delete("head.json");
  await assert.rejects(a.engine.sync(), /disappeared/);
  assert.equal(remote.headWrites, count);
});

test("network failure leaves baseline and local data intact for retry", async () => {
  const remote = new MemoryRemote();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "base" })));
  await a.engine.sync();
  const before = structuredClone(a.state.value);
  a.data.values = await records({ CHAT_one: "next" });
  remote.failHeadWrite = true;
  await assert.rejects(a.engine.sync(), /Network/);
  assert.deepEqual(a.state.value, before);
  assert.deepEqual(a.data.values, await records({ CHAT_one: "next" }));
  remote.failHeadWrite = false;
  await a.engine.sync();
});

test("interrupted apply blocks sync across reload and supports offline local rollback", async () => {
  const remote = new MemoryRemote();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "remote" })));
  await a.engine.sync();
  const local = await records({ CHAT_two: "local" });
  const b = device(remote, new MemoryData(local));
  b.data.failApply = true;
  await assert.rejects(b.engine.sync({ approve }), /Simulated crash/);
  assert.equal(b.state.value.pending, true);
  const saved = await b.engine.exportRollback();
  const reloaded = device(remote, b.data, b.state, b.vault);
  await assert.rejects(reloaded.engine.sync(), /interrupted/);
  // A second failed recovery must not replace the original rollback with partial data.
  await assert.rejects(reloaded.engine.rollback(approve), /Simulated crash/);
  assert.equal(await reloaded.engine.exportRollback(), saved);
  b.data.failApply = false;
  remote.failHeadWrite = true;
  await reloaded.engine.rollback(approve);
  assert.deepEqual(b.data.values, local);
  assert.equal(b.state.value.pending, false);
});

test("manual backup restore affects only local data until the next sync", async () => {
  const remote = new MemoryRemote();
  const old = await records({ CHAT_one: "old" });
  const a = device(remote, new MemoryData(old));
  await a.engine.sync();
  await a.engine.backup("Named snapshot");
  const backup = (await a.engine.list())[0]!;
  a.data.values = await records({ CHAT_one: "new" });
  await a.engine.sync();
  const before = (await remote.get("head.json"))!.text;
  await a.engine.restore(backup.id, approve);
  assert.deepEqual(a.data.values, old);
  assert.equal((await remote.get("head.json"))!.text, before);
  const rollback = validateHead(await a.vault.open(await a.engine.exportRollback()));
  assert.deepEqual(rollback.records, await records({ CHAT_one: "new" }));
});

test("local encrypted export/import works without any remote operations", async () => {
  const remote = new MemoryRemote();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "backup" })));
  const text = await a.engine.exportLocal();
  a.data.values = {};
  await a.engine.importLocal(text, approve);
  assert.deepEqual(a.data.values, await records({ CHAT_one: "backup" }));
  assert.equal(remote.counter, 0);
});

test("approval-time local edits abort before either side is overwritten", async () => {
  const remote = new MemoryRemote();
  const a = device(remote, new MemoryData(await records({ CHAT_one: "remote" })));
  await a.engine.sync();
  const b = device(remote, new MemoryData({}));
  const count = remote.headWrites;
  await assert.rejects(b.engine.sync({ approve: async () => {
    b.data.values = await records({ CHAT_two: "new local" });
    return true;
  } }), /Local data changed/);
  assert.equal(remote.headWrites, count);
  assert.equal(b.data.writes, 0);
});

test("encryption uses randomized ciphertext and authenticated tamper detection", async () => {
  const vault = new Vault(password);
  const first = await vault.seal({ data: "private" });
  const second = await vault.seal({ data: "private" });
  assert.notEqual(first, second);
  assert.ok(!first.includes("private"));
  const envelope = JSON.parse(first);
  envelope.data = (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
  await assert.rejects(vault.open(JSON.stringify(envelope)), /Decryption failed/);
  assert.deepEqual(await vault.open(second), { data: "private" });
});
