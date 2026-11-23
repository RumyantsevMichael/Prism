import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, checkout, eventually, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION, MACHINE, filesBelow } from "./fixtures/gate-askers.mjs";

// Requirements: docs/requirements/late-gate-answers.md §1, §2, §3.
// Contract: docs/plans/late-gate-answers/slice.md clauses 1, 2, 3, and 6.
// A requirement's approval gate records its asker as an initiative's gate does, and the record store never holds the session id.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

test("clauses 1, 2, 3, 6: an approval gate names its asker on its card, and the store keeps no session id", async (t) => {
  const place = await workspace(t);
  const api = await checkout(place, "api");
  const prism = await server(t, place, api, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] }));
  const gate = asked.artifacts[0].gate;
  // The review page reads this machine's private asker file from the same review app folder as the server, as clause 6 has it.
  const saved = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = place.app;
  t.after(() => { if (saved === undefined) delete process.env.PRISM_REVIEW_APP_DIR; else process.env.PRISM_REVIEW_APP_DIR = saved; });
  const review = await reviewBrowser(t, api);
  let item;
  await eventually(async () => (item = (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.find((entry) => entry.id === gate))?.asker !== undefined, 30000, "the approval card names its asker");
  assert.deepEqual([item.asker.known, item.asker.harness, item.asker.machine, item.asker.checkout, item.asker.thisMachine], [true, "Claude Code", MACHINE, "api/main", true]);
  assert.deepEqual(filesBelow(place.store).filter((entry) => entry.text.includes(CLAUDE_SESSION)).map((entry) => entry.file), [], "no store file holds the session id");
  assert.deepEqual(filesBelow(api).filter((entry) => entry.text.includes(CLAUDE_SESSION)).map((entry) => entry.file), [], "no checkout file holds the session id");
});
