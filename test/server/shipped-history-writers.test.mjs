import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveSliceChangeMap } from "../../dist/server/conservation/derived-change-map.mjs";
import { refuseShipped } from "../../dist/server/workflow/shipped-history.mjs";
import { answerUserGate, recordPersonAction } from "../../dist/server/workflow/state.mjs";

// The writers outside the MCP tools, a review browser action, a browser answer, and a derived change map, also leave a shipped initiative's records as they are.
const AT = "2026-11-03T23:35:20.345Z";

async function shippedRoot(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-writers-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n- Roadmap: docs/roadmap.md\n");
  const entry = (id, decision) => ({ id, title: `Title ${id}`, intent: `Intent ${id}.`, band: "Now", requirements: ["docs/requirements/reports.md#1"], requires: [], decision });
  const roadmap = { schemaVersion: 1, serves: "", initiatives: [entry("reports", { kind: "shipped", at: AT, actor: "orchestrator" }), entry("open", null)], openQuestions: [], history: [] };
  await writeFile(path.join(root, ".prism/roadmap.json"), `${JSON.stringify(roadmap, null, 2)}\n`);
  return root;
}

const shippedRefusal = (error) => error.code === "initiative_shipped" && error.initiative === "reports" && error.shippedAt === AT;

test("refuseShipped refuses a shipped initiative and returns for one that has not shipped", async (context) => {
  const root = await shippedRoot(context);
  await assert.rejects(refuseShipped(root, "reports"), shippedRefusal);
  await refuseShipped(root, "open");
  await refuseShipped(root, "unknown");
});

test("a review browser action that would change a shipped initiative's state is refused and writes nothing", async (context) => {
  const root = await shippedRoot(context);
  const before = await readdir(path.join(root, ".prism"));
  const entry = { id: "0123456789abcdef0123456789abcdef", action: "initiative.autonomy", target: "initiative:reports", before: "conservative", after: "broad", at: new Date().toISOString(), by: "person", via: "review-app" };
  await assert.rejects(recordPersonAction({ projectRoot: root, initiative: "reports", prepare: async () => ({ entry, setting: { name: "autonomy", value: "broad" } }) }), shippedRefusal);
  const unchanged = await recordPersonAction({ projectRoot: root, initiative: "reports", prepare: async () => null });
  assert.equal(unchanged.entry, null, "an action that changes nothing still answers");
  await assert.rejects(answerUserGate({ projectRoot: root, initiative: "reports", id: "g1", choice: "keep" }), shippedRefusal);
  assert.deepEqual(await readdir(path.join(root, ".prism")), before);
});

test("a shipped initiative's slice gets no derived change map", async (context) => {
  const root = await shippedRoot(context);
  const result = await deriveSliceChangeMap({ projectRoot: root, initiative: "reports", slice: "download" });
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /shipped/);
});
