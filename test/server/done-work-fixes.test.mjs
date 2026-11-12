import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { finished, finishedProject, ship, slice } from "./fixtures/shipped-work.mjs";

// A defect in done work joins its unshipped initiative as a fix slice that leaves the done slice's records as they were and holds ship until it is done.
const FIX = "fix-download";
const KEPT = ["status", "design", "requirements", "dependencies", "parent", "title"];
const keptOf = (record, slug) => JSON.stringify(Object.fromEntries(KEPT.map((key) => [key, record.slices[slug][key] ?? null])));

const update = async (call, operations) => {
  const current = await call("get_initiative", { initiative: "reports" });
  return call("update_initiative", { initiative: "reports", expectedRevision: current.value.revision, operations });
};
const read = async (call) => (await call("get_initiative", { initiative: "reports" })).value;

const reportDefect = (call, slug = "download", summary = "A download of an empty report returns an error instead of an empty file.") => update(call, [{ op: "report_defect", slug, requirements: ["reports.md§1"], summary }]);

// The fix slice's own design: its contract and changes in its own folder, and a frozen test of its own.
async function writeFixDesign(root, fix = FIX) {
  await mkdir(path.join(root, "docs/plans/reports", fix), { recursive: true });
  await writeFile(path.join(root, "docs/plans/reports", fix, "slice.md"), `# Empty report downloads\n\n## Contract\n\n1. Downloading an empty report writes an empty file and exits 0.\n\n## Changes\n\n- change \`src/report.mjs\`: download writes an empty file for an empty report (§1)\n`);
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test", `${fix}.test.mjs`), "import test from \"node:test\";\ntest(\"downloads an empty report\", () => {});\n");
}

const fixProposal = (defects = ["d1"], fix = FIX) => ({ op: "propose_design", slug: "download", operations: [
  { op: "add_fix", slug: "download", defects, fix: { slug: fix, title: "Empty report downloads", outcome: "An empty report downloads as an empty file.", requirements: ["reports.md§1"] } },
  { op: "accept_design", slug: fix, frozenTests: [`test/${fix}.test.mjs`], review: "none" }
] });

async function acceptedFix(context, slices = finished()) {
  const setup = await finishedProject(context, "reports", slices);
  assert.equal((await reportDefect(setup.call)).error, null);
  await writeFixDesign(setup.root);
  assert.equal((await update(setup.call, [{ op: "claim", slug: "download" }])).error, null);
  const before = await read(setup.call);
  const proposed = await update(setup.call, [fixProposal()]);
  assert.equal(proposed.error, null, proposed.error?.message);
  const accepted = await update(setup.call, [{ op: "accept_proposal", slug: "download", reviewRequired: [] }]);
  assert.equal(accepted.error, null, accepted.error?.message);
  return { ...setup, before: before.record, after: (await read(setup.call)).record };
}

test("§20 report_defect records a numbered defect on a done slice and leaves the slice as it was", async (context) => {
  const { call } = await finishedProject(context);
  const before = (await read(call)).record;
  assert.equal((await reportDefect(call)).error, null);
  assert.equal((await reportDefect(call, "download", "Downloads of large reports time out.")).error, null);
  const after = (await read(call)).record;
  assert.deepEqual(after.slices.download.defects.map(({ id, requirements, summary }) => ({ id, requirements, summary })), [
    { id: "d1", requirements: ["docs/requirements/reports.md#1"], summary: "A download of an empty report returns an error instead of an empty file." },
    { id: "d2", requirements: ["docs/requirements/reports.md#1"], summary: "Downloads of large reports time out." }
  ]);
  assert.ok(after.slices.download.defects.every((item) => !Number.isNaN(Date.parse(item.reportedAt))));
  assert.equal(keptOf(after, "download"), keptOf(before, "download"));
  const notDone = await finishedProject(context, "reports", { ...finished(), audit: slice("Audit downloads", "in-progress", "root", ["docs/requirements/reports.md#2"]) });
  assert.equal((await reportDefect(notDone.call, "audit")).value?.code, "validation_failed");
});

test("§21 a done slice takes a design claim for its fix", async (context) => {
  const { call } = await finishedProject(context);
  const claimed = await update(call, [{ op: "claim", slug: "download" }]);
  assert.equal(claimed.error, null, claimed.error?.message);
  assert.equal((await read(call)).claims.download.activity, "design");
});

test("§22 a done scope's proposal takes only one fix with its design, for open defects and a new slug", async (context) => {
  const { root, call } = await finishedProject(context);
  assert.equal((await reportDefect(call)).error, null);
  await writeFixDesign(root);
  assert.equal((await update(call, [{ op: "claim", slug: "download" }])).error, null);
  const refusals = [
    { op: "propose_design", slug: "download", operations: [{ op: "update_slice", slug: "download", title: "Download" }] },
    { op: "propose_design", slug: "download", operations: [fixProposal().operations[0]] },
    fixProposal(["d9"]),
    fixProposal(["d1"], "audit")
  ];
  for (const operation of refusals) assert.equal((await update(call, [operation])).value?.code, "validation_failed", JSON.stringify(operation.operations));
  assert.equal((await update(call, [fixProposal().operations[0]])).value?.code, "validation_failed", "add_fix stands only in a proposal");
  assert.equal((await update(call, [fixProposal()])).error, null);
  assert.equal((await update(call, [{ op: "accept_proposal", slug: "download", reviewRequired: [] }])).error, null);
  await writeFixDesign(root, "fix-again");
  assert.equal((await update(call, [{ op: "claim", slug: "download" }])).error, null);
  assert.equal((await update(call, [fixProposal(["d1"], "fix-again")])).value?.code, "validation_failed", "a defect that another fix names is not open");
});

