import assert from "node:assert/strict";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, bareRemote, exists, git, isolateGit, networkStore, place, startApp, storeCheckout, storeFolderId, workspaceId } from "./fixtures/workspace-view.mjs";

// Contract clauses 14-21 of the workspace-view design: a person adds a workspace from its store URL alone and removes it safely.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const folders = async (where) => (await readdir(path.join(where.app, "stores")).catch(() => [])).sort();
const add = (prism, url, extra = {}) => prism.post("/api/workspaces", { url, ...extra });

async function started(context, options) {
  const where = await place(context);
  const store = await networkStore(where, "store", options);
  const prism = await startApp(context, where);
  await prism.grant();
  return { where, store, prism };
}

test("clause 14: adding a store URL lists its workspace as added, and the add needs the page's write session", async (context) => {
  const { where, store, prism } = await started(context);
  const refused = await prism.post("/api/workspaces", { url: store.url }, { "X-Prism-Write": "" });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "write_forbidden");
  const added = await add(prism, store.url);
  assert.equal(added.status, 200, added.body);
  assert.equal(added.json.merged, false);
  assert.equal(added.json.workspace.id, workspaceId(store.identity));
  assert.equal(added.json.workspace.added, true);
  assert.equal(added.json.workspace.kind, "store");
  assert.deepEqual(added.json.workspace.store.urls, [store.url]);
  assert.deepEqual((await prism.workspaces()).map((entry) => entry.id), [workspaceId(store.identity)]);
  assert.ok(await exists(path.join(where.app, "stores", storeFolderId(store.identity), "README.md")), "only the store is cloned into its managed folder");
});

test("clause 15: a URL that carries credentials is refused before any Git command, while an SSH login name is accepted", async (context) => {
  const { where, store, prism } = await started(context);
  for (const url of [`https://ada:secret@example.invalid/${store.owner}/store.git`, `https://ghp_token@example.invalid/${store.owner}/store.git`, `ssh://git:secret@example.invalid/${store.owner}/store.git`]) {
    const refused = await add(prism, url);
    assert.equal(refused.status, 400, url);
    assert.equal(refused.json.code, "url_has_credentials");
    assert.match(refused.json.message, /credentials come from the machine's Git configuration/);
    assert.doesNotMatch(refused.json.message, /secret|ghp_token/);
  }
  assert.deepEqual(await folders(where), [], "no folder was made");
  const invalid = await add(prism, "not a store");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "url_invalid");
  const ssh = `git@example.invalid:${store.owner}/store.git`;
  alias(ssh, store.bare);
  const added = await add(prism, ssh);
  assert.equal(added.status, 200, added.body);
  assert.equal(added.json.workspace.id, workspaceId(store.identity));
});

test("clause 16: a store whose clone this machine already keeps is added without cloning", async (context) => {
  const { where, store, prism } = await started(context);
  await storeCheckout(context, where, "api", store.url);
  const clone = path.join(where.app, "stores", storeFolderId(store.identity));
  const head = git(clone, "rev-parse", "HEAD");
  await rename(store.bare, `${store.bare}.away`);
  context.after(() => rename(`${store.bare}.away`, store.bare).catch(() => {}));
  const added = await add(prism, store.url);
  assert.equal(added.status, 200, added.body);
  assert.equal(git(clone, "rev-parse", "HEAD"), head);
  assert.deepEqual(await folders(where), [storeFolderId(store.identity)]);
});

test("clause 17: a failed clone shows Git's reason without credentials and keeps nothing", async (context) => {
  const { where, store, prism } = await started(context);
  const url = `https://example.invalid/${store.owner}/missing.git`;
  alias(url, "https://ada:secret@127.0.0.1:9/missing.git");
  const failed = await add(prism, url);
  assert.equal(failed.status, 502, failed.body);
  assert.equal(failed.json.code, "clone_failed");
  assert.match(failed.json.message, /127\.0\.0\.1/);
  assert.doesNotMatch(failed.json.message, /secret|ada@/);
  assert.deepEqual(await folders(where), []);
  assert.deepEqual(await prism.workspaces(), []);
});

test("clause 17: a folder at the clone's place that is no clone of the store refuses the add and keeps its files", async (context) => {
  const { where, store, prism } = await started(context);
  const taken = path.join(where.app, "stores", storeFolderId(store.identity));
  await mkdir(taken, { recursive: true });
  await writeFile(path.join(taken, "mine.txt"), "keep\n");
  const refused = await add(prism, store.url);
  assert.equal(refused.status, 409, refused.body);
  assert.equal(refused.json.code, "clone_folder_taken");
  assert.deepEqual(await readdir(taken), ["mine.txt"]);
  assert.deepEqual(await prism.workspaces(), []);
});

