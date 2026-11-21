import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Git and the run logs use a private home and plugin data, so a recorded log path starts with ~; Windows reads the home folder from USERPROFILE.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-verification-panel-data-")));
await writeFile(path.join(privateData, "gitconfig"), "");
Object.assign(process.env, {
  PLUGIN_DATA: privateData, HOME: privateData, USERPROFILE: privateData, GIT_CONFIG_GLOBAL: path.join(privateData, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { appendRecord, forgetMigrations, listRecordEntries } = await import("../../dist/server/workflow/record-store.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
const { failingTestLinks, frozenTestFile, LOG_SHOWN_BYTES, verificationLog } = await import("../../dist/server/review/verification-view.mjs");
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const RUNS = { kind: "runs", initiative: INITIATIVE, slice: "download" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const DOWNLOAD_TEST = `import test from "node:test";

test("downloads a signed report", () => {});

test("refuses an unsigned report", () => {});
`;
const SHARED_TEST = `import test from "node:test";

test("refuses an unsigned report", () => {});

fn spreads_attempts() {}
`;
const AUDIT_TEST = "test(\"records each download\", () => {});\n";

// The test command fails and prints failing names in the forms verification reads.
const CHECK = `console.log("✖ downloads a signed report (1ms)");
console.log("✖ refuses an unsigned report (1ms)");
console.log("✖ retry::jitter::spreads_attempts (1ms)");
console.log("✖ a test no file names (1ms)");
console.log("FAILED test/download.test.mjs::Suite::downloads a signed report");
process.exit(1);
`;

async function project(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-verification-panel-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  forgetMigrations();
  const root = path.join(parent, "project");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), CHECK);
  await writeFile(path.join(root, "test", "download.test.mjs"), DOWNLOAD_TEST);
  await writeFile(path.join(root, "test", "shared.test.mjs"), SHARED_TEST);
  await writeFile(path.join(root, "test", "audit.test.mjs"), AUDIT_TEST);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [
    { op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] },
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }], evidence: await splitEvidence(root, `docs/plans/${INITIATIVE}`, "download") }
  ] });
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  // The audit slice is accepted before it starts, so its frozen test is staged out of the work tree.
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [
    { op: "set_status", slug: "download", status: "in-progress" },
    { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs", "test/shared.test.mjs"], review: "none" },
    { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
  ] });
  return root;
}

async function failedRun(root) {
  let result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  if (result.status === "approval_needed") {
    await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: result.gateId, choice: "allow" });
    result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: result.gateId });
  }
  assert.equal(result.status, "failed");
  return (await listRecordEntries(root, RUNS)).at(-1);
}

test("a run records where its full log is, and the panel reads that log on this machine and the kept output elsewhere", async (context) => {
  const root = await project(context);
  const run = await failedRun(root);
  assert.match(run.entry.log, /^~\/verification-logs\/[0-9a-f]{16}\/reports\/download\/verification-[\w-]+\.log$/, "the record names the log from the home folder");
  const local = path.join(privateData, run.entry.log.slice(2));
  const shown = await verificationLog(root, INITIATIVE, "download", run.id);
  assert.equal(shown.source, "log");
  assert.equal(shown.content, await readFile(local, "utf8"));
  assert.equal(shown.cut, false);
  assert.equal(shown.host, os.hostname().split(".")[0]);
  // Without the file, as on another machine, the panel shows the output the record keeps and names where the log is.
  await rm(local);
  const elsewhere = await verificationLog(root, INITIATIVE, "download", run.id);
  assert.equal(elsewhere.source, "record");
  assert.equal(elsewhere.content, run.entry.outputTail);
  assert.equal(elsewhere.complete, true, "an output shorter than the kept tail is the whole output");
  assert.equal(elsewhere.log, run.entry.log);
  assert.equal(await verificationLog(root, INITIATIVE, "download", "verification-unknown"), null);
});

test("a large log shows its end from a whole line, and a kept tail at its limit is marked partial", async (context) => {
  const root = await project(context);
  const run = await failedRun(root);
  const local = path.join(privateData, run.entry.log.slice(2));
  await writeFile(local, `${"x".repeat(LOG_SHOWN_BYTES)}\nlast line\n`);
  const shown = await verificationLog(root, INITIATIVE, "download", run.id);
  assert.equal(shown.cut, true);
  assert.equal(shown.content, "last line\n");
  const id = "verification-999999999999999-aaaaaa";
  await appendRecord(root, RUNS, id, { ...run.entry, log: null, outputTail: "y".repeat(4000) });
  const tail = await verificationLog(root, INITIATIVE, "download", id);
  assert.deepEqual([tail.source, tail.complete, tail.log], ["record", false, null]);
});

