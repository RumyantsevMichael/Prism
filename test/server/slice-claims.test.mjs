import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Git runs with a private home and configuration, a fixed identity, and only local repositories.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-claims-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { cancelRecordSyncs, configureRecordSync, readSyncStatus, syncRecordStore, takeSavedConflicts } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { forgetMigrations } = await import("../../dist/server/workflow/record-store.mjs");
const CLAIM_FILE = (slug) => `initiatives/reports/claims/${slug}.json`;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { claimHolder, configureClaims, heldClaims, renewHeldClaims, stopClaimRenewals } = await import("../../dist/server/workflow/slice-claims.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { withFileLock } = await import("../../dist/server/workflow/artifact-store.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
// Syncs run only when a test or a claim calls them, so each test controls its own ordering.
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
const PROCESS_HOLDER = claimHolder();
test.after(async () => { cancelRecordSyncs(); stopClaimRenewals(); await rm(environment, { recursive: true, force: true }); });

// One test process plays several Prism servers, each with its own holder and label.
const A = { holder: "aaaaaaaaaaaaaaaa", label: "Ada on alpha" };
const B = { holder: "bbbbbbbbbbbbbbbb", label: "Bob on beta" };
const as = (server) => configureClaims(server);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);
const storeConfig = (store, sync) => `## Paths\n- Plans (scratch): docs/plans/\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n\n## Workspace\n- Store: ../${store}\n${sync ? `- Store sync: ${sync}\n` : ""}`;
const read = (root) => getInitiative({ projectRoot: root, initiative: "reports" });
const write = async (root, operations, actor = path.basename(root)) => updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: (await read(root)).revision, actor, operations });
const start = (root, slug) => write(root, [{ op: "set_status", slug, status: "in-progress" }]);
const refusal = (code, check = () => true) => (error) => { assert.equal(error.code, code, error.message); check(error); return true; };

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-claims-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  context.after(() => { stopClaimRenewals(); configureClaims({ leaseMs: 30 * 60 * 1000, renewMs: 10 * 60 * 1000, holder: PROCESS_HOLDER, label: null }); });
  forgetMigrations();
  return parent;
}

async function project(parent, name, config) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), config);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  return root;
}

const create = async (root) => updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: null, operations: [
  { op: "create", slug: "reports", title: "Reports", requirements: ["r.md#R1", "r.md#R2"] },
  { op: "split", parent: "reports", children: [{ slug: "s1", title: "First", requirements: ["r.md#R1"] }, { slug: "s2", title: "Second", requirements: ["r.md#R2"] }], evidence: await splitEvidence(root, "docs/plans/reports", "s1") }
] });

// Two machines: each has a project whose synced store is a clone of one bare remote, and both hold one initiative with slices s1 and s2.
async function machines(context) {
  const parent = await folder(context);
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", "remote.git", "store-a");
  const storeA = path.join(parent, "store-a");
  git(storeA, "checkout", "-q", "-b", "main");
  await writeFile(path.join(storeA, "README.md"), "Prism records\n");
  git(storeA, "add", ".");
  git(storeA, "commit", "-q", "-m", "init");
  git(storeA, "push", "-q", "-u", "origin", "main");
  git(parent, "clone", "-q", "remote.git", "store-b");
  const value = {
    parent, storeA, storeB: path.join(parent, "store-b"), remote: path.join(parent, "remote.git"),
    a: await project(parent, "project-a", storeConfig("store-a", "on")), b: await project(parent, "project-b", storeConfig("store-b", "on"))
  };
  await create(value.a);
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  return value;
}

// Two worktrees on one machine share a store folder that does not sync.
async function worktrees(context) {
  const parent = await folder(context);
  await mkdir(path.join(parent, "store"));
  const value = { parent, a: await project(parent, "worktree-a", storeConfig("store")), b: await project(parent, "worktree-b", storeConfig("store")) };
  await create(value.a);
  return value;
}

