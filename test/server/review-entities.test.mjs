import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-entities-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { parseEntityRef } = await import("../../dist/server/review/workspace-model.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-entities-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  };
  await write(".prism/workflow.md", "## Paths\n- Requirements: docs/requirements/\n- ADRs: docs/ADRs/\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n- Glossary: docs/Glossary.md\n- Mystery: x/\n");
  await write("docs/requirements/reports.md", "# Activity reports\n\nStatus: Approved\nCreated: 2026-09-10\n");
  await write("docs/requirements/README.md", "# Requirements\n");
  await write("docs/ADRs/reporting/signed.md", "# Sign reports\n\nStatus: Accepted\nCreated: 2026-09-11\n");
  await write("docs/plans/reports/download/slice.md", "# Download\n\n## Context\n\nNarrative.\n");
  await write("docs/plans/reports/download/review.json", JSON.stringify({ waves: [{ id: "audit", mode: "design-audit" }], findings: [{ status: "OPEN", severity: "high" }, { status: "VERIFIED", severity: "blocker" }, { status: "FIXED", severity: "low" }] }));
  await write("docs/plans/reports/download/notes/extra.md", "# Extra\n");
  await updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: null, operations: [
    { op: "create", slug: "reports", title: "Export reports", requirements: ["docs/requirements/reports.md#1", "docs/requirements/reports.md#2"] },
    { op: "split", parent: "reports", children: [
      { slug: "download", title: "Download signed reports", outcome: "A signed report downloads.", requirements: ["docs/requirements/reports.md#1"] },
      { slug: "authorize", title: "Authorize access", requirements: ["docs/requirements/reports.md#2"] }
    ] },
    { op: "set_dependencies", slug: "download", dependencies: ["authorize"] },
    { op: "set_status", slug: "download", status: "in-progress" }
  ] });
  await updateInitiative({ projectRoot: root, initiative: "orphan", expectedRevision: null, operations: [{ op: "create", slug: "orphan", title: "Orphan", requirements: ["docs/requirements/reports.md#3"] }] });
  await updateRoadmap({ projectRoot: root, expectedRevision: null, operations: [
    { op: "add_initiative", id: "reports", title: "Export reports", intent: "Signed exports.", band: "Now" },
    { op: "add_initiative", id: "search", title: "Search", intent: "Find activity.", band: "Later", requires: ["reports"] }
  ] });
  await updateCoordinationState({ projectRoot: root, statePath: "docs/plans/reports/state.json", expectedRevision: null, changes: {
    pending: ["Confirm retention window"],
    gateOperations: [{ op: "ask", kind: "visual-review", slice: "download", question: "Review the download design before implementation.", artifacts: ["docs/plans/reports/download/slice.md", "docs/plans/reports/download/missing.md"] }]
  } });
  return root;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, text: body, json: () => JSON.parse(body) });
      });
    }).once("error", reject);
  });
}

function put(url, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "PUT", rejectUnauthorized: false, headers: { "Content-Type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("parses entity references without colliding with artifact paths", () => {
  assert.deepEqual(parseEntityRef("roadmap"), { kind: "roadmap" });
  assert.deepEqual(parseEntityRef("initiative:reports"), { kind: "initiative", id: "reports" });
  assert.deepEqual(parseEntityRef("slice:reports/download"), { kind: "slice", id: "reports", slug: "download" });
  for (const value of ["docs/roadmap.md", "initiative:../x", "slice:reports", "slice:a/b/c", "Roadmap"]) assert.equal(parseEntityRef(value), null, value);
});

