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
const { codeChip, remoteWeb } = await import("../../dist/server/review/public/views/code-location.js");
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
});

test("a recorded remote keeps only scheme, host, and path of a network remote", () => {
  assert.equal(publicRemote("https://user:token@example.com/o/r.git"), "https://example.com/o/r.git");
  assert.equal(publicRemote("https://example.com/o/r.git?access_token=secret"), "https://example.com/o/r.git");
  assert.equal(publicRemote("https://example.com/o/r.git#tok"), "https://example.com/o/r.git");
  assert.equal(publicRemote("http://example.com/o/r"), "http://example.com/o/r");
  assert.equal(publicRemote("ssh://deploy:secret@host:2222/owner/repo.git"), "ssh://host:2222/owner/repo.git");
  assert.equal(publicRemote("git://example.com/o/r.git"), "git://example.com/o/r.git");
  assert.equal(publicRemote("git@github.com:owner/repo.git"), "github.com:owner/repo.git");
  assert.equal(publicRemote("user:pass@github.com:owner/repo.git"), "github.com:owner/repo.git");
  assert.equal(publicRemote("github.com:owner/repo.git?token=x"), "github.com:owner/repo.git");
  for (const local of ["ext::ssh -i key host %S", "file:///srv/repo.git", "/srv/repo.git", "../repo", "C:/repo", "C:\\repo", "ftp://example.com/r", "", null]) assert.equal(publicRemote(local), null, String(local));
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
  assert.match(codeLine(run.checkout), /Last passing run on main at <code>[0-9a-f]{7}<\/code>/);
  assert.equal(codeLine(null), "");
  assert.equal(codeLine({ head: 42 }), "");
  assert.equal(codeLine({ head: "1a2b3c4d", branch: { name: "x" }, remote: ["x"] }), '<p class="muted">Last passing run at <code>1a2b3c4</code></p>');
});

test("two worktrees that share a store record their own branches, and the summary follows the latest passing run", async (context) => {
  const parent = await folder(context);
  const a = path.join(parent, "a"), b = path.join(parent, "b");
  await mkdir(path.join(parent, "store"));
  await files(a, "\n## Workspace\n- Store: ../store\n- Repository: project\n");
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
  const line = codeLine(fromB.checkout);
  assert.match(line, /Last passing run on <a [^>]*href="https:\/\/github\.com\/owner\/repo\/tree\/feature\/x"[^>]*>feature\/x<\/a> at <a [^>]*href="https:\/\/github\.com\/owner\/repo\/commit\/[0-9a-f]{40}"[^>]*><code>[0-9a-f]{7}<\/code><\/a> · <a [^>]*href="https:\/\/github\.com\/owner\/repo"[^>]*>github\.com\/owner\/repo<\/a>/);
  await verify(a);
  assert.equal((await getInitiative({ projectRoot: b, initiative: INITIATIVE })).code.download.branch, "main");
});

test("a contract-defect report records its checkout without judging uncommitted changes", async (context) => {
  const root = await project(context);
  const result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", contractDefects: [{ clause: "1", reason: "The clause contradicts the requirement." }] });
  assert.equal(result.status, "defects_recorded");
  const [entry] = (await listRecordEntries(root, RUNS)).map((item) => item.entry);
  assert.equal(entry.kind, "contract-defect");
  assert.equal(entry.checkout.head, git(root, "rev-parse", "HEAD"));
  assert.equal(entry.checkout.dirty, null);
});

test("code locations link to the remote's web pages only on a known host", () => {
  assert.equal(remoteWeb("github.com:owner/repo.git").url, "https://github.com/owner/repo");
  assert.equal(remoteWeb("https://github.com/owner/repo.git").url, "https://github.com/owner/repo");
  assert.equal(remoteWeb("ssh://gitlab.com:2222/group/sub/repo.git").url, "https://gitlab.com/group/sub/repo");
  assert.equal(remoteWeb("bitbucket.org:team/repo.git").url, "https://bitbucket.org/team/repo");
  for (const other of ["git.example.com:owner/repo.git", "https://github.com/owner", "https://github.com/../x", null, ""]) assert.equal(remoteWeb(other), null, String(other));
  const head = "0123456789abcdef0123456789abcdef01234567";
  assert.match(codeLine({ head, branch: "fix/a b", remote: "gitlab.com:g/r.git" }), /href="https:\/\/gitlab\.com\/g\/r\/-\/tree\/fix\/a%20b"/);
  assert.match(codeLine({ head, branch: "main", remote: "bitbucket.org:t/r.git" }), /href="https:\/\/bitbucket\.org\/t\/r\/commits\/0123456789abcdef/);
  assert.equal(codeLine({ head, branch: "main", remote: "git.example.com:o/r.git" }), '<p class="muted">Last passing run on main at <code>0123456</code> · git.example.com/o/r</p>');
  assert.equal(codeLine({ head, branch: "<b>", remote: null }), '<p class="muted">Last passing run on &lt;b&gt; at <code>0123456</code></p>');
  assert.match(codeChip({ head, branch: "main", remote: "github.com:o/r.git", dirty: true }), /main<\/a> · <a [^>]*><code>0123456<\/code><\/a><span class="code-dirty"/);
  assert.equal(codeChip(null), "");
});