test("refuses the second machine's start of a slice that the first machine claimed and synced", async (context) => {
  const value = await machines(context);
  as(A);
  const first = await start(value.a, "s1");
  const brief = initiativeAcknowledgement(first, [{ op: "set_status", slug: "s1", status: "in-progress" }]);
  assert.equal(brief.claimConfirmation, "sync");
  assert.equal(brief.slices.s1.claim.label, "Ada on alpha");
  assert.equal(brief.slices.s1.claim.activity, "implementation");
  assert.match(git(value.remote, "ls-tree", "-r", "--name-only", "main"), /initiatives\/reports\/claims\/s1\.json/, "the claim reached the remote before the write returned");
  assert.doesNotMatch(await readFile(path.join(value.storeA, "initiatives/reports/initiative.json"), "utf8"), /holder/, "the initiative record holds no claim");
  as(B);
  const before = await read(value.b);
  await assert.rejects(write(value.b, [{ op: "update_slice", slug: "s2", title: "Second from B" }, { op: "set_status", slug: "s1", status: "in-progress" }]), refusal("slice_claimed", (error) => {
    assert.match(error.message, /claimed by Ada on alpha for implementation until /);
    assert.deepEqual([error.claim.slug, error.claim.label, error.claim.activity, error.claim.holder], ["s1", "Ada on alpha", "implementation", A.holder]);
  }));
  const after = await read(value.b);
  assert.equal(after.record.slices.s1.claim.holder, A.holder, "the second machine's store shows the first claim");
  assert.deepEqual(after.claims, { s1: { label: "Ada on alpha", activity: "implementation", expiresAt: after.record.slices.s1.claim.expiresAt, heldHere: false } });
  assert.equal(after.record.slices.s2.title, "Second", "the refused update applied none of its operations");
  assert.equal(after.record.slices.s1.status, "not-started");
  assert.equal(after.revision, before.revision, "the refused update never wrote the initiative record");
  assert.equal(git(value.remote, "rev-parse", "main"), git(value.storeB, "rev-parse", "HEAD"), "the second store ends in step with the remote");
  assert.equal(git(value.storeB, "status", "--porcelain"), "");
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(value.storeB)), [], "the refusal already reported the lost claim");
  const status = await readSyncStatus(value.storeB);
  assert.deepEqual([status.state, status.conflicts], ["ok", []], "the review browser shows no saved record for a lost claim");
  assert.deepEqual(heldClaims().map((item) => [item.slug, item.holder]), [["s1", A.holder]]);
});

test("lets two machines start independent slices of one initiative and keeps both claims", async (context) => {
  const value = await machines(context);
  as(A);
  assert.equal((await start(value.a, "s1")).claims.confirmation, "sync");
  as(B);
  const second = await start(value.b, "s2");
  assert.equal(second.claims.confirmation, "sync");
  assert.equal(second.record.slices.s1.claim.holder, A.holder, "the confirming sync brought the first machine's claim");
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  const [onA, onB] = [await read(value.a), await read(value.b)];
  assert.equal(onA.revision, onB.revision);
  assert.deepEqual(Object.fromEntries(Object.entries(onA.claims).map(([slug, claim]) => [slug, claim.label])), { s1: "Ada on alpha", s2: "Bob on beta" });
  assert.equal(onA.claims.s2.heldHere, true, "B is the current server of the test process");
  assert.deepEqual([onA.record.slices.s1.status, onA.record.slices.s2.status], ["in-progress", "in-progress"]);
});

