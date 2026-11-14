import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/codec";
import { ImmutableS3Store } from "../src/immutable-s3";
import type { Config } from "../src/provider";
import { storageServer } from "./http-server";

const secrets = { password: "", accessKeyId: "test-access", secretAccessKey: "test-secret", sessionToken: "" };
const s3Config: Config = {
  provider: "s3", endpoint: "https://storage.example", bucket: "test-bucket",
  prefix: "immutable-test", region: "us-east-1", username: "", exclusions: [],
};

test("immutable S3 uses signed, prefix-scoped pagination and content-addressed unconditional PUT", async (t) => {
  const server = await storageServer();
  t.after(() => server.close());
  server.options.listPageSize = 1;
  const store = new ImmutableS3Store({ ...s3Config, endpoint: server.url }, secrets);
  const first = await sha256("first");
  const second = await sha256("second");
  await store.put(first, "first");
  await store.put(second, "second");
  assert.deepEqual(await store.list(), [first, second].sort());
  assert.equal(await store.get(first), "first");
  assert.equal(await store.get("0".repeat(64)), null);
  const lists = server.requests.filter(({ path }) => path.includes("list-type=2"));
  assert.equal(lists.length, 2);
  assert.ok(lists.every(({ path }) => new URL(path, server.url).searchParams.get("prefix") === "immutable-test/commits/"));
  assert.ok(server.requests.every(({ headers }) => /^AWS4-HMAC-SHA256/.test(String(headers.authorization))));
  assert.ok(server.requests.every(({ headers }) => !headers["if-match"] && !headers["if-none-match"]));
  await assert.rejects(store.put(first, "different"), /object ID/);
  await assert.rejects(store.get("../outside"), /object ID/);
  server.options.status = 403;
  await assert.rejects(store.list(), /403/);
});

test("invalid list scope, malformed XML, foreign objects and nonprogressing pagination fail closed", async () => {
  const root = (body: string, prefix = "immutable-test/commits/") =>
    `<ListBucketResult><Name>test-bucket</Name><Prefix>${prefix}</Prefix>${body}</ListBucketResult>`;
  for (const xml of [
    "<broken>",
    '<!DOCTYPE root [<!ENTITY secret "value">]>' + root("<IsTruncated>false</IsTruncated>"),
    root("<IsTruncated>false</IsTruncated>", "another-prefix/"),
    root("<IsTruncated>false</IsTruncated><Contents><Key>elsewhere.json</Key></Contents>"),
    root("<IsTruncated>true</IsTruncated>"),
    root("<IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>"),
  ]) {
    const store = new ImmutableS3Store(s3Config, secrets, async () => new Response(xml));
    await assert.rejects(store.list(), /XML|scope|out-of-scope|pagination/);
  }
});

test("continuation tokens are opaque and XML-unescaped before URL encoding", async () => {
  const tokens: (string | null)[] = [];
  const store = new ImmutableS3Store(s3Config, secrets, async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    tokens.push(new URL(request.url).searchParams.get("continuation-token"));
    return new Response("<ListBucketResult><Name>test-bucket</Name><Prefix>immutable-test/commits/</Prefix>" +
      (tokens.length === 1
        ? "<IsTruncated>true</IsTruncated><NextContinuationToken>+a&amp;b=/</NextContinuationToken>"
        : "<IsTruncated>false</IsTruncated>") + "</ListBucketResult>");
  });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(tokens, [null, "+a&b=/"]);
});
