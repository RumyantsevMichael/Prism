import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-initiative-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { analyzeInitiative, parseLegacyMap } = await import("../../dist/server/workflow/initiative-graph.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const example = await readFile(new URL("./fixtures/legacy-map.puml", import.meta.url), "utf8");
test.after(() => rm(privateData, { recursive: true, force: true }));

const leaf = (parent, status = "not-started", dependencies = []) => ({ title: "Meaningful capability", status, parent, requirements: ["req.md#R1"], dependencies });

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-initiative-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans (scratch): work/plans/\n");
  return root;
}

test("analyzes the documented example without duplicating derived state", () => {
  const map = parseLegacyMap(example);
  assert.equal(map.id, "reports");
  const analysis = analyzeInitiative(map.slices);
  assert.equal(analysis.root, "reports");
  assert.equal(analysis.slices.download.title, "Download signed reports");
  assert.equal(analysis.slices.download.parent, "reports");
  assert.deepEqual(analysis.effectiveDependencies.download, ["auth"]);
  assert.deepEqual(analysis.designCandidates, ["download"]);
  assert.equal(analysis.complete.reports, false);
  assert.equal(analysis.complete.auth, true);
  assert.equal(analysis.dependenciesComplete.includes("download"), true);
  assert.deepEqual(analysis.counts, { "not-started": 1, "in-progress": 0, blocked: 0, deferred: 0, done: 1 });
  assert.equal(analyzeInitiative(parseLegacyMap(example.replace("<<not-started>>", "<<done>>")).slices).complete.reports, true);
});

test("keeps distinct slugs including object property names", () => {
  const slugs = ["a-b", "a_b", "a_b_2", "__proto__", "constructor"];
  const source = JSON.parse(`{"root":${JSON.stringify(leaf(null, "split"))},${slugs.map((slug) => `${JSON.stringify(slug)}:${JSON.stringify(leaf("root"))}`).join(",")}}`);
  const analysis = analyzeInitiative(source);
  assert.equal(Object.keys(analysis.slices).length, 6);
  for (const slug of slugs) assert.equal(analysis.slices[slug].parent, "root");
});

test("expands inherited dependencies and parent completion while allowing early design", () => {
  const analysis = analyzeInitiative({
    root: leaf(null, "split"),
    group: leaf("root", "split", ["prerequisite"]),
    child: leaf("group"),
    prerequisite: leaf("root", "split"),
    first: leaf("prerequisite", "done"),
    second: leaf("prerequisite", "blocked")
  });
  assert.deepEqual(analysis.effectiveDependencies.child, ["first", "second"]);
  assert.deepEqual(analysis.designCandidates, ["child"]);
  assert.equal(analysis.dependenciesComplete.includes("child"), false);
  assert.equal(analysis.complete.prerequisite, false);
});

test("rejects legacy syntax and graph defects with the established messages", () => {
  const bad = [
    [example.replace("hide empty description", "!include secret"), /Unsupported|Missing/],
    [example.replace('state "Download signed reports"', 'state ""'), /Invalid slice title/],
    [example.replace("s_646f776e6c6f6164", "s_0"), /Invalid slice alias/],
    [example.replace("<<split>>", "<<done>>"), /Split status/],
    [example.replace('s_646f776e6c6f6164 : requires "docs/requirements/reports.md#1"', ""), /Missing requirement|Incomplete child coverage/],
    [example.replace("reports.md#2", "reports.md#3"), /Incomplete child coverage/],
    [example.replace("@enduml", "s_61757468 --> s_646f776e6c6f6164 : depends on\n@enduml"), /cycle/],
    [example.replace("@enduml", "s_646f776e6c6f6164 --> s_7265706f727473 : depends on\n@enduml"), /self-dependency/],
    [example.replace("@enduml", "s_646f776e6c6f6164 --> s_78 : depends on\n@enduml"), /Unknown dependency/],
    [example.replace("@enduml", 'state "Other root" as s_78 <<done>>\n@enduml'), /one root/]
  ];
  for (const [source, error] of bad) {
    assert.notEqual(source, example, "invalid-map mutation must change the fixture");
    assert.throws(() => analyzeInitiative(parseLegacyMap(source).slices), error);
  }
  assert.throws(() => analyzeInitiative({ a: leaf("b"), b: leaf("a") }), /one root|Parent cycle/);
});

