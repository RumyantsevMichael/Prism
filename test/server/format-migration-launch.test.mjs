import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditProposal, listedTools, readRun, runCheckout, runFor, serve, stubHosts, waitFor } from "./fixtures/format-migration-runs.mjs";
import { pause } from "./fixtures/wait.mjs";

// Prism launches each format migration run on this machine at once, on the first available host with a small model when no host and model are chosen,
// with the migrate-artifact prompt alone, and fails a run whose session ends before it finishes.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const BROKEN = { ...CONFORMING, [PATHS.requirements]: UNANCHORED };
const claudePrompt = (run) => ({ type: "user", message: { role: "user", content: `/prism:migrate-artifact ${run}` } });
// Whether a folder is the checkout, lies inside it, or holds it.
const touches = (folder, root) => {
  const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
  return inside(path.resolve(folder), root) || inside(root, path.resolve(folder));
};
const optionValues = (argv, name) => argv.flatMap((arg, index) => arg === name ? [argv[index + 1]] : []);
const statusOf = async (call, run, statuses) => waitFor(async () => {
  const record = await readRun(call, run);
  return statuses.includes(record.status) ? record : null;
}, { what: `the run ${run} to reach ${statuses.join(" or ")}` });
const launches = async (hosts, root) => {
  const { listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  return (await listLaunches({ projectRoot: root, env: { ...process.env, ...hosts.env, PRISM_REVIEW_APP_DIR: hosts.app } })).launches ?? [];
};

test("clauses 1, 2, 3, 4, 16: a new run launches Claude Code at once in an empty folder of its own outside the checkout, with the migrate-artifact prompt alone, the haiku model, and no read of the checkout, and records its launch", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN, { hosts: ["claude", "codex"] });
  const run = await runFor(call, PATHS.requirements);
  const record = await statusOf(call, run, ["running"]);
  assert.equal(record.launch.host, "claude-code", "Claude Code comes first when both hosts are available");
  assert.match(record.launch.id, /^launch-[0-9a-f]{16}$/);
  const [started] = await waitFor(() => hosts.runs("claude").length ? hosts.runs("claude") : null, { what: "the Claude Code stub to start" });
  assert.equal(hosts.runs("codex").some((entry) => hosts.inputs(entry.pid).some((message) => message.method === "thread/start")), false, "Codex, which lists no gpt-6-luna, opens no thread");
  assert.notEqual(started.cwd, root);
  assert.equal(touches(started.cwd, root), false, "the session works outside the checkout");
  assert.deepEqual(await readdir(started.cwd), [], "the working folder starts empty");
  assert.equal(optionValues(started.argv, "--tools").join(",").includes("Bash"), false, "no shell tool");
  assert.equal(optionValues(started.argv, "--allowedTools").join(",").includes("Bash"), false, "no shell call is allowed");
  const added = started.argv.flatMap((arg, index) => arg === "--add-dir" ? started.argv.slice(index + 1).filter((value, at, rest) => !rest.slice(0, at + 1).some((item) => item.startsWith("--"))) : []);
  assert.equal(added.some((folder) => touches(folder, root)), false, `no added folder reaches the checkout: ${added.join(", ")}`);
  assert.deepEqual(optionValues(started.argv, "--model"), ["haiku"], "a run with no chosen model uses Claude Code's small model");
  assert.equal(started.argv.some((arg) => arg.includes(run) || arg.includes("migrate-artifact")), false, "nothing of the run reaches the command line");
  await waitFor(() => hosts.inputs(started.pid).length ? true : null, { what: "the prompt" });
  assert.deepEqual(hosts.inputs(started.pid), [claudePrompt(run)]);
  const listed = (await launches(hosts, root)).find((launch) => launch.id === record.launch.id);
  assert.ok(listed, "the run is a launched session of the checkout");
  assert.equal(listed.initiative, null);
  assert.equal(listed.migrationRun, run);
  await call("check_artifacts", {});
  assert.equal(hosts.runs("claude").length, 1, "no second session starts while the run runs");
});

test("clauses 2, 3, 16: with only Codex available the run starts a Codex turn outside the checkout whose input is the migrate-artifact prompt, with Codex's default model when it lists no small one, and whose permission profile reads nothing of the checkout", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN, { hosts: ["codex"] });
  const run = await runFor(call, PATHS.requirements);
  const record = await statusOf(call, run, ["running"]);
  assert.equal(record.launch.host, "codex");
  // A read of Codex's model list may run first in an app server of its own, so the run's own app server is the one that opens a thread.
  const started = await waitFor(() => hosts.runs("codex").find((entry) => hosts.inputs(entry.pid).some((message) => message.method === "turn/start")) ?? null, { what: "the Codex turn" });
  const turn = hosts.inputs(started.pid).find((message) => message.method === "turn/start");
  assert.deepEqual(turn.params.input, [{ type: "text", text: `$prism:migrate-artifact ${run}` }]);
  const thread = hosts.inputs(started.pid).find((message) => message.method === "thread/start");
  assert.ok(thread && typeof thread.params.cwd === "string", JSON.stringify(thread));
  assert.equal(touches(thread.params.cwd, root), false, "the thread works outside the checkout");
  const readable = Object.keys(thread.params.config?.permissions?.[thread.params.permissions]?.filesystem ?? {}).filter((key) => !key.startsWith(":"));
  assert.ok(readable.length >= 1, JSON.stringify(thread.params.config?.permissions));
  assert.equal(readable.some((folder) => touches(folder, root)), false, `no readable root reaches the checkout: ${readable.join(", ")}`);
  assert.equal("model" in thread.params, false, "the stub lists no model, so Codex uses its own default model");
  assert.equal("effort" in turn.params, false);
});

