import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  assert.match(plannedChanges("## Changes\n- tweak `a.rs`\n- change `../b.rs`: x\n").problems.join(" "), /does not start with add[\s\S]*not a normalized/);
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
