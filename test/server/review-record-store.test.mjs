import assert from "node:assert/strict";
import test from "node:test";

const { diffHtml, diffLines } = await import("../../dist/server/review/public/views/line-diff.js");
const { outsideChanges, storeItem, syncItem } = await import("../../dist/server/review/public/views/record-store.js");

test("a line diff keeps shared lines and marks removed and added ones in order", () => {
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nx\nc\n"), [{ op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "x" }, { op: "same", text: "c" }]);
  assert.deepEqual(diffLines(null, "a\n"), [{ op: "add", text: "a" }]);
  assert.deepEqual(diffLines("a\n", "a\n"), [{ op: "same", text: "a" }]);
  assert.equal(diffLines("x\n".repeat(3000) + "a", "y\n".repeat(3000) + "b"), null);
});

test("a diff table folds long unchanged runs and escapes record text", () => {
  const before = `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const html = diffHtml(before, before.replace("line 10", "<line ten>"), { beforeLabel: "current record", afterLabel: "saved local copy" });
  assert.match(html, /7 unchanged lines/);
  assert.match(html, /6 unchanged lines/);
  assert.match(html, /&lt;line ten&gt;/);
  assert.match(html, /− current record/);
  assert.match(diffHtml("a", "a"), /identical/);
});

test("the status bar names where records live and the sync state", () => {
  const now = Date.parse("2026-11-03T02:00:00Z");
  assert.equal(storeItem({ kind: "project", label: ".prism" }).label, "Records in project");
  assert.equal(storeItem({ kind: "folder", label: "../store", location: "/x/store", sync: true }).label, "Store ../store");
  assert.equal(storeItem({ kind: "remote", label: "https://github.com/o/s", unavailable: "no clone" }).tone, "danger");
  assert.equal(syncItem({ kind: "project" }, null), null);
  assert.equal(syncItem({ kind: "folder", sync: false }, null).label, "Sync off");
  assert.equal(syncItem({ kind: "folder", sync: true }, null).label, "Not synced yet");
  assert.deepEqual(syncItem({ kind: "remote", sync: true }, { state: "ok", at: "2026-11-03T01:57:00Z" }, now), { label: "Synced 3 min ago", tone: "ok", problem: false });
  assert.deepEqual(syncItem({ kind: "remote", sync: true }, { state: "fetch_failed", at: "2026-11-03T01:59:30Z" }, now), { label: "Records not fetched · just now", tone: "danger", problem: true });
  assert.equal(syncItem({ kind: "remote", sync: true }, { state: "conflicts", at: "2026-11-03T01:00:00Z" }, now).tone, "warn");
});

test("the status bar warns of checkout files a tool call still moves and notes plainly the files a move kept", () => {
  const store = { kind: "folder", label: "../store", location: "/x/store", sync: false };
  const awaitingMove = { files: 2, message: "2 files wait for a tool call." };
  const keptInCheckout = { files: 1, message: "1 file stays until a person settles it." };
  const kept = storeItem({ ...store, keptInCheckout });
  assert.deepEqual([kept.label, kept.tone], ["Store ../store · 1 file kept in checkout", "muted"]);
  assert.match(kept.title, /person settles/);
  const both = storeItem({ ...store, awaitingMove, keptInCheckout });
  assert.deepEqual([both.label, both.tone], ["Store ../store · 2 files to move", "warn"]);
  assert.match(both.title, /tool call[\s\S]*person settles/);
});

test("the store's details say how quickly changes made outside Prism show, and name each folder that is checked instead of watched", () => {
  assert.equal(outsideChanges(null), null, "nothing is said when the server did not say");
  assert.deepEqual(outsideChanges({ unwatched: [], targets: 4 }), { row: "Shown at once", message: null, folders: [] });
  const some = outsideChanges({ unwatched: [{ path: "/mnt/c/Users/me/store", reason: "wsl" }, { path: "/Volumes/share/specs", reason: "network" }], targets: 5 });
  assert.equal(some.row, "Shown at once, except two folders checked every 5 seconds");
  assert.match(some.message, /^Two folders can't be watched, so Prism checks them every 5 seconds instead\./);
  assert.deepEqual(some.folders.map((folder) => folder.reason), ["A Windows drive seen from WSL, which reports no changes made from Windows", "A network drive, which reports no changes made on other computers"]);
  const one = outsideChanges({ unwatched: [{ path: "/srv/records", reason: "unwatchable" }], targets: 1 });
  assert.equal(one.row, "Checked every 5 seconds", "a root with nothing watched says so without an exception");
  assert.match(one.message, /^One folder can't be watched, so Prism checks it every/);
  const windows = outsideChanges({ unwatched: [{ path: "C:\\store", reason: "windows" }, { path: "C:\\work\\.prism", reason: "windows" }], targets: 2 });
  assert.equal(windows.row, "Checked every 5 seconds");
  assert.match(windows.message, /^On Windows, a folder that Prism watches can't be moved or deleted/);
  assert.deepEqual(windows.folders, [], "on Windows no folder is listed, since none is watched");
});
