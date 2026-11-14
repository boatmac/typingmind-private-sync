import assert from "node:assert/strict";
import test from "node:test";
import { binding, HttpStore, PreconditionError, validateConfig, type Config } from "../src/provider";
import { storageServer } from "./http-server";

export const config: Config = {
  provider: "webdav", endpoint: "https://storage.example/dav/",
  prefix: "typingmind/test", bucket: "test-bucket", region: "us-east-1",
  username: "test-user", exclusions: [],
};
const secrets = {
  password: "test-password", accessKeyId: "test-access", secretAccessKey: "test-secret", sessionToken: "",
};

test("WebDAV HTTP contract: nested folders, authentication, conditional writes and cleanup", async (t) => {
  const server = await storageServer();
  t.after(() => server.close());
  const store = new HttpStore({ ...config, endpoint: server.url + "/dav/" }, secrets);
  await store.probe();
  assert.equal(server.objects.size, 0);
  await store.put("head.json", "one", null);
  const first = await store.get("head.json");
  assert.equal(first?.text, "one");
  await assert.rejects(store.put("head.json", "wrong", null), PreconditionError);
  await store.put("head.json", "two", first!.etag);
  assert.equal((await store.get("head.json"))?.text, "two");
  assert.ok(server.requests.some(({ method, path }) => method === "MKCOL" && path === "/dav/typingmind/test/"));
  assert.ok(server.requests.every(({ headers }) =>
    headers.authorization === "Basic " + btoa("test-user:test-password")));
});

test("S3 signs real HTTP requests, including conditional headers and session tokens", async (t) => {
  const server = await storageServer();
  t.after(() => server.close());
  const store = new HttpStore({
    ...config, provider: "s3", endpoint: server.url,
  }, { ...secrets, sessionToken: "test-session-token" });
  await store.probe();
  await store.put("head.json", '{"data":1}', null);
  const first = await store.get("head.json");
  await store.put("head.json", '{"data":2}', first!.etag);
  const put = server.requests.slice().reverse().find(({ method, path }) => method === "PUT" && path.endsWith("head.json"))!;
  assert.equal(put.path, "/test-bucket/typingmind/test/head.json");
  assert.match(String(put.headers.authorization), /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-east-1\/s3\/aws4_request,/);
  assert.match(String(put.headers.authorization), /SignedHeaders=[^,]*if-match/);
  assert.equal(put.headers["x-amz-security-token"], "test-session-token");
  assert.ok(put.headers["x-amz-content-sha256"]);
  assert.ok(!server.requests.some(({ method }) => method === "MKCOL"));
});

test("servers ignoring conditional writes or hiding ETags are rejected before syncing", async (t) => {
  const server = await storageServer();
  t.after(() => server.close());
  const store = new HttpStore({ ...config, endpoint: server.url }, secrets);
  server.options.unsafe = true;
  await assert.rejects(store.probe(), /conditional writes are ignored/);
  assert.equal(server.objects.size, 0);
  server.options.unsafe = false;
  server.options.noEtag = true;
  await assert.rejects(store.probe(), /strong ETag/);
  assert.equal(server.objects.size, 0);
});

test("auth/permission errors never masquerade as an empty remote dataset", async (t) => {
  const server = await storageServer();
  t.after(() => server.close());
  const store = new HttpStore({ ...config, provider: "s3", endpoint: server.url }, secrets);
  server.options.status = 403;
  await assert.rejects(store.get("head.json"), /403/);
  await assert.rejects(store.put("head.json", "data", null), /403/);
});

test("endpoint policy blocks embedded secrets, insecure public HTTP and unsafe prefixes", () => {
  for (const endpoint of ["http://nas.example", "https://user:pass@nas.example/",
    "https://nas.example/?token=secret", "https://nas.example/#fragment"]) {
    assert.throws(() => validateConfig({ ...config, endpoint }));
  }
  assert.throws(() => validateConfig({ ...config, prefix: "../danger" }));
  assert.throws(() => validateConfig({ ...config, username: "invalid:user" }));
  assert.notEqual(binding(config), binding({ ...config, prefix: "different" }));
  assert.notEqual(binding(config), binding({ ...config, exclusions: ["CHAT_one"] }));
});
