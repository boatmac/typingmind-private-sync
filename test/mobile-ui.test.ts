import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const browserName = process.env.TMPS_TEST_BROWSER ?? "chromium";
if (browserName !== "chromium" && browserName !== "webkit") throw new Error("Unknown UI test browser.");

test(`${browserName} mobile UI preserves its storage protocol and contains the launcher and dialog`, { timeout: 90_000 }, async (t) => {
  const script = await readFile(new URL("../dist/typingmind-private-sync.js", import.meta.url));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/extension.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/extension.js" ? script :
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;display:flex;flex-direction:column;gap:20px}main{height:100vh;flex-shrink:0;position:relative;z-index:30}</style><main>Mobile app fixture</main><script src="/extension.js"></script>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mobile fixture address.");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await (browserName === "webkit" ? webkit : chromium).launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(url);
  const dimensions = () => page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
  }));
  const closed = await dimensions();
  assert.ok(closed.width <= closed.viewportWidth, "The launcher must not widen the page.");
  assert.ok(closed.height <= closed.viewportHeight, "The launcher must not add a blank row below the page.");
  await page.locator("#launcher").click();
  await page.locator("#provider").selectOption("s3");
  assert.equal(await page.locator("#protocol").inputValue(), "immutable");
  assert.equal(await page.locator("#protocol").isDisabled(), true);
  assert.equal(await page.locator("#immutable-fields").isVisible(), true);
  const bounds = await page.getByRole("dialog", { name: "TypingMind Private Sync" }).boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 375 && bounds.y + bounds.height <= 667);
  await page.locator("#endpoint").fill(url);
  await page.locator("#prefix").fill("mobile-config");
  await page.locator("#bucket").fill("fixture-bucket");
  await page.locator("#dataset").fill("shared-mobile-dataset");
  await page.locator("#access-key").fill("fixture-access");
  await page.locator("#secret-key").fill("fixture-secret");
  await page.locator("#passphrase").fill("mobile-test-passphrase");
  await page.locator("#acknowledge").check();
  const statusBounds = await page.locator("#status").boundingBox();
  assert.ok(statusBounds && statusBounds.y >= 0 && statusBounds.y + statusBounds.height <= 667,
    "The operation status must remain visible when scrolled to the action controls.");
  await page.locator("#connect").click();
  await page.locator("#status").filter({ hasText: "Unlocked" }).waitFor();
  const config = await page.evaluate(() => localStorage.getItem("tmps:config"));
  assert.ok(config);
  assert.equal(JSON.parse(config).protocol, "immutable");
  for (const secret of ["fixture-access", "fixture-secret", "mobile-test-passphrase"]) assert.ok(!config.includes(secret));
  await page.locator("#reload").click();
  await page.waitForFunction(() =>
    document.getElementById("typingmind-private-sync-root")?.shadowRoot?.getElementById("sync")?.hasAttribute("disabled"));
  await page.locator("#launcher").click();
  assert.equal(await page.locator("#provider").inputValue(), "s3");
  assert.equal(await page.locator("#protocol").inputValue(), "immutable");
  assert.equal(await page.locator("#dataset").inputValue(), "shared-mobile-dataset");
  assert.equal(await page.locator("#passphrase").inputValue(), "");
  assert.equal(await page.locator("#sync").isDisabled(), true);
  await page.locator("#protocol").evaluate((select) => {
    (select as HTMLSelectElement).value = "snapshot";
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  });
  assert.equal(await page.locator("#protocol").inputValue(), "immutable", "Saved configuration must survive late native form restoration.");
  await page.locator("#provider").selectOption("webdav");
  assert.equal(await page.locator("#protocol").inputValue(), "snapshot");
  assert.equal(await page.locator("#immutable-fields").isVisible(), false);
  await page.locator("#close").click();
  await page.evaluate(() => localStorage.setItem("tmps:config", JSON.stringify({
    provider: "s3", protocol: "snapshot", endpoint: location.origin, prefix: "legacy-prefix",
    bucket: "fixture-bucket", region: "us-east-1", dataset: "shared-mobile-dataset", exclusions: [],
  })));
  await page.reload();
  await page.locator("#launcher").click();
  assert.equal(await page.locator("#protocol").inputValue(), "immutable");
  assert.match(await page.locator("#status").innerText(), /saved S3 Snapshot/i);
  const legacy = await page.evaluate(() => localStorage.getItem("tmps:config"));
  assert.ok(legacy);
  assert.equal(JSON.parse(legacy).protocol, "snapshot",
    "Reading an old configuration must not migrate or save it automatically.");
  assert.equal(await page.locator("#sync").isDisabled(), true);
});