test("refuses a claim that cannot reach the remote and changes nothing else", async (context) => {
  const value = await machines(context);
  as(A);
  await writeFile(path.join(value.a, "test", "first.test.mjs"), "// frozen first test\n");
  await write(value.a, [{ op: "accept_design", slug: "s1", frozenTests: ["test/first.test.mjs"], review: "none" }]);
  assert.equal(await exists(path.join(value.a, "test", "first.test.mjs")), false, "accepting the design staged the test");
  const before = await read(value.a);
  await rename(value.remote, `${value.remote}.away`);
  await assert.rejects(start(value.a, "s1"), refusal("claim_unconfirmed", (error) => {
    assert.equal(error.syncState, "fetch_failed");
    assert.match(error.message, /could not be confirmed with the record store's remote \(fetch_failed/);
  }));
  const after = await read(value.a);
  assert.equal(after.revision, before.revision, "the initiative record was never written");
  assert.equal(after.claims, undefined);
  assert.equal(await exists(path.join(value.storeA, CLAIM_FILE("s1"))), false, "the claim record was withdrawn");
  assert.equal(after.record.slices.s1.status, "not-started");
  assert.equal(after.record.slices.s1.design.staged, true);
  assert.equal(await exists(path.join(value.a, "test", "first.test.mjs")), false, "the refused start put no frozen test in place");
  assert.deepEqual(heldClaims(), []);
  await rename(`${value.remote}.away`, value.remote);
  const started = await start(value.a, "s1");
  assert.equal(started.claims.confirmation, "sync");
  assert.equal(await exists(path.join(value.a, "test", "first.test.mjs")), true);
});

test("refuses a second start of a claimed slice from another worktree without sync", async (context) => {
  const value = await worktrees(context);
  as(A);
  const first = await start(value.a, "s1");
  assert.equal(first.claims.confirmation, "local");
  as(B);
  await assert.rejects(start(value.b, "s1"), refusal("slice_claimed", (error) => assert.equal(error.claim.label, "Ada on alpha")));
  await assert.rejects(start(value.a, "s1"), refusal("slice_claimed"), "the same checkout under another server is refused too");
  assert.equal((await start(value.b, "s2")).claims.confirmation, "local");
  as(A);
  const again = await start(value.a, "s1");
  assert.equal(again.record.slices.s1.claim.claimedAt, first.record.slices.s1.claim.claimedAt, "the holder's own start keeps when it first claimed the slice");
});

test("replaces an expired claim and names its holder", async (context) => {
  const value = await worktrees(context);
  as({ ...A, leaseMs: 1 });
  await start(value.a, "s1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  as({ ...B, leaseMs: 30 * 60 * 1000 });
  assert.equal((await read(value.b)).claims, undefined, "an expired claim is not shown as live");
  const operations = [{ op: "set_status", slug: "s1", status: "in-progress" }];
  const replaced = await write(value.b, operations);
  const brief = initiativeAcknowledgement(replaced, operations);
  assert.deepEqual(brief.replacedClaims.map((item) => [item.slug, item.holder, item.label, item.activity]), [["s1", A.holder, "Ada on alpha", "implementation"]]);
  assert.equal(replaced.record.slices.s1.claim.holder, B.holder);
  assert.equal(replaced.record.history.at(-1).replacedClaim.label, "Ada on alpha");
});

test("renews a running holder's claim record without touching the initiative record", async (context) => {
  const value = await worktrees(context);
  as({ ...A, renewMs: 40 });
  const taken = (await start(value.a, "s1")).record.slices.s1.claim;
  const before = await read(value.a);
  let renewed = taken;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && renewed.renewedAt === taken.renewedAt;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    renewed = (await read(value.a)).record.slices.s1.claim;
  }
  assert.ok(Date.parse(renewed.renewedAt) > Date.parse(taken.renewedAt), "renewedAt advances");
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(taken.expiresAt), "expiresAt advances");
  assert.equal(renewed.claimedAt, taken.claimedAt);
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(renewed.renewedAt), 30 * 60 * 1000, "a claim expires 30 minutes after its last renewal");
  assert.equal((await read(value.a)).revision, before.revision, "renewal leaves the initiative record alone");
  configureClaims({ renewMs: 10 * 60 * 1000 });
  await renewHeldClaims();
  as(B);
  await write(value.b, [{ op: "release_claim", slug: "s1" }]);
  as(A);
  await renewHeldClaims();
  assert.deepEqual(heldClaims(), [], "a released claim is no longer renewed");
  assert.equal(await exists(path.join(value.parent, "store", CLAIM_FILE("s1"))), false, "renewal never brings a released claim back");
  assert.deepEqual((await read(value.a)).lostClaims, [{ slug: "s1", reason: "released" }], "the next result for the initiative reports the lost claim once");
  assert.equal((await read(value.a)).lostClaims, undefined);
});

