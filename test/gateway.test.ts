import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayServer, gatewayConfig } from "../src/gateway";
import { HttpStore, PreconditionError } from "../src/provider";
import { gatewayDefaults, gatewayFixture } from "./gateway-fixture";

test("gateway preflight is unauthenticated, origin-restricted and exposes ETags", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const response = await fetch(fixture.url + "/dav/gateway-test/head.json", {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.typingmind.com",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "authorization,content-type,if-match,if-none-match",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.typingmind.com");
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "ETag");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(fixture.calls.length, 0);
  const denied = await fetch(fixture.url + "/dav/gateway-test/head.json", {
    method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  const invalid = await fetch(fixture.url + "/dav/gateway-test/head.json", {
    method: "OPTIONS", headers: {
      Origin: "https://www.typingmind.com", "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "cookie",
    },
  });
  assert.equal(invalid.status, 403);
});

test("gateway credentials are separate; upstream receives neither browser credentials nor cookies", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const url = fixture.url + "/dav/gateway-test/head.json";
  const unauthenticated = await fetch(url, { headers: { Origin: "https://www.typingmind.com" } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("Access-Control-Allow-Origin"), "https://www.typingmind.com");
  assert.equal(fixture.calls.length, 0);
  const response = await fetch(url, {
    headers: { Authorization: fixture.auth, Cookie: "do-not-forward=this", Origin: "https://www.typingmind.com" },
  });
  assert.equal(response.status, 404);
  const upstream = fixture.calls[0]!;
  assert.equal(upstream.url, "https://app.koofr.net/dav/Koofr/AppData/Test/gateway-test/head.json");
  assert.equal(upstream.headers.get("Authorization"), "Basic " +
    Buffer.from("upstream-test-user:upstream-test-app-password").toString("base64"));
  assert.notEqual(upstream.headers.get("Authorization"), fixture.auth);
  assert.equal(upstream.headers.get("Cookie"), null);
  assert.equal(upstream.headers.get("Origin"), null);
  assert.equal(upstream.redirect, "error");
});

test("the existing WebDAV provider works through the gateway and conditional writes remain enforced", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const store = new HttpStore({
    provider: "webdav", endpoint: fixture.url + "/dav/", prefix: fixture.config.prefix,
    username: fixture.config.username, bucket: "", region: "", exclusions: [],
  }, { password: fixture.config.password, accessKeyId: "", secretAccessKey: "", sessionToken: "" });
  await store.probe();
  assert.equal(fixture.backend.objects.size, 0);
  await store.put("head.json", '{"encrypted":"test"}', null);
  const first = await store.get("head.json");
  assert.equal(first?.text, '{"encrypted":"test"}');
  await store.put("head.json", '{"encrypted":"new"}', first!.etag);
  await assert.rejects(store.put("head.json", "{}", first!.etag), PreconditionError);
  assert.equal((await store.get("head.json"))?.text, '{"encrypted":"new"}');
  fixture.backend.options.unsafe = true;
  await assert.rejects(store.probe(), /conditional writes are ignored/);
});

test("gateway scope denies traversal, arbitrary targets, unsupported methods and head/backup deletion", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  for (const path of ["/dav/another/head.json", "/dav/gateway-test/%2fhead.json",
    "/dav/gateway-test/head.json?url=https://evil.example", "/dav/gateway-test/other.txt"]) {
    const response = await fetch(fixture.url + path, { headers: { Authorization: fixture.auth } });
    assert.ok(response.status === 400 || response.status === 404);
  }
  for (const name of ["head.json", "backup-abcdef.json"]) {
    const response = await fetch(fixture.url + "/dav/gateway-test/" + name,
      { method: "DELETE", headers: { Authorization: fixture.auth } });
    assert.equal(response.status, 403);
  }
  const unsupported = await fetch(fixture.url + "/dav/gateway-test/head.json", {
    method: "PROPFIND", headers: { Authorization: fixture.auth },
  });
  assert.equal(unsupported.status, 405);
  assert.equal(fixture.calls.length, 0);
});

test("unconditional writes, weak preconditions and invalid content types never reach Koofr", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const url = fixture.url + "/dav/gateway-test/head.json";
  for (const [headers, expected] of [
    [{}, 428],
    [{ "If-Match": '"one"', "If-None-Match": "*" }, 428],
    [{ "If-Match": 'W/"one"' }, 400],
    [{ "If-None-Match": '"one"' }, 400],
  ] as const) {
    const response = await fetch(url, {
      method: "PUT", body: "{}", headers: { ...headers, Authorization: fixture.auth, "Content-Type": "application/json" },
    });
    assert.equal(response.status, expected);
  }
  const invalidType = await fetch(url, {
    method: "PUT", body: "text", headers: { Authorization: fixture.auth, "If-None-Match": "*" },
  });
  assert.equal(invalidType.status, 415);
  assert.equal(fixture.calls.length, 0);
});

