import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createViewVersions } from "../../dist/server/review/view-versions.mjs";
import { collectValidity, validUntil } from "../../dist/server/workflow/view-validity.mjs";
import { isLive } from "../../dist/server/workflow/slice-claims.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

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

// Windows watches no folder, so there only the listings that the tests below check notice changes.
const watchedOnly = process.platform === "win32" ? "folders are not watched on Windows" : false;

test("a watched file that another write replaces by a rename, again and again, gives the root a new version each time without a listing", { skip: watchedOnly }, async (t) => {
  const root = await folder(t);
  const clock = 1000;
  // The clock stands still, so no listing runs and only the watcher can change the version.
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), isEventless: async () => false, now: () => clock });
  t.after(() => versions.close());
  // Every write Prism makes writes a new file and renames it over the old one, and here each rename lands before the watcher's process reads an event, as on a busy machine.
  const record = path.join(root, "store", "initiatives", "record.json");
  writeFileSync(record, "0\n");
  let version = await versions.current(root);
  for (let write = 1; write <= 5; write += 1) {
    writeFileSync(`${record}.tmp`, `${write}\n`);
    renameSync(`${record}.tmp`, record);
    const next = await settled(() => versions.current(root), (read) => read !== version);
    assert.notEqual(next, version, `rewrite ${write} changes the version`);
    version = next;
  }
});

test("a folder made after the watcher started is watched too, and a file written into it at once is counted", { skip: watchedOnly }, async (t) => {
  const root = await folder(t);
  const clock = 1000;
  const versions = createViewVersions({ targetsOf: async () => ({ folders: [path.join(root, "store")], files: [], gitRoots: [] }), isEventless: async () => false, now: () => clock });
  t.after(() => versions.close());
  const first = await versions.current(root);
  const made = path.join(root, "store", "initiatives", "reports", "slices");
  mkdirSync(made, { recursive: true });
  writeFileSync(path.join(made, "totals.json"), "{}\n");
  const created = await settled(() => versions.current(root), (read) => read !== first);
  assert.notEqual(created, first, "the new folder and its file change the version");
  // Once the creation's events have arrived, a later write inside the new folder is reported by that folder's own watcher.
  await pause(300, "the creation's last events arrive, so a change after them comes from the later write alone");
  const seen = await versions.current(root);
  writeFileSync(`${path.join(made, "totals.json")}.tmp`, '{"changed":true}\n');
  renameSync(`${path.join(made, "totals.json")}.tmp`, path.join(made, "totals.json"));
  assert.notEqual(await settled(() => versions.current(root), (read) => read !== seen), seen, "a rewrite in the new folder changes the version");
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

test("Prism's own lock and write files never change the version, watched or not, so a build that takes a lock does not start the next one", async (t) => {
  const root = await folder(t);
  const store = path.join(root, "store");
  let clock = 1000;
  let listener = null;
  const capture = (target, options, callback) => { listener = callback; return { on() {}, close() {}, unref() {} }; };
  const watched = createViewVersions({ targetsOf: async () => ({ folders: [store], files: [], gitRoots: [] }), watchTree: capture, isEventless: async () => null, now: () => clock });
  t.after(() => watched.close());
  const first = await watched.current(root);
  listener("rename", path.join("format-migrations", "run-0000000000000000.json.lock"));
  listener("rename", path.join("initiatives", ".state.json.123.abc.tmp"));
  assert.equal(await watched.current(root), first, "a watcher event for a lock or write file is ignored");
  listener("rename", path.join("initiatives", "state.json"));
  assert.notEqual(await watched.current(root), first, "the record's own event still counts");

  const unwatched = createViewVersions({ targetsOf: async () => ({ folders: [store], files: [], gitRoots: [] }), watchTree: noWatcher, isEventless: async () => null, now: () => clock });
  t.after(() => unwatched.close());
  const before = await unwatched.current(root);
  const lock = path.join(store, "initiatives", "run.json.lock");
  for (let round = 0; round < 3; round += 1) {
    await writeFile(lock, "{}");
    clock += 1;
    assert.equal(await unwatched.current(root), before, "a lock taken is not a change");
    await rm(lock);
    clock += 1;
    assert.equal(await unwatched.current(root), before, "a lock released is not a change");
  }
  clock += 5000;
  assert.equal(await unwatched.current(root), before, "the full listing leaves lock files out too");
  await writeFile(path.join(store, "initiatives", "added.json.tmp"), "{}\n");
  await rename(path.join(store, "initiatives", "added.json.tmp"), path.join(store, "initiatives", "added.json"));
  await settled(async () => { clock += 1; return unwatched.current(root); }, (version) => version !== before);
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
