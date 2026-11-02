import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Git runs with a private home and configuration and a fixed identity.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-code-links-data-")));
await writeFile(path.join(privateData, "gitconfig"), "");
Object.assign(process.env, {
  PLUGIN_DATA: privateData, HOME: privateData, GIT_CONFIG_GLOBAL: path.join(privateData, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { publicRemote, verificationBrief, verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { appendRecord, forgetMigrations, listRecordEntries } = await import("../../dist/server/workflow/record-store.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
const { codeLine } = await import("../../dist/server/review/public/views/slice.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const RUNS = { kind: "runs", initiative: INITIATIVE, slice: "download" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function files(root, workflow) {
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n${workflow}`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
}

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-code-links-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  forgetMigrations();
  return parent;
}

// A project with an initiative whose download slice has a started, accepted design.
async function initiative(root) {
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [
    { op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] },
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }], evidence: await splitEvidence(root, `docs/plans/${INITIATIVE}`, "download") }
  ] });
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "set_status", slug: "download", status: "in-progress" }, { op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }] });
}

async function project(context, { commit = true } = {}) {
  const root = path.join(await folder(context), "project");
  await files(root, "");
  git(root, "init", "-q", "-b", "main");
  if (commit) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  await initiative(root);
  return root;
}

// The first run asks for approval, and the browser's Allow answer lets the next call run.
async function verify(root) {
  let result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  if (result.status === "approval_needed") {
    await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: result.gateId, choice: "allow" });
    result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: result.gateId });
  }
  assert.equal(result.status, "passed");
  return result;
}

test("a run records its checkout, and the remote never keeps credentials", async (context) => {
  const root = await project(context);
  git(root, "remote", "add", "origin", "https://user:token@example.com/o/r.git");
  const clean = await verify(root);
  assert.deepEqual(clean.checkout, { repository: git(root, "rev-list", "--max-parents=0", "HEAD"), remote: "https://example.com/o/r.git", branch: "main", head: git(root, "rev-parse", "HEAD"), dirty: false });
  assert.deepEqual(verificationBrief(clean).code, clean.checkout);
  await writeFile(path.join(root, "source.mjs"), "export const value = 2;\n");
  const changed = await verify(root);
  assert.equal(changed.checkout.dirty, true);
  const stored = (await listRecordEntries(root, RUNS)).map((item) => item.entry.checkout);
  assert.deepEqual(stored.map((item) => item.dirty), [false, true]);
  assert.equal(JSON.stringify(stored).includes("token"), false);
  assert.equal(publicRemote("git@github.com:owner/repo.git"), "github.com:owner/repo.git");
  assert.equal(publicRemote("ssh://deploy:secret@host:2222/owner/repo.git"), "ssh://host:2222/owner/repo.git");
});

test("a detached head has no branch, and a project without commits records nulls and still passes", async (context) => {
  const detached = await project(context);
  git(detached, "checkout", "-q", "--detach");
  const run = await verify(detached);
  assert.equal(run.checkout.branch, null);
  assert.equal(run.checkout.head, git(detached, "rev-parse", "HEAD"));
  assert.equal(run.checkout.remote, null);
  const empty = await project(context, { commit: false });
  const unborn = await verify(empty);
  assert.equal(unborn.checkout.repository, null);
  assert.equal(unborn.checkout.head, null);
  assert.equal(unborn.checkout.dirty, null);
});

test("get_initiative shows the latest passing run's code, and an older run without a checkout shows none", async (context) => {
  const root = await project(context);
  const run = await verify(root);
  assert.deepEqual((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).code, { download: run.checkout });
  await appendRecord(root, RUNS, "verification-999999999999999-legacy", { kind: "verification", passed: true, tree: run.tree, designAcceptedAt: run.designAcceptedAt });
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).code, undefined);
  assert.match(codeLine(run.checkout), /Verified on main at <code>[0-9a-f]{7}<\/code>/);
  assert.equal(codeLine(null), "");
});

test("two worktrees that share a store record their own branches, and the summary follows the latest passing run", async (context) => {
  const parent = await folder(context);
  const a = path.join(parent, "a"), b = path.join(parent, "b");
  await mkdir(path.join(parent, "store"));
  await files(a, "\n## Workspace\n- Store: ../store\n");
  git(a, "init", "-q", "-b", "main");
  git(a, "remote", "add", "origin", "git@github.com:owner/repo.git");
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "init");
  git(a, "worktree", "add", "-q", "-b", "feature/x", b);
  await initiative(a);
  assert.equal((await verify(a)).checkout.branch, "main");
  const fromB = await verify(b);
  assert.equal(fromB.checkout.branch, "feature/x");
  assert.equal((await getInitiative({ projectRoot: a, initiative: INITIATIVE })).code.download.branch, "feature/x");
  assert.match(codeLine(fromB.checkout), /Verified on feature\/x at <code>[0-9a-f]{7}<\/code> · github\.com\/owner\/repo/);
  await verify(a);
  assert.equal((await getInitiative({ projectRoot: b, initiative: INITIATIVE })).code.download.branch, "main");
});
