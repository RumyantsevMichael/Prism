import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Requirement: docs/requirements/review-finding-provenance.md §1.
// Feature: docs/Features/F-finding-provenance.feature.
// The ledger already keeps the raising wave as each finding's first history entry, so this test verifies existing behavior.
// Review operations go through the MCP tool dispatch; only the empty plan and its comparison are prepared directly.

import { conservationStore as store } from "../../dist/server/conservation/conservation-store.mjs";
import { updateChangeMap } from "../../dist/server/conservation/change-map.mjs";
import { compareChangeMap, ANALYSIS_VERSION } from "../../dist/server/conservation/conservation-analysis.mjs";
import { callConservationTool } from "../../dist/server/conservation/conservation-tools.mjs";
import { CHUNKER_VERSION } from "../../dist/native-runtime/versions.mjs";

const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-finding-provenance-")));
store.directory = path.join(home, "evidence");
test.after(() => rm(home, { recursive: true, force: true }));

const degraded = { prepare: async () => ({ status: "degraded", diagnostics: [{ code: "unsupported_runtime", message: "Test without inference" }] }) };
const KEY = { initiative: "plan", slice: "slice" };
const coordinator = { id: "coord", role: "coordinator" }, reviewer = { id: "r1", role: "reviewer" }, delivery = { id: "dev", role: "delivery" };

// An empty plan over an empty project gives every wave the same retained inputs, so a later wave can carry an earlier lane.
async function emptySlice() {
  const root = await mkdtemp(path.join(home, "project-"));
  const baseline = await store.capture(root, KEY);
  const analysis = { kind: "analysis", schemaVersion: 1, project: root, snapshotId: baseline.snapshotId, units: [], fileCoverage: {}, diagnostics: [], tokenCounts: {}, structureCounts: {},
    versions: { extractor: CHUNKER_VERSION, metrics: ANALYSIS_VERSION, tokenizer: "fixture" } };
  await store.link(root, baseline.snapshotId, await store.put(root, analysis));
  const plan = await updateChangeMap({ projectRoot: root, ...KEY, expectedRevision: null, scope: ["src"], baselineId: baseline.snapshotId, operations: [] });
  const comparison = await compareChangeMap({ projectRoot: root, ...KEY, expectedRevision: plan.revision, baselineId: baseline.snapshotId, resultSnapshotId: baseline.snapshotId }, { runtime: degraded });
  let revision = null;
  const act = async (actor, operations) => {
    const result = await callConservationTool("update_review", { projectRoot: root, ...KEY, delivery: delivery.id, expectedRevision: revision, actor, operations });
    revision = result.revision;
    return result;
  };
  const startWave = (id) => ({ op: "start_wave", id, mode: "design-audit", deltaRevision: plan.revision, snapshotId: baseline.snapshotId, comparisonId: comparison.comparisonId, lanes: [{ id: "main", reviewer: reviewer.id, coverage: ["src"] }] });
  const findings = async () => Object.fromEntries((await callConservationTool("get_review", { projectRoot: root, ...KEY, section: "findings" })).entries.map((finding) => [finding.localId, finding]));
  return { act, startWave, findings };
}

const raise = (localId) => ({ op: "open_finding", lane: "main", localId, title: `Finding ${localId}`, severity: "high", affectedPath: "src", evidence: "Observed gap", conditionToClose: "Close the gap" });
const status = (localId, value) => ({ op: "set_finding_status", id: `design-audit/main/${localId}`, status: value, evidence: `${value} evidence` });

test("a finding keeps the wave that raised it through later status changes, reopening, and carried lanes", async () => {
  const slice = await emptySlice();
  const raisingWaves = async () => Object.fromEntries(Object.entries(await slice.findings()).map(([localId, finding]) => [localId, finding.history[0]]));
  const expectRaised = async (expected) => {
    const first = await raisingWaves();
    assert.deepEqual(Object.fromEntries(Object.entries(first).map(([localId, entry]) => [localId, [entry.wave, entry.status]])), expected);
  };

  await slice.act(coordinator, [slice.startWave("wave-a")]);
  await slice.act(reviewer, [raise("F-1")]);
  await expectRaised({ "F-1": ["wave-a", "OPEN"] });
  const raisedEntry = (await raisingWaves())["F-1"];

  await slice.act(coordinator, [slice.startWave("wave-b")]);
  await slice.act(delivery, [status("F-1", "IN PROGRESS"), status("F-1", "FIXED")]);
  await slice.act(reviewer, [status("F-1", "VERIFIED"), raise("F-2")]);
  await expectRaised({ "F-1": ["wave-a", "OPEN"], "F-2": ["wave-b", "OPEN"] });

  await slice.act(coordinator, [slice.startWave("wave-c")]);
  await slice.act(reviewer, [status("F-1", "REOPENED")]);
  await slice.act(delivery, [status("F-1", "FIXED"), status("F-2", "IN PROGRESS"), status("F-2", "FIXED")]);
  await slice.act(reviewer, [status("F-1", "VERIFIED"), status("F-2", "VERIFIED"), { op: "submit_lane", lane: "main", status: "CLEAN" }]);
  await slice.act(coordinator, [{ op: "accept_wave" }]);
  await expectRaised({ "F-1": ["wave-a", "OPEN"], "F-2": ["wave-b", "OPEN"] });

  const beforeCarry = await slice.findings();
  await slice.act(coordinator, [slice.startWave("wave-d"), { op: "carry_lane", lane: "main", fromWave: "wave-c" }]);
  await slice.act(reviewer, [{ op: "carry_assessments", lane: "main", fromWave: "wave-c" }]);
  await slice.act(coordinator, [{ op: "accept_wave" }]);
  // Carrying a lane or its assessments into a later wave leaves every finding record, including its raising wave, unchanged.
  assert.deepEqual(await slice.findings(), beforeCarry);

  const final = await slice.findings();
  assert.deepEqual(final["F-1"].history[0], raisedEntry);
  assert.deepEqual(final["F-1"].history.map((entry) => [entry.wave, entry.status]), [
    ["wave-a", "OPEN"], ["wave-b", "IN PROGRESS"], ["wave-b", "FIXED"], ["wave-b", "VERIFIED"], ["wave-c", "REOPENED"], ["wave-c", "FIXED"], ["wave-c", "VERIFIED"]
  ]);
  assert.equal(final["F-1"].status, "VERIFIED");
});
