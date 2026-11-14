import { build } from "esbuild";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv } from "node:process";
import { URL } from "node:url";

const pages = argv.includes("--pages");
const directory = pages ? "pages-dist" : "dist";
const filename = "typingmind-private-sync.js";

if (pages) {
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Pages output must be a regular directory, not a symbolic link.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name !== filename || !entry.isFile())) {
    throw new Error("Pages output contains unexpected files or links. Inspect pages-dist before retrying.");
  }
}

const notices = await readFile(new URL("../THIRD_PARTY_NOTICES", import.meta.url), "utf8");
const footer = { js: `/*! ${notices.trim()}\n*/` };

await build({
  entryPoints: ["src/extension.ts"],
  outfile: join(directory, filename),
  bundle: true,
  format: "iife",
  target: ["es2022"],
  sourcemap: !pages,
  legalComments: "eof",
  footer,
});
console.log(`Built ${join(directory, filename)}`);

if (!pages) {
  await build({
    entryPoints: ["src/gateway.ts"],
    outfile: "dist/koofr-gateway.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node24"],
    sourcemap: true,
    footer,
  });
  console.log("Built dist/koofr-gateway.mjs");
}
