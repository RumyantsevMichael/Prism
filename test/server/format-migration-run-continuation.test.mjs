import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditProposal, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// The person's answer moves a format migration run out of asking in the same write that records it,
// so a continuation that cannot start never leaves an answered run asking, listed as a question, or tells the page that the answer was lost.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-continuation-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const RECOMMENDATION = "Leave it unknown until the team decides.";

async function served(context, options = {}) {
  const { root, call, hosts } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, options);
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app, PLUGIN_DATA: privateData });
  context.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  const questions = async () => (await get(base, "api/entity?ref=attention:questions", headers)).json.data.filter.items.map((entry) => entry.item);
  return { root, call, hosts, base, headers, questions };
}

async function asking(call) {
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run));
  const asked = bare.value.points.map((point) => ({ point, recommendation: RECOMMENDATION }));
  const proposed = await call("propose_migration", auditProposal(run, { asked }));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  assert.equal((await readRun(call, run)).status, "asking");
  return { run, points: proposed.value.migration.points };
}

const unknownAnswers = (points) => Object.fromEntries(points.map((point) => [point.id, "unknown"]));

test("an answer whose continuation cannot start leaves no run asking and no question, and the answer still succeeds", { skip: posixOnly }, async (context) => {
  const { root, call, hosts, base, headers, questions } = await served(context, { plans: { claude: [{ hold: 2000 }, { hold: "forever" }] } });
  const { run, points } = await asking(call);
  const { listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  await waitFor(async () => {
    const launch = (await listLaunches({ projectRoot: root })).launches.find((entry) => entry.migrationRun === run);
    return launch && launch.state !== "running" ? launch : null;
  }, { what: "the asking run's session to end", ms: 20000 });
  const listed = await listing(base, `migration-run:${run}`, headers);
  const action = actionOf(listed, "migration-run.answer");
  assert.ok(action, listed.text);
  // The stub host leaves PATH, so neither resuming the session nor launching a new one can start the continuation.
  process.env.PATH = process.env.PATH.split(path.delimiter).filter((folder) => folder !== hosts.bin).join(path.delimiter);
  const answered = await apply(base, { action: "migration-run.answer", target: `migration-run:${run}`, input: unknownAnswers(points), revision: action.revision, confirmed: true }, headers);
  assert.equal(answered.status, 200, answered.text);
  const record = await readRun(call, run);
  assert.notEqual(record.status, "asking", "the answered run no longer asks");
  assert.deepEqual(Object.keys(record.answers).sort(), points.map((point) => point.id).sort(), "the answers stay recorded");
  assert.equal((await questions()).some((entry) => entry.type === "migration-question" && entry.run === run), false, "the answered run is no question on Attention");
});

test("an answer recorded by a process that ends before continuing leaves the run continuing, not asking", { skip: posixOnly }, async (context) => {
  const { root, call, questions } = await served(context);
  const { run, points } = await asking(call);
  const { answerMigrationRun } = await import("../../dist/server/workflow/migration-runs.mjs");
  await answerMigrationRun(root, run, Object.fromEntries(points.map((point) => [point.id, { choice: "value", value: "unknown", by: { name: "Ada", email: null, checkout: "here" }, at: new Date().toISOString() }])));
  const record = await readRun(call, run);
  assert.equal(record.status, "continuing");
  assert.equal((await questions()).some((entry) => entry.type === "migration-question" && entry.run === run), false);
});
