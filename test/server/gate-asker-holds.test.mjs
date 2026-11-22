import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { holdGates, readGateAsker } from "../../dist/server/workflow/gate-askers.mjs";
import { checkout, isolateGit, ok, requirementFile, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION } from "./fixtures/gate-askers.mjs";

// Each wait on a gate keeps a hold of its own, and an approval gate's private asker entry keeps the initiative the gate names.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("two waits on one gate: the first to end leaves the other's hold live", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-gate-holds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = { initiative: "demo", gate: "gate-0123abcd" };
  const first = holdGates(root, [key], { leaseMs: 60000 });
  await first.ready;
  const second = holdGates(root, [key], { leaseMs: 60000 });
  await second.ready;
  assert.equal((await readGateAsker(root, key)).held, true);
  await first.release();
  assert.equal((await readGateAsker(root, key)).held, true, "the second wait still holds the gate");
  await second.release();
  assert.equal((await readGateAsker(root, key)).held, false, "no wait holds the gate");
});

test("a lapsed hold of a wait that stopped renewing does not hold the gate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-gate-holds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = { gate: "approval-0123abcd" };
  const wait = holdGates(root, [key], { leaseMs: 60000 });
  await wait.ready;
  assert.equal((await readGateAsker(root, key, Date.now() + 61000)).held, false);
  await wait.release();
});

test("an approval gate's private asker entry keeps the initiative the gate names, and one naming none keeps null", async (t) => {
  const place = await workspace(t);
  const api = await checkout(place, "api");
  const prism = await server(t, place, api, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  await writeArtifact(prism, "docs/requirements/billing.md", requirementFile("Billing"));
  await writeArtifact(prism, "docs/requirements/invoices.md", requirementFile("Invoices"));
  const asked = ok(await prism.call("update_artifact", { operations: [
    { op: "ask_approval", path: "docs/requirements/billing.md", question: "Approve billing?", context: "Billing.", initiative: "billing-flow" },
    { op: "ask_approval", path: "docs/requirements/invoices.md", question: "Approve invoices?", context: "Invoices." }
  ] }));
  const [named, unnamed] = asked.artifacts.map((entry) => entry.gate);
  const kept = JSON.parse(await readFile(path.join(place.app, "gate-asker-sessions.json"), "utf8")).gates;
  assert.equal(kept[`approval:${named}`].initiative, "billing-flow");
  assert.equal(kept[`approval:${unnamed}`].initiative, null);
});
