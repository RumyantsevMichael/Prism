import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, artifactConfig, bareRemote, blobOf, commitFiles, eventually, exists, git, isolateGit, networkStore, ok, place, server, sha16, startApp, storeCheckout, workspaceId } from "./fixtures/workspace-view.mjs";
import { repository } from "./fixtures/repository-checkouts.mjs";

// Contract clauses 41-50 of the workspace-view design: code-repository content of every pushed branch, from blobless clones Prism keeps.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TOTAL = "export const total = (items) => items.reduce((sum, item) => sum + item, 0);\n";
const FEATURE = "Feature: Billing\n  Scenario: Totals\n";

// A store workspace of the repository api, whose code remote holds main and feature-x, and of web, whose code remote cannot be reached.
async function codeWorkspace(context, options = {}) {
  const where = await place(context);
  const store = await networkStore(where);
  const code = await bareRemote(where.parent, "api-code.git", {
    files: { ".prism/workflow.md": "## Components\n- billing: packages/billing\n", "packages/billing/total.js": TOTAL, "docs/Features/billing.feature": FEATURE, ".env": "TOKEN=secret\n" },
    branches: { "feature-x": { ".prism/workflow.md": "## Components\n- billing: packages/billing\n- web: packages/web\n", "packages/web/page.js": "export const page = 1;\n" } }
  });
  alias("https://github.com/acme/api.git", code);
  alias("https://github.com/acme/web.git", path.join(where.parent, "missing.git"));
  await storeCheckout(context, where, "api", store.url);
  await storeCheckout(context, where, "web", store.url);
  const prism = await startApp(context, where, { workspaceFetchMs: 300, ...options });
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  const clone = path.join(where.app, "code", `${sha16("github.com/acme/api")}.git`);
  return { where, store, code, prism, id, clone };
}

const enable = (prism, id, repository, enabled = true) => prism.put(`/w/${id}/api/code/${repository}`, { enabled });
const present = (clone, object) => git(clone, "cat-file", "--batch-all-objects", "--batch-check").split("\n").some((line) => line.startsWith(`${object} `));