test("size limits reject declared and chunked bodies without any upstream write", async (t) => {
  const fixture = await gatewayFixture({ maxBodyBytes: 4 });
  t.after(() => fixture.close());
  const url = fixture.url + "/dav/gateway-test/head.json";
  const headers = { Authorization: fixture.auth, "If-None-Match": "*", "Content-Type": "application/json" };
  const declared = await fetch(url, { method: "PUT", body: "12345", headers });
  assert.equal(declared.status, 413);
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.close(); },
  });
  const init: RequestInit & { duplex: "half" } = { method: "PUT", headers, body: stream, duplex: "half" };
  const chunked = await fetch(url, init);
  assert.equal(chunked.status, 413);
  assert.equal(fixture.calls.length, 0);
});

test("upstream timeout is explicit and error logs do not expose credentials", async (t) => {
  const fixture = await gatewayFixture({ timeoutMs: 50 }, async (input, init) => {
    const request = new Request(input, init);
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  });
  t.after(() => fixture.close());
  const response = await fetch(fixture.url + "/dav/gateway-test/head.json", {
    headers: { Authorization: fixture.auth },
  });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_request_failed" });
  assert.ok(fixture.logs.includes("upstream_request_failed"));
  const logs = fixture.logs.join(" ");
  assert.ok(!logs.includes(fixture.config.password) && !logs.includes(fixture.config.upstreamPassword));
});

test("concurrency overload is rejected without starting a second upstream request", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (response: Response) => void;
  const fixture = await gatewayFixture({ maxConcurrent: 1 }, async () => {
    entered();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  t.after(() => fixture.close());
  const url = fixture.url + "/dav/gateway-test/head.json";
  const first = fetch(url, { headers: { Authorization: fixture.auth } });
  await started;
  try {
    const second = await fetch(url, { headers: { Authorization: fixture.auth } });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("Retry-After"), "1");
  } finally {
    release(new Response("{}", { headers: { ETag: '"one"' } }));
  }
  assert.equal((await first).status, 200);
});

test("upstream redirects are blocked and upstream cookies are not exposed", async (t) => {
  const redirected = await gatewayFixture({}, async () =>
    new Response(null, { status: 302, headers: { Location: "https://evil.example" } }));
  t.after(() => redirected.close());
  const denied = await fetch(redirected.url + "/dav/gateway-test/head.json",
    { headers: { Authorization: redirected.auth } });
  assert.equal(denied.status, 502);
  const safe = await gatewayFixture({}, async () =>
    new Response("{}", { headers: { ETag: '"one"', "Set-Cookie": "do-not-forward=this" } }));
  t.after(() => safe.close());
  const response = await fetch(safe.url + "/dav/gateway-test/head.json",
    { headers: { Authorization: safe.auth } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("ETag"), '"one"');
});

test("configuration fails closed for missing credentials, weak secrets and unsafe targets", () => {
  assert.throws(() => gatewayConfig({}));
  const valid = {
    KOOFR_WEBDAV_URL: gatewayDefaults.upstream, KOOFR_USERNAME: gatewayDefaults.upstreamUsername,
    KOOFR_APP_PASSWORD: gatewayDefaults.upstreamPassword,
    GATEWAY_USERNAME: gatewayDefaults.username, GATEWAY_PASSWORD: gatewayDefaults.password,
  };
  assert.equal(gatewayConfig(valid).maxBodyBytes, 256 * 1024 * 1024);
  assert.throws(() => gatewayConfig({ ...valid, GATEWAY_PASSWORD: "weak" }));
  assert.throws(() => gatewayConfig({ ...valid, GATEWAY_PREFIX: "parent/child" }));
  assert.throws(() => gatewayConfig({ ...valid, GATEWAY_ALLOWED_ORIGINS: "*" }));
  assert.throws(() => gatewayConfig({ ...valid, GATEWAY_MAX_CONCURRENT: "0" }));
  for (const upstream of ["https://evil.example/dav/Koofr/", "http://app.koofr.net/dav/Koofr/",
    "https://user:secret@app.koofr.net/dav/Koofr/",
    "https://app.koofr.net/dav/Koofr/AppData/../Other/",
    "https://app.koofr.net/dav/Koofr/%2e%2e/"]) {
    assert.throws(() => createGatewayServer({ ...gatewayDefaults, upstream }));
  }
});

test("health check is local readiness only, with no upstream requests", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const response = await fetch(fixture.url + "/healthz");
  assert.deepEqual(await response.json(), { status: "ready", upstreamTested: false });
  assert.equal(fixture.calls.length, 0);
});
