import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alias, exists, git, isolateGit, networkStore } from "./fixtures/workspace-view.mjs";

// Store identity beyond the frozen tests: Git remote-helper values, percent-encoded paths, earlier clones that cannot move yet, and plaintext spellings of a store.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { isRemoteStore, legacyStoreId, managedStoreId, storeIdentity } = await import("../../dist/server/workflow/remote-url.mjs");
const { managedRecordStore, useManagedStores } = await import("../../dist/server/workflow/record-store-remote.mjs");

const unavailable = (message) => Object.assign(new Error(message), { code: "store_unavailable" });

async function place(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-store-identity-")));
  context.after(() => rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const root = path.join(parent, "project");
  const stores = path.join(parent, "app", "stores");
  await mkdir(stores, { recursive: true });
  useManagedStores(root, stores);
  return { parent, root, stores };
}

// A clone at the folder that Prism 0.20 named for the store's URL, holding one commit that its remote does not have.
async function earlierClone(where, store, folder = where.stores) {
  const old = path.join(folder, legacyStoreId(store.url));
  git(where.parent, "clone", "-q", store.bare, old);
  git(old, "remote", "set-url", "origin", store.url);
  await writeFile(path.join(old, "LOCAL.md"), "kept\n");
  git(old, "add", "LOCAL.md");
  git(old, "commit", "-q", "-m", "unpushed");
  return { old, unpushed: git(old, "rev-parse", "HEAD"), target: path.join(where.stores, await managedStoreId(store.url)) };
}

test("a Git remote-helper value is no network store and is refused without running Git", async (context) => {
  const where = await place(context);
  const bin = path.join(where.parent, "bin");
  const marker = path.join(where.parent, "helper-ran");
  await mkdir(bin);
  await writeFile(path.join(bin, "git-remote-probe"), `#!/bin/sh\necho "$@" > '${marker}'\nexit 1\n`);
  await chmod(path.join(bin, "git-remote-probe"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  context.after(() => { process.env.PATH = before; });
  try { execFileSync("git", ["ls-remote", "probe::anything"], { stdio: "pipe" }); } catch { /* The stub fails after it records that it ran. */ }
  assert.equal(await exists(marker), true, "Git itself starts the stub helper for this value");
  await rm(marker);
  for (const value of ["probe::anything", "ext::sh", "git@probe::anything"]) {
    assert.equal(isRemoteStore(value), false, value);
    assert.equal(await managedStoreId(value), null, value);
    assert.doesNotMatch(String(await storeIdentity(value, { root: where.root })), /^probe\/|^ext\//, value);
  }
  await assert.rejects(managedRecordStore(where.root, "probe::anything", unavailable), (error) => error.code === "store_unavailable" && /not a usable remote address/.test(error.message));
  assert.equal(await exists(marker), false, "no helper ran");
});

test("URL and scp spellings of a path with non-ASCII characters have one identity", async () => {
  const spellings = ["https://h.example/équipe/store.git", "ssh://git@h.example:22/%C3%A9quipe/store", "git@h.example:équipe/store.git"];
  for (const value of spellings) assert.equal(await storeIdentity(value), "h.example/équipe/store", value);
  assert.equal(new Set(await Promise.all(spellings.map(managedStoreId))).size, 1);
});

test("a failed rename of a 0.20 clone makes no new clone, and a later access moves it", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const { old, unpushed, target } = await earlierClone(where, store);
  const failing = async () => { throw Object.assign(new Error("resource busy"), { code: "EBUSY" }); };
  await assert.rejects(managedRecordStore(where.root, store.url, unavailable, { renameFolder: failing }), (error) => {
    assert.equal(error.code, "store_unavailable");
    assert.ok(error.message.includes(old), error.message);
    return true;
  });
  assert.equal(await exists(target), false, "no clone is made at the new folder");
  assert.equal(git(old, "rev-parse", "HEAD"), unpushed, "the old folder keeps its commit");
  assert.equal(await exists(path.join(old, ".prism-sync", "sync.lock")), false, "the old folder's sync lock is released");
  const base = await managedRecordStore(where.root, store.url, unavailable);
  assert.equal(base, await realpath(target));
  assert.equal(await exists(old), false);
  assert.doesNotThrow(() => git(target, "cat-file", "-e", `${unpushed}^{commit}`));
  assert.equal(await exists(path.join(target, ".prism-sync", "sync.lock")), false, "the moved lock is removed");
});

test("a 0.20 clone whose sync lock is held stays in place until the lock is free", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const { old, unpushed, target } = await earlierClone(where, store);
  const lock = path.join(old, ".prism-sync", "sync.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: "held-by-a-sync", renewable: true, at: new Date().toISOString() }));
  await assert.rejects(managedRecordStore(where.root, store.url, unavailable), (error) => {
    assert.equal(error.code, "store_unavailable");
    assert.ok(error.message.includes(old) && /sync of that clone is still running/.test(error.message), error.message);
    return true;
  });
  assert.equal(await exists(target), false, "no clone is made at the new folder");
  assert.equal(git(old, "rev-parse", "HEAD"), unpushed);
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, "held-by-a-sync", "the holder keeps its lock");
  await rm(lock);
  await managedRecordStore(where.root, store.url, unavailable);
  assert.equal(await exists(old), false);
  assert.doesNotThrow(() => git(target, "cat-file", "-e", `${unpushed}^{commit}`));
});

test("a failed move of a 0.16 clone makes no new clone, and a later access moves it", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const data = path.join(where.parent, "plugin-data");
  await mkdir(path.join(data, "stores"), { recursive: true });
  const before = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = data;
  context.after(() => { if (before === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = before; });
  const { old, unpushed, target } = await earlierClone(where, store, path.join(data, "stores"));
  const failing = async () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); };
  await assert.rejects(managedRecordStore(where.root, store.url, unavailable, { renameFolder: failing }), (error) => {
    assert.equal(error.code, "store_unavailable");
    assert.ok(error.message.includes(old), error.message);
    return true;
  });
  assert.equal(await exists(target), false, "no clone is made at the new folder");
  assert.equal(git(old, "rev-parse", "HEAD"), unpushed, "the old folder keeps its commit");
  assert.equal(await exists(path.join(old, ".prism-sync", "sync.lock")), false, "the old folder's sync lock is released");
  await managedRecordStore(where.root, store.url, unavailable);
  assert.equal(await exists(old), false);
  assert.doesNotThrow(() => git(target, "cat-file", "-e", `${unpushed}^{commit}`));
});