test("serves navigation and entity views built from Prism records", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const index = (await get(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.navigation.initiatives.map((item) => [item.id, item.state]), [["reports", "in-progress"], ["search", "envisioned"], ["orphan", "unlisted"]]);
    assert.equal(index.navigation.glossary.exists, false);
    assert.deepEqual(index.navigation.diagnostics.map((item) => item.code), ["path_unknown"]);
    const entity = async (ref) => (await get(`${review.baseUrl}/api/entity?ref=${encodeURIComponent(ref)}`)).json();
    const roadmap = await entity("roadmap");
    const reports = roadmap.data.items.find((item) => item.id === "reports");
    assert.deepEqual(reports.findings, { unresolved: 1, blocking: 1 });
    assert.deepEqual(reports.requiredBy, ["search"]);
    assert.deepEqual(roadmap.data.unlisted, ["orphan"]);
    const initiative = await entity("initiative:reports");
    assert.deepEqual(initiative.data.derived.effectiveDependencies.download, ["authorize"]);
    assert.deepEqual(initiative.data.slices.download.files, ["docs/plans/reports/download/notes/extra.md", "docs/plans/reports/download/review.json", "docs/plans/reports/download/slice.md"]);
    assert.equal(initiative.data.slices.download.review.byStatus.OPEN, 1);
    const slice = await entity("slice:reports/download");
    assert.equal(slice.data.slice.outcome, "A signed report downloads.");
    assert.deepEqual(slice.data.effectiveDependencies, ["authorize"]);
    assert.equal(slice.data.artifacts.narrative, "docs/plans/reports/download/slice.md");
    const authorize = await entity("slice:reports/authorize");
    assert.deepEqual(authorize.data.dependents, ["download"]);
    const requirements = await entity("requirements");
    assert.deepEqual(requirements.data.entries.map((entry) => [entry.path, entry.status]), [["docs/requirements/reports.md", "Approved"]]);
    assert.deepEqual(requirements.data.entries[0].assignedTo.map((use) => `${use.initiative}/${use.slug}#${use.anchor}`).sort(), ["orphan/orphan#3", "reports/authorize#2", "reports/download#1"]);
    const decisions = await entity("decisions");
    assert.deepEqual(decisions.data.entries.map((entry) => [entry.topic, entry.status]), [["reporting", "Accepted"]]);
    const glossary = await entity("glossary");
    assert.deepEqual([glossary.data.path, glossary.data.exists], ["docs/Glossary.md", false]);
    assert.equal((await get(`${review.baseUrl}/api/entity?ref=slice%3Areports%2Fmissing`)).status, 400);
    assert.equal((await get(`${review.baseUrl}/api/entity?ref=docs%2Froadmap.md`)).status, 400);
  } finally {
    await review.close();
  }
});

test("accepts entity tabs that resolve and rejects those that do not", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const accepted = await put(`${review.baseUrl}/api/session`, { openTabs: ["roadmap", "initiative:reports", "slice:reports/download", "docs/requirements/reports.md"], activeTab: "slice:reports/download" });
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(review.getOpenTabs(), ["roadmap", "initiative:reports", "slice:reports/download", "docs/requirements/reports.md"]);
    for (const tab of ["initiative:missing", "slice:reports/missing", "slice:missing/x"]) {
      const rejected = await put(`${review.baseUrl}/api/session`, { openTabs: [tab] });
      assert.equal(rejected.status, 400, tab);
    }
    const views = await Promise.all(["entities", "attention", "roadmap", "initiative", "slice", "library", "palette"].map((name) => get(`${review.baseUrl}/views/${name}.js`)));
    assert.deepEqual(views.map((response) => response.status), [200, 200, 200, 200, 200, 200, 200]);
  } finally {
    await review.close();
  }
});

