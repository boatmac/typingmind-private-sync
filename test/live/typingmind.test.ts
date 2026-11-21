import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { strFromU8, unzipSync } from "fflate";
import { Vault } from "../../src/crypto";
import { unpack } from "../../src/codec";
import { recordId, validateHead, type Records } from "../../src/model";
import { ImmutableLog } from "../../src/immutable-log";
import { ImmutableS3Store } from "../../src/immutable-s3";
import { storageServer } from "../http-server";

const appUrl = "https://www.typingmind.com/";
const script = fileURLToPath(new URL("../../dist/typingmind-private-sync.js", import.meta.url));
const chatId = "TmPsLive01";
const title = "Private Sync isolated integration test";
const content = "Synthetic message for a local compatibility test. No model was called.";
const passphrase = "isolated-live-test-passphrase";

async function dismissPromotions(page: Page): Promise<void> {
  await page.addLocatorHandler(
    page.locator("#headlessui-portal-root").getByText("Get a lifetime license", { exact: true }).first(),
    async () => { await page.keyboard.press("Escape"); },
  );
}

async function openApp(page: Page): Promise<void> {
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('[data-element-id="workspace-tab-settings"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => localStorage.getItem("TM_useExampleFilled") !== null);
}

async function addSyntheticChat(page: Page): Promise<void> {
  await page.evaluate(async ({ chatId, title, content }) => {
    const request = indexedDB.open("keyval-store");
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains("keyval")) {
          db.close();
          reject(new Error("Live app schema changed."));
          return;
        }
        const tx = db.transaction("keyval", "readwrite");
        const store = tx.objectStore("keyval");
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) { tx.abort(); return; }
          if (typeof item.key !== "string" || !item.key.startsWith("CHAT_")) {
            item.continue();
            return;
          }
          store.put({
            id: chatId, chatID: chatId, model: item.value.model,
            folderID: item.value.folderID,
            chatTitle: title, preview: content, tags: [],
            updatedAt: new Date(), lastMessageCreatedAt: new Date(),
            messages: [{ role: "user", uuid: "TmPsMsg001", content }],
          }, "CHAT_" + chatId);
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, { chatId, title, content });
}

async function readSyntheticChat(page: Page): Promise<unknown> {
  return page.evaluate(async (chatId) => {
    const request = indexedDB.open("keyval-store");
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("keyval", "readonly");
        const read = tx.objectStore("keyval").get("CHAT_" + chatId);
        read.onsuccess = () => resolve(read.result);
        tx.oncomplete = () => db.close();
        tx.onabort = () => reject(tx.error);
      };
    });
  }, chatId);
}

async function waitResult(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const root = document.getElementById("typingmind-private-sync-root")?.shadowRoot;
    return root?.getElementById("sync")?.hasAttribute("disabled") === false;
  }, undefined, { timeout: 30_000 });
  return await page.locator("#status").innerText();
}

async function unlock(page: Page, endpoint: string, protocol: "snapshot" | "immutable" = "snapshot"): Promise<void> {
  await page.addScriptTag({ path: script });
  await page.getByRole("button", { name: "Private Sync", exact: true }).click();
  await page.removeLocatorHandler(
    page.locator("#headlessui-portal-root").getByText("Get a lifetime license", { exact: true }).first());
  await page.locator("#endpoint").fill(endpoint);
  if (protocol === "immutable") {
    await page.locator("#provider").selectOption("s3");
    assert.equal(await page.locator("#protocol").inputValue(), "immutable");
    await page.locator("#dataset").fill("live-immutable-dataset");
    await page.locator("#prefix").fill("live-immutable");
    await page.locator("#bucket").fill("test-bucket");
    await page.locator("#region").fill("us-east-1");
    await page.locator("#access-key").fill("isolated-test-access");
    await page.locator("#secret-key").fill("isolated-test-secret");
  } else {
    await page.locator("#username").fill("isolated-test-user");
    await page.locator("#dav-password").fill("isolated-test-password");
  }
  await page.locator("#passphrase").fill(passphrase);
  await page.locator("#acknowledge").check();
  await page.getByRole("button", { name: "Unlock / connect" }).click();
  assert.match(await waitResult(page), /Unlocked/);
}

