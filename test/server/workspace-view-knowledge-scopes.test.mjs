import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { adrFile, git, isolateGit, networkStore, place, pushToRemote, requirementFile, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { launch, settle, skip } from "./fixtures/kit-browser.mjs";
import { answerGate, ok, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// The Knowledge place of a workspace lists every scope's requirements, decisions, and glossary terms, and the scope chips narrow every count and list at once.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

// One store with requirements in the workspace, api, and web scopes, a decision in api, and glossaries in the api and workspace scopes that both define Ledger; web writes the workspace one, since api already sees its own.
async function scoped(context, { brokenWorkspaceGlossary = false } = {}) {
  const where = await place(context);
  const store = await networkStore(where);
  const apiRoot = await storeCheckout(context, where, "api", store.url);
  const webRoot = await storeCheckout(context, where, "web", store.url);
  const api = await server(context, where, apiRoot);
  const web = await server(context, where, webRoot);
  await writeArtifact(api, "docs/requirements/shared.md", requirementFile("Shared"));
  await writeArtifact(api, "docs/requirements/billing.md", requirementFile("Billing"), { scope: "repository" });
  await writeArtifact(web, "docs/requirements/billing.md", requirementFile("Web billing"), { scope: "repository" });
  await writeArtifact(api, "docs/ADRs/ledger.md", adrFile("Ledger"), { scope: "repository" });
  // A glossary term cites a decided source, so the cited requirements are approved first.
  // The review browser of the checkout runs in this process, so it resolves the store's clone in this machine's application folder.
  process.env.PRISM_REVIEW_APP_DIR = where.app;
  git(apiRoot, "config", "user.name", "Ada Reviewer");
  const review = await reviewBrowser(context, apiRoot);
  for (const [file, scope] of [["docs/requirements/billing.md", "repository"], ["docs/requirements/shared.md", "workspace"]]) {
    const gate = ok(await api.call("update_artifact", { operations: [{ op: "ask_approval", path: file, scope, context: "The glossary cites it." }] })).artifacts[0].gate;
    const answered = await answerGate(review, { id: gate, choice: "approve" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  }
  await writeArtifact(api, "docs/Glossary.md", "# Glossary\n\nTerms of the api.\n\n<a id=\"ledger\"></a>\n## Ledger\n\nThe api's charge table.\n\nSource: [billing.md§1](requirements/billing.md#1)\n", { scope: "repository" });
  await writeArtifact(web, "docs/Glossary.md", "# Glossary\n\nTerms of every repository.\n\n<a id=\"ledger\"></a>\n## Ledger\n\nThe record of every charge.\n\nSource: [shared.md§1](requirements/shared.md#1)\n\n<a id=\"workspace\"></a>\n## Workspace\n\nEvery repository together.\n\nSource: [shared.md§1](requirements/shared.md#1)\n");
  // A workspace glossary that another machine pushed without the sources its terms need breaks the glossary format, since every write through Prism is checked.
  if (brokenWorkspaceGlossary) await pushToRemote(where, store.bare, { "artifacts/glossary.md": "# Glossary\n\nTerms of every repository.\n\n<a id=\"ledger\"></a>\n## Ledger\n\nThe record of every charge.\n" });
  const prism = await startApp(context, where);
  await prism.register(apiRoot);
  return { prism, id: workspaceId(store.identity) };
}

const entity = async (prism, id, ref) => (await prism.get(`/w/${id}/api/entity?ref=${encodeURIComponent(ref)}`)).json.data;

test("a workspace's requirements and decisions list every scope's files by store location, with each scope's count", async (context) => {
  const { prism, id } = await scoped(context);
  const requirements = await entity(prism, id, "requirements");
  assert.deepEqual(requirements.entries.map(({ path, scope, title }) => [path, scope, title]).sort(), [
    ["store:repositories/api/requirements/billing.md", "api", "Billing"],
    ["store:repositories/web/requirements/billing.md", "web", "Web billing"],
    ["store:requirements/shared.md", "workspace", "Shared"]
  ]);
  assert.deepEqual(requirements.byScope, { api: 1, web: 1, workspace: 1 });
  const decisions = await entity(prism, id, "decisions");
  assert.deepEqual(decisions.entries.map(({ path, scope }) => [path, scope]), [["store:repositories/api/adrs/ledger.md", "api"]]);
  const index = (await prism.get(`/w/${id}/api/index`)).json;
  assert.deepEqual(index.navigation.library.byScope.requirements, { api: 1, web: 1, workspace: 1 });
  assert.deepEqual(index.navigation.library.byScope.terms, { api: 1, workspace: 2 });
});

test("each scope keeps its own glossary, so a term two scopes define is listed in both", async (context) => {
  const { prism, id } = await scoped(context);
  const glossary = await entity(prism, id, "glossary");
  assert.equal(glossary.exists, true);
  assert.deepEqual(glossary.glossaries.map(({ ref, scope, terms }) => [ref, scope, terms.map((term) => term.term)]).sort(), [
    ["store:glossary.md", "workspace", ["Ledger", "Workspace"]],
    ["store:repositories/api/glossary.md", "api", ["Ledger"]]
  ]);
  assert.equal(glossary.glossaries.find((item) => item.scope === "api").terms[0].text, "The api's charge table.");
});

const table = (page) => page.locator("#artifact prism-lib-table.library-table");
const groupNames = (page) => table(page).locator(".prism-lib-group-name").evaluateAll((heads) => heads.map((head) => head.firstChild.textContent.trim()));
// The page sub, once it reads as the pattern says.
const subReads = (page, pattern) => page.locator("#artifact .artifact-header prism-page-sub").filter({ hasText: pattern }).waitFor({ timeout: 10000 });
const sub = (page) => page.locator("#artifact .artifact-header prism-page-sub").innerText();

test("the scope chips narrow the library, its count, and the sidebar, and Show all scopes brings every scope back", { skip, timeout: 120000 }, async (context) => {
  const { prism, id } = await scoped(context);
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=requirements&place=knowledge`);
  await settle(page);
  await table(page).waitFor({ timeout: 10000 });
  assert.equal(await sub(page), "3 requirements files in 3 scopes: what the product must do, and which slices build each requirement.");
  assert.deepEqual(await groupNames(page), ["workspace", "api", "web"], "the page groups by scope when the workspace has more than one");
  assert.equal(await table(page).locator("[data-scope-label]").count(), 0, "rows grouped by scope carry no scope chip");
  assert.doesNotMatch(await page.locator("#nav").innerText(), /^Store$/m, "the sidebar has no store tree");
  const chip = (label) => page.locator("[data-scope-filter] prism-chip").filter({ hasText: new RegExp(`^${label}\\s*\\d*$`) });
  await chip("web").click();
  await subReads(page, /^1 of 3 requirements files/);
  assert.match(await page.locator("[data-library-narrowed]").innerText(), /^Narrowed to web\. Show all scopes$/);
  assert.deepEqual(await groupNames(page), ["web"]);
  assert.match(await page.locator("#nav").innerText(), /Scopes · 1 of 3/, "the sidebar says how far it narrows");
  await chip("workspace").click();
  await subReads(page, /^2 of 3 requirements files/);
  assert.match(await page.locator("[data-library-narrowed]").innerText(), /^Narrowed to (web and workspace|workspace and web)\./);
  assert.deepEqual(await groupNames(page), ["workspace", "web"]);
  await page.locator("[data-show-all-scopes]").click();
  await settle(page);
  await subReads(page, /^3 requirements files in 3 scopes/);
  assert.equal(await page.locator("[data-library-narrowed]").count(), 0);
  assert.deepEqual(errors, []);
});

test("the glossary lists each scope's terms in one table and marks a term another scope also defines", { skip, timeout: 120000 }, async (context) => {
  const { prism, id } = await scoped(context);
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=glossary`);
  await settle(page);
  await table(page).waitFor({ timeout: 10000 });
  assert.deepEqual(await groupNames(page), ["workspace", "api"]);
  const rows = await table(page).locator("[data-library-row]").evaluateAll((items) => items.map((row) => row.innerText.replace(/\s+/g, " ").trim()));
  assert.equal(rows.length, 3);
  assert.ok(rows.filter((row) => row.startsWith("Ledger")).every((row) => /also defines it/.test(row)), "both definitions of Ledger name the other scope");
  assert.ok(!/also defines it/.test(rows.find((row) => row.startsWith("Workspace"))));
});

test("the glossary shows a banner with the findings of each scope's glossary that breaks its format, and counts it under the title", { skip, timeout: 120000 }, async (context) => {
  const { prism, id } = await scoped(context, { brokenWorkspaceGlossary: true });
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=glossary`);
  await settle(page);
  await table(page).waitFor({ timeout: 10000 });
  const banners = page.locator("#artifact prism-banner[data-format-mark]");
  await banners.first().waitFor({ timeout: 10000 });
  assert.equal(await banners.count(), 1, "only the workspace's glossary breaks its format");
  assert.equal(await banners.first().getAttribute("heading"), "The glossary of workspace breaks its format");
  assert.ok(await banners.first().locator(".format-finding").count() >= 1, "the banner lists what breaks");
  await subReads(page, /1 of 2 glossaries breaks its format/);
});
