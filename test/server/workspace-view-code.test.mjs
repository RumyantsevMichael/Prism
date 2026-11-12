import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, artifactConfig, bareRemote, blobOf, commitFiles, eventually, exists, git, isolateGit, networkStore, ok, place, server, sha16, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { repository } from "./fixtures/repository-checkouts.mjs";
import { launch, settle, skip } from "./fixtures/kit-browser.mjs";

// Contract clauses 41-50 of the workspace-view design: code-repository content of every pushed branch, from blobless clones Prism keeps, and store artifact links to code files resolved from them.
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

const NOTES = "Billing notes\n";
const CHECKOUT_TOTAL = "// the checkout's own copy\n";
const LINKED = "# Billing\n\nSee [total](../../packages/billing/total.js), [notes](../../packages/billing/notes.txt), [page](../../packages/web/page.js), [secret](../../.env), [logo](../../assets/logo.bin), [big](../../assets/big.txt), and [none](../../none.js).\n";
const LINKED_REF = "store:repositories/api/requirements/billing.md";

// A workspace added from its store URL alone, whose api scope holds a requirement linking to code files; api's code remote holds main and feature-x, its HEAD naming head.
// The api checkout holds its own copy of packages/billing/total.js and is not registered with the app until a test registers it.
async function linkedWorkspace(context, { head = "main" } = {}) {
  const where = await place(context);
  const store = await networkStore(where);
  const code = await bareRemote(where.parent, "api-code.git", {
    files: { "packages/billing/total.js": TOTAL, "packages/billing/notes.txt": NOTES, ".env": "TOKEN=secret\n", "assets/logo.bin": "PNG\u0000\u0001\u0002", "assets/big.txt": "x".repeat(600 * 1024) },
    branches: { "feature-x": { "packages/web/page.js": "export const page = 1;\n" } }
  });
  git(code, "symbolic-ref", "HEAD", `refs/heads/${head}`);
  alias("https://github.com/acme/api.git", code);
  const apiRoot = await storeCheckout(context, where, "api", store.url, { files: { "packages/billing/total.js": CHECKOUT_TOTAL } });
  await writeArtifact(await server(context, where, apiRoot), "docs/requirements/billing.md", LINKED, { scope: "repository" });
  // Checkout servers push store writes only after the record-sync debounce, so the add waits until the remote holds the artifact.
  const pushed = () => { try { git(store.bare, "cat-file", "-e", "main:artifacts/repositories/api/requirements/billing.md"); return true; } catch { return false; } };
  await eventually(pushed, 15000, "the artifact reaching the remote");
  const prism = await startApp(context, where);
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  const links = async () => {
    const read = await prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent(LINKED_REF)}`);
    assert.equal(read.status, 200, read.body);
    return Object.fromEntries(read.json.links.map(({ href, ...link }) => [href.replace("../../", ""), link]));
  };
  const open = (file) => prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent(`code:api:${file}`)}`);
  return { where, code, prism, id, apiRoot, links, open };
}

const available = (file) => ({ line: 3, target: `code:api:${file}`, resolved: true });
const unavailable = (file) => ({ line: 3, target: `code:api:${file}`, resolved: null, reason: "code_not_available" });

test("clause 50: with code content on and no checkout, a link to a code file resolves from the clone's default branch", async (context) => {
  const { code, prism, id, links, open } = await linkedWorkspace(context);
  assert.deepEqual((await links())["packages/billing/total.js"], unavailable("packages/billing/total.js"), "code content is still off");
  assert.equal((await enable(prism, id, "api")).status, 200);
  const on = await links();
  assert.deepEqual(on["packages/billing/total.js"], available("packages/billing/total.js"));
  assert.deepEqual(on["packages/billing/notes.txt"], available("packages/billing/notes.txt"));
  assert.deepEqual(on["packages/web/page.js"], unavailable("packages/web/page.js"), "only feature-x holds it, not the default branch");
  assert.deepEqual(on["none.js"], unavailable("none.js"));
  const file = await open("packages/billing/total.js");
  assert.equal(file.status, 200, file.body);
  assert.deepEqual(file.json, { ref: "code:api:packages/billing/total.js", repository: "api", branch: "main", commit: git(code, "rev-parse", "main"), path: "packages/billing/total.js", blob: blobOf(TOTAL), bytes: Buffer.byteLength(TOTAL), content: TOTAL });
  assert.equal((await open("packages/web/page.js")).status, 404);
  assert.equal((await open("none.js")).status, 404);
  assert.equal((await enable(prism, id, "api", false)).status, 200);
  assert.deepEqual((await links())["packages/billing/total.js"], unavailable("packages/billing/total.js"), "code content is off again");
  assert.equal((await open("packages/billing/total.js")).status, 404);
});

test("clause 50: a file opened through a link from the clone keeps clause 47's secret, binary, and size checks", async (context) => {
  const { prism, id, open } = await linkedWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  for (const file of [".env", "assets/logo.bin", "assets/big.txt"]) assert.equal((await open(file)).status, 404, file);
  assert.equal((await open("packages/billing/notes.txt")).json.content, NOTES);
});

test("clause 50: the default branch is the one the remote's HEAD names", async (context) => {
  const { code, prism, id, links, open } = await linkedWorkspace(context, { head: "feature-x" });
  assert.equal((await enable(prism, id, "api")).status, 200);
  assert.deepEqual((await links())["packages/web/page.js"], available("packages/web/page.js"));
  const file = await open("packages/web/page.js");
  assert.equal(file.status, 200, file.body);
  assert.equal(file.json.branch, "feature-x");
  assert.equal(file.json.commit, git(code, "rev-parse", "feature-x"));
});

test("clause 50: a registered checkout that lists the path still answers the link, and the clone answers the paths it does not list", async (context) => {
  const { prism, id, apiRoot, links, open } = await linkedWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  await prism.register(apiRoot);
  const listed = await links();
  assert.deepEqual(listed["packages/billing/total.js"], available("packages/billing/total.js"));
  assert.deepEqual(listed["packages/billing/notes.txt"], available("packages/billing/notes.txt"));
  assert.deepEqual(listed["packages/web/page.js"], { line: 3, target: null, resolved: false }, "with a checkout registered, a path neither it nor the default branch holds names nothing");
  const total = await open("packages/billing/total.js");
  assert.equal(total.status, 200, total.body);
  assert.equal(total.json.content, CHECKOUT_TOTAL, "the checkout wins over the clone");
  const notes = await open("packages/billing/notes.txt");
  assert.equal(notes.json.branch, "main");
  assert.equal(notes.json.content, NOTES);
});

test("clause 50: the page opens a link resolved from the clone as a tab with its branch's label", { skip }, async (context) => {
  const { prism, id } = await linkedWorkspace(context);
  assert.equal((await enable(prism, id, "api")).status, 200);
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=${encodeURIComponent(LINKED_REF)}`);
  await settle(page);
  const link = page.locator('a[data-doc-link="code:api:packages/billing/total.js"]');
  assert.equal(await link.count(), 1, "the link opens the file");
  assert.equal(await page.locator('[data-link="unavailable"]').count(), 2, "page.js and none.js are not available on this machine");
  await link.click();
  await settle(page);
  assert.match(await page.locator("body").innerText(), /export const total/);
  assert.ok((await page.locator("[data-branch-label]").allTextContents()).some((label) => label.includes("main")), "the tab shows the default branch's label");
});