test("never revives an expired claim, even when another holder took the slice", async (context) => {
  const value = await worktrees(context);
  as({ ...A, leaseMs: 300 });
  await start(value.a, "s1");
  await start(value.a, "s2");
  await new Promise((resolve) => setTimeout(resolve, 400));
  as({ ...B, leaseMs: 30 * 60 * 1000 });
  await write(value.b, [{ op: "claim", slug: "reports" }]);
  const bytes = await readFile(path.join(value.parent, "store", CLAIM_FILE("reports")), "utf8");
  as({ ...A, leaseMs: 30 * 60 * 1000 });
  await renewHeldClaims();
  const kept = JSON.parse(await readFile(path.join(value.parent, "store", CLAIM_FILE("reports")), "utf8"));
  assert.deepEqual([kept.holder, kept.nonce], [JSON.parse(bytes).holder, JSON.parse(bytes).nonce], "the newer overlapping claim stays the other holder's");
  assert.equal(Date.parse(JSON.parse(await readFile(path.join(value.parent, "store", CLAIM_FILE("s1")), "utf8")).expiresAt) < Date.now(), true, "the expired claim stays expired");
  assert.deepEqual(heldClaims().filter((item) => item.holder === A.holder), []);
  assert.deepEqual((await read(value.a)).lostClaims.map((item) => [item.slug, item.reason]).sort(), [["s1", "expired"], ["s2", "expired"]]);
});

test("keeps renewing a claim whose holder's combined update was refused", async (context) => {
  const value = await worktrees(context);
  as(A);
  await start(value.a, "s1");
  as(B);
  await start(value.b, "s2");
  as(A);
  await assert.rejects(write(value.a, [{ op: "set_status", slug: "s1", status: "blocked" }, { op: "set_status", slug: "s2", status: "in-progress" }]), refusal("slice_claimed"));
  assert.deepEqual(heldClaims().filter((item) => item.holder === A.holder).map((item) => item.slug), ["s1"], "the refused update ended nothing");
  assert.equal((await read(value.a)).record.slices.s1.status, "in-progress");
  await renewHeldClaims();
  assert.equal((await read(value.a)).claims.s1.label, "Ada on alpha");
});

test("refuses a restart whose claim lost to another machine although this server held the slice before", async (context) => {
  const value = await machines(context);
  as(A);
  await start(value.a, "s1");
  as(B);
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  await write(value.b, [{ op: "release_claim", slug: "s1" }]);
  await write(value.b, [{ op: "set_status", slug: "s1", status: "in-progress" }]);
  as(A);
  await assert.rejects(write(value.a, [{ op: "set_status", slug: "s1", status: "in-progress" }]), refusal("slice_claimed", (error) => assert.equal(error.claim.label, "Bob on beta")));
  const onA = await read(value.a);
  assert.equal(onA.record.slices.s1.claim.holder, B.holder);
  assert.deepEqual(onA.lostClaims, [{ slug: "s1", reason: "replaced by Bob on beta" }], "the earlier claim is reported as lost");
});

test("keeps freshly frozen tests in the work tree when a sync refuses the update that accepted them", async (context) => {
  const value = await machines(context);
  as(A);
  await start(value.a, "s2");
  as(B);
  await writeFile(path.join(value.b, "test", "first.test.mjs"), "// frozen first test\n");
  const before = await read(value.b);
  await assert.rejects(write(value.b, [{ op: "accept_design", slug: "s1", frozenTests: ["test/first.test.mjs"], review: "none" }, { op: "set_status", slug: "s2", status: "in-progress" }]), refusal("slice_claimed"));
  assert.equal(await readFile(path.join(value.b, "test", "first.test.mjs"), "utf8"), "// frozen first test\n");
  const after = await read(value.b);
  assert.equal(after.revision, before.revision);
  assert.equal(after.record.slices.s1.design, undefined);
  const accepted = await write(value.b, [{ op: "accept_design", slug: "s1", frozenTests: ["test/first.test.mjs"], review: "none" }]);
  assert.equal(accepted.record.slices.s1.design.staged, true, "the test can still be accepted");
});

