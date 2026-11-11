import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Retention of structure-only indexes once their complete index is saved, and the component entry of a structure-only search that fails.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-retention-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const HELD = "packages/net/timeout.ts";
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("a complete index removes the structure-only index it replaced, so earlier complete indexes keep their slots", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const { runtime } = await stagedRuntime(storage);
  const directory = (await runtime.location(root)).directory;
  const completed = [];
  for (let build = 0; build < 6; build++) {
    if (build) await write(HELD, `${FILES[HELD]}// change ${build}\n`);
    const found = await until(async () => { const value = await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 2000 }); return value.status === "ready" && value; }, "The build did not finish.");
    assert.ok(found);
    const current = await readJson(path.join(directory, "current.json"));
    assert.equal(current.stage, "complete");
    completed.push(current.revision);
  }
  const entries = await readdir(directory);
  const revisions = entries.filter((name) => /^[a-f\d]{64}\.json$/.test(name)).map((name) => name.slice(0, 64)).sort();
  assert.deepEqual(revisions, completed.slice(-4).sort(), "the four most recent complete indexes, the current one among them, are kept");
  assert.deepEqual(entries.filter((name) => name.startsWith("units-")).map((name) => name.slice(6, 70)).sort(), revisions);
  for (const name of entries.filter((name) => name.startsWith("generation-"))) assert.equal((await readJson(path.join(directory, name))).stage, "complete");
});
