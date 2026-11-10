import assert from "node:assert/strict";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, checkout, exists, git, isolateGit, networkStore, ok, place, server, sha16, storeFolderId } from "./fixtures/workspace-view.mjs";

// Contract clauses 1-3 of the workspace-view design: every spelling of one store names one managed clone.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const stores = async (where) => (await readdir(path.join(where.app, "stores")).catch(() => [])).filter((name) => !name.startsWith("."));
const createInitiative = (prism, slug) => prism.call("update_initiative", { initiative: slug, expectedRevision: null, operations: [{ op: "create", slug, title: "Reports", requirements: ["r.md#1"] }] });

test("clauses 1 and 2: HTTPS, scp, and ssh spellings of one store share one clone named by the store identity", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const spellings = [`git@example.invalid:${store.owner}/store.git`, `ssh://git@EXAMPLE.invalid:22/${store.owner}/store`, `https://example.invalid/${store.owner}/store/`];
  for (const url of spellings) alias(url, store.bare);
  const roots = [await checkout(where, "api", { store: store.url, sync: "on" })];
  for (const [index, url] of spellings.entries()) roots.push(await checkout(where, `web${index}`, { store: url, sync: "on" }));
  const servers = [];
  for (const root of roots) servers.push(await server(context, where, root));
  ok(await createInitiative(servers[0], "reports"));
  for (const prism of servers.slice(1)) {
    const read = ok(await prism.call("get_initiative", { initiative: "reports" }));
    assert.equal(read.exists, true, "every spelling reads the record the first one wrote, from the same clone");
  }
  assert.deepEqual(await stores(where), [storeFolderId(store.identity)]);
});

test("clause 1: a folder store keeps its own identity, apart from a network spelling of another store", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const folder = path.join(where.parent, "store");
  git(where.parent, "init", "-q", "-b", "main", folder);
  const local = await checkout(where, "api", { store: "../store" });
  const remote = await checkout(where, "web", { store: store.url, sync: "on" });
  ok(await createInitiative(await server(context, where, local), "local"));
  ok(await createInitiative(await server(context, where, remote), "remote"));
  assert.deepEqual(await stores(where), [storeFolderId(store.identity)], "only the network store has a managed clone");
  assert.equal((await ok(await (await server(context, where, local)).call("get_initiative", { initiative: "remote" }))).exists, false);
});

test("clause 3: a clone that Prism 0.20 named for the configured URL moves to the new folder with its unpushed commit", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const old = path.join(where.app, "stores", sha16(`https://example.invalid/${store.owner}/store`));
  git(where.parent, "clone", "-q", store.bare, old);
  git(old, "remote", "set-url", "origin", store.url);
  await writeFile(path.join(old, "LOCAL.md"), "kept\n");
  git(old, "add", "LOCAL.md");
  git(old, "commit", "-q", "-m", "unpushed");
  const unpushed = git(old, "rev-parse", "HEAD");
  const root = await checkout(where, "api", { store: store.url, sync: "on" });
  ok(await createInitiative(await server(context, where, root), "reports"));
  const moved = path.join(where.app, "stores", storeFolderId(store.identity));
  assert.equal(await exists(old), false, "the old folder is gone");
  assert.doesNotThrow(() => git(moved, "cat-file", "-e", `${unpushed}^{commit}`), "the unpushed commit is in the new folder");
});

test("clause 3: an old folder stays untouched when the new folder already exists", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const clone = (folder) => {
    git(where.parent, "clone", "-q", store.bare, folder);
    git(folder, "remote", "set-url", "origin", store.url);
    return git(folder, "rev-parse", "HEAD");
  };
  const fresh = path.join(where.app, "stores", storeFolderId(store.identity));
  const old = path.join(where.app, "stores", sha16(`https://example.invalid/${store.owner}/store`));
  clone(fresh);
  const before = clone(old);
  const root = await checkout(where, "api", { store: store.url, sync: "on" });
  ok(await createInitiative(await server(context, where, root), "reports"));
  assert.equal(git(old, "rev-parse", "HEAD"), before, "the old folder takes no commit");
  assert.equal(git(old, "status", "--porcelain"), "", "the old folder takes no file");
  assert.ok(await exists(path.join(fresh, ".prism", "initiatives", "reports", "initiative.json")) || git(fresh, "log", "--all", "--oneline").includes("prism"), "the new folder holds the record");
});