test("merges another machine's edit of a slice while its holder renews the claim", async (context) => {
  const value = await machines(context);
  as(A);
  await start(value.a, "s1");
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  as(B);
  await write(value.b, [{ op: "update_slice", slug: "s1", title: "First from B" }]);
  as(A);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renewHeldClaims();
  const renewed = JSON.parse(await readFile(path.join(value.storeA, CLAIM_FILE("s1")), "utf8"));
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  const status = await syncRecordStore(value.storeB);
  assert.deepEqual([status.state, status.conflicts], ["ok", []]);
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  for (const root of [value.a, value.b]) {
    const record = await read(root);
    assert.equal(record.record.slices.s1.title, "First from B");
    assert.equal(record.record.slices.s1.claim.renewedAt, renewed.renewedAt);
  }
});

test("refuses a release that a renewal pushed first, and tells the holder when a release wins", async (context) => {
  const value = await machines(context);
  as(A);
  await start(value.a, "s1");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renewHeldClaims();
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  as(B);
  await assert.rejects(write(value.b, [{ op: "release_claim", slug: "s1" }]), refusal("slice_claimed", (error) => assert.match(error.message, /renewed or taken by Ada on alpha/)));
  assert.equal((await read(value.b)).claims.s1.label, "Ada on alpha", "the renewed claim stays");
  const released = await write(value.b, [{ op: "release_claim", slug: "s1" }]);
  assert.equal(released.claims.confirmation, "sync");
  as(A);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renewHeldClaims();
  assert.equal((await syncRecordStore(value.storeA)).state, "ok", "a lost claim does not show as a saved record");
  assert.equal(await exists(path.join(value.storeA, CLAIM_FILE("s1"))), false, "the release that was pushed first wins");
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(value.storeA)), [], "a lost claim is not reported as a saved record");
  assert.deepEqual((await read(value.a)).lostClaims, [{ slug: "s1", reason: "released" }]);
});

test("releases another machine's claim and records who released whose claim", async (context) => {
  const value = await machines(context);
  as(A);
  await start(value.a, "s1");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  as(B);
  const operations = [{ op: "release_claim", slug: "s1" }];
  const released = await write(value.b, operations, "Bob");
  const brief = initiativeAcknowledgement(released, operations);
  assert.deepEqual(brief.releasedClaims.map((item) => [item.slug, item.label, item.holder]), [["s1", "Ada on alpha", A.holder]]);
  assert.equal(brief.slices.s1.claim, undefined);
  const entry = released.record.history.at(-1);
  assert.deepEqual([entry.actor, entry.operation, entry.slug, entry.released.label, entry.released.holder, entry.releasedBy.label, entry.releasedBy.holder], ["Bob", "release_claim", "s1", "Ada on alpha", A.holder, "Bob on beta", B.holder]);
  await assert.rejects(write(value.b, operations), /holds no claim/);
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await read(value.a)).record.slices.s1.claim, undefined);
  as(A);
  await renewHeldClaims();
  assert.deepEqual(heldClaims(), []);
});

