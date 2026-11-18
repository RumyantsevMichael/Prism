import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, LOG_ADR, LOG_ADR_SOURCE, auditProposal, entryFor, logAdrContent, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";
import { actionOf, apply, authorOf, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// Attention holds each format migration run that waits for the person, failed, or waits for a host,
// and the person answers a run's asked points once, which continues it, or runs a failed run again.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-actions-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const RECOMMENDATION = "Leave it unknown until the team decides.";
const codeOf = (response) => response.json?.code ?? response.json?.error?.code ?? null;

/** The review app of a run project, served in this process with the stub hosts that the project's Prism server sees. */
async function served(context, files, options = {}) {
  const { root, call, hosts } = await runCheckout(context, files, options);
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app, PLUGIN_DATA: privateData });
  context.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  const attention = async () => {
    const data = (await get(base, "api/entity?ref=attention", headers)).json.data;
    return [...data.needsYou, ...data.watch];
  };
  const kindPage = async (kind) => (await get(base, `api/entity?ref=attention:${kind}`, headers)).json.data.filter.items.map((entry) => entry.item);
  return { root, call, hosts, base, headers, attention, kindPage };
}

/** A run of the audit requirement that asked its question: the run id and its asked points. */
async function asking(call, file = AUDIT, proposal = auditProposal) {
  const run = await runFor(call, file);
  const bare = await call("propose_migration", proposal(run));
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  const asked = bare.value.points.map((point) => ({ point, recommendation: RECOMMENDATION }));
  const proposed = await call("propose_migration", proposal(run, { asked }));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  assert.equal((await readRun(call, run)).status, "asking");
  return { run, points: proposed.value.migration.points };
}

const answerAction = async (base, run, headers) => {
  const listed = await listing(base, `migration-run:${run}`, headers);
  assert.equal(listed.status, 200, listed.text);
  return { listed, action: actionOf(listed, "migration-run.answer") };
};
const answer = async (base, run, input, headers) => {
  const { action } = await answerAction(base, run, headers);
  assert.ok(action, "the asking run lists its answer action");
  return apply(base, { action: "migration-run.answer", target: `migration-run:${run}`, input, revision: action.revision, confirmed: true }, headers);
};
const unknownAnswers = (points) => Object.fromEntries(points.map((point) => [point.id, "unknown"]));

test("clauses 1, 3: an asking run is a question on Attention with its asked points, and the format entry gives each artifact its migration state", { skip: posixOnly }, async (context) => {
  const { call, attention, kindPage } = await served(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE });
  const { run, points } = await asking(call);
  const item = (await attention()).find((entry) => entry.type === "migration-question");
  assert.ok(item, "Attention holds the run's question");
  assert.deepEqual([item.run, item.artifactType, item.scope, item.points], [run, "requirements", null, points.length]);
  assert.ok((await kindPage("questions")).some((entry) => entry.type === "migration-question" && entry.run === run), "it is of the questions kind");
  const formats = (await attention()).find((entry) => entry.type === "format-findings" && entry.artifactType === "requirements");
  const artifact = formats?.artifacts?.find((entry) => entry.path === AUDIT);
  assert.deepEqual(artifact?.migration, { run, status: "asking", reason: null });
});

