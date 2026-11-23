import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { entryFor, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";

// A format migration run launches on the host and model that this computer chose for Prism's own runs, still read-only,
// and on the first available host with its default model when the chosen host is not found.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const BROKEN = { ...CONFORMING, [PATHS.requirements]: REQUIREMENT.replace('<a id="2"></a>\n', "") };

// Stores the computer's choice for Prism's own runs in the stub hosts' review app folder, as Settings does.
async function choose(hosts, choice) {
  const { writePrismRunsChoice } = await import("../../dist/server/session/prism-runs.mjs");
  await writePrismRunsChoice({ choice: { provider: null, model: null, effort: null, typed: false, ...choice }, by: "test", revision: "none", env: { ...process.env, PRISM_REVIEW_APP_DIR: hosts.app } });
}

const running = (call, run) => waitFor(async () => {
  const record = await readRun(call, run);
  return record.status === "running" ? record : null;
}, { what: `the run ${run} to run` });

test("a run launches Codex with the model chosen for Prism's runs, though Claude Code comes first, and its thread stays read-only", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude", "codex"] });
  await choose(hosts, { host: "codex", model: "gpt-5.5", effort: "low" });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await running(call, run)).launch.host, "codex");
  const [started] = await waitFor(() => hosts.runs("codex").length ? hosts.runs("codex") : null, { what: "the Codex stub to start" });
  assert.equal(hosts.runs("claude").length, 0);
  const thread = await waitFor(() => hosts.inputs(started.pid).find((message) => message.method === "thread/start") ?? null, { what: "the Codex thread" });
  assert.equal(thread.params.model, "gpt-5.5");
  assert.equal(thread.params.permissions, "prism-read-only");
  assert.equal(thread.params.approvalPolicy, "never");
  const turn = await waitFor(() => hosts.inputs(started.pid).find((message) => message.method === "turn/start") ?? null, { what: "the Codex turn" });
  assert.equal(turn.params.effort, "low");
  assert.equal("sandboxPolicy" in turn.params, false);
  assert.deepEqual(turn.params.input, [{ type: "text", text: `$prism:migrate-artifact ${run}` }]);
});

test("a run launches Claude Code with --model of the choice and no built-in tool", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude", "codex"] });
  await choose(hosts, { host: "claude-code", model: "opus" });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await running(call, run)).launch.host, "claude-code");
  const [started] = await waitFor(() => hosts.runs("claude").length ? hosts.runs("claude") : null, { what: "the Claude Code stub to start" });
  assert.deepEqual(started.argv.slice(started.argv.indexOf("--model"), started.argv.indexOf("--model") + 2), ["--model", "opus"]);
  assert.equal(started.argv[started.argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(started.argv[started.argv.indexOf("--tools") + 1], "");
});

test("a chosen host that is not found leaves the run on the first available host with its default model, and the run says why", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude"] });
  await choose(hosts, { host: "codex", model: "gpt-5.5" });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await running(call, run)).launch.host, "claude-code");
  const [started] = await waitFor(() => hosts.runs("claude").length ? hosts.runs("claude") : null, { what: "the Claude Code stub to start" });
  assert.equal(started.argv.includes("--model"), false, "the host uses its own default model");
  const entry = await entryFor(call, PATHS.requirements);
  assert.equal(entry.migration.status, "running");
  assert.match(entry.migration.reason, /^Codex, chosen for Prism's own runs, was not found: .+\. Claude Code runs it with its default model\.$/);
});

test("a choice that cannot be read leaves the run on the first available host, and the run says why", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude"] });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(hosts.app, { recursive: true });
  await writeFile((await import("node:path")).join(hosts.app, "prism-runs.json"), "{ not json", { mode: 0o600 });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await running(call, run)).launch.host, "claude-code");
  assert.equal((await entryFor(call, PATHS.requirements)).migration.reason, "The choice for Prism's own runs could not be read, so the first available host runs it with its default model.");
});

test("a run on the chosen host records no reason", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude"] });
  await choose(hosts, { host: "claude-code" });
  const run = await runFor(call, PATHS.requirements);
  await running(call, run);
  assert.equal((await entryFor(call, PATHS.requirements)).migration.reason, null);
});