test("ends a claim when the slice is done, blocked, or back to not-started", async (context) => {
  const parent = await folder(context);
  const root = await project(parent, "project", "## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: " + process.execPath + " check.mjs\n");
  await writeFile(path.join(root, "test", "first.test.mjs"), "// frozen first test\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await create(root);
  as(A);
  await write(root, [{ op: "set_status", slug: "s1", status: "in-progress" }, { op: "accept_design", slug: "s1", frozenTests: ["test/first.test.mjs"], review: "none" }]);
  assert.equal((await read(root)).record.slices.s1.claim.holder, A.holder);
  const asked = await verifySlice({ projectRoot: root, initiative: "reports", slice: "s1" });
  await answerUserGate({ projectRoot: root, initiative: "reports", id: asked.gateId, choice: "allow", note: null });
  const passed = await verifySlice({ projectRoot: root, initiative: "reports", slice: "s1", approvalGate: asked.gateId });
  assert.equal(passed.sliceStatus, "done");
  assert.equal((await read(root)).record.slices.s1.claim, undefined, "set_status done ends the claim");
  assert.equal(await exists(path.join(root, ".prism", CLAIM_FILE("s1"))), false);
  for (const status of ["blocked", "not-started"]) {
    await start(root, "s2");
    assert.ok((await read(root)).claims.s2);
    const ended = await write(root, [{ op: "set_status", slug: "s2", status }]);
    assert.deepEqual(ended.claims.ended.map((item) => item.slug), ["s2"]);
    assert.equal((await read(root)).record.slices.s2.claim, undefined, `${status} ends the claim`);
  }
  const both = await write(root, [{ op: "set_status", slug: "s2", status: "in-progress" }, { op: "set_status", slug: "s2", status: "blocked" }]);
  assert.equal(both.record.slices.s2.claim, undefined, "a claim that the same update ended is not kept");
  assert.deepEqual(both.claims.taken, []);
  assert.deepEqual(heldClaims(), []);
});

test("a design claim on a scope blocks an implementation claim inside it, and the reverse", async (context) => {
  const value = await worktrees(context);
  as(A);
  const before = await read(value.a);
  const claimed = await write(value.a, [{ op: "claim", slug: "reports" }]);
  const brief = initiativeAcknowledgement(claimed, [{ op: "claim", slug: "reports" }]);
  assert.deepEqual([brief.slices.reports.claim.activity, brief.claimConfirmation], ["design", "local"]);
  assert.equal(claimed.revision, before.revision, "a design claim writes no initiative history");
  as(B);
  await assert.rejects(start(value.b, "s1"), refusal("slice_claimed", (error) => {
    assert.deepEqual([error.claim.slug, error.claim.activity, error.claim.label], ["reports", "design", "Ada on alpha"]);
    assert.match(error.message, /through its claim on reports/);
  }));
  await write(value.b, [{ op: "release_claim", slug: "reports" }]);
  await start(value.b, "s1");
  as(A);
  await assert.rejects(write(value.a, [{ op: "claim", slug: "reports" }]), refusal("slice_claimed", (error) => assert.deepEqual([error.claim.slug, error.claim.activity, error.claim.label], ["s1", "implementation", "Bob on beta"])));
  await write(value.a, [{ op: "claim", slug: "s2" }]);
  await write(value.a, [{ op: "propose_design", slug: "s2", operations: [{ op: "update_slice", slug: "s2", title: "Second, designed" }] }]);
  assert.equal((await read(value.a)).claims.s2.activity, "design", "a pending proposal keeps the design claim");
  const accepted = await write(value.a, [{ op: "accept_proposal", slug: "s2", reviewRequired: [] }]);
  assert.equal(accepted.record.slices.s2.claim, undefined, "accepting the scope's proposal ends its design claim");
  assert.equal(accepted.record.slices.s2.title, "Second, designed");
});

test("refuses an implementation claim that syncs under another machine's design claim on its scope", async (context) => {
  const value = await machines(context);
  as(A);
  await write(value.a, [{ op: "claim", slug: "reports" }]);
  as(B);
  await assert.rejects(start(value.b, "s1"), refusal("slice_claimed", (error) => assert.deepEqual([error.claim.slug, error.claim.activity], ["reports", "design"])));
  const onB = await read(value.b);
  assert.equal(onB.record.slices.s1.claim, undefined);
  assert.equal(await exists(path.join(value.storeB, CLAIM_FILE("s1"))), false, "the refused attempt removed its own claim record");
  assert.equal(onB.record.slices.s1.status, "not-started");
  assert.equal(onB.record.slices.reports.claim.holder, A.holder);
});

test("reads and writes older records without claims as before, and reports unreadable claim records", async (context) => {
  const value = await worktrees(context);
  const file = path.join(value.parent, "store", "initiatives", "reports", "initiative.json");
  const older = await readFile(file, "utf8");
  assert.doesNotMatch(older, /claim/);
  const read1 = await read(value.a);
  assert.equal(read1.valid, true);
  assert.equal(read1.claims, undefined);
  await write(value.a, [{ op: "update_slice", slug: "s1", title: "First, renamed" }]);
  as(A);
  await start(value.a, "s1");
  assert.doesNotMatch(await readFile(file, "utf8"), /holder|claimedAt/, "claims never enter the initiative record");
  const claimFile = path.join(value.parent, "store", CLAIM_FILE("s2"));
  const claim = JSON.parse(await readFile(path.join(value.parent, "store", CLAIM_FILE("s1")), "utf8"));
  assert.deepEqual(Object.keys(claim), ["schemaVersion", "slug", "holder", "label", "activity", "claimedAt", "renewedAt", "expiresAt", "nonce"]);
  for (const [malformed, problem] of [[{ ...claim, slug: "s2", activity: "review" }, /activity must be/], [{ ...claim, slug: "s2", expiresAt: "soon" }, /expiresAt must be a date-time/], [{ ...claim, slug: "s1" }, /slug must be s2/], [{ ...claim, slug: "s2", extra: 1 }, /unknown fields extra/], ["held", /must be a JSON object/]]) {
    await writeFile(claimFile, `${JSON.stringify(malformed)}\n`);
    const loaded = await read(value.a);
    assert.equal(loaded.valid, true, "a claim record never makes the initiative record invalid");
    assert.match(loaded.claimProblems.join(" "), problem);
    assert.equal(loaded.claims.s2, undefined);
  }
});

test("labels a claim with the store's Git user name and the short host name", async (context) => {
  const parent = await folder(context);
  git(parent, "init", "-q", "store");
  git(path.join(parent, "store"), "config", "user.name", "Ada Lovelace");
  const root = await project(parent, "project", storeConfig("store"));
  await create(root);
  configureClaims({ holder: PROCESS_HOLDER, label: null });
  const started = await start(root, "s1");
  assert.equal(started.record.slices.s1.claim.label, `Ada Lovelace on ${os.hostname().split(".")[0]}`);
  assert.equal(started.record.slices.s1.claim.holder, PROCESS_HOLDER);
  assert.match(PROCESS_HOLDER, /^[0-9a-f]{16}$/);
});

// Holds a lock until the returned release is called, so a test can act while Prism waits for it.
async function holdLock(target) {
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const done = withFileLock(target, () => { acquired(); return new Promise((resolve) => { release = resolve; }); });
  await ready;
  return async () => { release(); await done; };
}

const nonceIn = async (file) => JSON.parse(await readFile(file, "utf8")).nonce;
async function until(check) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The condition never held.");
}

