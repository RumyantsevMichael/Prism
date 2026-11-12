import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, isolateGit, requirementFile } from "./fixtures/workspace-artifacts.mjs";

// A sync never merges while files under the artifact lock are uncommitted on disk because an artifact update held that lock: it does nothing, ends as skipped rather than failed, and the next sync tries again.
const environment = await isolateGit();
const { withFileLock } = await import("../../dist/server/workflow/artifact-store.mjs");
const { cancelRecordSyncs, configureRecordSync, readSyncStatus, syncRecordStore, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const rec = (value) => `${JSON.stringify(value)}\n`;
const W = "requirements/billing.md";
const W2 = "requirements/ledger.md";
const CNAME = "2026-11-09T10-00-02-000Z-0123abce.json";
const MINE = `artifact-comments/${W}/${CNAME}`;
const artifactOf = (location, id) => ({ [`artifacts/${location}`]: requirementFile(id), [`artifact-identity/${location}`]: rec({ id: id.repeat(32) }), [`artifact-status/${location}/status.json`]: rec({ status: "Draft" }) });
const comment = (text) => rec({ location: W, version: `sha256:${"0".repeat(64)}`, line: 1, text, author: { name: "Ada", host: "vm" }, at: "2026-11-09T10:00:02.000Z", entry: "a".repeat(32), by: { name: "Ada", email: null, checkout: "c" }, via: "review-app" });
const idAt = (cwd, location) => { try { return JSON.parse(git(cwd, ["show", `main:artifact-identity/${location}`])).id[0]; } catch { return null; } };
const comments = (remote) => git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter((file) => file.startsWith("artifact-comments/"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    if (contents === null) { await rm(target, { force: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function push(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  git(root, ["push", "-q", "origin", "main"]);
}

// Two machines' stores cloned from one bare remote that holds a README and the artifact at W, and this machine's comment on it, on disk and in no commit yet;
// the other machine then moves the artifact away from W, or removes it, and writes a new artifact there.
async function stores(context, kind) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-lock-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "a"]);
  const a = path.join(parent, "a");
  git(a, ["checkout", "-q", "-b", "main"]);
  await put(a, { "README.md": "Prism store\n", ...artifactOf(W, "1") });
  push(a, "init");
  git(parent, ["clone", "-q", remote, "b"]);
  const b = path.join(parent, "b");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  await put(b, { [MINE]: comment("about the first artifact") });
  await put(a, Object.fromEntries(Object.keys(artifactOf(W, "1")).map((file) => [file, null])));
  if (kind === "moves") await put(a, artifactOf(W2, "1"));
  push(a, kind);
  await put(a, artifactOf(W, "2"));
  push(a, "a new artifact at the old place");
  return { remote, b };
}

// A sync of b that starts while an artifact update holds the artifact lock for ms milliseconds, run once or, as a caller that waits for its sync does, until it is not skipped.
async function syncWhileLocked(b, ms, sync = syncRecordStore) {
  const held = withFileLock(path.join(b, "artifacts"), () => sleep(ms));
  await sleep(50);
  const status = await sync(b);
  await held;
  return status;
}

for (const kind of ["moves", "removes"]) {
  test(`a sync that finds an update holding the artifact lock commits, merges, and pushes nothing and ends as skipped, so a comment on disk never lands on a new artifact at its place where the other machine ${kind} its artifact`, { timeout: 120000 }, async (context) => {
    const { remote, b } = await stores(context, kind);
    const head = git(b, ["rev-parse", "HEAD"]);
    const tip = git(remote, ["rev-parse", "main"]);
    const shown = await readSyncStatus(b);
    const status = await syncWhileLocked(b, 1500);
    assert.deepEqual(status, { state: "skipped" }, "a busy lock is no failure");
    assert.deepEqual(await readSyncStatus(b), shown, "and the status that the review app shows stays as it was");
    assert.equal(git(b, ["rev-parse", "HEAD"]), head, "the branch stays");
    assert.equal(git(b, ["rev-parse", "refs/remotes/origin/main"]), head, "and the sync did not fetch");
    assert.equal(git(remote, ["rev-parse", "main"]), tip, "nothing is pushed");
    assert.equal(await readFile(path.join(b, ...MINE.split("/")), "utf8"), comment("about the first artifact"), "the comment stays on disk as it was");
    const next = await syncRecordStoreNow(b);
    assert.ok(["ok", "conflicts"].includes(next.state), JSON.stringify(next));
    if (kind === "removes") assert.ok(next.conflicts.some((conflict) => conflict.path === MINE), `a comment whose artifact is gone is saved and named: ${JSON.stringify(next)}`);
    assert.equal(idAt(remote, W), "2");
    assert.deepEqual(comments(remote), kind === "moves" ? [`artifact-comments/${W2}/${CNAME}`] : [], "the comment follows its artifact's identity and never lands on the new artifact");
  });
}

test("a caller that waits for its sync, as a claim's confirming sync does, retries a sync that found an update holding the artifact lock, and its sync merges once the update is done", { timeout: 120000 }, async (context) => {
  const { remote, b } = await stores(context, "moves");
  const status = await syncWhileLocked(b, 400, syncRecordStoreNow);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["rev-parse", "main"]), git(b, ["rev-parse", "HEAD"]));
  assert.deepEqual(comments(remote), [`artifact-comments/${W2}/${CNAME}`]);
});