test("lists what waits on the user apart from agent-side state", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const attention = (await get(`${review.baseUrl}/api/entity?ref=attention`)).json();
    const needs = attention.data.needsYou;
    assert.deepEqual(needs.map((item) => item.type), ["gate", "pending-note", "unlisted", "config"]);
    assert.equal(needs[0].kind, "visual-review");
    assert.deepEqual(needs[0].slice, { slug: "download", title: "Download signed reports" });
    assert.deepEqual(needs[0].initiative, { id: "reports", title: "Export reports" });
    assert.deepEqual(needs[0].artifacts, [{ path: "docs/plans/reports/download/slice.md", available: true }, { path: "docs/plans/reports/download/missing.md", available: false }]);
    assert.deepEqual(attention.data.watch.map((item) => item.type), ["findings"]);
    assert.deepEqual([attention.data.watch[0].unresolved, attention.data.watch[0].blocking], [1, 1]);
    const index = (await get(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.navigation.attention, { needsYou: 4, gates: 1, watch: 1 });
    const refs = index.navigation.index.map((entry) => `${entry.kind}:${entry.ref}`);
    for (const expected of ["initiative:initiative:reports", "initiative:initiative:orphan", "slice:slice:reports/download", "requirement:docs/requirements/reports.md", "decision:docs/ADRs/reporting/signed.md"]) assert.ok(refs.includes(expected), expected);
  } finally {
    await review.close();
  }
});

test("gives every tab a breadcrumb trail and sidebar scope", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const contextOf = async (ref) => (await get(`${review.baseUrl}/api/context?ref=${encodeURIComponent(ref)}`)).json();
    const labels = (value) => value.trail.map((crumb) => crumb.label);
    const sliceFile = await contextOf("docs/plans/reports/download/review.json");
    assert.deepEqual(labels(sliceFile), ["Roadmap", "Export reports", "Download signed reports", "review.json"]);
    assert.equal(sliceFile.scope.kind, "initiative");
    assert.equal(sliceFile.scope.current, "download");
    assert.deepEqual(sliceFile.scope.tree.map((node) => [node.slug, node.depth, node.status]), [["reports", 0, "split"], ["authorize", 1, "not-started"], ["download", 1, "in-progress"]]);
    const state = await contextOf("docs/plans/reports/state.json");
    assert.deepEqual([labels(state), state.scope.current], [["Roadmap", "Export reports", "state.json"], null]);
    const requirement = await contextOf("docs/requirements/reports.md");
    assert.deepEqual(labels(requirement), ["Library", "Requirements", "Activity reports"]);
    assert.deepEqual([requirement.scope.kind, requirement.scope.section, requirement.scope.current], ["library", "requirements", "docs/requirements/reports.md"]);
    assert.deepEqual(labels(await contextOf("decisions")), ["Library", "Decisions"]);
    assert.deepEqual((await contextOf("attention")).scope, { kind: "global" });
    assert.deepEqual(labels(await contextOf("docs/requirements/README.md")), ["Library", "Requirements", "README.md"]);
  } finally {
    await review.close();
  }
});

test("keeps the preview and the human's tabs when an agent presents artifacts", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot, openBrowser: async () => true });
  try {
    const browsed = await put(`${review.baseUrl}/api/session`, { openTabs: ["roadmap", "initiative:reports"], activeTab: "initiative:reports", previewTab: "initiative:reports" });
    assert.equal(browsed.status, 200, browsed.text);
    const presented = await review.open(["docs/requirements/reports.md", "slice:reports/download"]);
    assert.deepEqual(presented.openTabs, ["roadmap", "initiative:reports", "docs/requirements/reports.md", "slice:reports/download"]);
    assert.deepEqual([presented.activeTab, presented.previewTab], ["docs/requirements/reports.md", "initiative:reports"]);
    assert.deepEqual(presented.agentTabs, ["docs/requirements/reports.md", "slice:reports/download"]);
    const promoted = await review.open(["initiative:reports"]);
    assert.deepEqual([promoted.previewTab, promoted.agentTabs.includes("initiative:reports")], [null, true]);
    const landing = await review.open([]);
    assert.deepEqual([landing.activeTab, landing.previewTab, landing.openTabs.at(-1)], ["attention", "attention", "attention"]);
    for (const body of [{ openTabs: ["roadmap"], previewTab: "glossary" }, { openTabs: ["roadmap"], agentTabs: ["glossary"] }]) {
      assert.equal((await put(`${review.baseUrl}/api/session`, body)).status, 400, JSON.stringify(body));
    }
  } finally {
    await review.close();
  }
});
