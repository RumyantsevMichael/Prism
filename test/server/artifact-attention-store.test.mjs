import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { browserRequest, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Attention's format findings and legacy marks in a project whose requirements are store artifacts in several scopes.

const OLD = "docs/requirements/old.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";
// The workspace scope's copy of OLD in the store's files.
const WORKSPACE_OLD = "artifacts/requirements/old.md";

// A nonconforming store file arrives as another machine's sync would bring it, since every write of a requirement through Prism is checked against its format.
async function storeFile(place, location, text) {
  await mkdir(path.dirname(path.join(place.store, location)), { recursive: true });
  await writeFile(path.join(place.store, location), text);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function served(context) {
  const { place, root, call } = await storeProject(context, { ...CONFORMING, [OLD]: BROKEN });
  // api's first tool call moves its checkout artifacts into scope api before the workspace holds the same path, which would keep them in the checkout.
  await storeRead(call, PATHS.requirements);
  // The workspace scope holds another nonconforming copy at the same path, which a checkout that does not see api's scope reads.
  const web = await otherCheckout(context, place);
  await storeFile(place, WORKSPACE_OLD, `${BROKEN}\nThe server logs.\n`);
  const review = await reviewBrowser(context, root);
  const attention = async () => (await browserRequest(review, "/api/entity?ref=attention")).body.data;
  const listing = (target) => browserRequest(review, `/api/actions?target=${encodeURIComponent(target)}`);
  const apply = (body) => browserRequest(review, "/api/actions/apply", { method: "POST", body });
  return { place, root, call, web, attention, listing, apply };
}

test("clauses 17, 55: Attention lists each nonconforming store artifact by path and scope, one entry per scope that holds it", async (context) => {
  const { attention } = await served(context);
  const [requirements] = (await attention()).formats;
  assert.equal(requirements.count, 2);
  assert.deepEqual(requirements.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[OLD, "api"], [OLD, "workspace"]]);
  assert.ok(requirements.artifacts.every((artifact) => artifact.findings.some((finding) => finding.rule === "requirements.header")));
});

test("clause 55: a legacy mark covers the store copy it names by scope label and path, and check_artifacts names it on that copy only", async (context) => {
  const { call, attention, listing, apply } = await served(context);
  const listed = await listing("artifacts:requirements");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const mark = listed.body.actions.find((action) => action.id === "artifacts.mark-legacy");
  assert.ok(mark, "the type lists the mark action");
  assert.deepEqual(mark.fields.find((field) => field.name === "paths").options.map((option) => option.value), [`api:${OLD}`, `workspace:${OLD}`]);
  const applied = await apply({ action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths: [`workspace:${OLD}`] }, revision: mark.revision, confirmed: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const [requirements] = (await attention()).formats;
  assert.deepEqual(requirements.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[OLD, "api"]]);
  assert.deepEqual([requirements.legacy.count, requirements.legacy.sets[0].count], [1, 1]);
  const checked = (await call("check_artifacts", { paths: [{ path: OLD, scope: "workspace" }, { path: OLD, scope: "repository" }] })).value;
  const byScope = Object.fromEntries(checked.artifacts.map((entry) => [labelOf(entry), entry.legacy]));
  assert.match(byScope.workspace?.set ?? "", /^legacy-[0-9a-f]+$/);
  assert.equal(byScope.api, null);
});

test("clause 55: a legacy mark keeps covering a store copy after an update_artifact change, and an option names no copy that conforms", async (context) => {
  const { place, web, attention, listing, apply } = await served(context);
  const mark = (await listing("artifacts:requirements")).body.actions.find((action) => action.id === "artifacts.mark-legacy");
  assert.equal((await apply({ action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths: [`workspace:${OLD}`] }, revision: mark.revision, confirmed: true })).status, 200);
  const current = await storeRead(web.call, OLD);
  const changed = { version: await storeFile(place, WORKSPACE_OLD, `${current.content}A later line.\n`) };
  assert.equal((await attention()).formats[0].legacy.count, 1, "a changed copy stays covered");
  await storeWrite(web.call, OLD, REQUIREMENT, { expectedVersion: changed.version });
  const fixed = (await attention()).formats[0];
  assert.deepEqual([fixed.count, fixed.legacy.count], [1, 0], "a conforming copy is neither counted nor legacy");
  const refused = await apply({ action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths: [`workspace:${OLD}`] }, revision: (await listing("artifacts:requirements")).body.actions.find((action) => action.id === "artifacts.mark-legacy").revision, confirmed: true });
  assert.deepEqual([refused.status, refused.body.code], [400, "invalid_input"]);
});
