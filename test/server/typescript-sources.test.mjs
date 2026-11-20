import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every source under src is TypeScript that the native build type-checks and compiles into dist, and tests run that compiled output.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function files(directory, skip) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) found.push(...await files(full, skip));
    } else {
      found.push(full);
    }
  }
  return found;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

// A stub stands in for an npm package that the native runtime installs as it is, so it never passes through the build.
test("no hand-written JavaScript is left under src, apart from installed packages and their stubs", async () => {
  const javascript = (await files(path.join(ROOT, "src"), new Set(["node_modules", "stubs"]))).filter((file) => /\.[cm]?js$/.test(file));
  assert.deepEqual(javascript.map(relative), []);
});

test("no test or script imports a module from src instead of its compiled output in dist", async () => {
  const skip = new Set(["node_modules", "fixtures"]);
  const callers = [...await files(path.join(ROOT, "test"), skip), ...await files(path.join(ROOT, "scripts"), skip)].filter((file) => /\.[cm]?[jt]s$/.test(file));
  const importsFromSource = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`](?:\.\.?\/)+src\//;
  const offenders = [];
  for (const file of callers) {
    const text = await readFile(file, "utf8");
    if (importsFromSource.test(text)) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, []);
});
