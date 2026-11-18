import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/slice-complexity-assessment.md §2.
// Contract: docs/plans/design-views/slice.md clause 14.
// A dense view of a fitted slice needs the design's assessment of why the slice stays whole, and Prism records each view's density with the accepted design.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-split-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n2. Audits list downloads.\n";
const range = (count) => Array.from({ length: count }, (_, index) => index + 1);
// Eight participants are more than two thirds of a sequence view's limit of 10, so the view is dense.
const DENSE = `@startuml\n${range(8).map((n) => `participant P${n}`).join("\n")}\n${range(7).map((n) => `P${n} -> P${n + 1}: call ${n}`).join("\n")}\n@enduml\n`;
const SPARSE = "@startuml\nparticipant Client\nparticipant Server\nClient -> Server: download\n@enduml\n";
const VIEW_LINE = "- `flow.puml` sequence (§1): In what order do the parts of a download talk?";

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-split-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// downloads write the report\n");
  await write(root, "test/audit.test.mjs", "// audits list downloads\n");
  await write(root, `${PLANS}/slice.md`, CONTRACT);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] }] });
  return root;
}

async function update(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

const single = [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }];

test("clause 14: a dense view of a fitted slice without a split assessment is refused, naming the view", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/flow.puml`, DENSE);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n${VIEW_LINE}\n`);
  await assert.rejects(update(root, [{ op: "propose_design", slug: INITIATIVE, operations: single }]), (error) => error.code === "split_assessment_missing" && /docs\/plans\/reports\/flow\.puml/.test(error.message) && /8 participants/.test(error.message));
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n${VIEW_LINE}\n\n## Split assessment\n- \`other.puml\`: The slice stays whole.\n`);
  await assert.rejects(update(root, [{ op: "propose_design", slug: INITIATIVE, operations: single }]), { code: "split_assessment_missing" });
});

test("clause 14: with a split assessment the dense view is accepted, and the accepted design records each view's counts and density", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/flow.puml`, DENSE);
  await write(root, `${PLANS}/calls.puml`, SPARSE);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n${VIEW_LINE}\n- \`calls.puml\` sequence (§2): Which call starts an audit?\n\n## Split assessment\n- \`flow.puml\`: Every participant takes part in the one download outcome, and a split would leave a slice no test can observe.\n`);
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: single }]);
  const accepted = await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  assert.deepEqual(accepted.record.slices[INITIATIVE].design.views, [
    { path: `${PLANS}/calls.puml`, kind: "sequence", elements: 2, relations: 1, dense: false },
    { path: `${PLANS}/flow.puml`, kind: "sequence", elements: 8, relations: 7, dense: true }
  ]);
});

test("clause 14: an overview of a plan is not a slice's view, so a dense overview needs no split assessment", async (context) => {
  const root = await project(context);
  const packages = range(24).map((n) => `package p${n} {\n}`).join("\n");
  await write(root, `${PLANS}/overview.puml`, `@startuml\npackage download {\n}\npackage audit {\n}\n${packages}\naudit ..> download\n@enduml\n`);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`overview.puml\` component (§1, §2): How do the download and audit slices fit together?\n`);
  const plan = [
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }] },
    { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
    { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
  ];
  const proposed = await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: plan }]);
  assert.ok(proposed.record.proposals[INITIATIVE]);
});
