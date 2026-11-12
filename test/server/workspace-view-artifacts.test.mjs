import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { eventually, git, isolateGit, networkStore, ok, place, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { launch, playwright, settle, skip } from "./fixtures/kit-browser.mjs";

// Contract clauses 34-40 of the workspace-view design: the app shows every scope's artifacts together, by store location, with a filter and resolved links.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const BILLING = "# Billing\n\nSee [the plan](../plans/reports/slice.md), [the ledger](../ADRs/ledger.md), [shared](shared.md), [gone](missing.md), and [the site](https://example.com/x.md).\n";

// One store with artifacts in the workspace scope, two repository scopes, and a component scope; the app has the api checkout registered.
async function combined(context, { register = true } = {}) {
  const where = await place(context);
  const store = await networkStore(where);
  const apiRoot = await storeCheckout(context, where, "api", store.url, { components: ["- billing: packages/billing"] });
  const webRoot = await storeCheckout(context, where, "web", store.url);
  const api = await server(context, where, apiRoot);
  const web = await server(context, where, webRoot);
  await writeArtifact(api, "docs/requirements/shared.md", "# Shared\n");
  await writeArtifact(api, "docs/requirements/billing.md", BILLING, { scope: "repository" });
  await writeArtifact(api, "docs/plans/reports/slice.md", "# API reports\n", { scope: "repository" });
  await writeArtifact(api, "docs/ADRs/ledger.md", "# Ledger\n", { scope: "repository" });
  await writeArtifact(api, "docs/requirements/totals.md", "# Totals\n", { scope: "component", component: "billing" });
  await writeArtifact(web, "docs/plans/reports/slice.md", "# Web reports\n", { scope: "repository" });
  const prism = await startApp(context, where);
  if (register) await prism.register(apiRoot);
  return { where, store, api, web, apiRoot, prism, id: workspaceId(store.identity) };
}

const STORED = [
  "store:repositories/api/adrs/ledger.md",
  "store:repositories/api/components/billing/requirements/totals.md",
  "store:repositories/api/plans/reports/slice.md",
  "store:repositories/api/requirements/billing.md",
  "store:repositories/web/plans/reports/slice.md",
  "store:requirements/shared.md"
];

test("clause 34: a workspace lists every scope's artifacts by store location, each with its scope", async (context) => {
  const { prism, id } = await combined(context);
  const index = (await prism.get(`/w/${id}/api/index`)).json;
  assert.deepEqual(index.artifacts.filter((ref) => ref.startsWith("store:")).sort(), STORED);
  assert.deepEqual(index.artifacts.filter((ref) => /^docs\/(requirements|plans|ADRs)\//.test(ref)), [], "no store artifact is listed by a checkout path");
  assert.equal(index.artifactScopes["store:repositories/web/plans/reports/slice.md"], "web");
  assert.equal(index.artifactScopes["store:repositories/api/components/billing/requirements/totals.md"], "api/billing");
  assert.deepEqual(index.scopes, [
    { kind: "workspace", label: "workspace", repository: null, component: null, artifacts: 1 },
    { kind: "repository", label: "api", repository: "api", component: null, artifacts: 3 },
    { kind: "component", label: "api/billing", repository: "api", component: "billing", artifacts: 1 },
    { kind: "repository", label: "web", repository: "web", component: null, artifacts: 1 }
  ]);
});

test("clause 35: a scope filter narrows the artifacts and keeps the workspace", async (context) => {
  const { prism, id } = await combined(context);
  const index = (await prism.get(`/w/${id}/api/index?scopes=web,workspace,mobile`)).json;
  assert.deepEqual(index.artifacts.filter((ref) => ref.startsWith("store:")).sort(), ["store:repositories/web/plans/reports/slice.md", "store:requirements/shared.md"]);
  assert.deepEqual(index.scopeFilter, ["web", "workspace"]);
  assert.deepEqual(index.unknownScopes, ["mobile"]);
  assert.equal(index.workspace.id, id);
});

test("clause 36: an artifact is read by its store identity, also in a workspace with no registered checkout", async (context) => {
  const { store, where, id } = await combined(context, { register: false });
  // Checkout servers push store writes only after the record-sync debounce, so the add waits until the remote holds the artifact it reads.
  const pushed = () => { try { git(store.bare, "cat-file", "-e", "main:artifacts/repositories/web/plans/reports/slice.md"); return true; } catch { return false; } };
  await eventually(pushed, 15000, "the web artifact reaching the remote");
  const prism = await startApp(context, { ...where, app: `${where.app}-b` });
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const read = await prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent("store:repositories/web/plans/reports/slice.md")}`);
  assert.equal(read.status, 200, read.body);
  assert.equal(read.json.ref, "store:repositories/web/plans/reports/slice.md");
  assert.equal(read.json.location, "repositories/web/plans/reports/slice.md");
  assert.equal(read.json.scope.label, "web");
  assert.equal(read.json.content, "# Web reports\n");
  assert.equal((await prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent("store:requirements/none.md")}`)).status, 404);
});

