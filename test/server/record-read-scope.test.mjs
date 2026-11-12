import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Counts reads of each project's workflow config, which the store's resolution reads once per resolution.
const configReads = new Map();
const readFile = fs.promises.readFile;
fs.promises.readFile = function (target, ...rest) {
  const name = String(target);
  if (name.endsWith(path.join(".prism", "workflow.md"))) configReads.set(name, (configReads.get(name) ?? 0) + 1);
  return readFile.call(this, target, ...rest);
};
syncBuiltinESMExports();
const { forgetMigrations, readRecord, withRecordReads, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-read-scope-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n");
  forgetMigrations();
  return root;
}

const reads = (root) => configReads.get(path.join(root, ".prism", "workflow.md")) ?? 0;
const keys = ["one", "two", "three", "four", "five"].map((initiative) => ({ kind: "initiative", initiative }));

test("a burst of record reads resolves the project's store once, and reads after it resolve it again", async (context) => {
  const root = await project(context);
  for (const key of keys) await writeRecord(root, key, `{"title":"${key.initiative}"}\n`);
  const before = reads(root);
  const texts = await withRecordReads(() => Promise.all(keys.map(async (key) => (await readRecord(root, key)).bytes.toString("utf8"))));
  assert.deepEqual(texts, keys.map((key) => `{"title":"${key.initiative}"}\n`));
  assert.equal(reads(root) - before, 1, "five reads in one burst read the workflow config once");
  const after = reads(root);
  for (const key of keys) await readRecord(root, key);
  assert.equal(reads(root) - after, keys.length, "reads outside a burst resolve the store each time");
});

test("a write inside a burst checks its folders again, so a symlink placed after the burst's reads cannot redirect it", { skip: process.platform === "win32" ? "creating a symlink needs a privilege Windows runners do not grant" : false }, async (context) => {
  const root = await project(context);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-read-scope-outside-")));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const key = { kind: "initiative", initiative: "moved" };
  await writeRecord(root, key, "{}\n");
  await assert.rejects(withRecordReads(async () => {
    await readRecord(root, key);
    const folder = path.join(root, ".prism", "initiatives", "moved");
    await rm(folder, { recursive: true });
    await symlink(outside, folder);
    await writeRecord(root, key, "{\"redirected\":true}\n");
  }), { code: "invalid_path" });
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was written outside the project");
});