test("§23 accepting a fix adds a new slice under the done slice and keeps the done slice's records", async (context) => {
  const { before, after } = await acceptedFix(context);
  const fix = after.slices[FIX];
  assert.deepEqual({ status: fix.status, parent: fix.parent, fixes: fix.fixes, title: fix.title, outcome: fix.outcome, requirements: fix.requirements }, {
    status: "not-started", parent: "download", fixes: { slice: "download", defects: ["d1"] }, title: "Empty report downloads", outcome: "An empty report downloads as an empty file.", requirements: ["docs/requirements/reports.md#1"]
  });
  assert.deepEqual(fix.design.frozenTests.map((item) => item.path), [`test/${FIX}.test.mjs`]);
  assert.equal(keptOf(after, "download"), keptOf(before, "download"));
  assert.deepEqual(after.slices.download.defects, before.slices.download.defects);
});

test("§24 the fix slice's design is the slice.md in its own folder", async (context) => {
  const { root, call } = await finishedProject(context);
  assert.equal((await reportDefect(call)).error, null);
  await writeFixDesign(root);
  await writeFile(path.join(root, "docs/plans/reports", FIX, "slice.md"), "# Empty report downloads\n\n## Contract\n\n1. Downloading an empty report writes an empty file.\n\n## Changes\n\n- rewrite the download\n");
  assert.equal((await update(call, [{ op: "claim", slug: "download" }])).error, null);
  const refused = await update(call, [fixProposal()]);
  assert.equal(refused.value?.code, "validation_failed", "acceptance reads Changes from the fix slice's own folder");
  assert.match(refused.error.message, /Changes line/);
  await writeFixDesign(root);
  assert.equal((await update(call, [fixProposal()])).error, null);
});

test("§25 a fix slice is a leaf of the done slice's ancestors and cannot split", async (context) => {
  const { call } = await acceptedFix(context);
  const { derived } = await read(call);
  assert.ok(derived.leaves.includes(FIX));
  assert.ok(derived.leaves.includes("download"));
  assert.equal(derived.counts["not-started"], 1);
  assert.equal(derived.counts.done, 2);
  assert.ok(derived.designCandidates.includes(FIX));
  assert.equal(derived.complete.root, false);
  assert.equal(derived.complete.download, false, "the fixed slice's subtree waits for its fix");
  assert.deepEqual(derived.children.download, [FIX]);
  assert.deepEqual(derived.fixes, { download: [FIX] });
  const split = await update(call, [{ op: "split", parent: FIX, children: [{ slug: "part", title: "Part", requirements: ["reports.md§1"] }], evidence: { kind: "user_gate", gate: "gate-00000001" } }]);
  assert.equal(split.value?.code, "validation_failed");
});

test("§26 a fix starts after the done slice's dependencies, and dependents of the done slice wait for the fix", async (context) => {
  const slices = {
    root: slice("Reports", "split", null, ["docs/requirements/reports.md#1", "docs/requirements/reports.md#2", "docs/requirements/reports.md#3"]),
    base: slice("Base", "not-started", "root", ["docs/requirements/reports.md#3"]),
    download: slice("Download reports", "done", "root", ["docs/requirements/reports.md#1"], { dependencies: ["base"] }),
    audit: slice("Audit downloads", "not-started", "root", ["docs/requirements/reports.md#2"], { dependencies: ["download"] })
  };
  const { call } = await acceptedFix(context, slices);
  const fixStart = await update(call, [{ op: "set_status", slug: FIX, status: "in-progress" }]);
  assert.equal(fixStart.value?.code, "dependencies_incomplete");
  assert.deepEqual(fixStart.value.waiting, ["base"]);
  const auditStart = await update(call, [{ op: "set_status", slug: "audit", status: "in-progress" }]);
  assert.equal(auditStart.value?.code, "dependencies_incomplete");
  assert.ok(auditStart.value.waiting.includes(FIX));
});

test("§27 an unfinished fix keeps the initiative from shipping and is named", async (context) => {
  const { call } = await finishedProject(context);
  assert.equal((await reportDefect(call)).error, null);
  let view = await read(call);
  assert.deepEqual(view.derived.unfinishedFixes, [{ slice: "download", defect: "d1", fix: null, status: "not-designed" }]);
  assert.equal(view.derived.readyToShip, false);
  const refused = await ship(call, "reports");
  assert.equal(refused.value?.code, "fixes_unfinished");
  assert.deepEqual(refused.value.fixes, [{ slice: "download", defect: "d1", fix: null, status: "not-designed" }]);
  assert.match(refused.error.message, /download/);
  assert.match(refused.error.message, /d1/);
  assert.equal((await call("get_roadmap")).value.derived.find((item) => item.id === "reports").readyToShip, false);
});

test("§27 an accepted fix that is not done is named with its slice and status", async (context) => {
  const { call } = await acceptedFix(context);
  const view = await read(call);
  assert.deepEqual(view.derived.unfinishedFixes, [{ slice: "download", defect: "d1", fix: FIX, status: "not-started" }]);
  const refused = await ship(call, "reports");
  assert.equal(refused.value?.code, "fixes_unfinished");
  assert.match(refused.error.message, new RegExp(FIX));
});

test("§28 a done slice stays done", async (context) => {
  const { call } = await finishedProject(context);
  for (const status of ["in-progress", "not-started", "blocked", "deferred"]) {
    const refused = await update(call, [{ op: "set_status", slug: "download", status }]);
    assert.equal(refused.value?.code, "slice_done", status);
    assert.equal(refused.error.message.split("\n")[0], "The slice download is done and stays done; report a defect with report_defect and design a fix as new work.");
  }
  assert.equal((await read(call)).record.slices.download.status, "done");
});
