import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

test("Pages build publishes only the extension without gateway, source maps or local files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tmps-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "src", "extension.ts"), "console.log('test extension');");
  await writeFile(join(directory, "dist", "koofr-gateway.mjs"), "private gateway fixture");
  await writeFile(join(directory, ".env.fixture.local"), "private credential fixture");
  await execute(process.execPath, [script, "--pages"], { cwd: directory });
  const output = join(directory, "pages-dist");
  assert.deepEqual(await readdir(output), ["typingmind-private-sync.js"]);
  const bundle = await readFile(join(output, "typingmind-private-sync.js"), "utf8");
  assert.doesNotMatch(bundle, /sourceMappingURL|private gateway fixture|private credential fixture/);
});

test("Pages build refuses unexpected existing output instead of publishing or deleting it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tmps-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "pages-dist");
  await mkdir(output);
  await writeFile(join(output, ".env.local"), "private output fixture");
  await writeFile(join(output, "typingmind-private-sync.js"), "previous build");
  await assert.rejects(execute(process.execPath, [script, "--pages"], { cwd: directory }), /unexpected files or links/);
  assert.equal(await readFile(join(output, ".env.local"), "utf8"), "private output fixture");
  assert.equal(await readFile(join(output, "typingmind-private-sync.js"), "utf8"), "previous build");
});

test("Pages build refuses a linked output directory without touching its target", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tmps-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "private");
  await mkdir(target);
  await writeFile(join(target, "typingmind-private-sync.js"), "private linked fixture");
  await symlink(target, join(directory, "pages-dist"), "junction");
  await assert.rejects(execute(process.execPath, [script, "--pages"], { cwd: directory }), /regular directory/);
  assert.equal(await readFile(join(target, "typingmind-private-sync.js"), "utf8"), "private linked fixture");
});
