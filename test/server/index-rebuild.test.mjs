import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectReview } from "../../dist/server/review/review-server.mjs";
import { createWriteSessions } from "../../dist/server/review/write-sessions.mjs";
import { panelHtml } from "../../dist/server/review/public/views/indexing.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Git project whose only index was built for another work tree, so the review page reads it as out of date.
async function staleProject(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-rebuild-")));
  const storage = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-rebuild-index-")));
  context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(storage, { recursive: true, force: true })]));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  const directory = path.join(storage, "projects", createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "current.json"), JSON.stringify({ snapshot: "s1", builtAt: new Date().toISOString() }));
  await writeFile(path.join(directory, "freshness.json"), JSON.stringify({ snapshot: "s1", git: { head: "old", worktree: "old" }, checkedAt: new Date().toISOString() }));
  return { root, storage };
}

async function serve(context, review) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    void review.handle(request, response, url.pathname, url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, { method = "GET", headers = {}, body } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers, body });
    return { status: response.status, body: await response.text() };
  };
}

function reviewOf(root, storage, { auto = true, writeSessions = null } = {}) {
  const calls = [];
  const review = createProjectReview({ projectRoot: root, baseUrl: "http://127.0.0.1/", intelligenceDirectories: () => [storage], writeSessions,
    rebuildIndex: async (projectRoot) => { calls.push(projectRoot); }, autoRebuild: async () => auto, rebuildTiming: { quietMs: 300, gapMs: 1500, freshnessMs: 0 } });
  return { review, calls };
}

test("an open page rebuilds an out-of-date index once the files stay unchanged, and at most once per gap", async (context) => {
  const { root, storage } = await staleProject(context);
  const { review, calls } = reviewOf(root, storage);
  const call = await serve(context, review);
  const first = JSON.parse((await call("/api/indexing")).body);
  assert.deepEqual([first.state, first.stale, first.autoRebuild], ["ready", true, true]);
  assert.equal(calls.length, 0, "the files have not been quiet long enough yet");
  await writeFile(path.join(root, "source.mjs"), "export const value = 22;\n");
  await call("/api/indexing");
  await pause(350);
  await call("/api/indexing");
  assert.deepEqual(calls, [root], "one rebuild after the edits stopped");
  await call("/api/indexing");
  assert.equal(calls.length, 1, "no second rebuild inside the gap");
});

test("background indexing off leaves rebuilding to the person, whose request must come from the page as JSON", async (context) => {
  const { root, storage } = await staleProject(context);
  const writeSessions = await createWriteSessions();
  const { review, calls } = reviewOf(root, storage, { auto: false, writeSessions });
  const call = await serve(context, review);
  const token = { "X-Prism-Write": await writeSessions.exchange(writeSessions.issueGrant()) };
  await call("/api/indexing");
  await pause(350);
  const status = JSON.parse((await call("/api/indexing")).body);
  assert.equal(status.autoRebuild, false);
  assert.equal(calls.length, 0);
  assert.match(panelHtml(status), /Rebuild index/);
  assert.match(panelHtml(status), /only when you ask/);
  // The rebuild records its history entry in Prism's application folder, so the test gives it a folder of its own.
  const appFolder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-rebuild-app-")));
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = appFolder;
  context.after(() => {
    if (previous === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = previous;
    return rm(appFolder, { recursive: true, force: true });
  });
  const body = JSON.stringify({ action: "index.rebuild", target: "index:root/root", input: {}, revision: null });
  assert.equal((await call("/api/actions/apply", { method: "POST", headers: token, body })).status, 403);
  assert.equal((await call("/api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example", ...token }, body })).status, 403);
  assert.equal((await call("/api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403, "a request without a write session is refused");
  assert.equal((await call("/api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...token }, body })).status, 200);
  assert.deepEqual(calls, [root]);
  assert.doesNotMatch(panelHtml({ ...status, state: "preparing", progress: { phase: "embedding", current: 1, total: 2 } }), /Rebuild index/, "a running build has no rebuild button");
});

test("a rebuild joins the one running in this process and a later request starts another", async () => {
  const { startIndexRebuild } = await import("../../dist/server/repository-intelligence/background-preparation.mjs");
  let builds = 0, finish;
  const prepare = () => { builds++; return new Promise((resolve) => { finish = resolve; }); };
  const options = { prepare, available: async () => true, record: async () => {} };
  const first = startIndexRebuild("/project", options);
  assert.equal(startIndexRebuild("/project", options), first);
  await pause(10);
  finish();
  await first;
  const second = startIndexRebuild("/project", options);
  await pause(10);
  finish();
  await second;
  assert.equal(builds, 2);
  assert.equal(await startIndexRebuild("/project", { ...options, available: async () => false }), undefined);
  assert.equal(builds, 2, "a platform without a runtime builds nothing");
});
