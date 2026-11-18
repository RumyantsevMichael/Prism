import assert from "node:assert/strict";
import test from "node:test";
import { isolateGit, workspace } from "./fixtures/workspace-artifacts.mjs";
import { repository, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Requirements: docs/requirements/design-views.md §8.
// Contract: docs/plans/design-views/slice.md clause 16.
// An agent that reads a declared view through get_artifact learns which clauses it explains and that the contract decides.

await isolateGit();
const { getArtifact, updateArtifact } = await import("../../dist/server/workflow/store-artifacts.mjs");

const PLANS = "docs/plans/reports";
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n2. An unknown id exits 2.\n3. Audits list downloads.\n";
const SEQUENCE = "@startuml\nparticipant Client\nparticipant Server\nClient -> Server: download\nServer --> Client: bytes\n@enduml\n";

async function storeProject(context) {
  const { parent } = await workspace(context);
  await storeFolder(parent);
  return repository(parent, "demo", { repository: "demo" });
}

async function write(root, files) {
  await updateArtifact({ projectRoot: root, operations: Object.entries(files).map(([file, content]) => ({ op: "write", path: file, content, expectedVersion: null })) });
}

test("clause 16: reading a declared view names its kind, question, and clauses, and says that the contract decides", async (context) => {
  const root = await storeProject(context);
  await write(root, {
    [`${PLANS}/slice.md`]: `${CONTRACT}\n## Views\n- \`flow.puml\` sequence (§1, §3): In what order do the client and the server talk?\n`,
    [`${PLANS}/flow.puml`]: SEQUENCE,
    [`${PLANS}/download/slice.md`]: "# Download reports\n\n## Views\n- `calls.puml` sequence (§2): What happens for an unknown id?\n",
    [`${PLANS}/download/calls.puml`]: SEQUENCE,
    [`${PLANS}/download/other.puml`]: SEQUENCE
  });
  const read = await getArtifact({ projectRoot: root, path: `${PLANS}/flow.puml` });
  assert.equal(read.content, SEQUENCE);
  assert.equal(read.view.kind, "sequence");
  assert.equal(read.view.question, "In what order do the client and the server talk?");
  assert.deepEqual(read.view.clauses, [1, 3]);
  assert.equal(read.view.contract, `${PLANS}/slice.md`);
  assert.match(read.view.note, /explains §1 and §3/);
  assert.match(read.view.note, /docs\/plans\/reports\/slice\.md/);
  assert.match(read.view.note, /the contract decides/);
  const inherited = await getArtifact({ projectRoot: root, path: `${PLANS}/download/calls.puml` });
  assert.deepEqual(inherited.view.clauses, [2]);
  assert.equal(inherited.view.contract, `${PLANS}/slice.md`, "a slice's view cites the nearest design above it that holds a Contract");
  assert.match(inherited.view.note, /explains §2 of the contract in docs\/plans\/reports\/slice\.md/);
  assert.equal((await getArtifact({ projectRoot: root, path: `${PLANS}/download/other.puml` })).view, undefined, "an undeclared file is no view");
  assert.equal((await getArtifact({ projectRoot: root, path: `${PLANS}/slice.md` })).view, undefined);
});