test("clause 37: relative links resolve against the store location, then through checkout paths, and unresolved ones are counted", async (context) => {
  const { prism, id } = await combined(context);
  const read = (await prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent("store:repositories/api/requirements/billing.md")}`)).json;
  assert.deepEqual(read.links, [
    { line: 3, href: "../plans/reports/slice.md", target: "store:repositories/api/plans/reports/slice.md", resolved: true },
    { line: 3, href: "../ADRs/ledger.md", target: "store:repositories/api/adrs/ledger.md", resolved: true },
    { line: 3, href: "shared.md", target: "store:requirements/shared.md", resolved: true },
    { line: 3, href: "missing.md", target: null, resolved: false }
  ]);
  assert.equal(read.unresolvedLinks, 1);
});

test("clause 38: the page labels each artifact with its scope, offers the scope filter, and marks unresolved links", { skip }, async (context) => {
  const { prism, id } = await combined(context);
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=${encodeURIComponent("store:repositories/api/requirements/billing.md")}`);
  await settle(page);
  assert.ok(await page.locator("[data-scope-filter]").count() > 0, "the scope filter is shown");
  assert.ok((await page.locator("[data-scope-label]").allTextContents()).some((label) => label.includes("api")), "the artifact shows its scope label");
  const unresolved = page.locator('[data-link="unresolved"]');
  assert.equal(await unresolved.count(), 1);
  assert.match(await page.locator("body").innerText(), /link not found/);
  assert.ok(playwright);
});

test("clause 39: a store without artifacts says that the repositories keep them in their checkouts", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const root = await storeCheckout(context, where, "api", store.url);
  const prism = await startApp(context, where);
  await prism.register(root);
  const index = (await prism.get(`/w/${workspaceId(store.identity)}/api/index`)).json;
  assert.equal(index.notes.length, 1);
  assert.match(index.notes[0].message ?? index.notes[0], /api/);
  assert.match(index.notes[0].message ?? index.notes[0], /checkouts/);
});

test("clause 40: a comment on a store artifact from the workspace page targets its scope label and location", async (context) => {
  const { api, prism, id } = await combined(context);
  git(process.cwd(), "config", "--global", "user.name", "Ada Reviewer");
  git(process.cwd(), "config", "--global", "user.email", "ada@example.invalid");
  context.after(() => { git(process.cwd(), "config", "--global", "--unset", "user.name"); git(process.cwd(), "config", "--global", "--unset", "user.email"); });
  await prism.grant();
  const target = "artifact:api:requirements/billing.md";
  const listed = await prism.get(`/w/${id}/api/actions?target=${encodeURIComponent(target)}`);
  assert.equal(listed.status, 200, listed.body);
  const action = listed.json.actions.find((item) => item.id === "artifact.comment");
  const applied = await prism.post(`/w/${id}/api/actions/apply`, { action: "artifact.comment", target, input: { line: "1", text: "Looks right" }, revision: action.revision });
  assert.equal(applied.status, 200, applied.body);
  const read = ok(await api.call("get_artifact", { path: "docs/requirements/billing.md", scope: "repository" }));
  assert.deepEqual(read.comments.map((comment) => [comment.text, comment.author.name]), [["Looks right", "Ada Reviewer"]]);
});