test("a recorded log path that does not name the run's own log is never read", async (context) => {
  const root = await project(context);
  const run = await failedRun(root);
  const secret = path.join(privateData, "secret.txt");
  await writeFile(secret, "private\n");
  const elsewhere = path.join(privateData, "verification-logs", "0123456789abcdef", INITIATIVE, "download");
  await mkdir(elsewhere, { recursive: true });
  const cases = [secret, "~/secret.txt", path.join(elsewhere, "verification-000000000000001-other.log"), "verification-logs/0123456789abcdef/reports/download/x.log", ["not", "text"]];
  for (const [index, log] of cases.entries()) {
    const id = `verification-99999999999999${index}-bbbbbb`;
    await writeFile(path.join(elsewhere, "verification-000000000000001-other.log"), "other run\n");
    await appendRecord(root, RUNS, id, { ...run.entry, log, outputTail: "kept" });
    const shown = await verificationLog(root, INITIATIVE, "download", id);
    assert.equal(shown.source, "record", JSON.stringify(log));
    assert.equal(shown.content, "kept");
  }
});

test("a failing name links to the one frozen test that names it, and to nothing when none or several do", async (context) => {
  const root = await project(context);
  const links = await failingTestLinks(root, INITIATIVE, "download", ["downloads a signed report", "refuses an unsigned report", "retry::jitter::spreads_attempts", "a test no file names", "test/download.test.mjs::Suite::refuses an unsigned report", 7]);
  assert.deepEqual(links, [
    { name: "downloads a signed report", path: "test/download.test.mjs", line: 3 },
    { name: "refuses an unsigned report" },
    { name: "retry::jitter::spreads_attempts", path: "test/shared.test.mjs", line: 5 },
    { name: "a test no file names" },
    { name: "test/download.test.mjs::Suite::refuses an unsigned report", path: "test/download.test.mjs", line: 5 }
  ]);
  // A test of another slice is not one of this slice's frozen tests.
  assert.deepEqual(await failingTestLinks(root, INITIATIVE, "download", ["records each download"]), [{ name: "records each download" }]);
});

test("a frozen test reads from the work tree, the staged copy, or the changed file, and only a frozen path reads", async (context) => {
  const root = await project(context);
  const frozen = await frozenTestFile(root, INITIATIVE, "download", "test/download.test.mjs");
  assert.deepEqual([frozen.kind, frozen.state, frozen.content, frozen.note], ["source", "frozen", DOWNLOAD_TEST, undefined]);
  const staged = await frozenTestFile(root, INITIATIVE, "audit", "test/audit.test.mjs");
  assert.equal(staged.state, "staged");
  assert.equal(staged.content, AUDIT_TEST);
  assert.match(staged.note, /has not started/);
  await writeFile(path.join(root, "test", "download.test.mjs"), "changed\n");
  const changed = await frozenTestFile(root, INITIATIVE, "download", "test/download.test.mjs");
  assert.deepEqual([changed.state, changed.content], ["changed", "changed\n"]);
  assert.match(changed.note, /changed after the design was accepted/);
  for (const other of ["check.mjs", "test/audit.test.mjs", "../outside", ".prism/workflow.md"]) assert.equal(await frozenTestFile(root, INITIATIVE, "download", other).catch(() => null), null, other);
});

test("the review server serves a slice's frozen test and run log, and refuses any other path or run", async (context) => {
  const root = await project(context);
  const run = await failedRun(root);
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(() => review.close());
  const base = review.baseUrl.replace(/\/$/, "");
  const query = (route, params) => fetch(`${base}/api/${route}?${new URLSearchParams({ initiative: INITIATIVE, slice: "download", ...params })}`);
  const file = await query("frozen-test", { path: "test/download.test.mjs" });
  assert.equal(file.status, 200);
  assert.equal((await file.json()).content, DOWNLOAD_TEST);
  const refused = await query("frozen-test", { path: "check.mjs" });
  assert.equal(refused.status, 404);
  assert.match(await refused.text(), /freezes no test at that path/);
  const log = await query("verification-log", { id: run.id });
  assert.equal(log.status, 200);
  assert.match((await log.json()).content, /downloads a signed report/);
  assert.equal((await query("verification-log", { id: "verification-unknown" })).status, 404);
  const slice = await fetch(`${base}/api/frozen-test?initiative=${INITIATIVE}&slice=none&path=test/download.test.mjs`);
  assert.equal(slice.status, 404);
  assert.match(await slice.text(), /no slice of that initiative/);
});
