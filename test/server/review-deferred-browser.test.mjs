import { defer } from "./fixtures/teardown.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-loop-decisions.md §3, §4.
// The review browser shows deferred findings apart from fixed and verified ones, and the review loop gate's summary on Attention.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-deferred-browser-data-")));
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");

const INITIATIVE = "reports";
const coordinator = { id: "orchestrator", role: "coordinator" };
const delivery = { id: "Develop download", role: "delivery" };
const reviewerOf = (wave) => ({ id: `Review ${wave}`, role: "reviewer" });
const lanes = (wave) => [{ id: "correctness", reviewer: `Review ${wave}`, coverage: ["."] }];
const findingId = (local) => `implementation-review/correctness/${local}`;
const LOWS = [{ localId: "L1", title: "Help text has a typo", severity: "low" }, { localId: "L2", title: "Log line names the wrong report", severity: "low" }];

// A project whose root slice reached the review wave limit with two low findings, so Prism recorded its review loop gate.
async function atLimit(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-deferred-browser-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }, { op: "accept_design", slug: INITIATIVE, frozenTests: ["test/acceptance.test.mjs"], review: "required" }] });
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE };
  const asked = await verifySlice(slice);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow" });
  assert.equal((await verifySlice({ ...slice, approvalGate: asked.gateId })).status, "passed");
  const review = async (actor, operations, extra = {}) => updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor, operations, ...extra });
  await review(coordinator, [{ op: "start_wave", id: "w1", mode: "implementation-review", lanes: lanes("w1") }], { delivery: delivery.id });
  await review(reviewerOf("w1"), [{ op: "open_finding", lane: "correctness", localId: "H1", title: "Signature is not checked", severity: "high", affectedPath: "source.mjs", evidence: "No check.", conditionToClose: "Checked." }, { op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
  await review(delivery, [{ op: "set_finding_status", id: findingId("H1"), status: "FIXED", evidence: "Added the check." }]);
  await review(coordinator, [{ op: "start_wave", id: "w2", mode: "implementation-review", lanes: lanes("w2") }]);
  await review(reviewerOf("w2"), [{ op: "set_finding_status", id: findingId("H1"), status: "VERIFIED", evidence: "Checked." }, ...LOWS.map((finding) => ({ op: "open_finding", lane: "correctness", affectedPath: "source.mjs", evidence: "Seen.", conditionToClose: "Fixed.", ...finding })), { op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
  let gate = null;
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3") }]), (error) => {
    gate = error.problems?.[0]?.gate ?? null;
    return error.code === "gate_blocked";
  });
  assert.ok(gate, "Prism names the review loop gate it recorded");
  return { root, slice, review, gate };
}

// The same project after the user chose to accept the low findings and the coordinator deferred them.
async function deferred(context) {
  const project = await atLimit(context);
  await answerUserGate({ projectRoot: project.root, initiative: INITIATIVE, id: project.gate, choice: "accept-deferred" });
  await project.review(coordinator, [{ op: "accept_wave", gate: project.gate, deferrals: [{ finding: findingId("L1"), followUp: "#101" }, { finding: findingId("L2"), followUp: "#102" }] }]);
  return project;
}

test("clause 28: Attention shows the review loop gate's summary with the findings by wave as a table", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { root, gate } = await atLimit(context);
  assert.ok((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.some((item) => item.id === gate));
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"));
  await waitForView(page);
  const view = page.locator("#artifact");
  await view.getByText("How should the review of slice reports continue after 2 review waves?").first().waitFor({ timeout: 10000 });
  const table = view.locator("table").filter({ hasText: "Raised" });
  assert.equal(await table.count(), 1, "the findings by wave render as one table");
  const rows = await table.locator("tbody tr").allInnerTexts();
  assert.deepEqual(rows.map((row) => row.split(/\s+/).filter(Boolean)), [["w1", "1", "0"], ["w2", "2", "1"]]);
  assert.match(await view.innerText(), /Unresolved findings:\s*0 blocker, 0 high, 0 medium, 2 low\./);
  assert.match(await view.innerText(), /Accept with deferred low findings/);
  assert.deepEqual(page.errors, []);
});

test("clauses 26, 29: the findings board shows deferred findings in their own column with their gate and follow-up", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { root, gate } = await deferred(context);
  const { base } = await serveProject(context, root);
  const index = await (await fetch(`${base}/api/index`)).json();
  const ledger = index.artifacts.find((item) => /review\.json$/.test(item));
  assert.ok(ledger, "the review record is listed");
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, ledger));
  await waitForView(page);
  const view = page.locator("#artifact");
  const heads = await view.locator(".board-column-head").allInnerTexts();
  const columns = heads.map((text) => text.replace(/\s*\d+\s*$/, "").trim());
  assert.deepEqual(columns.slice(-2), ["VERIFIED", "DEFERRED"], "the DEFERRED column follows VERIFIED");
  const deferredColumn = view.locator(".board-column").filter({ has: page.locator(".board-column-head", { hasText: "DEFERRED" }) });
  for (const finding of LOWS) assert.equal(await deferredColumn.getByText(finding.title).count(), 1, finding.title);
  assert.equal(await view.locator('prism-stat[label="unresolved findings"]').getAttribute("value"), "0", "deferred findings are not unresolved");
  const deferredStat = view.locator('prism-stat[label*="deferred"]');
  assert.equal(await deferredStat.count(), 1, "a deferred count appears");
  assert.equal(await deferredStat.getAttribute("value"), "2");
  await deferredColumn.getByText(LOWS[0].title).click();
  const detail = view.locator("[data-detail]");
  await detail.getByText("#101").waitFor({ timeout: 5000 });
  assert.match(await detail.innerText(), new RegExp(gate));
  const { checkKitUsage } = await import(pathToFileURL(path.join(ROOT, "scripts/review-kit/kit-guard.mjs")).href);
  const findings = await checkKitUsage({ root: ROOT, files: ["src/server/review/public/views/review-ledger.js", "src/server/review/public/views/slice.js", "src/server/review/public/styles/record-views.css", "src/server/review/public/styles/workflow-views.css"] });
  assert.deepEqual(findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule} ${finding.value}`), []);
  assert.deepEqual(page.errors, []);
});

test("clause 27: the slice page counts deferred findings apart and lists each with its gate and follow-up", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { root, gate } = await deferred(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, `slice:${INITIATIVE}/${INITIATIVE}`));
  await waitForView(page);
  const card = page.locator("#artifact prism-panel").filter({ has: page.locator('prism-stat[label="unresolved"]') });
  assert.equal(await card.count(), 1, "the slice page has its review card");
  assert.equal(await card.locator('prism-stat[label="unresolved"]').getAttribute("value"), "0");
  const deferredStat = card.locator('prism-stat[label*="deferred"]');
  assert.equal(await deferredStat.count(), 1);
  assert.equal(await deferredStat.getAttribute("value"), "2");
  const text = await card.innerText();
  for (const [finding, followUp] of [[LOWS[0], "#101"], [LOWS[1], "#102"]]) {
    assert.ok(text.includes(finding.title), finding.title);
    assert.ok(text.includes(followUp), followUp);
  }
  assert.ok(text.includes(gate), "each deferred finding names its decision gate");
  assert.match(text, /low/);
  assert.deepEqual(page.errors, []);
});