test("clause 18: an empty store becomes a workspace only after the person confirms", async (context) => {
  const where = await place(context);
  const bare = await bareRemote(where.parent, "empty-remote.git", { files: null });
  const url = `https://example.invalid/${path.basename(where.parent)}/empty.git`;
  alias(url, bare);
  const prism = await startApp(context, where);
  await prism.grant();
  const refused = await add(prism, url);
  assert.equal(refused.status, 409, refused.body);
  assert.equal(refused.json.code, "store_empty");
  assert.deepEqual(await folders(where), []);
  assert.deepEqual(await prism.workspaces(), []);
  const confirmed = await add(prism, url, { confirmEmpty: true });
  assert.equal(confirmed.status, 200, confirmed.body);
  assert.equal(confirmed.json.workspace.name, "empty");
  assert.equal((await prism.workspaces()).length, 1);
});

test("clause 19: an SSH host alias of a kept store joins its workspace by the root commit", async (context) => {
  const { where, store, prism } = await started(context);
  assert.equal((await add(prism, store.url)).status, 200);
  const aliased = `ssh://work-alias/${store.owner}/store.git`;
  alias(aliased, store.bare);
  const merged = await add(prism, aliased);
  assert.equal(merged.status, 200, merged.body);
  assert.equal(merged.json.merged, true);
  assert.equal(merged.json.workspace.id, workspaceId(store.identity));
  assert.deepEqual(merged.json.workspace.store.urls, [store.url, aliased]);
  assert.deepEqual(await folders(where), [storeFolderId(store.identity)]);
  assert.equal((await prism.workspaces()).length, 1);
});

test("clause 20: an added workspace stays listed across restarts, however many projects were used since", async (context) => {
  const { where, store, prism } = await started(context);
  assert.equal((await add(prism, store.url)).status, 200);
  for (let index = 0; index < 22; index += 1) {
    const root = path.join(where.parent, `project-${index}`);
    await mkdir(root, { recursive: true });
    const lease = `lease-${index}`;
    await prism.register(root, lease);
    await prism.control(`projects/${lease}`, { method: "DELETE" });
  }
  await prism.app.close();
  const again = await startApp(context, where);
  const listed = await again.workspaces();
  assert.ok(listed.some((entry) => entry.id === workspaceId(store.identity) && entry.added), "the added workspace is still listed");
});

test("clause 21: removing an added workspace deletes its clone only when nothing on the machine uses it and nothing is unpushed", async (context) => {
  const { where, store, prism } = await started(context);
  const id = workspaceId(store.identity);
  const clone = path.join(where.app, "stores", storeFolderId(store.identity));
  assert.equal((await add(prism, store.url)).status, 200);
  const removed = await prism.del(`/api/workspaces/${id}`);
  assert.equal(removed.status, 200, removed.body);
  assert.deepEqual({ removed: removed.json.removed, clone: removed.json.clone }, { removed: true, clone: "deleted" });
  assert.equal(await exists(clone), false);
  assert.deepEqual(await prism.workspaces(), []);

  assert.equal((await add(prism, store.url)).status, 200);
  await writeFile(path.join(clone, "LOCAL.md"), "not pushed\n");
  git(clone, "add", "LOCAL.md");
  git(clone, "commit", "-q", "-m", "unpushed");
  const unpushed = await prism.del(`/api/workspaces/${id}`);
  assert.equal(unpushed.json.clone, "kept");
  assert.match(unpushed.json.message, /not pushed/);
  assert.ok(await exists(clone));
  assert.equal((await prism.del("/api/workspaces/0123456789abcdef")).status, 404);
});

test("clause 21: a clone that a checkout names stays, and the workspace stays listed as not added", async (context) => {
  const { where, store, prism } = await started(context);
  const id = workspaceId(store.identity);
  const api = await storeCheckout(context, where, "api", store.url);
  await prism.register(api);
  assert.equal((await add(prism, store.url)).status, 200);
  const removed = await prism.del(`/api/workspaces/${id}`);
  assert.equal(removed.json.clone, "kept");
  assert.ok(removed.json.message.includes(api), removed.json.message);
  assert.ok(await exists(path.join(where.app, "stores", storeFolderId(store.identity))));
  const entry = (await prism.workspaces()).find((item) => item.id === id);
  assert.equal(entry.added, false);
  const again = await prism.del(`/api/workspaces/${id}`);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "workspace_not_added");
});
