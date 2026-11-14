import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { Vault } from "../src/crypto";
import { unpack } from "../src/codec";
import { recordId, validateHead } from "../src/model";
import { storageServer } from "./http-server";

const password = "immutable-ui-test-passphrase";
async function chat(page: Page, key: string, message?: string): Promise<{ messages: string[]; attachment: string } | null> {
  return page.evaluate(async ({ key, message }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keyval");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let result: { messages: string[]; attachment: Blob } | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keyval", message === undefined ? "readonly" : "readwrite");
        const store = tx.objectStore("keyval");
        if (message !== undefined) store.put({
          messages: [message], attachment: new Blob(["ui-image"], { type: "image/png" }),
        }, key);
        const request = store.get(key);
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    return result ? { messages: result.messages, attachment: await result.attachment.text() } : null;
  }, { key, message });
}

async function finished(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const root = document.getElementById("typingmind-private-sync-root")?.shadowRoot;
    const button = root?.getElementById("sync") as HTMLButtonElement | null;
    return button && !button.disabled && !root?.getElementById("status")?.textContent?.startsWith("Working.");
  }, undefined, { timeout: 20_000 });
  return page.locator("#status").innerText();
}

test("installed artifact exposes opt-in immutable sync, reviewed conflicts, remote backups and local recovery", { timeout: 120_000 }, async (t) => {
  const script = await readFile(new URL("../dist/typingmind-private-sync.js", import.meta.url));
  const storage = await storageServer();
  storage.options.listPageSize = 1;
  storage.options.unsafe = true;
  t.after(() => storage.close());
  const web = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/extension.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/extension.js" ? script : "<!doctype html><title>Immutable UI fixture</title>");
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>((resolve) => { web.close(() => resolve()); web.closeAllConnections(); }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Missing UI fixture address.");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const contextA = await browser.newContext({ acceptDownloads: true });
  const contextB = await browser.newContext({ acceptDownloads: true });
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const errors: string[] = [];
  for (const page of [a, b]) {
    page.on("dialog", async (dialog) => dialog.accept());
    page.on("pageerror", (error) => errors.push(error.message));
  }
  const unlock = async (page: Page, dataset = "shared-ui-dataset") => {
    await page.goto(url);
    await chat(page, "CHAT_missing");
    await page.addScriptTag({ url: url + "/extension.js" });
    await page.getByRole("button", { name: "Private Sync", exact: true }).click();
    await page.locator("#provider").selectOption("s3");
    await page.locator("#protocol").selectOption("immutable");
    await page.locator("#dataset").fill(dataset);
    await page.locator("#endpoint").fill(storage.url);
    await page.locator("#prefix").fill("ui-immutable");
    await page.locator("#bucket").fill("test-bucket");
    await page.locator("#region").fill("us-east-1");
    await page.locator("#access-key").fill("ui-access");
    await page.locator("#secret-key").fill("ui-secret");
    await page.locator("#passphrase").fill(password);
    await page.locator("#acknowledge").check();
    await page.getByRole("button", { name: "Unlock / connect" }).click();
    assert.match(await finished(page), /Unlocked/);
    assert.equal(await page.locator("#passphrase").inputValue(), "");
  };
  const sync = async (page: Page) => {
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    return finished(page);
  };
  await a.goto(url);
  await a.addScriptTag({ url: url + "/extension.js" });
  assert.equal(await a.locator("#protocol").inputValue(), "snapshot");
  await unlock(a);
  const writesBeforeProbe = storage.requests.filter(({ method }) => method === "PUT").length;
  await a.getByRole("button", { name: "Test storage", exact: true }).click();
  assert.match(await finished(a), /listing verified.*Write access is checked/);
  assert.equal(storage.requests.filter(({ method }) => method === "PUT").length, writesBeforeProbe);
  await chat(a, "CHAT_one", "base");
  assert.match(await sync(a), /Sync complete/);
  await unlock(b);
  assert.match(await sync(b), /Synced and verified/);
  assert.deepEqual(await chat(b, "CHAT_one"), { messages: ["base"], attachment: "ui-image" });
  await unlock(b);
  await a.getByRole("button", { name: "Create backup", exact: true }).click();
  assert.match(await finished(a), /Backup saved/);
  await a.getByRole("button", { name: "Refresh backups", exact: true }).click();
  assert.match(await finished(a), /1 remote backup/);
  assert.equal(await a.locator("#backups option").count(), 1);
  const backupId = await a.locator("#backups").inputValue();
  assert.match(backupId, /^[0-9a-f]{64}$/);
  await chat(a, "CHAT_one", "edit-A");
  await chat(b, "CHAT_one", "edit-B");
  await chat(a, "CHAT_a", "only A");
  await chat(b, "CHAT_b", "only B");
  await Promise.all([sync(a), sync(b)]);
  assert.match(await sync(b), /explicit resolution/);
  assert.equal(await b.locator("#conflicts").isVisible(), false);
  assert.equal(await b.locator("#log-conflicts").isVisible(), true);
  await b.getByRole("button", { name: "Resolve selected versions and sync" }).click();
  assert.match(await finished(b), /Choose a version/);
  assert.equal(await b.locator("#log-conflicts").isVisible(), true);
  await b.locator("#log-versions select").selectOption("0");
  await b.locator("#log-versions pre").filter({ hasText: "edit-A" }).waitFor();
  await b.getByRole("button", { name: "Resolve selected versions and sync" }).click();
  assert.match(await finished(b), /Synced and verified/);
  assert.equal(await b.locator("#log-conflicts").isVisible(), false);
  assert.deepEqual(await chat(b, "CHAT_one"), { messages: ["edit-A"], attachment: "ui-image" });
  await unlock(b);
  assert.match(await sync(a), /Synced and verified/);
  await unlock(a);
  assert.deepEqual(await chat(a, "CHAT_b"), { messages: ["only B"], attachment: "ui-image" });
  const beforeRestore = [...storage.objects];
  await b.getByRole("button", { name: "Refresh backups", exact: true }).click();
  assert.match(await finished(b), /1 remote backup/);
  await b.locator("#backups").selectOption(backupId);
  await b.getByRole("button", { name: "Restore selected to this device" }).click();
  assert.match(await finished(b), /Local restore verified/);
  assert.deepEqual([...storage.objects], beforeRestore);
  assert.deepEqual(await chat(b, "CHAT_one"), { messages: ["base"], attachment: "ui-image" });
  assert.equal(await chat(b, "CHAT_b"), null);
  await unlock(b);
  assert.match(await sync(b), /Sync complete/);
  assert.match(await sync(a), /Synced and verified/);
  const rollbackDownload = a.waitForEvent("download");
  await a.getByRole("button", { name: "Download local rollback", exact: true }).click();
  assert.match(await finished(a), /rollback downloaded/);
  const download = await rollbackDownload;
  const path = await download.path();
  assert.ok(path);
  const rollbackText = await readFile(path, "utf8");
  const rollback = validateHead(await new Vault(password).open(rollbackText));
  const oldChat = await unpack(rollback.records[recordId("idb", "CHAT_one")]!) as { messages: string[] };
  assert.deepEqual(oldChat.messages, ["edit-A"]);
  const beforeImport = [...storage.objects];
  await b.locator("#file").setInputFiles({
    name: "encrypted-rollback.json", mimeType: "application/json", buffer: Buffer.from(rollbackText),
  });
  assert.match(await finished(b), /Local import verified/);
  assert.deepEqual([...storage.objects], beforeImport);
  assert.deepEqual(await chat(b, "CHAT_one"), { messages: ["edit-A"], attachment: "ui-image" });
  const immutableWrites = storage.requests.filter(({ method }) => method === "PUT");
  assert.ok(immutableWrites.every(({ headers }) => !headers["if-match"] && !headers["if-none-match"]));
  assert.ok(immutableWrites.every(({ path }) => /^\/test-bucket\/ui-immutable\/(?:commits|backups)\/[0-9a-f]{64}\.json$/.test(path)));
  assert.ok(!storage.requests.some(({ method }) => method === "DELETE" || method === "MKCOL"));
  assert.ok(storage.requests.every(({ headers }) => /^AWS4-HMAC-SHA256/.test(String(headers.authorization))));
  await unlock(b, "different-ui-dataset");
  const writesBeforeWrongDataset = storage.requests.filter(({ method }) => method === "PUT").length;
  assert.match(await sync(b), /wrong dataset/);
  assert.equal(storage.requests.filter(({ method }) => method === "PUT").length, writesBeforeWrongDataset);
  await b.locator("#protocol").selectOption("snapshot");
  await b.locator("#prefix").fill("ui-legacy-unsafe");
  await b.locator("#access-key").fill("ui-access");
  await b.locator("#secret-key").fill("ui-secret");
  await b.locator("#passphrase").fill(password);
  await b.getByRole("button", { name: "Unlock / connect" }).click();
  assert.match(await finished(b), /Unlocked/);
  await b.getByRole("button", { name: "Test storage", exact: true }).click();
  assert.match(await finished(b), /conditional writes are ignored/);
  assert.ok(!storage.objects.has("/test-bucket/ui-legacy-unsafe/head.json"));
  const settings = await b.evaluate(() => localStorage.getItem("tmps:config"));
  assert.ok(!settings?.includes("ui-secret"));
  assert.ok(!settings?.includes(password));
  await a.goto(url + "/?safe_mode=1");
  await a.addScriptTag({ url: url + "/extension.js" });
  assert.equal(await a.locator("#typingmind-private-sync-root").count(), 0);
  assert.deepEqual(errors, []);
});
