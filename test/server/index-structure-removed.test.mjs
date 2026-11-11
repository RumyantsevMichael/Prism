import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { fork } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// A complete save removes the structure-only index it replaces, also while another session that loaded that structure still answers from it.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-structure-removed-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const message = (child, value) => new Promise((resolve) => child.on("message", (got) => got === value && resolve()));

test("a search in another session after the complete save removed the structure it loaded answers from the stored complete index", async (t) => {
  const { root, storage } = await project(t);
  const child = fork(new URL("./fixtures/structure-removed-child.mjs", import.meta.url), [root, storage], { env: process.env });
  t.after(() => child.kill());
  await message(child, "held");
  const later = await stagedRuntime(storage);
  const directory = (await later.runtime.location(root, NET)).directory;
  const structureRevision = (await readJson(path.join(directory, "current.json"))).revision;
  const early = await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: later.runtime, waitMs: 300 });
  assert.equal(early.components.find((item) => item.component === "root/net").status, "included");
  await until(async () => [...later.runtime.jobs.values()].some((job) => job.retry), "the later session never waited for the lock");
  const done = message(child, "done");
  child.send("release");
  await done;
  await access(path.join(directory, `${structureRevision}.json`)).then(() => assert.fail("structure still present"), () => {});
  const after = await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: later.runtime, waitMs: 0 });
  const net = after.components.find((item) => item.component === "root/net");
  const complete = await readJson(path.join(directory, "current.json"));
  assert.equal(complete.stage, "complete");
  assert.deepEqual([net.status, net.indexRevision, net.embeddings], ["included", complete.revision, undefined], JSON.stringify(net));
  assert.equal(after.diagnostics.some((item) => item.code === "embeddings_pending"), false, JSON.stringify(after.diagnostics));
});
