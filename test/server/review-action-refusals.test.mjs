import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { INITIATIVE, actionOf, actionProject, apply, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";
import { runOptionsFixture } from "./fixtures/run-options-hosts.mjs";

const indexer = { status: async () => ({ state: "ready" }), rebuild: async () => {} };
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

// Every entry under the project's .prism folder, so a test can show that a refusal left the record store as it was.
async function entries(root) {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(path.join(root, ".prism"));
  return found.sort();
}

test("models mode host defaults stores host defaults whatever the text fields hold", { skip: posixOnly }, async (t) => {
  const { root, env } = await runOptionsFixture(t);
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const { listActions, applyAction } = await import("../../dist/server/workflow/actions.mjs");
  const target = `initiative:${INITIATIVE}`;
  const revisionOf = async () => (await listActions({ projectRoot: root, target, indexer, env })).actions.find((action) => action.id === "initiative.models").revision;
  const typed = (model) => ({ model, effort: null, typed: true });
  await applyAction({ projectRoot: root, target, action: "initiative.models", input: { host: "codex", designImplementation: typed("d") }, revision: await revisionOf(), indexer, env });
  await applyAction({ projectRoot: root, target, action: "initiative.models", input: { host: "claude-code", designImplementation: typed("d"), codeReview: typed("r"), securityReview: typed("s") }, revision: await revisionOf(), indexer, env });
  // Every choice of a host back at the host default stores nothing for that host, and the other host keeps its choices.
  const result = await applyAction({ projectRoot: root, target, action: "initiative.models", input: { host: "claude-code", provider: null, coordinator: null, designImplementation: { model: null, effort: null, typed: false } }, revision: await revisionOf(), indexer, env });
  assert.deepEqual(result.applied.after["claude-code"].designImplementation, { model: null, effort: null, typed: false });
  assert.deepEqual((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.settings.models, { codex: { designImplementation: { model: "d", typed: true } } });
  const long = "x".repeat(300);
  await assert.rejects(applyAction({ projectRoot: root, target, action: "initiative.models", input: { host: "claude-code", designImplementation: typed(long) }, revision: await revisionOf(), indexer, env }), (error) => error.code === "invalid_input" && error.field === "designImplementation");
});

test("a refused apply on an initiative without coordination state leaves the record store unchanged", async (t) => {
  const { root } = await actionProject(t, { gates: false });
  const { listActions, applyAction } = await import("../../dist/server/workflow/actions.mjs");
  const target = "initiative:search";
  const before = await entries(root);
  assert.ok(!before.includes(path.join(".prism", "initiatives", "search")));
  const autonomy = (await listActions({ projectRoot: root, target, indexer })).actions.find((action) => action.id === "initiative.autonomy");
  const refusals = [
    [{ input: { value: "everything" }, revision: autonomy.revision }, "invalid_input"],
    [{ input: { value: "broad" }, revision: "f".repeat(64) }, "stale_revision"],
    [{ input: { value: "full" }, revision: autonomy.revision }, "confirmation_required"]
  ];
  for (const [request, code] of refusals) {
    await assert.rejects(applyAction({ projectRoot: root, target, action: "initiative.autonomy", indexer, ...request }), (error) => error.code === code);
    assert.deepEqual(await entries(root), before);
  }
  const unchanged = await applyAction({ projectRoot: root, target, action: "initiative.autonomy", input: { value: "conservative" }, revision: autonomy.revision, indexer });
  assert.equal(unchanged.applied, null);
  assert.deepEqual(await entries(root), before);
});

test("the apply route accepts only the application/json media type", async (t) => {
  const { root } = await actionProject(t, { gates: false });
  const { review, base, opened } = await startActionReview(t, root);
  const headers = await pageSession(review, opened);
  const target = `initiative:${INITIATIVE}`;
  const continuation = actionOf(await listing(base, target, headers), "initiative.continuation");
  const body = JSON.stringify({ action: "initiative.continuation", target, input: { value: "stepwise" }, revision: continuation.revision });
  for (const type of ["application/json-seq", "application/jsonx", "application/json-patch+json"]) {
    const refused = await fetch(`${base}/api/actions/apply`, { method: "POST", headers: { ...headers, "Content-Type": type }, body });
    assert.deepEqual([type, refused.status, (await refused.json()).code], [type, 403, "origin_refused"]);
  }
  const accepted = await apply(base, body, { ...headers, "Content-Type": "Application/JSON; charset=utf-8" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.applied.after, "stepwise");
});
