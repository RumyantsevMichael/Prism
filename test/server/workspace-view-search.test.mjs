import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { isolateGit, networkStore, place, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";

// Contract clauses 58-60 of the workspace-view design: Knowledge searches every scope and names left-out components, and checkout actions need a checkout.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

// A store workspace of api, registered with the app and declaring billing, and web, whose checkout was removed from this machine and which holds a component scope pages.
async function searchable(context) {
  const where = await place(context);
  const store = await networkStore(where);
  const apiRoot = await storeCheckout(context, where, "api", store.url, { components: ["- billing: packages/billing"] });
  const webRoot = await storeCheckout(context, where, "web", store.url, { components: ["- pages: packages/pages"] });
  await writeArtifact(await server(context, where, apiRoot), "docs/requirements/billing.md", "# Billing totals\n", { scope: "repository" });
  const web = await server(context, where, webRoot);
  await writeArtifact(web, "docs/requirements/invoices.md", "# Billing invoices\n", { scope: "repository" });
  await writeArtifact(web, "docs/requirements/screens.md", "# Billing screens\n", { scope: "component", component: "pages" });
  await writeArtifact(web, "docs/requirements/shared.md", "# Shared billing terms\n");
  // web's checkout leaves this machine, so its entry in the machine's checkout list no longer counts.
  await web.close();
  await rm(webRoot, { recursive: true, force: true });
  const prism = await startApp(context, where);
  await prism.register(apiRoot);
  return { prism, id: workspaceId(store.identity) };
}

test("clause 58: Knowledge search covers every scope's artifacts and names each component it left out", async (context) => {
  const { prism, id } = await searchable(context);
  const found = await prism.get(`/w/${id}/api/search?q=billing`);
  assert.equal(found.status, 200, found.body);
  assert.equal(found.json.query, "billing");
  assert.deepEqual(found.json.results.map((result) => [result.ref, result.scope.label]).sort(), [
    ["store:repositories/api/requirements/billing.md", "api"],
    ["store:repositories/web/components/pages/requirements/screens.md", "web/pages"],
    ["store:repositories/web/requirements/invoices.md", "web"],
    ["store:requirements/shared.md", "workspace"]
  ]);
  assert.deepEqual(found.json.code, []);
  assert.ok(found.json.results.every((result) => Array.isArray(result.matches) && result.matches.length > 0));
});

test("clause 59: the left-out components are every component the workspace knows, with the reason each was left out", async (context) => {
  const { prism, id } = await searchable(context);
  const found = (await prism.get(`/w/${id}/api/search?q=billing`)).json;
  assert.deepEqual(found.leftOut, [
    { component: "api/api", reason: "no_index" },
    { component: "api/billing", reason: "no_index" },
    { component: "web/pages", reason: "no_checkout" },
    { component: "web/web", reason: "no_checkout" }
  ]);
});

test("clause 60: an index rebuild is offered only for repositories with a checkout on this machine", async (context) => {
  const { prism, id } = await searchable(context);
  const targets = await prism.get(`/w/${id}/api/actions/targets?kind=index`);
  assert.equal(targets.status, 200, targets.body);
  assert.deepEqual(targets.json.targets, ["index:api/billing"]);
  const refused = await prism.get(`/w/${id}/api/actions?target=${encodeURIComponent("index:web/pages")}`);
  assert.equal(refused.json?.code, "unknown_target", refused.body);
});
