import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { comparePlannedChanges, contractClauses, loadDesignView, plannedChanges, updateDesignView } = await import("../../dist/server/workflow/design-view.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const DESIGN = `# Download signed reports

## Contract
- \`report download <id>\` writes the report bytes to stdout and exits 0.
- An unknown id exits 2 with \`error: no report <id>\` on stderr
  and writes nothing to stdout.
- Reports above 2 GiB are refused with \`error: report too large\`.

## Changes
- add \`src/report/source.rs\`: \`ReportSource\`, shared by both steps.
- change \`src/storage/client.rs\`: \`get\` streams large reports.
- change \`src/cli/report.rs\`: \`download\` subcommand.

## Frozen tests
- \`tests/report_download.rs\`
`;
const TESTS = "#[test]\nfn download_writes_bytes() {}\n#[test]\nfn download_unknown_id() {}\n";

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of [".prism", "tests", "src/storage", "src/cli", `docs/plans/${INITIATIVE}`]) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, "tests", "report_download.rs"), TESTS);
  await writeFile(path.join(root, "src", "storage", "client.rs"), "fn get() {}\n");
  await writeFile(path.join(root, "src", "cli", "report.rs"), "fn main() {}\n");
  await writeFile(path.join(root, "docs", "plans", INITIATIVE, "slice.md"), DESIGN);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

const examples = [
  { clause: 1, file: "tests/report_download.rs", test: "download_writes_bytes", example: "`report download 42` with report 42 stored → its bytes on stdout, exit 0" },
  { clause: 2, file: "tests/report_download.rs", test: "download_unknown_id", example: "`report download 7` with no report 7 → `error: no report 7`, exit 2" }
];

test("a design's contract clauses and planned changes are read from slice.md", () => {
  assert.deepEqual(contractClauses(DESIGN).map((clause) => clause.slice(0, 22)), ["`report download <id>`", "An unknown id exits 2 ", "Reports above 2 GiB ar"]);
  assert.match(contractClauses(DESIGN)[1], /stderr and writes nothing/);
  const { changes, problems } = plannedChanges(`${DESIGN}\n## Changes\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual(changes.map((change) => [change.action, change.path, change.units]), [
    ["add", "src/report/source.rs", ["ReportSource"]],
    ["change", "src/storage/client.rs", ["get"]],
    ["change", "src/cli/report.rs", ["download"]]
  ]);
  assert.match(plannedChanges("## Changes\n- tweak `a.rs`\n- change `../b.rs`: x\n").problems.join(" "), /must be add, change, or remove[\s\S]*not a normalized/);
  // One line may name several paths; each becomes its own change with the shared note, and a line that runs on after its paths is refused.
  const listed = plannedChanges("## Changes\n- change `dist/a.mjs`, `dist/b.mjs`: regenerated output of `build`.\n");
  assert.deepEqual(listed.problems, []);
  assert.deepEqual(listed.changes.map((change) => [change.path, change.units, change.note]), [["dist/a.mjs", ["build"], "regenerated output of `build`."], ["dist/b.mjs", ["build"], "regenerated output of `build`."]]);
  assert.equal(plannedChanges("## Changes\n- change `a.mjs` and `b.mjs`: x\n").problems.length, 1);
});

test("the design view keeps only examples that cite a real clause and test, and lists clauses without one as gaps", async (context) => {
  const root = await project(context);
  await assert.rejects(updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples: [{ ...examples[0], test: "download_streams" }] }), /does not contain/);
  await assert.rejects(updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples: [{ ...examples[0], clause: 4 }] }), /the Contract has 3/);
  await assert.rejects(updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples: [{ ...examples[0], test: "download" }] }), /does not contain/, "a test name matches as a whole word");
  const written = await updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples });
  assert.equal(written.status, "written");
  assert.deepEqual(written.gaps.map((gap) => gap.clause), [3]);

  const view = await loadDesignView(root, INITIATIVE, INITIATIVE);
  assert.deepEqual(view.stale, []);
  assert.deepEqual(view.gaps, [3]);
  assert.equal(view.clauses[1].examples[0].test, "download_unknown_id");
  assert.deepEqual(view.changeProblems, []);
});

test("an accepted design limits examples to its frozen tests, and a changed contract or test marks the view stale", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, "tests", "other.rs"), "fn download_writes_bytes() {}\n");
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }, { op: "accept_design", slug: INITIATIVE, frozenTests: ["tests/report_download.rs"], review: "none" }] });
  await assert.rejects(updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples: [{ ...examples[0], file: "tests/other.rs" }] }), /not a frozen test/);
  await updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples });

  await writeFile(path.join(root, "tests", "report_download.rs"), `${TESTS}fn download_large() {}\n`);
  await writeFile(path.join(root, "docs", "plans", INITIATIVE, "slice.md"), DESIGN.replace("exits 0", "exits 0 and flushes"));
  const view = await loadDesignView(root, INITIATIVE, INITIATIVE);
  assert.equal(view.stale.length, 2);
  assert.deepEqual(view.gaps, [], "a stale view claims no gaps");
});

test("a planned change to a missing file is flagged before implementation", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, "docs", "plans", INITIATIVE, "slice.md"), DESIGN.replace("src/cli/report.rs", "src/cli/missing.rs"));
  const view = await loadDesignView(root, INITIATIVE, INITIATIVE);
  assert.deepEqual(view.changeProblems, ["src/cli/missing.rs is planned to change but does not exist."]);
  assert.equal(view.examplesWritten, null);
});

test("a Changes line names the Contract clauses it serves, and a clause the Contract lacks is a problem", () => {
  const tagged = plannedChanges(`${DESIGN.split("## Changes")[0]}## Changes\n- change \`src/cli/report.rs\`: \`download\` and its errors (§1, §3).\n- change \`src/storage/client.rs\`: \`get\` streams.\n`);
  assert.deepEqual(tagged.problems, []);
  assert.deepEqual(tagged.changes.map((change) => [change.note, change.clauses, change.item]), [["`download` and its errors", [1, 3], 0], ["`get` streams.", [], 1]]);
  assert.match(plannedChanges(`${DESIGN.split("## Changes")[0]}## Changes\n- change \`src/cli/report.rs\`: x (§4).\n`).problems.join(" "), /§4/);
});

test("the design view places changed units through the code index and lists the tests behind each change", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, "docs", "plans", INITIATIVE, "slice.md"), DESIGN.replace("`get` streams large reports.", "`get` streams large reports (§1).").replace("`download` subcommand.", "`download` and `print_error` (§2, §3)."));
  await updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples });
  const units = { snapshot: "s1", units: [
    { file: "src/storage/client.rs", kind: "function", name: "get", range: { startLine: 1, endLine: 1 } },
    { file: "src/cli/report.rs", kind: "function", name: "download", qualifiedName: "cli::download", range: { startLine: 4, endLine: 9 } }
  ] };
  const view = await loadDesignView(root, INITIATIVE, INITIATIVE, { units });
  assert.deepEqual(view.indexed, { snapshot: "s1" });
  const [added, client, cli] = view.changes;
  assert.deepEqual(added.places, [], "an added file has no place yet");
  assert.deepEqual(client.places, [{ unit: "get", kind: "function", startLine: 1, endLine: 1 }]);
  assert.deepEqual(client.tests.map((item) => item.test), ["download_writes_bytes"]);
  assert.deepEqual(cli.places.map((place) => [place.unit, place.startLine, place.endLine]), [["download", 4, 9]]);
  assert.deepEqual(cli.tests.map((item) => item.test), ["download_unknown_id"], "clause 3 has no example, so only clause 2's test is listed");
  assert.deepEqual(view.changeProblems, ["`print_error` is not a unit of src/cli/report.rs in the code index."]);
  const unindexed = await loadDesignView(root, INITIATIVE, INITIATIVE);
  assert.equal(unindexed.indexed, null);
  assert.equal(unindexed.changes[1].places, null);
});

