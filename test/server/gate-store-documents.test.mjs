import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, checkout, eventually, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// In a workspace with a record store, a gate names the requirements it attaches by title and kind, as it does in a project without one, and an approval names its document.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

test("a gate in a store workspace names an attached requirements file as requirements, not as source", async (t) => {
  const place = await workspace(t);
  const api = await checkout(place, "api");
  const prism = await server(t, place, api);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  ok(await prism.call("update_coordination_state", { initiative: "billing", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Keep monthly invoices?", context: "Billing drafts both.", options: [{ id: "keep", label: "Keep", consequence: "Invoices stay monthly." }, { id: "drop", label: "Drop", consequence: "Invoices go weekly." }], recommended: { option: "keep", reason: "Customers expect it." }, artifacts: [FILE] }] } }));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] }));
  const approval = asked.artifacts[0].gate;
  const review = await reviewBrowser(t, api);
  let items;
  await eventually(async () => (items = (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou).length >= 2, 30000, "both gates reach Attention");
  const decision = items.find((entry) => entry.question === "Keep monthly invoices?");
  assert.equal(decision.artifacts[0].available, true);
  assert.equal(decision.artifacts[0].record?.kind, "requirements", "the attached file is named as requirements");
  const asking = items.find((entry) => entry.id === approval);
  assert.equal(asking.artifact.kind, "requirements");
  assert.equal(asking.artifact.title, "Billing");
});
