import assert from "node:assert/strict";
import test from "node:test";
import { pack, unpack } from "../src/codec";
import { ConflictError, hashes, merge, recordId, validateHead } from "../src/model";
import { records } from "./helpers";

test("three-way merge detects equal-length edits instead of comparing sizes", async () => {
  const base = await records({ CHAT_one: "abc" });
  const local = await records({ CHAT_one: "xyz" });
  assert.deepEqual(await merge(await hashes(base), local, base), local);
});

test("independent changes merge; IndexedDB and Local Storage identities cannot collide", async () => {
  const local = await records({ same: "local" });
  const remote = await records({ same: "remote" }, "ls");
  assert.deepEqual(await merge({}, local, remote), { ...local, ...remote });
});

test("concurrent edit and delete/edit stop without a resolver", async () => {
  const original = await records({ CHAT_one: "original" });
  const remote = await records({ CHAT_one: "remote" });
  await assert.rejects(merge(await hashes(original), {}, remote), ConflictError);
  await assert.rejects(merge({}, original, remote), ConflictError);
});

test("tracked deletions propagate in either direction", async () => {
  const base = await records({ CHAT_one: "original" });
  assert.deepEqual(await merge(await hashes(base), {}, base), {});
  assert.deepEqual(await merge(await hashes(base), base, {}), {});
  assert.deepEqual(await merge({}, {}, base), base);
});

test("tombstones block a newly configured stale device from silently resurrecting deleted records", async () => {
  const id = recordId("idb", "CHAT_one");
  const stale = await records({ CHAT_one: "old" });
  await assert.rejects(merge({}, stale, {}, undefined, [id]), ConflictError);
  assert.deepEqual(await merge({ [id]: "-" }, stale, {}, undefined, [id]), stale);
  assert.deepEqual(await merge({}, stale, {}, async () => "remote", [id]), {});
});

test("explicit conflict decisions preserve nonconflicting records", async () => {
  const base = await records({ one: "base" });
  const local = await records({ one: "local", two: "new" });
  const remote = await records({ one: "remote", three: "new" });
  const merged = await merge(await hashes(base), local, remote, async () => "remote");
  assert.deepEqual(merged, { ...local, ...remote });
});

test("codec preserves nested attachments, binary offsets and structured values", async () => {
  const data = {
    blob: new Blob([new Uint8Array([0, 1, 255])], { type: "image/png" }),
    file: new File(["hello"], "note.txt", { type: "text/plain", lastModified: 123 }),
    view: new Uint16Array(new Uint16Array([3, 5, 7]).buffer, 2, 1),
    buffer: new Uint8Array([8, 9]).buffer,
    map: new Map([["x", new Set([1n, undefined])]]),
    array: [null, false, NaN, -0, Infinity, new Date("2026-01-01T00:00:00Z")],
    __proto__: null,
  };
  const encoded = await pack(data);
  const decoded = await unpack(encoded) as typeof data;
  assert.equal(await pack(decoded), encoded);
  assert.equal(await decoded.blob.text(), await data.blob.text());
  assert.equal(decoded.file.name, "note.txt");
  assert.equal(decoded.file.lastModified, 123);
  assert.deepEqual([...decoded.view], [5]);
  assert.ok(Object.is(decoded.array[3], -0));
});

test("unsupported/cyclic/sparse values and invalid payloads fail rather than lose data", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await assert.rejects(pack(cyclic), /Cyclic/);
  await assert.rejects(pack(new RegExp("abc")), /Unsupported/);
  await assert.rejects(pack(new Array(3)), /Sparse/);
  await assert.rejects(unpack('["view","Function","AA=="]'), /Unknown binary/);
  await assert.rejects(unpack('["unexpected",1]'), /Unknown/);
  const malformed = {
    format: 1, dataset: "a", records: { bad: "data" }, deleted: [], backups: [],
  };
  assert.throws(() => validateHead(malformed));
});