test("a slice of a split scope cites the scope's Contract and shows only the clauses it serves", async (context) => {
  const root = await project(context);
  await updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples });
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "split", parent: INITIATIVE, children: [
    { slug: "stream", title: "Stream reports", requirements: ["req.md#R1"] },
    { slug: "errors", title: "Report errors", requirements: ["req.md#R1"] }
  ], evidence: await splitEvidence(root, `docs/plans/${INITIATIVE}`, "errors") }] });
  await mkdir(path.join(root, "docs", "plans", INITIATIVE, "errors"), { recursive: true });
  await writeFile(path.join(root, "docs", "plans", INITIATIVE, "errors", "slice.md"), "# Report errors\n\n## Changes\n- change `src/cli/report.rs`: `download` error messages (§2, §3).\n");
  const view = await loadDesignView(root, INITIATIVE, "errors");
  assert.deepEqual(view.contract, { path: `docs/plans/${INITIATIVE}/slice.md`, slice: INITIATIVE });
  assert.deepEqual(view.clauses.map((clause) => clause.number), [2, 3]);
  assert.deepEqual(view.gaps, [3], "the scope's examples cover clause 2 only");
  assert.deepEqual(view.changes[0].tests.map((item) => item.test), ["download_unknown_id"]);
  assert.deepEqual(view.changeProblems, []);
  const next = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await assert.doesNotReject(updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: next.revision, operations: [{ op: "set_status", slug: "errors", status: "in-progress" }, { op: "accept_design", slug: "errors", frozenTests: ["tests/report_download.rs"], review: "none" }] }), "a clause of the scope's Contract is a valid citation");
});

test("planned changes line up against the verified result's change map", () => {
  const { changes } = plannedChanges(DESIGN);
  const unit = (action, file, label) => ({ action, kind: "function", label, before: action === "ADD" ? [] : [{ path: file }], after: action === "DELETE" ? [] : [{ path: file }] });
  const concepts = [
    unit("ADD", "src/cli/report.rs", "download"),
    unit("ADD", "src/cli/report.rs", "parse_id"),
    unit("MODIFY", "src/storage/client.rs", "retry"),
    { action: "MODIFY", kind: "file", label: "src/config.rs", before: [{ path: "src/config.rs" }], after: [{ path: "src/config.rs" }] }
  ];
  const rows = Object.fromEntries(comparePlannedChanges(changes, concepts).map((row) => [row.path, row]));
  assert.equal(rows["src/cli/report.rs"].reading, "as-planned");
  assert.deepEqual(rows["src/cli/report.rs"].extra, ["parse_id"]);
  assert.equal(rows["src/storage/client.rs"].reading, "partly");
  assert.deepEqual(rows["src/storage/client.rs"].missing, ["get"]);
  assert.equal(rows["src/report/source.rs"].reading, "untouched");
  assert.equal(rows["src/config.rs"].reading, "unplanned");
  assert.equal(comparePlannedChanges([{ action: "change", path: "src/", units: [], note: "" }], concepts)[0].reading, "as-planned", "a planned folder covers the files under it");
});
