import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { storageServer } from "./http-server";
import { gatewayFixture } from "./gateway-fixture";

async function seed(page: Page, initial: boolean): Promise<void> {
  await page.evaluate(async (initial) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keyval");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("keyval", "readwrite");
        if (initial) tx.objectStore("keyval").put({
          messages: ["from device A"], attachment: new Blob(["image-data"], { type: "image/png" }),
        }, "CHAT_one");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    if (initial) localStorage.setItem("TM_theme", "dark");
  }, initial);
}

test("built browser extension syncs two profiles through WebDAV, S3 and the scoped gateway", { timeout: 90_000 }, async (t) => {
  const script = await readFile(new URL("../dist/typingmind-private-sync.js", import.meta.url));
  const storage = await storageServer();
  t.after(() => storage.close());
  const web = createServer((request, response) => {
    if (request.url === "/extension.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(script);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><html><head><title>Test app fixture</title></head><body>Isolated data fixture</body></html>");
    }
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>((resolve) => {
    web.close(() => resolve());
    web.closeAllConnections();
  }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Missing browser test address.");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const errors: string[] = [];
  for (const page of [pageA, pageB]) page.on("pageerror", (error) => errors.push(error.message));

  const unlock = async (page: Page, options: {
    endpoint?: string; prefix?: string; username?: string; password?: string;
  } = {}) => {
    await page.addScriptTag({ url: url + "/extension.js" });
    await page.getByRole("button", { name: "Private Sync", exact: true }).click();
    assert.equal(await page.locator("#sync").isDisabled(), true);
    assert.equal(await page.locator("#test").isDisabled(), true);
    await page.locator("#provider").selectOption("webdav");
    await page.evaluate(() => {
      document.addEventListener("keydown", (event) => {
        if (event.key === "/" && !(event.target instanceof HTMLInputElement)) event.preventDefault();
      });
    });
    await page.locator("#endpoint").fill("");
    await page.locator("#endpoint").pressSequentially("https://storage.example/dav/");
    assert.equal(await page.locator("#endpoint").inputValue(), "https://storage.example/dav/");
    await page.locator("#dav-password").pressSequentially("fixture/password");
    assert.equal(await page.locator("#dav-password").inputValue(), "fixture/password");
    await page.locator("#endpoint").fill(options.endpoint ?? storage.url + "/dav/");
    await page.locator("#prefix").fill(options.prefix ?? "typingmind-private");
    await page.locator("#username").fill(options.username ?? "test-user");
    await page.locator("#dav-password").fill(options.password ?? "test-password");
    await page.locator("#passphrase").fill("browser-test-passphrase");
    await page.locator("#acknowledge").check();
    assert.equal(await page.locator("#test").isDisabled(), true);
    const requestsBeforeUnlock = storage.requests.length;
    await page.getByRole("button", { name: "Unlock / connect" }).click();
    await page.locator("#status").filter({ hasText: "Unlocked" }).waitFor();
    assert.equal(await page.locator("#passphrase").inputValue(), "");
    assert.equal(await page.locator("#dav-password").inputValue(), "");
    assert.equal(await page.locator("#passphrase").isDisabled(), true);
    assert.equal(await page.locator("#dav-password").isDisabled(), true);
    assert.equal(await page.locator("#connect").isDisabled(), true);
    assert.match(await page.locator("#session-state").innerText(), /Session unlocked.*in memory/);
    assert.equal(storage.requests.length, requestsBeforeUnlock);
  };
  await pageA.goto(url);
  await seed(pageA, true);
  await unlock(pageA);
  const storageRoute = storage.url + "/**";
  await pageA.route(storageRoute, (route) => route.abort("failed"));
  await pageA.getByRole("button", { name: "Test storage", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Storage network request failed" }).waitFor();
  assert.match(await pageA.locator("#status").innerText(), /CORS\/preflight/);
  assert.match(await pageA.locator("#session-state").innerText(), /Session unlocked/);
  assert.equal(await pageA.locator("#passphrase").isDisabled(), true);
  assert.equal(await pageA.locator("#test").isDisabled(), false);
  await pageA.unroute(storageRoute);
  await pageA.getByRole("button", { name: "Test storage", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Storage verified" }).waitFor();
  assert.ok(storage.requests.every(({ headers }) =>
    headers.authorization === "Basic " + btoa("test-user:test-password")));
  storage.options.status = 401;
  await pageA.getByRole("button", { name: "Test storage", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "HTTP 401" }).waitFor();
  assert.ok(!(await pageA.locator("#status").innerText()).includes("CORS/preflight"));
  assert.match(await pageA.locator("#session-state").innerText(), /Session unlocked/);
  storage.options.status = 0;
  await pageA.getByRole("button", { name: "Change credentials / lock", exact: true }).click();
  assert.equal(await pageA.locator("#test").isDisabled(), true);
  assert.equal(await pageA.locator("#passphrase").isDisabled(), false);
  assert.match(await pageA.locator("#session-state").innerText(), /Session locked/);
  await pageA.locator("#dav-password").fill("test-password");
  await pageA.locator("#passphrase").fill("browser-test-passphrase");
  await pageA.getByRole("button", { name: "Unlock / connect", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Unlocked" }).waitFor();
  await pageA.getByRole("button", { name: "Sync now", exact: true }).click();
  try {
    await pageA.locator("#status").filter({ hasText: "Sync complete" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`Initial browser sync failed: ${await pageA.locator("#status").textContent()}`, { cause: error });
  }
  const persisted = await pageA.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(!persisted.includes("test-password"));
  assert.ok(!persisted.includes("browser-test-passphrase"));
  await pageA.locator("#auto").check();
  await pageA.locator("#auto").uncheck();
  await pageA.locator("#status").filter({ hasText: "Background sync disabled" }).waitFor();

  await pageB.goto(url);
  await seed(pageB, false);
  await unlock(pageB);
  pageB.on("dialog", async (dialog) => { await dialog.accept(); });
  await pageB.getByRole("button", { name: "Sync now", exact: true }).click();
  await pageB.locator("#status").filter({ hasText: "Synced and verified" }).waitFor();
  const received = await pageB.evaluate(async () => {
    const request = indexedDB.open("keyval-store");
    const value = await new Promise<{ messages: string[]; attachment: Blob }>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("keyval", "readonly");
        const read = tx.objectStore("keyval").get("CHAT_one");
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
        tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    return { messages: value.messages, type: value.attachment.type,
      attachment: await value.attachment.text(), theme: localStorage.getItem("TM_theme") };
  });
  assert.deepEqual(received, {
    messages: ["from device A"], type: "image/png", attachment: "image-data", theme: "dark",
  });
  await pageA.getByRole("button", { name: "Create backup", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Backup saved" }).waitFor();
  await pageA.getByRole("button", { name: "Refresh backups", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "remote backup(s)" }).waitFor();
  assert.equal(await pageA.locator("#backups option").count(), 1);
  await pageA.getByRole("button", { name: "Lock / forget session credentials" }).click();
  await pageA.locator("#status").filter({ hasText: "Locked." }).waitFor();

  await pageA.locator("#provider").selectOption("s3");
  assert.equal(await pageA.locator("#protocol").inputValue(), "immutable");
  await pageA.locator("#dataset").fill("browser-s3-dataset");
  await pageA.locator("#endpoint").fill(storage.url);
  await pageA.locator("#prefix").fill("browser-s3");
  await pageA.locator("#bucket").fill("test-bucket");
  await pageA.locator("#access-key").fill("test-access");
  await pageA.locator("#secret-key").fill("test-secret");
  await pageA.locator("#passphrase").fill("browser-test-passphrase");
  await pageA.getByRole("button", { name: "Unlock / connect" }).click();
  await pageA.locator("#status").filter({ hasText: "Unlocked" }).waitFor();
  await pageA.getByRole("button", { name: "Sync now", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Sync complete" }).waitFor();
  const signed = storage.requests.find(({ method, path }) =>
    method === "PUT" && path.startsWith("/test-bucket/browser-s3/commits/"));
  assert.match(String(signed?.headers.authorization), /^AWS4-HMAC-SHA256/);

  await pageA.locator("#prefix").fill("different-prefix");
  await pageA.locator("#status").filter({ hasText: "Settings changed" }).waitFor();
  const writes = storage.requests.filter(({ method }) => method === "PUT").length;
  assert.equal(await pageA.locator("#sync").isDisabled(), true);
  assert.equal(await pageA.locator("#test").isDisabled(), true);
  assert.equal(storage.requests.filter(({ method }) => method === "PUT").length, writes);

  const gateway = await gatewayFixture({ origins: [url] });
  t.after(() => gateway.close());
  const gatewayOptions = {
    endpoint: gateway.url + "/dav/", prefix: gateway.config.prefix,
    username: gateway.config.username, password: gateway.config.password,
  };
  await pageA.goto(url);
  await pageA.evaluate(async () => {
    const request = indexedDB.open("keyval-store");
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("keyval", "readwrite");
        tx.objectStore("keyval").put({ messages: ["through the gateway"] }, "CHAT_gateway");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  await unlock(pageA, gatewayOptions);
  await pageA.getByRole("button", { name: "Sync now", exact: true }).click();
  await pageA.locator("#status").filter({ hasText: "Sync complete" }).waitFor();
  await pageB.goto(url);
  await unlock(pageB, gatewayOptions);
  await pageB.getByRole("button", { name: "Sync now", exact: true }).click();
  await pageB.locator("#status").filter({ hasText: "Synced and verified" }).waitFor();
  const viaGateway = await pageB.evaluate(async () => {
    const request = indexedDB.open("keyval-store");
    return new Promise<{ messages: string[] }>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("keyval", "readonly");
        const read = tx.objectStore("keyval").get("CHAT_gateway");
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
        tx.onabort = () => reject(tx.error);
      };
    });
  });
  assert.deepEqual(viaGateway.messages, ["through the gateway"]);
  assert.ok(gateway.calls.length > 0);
  const upstreamAuth = "Basic " + Buffer.from(
    `${gateway.config.upstreamUsername}:${gateway.config.upstreamPassword}`).toString("base64");
  assert.ok(gateway.calls.every((request) => request.headers.get("Authorization") === upstreamAuth));

  await pageA.goto(url + "/?safe_mode=1");
  await pageA.addScriptTag({ url: url + "/extension.js" });
  assert.equal(await pageA.locator("#typingmind-private-sync-root").count(), 0);
  assert.deepEqual(errors, []);
});
