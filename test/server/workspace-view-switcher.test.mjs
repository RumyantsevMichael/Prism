import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { alias, checkout, git, isolateGit, networkStore, ok, place, projectWorkspaceId, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";

// Contract clauses 4-13 and 61 of the workspace-view design: the app lists and opens workspaces, one per store, and old checkout URLs move to them.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));

async function plainProject(where, name) {
  const root = path.join(where.parent, name);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "notes.md"), "# Notes\n");
  git(root, "init", "-q", "-b", "main");
  return root;
}

// Two checkouts of two repositories naming one store by two spellings, and one project without a store, registered with a started app.
async function threeCheckouts(context) {
  const where = await place(context);
  const store = await networkStore(where);
  const scp = `git@example.invalid:${store.owner}/store.git`;
  alias(scp, store.bare);
  const api = await storeCheckout(context, where, "api", store.url);
  const web = await storeCheckout(context, where, "web", scp);
  const notes = await plainProject(where, "notes");
  const prism = await startApp(context, where);
  const leases = { api: await prism.register(api), web: await prism.register(web), notes: await prism.register(notes) };
  return { where, store, scp, api, web, notes, prism, leases };
}

test("clauses 4, 5, and 6: checkouts that name one store are one workspace, and a project without a store is a workspace of its own", async (context) => {
  const { store, scp, api, web, notes, prism } = await threeCheckouts(context);
  const listed = await prism.workspaces();
  assert.equal(listed.length, 2);
  const shared = listed.find((entry) => entry.kind === "store");
  const alone = listed.find((entry) => entry.kind === "project");
  assert.equal(shared.id, workspaceId(store.identity));
  assert.equal(alone.id, projectWorkspaceId(notes));
  assert.deepEqual(Object.keys(shared).sort(), ["added", "checkouts", "gates", "id", "kind", "live", "name", "repositories", "store", "url"]);
  assert.equal(shared.added, false);
  assert.equal(shared.live, true);
  assert.equal(shared.store.identity, store.identity);
  assert.deepEqual(shared.store.urls, [store.url, scp]);
  assert.deepEqual(shared.repositories, [{ name: "api", checkouts: [api] }, { name: "web", checkouts: [web] }]);
  assert.deepEqual([...shared.checkouts].sort(), [api, web].sort());
  assert.equal(shared.url, `${prism.viewer}/w/${shared.id}/`);
  assert.equal(alone.store, null);
  assert.deepEqual(alone.checkouts, [notes]);
});