test("keeps a re-claimed slice held and renewed while the new claim waits for its sync", async (context) => {
  const value = await machines(context);
  as(A);
  await write(value.a, [{ op: "claim", slug: "s1" }]);
  const file = path.join(value.storeA, CLAIM_FILE("s1"));
  const designNonce = await nonceIn(file);
  const release = await holdLock(path.join(value.storeA, ".prism-sync", "sync"));
  const pending = start(value.a, "s1");
  await until(async () => (await nonceIn(file)) !== designNonce);
  await renewHeldClaims();
  const during = await read(value.a);
  assert.equal(during.lostClaims, undefined, "the server's own pending claim is not lost");
  assert.equal(during.claims.s1.heldHere, true);
  assert.deepEqual(heldClaims().map((item) => [item.slug, item.nonce]), [["s1", designNonce]]);
  await release();
  const started = await pending;
  assert.equal(started.claims.confirmation, "sync");
  assert.deepEqual(heldClaims().map((item) => [item.slug, item.nonce]), [["s1", await nonceIn(file)]]);
  assert.equal((await read(value.a)).lostClaims, undefined);
});

test("keeps renewing the earlier claim when a re-claim is undone", async (context) => {
  const value = await machines(context);
  as(A);
  await write(value.a, [{ op: "claim", slug: "s1" }]);
  const file = path.join(value.storeA, CLAIM_FILE("s1"));
  const before = JSON.parse(await readFile(file, "utf8"));
  await rename(value.remote, `${value.remote}.away`);
  await assert.rejects(start(value.a, "s1"), refusal("claim_unconfirmed"));
  assert.equal(await nonceIn(file), before.nonce, "the undo restored the earlier design claim");
  assert.deepEqual(heldClaims().map((item) => [item.slug, item.nonce, item.pending]), [["s1", before.nonce, undefined]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renewHeldClaims();
  const renewed = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Date.parse(renewed.renewedAt) > Date.parse(before.renewedAt), "the restored claim is still renewed");
  const after = await read(value.a);
  assert.equal(after.lostClaims, undefined);
  assert.equal(after.claims.s1.activity, "design");
});

test("waits for a claim record's own lock before it removes an ended claim", async (context) => {
  const value = await worktrees(context);
  as(A);
  await start(value.a, "s1");
  const file = path.join(value.parent, "store", CLAIM_FILE("s1"));
  const release = await holdLock(file);
  const ending = write(value.a, [{ op: "set_status", slug: "s1", status: "blocked" }]);
  await until(async () => (await readFile(path.join(value.parent, "store", "initiatives/reports/initiative.json"), "utf8")).includes("\"blocked\""));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await exists(file), true, "the removal waits while the sync's lock on the record is held");
  await release();
  await ending;
  assert.equal(await exists(file), false);
});

