import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

// A format migration run's session works outside the checkout, so its scoped Prism server serves the run's checkout sources,
// the project's paths, and the sources' Git history, takes its project from the launch, and reads no other checkout file.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const SECRET = "TOKEN=do-not-move-me\n";
const RUN_TOOLS = ["fail_migration_run", "finish_migration_run", "get_artifact", "get_migration_run", "propose_migration"];

/** A Prism server started in an empty folder outside the checkout, as a run's session starts it, scoped to the run and its project: its call. */
async function scopedServer(context, root, run) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-folder-")));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const env = isolatedEnv({
    PRISM_REVIEW_APP: "off",
    PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)),
    CLAUDE_PROJECT_DIR: folder,
    PRISM_MIGRATION_RUN: run,
    PRISM_MIGRATION_PROJECT: root
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url))], { cwd: folder, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const answers = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) answers.set(message.id, message);
  });
  let next = 1;
  const request = async (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitFor(() => answers.get(id) ?? null, { what: method });
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "run-access-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (name, args) => {
    const message = await request("tools/call", { name, arguments: args });
    const value = message.result?.structuredContent ?? (message.error ? { code: message.error.data?.code, ...message.error.data } : null);
    return { value, refused: Boolean(message.error || message.result?.isError), text: JSON.stringify(message) };
  };
  return { folder, call, list: async () => (await request("tools/list", {})).result.tools.map((tool) => tool.name).sort() };
}

async function waitingRun(context) {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, { hosts: [] });
  await writeFile(path.join(root, ".env"), SECRET);
  return { root, run: await runFor(call, PATHS.requirements) };
}

test("clauses 17, 18: the run's server takes its project from the launch, reads the run's checkout source without a store, and refuses every other checkout file", { skip: posixOnly }, async (context) => {
  const { root, run } = await waitingRun(context);
  const scoped = await scopedServer(context, root, run);
  assert.deepEqual(await scoped.list(), RUN_TOOLS);
  const read = await scoped.call("get_migration_run", { run });
  assert.equal(read.refused, false, read.text);
  assert.equal(read.value.run.id, run, "a call without projectRoot is served for the launch's project");
  const source = await scoped.call("get_artifact", { path: PATHS.requirements });
  assert.equal(source.refused, false, source.text);
  assert.equal(source.value.content, UNANCHORED, "the checkout source is read in a project without a store");
  assert.equal(source.value.scope, null);
  assert.match(source.value.version ?? "", /^sha256:/);
  for (const file of [".env", ".git/config", "package.json"]) {
    const refused = await scoped.call("get_artifact", { path: file });
    assert.equal(refused.value?.code, "migration_scope", `${file}: ${refused.text}`);
    assert.equal(refused.text.includes("do-not-move-me"), false);
  }
  const elsewhere = await scoped.call("get_migration_run", { run, projectRoot: scoped.folder });
  assert.equal(elsewhere.value?.code, "migration_scope", elsewhere.text);
});

test("clause 19: get_migration_run gives the project's paths, whether a store is configured, and each source's Git history", { skip: posixOnly }, async (context) => {
  const { root, run } = await waitingRun(context);
  const scoped = await scopedServer(context, root, run);
  const { value } = await scoped.call("get_migration_run", { run });
  const { settings, set } = value.run;
  assert.deepEqual(Object.keys(settings.paths).sort(), ["adrs", "features", "glossary", "requirements"]);
  assert.match(settings.paths.requirements, /^docs\/requirements\/?$/);
  assert.equal(settings.store, false);
  const [artifact] = set.artifacts;
  assert.equal(artifact.path, PATHS.requirements);
  assert.ok(Array.isArray(artifact.history) && artifact.history.length >= 1 && artifact.history.length <= 100, JSON.stringify(artifact.history));
  for (const commit of artifact.history) {
    assert.deepEqual(Object.keys(commit).sort(), ["date", "subject"]);
    assert.ok(Number.isFinite(Date.parse(commit.date)), commit.date);
  }
});