test("clause 41: turning code content on keeps a bare blobless clone with every branch of the repository's remote", async (context) => {
  const { code, prism, id, clone } = await codeWorkspace(context);
  const enabled = await enable(prism, id, "api");
  assert.equal(enabled.status, 200, enabled.body);
  assert.equal(enabled.json.repository, "api");
  assert.equal(enabled.json.code.state, "on");
  assert.deepEqual(enabled.json.code.branches, [{ name: "feature-x", commit: git(code, "rev-parse", "feature-x") }, { name: "main", commit: git(code, "rev-parse", "main") }]);
  assert.equal(git(clone, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(git(clone, "config", "--get", "remote.origin.partialclonefilter"), "blob:none");
  assert.equal((await enable(prism, id, "mobile")).status, 404);
});

test("clause 41: a repository whose registration lists no remote cannot take code content", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const root = await repository(where.parent, "local", { remote: null });
  await commitFiles(root, { ".prism/workflow.md": artifactConfig({ store: store.url, repository: "local", sync: "on" }) }, "configure Prism");
  ok(await (await server(context, where, root)).call("get_roadmap", {}));
  const prism = await startApp(context, where);
  await prism.grant();
  await prism.register(root);
  const refused = await enable(prism, workspaceId(store.identity), "local");
  assert.equal(refused.status, 409, refused.body);
  assert.equal(refused.json.code, "no_remote");
});

test("clause 42: turning code content off deletes the clone, and the choice survives a restart", async (context) => {
  const { where, prism, id, clone } = await codeWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  const disabled = await enable(prism, id, "api", false);
  assert.deepEqual(disabled.json.code, { state: "off" });
  assert.equal(await exists(clone), false);
  assert.equal((await enable(prism, id, "api")).status, 200);
  await prism.app.close();
  const again = await startApp(context, where);
  const index = (await again.get(`/w/${id}/api/index`)).json;
  assert.equal(index.repositories.find((entry) => entry.name === "api").code.state, "on");
});

test("clauses 43 and 49: each workspace fetch brings new branches and drops removed ones with their declarations", async (context) => {
  const { where, code, prism, id } = await codeWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  const work = path.join(where.parent, "api-work");
  git(where.parent, "clone", "-q", code, work);
  git(work, "checkout", "-q", "-b", "feature-y", "origin/main");
  await commitFiles(work, { "packages/billing/tax.js": "export const tax = 0;\n" }, "tax");
  git(work, "push", "-q", "origin", "feature-y");
  git(work, "push", "-q", "origin", "--delete", "feature-x");
  const stream = http.get(`${prism.viewer}/w/${id}/api/events`);
  context.after(() => stream.destroy());
  const tree = async (folder) => (await prism.get(`/w/${id}/api/code/tree?repository=api&folder=${encodeURIComponent(folder)}`)).json;
  await eventually(async () => (await tree("packages/billing")).entries.some((entry) => entry.path === "packages/billing/tax.js"), 10000, "the new branch's file");
  assert.equal((await tree("packages")).entries.some((entry) => entry.path === "packages/web"), false, "the removed branch's folder is gone");
  const components = (await prism.get(`/w/${id}/api/code/components?repository=api`)).json;
  assert.deepEqual(components.components.map((entry) => entry.identity), ["api/billing"]);
});

test("clauses 44 and 45: a repository whose code cannot be fetched is named, while the workspace still shows its store", async (context) => {
  const { where, prism, id } = await codeWorkspace(context);
  const failed = await enable(prism, id, "web");
  assert.equal(failed.status, 200, failed.body);
  assert.equal(failed.json.code.state, "unreachable");
  assert.equal(typeof failed.json.code.message, "string");
  assert.equal(await exists(path.join(where.app, "code", `${sha16("github.com/acme/web")}.git`)), false);
  assert.equal((await enable(prism, id, "api")).status, 200);
  const index = await prism.get(`/w/${id}/api/index`);
  assert.equal(index.status, 200);
  assert.deepEqual(index.json.repositories.map((entry) => [entry.name, entry.code.state]), [["api", "on"], ["web", "unreachable"]]);
});

test("clause 46: a folder lists each entry of every branch with the branches and blobs that hold it", async (context) => {
  const { prism, id } = await codeWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  const packages = (await prism.get(`/w/${id}/api/code/tree?repository=api&folder=packages`)).json;
  assert.deepEqual(packages, { repository: "api", folder: "packages", entries: [
    { path: "packages/billing", type: "folder", branches: [{ branch: "feature-x", blob: null }, { branch: "main", blob: null }] },
    { path: "packages/web", type: "folder", branches: [{ branch: "feature-x", blob: null }] }
  ] });
  const billing = (await prism.get(`/w/${id}/api/code/tree?repository=api&folder=packages/billing`)).json;
  assert.deepEqual(billing.entries, [{ path: "packages/billing/total.js", type: "file", branches: [{ branch: "feature-x", blob: blobOf(TOTAL) }, { branch: "main", blob: blobOf(TOTAL) }] }]);
});

test("clause 47: a file's contents are fetched only when someone opens it, and secrets and missing paths answer 404", async (context) => {
  const { code, prism, id, clone } = await codeWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  assert.equal(present(clone, blobOf(FEATURE)), false, "nobody opened the feature file yet");
  const read = await prism.get(`/w/${id}/api/code/file?repository=api&branch=main&path=${encodeURIComponent("docs/Features/billing.feature")}`);
  assert.equal(read.status, 200, read.body);
  assert.deepEqual(read.json, { repository: "api", branch: "main", commit: git(code, "rev-parse", "main"), path: "docs/Features/billing.feature", blob: blobOf(FEATURE), bytes: Buffer.byteLength(FEATURE), content: FEATURE });
  assert.equal(present(clone, blobOf(FEATURE)), true);
  assert.equal(present(clone, blobOf(TOTAL)), false, "an unopened file stays unfetched");
  const byCommit = await prism.get(`/w/${id}/api/code/file?repository=api&commit=${git(code, "rev-parse", "main")}&path=${encodeURIComponent("packages/billing/total.js")}`);
  assert.equal(byCommit.json.branch, null);
  assert.equal(byCommit.json.content, TOTAL);
  assert.equal((await prism.get(`/w/${id}/api/code/file?repository=api&branch=main&path=.env`)).status, 404);
  assert.equal((await prism.get(`/w/${id}/api/code/file?repository=api&branch=main&path=none.js`)).status, 404);
});

test("clause 48: component declarations come from every branch, each with the branches that declare it", async (context) => {
  const { where, code, prism, id } = await codeWorkspace(context);
  const work = path.join(where.parent, "api-broken");
  git(where.parent, "clone", "-q", code, work);
  git(work, "checkout", "-q", "-b", "broken", "origin/main");
  await commitFiles(work, { ".prism/workflow.md": "## Components\n- billing: packages/billing\n- totals: packages/billing\n" }, "overlap");
  git(work, "push", "-q", "origin", "broken");
  assert.equal((await enable(prism, id, "api")).status, 200);
  const components = (await prism.get(`/w/${id}/api/code/components?repository=api`)).json;
  assert.deepEqual(components.components, [
    { identity: "api/billing", folder: "packages/billing", branches: ["feature-x", "main"] },
    { identity: "api/web", folder: "packages/web", branches: ["feature-x"] }
  ]);
  assert.deepEqual(components.problems.map((problem) => problem.branch), ["broken"]);
  assert.equal(typeof components.problems[0].message, "string");
});

test("clause 50: no code answer names a Git host's URL", async (context) => {
  const { prism, id } = await codeWorkspace(context);
  const answers = [await enable(prism, id, "api")];
  answers.push(await prism.get(`/w/${id}/api/code/tree?repository=api&folder=`));
  answers.push(await prism.get(`/w/${id}/api/code/file?repository=api&branch=main&path=${encodeURIComponent("packages/billing/total.js")}`));
  answers.push(await prism.get(`/w/${id}/api/code/components?repository=api`));
  for (const answer of answers) {
    assert.equal(answer.status, 200, answer.body);
    assert.doesNotMatch(answer.body, /https?:\/\/|github\.com/);
  }
});