for (const protocol of ["snapshot", "immutable"] as const) {
test(`live TypingMind officially exports a synthetic chat after ${protocol} sync and app reload`, {
  timeout: 180_000,
}, async (t) => {
  const storage = await storageServer();
  t.after(() => storage.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const endpoint = "https://typingmind-private-sync.test" + (protocol === "snapshot" ? "/dav/" : "");
  let modelRequests = 0;
  const contexts: BrowserContext[] = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    contexts.push(context);
    await context.route("https://typingmind-private-sync.test/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const path = requestUrl.pathname + requestUrl.search;
      const response = await route.fetch({ url: storage.url + path });
      await route.fulfill({ response });
    });
    await context.route(/https:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)\//, async (route) => {
      modelRequests++;
      await route.abort("blockedbyclient");
    });
  }
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  assert.ok(a && b);
  await Promise.all([dismissPromotions(a), dismissPromotions(b)]);
  await openApp(a);
  await addSyntheticChat(a);
  await openApp(a);
  await unlock(a, endpoint, protocol);
  await a.getByRole("button", { name: "Sync now", exact: true }).click();
  assert.match(await waitResult(a), /Sync complete/, "Live app upload must actually succeed.");
  const vault = new Vault(passphrase);
  let remoteRecords: Records;
  let immutableTip = "";
  if (protocol === "snapshot") {
    const object = storage.objects.get("/dav/typingmind-private/head.json");
    assert.ok(object);
    remoteRecords = validateHead(await vault.open(object.text)).records;
  } else {
    const view = await new ImmutableLog(new ImmutableS3Store({
      provider: "s3", endpoint: storage.url, prefix: "live-immutable", bucket: "test-bucket",
      region: "us-east-1", username: "", exclusions: [],
    }, {
      password: "", accessKeyId: "isolated-test-access", secretAccessKey: "isolated-test-secret", sessionToken: "",
    }), vault, "live-immutable-dataset").read();
    assert.ok(view.records);
    remoteRecords = view.records;
    immutableTip = view.tips[0]!;
  }
  const packedChat = remoteRecords[recordId("idb", "CHAT_" + chatId)];
  assert.ok(packedChat);
  const received = await unpack(packedChat) as { updatedAt: unknown; chatTitle: string };
  assert.ok(received.updatedAt instanceof Date);
  assert.equal(received.chatTitle, title);
  assert.ok(!Object.keys(remoteRecords).some((id) => id.includes("TM_MIGRATE_")));

  await openApp(b);
  assert.equal(await readSyntheticChat(b), undefined);
  await unlock(b, endpoint, protocol);
  b.on("dialog", async (dialog) => { await dialog.accept(); });
  await b.getByRole("button", { name: "Sync now", exact: true }).click();
  let status = await waitResult(b);
  if (status.includes("Conflicting changes")) {
    await b.getByRole("button", { name: "Retry: keep remote conflicting records", exact: true }).click();
    status = await waitResult(b);
  }
  if (protocol === "immutable" && status.includes("record conflict(s) need review")) {
    for (const select of await b.locator("#log-versions select").all()) {
      const options = select.locator("option").filter({ hasText: immutableTip.slice(0, 10) });
      assert.equal(await options.count(), 1, "Every shared default conflict must offer the first device's version.");
      const value = await options.getAttribute("value");
      assert.ok(value);
      await select.selectOption(value);
    }
    await b.getByRole("button", { name: "Resolve selected versions and sync", exact: true }).click();
    status = await waitResult(b);
  }
  assert.match(status, /Synced and verified/, "Fresh app defaults may need explicit conflict resolution.");
  await openApp(b);
  assert.deepEqual(await readSyntheticChat(b), await readSyntheticChat(a),
    "Native typed records must survive an actual application reload.");
  await dismissPromotions(b);
  await b.locator('[data-element-id="workspace-tab-settings"]').click();
  await b.getByText("Export", { exact: true }).first().waitFor();
  await b.getByText("Export", { exact: true }).first().click();
  const pending = b.waitForEvent("download");
  await b.getByText("Download File", { exact: true }).first().click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.zip$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const files = unzipSync(Buffer.concat(chunks));
  const exportedData = files["data.json"];
  assert.ok(exportedData, "Native export must contain data.json.");
  const exported = JSON.parse(strFromU8(exportedData));
  assert.ok(Array.isArray(exported.data.chats));
  const chat = exported.data.chats.find((chat: { id: string }) => chat.id === chatId);
  assert.ok(chat, "The native application export must include the synced chat.");
  assert.equal(chat.chatTitle, title);
  assert.equal(chat.messages[0].content, content);
  assert.equal(modelRequests, 0, "The live test must not make any model API requests.");
});
}

test("live TypingMind native extension installer loads the bundle after reload and honors safe mode", {
  timeout: 90_000,
}, async (t) => {
  const body = await readFile(script, "utf8");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const url = "https://typingmind-private-sync.test/extension.js";
  await context.route(url, (route) => route.fulfill({
    contentType: "application/javascript",
    headers: { "Access-Control-Allow-Origin": "*" }, body,
  }));
  const page = await context.newPage();
  await dismissPromotions(page);
  page.on("dialog", async (dialog) => { await dialog.accept(); });
  await openApp(page);
  await page.locator('[data-element-id="workspace-tab-settings"]').click();
  await page.getByText("Extensions", { exact: true }).first().waitFor();
  await page.getByText("Extensions", { exact: true }).first().click();
  await page.getByPlaceholder("Enter extension URL", { exact: true }).fill(url);
  await page.getByText("Install", { exact: true }).first().click();
  await page.waitForFunction((url) =>
    Object.keys(localStorage).some((key) => localStorage.getItem(key)?.includes(url)), url);
  await openApp(page);
  // The host has zero layout size; its fixed-position shadow button is visible.
  await page.getByRole("button", { name: "Private Sync", exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Private Sync", exact: true }).click();
  await page.getByRole("dialog", { name: "TypingMind Private Sync", exact: true }).waitFor();
  assert.match(await page.locator("#status").innerText(), /Locked/);
  await page.goto(appUrl + "?safe_mode=1", { waitUntil: "domcontentloaded" });
  await page.locator('[data-element-id="workspace-tab-settings"]').waitFor();
  assert.equal(await page.locator("#typingmind-private-sync-root").count(), 0);
});