test("creates, splits, and updates an initiative through revision-checked operations", async (context) => {
  const projectRoot = await project(context);
  const absent = await getInitiative({ projectRoot, initiative: "reports" });
  assert.equal(absent.exists, false);
  assert.equal(absent.recordPath, ".prism/initiatives/reports/initiative.json");
  const created = await updateInitiative({ projectRoot, initiative: "reports", expectedRevision: null, actor: "orchestrator", operations: [
    { op: "create", slug: "reports", title: "Export activity reports", outcome: "Users export their activity.", requirements: ["docs/requirements/reports.md#1", "docs/requirements/reports.md#2"] }
  ] });
  assert.equal(created.created, true);
  assert.equal(created.derived.root, "reports");
  assert.deepEqual(created.derived.designCandidates, ["reports"]);
  const split = await updateInitiative({ projectRoot, initiative: "reports", expectedRevision: created.revision, operations: [
    { op: "split", parent: "reports", children: [
      { slug: "download", title: "Download signed reports", outcome: "A signed file downloads.", requirements: ["docs/requirements/reports.md#1"] },
      { slug: "auth", title: "Authorize report access", requirements: ["docs/requirements/reports.md#2"] }
    ] },
    { op: "set_dependencies", slug: "download", dependencies: ["auth"] },
    { op: "set_status", slug: "auth", status: "in-progress" }
  ] });
  assert.equal(split.record.slices.reports.status, "split");
  assert.deepEqual(split.derived.effectiveDependencies.download, ["auth"]);
  assert.deepEqual(split.record.history.map((entry) => entry.operation), ["create", "split", "set_dependencies", "set_status"]);
  const projection = await readFile(path.join(projectRoot, "work/plans/reports/initiative.md"), "utf8");
  assert.match(projection, /generated view of initiative.json/);
  assert.match(projection, /  - \*\*Download signed reports\*\* \(`download`\): not-started/);
  await assert.rejects(updateInitiative({ projectRoot, initiative: "reports", expectedRevision: created.revision, operations: [{ op: "update_slice", slug: "auth", title: "x" }] }), { code: "revision_conflict" });
  await assert.rejects(updateInitiative({ projectRoot, initiative: "reports", expectedRevision: split.revision, operations: [
    { op: "split", parent: "download", children: [{ slug: "half", title: "Half", requirements: ["docs/requirements/reports.md#9"] }] }
  ] }), /Incomplete child coverage/);
  await assert.rejects(updateInitiative({ projectRoot, initiative: "reports", expectedRevision: split.revision, operations: [
    { op: "split", parent: "download", children: [{ slug: "auth", title: "Duplicate", requirements: ["docs/requirements/reports.md#1"] }] }
  ] }), /already used/);
  await assert.rejects(updateInitiative({ projectRoot, initiative: "reports", expectedRevision: split.revision, operations: [{ op: "set_status", slug: "reports", status: "done" }] }), /split status permanently/);
  const unchanged = await getInitiative({ projectRoot, initiative: "reports" });
  assert.equal(unchanged.revision, split.revision);
});

test("refuses a done transition without a passing completion gate", async (context) => {
  const projectRoot = await project(context);
  const created = await updateInitiative({ projectRoot, initiative: "solo", expectedRevision: null, operations: [{ op: "create", slug: "solo", title: "Solo", requirements: ["r.md#1"] }] });
  await assert.rejects(
    updateInitiative({ projectRoot, initiative: "solo", expectedRevision: created.revision, operations: [{ op: "set_status", slug: "solo", status: "done" }] }),
    (error) => error.code === "gate_blocked" && error.problems.length > 0 && error.slice === "solo"
  );
  const split = await updateInitiative({ projectRoot, initiative: "solo", expectedRevision: created.revision, operations: [{ op: "split", parent: "solo", children: [{ slug: "child", title: "Child", requirements: ["r.md#1"] }] }] });
  await assert.rejects(
    updateInitiative({ projectRoot, initiative: "solo", expectedRevision: split.revision, operations: [{ op: "set_status", slug: "child", status: "done" }] }),
    (error) => error.code === "gate_blocked" && error.slice === "child"
  );
});

test("imports a legacy map with outcomes from slice records and keeps hand-written projections", async (context) => {
  const projectRoot = await project(context);
  await mkdir(path.join(projectRoot, "work/plans/reports/download"), { recursive: true });
  await writeFile(path.join(projectRoot, "work/plans/reports/map.puml"), example);
  await writeFile(path.join(projectRoot, "work/plans/reports/download/slice.md"), "# Download signed reports\n\n## Outcome\n\nA signed report downloads.\n\n## Requirements\n\n- x\n");
  await writeFile(path.join(projectRoot, "work/plans/reports/initiative.md"), "# Notes written by a person\n");
  const imported = await updateInitiative({ projectRoot, initiative: "reports", expectedRevision: null, operations: [{ op: "import_map", path: "work/plans/reports/map.puml" }] });
  assert.equal(imported.record.slices.download.outcome, "A signed report downloads.");
  assert.equal(imported.record.slices.auth.status, "done");
  assert.equal(imported.projectionStale, true);
  assert.equal(await readFile(path.join(projectRoot, "work/plans/reports/initiative.md"), "utf8"), "# Notes written by a person\n");
  await assert.rejects(updateInitiative({ projectRoot, initiative: "other", expectedRevision: null, operations: [{ op: "import_map", path: "work/plans/reports/map.puml" }] }), /names initiative reports/);
});

test("rejects identifiers that could leave the plans directory", async (context) => {
  const projectRoot = await project(context);
  await assert.rejects(getInitiative({ projectRoot, initiative: "../outside" }), { code: "invalid_path" });
});

test("stores requirement citations as configured requirement paths", async (context) => {
  const projectRoot = await project(context);
  const created = await updateInitiative({ projectRoot, initiative: "cited", expectedRevision: null, operations: [
    { op: "create", slug: "cited", title: "Cited", requirements: ["token-bucket.md§1", "token-bucket.md§2"] },
    { op: "split", parent: "cited", children: [{ slug: "one", title: "One", requirements: ["token-bucket.md§1"] }, { slug: "two", title: "Two", requirements: ["docs/requirements/token-bucket.md#2"] }] }
  ] });
  assert.deepEqual(created.record.slices.cited.requirements, ["docs/requirements/token-bucket.md#1", "docs/requirements/token-bucket.md#2"]);
  assert.deepEqual(created.record.slices.one.requirements, ["docs/requirements/token-bucket.md#1"]);
  await assert.rejects(
    updateInitiative({ projectRoot, initiative: "other", expectedRevision: null, operations: [{ op: "create", slug: "other", title: "Other", requirements: ["token-bucket.md 1"] }] }),
    /Invalid requirement reference "token-bucket\.md 1": use <requirements path>\.md#<number>, such as docs\/requirements\/capability\.md#1, or <file>\.md§<number>\./
  );
});
