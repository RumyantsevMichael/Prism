import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordPersonAction } from "../../dist/server/workflow/state.mjs";

// A ship that lands after a writer checked the roadmap and before it wrote must still leave the shipped initiative's state unchanged.
const AT = "2026-11-03T23:35:20.345Z";

const roadmap = (decision) => ({ schemaVersion: 1, serves: "", initiatives: [{ id: "reports", title: "Title reports", intent: "Intent reports.", band: "Now", requirements: ["docs/requirements/reports.md#1"], requires: [], decision }], openQuestions: [], history: [] });

test("a change whose write follows a concurrent ship is refused and writes nothing", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-race-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n- Roadmap: docs/roadmap.md\n");
  const roadmapFile = path.join(root, ".prism/roadmap.json");
  await writeFile(roadmapFile, `${JSON.stringify(roadmap(null), null, 2)}\n`);
  let calls = 0;
  const prepare = async () => {
    calls += 1;
    // The second call runs under the state lock, after the shipped check: the initiative ships at this moment.
    if (calls === 2) await writeFile(roadmapFile, `${JSON.stringify(roadmap({ kind: "shipped", at: AT, actor: "orchestrator" }), null, 2)}\n`);
    const entry = { id: "0123456789abcdef0123456789abcdef", action: "initiative.autonomy", target: "initiative:reports", before: "conservative", after: "broad", at: new Date().toISOString(), by: { name: "Person", email: "person@example.com", checkout: "checkout" }, via: "review-app" };
    return { entry, setting: { name: "autonomy", value: "broad" } };
  };
  const outcome = await recordPersonAction({ projectRoot: root, initiative: "reports", prepare }).then(() => "written", (error) => error.code);
  const state = await readFile(path.join(root, ".prism/initiatives/reports/state.json"), "utf8").catch(() => null);
  assert.equal(outcome, "initiative_shipped", "the write after the ship must be refused");
  assert.equal(state, null, "the shipped initiative must get no coordination state");
});