// The http:// spelling of a network store, reaching the same remote.
function plaintextSpelling(store) {
  const url = store.url.replace(/^https:/, "http:");
  alias(url, store.bare);
  return url;
}

test("http:// and git:// spellings keep their scheme in the store identity", async () => {
  assert.equal(await storeIdentity("http://GitHub.com:80/Acme/store.git"), "http://github.com/Acme/store");
  assert.equal(await storeIdentity("git://github.com/Acme/store.git/"), "git://github.com/Acme/store");
  assert.equal(await storeIdentity("HTTP://github.com/Acme/store"), "http://github.com/Acme/store");
  assert.equal(await storeIdentity("https://github.com/Acme/store.git"), "github.com/Acme/store");
});

test("a plaintext spelling never reaches the clone of an encrypted spelling of the same store", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const http = plaintextSpelling(store);
  const plainGit = http.replace(/^http:/, "git:");
  alias(plainGit, store.bare);
  const encrypted = await managedRecordStore(where.root, store.url, unavailable);
  const clones = new Set([encrypted]);
  for (const value of [http, plainGit]) {
    const base = await managedRecordStore(where.root, value, unavailable);
    assert.equal(clones.has(base), false, `${value} has a clone of its own`);
    clones.add(base);
    assert.equal(git(base, "config", "--get", "remote.origin.url"), value, "the plaintext clone keeps its own spelling");
  }
  assert.equal(git(encrypted, "config", "--get", "remote.origin.url"), store.url, "the encrypted clone keeps its encrypted origin");
});

test("a 0.20 clone of an http:// spelling stays that spelling's clone, and moves only to its identity folder", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const http = plaintextSpelling(store);
  assert.equal(legacyStoreId(http), await managedStoreId(http), "a plain http:// spelling already names the folder of its identity");
  const ported = http.replace("example.invalid/", "example.invalid:8080/");
  alias(ported, store.bare);
  const { old, unpushed, target } = await earlierClone(where, { ...store, url: ported });
  assert.notEqual(old, target);
  const encrypted = path.join(where.stores, await managedStoreId(store.url));
  assert.notEqual(target, encrypted);
  assert.equal(await managedRecordStore(where.root, store.url, unavailable), await realpath(encrypted));
  assert.equal(await exists(old), true, "an encrypted access leaves the plaintext clone where it is");
  assert.equal(await managedRecordStore(where.root, ported, unavailable), await realpath(target), "its own spelling moves it");
  assert.equal(await exists(old), false);
  assert.doesNotThrow(() => git(target, "cat-file", "-e", `${unpushed}^{commit}`));
});
