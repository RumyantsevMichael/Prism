import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listActionTargets } from "../../dist/server/workflow/actions.mjs";
import { knownComponents } from "../../dist/server/review/workspaces.mjs";

// A checkout folder whose workflow configuration names its repository and declares the given components.
async function checkoutOf(context, repository, components = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `prism-${repository}-`)));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  const declared = components.length ? `\n## Components\n${components.map(([name, folder]) => `- ${name}: ${folder}`).join("\n")}\n` : "";
  await writeFile(path.join(root, ".prism", "workflow.md"), `# Workflow config\n\n## Workspace\n- Repository: ${repository}\n${declared}`);
  return root;
}

test("a workspace knows each checkout's, clone's, and scope folder's components with every repository's root component", async (context) => {
  const api = await checkoutOf(context, "api", [["billing", "packages/billing"]]);
  const known = await knownComponents({
    checkouts: [{ root: api }],
    repositories: ["api", "docs", "web"],
    scopes: [{ kind: "workspace", label: "workspace" }, { kind: "repository", label: "web", repository: "web" }, { kind: "component", label: "web/pages", repository: "web", component: "pages" }],
    clones: async (repository) => repository === "docs" ? { components: [{ identity: "docs/site", folder: "site", branches: [] }], problems: [] } : null
  });
  assert.deepEqual(known, [
    { identity: "api/api", repository: "api", root: api },
    { identity: "api/billing", repository: "api", root: api },
    { identity: "docs/docs", repository: "docs", root: null },
    { identity: "docs/site", repository: "docs", root: null },
    { identity: "web/pages", repository: "web", root: null },
    { identity: "web/web", repository: "web", root: null }
  ]);
});

test("a workspace page's index targets are the components of every checkout here, by repository, and none without a checkout", async (context) => {
  const web = await checkoutOf(context, "web");
  const api = await checkoutOf(context, "api", [["billing", "packages/billing"]]);
  const other = await checkoutOf(context, "api");
  assert.deepEqual((await listActionTargets({ projectRoot: web, kind: "index", checkouts: [web, api, other] })).targets, ["index:api/api", "index:api/billing", "index:web/web"]);
  assert.deepEqual((await listActionTargets({ projectRoot: web, kind: "index", checkouts: [] })).targets, []);
  assert.deepEqual((await listActionTargets({ projectRoot: web, kind: "index" })).targets, ["index:web/web"]);
});
