import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Requirements: docs/requirements/design-views.md §2.
// Contract: docs/plans/design-views/slice.md clauses 8 and 9.
// A contract that plans more than one slice carries an overview that shows every planned slice.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-overview-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n2. Audits list downloads.\n";
const OVERVIEW_LINE = "- `overview.puml` component (§1, §2): How do the download and audit slices fit together?";
const children = [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }];
const plan = [
  { op: "split", parent: INITIATIVE, children },
  { op: "set_dependencies", slug: "audit", dependencies: ["download"] },
  { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
  { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
];

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-overview-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// downloads write the report\n");
  await write(root, "test/audit.test.mjs", "// audits list downloads\n");
  await write(root, `${PLANS}/slice.md`, CONTRACT);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] }] });
  return root;
}

async function propose(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "propose_design", slug: INITIATIVE, operations }] });
}

const refused = (code, ...patterns) => (error) => {
  assert.equal(error.code, code, error.message);
  for (const pattern of patterns) assert.match(error.message, pattern);
  return true;
};

test("clause 8: a plan of more than one slice without an overview is refused, naming the missing overview", async (context) => {
  const root = await project(context);
  await assert.rejects(propose(root, plan), refused("overview_missing", /docs\/plans\/reports\/overview\.puml/));
  await write(root, `${PLANS}/overview.puml`, "@startuml\nparticipant download\nparticipant audit\naudit -> download: reads\n@enduml\n");
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`overview.puml\` sequence (§1, §2): How do the download and audit slices fit together?\n`);
  await assert.rejects(propose(root, plan), refused("overview_missing", /overview\.puml/, /component/));
  const unchanged = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  assert.equal(unchanged.record.proposals, undefined, "a refused proposal records nothing");
});

test("clause 9: an overview that does not show every planned slice is refused, naming the slices it leaves out", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n${OVERVIEW_LINE}\n`);
  await write(root, `${PLANS}/overview.puml`, "@startuml\npackage download {\n  [cli]\n}\n@enduml\n");
  await assert.rejects(propose(root, plan), (error) => refused("overview_missing", /overview\.puml/, /audit/)(error) && !error.missing?.includes("download") && error.missing?.includes("audit"));
  await write(root, `${PLANS}/overview.puml`, "@startuml\npackage download {\n  [cli]\n}\npackage audit {\n  [log]\n}\n[log] ..> [cli] : reads downloads\n@enduml\n");
  const proposed = await propose(root, plan);
  assert.equal(proposed.record.proposals[INITIATIVE].operations.length, 4);
});

test("clause 9: a one-slice plan and a split into parts need no overview", async (context) => {
  const root = await project(context);
  const single = await propose(root, [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }]);
  assert.ok(single.record.proposals[INITIATIVE]);
  const other = await project(context);
  const parts = await propose(other, [{ op: "split", parent: INITIATIVE, children, evidence: await splitEvidence(other, PLANS, "download") }]);
  assert.ok(parts.record.proposals[INITIATIVE]);
});