test("clause 5: with no host available the run waits for one, and a check on the machine once a host is there launches it", { skip: posixOnly }, async (context) => {
  const { root, call } = await runCheckout(context, BROKEN, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  const waiting = await statusOf(call, run, ["waiting-for-host"]);
  const entry = (await call("check_artifacts", {})).value.artifacts.find((artifact) => artifact.path === PATHS.requirements);
  assert.equal(entry.migration.status, "waiting-for-host");
  assert.match(entry.migration.reason, /^No host is available on this machine: /);
  assert.equal(waiting.launch ?? null, null, "no session started");
  const hosts = await stubHosts(context);
  const later = await serve(context, root, hosts);
  await later("check_artifacts", {});
  await waitFor(() => hosts.runs("claude").length ? true : null, { what: "the run to launch once a host is available" });
  assert.equal((await statusOf(later, run, ["running"])).launch.host, "claude-code");
});

test("clause 6: a session that ends while the run is still running fails the run and applies nothing", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, BROKEN, { plans: { claude: [{ hold: 200 }] } });
  const run = await runFor(call, PATHS.requirements);
  const failed = await statusOf(call, run, ["failed"]);
  assert.match(failed.failure.reason, /^The run's session ended before the run finished: /);
  assert.equal(failed.result, null);
});

test("clause 6: a session that ends after the run asked its question leaves the run asking", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, { plans: { claude: [{ hold: 6000 }] } });
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run));
  const asked = bare.value.points.map((point) => ({ point, recommendation: "Leave it unknown until the team decides." }));
  assert.equal((await call("propose_migration", auditProposal(run, { asked }))).refused, false);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  // The stub's turn ends six seconds after it started, which ends the session once the run asks.
  await pause(8000, "the check is that the ended session starts no other one and leaves the run asking, which no event marks");
  assert.equal(hosts.runs("claude").length, 1);
  assert.equal((await readRun(call, run)).status, "asking", "the person's answer is still awaited");
});

test("clauses 7, 9: continueMigrationRun resumes the run's session with the same prompt, and no agent tool continues or launches a run", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, { plans: { claude: [{ hold: 4000 }, { hold: "forever" }] } });
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run));
  const asked = bare.value.points.map((point) => ({ point, recommendation: "Leave it unknown until the team decides." }));
  assert.equal((await call("propose_migration", auditProposal(run, { asked }))).refused, false);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  assert.equal(hosts.runs("claude").length, 1, "proposing and finishing start no session");
  const [first] = hosts.runs("claude");
  await waitFor(async () => {
    const listed = (await launches(hosts, root)).find((launch) => launch.migrationRun === run);
    return listed && listed.state !== "running" ? listed : null;
  }, { what: "the first session to end", ms: 20000 });
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app });
  context.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  const { continueMigrationRun } = await import("../../dist/server/workflow/migration-runs.mjs");
  await continueMigrationRun(root, run);
  const second = await waitFor(() => hosts.runs("claude")[1] ?? null, { what: "the resumed session" });
  assert.ok(second.argv.includes("--resume"), JSON.stringify(second.argv));
  assert.ok(second.argv.includes(first.argv[3]), "the run's own host session resumes");
  await waitFor(() => hosts.inputs(second.pid).length ? true : null, { what: "the resumed prompt" });
  assert.deepEqual(hosts.inputs(second.pid), [claudePrompt(run)]);
  assert.ok(["continuing", "running"].includes((await readRun(call, run)).status));
  const tools = Object.keys(await listedTools(context, root));
  assert.deepEqual(tools.filter((name) => /launch|continue|rerun|resume/i.test(name)), [], "no agent tool starts, continues, or reruns a session");
});

test("clause 8: rerunMigration records a new run of the failed set's still nonconforming artifacts with the cause rerun, and launches it", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN);
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await call("fail_migration_run", { run, reason: "The section numbers are ambiguous." })).refused, false);
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app });
  context.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  const { rerunMigration } = await import("../../dist/server/workflow/migration-runs.mjs");
  const rerun = await rerunMigration(root, run, { name: "Ada", email: "ada@example.invalid" });
  const id = rerun?.run?.id ?? rerun?.id ?? rerun?.run;
  assert.match(id, /^run-[0-9a-f]{16}$/);
  assert.notEqual(id, run);
  const record = await readRun(call, id);
  assert.equal(record.cause, "rerun");
  assert.deepEqual(record.set.artifacts.map((artifact) => artifact.path), [PATHS.requirements]);
  await statusOf(call, id, ["running"]);
  assert.equal((await readRun(call, run)).status, "failed", "the failed run stays as it was");
});
