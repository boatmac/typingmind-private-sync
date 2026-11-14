import { build } from "esbuild";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { argv } from "node:process";

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

await build({
  entryPoints: ["src/extension.ts"],
  outfile: join(directory, filename),
  bundle: true,
  format: "iife",
  target: ["es2022"],
  sourcemap: !pages,
  legalComments: "eof",
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
  });
  console.log("Built dist/koofr-gateway.mjs");
}
