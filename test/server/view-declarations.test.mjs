import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/design-views.md §1, §3, §4, §6.
// Contract: docs/plans/design-views/slice.md clauses 1 to 6, 10, and 15.
// A design declares its views in a Views section of slice.md, and Prism checks every declaration when the design is proposed.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-declarations-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { updateDesignView } = await import("../../dist/server/workflow/design-view.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n2. An unknown id exits 2.\n3. Audits list downloads.\n";
const SOURCES = {
  sequence: "@startuml\nparticipant Client\nparticipant Server\nClient -> Server: download\nServer --> Client: bytes\n@enduml\n",
  activity: "@startuml\nstart\n:read the id;\nif (known?) then (yes)\n  :write bytes;\nelse (no)\n  :exit 2;\nendif\nstop\n@enduml\n",
  state: "@startuml\n[*] --> Requested\nRequested --> Written : found\nRequested --> Refused : unknown\nWritten --> [*]\n@enduml\n",
  component: "@startuml\ncomponent \"cli\" as cli\ncomponent \"storage\" as storage\ncli --> storage : get\n@enduml\n",
  deployment: "@startuml\nnode \"laptop\" {\n  artifact \"report cli\" as cli\n}\ncloud \"report store\" as store\ncli --> store\n@enduml\n",
  code: "@startuml\nclass ReportSource\nclass Client\nReportSource --> Client\n@enduml\n",
  "data-model": "@startuml\nentity Report {\n  id : string\n}\nentity Download {\n  at : time\n}\nReport ||--o{ Download\n@enduml\n",
  api: `${JSON.stringify({ openapi: "3.1.0", info: { title: "Reports", version: "1" }, paths: { "/reports/{id}": { get: { responses: { 200: { description: "The report" } } } } } }, null, 2)}\n`
};
const FILES = { sequence: "flow.puml", activity: "steps.puml", state: "states.puml", component: "parts.puml", deployment: "hosts.puml", code: "code.puml", "data-model": "data.puml", api: "api.json" };

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-declarations-")));
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
const propose = async (root, operations = single) => {
  const request = [{ op: "propose_design", slug: INITIATIVE, operations }];
  return initiativeAcknowledgement(await update(root, request), request);
};
const views = (lines) => `${CONTRACT}\n## Views\n${lines.join("\n")}\n`;
const refused = (code, ...patterns) => (error) => {
  assert.equal(error.code, code, error.message);
  for (const pattern of patterns) assert.match(error.message, pattern);
  return true;
};

test("clause 2: a design with no views is accepted, and so is one with views of every kind in one folder", async (context) => {
  const root = await project(context);
  const none = await propose(root);
  assert.deepEqual(none.views ?? [], [], "a design needs no view, not even a code view");
  const other = await project(context);
  const kinds = Object.keys(FILES);
  for (const kind of kinds) await write(other, `${PLANS}/${FILES[kind]}`, SOURCES[kind]);
  await write(other, `${PLANS}/slice.md`, views(kinds.map((kind) => `- \`${FILES[kind]}\` ${kind} (§1): What does the ${kind} view show?`)));
  const all = await propose(other);
  assert.deepEqual(all.views.map((view) => [view.path, view.kind]).sort(), kinds.map((kind) => [`${PLANS}/${FILES[kind]}`, kind]).sort());
});

