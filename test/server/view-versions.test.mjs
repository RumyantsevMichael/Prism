import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createViewVersions } from "../../dist/server/review/view-versions.mjs";
import { collectValidity, validUntil } from "../../dist/server/workflow/view-validity.mjs";
import { isLive } from "../../dist/server/workflow/slice-claims.mjs";
import { settled } from "./fixtures/wait.mjs";

async function folder(t) {
  const root = await mkdtemp(path.join(tmpdir(), "prism-view-versions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "store", "initiatives"), { recursive: true });
  await writeFile(path.join(root, "store", "roadmap.json"), "{}\n");
  return root;
}

const noWatcher = () => { throw new Error("no watcher here"); };

test("a watched change to a store file gives the root a new version at once, and an unchanged store keeps its version", async (t) => {
  const root = await folder(t);
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), isEventless: async () => false });
  t.after(() => versions.close());
  const first = await versions.current(root);
  assert.equal(await versions.current(root), first, "nothing changed, so the version holds");
  await writeFile(path.join(root, "store", "initiatives", "added.json"), "{}\n");
  await settled(() => versions.current(root), (version) => version !== first);
});

test("without a watcher, an in-place edit is found by the listing check within the short interval", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => false, verifyMs: 5000, watchedVerifyMs: 30000, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  await writeFile(path.join(root, "store", "roadmap.json"), '{"changed":true}\n');
  clock += 4999;
  assert.equal(await versions.current(root), first, "no check runs before the interval passes");
  clock += 1;
  assert.notEqual(await versions.current(root), first, "the listing check notices the edit");
});

test("without a watcher, a file that another process adds or replaces by a rename shows at the next read, before any full listing", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => false, verifyMs: 5000, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  clock += 1;
  await writeFile(path.join(root, "store", "initiatives", "new.json.tmp"), "{}\n");
  await rename(path.join(root, "store", "initiatives", "new.json.tmp"), path.join(root, "store", "initiatives", "new.json"));
  // A folder's time can have a coarse resolution, so the read is repeated until the change shows, while the clock stays short of a full listing.
  await settled(() => versions.current(root), (version) => version !== first);
});

test("a target on a file system that delivers no events is checked at the short interval even while a watcher runs", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: (target, options) => ({ on() {}, close() {}, unref() {} }), isEventless: async () => true, verifyMs: 5000, watchedVerifyMs: 30000, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  await writeFile(path.join(root, "store", "roadmap.json"), '{"from":"another machine"}\n');
  clock += 5000;
  assert.notEqual(await versions.current(root), first);
});

test("a fully watched root is still checked against its listing at the long interval, so a dropped event is found", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  const silent = () => ({ on() {}, close() {}, unref() {} });
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: silent, isEventless: async () => false, verifyMs: 5000, watchedVerifyMs: 30000, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  await writeFile(path.join(root, "store", "roadmap.json"), '{"dropped":true}\n');
  clock += 5000;
  assert.equal(await versions.current(root), first, "a watched root waits for the long interval");
  clock += 25000;
  assert.notEqual(await versions.current(root), first);
});

test("a missing target leaves the watched ones unlisted between full listings, and its creation shows at once", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  const watched = new Map();
  const fake = (target, options, listener) => { watched.set(target, listener); return { on() {}, close() { watched.delete(target); }, unref() {} }; };
  const failing = (target, options, listener) => {
    if (target === path.join(root, "docs", "ADRs") || target === path.join(root, "docs")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return fake(target, options, listener);
  };
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "docs", "ADRs"), path.join(root, "store")], files: [], gitRoots: [] }), watchTree: failing, isEventless: async () => false, verifyMs: 5000, watchedVerifyMs: 30000, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  assert.ok(watched.has(root), "the missing folder is watched through the nearest folder that exists");
  // A change the watched store's watcher does not report waits for the full listing, so the store is not listed at every read.
  await writeFile(path.join(root, "store", "initiatives", "silent.json.tmp"), "{}\n");
  await rename(path.join(root, "store", "initiatives", "silent.json.tmp"), path.join(root, "store", "initiatives", "silent.json"));
  clock += 6000;
  assert.equal(await versions.current(root), first, "a watched target is not listed between full listings");
  await mkdir(path.join(root, "docs", "ADRs"), { recursive: true });
  watched.get(root)("rename", "docs");
  const created = await versions.current(root);
  assert.notEqual(created, first, "the creation changes the version at once");
  assert.ok(watched.has(path.join(root, "store")), "the watchers start again, now on the created folder");
  await writeFile(path.join(root, "store", "roadmap.json"), '{"silent":true}\n');
  clock += 30000;
  assert.notEqual(await versions.current(root), created, "the full listing finds a change no watcher reported");
});

test("a root reports which targets no watcher covers and why", async (t) => {
  const root = await folder(t);
  const network = path.join(root, "store");
  const local = path.join(root, "local");
  await mkdir(local);
  const fake = () => ({ on() {}, close() {}, unref() {} });
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [local, network, path.join(root, "missing")], files: [], gitRoots: [] }), watchTree: fake, isEventless: async (target) => (target === network ? "smbfs" : null) });
  t.after(() => versions.close());
  assert.deepEqual(await versions.watching(root), { unwatched: [{ path: network, reason: "network" }], targets: 3 }, "a missing target watched through its parent counts as watched");
  const failing = createViewVersions({ targetsOf: async () => ({ folders: [local], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => null });
  t.after(() => failing.close());
  assert.deepEqual((await failing.watching(root)).unwatched, [{ path: local, reason: process.platform === "win32" ? "windows" : "unwatchable" }]);
});

test("changes inside Git's data and the store's sync state never change the version", async (t) => {
  const root = await folder(t);
  let clock = 1000;
  await mkdir(path.join(root, "store", ".git"), { recursive: true });
  await mkdir(path.join(root, "store", ".prism-sync"), { recursive: true });
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => false, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  await writeFile(path.join(root, "store", ".git", "index"), "changed");
  await writeFile(path.join(root, "store", ".prism-sync", "status.json"), "{}");
  clock += 60000;
  assert.equal(await versions.current(root), first);
});

test("a root whose targets cannot be named gets a new version at every read, so nothing of it is reused", async (t) => {
  const versions = createViewVersions({ targetsOf: async () => { throw new Error("store unavailable"); } });
  t.after(() => versions.close());
  const first = await versions.current("/nowhere");
  assert.notEqual(await versions.current("/nowhere"), first);
});

test("a write of this process changes every version at once", async (t) => {
  const root = await folder(t);
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => false });
  t.after(() => versions.close());
  const first = await versions.current(root);
  versions.bump();
  assert.notEqual(await versions.current(root), first);
});

test("a view that finds a claim live holds only until the claim expires, and the earliest such time wins", async () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const soon = { expiresAt: "2026-11-22T12:05:00Z" };
  const later = { expiresAt: "2026-11-22T13:00:00Z" };
  const lapsed = { expiresAt: "2026-11-22T11:00:00Z" };
  const { value, until } = await collectValidity(async () => [isLive(later, now), isLive(soon, now), isLive(lapsed, now)]);
  assert.deepEqual(value, [true, true, false]);
  assert.equal(until, Date.parse(soon.expiresAt));
  assert.equal((await collectValidity(async () => isLive(lapsed, now))).until, Infinity, "an expired claim stays expired until a file changes");
  validUntil(0);
});
