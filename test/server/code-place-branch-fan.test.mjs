import assert from "node:assert/strict";
import test from "node:test";

// Requirements: docs/requirements/code-place.md §7.
// Contract: docs/plans/code-place/slice.md clauses 8 and 12, through the branch model's readBranches,
// for a repository where many branches point at the one commit that other branches were built on, which anyone who can push sets.
const { readBranches } = await import("../../dist/server/review/code-branches.mjs");

test("many branches at one nearest tip keep the base choice's work per branch constant and give way to other work", async () => {
  // main, 40000 branches at one commit X on main, and 500 branches each one commit on X, so X is the nearest tip of each of the 500.
  const shared = 40000;
  const children = 500;
  const tips = ["a".repeat(40), "b".repeat(40)];
  const at = "1970-01-01T00:00:00.000Z";
  const branches = [{ name: "main", commit: tips[0], committedAt: at, tip: 0 }];
  for (let index = 0; index < shared; index += 1) branches.push({ name: `x${String(index).padStart(6, "0")}`, commit: tips[1], committedAt: at, tip: 1 });
  for (let index = 0; index < children; index += 1) {
    tips.push(String(index).padStart(40, "0"));
    branches.push({ name: `y${String(index).padStart(6, "0")}`, commit: tips.at(-1), committedAt: at, tip: tips.length - 1 });
  }
  const size = tips.length;
  const facts = {
    key: "k", defaultBranch: "main", branches, tips, mainTip: 0,
    totals: Uint32Array.from({ length: size }, (_, tip) => tip + 1),
    ownOfMain: Uint32Array.from({ length: size }, (_, tip) => (tip === 0 ? 0 : tip === 1 ? 1 : 2)),
    merges: new Uint32Array(size),
    nearest: Int32Array.from({ length: size }, (_, tip) => (tip > 1 ? 1 : -1)),
    ownOfNearest: Uint32Array.from({ length: size }, (_, tip) => (tip > 1 ? 1 : 0)),
    columns: new Map(), pairs: new Map()
  };
  // Git answers at once, so the time between timer ticks is the branch model's own synchronous work.
  const fakeGit = async (args) => (args[0] === "merge-base"
    ? { ok: true, text: tips[1], stdout: Buffer.from(tips[1]) }
    : { ok: true, text: args[0] === "rev-list" ? "1" : "", stdout: Buffer.alloc(0) });
  let longest = 0;
  let last = performance.now();
  const ticking = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  const model = await readBranches(fakeGit, facts, new Set());
  clearInterval(ticking);
  assert.equal(model.branches.find((branch) => branch.name === "y000000").base, "x000000", "a branch built on X takes the first ranked branch at X as its base");
  assert.ok(longest < 1000, `the base choice held the event loop for ${Math.round(longest)} ms in one turn, though each of the ${children} branches has a constant number of candidate commits`);
});