test("the review model shows live claims, a scope's design claim on its slices, and a lapsed claim as expired", async (context) => {
  const { serializeClaim } = await import("../../dist/server/workflow/slice-claims.mjs");
  const { loadEntity, forgetWorkspace } = await import("../../dist/server/review/workspace-model.mjs");
  const { claimChip, claimOf } = await import("../../dist/server/review/public/views/claims.js");
  const root = await project(await folder(context), "local", "## Paths\n- Plans (scratch): docs/plans/\n");
  await create(root);
  const now = Date.now();
  const claim = (slug, activity, minutes) => writeFile(path.join(root, ".prism", CLAIM_FILE(slug)), serializeClaim({ slug, holder: A.holder, label: `${slug} owner`, activity, claimedAt: new Date(now - 600000).toISOString(), renewedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + minutes * 60000).toISOString(), nonce: `nonce-${slug}` }));
  await mkdir(path.join(root, ".prism/initiatives/reports/claims"), { recursive: true });
  await claim("reports", "design", 20);
  await claim("s1", "implementation", -5);
  forgetWorkspace();
  const slices = (await loadEntity(root, "initiative:reports")).data.record.slices;
  assert.equal(slices.reports.claim.label, "reports owner");
  assert.equal(slices.s1.claim, undefined);
  assert.equal(slices.s1.expiredClaim.label, "s1 owner");
  assert.match(claimChip(claimOf(slices, "s1")), /is-expired[\s\S]*implementation · expired<\/span>/);
  assert.match(claimChip(claimOf(slices, "s2")), /reports owner<\/span><span class="claim-meta">design via Reports · 20 min left/);
  assert.equal(claimOf(slices, "s2", now + 21 * 60000), null, "a lapsed scope claim covers nothing");
  const s2 = (await loadEntity(root, "slice:reports/s2")).data;
  assert.deepEqual([s2.coveringClaim.slug, s2.coveringClaim.claim.activity], ["reports", "design"]);
  assert.equal(claimChip(null), "");
});
