import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/design-views.md §5.
// Contract: docs/plans/design-views/slice.md clause 7.
// Prism reads the kind a view draws from its source and refuses a view that declares another kind.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-kinds-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n";
const SOURCES = {
  sequence: "@startuml\nparticipant Client\nparticipant Server\nClient -> Server: download\nServer --> Client: bytes\n@enduml\n",
  actors: "@startuml\nactor Person\ndatabase Store\nPerson -> Store: read\n@enduml\n",
  blocks: "@startuml\nparticipant Client\nparticipant Server\nalt known id\n  Client -> Server: download\nelse unknown id\n  Server --> Client: exit 2\nend\nloop each chunk\n  Server --> Client: bytes\nend\nopt audit\n  Server -> Server: record\nend\npar\n  Client -> Server: ping\nelse\n  Server -> Client: pong\nend\ngroup retry\n  Client -> Server: download\nend\ncritical\n  Server -> Server: sign\nend\nbreak timeout\n  Server --> Client: abort\nend\n@enduml\n",
  edges: "@startuml\nparticipant Server\n[-> Server: download [id]\n[o-> Server: retry [id]\nServer ->] : bytes\n@enduml\n",
  activity: "@startuml\nstart\n:read the id;\nif (known?) then (yes)\n  :write bytes;\nelse (no)\n  :exit 2;\nendif\nstop\n@enduml\n",
  state: "@startuml\n[*] --> Requested\nRequested --> Written : found\nWritten --> [*]\n@enduml\n",
  component: "@startuml\ncomponent \"cli\" as cli\ninterface \"report API\" as api\ncli --> api\n@enduml\n",
  bracketed: "@startuml\npackage reports {\n  [cli]\n}\n[cli] --> [storage]\n@enduml\n",
  c4: "@startuml\n!include <C4/C4_Component>\nComponent(cli, \"cli\", \"js\")\nComponent(store, \"store\", \"js\")\nRel(cli, store, \"reads\")\n@enduml\n",
  deployment: "@startuml\nnode \"laptop\" {\n  artifact \"report cli\" as cli\n}\ncloud \"report store\" as store\ncli --> store\n@enduml\n",
  c4deployment: "@startuml\n!include <C4/C4_Deployment>\nDeployment_Node(laptop, \"laptop\") {\n  Container(cli, \"report cli\", \"node\")\n}\n@enduml\n",
  class: "@startuml\nclass ReportSource\nclass Client\nReportSource --> Client\n@enduml\n",
  grouped: "@startuml\npackage reports {\n  class Report\n  class Download\n}\nReport --> Download\n@enduml\n",
  relations: "@startuml\nentity Report\nentity Download\nReport ||--o{ Download\n@enduml\n",
  entity: "@startuml\nentity Report {\n  id : string\n}\nentity Download {\n  at : time\n}\nReport ||--o{ Download\n@enduml\n",
  mindmap: "@startmindmap\n* reports\n** download\n@endmindmap\n",
  api: `${JSON.stringify({ openapi: "3.1.0", info: { title: "Reports", version: "1" }, paths: {} })}\n`
};

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-kinds-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// downloads write the report\n");
  await write(root, `${PLANS}/slice.md`, CONTRACT);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

// Propose a one-slice design whose folder holds one view of the declared kind drawn from the named source.
async function proposeView(root, declared, source) {
  const file = source === "api" ? "view.json" : "view.puml";
  await rm(path.join(root, PLANS, source === "api" ? "view.puml" : "view.json"), { force: true });
  await write(root, `${PLANS}/${file}`, SOURCES[source]);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`${file}\` ${declared} (§1): What does this view answer?\n`);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const request = [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }] }];
  return initiativeAcknowledgement(await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: request }), request);
}

const ACCEPTED = [
  ["sequence", "sequence"], ["sequence", "actors"], ["sequence", "blocks"], ["sequence", "edges"], ["activity", "activity"], ["state", "state"],
  ["component", "component"], ["component", "bracketed"], ["component", "c4"], ["component", "deployment"],
  ["deployment", "deployment"], ["deployment", "c4deployment"],
  ["code", "class"], ["code", "component"], ["code", "c4"], ["data-model", "entity"], ["data-model", "class"],
  ["data-model", "grouped"], ["code", "grouped"], ["data-model", "relations"], ["api", "api"]
];

test("clause 7: a view whose source draws its declared kind is accepted with that kind", async (context) => {
  const root = await project(context);
  const failures = [];
  for (const [declared, source] of ACCEPTED) {
    try {
      const result = await proposeView(root, declared, source);
      const view = result.views?.find((item) => item.path.startsWith(`${PLANS}/view.`));
      if (view?.kind !== declared) failures.push(`${declared} from ${source}: listed as ${view?.kind}`);
    } catch (error) { failures.push(`${declared} from ${source}: ${error.message}`); }
  }
  assert.deepEqual(failures, []);
});

const REFUSED = [
  ["activity", "sequence", "sequence"], ["activity", "blocks", "sequence"], ["component", "edges", "sequence"], ["sequence", "activity", "activity"], ["sequence", "state", "state"],
  ["deployment", "component", "component"], ["component", "class", "class"], ["data-model", "component", "component"], ["component", "grouped", "class"],
  ["wireframe", "sequence", "sequence"], ["component", "mindmap", "mindmap"], ["api", "sequence", "sequence"], ["sequence", "api", "api"]
];

test("clause 7: a view whose source draws another kind is refused, naming the view, the declared kind, and the drawn kind", async (context) => {
  const root = await project(context);
  const failures = [];
  for (const [declared, source, drawn] of REFUSED) {
    try {
      await proposeView(root, declared, source);
      failures.push(`${declared} from ${source}: accepted`);
    } catch (error) {
      const file = source === "api" ? "view.json" : "view.puml";
      if (error.code !== "view_problems" || !error.message.includes(`${PLANS}/${file}`) || !error.message.includes(`declares ${declared}`) || !error.message.includes(`draws ${drawn}`)) failures.push(`${declared} from ${source}: ${error.code} ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
