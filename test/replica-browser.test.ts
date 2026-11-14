import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import { recordId } from "../src/model";
import { storageServer } from "./http-server";

declare global {
  interface Window { ReplicaFixture: typeof import("./replica-browser-fixture"); }
}

test("Chromium replicas persist causal parents, paginate S3 and recover upload/apply interruptions", { timeout: 90_000 }, async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./replica-browser-fixture.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", globalName: "ReplicaFixture", platform: "browser", target: "es2022",
  });
  const script = bundle.outputFiles[0]!.text;
  const storage = await storageServer();
  storage.options.listPageSize = 1;
  t.after(() => storage.close());
  const web = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/fixture.js" ? script : "<!doctype html><title>Causal replica fixture</title>");
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>((resolve) => { web.close(() => resolve()); web.closeAllConnections(); }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const errors: string[] = [];
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  const connect = async (page: Page, prefix = "browser-log") => {
    await page.goto(url);
    await page.addScriptTag({ url: url + "/fixture.js" });
    await page.evaluate(({ endpoint, prefix }) => window.ReplicaFixture.connect(endpoint, prefix),
      { endpoint: storage.url, prefix });
  };
  await connect(a);
  await a.evaluate(() => window.ReplicaFixture.reset());
  await a.evaluate(() => window.ReplicaFixture.edit("CHAT_one", "base"));
  await a.evaluate(() => window.ReplicaFixture.publish());
  await connect(b);
  await b.evaluate(() => window.ReplicaFixture.reset());
  await b.evaluate(async () => window.ReplicaFixture.apply(await window.ReplicaFixture.review()));
  await connect(b);
  assert.deepEqual(await b.evaluate(() => window.ReplicaFixture.snapshot()),
    await a.evaluate(() => window.ReplicaFixture.snapshot()));
  await a.evaluate(() => window.ReplicaFixture.edit("CHAT_left", "left"));
  await b.evaluate(() => window.ReplicaFixture.edit("CHAT_right", "right"));
  await Promise.all([
    a.evaluate(() => window.ReplicaFixture.publish()),
    b.evaluate(() => window.ReplicaFixture.publish()),
  ]);
  await a.evaluate(async () => window.ReplicaFixture.apply(await window.ReplicaFixture.review()));
  await b.evaluate(async () => window.ReplicaFixture.apply(await window.ReplicaFixture.review()));
  await Promise.all([connect(a), connect(b)]);
  const merged = await a.evaluate(() => window.ReplicaFixture.snapshot());
  assert.equal(Object.keys(merged).length, 3);
  assert.deepEqual(merged, await b.evaluate(() => window.ReplicaFixture.snapshot()));
  const persisted = await b.evaluate(() => window.ReplicaFixture.state());
  assert.equal(typeof persisted, "string");
  for (const secret of ["fixture-secret", "browser-replica-passphrase", "CHAT_one"]) {
    assert.ok(!String(persisted).includes(secret));
  }
  await a.evaluate(() => window.ReplicaFixture.remove("CHAT_one"));
  await a.evaluate(() => window.ReplicaFixture.publish());
  const seenDeletion = await b.evaluate(() => window.ReplicaFixture.review());
  assert.deepEqual(seenDeletion.deleted, [recordId("idb", "CHAT_one")]);
  await b.evaluate(() => window.ReplicaFixture.edit("CHAT_one", "offline"));
  const conflicted = await b.evaluate(() => window.ReplicaFixture.publish());
  assert.equal(conflicted.records, null);
  assert.equal(conflicted.conflicts.length, 1);
  await assert.rejects(b.evaluate((view) => window.ReplicaFixture.apply(view), conflicted), /explicit resolution/);

  await connect(a, "browser-retry");
  await a.evaluate(() => window.ReplicaFixture.reset());
  await a.evaluate(() => window.ReplicaFixture.edit("CHAT_retry", "retry"));
  await a.evaluate(() => window.ReplicaFixture.failUpload());
  await assert.rejects(a.evaluate(() => window.ReplicaFixture.publish()), /connection lost/);
  const retriesBefore = [...storage.objects].filter(([key]) => key.includes("/browser-retry/commits/"));
  assert.equal(retriesBefore.length, 1);
  await connect(a, "browser-retry");
  await a.evaluate(() => window.ReplicaFixture.publish());
  assert.deepEqual([...storage.objects].filter(([key]) => key.includes("/browser-retry/commits/")), retriesBefore);
  await connect(b, "browser-retry");
  await b.evaluate(() => window.ReplicaFixture.reset());
  await b.evaluate(() => window.ReplicaFixture.failApply());
  await assert.rejects(b.evaluate(async () => window.ReplicaFixture.apply(await window.ReplicaFixture.review())),
    /interrupted after application/);
  await connect(b, "browser-retry");
  await assert.rejects(b.evaluate(() => window.ReplicaFixture.review()), /Interrupted local application/);
  await b.evaluate(() => window.ReplicaFixture.recover());
  await connect(b, "browser-retry");
  assert.deepEqual(await b.evaluate(() => window.ReplicaFixture.snapshot()), {});
  await b.evaluate(async () => window.ReplicaFixture.apply(await window.ReplicaFixture.review()));
  await connect(b, "browser-retry");
  assert.deepEqual(await b.evaluate(() => window.ReplicaFixture.snapshot()),
    await a.evaluate(() => window.ReplicaFixture.snapshot()));
  assert.ok(storage.requests.some(({ path }) => path.includes("continuation-token=")));
  assert.ok(storage.requests.every(({ headers }) => /^AWS4-HMAC-SHA256/.test(String(headers.authorization))));
  assert.ok(storage.requests.every(({ headers }) => !headers["if-match"] && !headers["if-none-match"]));
  assert.ok(storage.requests.every(({ method }) => method === "GET" || method === "PUT"));
  assert.deepEqual(errors, []);
});
