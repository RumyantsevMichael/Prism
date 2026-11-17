import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Requirements: docs/requirements/design-views.md §1, §7.
// Contract: docs/plans/design-views/slice.md clause 13.
// The vendored PlantUML runtime parses PlantUML Salt, so a wireframe view passes the design check and the review page can draw it.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-salt-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. The download screen asks for a report id.\n";
const SALT = "@startsalt\n{\n  Report id | \"42      \"\n  [Download] | [Cancel]\n}\n@endsalt\n";
const EMBEDDED = "@startuml\nsalt\n{+\n  Report id | \"42      \"\n  [Download] | [Cancel]\n}\n@enduml\n";

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-salt-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// the download screen asks for a report id\n");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

async function proposeWireframe(root, source) {
  await write(root, `${PLANS}/screen.puml`, source);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`screen.puml\` wireframe (§1): What does the download screen show?\n`);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }] }] });
}

test("clause 13: a Salt wireframe parses, both as its own diagram and inside @startuml", async (context) => {
  const root = await project(context);
  const own = await proposeWireframe(root, SALT);
  assert.ok(own.record.proposals[INITIATIVE], "the wireframe parses");
  const other = await project(context);
  const embedded = await proposeWireframe(other, EMBEDDED);
  assert.ok(embedded.record.proposals[INITIATIVE], "salt inside @startuml parses");
});

test("clause 13: the third-party notice names the vendored PlantUML release that draws Salt", async () => {
  const notices = await readFile(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  const version = /`@plantuml\/core` version (\d+)\.(\d+)\.(\d+)/.exec(notices);
  assert.ok(version, "the notice names the @plantuml/core version");
  const [major, year, release] = version.slice(1).map(Number);
  assert.ok(major > 1 || year > 2026 || (year === 2026 && release >= 9), `@plantuml/core ${version.slice(1).join(".")} predates Salt support`);
});