test("clause 6: no workspace entry offers a checkout, repository, or component as a place to open", async (context) => {
  const { prism } = await threeCheckouts(context);
  for (const entry of await prism.workspaces()) {
    const urls = JSON.stringify(entry).match(/https?:\/\/[^"]+/g) ?? [];
    assert.deepEqual(urls.filter((url) => url !== entry.url && !entry.store?.urls.includes(url)), [], `${entry.name} names no other URL`);
    assert.doesNotMatch(JSON.stringify(entry), /\/p\/[0-9a-f]{16}/);
  }
});

test("clause 7: a workspace is named by the store's workspace name, else by the store, and a project by its folder", async (context) => {
  const { where, api, prism } = await threeCheckouts(context);
  let listed = await prism.workspaces();
  assert.equal(listed.find((entry) => entry.kind === "store").name, "store");
  assert.equal(listed.find((entry) => entry.kind === "project").name, "notes");
  const prismServer = await server(context, where, api);
  const roadmap = ok(await prismServer.call("get_roadmap", {}));
  ok(await prismServer.call("update_roadmap", { expectedRevision: roadmap.revision ?? null, operations: [{ op: "set_workspace_name", name: "Platform team" }] }));
  listed = await prism.workspaces();
  assert.equal(listed.find((entry) => entry.kind === "store").name, "Platform team");
});

test("clause 8: a workspace's page and API answer under its id, and an unknown id answers 404", async (context) => {
  const { store, prism } = await threeCheckouts(context);
  const id = workspaceId(store.identity);
  const page = await prism.get(`/w/${id}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<prism-rail id="rail" label="Places"/);
  const index = await prism.get(`/w/${id}/api/index`);
  assert.equal(index.status, 200, index.body);
  assert.equal(index.json.workspace.id, id);
  assert.equal((await prism.get("/w/0123456789abcdef/api/index")).status, 404);
});

test("clause 9: a checkout's URL redirects to its workspace, naming a store artifact by its store location", async (context) => {
  const { where, store, api, prism, leases } = await threeCheckouts(context);
  await writeArtifact(await server(context, where, api), "docs/plans/reports/slice.md", "# Reports\n");
  const redirected = await prism.get(`/p/${leases.api.projectId}/review?artifact=${encodeURIComponent("docs/plans/reports/slice.md")}&mode=diff`);
  assert.equal(redirected.status, 308);
  const location = new URL(redirected.headers.location, prism.viewer);
  assert.equal(location.pathname, `${new URL(prism.viewer).pathname}/w/${workspaceId(store.identity)}/review`);
  assert.equal(location.searchParams.get("artifact"), "store:plans/reports/slice.md");
  assert.equal(location.searchParams.get("mode"), "diff");
  const source = await prism.get(`/p/${leases.api.projectId}/review?artifact=${encodeURIComponent(".prism/workflow.md")}`);
  assert.equal(new URL(source.headers.location, prism.viewer).searchParams.get("artifact"), ".prism/workflow.md");
});

test("clause 10: the app's root opens the workspace used most recently, or the add-a-workspace page when there is none", async (context) => {
  const where = await place(context);
  const empty = await startApp(context, where);
  const page = await empty.get("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<prism-rail id="rail" label="Places"/);
  const root = await plainProject(where, "notes");
  await empty.register(root);
  const redirected = await empty.get("/");
  assert.equal(redirected.status, 302);
  assert.match(redirected.headers.location, new RegExp(`/w/${projectWorkspaceId(root)}/$`));
});

test("clause 11: a present without a checkout grants a write session for the app's root, and prism review --workspaces opens it", async (context) => {
  const where = await place(context);
  const prism = await startApp(context, where);
  const headers = await prism.grant();
  assert.match(headers["X-Prism-Write"], /^[A-Za-z0-9_-]+$/);
  const output = await new Promise((resolve) => execFile(process.execPath, [path.join(REPOSITORY, "bin", "prism"), "review", "--workspaces"], { cwd: where.parent, env: isolatedEnv({ PRISM_REVIEW_APP_DIR: where.app, HOME: environment, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }) }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.stdout.includes(`${prism.viewer}/`), output.stdout);
  assert.doesNotMatch(output.stdout, /\/[pw]\/[0-9a-f]{16}/);
});

test("clause 12: a session tab that names a store artifact by its checkout path is kept as its store identity", async (context) => {
  const { where, store, api, prism } = await threeCheckouts(context);
  await writeArtifact(await server(context, where, api), "docs/plans/reports/slice.md", "# Reports\n");
  const id = workspaceId(store.identity);
  const updated = await prism.put(`/w/${id}/api/session`, { openTabs: ["docs/plans/reports/slice.md"], activeTab: "docs/plans/reports/slice.md" });
  assert.equal(updated.status, 200, updated.body);
  const session = (await prism.get(`/w/${id}/api/session`)).json;
  assert.deepEqual(session.openTabs, ["store:plans/reports/slice.md"]);
  assert.equal(session.activeTab, "store:plans/reports/slice.md");
});

test("clause 13: the workflow skill defines a workspace as one store and the review app's unit", async () => {
  const skill = await readFile(path.join(REPOSITORY, "skills", "workflow", "SKILL.md"), "utf8");
  const row = skill.split("\n").find((line) => line.startsWith("| Workspace |"));
  assert.ok(row, "the Common terms define Workspace");
  assert.match(row, /one record store/);
  assert.match(row, /review app's unit/);
  assert.match(row, /workspace of one/);
});

test("clause 61: the workspace page keeps the places navigation and the kit guard reports nothing", async (context) => {
  const { store, prism } = await threeCheckouts(context);
  const page = await prism.get(`/w/${workspaceId(store.identity)}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<prism-rail id="rail" label="Places"/);
  const guard = await new Promise((resolve) => execFile(process.execPath, [path.join(REPOSITORY, "scripts", "review-kit", "kit-guard.mjs")], { cwd: REPOSITORY }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  assert.equal(guard.code, 0, guard.stdout);
  assert.equal(guard.stdout.trim(), "");
});
