import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDecision, normalizeDecision, readDecisionHistory, setDecisionRecording } from "../../dist/server/workflow/decision-history.mjs";
import { updateCoordinationState } from "../../dist/server/workflow/state.mjs";
import { createHash } from "node:crypto";

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-decisions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { projectRoot: directory, dataDirectory: directory };
}

test("keeps decision recording disabled until a project opts in", async (context) => {
  const options = await fixture(context);
  const result = await appendDecision({ ...options, decision: { kind: "context_plan", outcome: "SUCCESS" } });
  assert.equal(result.status, "disabled");
  const history = await readDecisionHistory(options);
  assert.equal(history.enabled, false);
  assert.deepEqual(history.records, []);
  assert.ok(history.coverageGaps.includes("recording_disabled"));
  await assert.rejects(readdir(path.join(options.dataDirectory, "decision-history")), { code: "ENOENT" });
});

test("records a content-free CodeGraph null estimate and explicit coverage gaps", async (context) => {
  const options = await fixture(context);
  await setDecisionRecording({ ...options, enabled: true });
  const appended = await appendDecision({ ...options, correlationKey: "a".repeat(64), decision: {
    kind: "context_plan", outcome: "SUCCESS", requestedProvider: "codegraph", selectedProvider: "codegraph",
    reasonCodes: ["semantic_search_unavailable"],
    counts: { must: 4, likely: 20, possible: 0, verifiedTokens: 9000 },
    estimate: { lower: null, expected: null, upper: null },
    evidencePaths: ["docs/plans/native-seatbelt/design.md"], agentLabel: "design-worker"
  } });
  assert.equal(appended.status, "recorded");
  assert.equal(appended.actor.status, "unverified");
  const history = await readDecisionHistory(options);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].counts.verifiedTokens, 9000);
  assert.equal(history.records[0].estimate.expected, null);
  assert.ok(history.coverageGaps.includes("unverified_execution"));
  assert.ok(history.coverageGaps.includes("subagent_attribution_unverified"));
  const files = await readdir(path.join(options.dataDirectory, "decision-history"));
  const stored = await readFile(path.join(options.dataDirectory, "decision-history", files.find((name) => name.endsWith(".events.json"))), "utf8");
  assert.doesNotMatch(stored, /prompt|source text|secret token/);
});

test("rejects content and requires an unreadable diagram split assessment", () => {
  assert.throws(() => normalizeDecision({ kind: "design_fit", outcome: "FIT", prompt: "secret token" }), /not allowed/);
  assert.throws(() => normalizeDecision({ kind: "design_fit", outcome: "FIT", readability: "unreadable" }), /split assessment/);
  assert.deepEqual(normalizeDecision({ kind: "design_fit", outcome: "SPLIT", readability: "unreadable", splitAssessment: "split", counts: { elements: 50, links: 84, notes: 17 } }).counts,
    { elements: 50, links: 84, notes: 17 });
});

test("drops expired decision records from history", async (context) => {
  const options = await fixture(context);
  await setDecisionRecording({ ...options, enabled: true });
  await appendDecision({ ...options, decision: { kind: "review", outcome: "CLEAN", reviewPhase: "design_audit" } });
  const directory = path.join(options.dataDirectory, "decision-history");
  const file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".events.json")));
  const value = JSON.parse(await readFile(file, "utf8"));
  value.records[0].occurredAt = "2020-01-01T00:00:00.000Z";
  await writeFile(file, JSON.stringify(value));
  assert.deepEqual((await readDecisionHistory(options)).records, []);
  await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
  await appendDecision({ ...options, decision: { kind: "review", outcome: "FINDINGS", reviewPhase: "design_audit" } });
  assert.equal((await readDecisionHistory(options)).records.length, 1);
});

test("labels inactive parent recovery as historical and detects active recovery gaps", async (context) => {
  const options = await fixture(context);
  const statePath = "docs/plans/example/state.json";
  const parentPath = "docs/plans/example/parent/recovery.md";
  const childPath = "docs/plans/example/child/recovery.md";
  await updateCoordinationState({ projectRoot: options.projectRoot, statePath, expectedRevision: null, changes: {
    activeOperations: [{ slice: "child", activity: "design", workers: ["worker"], workspace: "/work" }].map(entry => ({ op: "start", entry })),
    evidence: ["parent/recovery.md", "child/recovery.md"]
  } });
  await setDecisionRecording({ ...options, enabled: true });
  let history = await readDecisionHistory({ ...options, statePath });
  assert.deepEqual(history.recovery.map((item) => item.status), ["historical", "missing"]);
  await mkdir(path.join(options.projectRoot, path.dirname(childPath)), { recursive: true });
  await writeFile(path.join(options.projectRoot, childPath), "Current note.\n");
  const recoveryDigest = createHash("sha256").update("Current note.\n").digest("hex");
  await appendDecision({ ...options, decision: { kind: "pause", outcome: "PAUSED", evidencePaths: [childPath], recoveryDigest } });
  history = await readDecisionHistory({ ...options, statePath });
  assert.equal(history.recovery[1].status, "current");
  await writeFile(path.join(options.projectRoot, childPath), "Changed note.\n");
  history = await readDecisionHistory({ ...options, statePath });
  assert.equal(history.recovery[1].status, "stale");
});

test("keeps the reconstructed Lumen probe after the earlier fit decision", async (context) => {
  const options = await fixture(context);
  await setDecisionRecording({ ...options, enabled: true });
  const earlier = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const later = new Date().toISOString();
  await appendDecision({ ...options, source: "audit_reconstruction", occurredAt: earlier, decision: {
    kind: "design_fit", outcome: "FIT", readability: "not_assessed", counts: { elements: 50, links: 84, notes: 17 }
  } });
  await appendDecision({ ...options, source: "audit_reconstruction", occurredAt: later, decision: {
    kind: "context_plan", outcome: "SUCCESS", requestedProvider: "codegraph", selectedProvider: "codegraph",
    reasonCodes: ["semantic_search_unavailable"], counts: { must: 4, likely: 20, possible: 0 },
    estimate: { lower: null, expected: null, upper: null }
  } });
  const history = await readDecisionHistory(options);
  assert.deepEqual(history.records.map((item) => item.kind), ["design_fit", "context_plan"]);
  assert.ok(history.coverageGaps.includes("legacy_fit_readability_unobserved"));
  assert.equal(history.records[1].estimate.expected, null);
});
