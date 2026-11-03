import assert from "node:assert/strict";
import test from "node:test";

const { diffHtml, diffLines } = await import("../../dist/server/review/public/views/line-diff.js");
const { storeItem, syncItem } = await import("../../dist/server/review/public/views/record-store.js");

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