test("clause 2: a failed run is an item of the failed kind with its reason, and a run that waits for a host one of the problems kind", { skip: posixOnly }, async (context) => {
  const failing = await served(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(failing.call, PATHS.requirements);
  assert.equal((await failing.call("fail_migration_run", { run, reason: "The section numbers are ambiguous." })).refused, false);
  const failed = (await failing.kindPage("failed")).find((entry) => entry.type === "migration-failed");
  assert.deepEqual([failed?.run, failed?.artifactType, failed?.scope, failed?.reason], [run, "requirements", null, "The section numbers are ambiguous."]);
});

test("clause 2: a run with no host available is a problem with the waiting reason", { skip: posixOnly }, async (context) => {
  const { call, kindPage } = await served(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  const item = await waitFor(async () => (await kindPage("problems")).find((entry) => entry.type === "migration-waiting") ?? null, { what: "the waiting run on Attention" });
  assert.equal(item.run, run);
  assert.match(item.reason, /^No host is available on this machine: /);
});

test("clauses 11, 12: answering records each point's value with its author and continues the run", { skip: posixOnly }, async (context) => {
  const { root, call, hosts, base, headers } = await served(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, { plans: { claude: [{ hold: 5000 }, { hold: "forever" }] } });
  const { run, points } = await asking(call);
  const { action } = await answerAction(base, run, headers);
  assert.deepEqual(action.fields.map((field) => field.name).sort(), points.map((point) => point.id).sort(), "one field per asked point, named by its id");
  const { listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  await waitFor(async () => {
    const launch = (await listLaunches({ projectRoot: root })).launches.find((entry) => entry.migrationRun === run);
    return launch && launch.state !== "running" ? launch : null;
  }, { what: "the asking run's session to end", ms: 20000 });
  const answered = await answer(base, run, unknownAnswers(points), headers);
  assert.equal(answered.status, 200, answered.text);
  const record = await readRun(call, run);
  assert.deepEqual(Object.keys(record.answers).sort(), points.map((point) => point.id).sort());
  for (const point of points) {
    const entry = record.answers[point.id];
    assert.equal(entry.value, "unknown");
    assert.deepEqual(entry.by, authorOf(root));
    assert.equal(typeof entry.at, "string");
  }
  assert.ok(["continuing", "running"].includes(record.status), record.status);
  await waitFor(() => hosts.runs("claude").length >= 2 || null, { what: "the run's session to continue" });
});

test("clause 13: answering refuses an answered run, a run that is not asking, an invalid value, and a field for no asked point", { skip: posixOnly }, async (context) => {
  const { call, base, headers } = await served(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE, [PATHS.requirements]: UNANCHORED });
  const { run, points } = await asking(call);
  const lined = await answer(base, run, { ...unknownAnswers(points), [points[0].id]: "Two\nlines." }, headers);
  assert.equal(codeOf(lined), "invalid_input", lined.text);
  assert.match(lined.text, new RegExp(points[0].id));
  const stray = await answer(base, run, { ...unknownAnswers(points), p999: "unknown" }, headers);
  assert.equal(codeOf(stray), "invalid_input", stray.text);
  const missing = await answer(base, run, unknownAnswers(points.slice(1)), headers);
  assert.equal(codeOf(missing), "invalid_input", missing.text);
  assert.equal((await readRun(call, run)).answers, null, "a refused answer records nothing");
  assert.equal((await answer(base, run, unknownAnswers(points), headers)).status, 200);
  const again = await apply(base, { action: "migration-run.answer", target: `migration-run:${run}`, input: unknownAnswers(points), revision: "x", confirmed: true }, headers);
  assert.equal(codeOf(again), "already_answered", again.text);
  const running = (await entryFor(call, PATHS.requirements)).migration.run;
  const notAsking = await apply(base, { action: "migration-run.answer", target: `migration-run:${running}`, input: { p1: "unknown" }, revision: "x", confirmed: true }, headers);
  assert.equal(codeOf(notAsking), "run_not_asking", notAsking.text);
});

test("clause 11: an unknown value is refused as an answer for an Accepted ADR", { skip: posixOnly }, async (context) => {
  const { call, base, headers } = await served(context, { ...CONFORMING, [LOG_ADR]: LOG_ADR_SOURCE });
  const proposal = (run, extra = {}) => ({ run, type: "adr", source: LOG_ADR, target: LOG_ADR, content: logAdrContent(), summary: "Adds the format's sections around the decision.", leftovers: [], ...extra });
  const { run, points } = await asking(call, LOG_ADR, proposal);
  const refused = await answer(base, run, unknownAnswers(points), headers);
  assert.equal(codeOf(refused), "invalid_input", refused.text);
  const values = Object.fromEntries(points.map((point) => [point.id, "Every change is traced to its administrator."]));
  assert.equal((await answer(base, run, values, headers)).status, 200);
});

test("clause 14: rerunning a failed run starts a new run of its set, and a run that is not failed or already rerun is refused", { skip: posixOnly }, async (context) => {
  const { call, base, headers, kindPage } = await served(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED, [AUDIT]: AUDIT_SOURCE });
  const { run: asked } = await asking(call);
  const run = (await entryFor(call, PATHS.requirements)).migration.run;
  assert.equal((await call("fail_migration_run", { run, reason: "The section numbers are ambiguous." })).refused, false);
  const listed = await listing(base, `migration-run:${run}`, headers);
  const action = actionOf(listed, "migration-run.rerun");
  assert.ok(action, "a failed run lists its rerun");
  const rerun = await apply(base, { action: "migration-run.rerun", target: `migration-run:${run}`, input: {}, revision: action.revision, confirmed: true }, headers);
  assert.equal(rerun.status, 200, rerun.text);
  const next = await waitFor(async () => {
    const migration = (await entryFor(call, PATHS.requirements)).migration;
    return migration && migration.run !== run ? migration.run : null;
  }, { what: "the new run" });
  assert.equal((await readRun(call, next)).cause, "rerun");
  assert.equal((await kindPage("failed")).some((entry) => entry.type === "migration-failed" && entry.run === run), false, "a failed run that a later run follows leaves Attention");
  for (const target of [run, asked]) {
    const refused = await apply(base, { action: "migration-run.rerun", target: `migration-run:${target}`, input: {}, revision: "x", confirmed: true }, headers);
    assert.equal(codeOf(refused), "run_not_failed", refused.text);
  }
});

test("clause 15: the answer takes only the run's id and the point fields, and no answer text reaches the host's command line", { skip: posixOnly }, async (context) => {
  const { root, call, hosts, base, headers } = await served(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, { plans: { claude: [{ hold: 5000 }, { hold: "forever" }] } });
  const { run, points } = await asking(call);
  const { listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  await waitFor(async () => {
    const launch = (await listLaunches({ projectRoot: root })).launches.find((entry) => entry.migrationRun === run);
    return launch && launch.state !== "running" ? launch : null;
  }, { what: "the asking run's session to end", ms: 20000 });
  const smuggled = await answer(base, run, { ...unknownAnswers(points), prompt: "$(touch /tmp/prism-owned)" }, headers);
  assert.equal(codeOf(smuggled), "invalid_input", "a field that names no point is refused");
  assert.equal((await answer(base, run, unknownAnswers(points), headers)).status, 200);
  const second = await waitFor(() => hosts.runs("claude")[1] ?? null, { what: "the continued session" });
  assert.equal(JSON.stringify(second.argv).includes("unknown"), false);
  await waitFor(() => hosts.inputs(second.pid).length || null, { what: "the continued prompt" });
  assert.deepEqual(hosts.inputs(second.pid), [{ type: "user", message: { role: "user", content: `/prism:migrate-artifact ${run}` } }], "the prompt names the run alone");
});
