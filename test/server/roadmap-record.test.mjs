import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-roadmap-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getRoadmap, updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function project(context, paths = "- Roadmap: product/roadmap.md\n- Plans (scratch): docs/plans/\n") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-roadmap-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n${paths}`);
  return root;
}

const add = (id, band, extra = {}) => ({ op: "add_initiative", id, title: `Title ${id}`, intent: `Intent ${id}.`, band, ...extra });

test("records initiative decisions and orders them within bands", async (context) => {
  const projectRoot = await project(context);
  const created = await updateRoadmap({ projectRoot, expectedRevision: null, actor: "roadmap", operations: [
    { op: "set_serves", serves: "Reliable planning." },
    add("alpha", "Now"), add("beta", "Now"), add("gamma", "Next", { requires: ["alpha"], rationale: "Builds on alpha." }),
    add("delta", "Parked", { rationale: "Waiting for demand." }),
    { op: "place", id: "beta", band: "Now", position: 0 },
    { op: "set_open_questions", questions: ["Is gamma needed this cycle?"] }
  ] });
  assert.equal(created.created, true);
  assert.equal(created.recordPath, "product/roadmap.json");
  assert.deepEqual(created.record.initiatives.map((item) => item.id), ["beta", "alpha", "gamma", "delta"]);
  assert.deepEqual(created.derived.map((item) => item.state), ["envisioned", "envisioned", "envisioned", "envisioned"]);
  const projection = await readFile(path.join(projectRoot, "product/roadmap.md"), "utf8");
  for (const heading of ["## Initiative index", "### Now", "### Next", "### Parked", "## Sequencing rationale", "## Parked context", "## Open questions", "## Lifecycle"]) assert.match(projection, new RegExp(`^${heading}$`, "m"));
  assert.match(projection, /Requires `alpha`\./);
  assert.match(projection, /generated view of roadmap.json/);
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: created.revision, operations: [{ op: "set_requires", id: "alpha", requires: ["gamma"] }] }), /cycle/);
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: created.revision, operations: [{ op: "set_requires", id: "alpha", requires: ["missing"] }] }), /unknown initiative/);
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("x", "Now")] }), { code: "revision_conflict" });
  assert.equal((await getRoadmap({ projectRoot })).revision, created.revision);
});

test("derives planned and in-progress from records and refuses to ship unfinished work", async (context) => {
  const projectRoot = await project(context);
  let roadmap = await updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("reports", "Now")] });
  const initiative = await updateInitiative({ projectRoot, initiative: "reports", expectedRevision: null, operations: [
    { op: "create", slug: "reports", title: "Export reports", requirements: ["r.md#1", "r.md#2"] },
    { op: "split", parent: "reports", children: [{ slug: "a", title: "A", requirements: ["r.md#1"] }, { slug: "b", title: "B", requirements: ["r.md#2"] }] }
  ] });
  roadmap = await getRoadmap({ projectRoot });
  assert.equal(roadmap.derived[0].state, "planned");
  assert.deepEqual(roadmap.derived[0].progress, { leaves: 2, "not-started": 2, "in-progress": 0, blocked: 0, deferred: 0, done: 0 });
  await updateCoordinationState({ projectRoot, statePath: "docs/plans/reports/state.json", expectedRevision: null, changes: { settings: { autonomy: "broad" } } });
  assert.equal((await getRoadmap({ projectRoot })).derived[0].state, "planned");
  await updateInitiative({ projectRoot, initiative: "reports", expectedRevision: initiative.revision, operations: [{ op: "set_status", slug: "a", status: "in-progress" }] });
  roadmap = await getRoadmap({ projectRoot });
  assert.equal(roadmap.derived[0].state, "in-progress");
  assert.equal(roadmap.derived[0].readyToShip, false);
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: roadmap.revision, operations: [{ op: "ship", id: "reports" }] }), (error) => error.code === "gate_blocked" && error.state === "in-progress");
});

test("a recorded ship decision survives coordination cleanup", async (context) => {
  const projectRoot = await project(context);
  const roadmap = await updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("done-work", "Now"), add("next-work", "Next")] });
  // A complete record is written directly because the completion gate needs review evidence this test does not build.
  await mkdir(path.join(projectRoot, "docs/plans/done-work"), { recursive: true });
  await writeFile(path.join(projectRoot, "docs/plans/done-work/initiative.json"), JSON.stringify({ schemaVersion: 1, id: "done-work", slices: { root: { title: "Root", status: "done", parent: null, requirements: ["r.md#1"], dependencies: [] } }, history: [] }));
  const ready = await getRoadmap({ projectRoot });
  assert.equal(ready.derived[0].readyToShip, true);
  const shipped = await updateRoadmap({ projectRoot, expectedRevision: ready.revision, actor: "orchestrator", operations: [{ op: "ship", id: "done-work" }, { op: "supersede", id: "next-work", by: "done-work", reason: "Shipped work covers it." }] });
  assert.equal(shipped.derived[0].state, "shipped");
  assert.equal(shipped.derived[0].band, "Shipped");
  assert.equal(shipped.derived[1].state, "superseded");
  await rm(path.join(projectRoot, "docs/plans/done-work"), { recursive: true });
  const after = await getRoadmap({ projectRoot });
  assert.equal(after.derived[0].state, "shipped");
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: after.revision, operations: [{ op: "place", id: "done-work", band: "Now" }] }), /keeps its place in history/);
  const projection = await readFile(path.join(projectRoot, "product/roadmap.md"), "utf8");
  assert.match(projection, /### Shipped/);
  assert.match(projection, /## Superseded context/);
  assert.equal(roadmap.created, true);
});

test("keeps a hand-written roadmap until the caller replaces it explicitly", async (context) => {
  const projectRoot = await project(context, "- Roadmap: docs/roadmap.md\n");
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await writeFile(path.join(projectRoot, "docs/roadmap.md"), "# Roadmap\n\nWritten by a person.\n");
  const created = await updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("alpha", "Now")] });
  assert.equal(created.projectionStale, true);
  assert.equal(await readFile(path.join(projectRoot, "docs/roadmap.md"), "utf8"), "# Roadmap\n\nWritten by a person.\n");
  const replaced = await updateRoadmap({ projectRoot, expectedRevision: created.revision, operations: [{ op: "replace_hand_written_projection" }] });
  assert.equal(replaced.projectionStale, false);
  assert.equal(replaced.revision, created.revision);
  assert.match(await readFile(path.join(projectRoot, "docs/roadmap.md"), "utf8"), /generated view of roadmap.json/);
});

test("a disabled roadmap path refuses roadmap tools", async (context) => {
  const projectRoot = await project(context, "- Roadmap: n/a\n");
  await assert.rejects(getRoadmap({ projectRoot }), { code: "invalid_config" });
});