test("clause 2: a slice of a plan cites the scope's contract and its folder's views are checked with the overview", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/overview.puml`, "@startuml\npackage download {\n}\npackage audit {\n}\naudit ..> download\n@enduml\n");
  await write(root, `${PLANS}/slice.md`, views(["- `overview.puml` component (§1, §3): How do the download and audit slices fit together?"]));
  await write(root, `${PLANS}/download/flow.puml`, SOURCES.sequence);
  await write(root, `${PLANS}/download/slice.md`, "# Download reports\n\n## Views\n- `flow.puml` sequence (§1, §2): In what order do the client and the server talk?\n");
  const plan = [
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }] },
    { op: "set_dependencies", slug: "audit", dependencies: ["download"] },
    { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
    { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
  ];
  const accepted = await propose(root, plan);
  assert.deepEqual(accepted.views.map((view) => view.path).sort(), [`${PLANS}/download/flow.puml`, `${PLANS}/overview.puml`]);
  await write(root, `${PLANS}/download/slice.md`, "# Download reports\n\n## Views\n- `flow.puml` sequence (§4): In what order do the client and the server talk?\n");
  await assert.rejects(propose(root, plan), refused("view_problems", /flow\.puml/, /§4/));
});

test("clause 3: a PlantUML file that the Views section does not declare is refused, naming the file", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/code.puml`, SOURCES.code);
  await assert.rejects(propose(root), refused("view_problems", /docs\/plans\/reports\/code\.puml/, /states no question/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1): In what order do the client and the server talk?"]));
  await write(root, `${PLANS}/flow.puml`, SOURCES.sequence);
  await assert.rejects(propose(root), refused("view_problems", /code\.puml/, /states no question/));
});

test("clause 4: a Views line Prism cannot read, an unknown kind, and a missing question are refused, naming the view", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/flow.puml`, SOURCES.sequence);
  await write(root, `${PLANS}/slice.md`, views(["- flow.puml shows the calls"]));
  await assert.rejects(propose(root), refused("view_problems", /Views line/, /flow\.puml shows the calls/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` timeline (§1): In what order do the client and the server talk?"]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /timeline/, /sequence/, /api/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1): The calls between the client and the server."]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /question/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1):"]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /question/));
  await write(root, `${PLANS}/sub/flow.puml`, SOURCES.sequence);
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1): In what order do the client and the server talk?", "- `sub/flow.puml` sequence (§1): In what order do they talk again?"]));
  await assert.rejects(propose(root), refused("view_problems", /sub\/flow\.puml/, /api/));
});

test("clause 5: a view that cites no clause, or a clause the contract does not hold, is refused, naming the view and the clause", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/flow.puml`, SOURCES.sequence);
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence: In what order do the client and the server talk?"]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /cites no clause/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (): In what order do the client and the server talk?"]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /cites no clause/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§2, §7): In what order do the client and the server talk?"]));
  await assert.rejects(propose(root), refused("view_problems", /flow\.puml/, /§7/, /3 clauses|has 3/));
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§2, §3): In what order do the client and the server talk?"]));
  assert.deepEqual((await propose(root)).views.map((view) => view.path), [`${PLANS}/flow.puml`]);
});

test("clause 6: a declared view whose file does not exist is refused, naming the view", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1): In what order do the client and the server talk?"]));
  await assert.rejects(propose(root), refused("view_problems", /docs\/plans\/reports\/flow\.puml/, /does not exist/));
});

test("clause 10: a view that does not parse is refused, naming the view and the line", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/code.puml`, "@startuml\nclass A {\nA -->> B ::\n@enduml\n");
  await write(root, `${PLANS}/slice.md`, views(["- `code.puml` code (§1): Which units change?"]));
  await assert.rejects(propose(root), refused("view_problems", /code\.puml line 2 does not parse/));
  await write(root, `${PLANS}/code.puml`, "class Report\n");
  await assert.rejects(propose(root), refused("view_problems", /code\.puml does not parse/));
});

test("clause 15: the design view's writer learns of view problems before the design is proposed", async (context) => {
  const root = await project(context);
  await write(root, `${PLANS}/code.puml`, SOURCES.code);
  await write(root, `${PLANS}/flow.puml`, SOURCES.sequence);
  await write(root, `${PLANS}/slice.md`, views(["- `flow.puml` sequence (§1): In what order do the client and the server talk?"]));
  const written = await updateDesignView({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, examples: [{ clause: 1, file: "test/download.test.mjs", test: "downloads write the report", example: "a known id writes the report" }] });
  assert.equal(written.status, "written");
  assert.ok(written.viewProblems.some((problem) => /code\.puml/.test(problem) && /states no question/.test(problem)), JSON.stringify(written.viewProblems));
  assert.deepEqual(written.views.map((view) => [view.path, view.kind]), [[`${PLANS}/flow.puml`, "sequence"]]);
  assert.equal(written.diagramProblems, undefined);
});
