import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Git runs with a private home and configuration, a fixed identity, and only local repositories.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-state-merge-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment, PRISM_REVIEW_APP_DIR: path.join(environment, "app"),
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { recordMergeFor, hasRecordMerge } = await import("../../dist/server/workflow/record-merge.mjs");
const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { forgetMigrations } = await import("../../dist/server/workflow/record-store.mjs");
const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const PATH = "initiatives/reports/state.json";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const entry = (id, at, action = "initiative.continuation", extra = {}) => ({ id: id.padEnd(32, "0"), action, target: "initiative:reports", before: "auto", after: "stepwise", at, by: { name: "Ada", email: "ada@example.invalid", checkout: "reports/main on a" }, via: "review-app", ...extra });
const gate = (id, extra = {}) => ({ id, kind: "decision", question: `Question ${id}?`, artifacts: [], options: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }], askedAt: "2026-11-01T00:00:00.000Z", ...extra });
const base = (extra = {}) => ({ schemaVersion: 1, settings: {}, active: [], pending: [], next: [], evidence: [], history: [], personSettings: {}, ...extra });
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function merge(baseState, local, upstream) {
  const run = await recordMergeFor(PATH);
  assert.equal(typeof run, "function", "the coordination state has a structural merge");
  return run({ path: PATH, base: baseState === null ? null : text(baseState), local: text(local), upstream: text(upstream) });
}

async function merged(...versions) {
  const result = await merge(...versions);
  assert.equal(result.conflict, undefined, result.conflict);
  return JSON.parse(result.contents);
}

test("the coordination state record kind registers a structural merge", () => {
  assert.equal(hasRecordMerge(PATH), true);
  assert.equal(hasRecordMerge("initiatives/reports/claims/reports.json"), false, "other record kinds keep their own handling");
});

test("settings merge per setting, and a setting both sides changed takes the person's later change with its mark", async () => {
  const start = base({ settings: { push: "off", review: "marked" } });
  const fromA = entry("a1", "2026-11-05T10:00:00.000Z", "initiative.push");
  const local = base({ settings: { push: "on", review: "marked" }, personSettings: { push: { at: fromA.at, entry: fromA.id } }, history: [fromA] });
  const upstream = base({ settings: { push: "off", review: "all", continuation: "stepwise" } });
  const together = await merged(start, local, upstream);
  assert.deepEqual(together.settings, { push: "on", review: "all", continuation: "stepwise" }, "each side's setting survives");
  assert.deepEqual(together.personSettings, { push: { at: fromA.at, entry: fromA.id } });
  const fromB = entry("b1", "2026-11-05T10:00:05.000Z", "initiative.push");
  const both = base({ settings: { push: "off" }, personSettings: { push: { at: fromB.at, entry: fromB.id } }, history: [fromB] });
  const later = await merged(base({ settings: { push: "on" } }), local, both);
  assert.equal(later.settings.push, "off", "the later person's change wins");
  assert.deepEqual(later.personSettings.push, { at: fromB.at, entry: fromB.id });
  const agentOnly = await merge(base({ settings: { push: "off" } }), base({ settings: { push: "on" } }), base({ settings: { push: "on", commit: "on" }, next: [] }));
  assert.equal(agentOnly.conflict, undefined, "the same change on both sides is no conflict");
  const oneSide = await merged(base({ settings: { continuation: "auto" } }), base({ settings: { continuation: "stepwise" } }), base({ settings: { continuation: "auto", review: "all" } }));
  assert.deepEqual(oneSide.settings, { continuation: "stepwise", review: "all" }, "a change on one side only takes that side");
  const agents = await merge(base({ settings: { autonomy: "conservative" } }), base({ settings: { autonomy: "broad" } }), base({ settings: { autonomy: "full" } }));
  assert.equal(typeof agents.conflict, "string", "two different agent writes of one setting, neither the person's, are a conflict");
});

test("history keeps every entry of both sides once, ordered by time and then id, and keeps the newest 200", async () => {
  const shared = entry("00", "2026-11-05T09:00:00.000Z");
  const a = entry("aa", "2026-11-05T10:00:00.000Z");
  const b = entry("bb", "2026-11-05T10:00:00.000Z");
  const c = entry("cc", "2026-11-05T09:30:00.000Z");
  const result = await merged(base({ history: [shared] }), base({ history: [shared, b] }), base({ history: [shared, c, a] }));
  assert.deepEqual(result.history.map((item) => item.id), [shared.id, c.id, a.id, b.id]);
  const many = Array.from({ length: 199 }, (_, index) => entry(`1${String(index).padStart(3, "0")}`, `2026-11-04T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`));
  const capped = await merged(base({ history: many }), base({ history: [...many, a] }), base({ history: [...many, c] }));
  assert.equal(capped.history.length, 200);
  assert.deepEqual(capped.history.slice(-2).map((item) => item.id), [c.id, a.id]);
  assert.equal(capped.history[0].id, many[1].id, "the oldest entry gives way");
  const fresh = await merged(null, base({ history: [a] }), base({ history: [b] }));
  assert.deepEqual(fresh.history.map((item) => item.id), [a.id, b.id], "a state created on both machines merges against an empty state");
});

test("pending gates merge per id, an answer on both sides keeps the earlier one, and a gate closed on one side stays closed", async () => {
  const start = base({ pending: [gate("gate-00000001"), gate("gate-00000002")] });
  const answer = (choice, answeredAt, id) => ({ choice, note: null, via: "browser", answeredAt, by: { name: "Ada", email: null, checkout: "reports/main on a" }, entry: id.padEnd(32, "0") });
  const local = base({ pending: [gate("gate-00000001", { answer: answer("keep", "2026-11-05T10:00:01.000Z", "a1") }), gate("gate-00000002"), gate("gate-00000003")] });
  const upstream = base({ pending: [gate("gate-00000001", { answer: answer("drop", "2026-11-05T10:00:00.000Z", "b1") }), gate("gate-00000002"), gate("gate-00000004")] });
  const result = await merged(start, local, upstream);
  assert.deepEqual(result.pending.map((item) => item.id), ["gate-00000001", "gate-00000002", "gate-00000004", "gate-00000003"]);
  assert.equal(result.pending[0].answer.choice, "drop", "the earlier answer stays");
  const closedGate = { ...gate("gate-00000002"), closedAt: "2026-11-05T11:00:00.000Z", reason: "No longer needed." };
  const closing = await merged(start, base({ pending: [gate("gate-00000001")], closed: [closedGate] }), base({ pending: [gate("gate-00000001"), gate("gate-00000002", { answer: answer("keep", "2026-11-05T10:00:00.000Z", "c1") })] }));
  assert.deepEqual(closing.pending.map((item) => item.id), ["gate-00000001"]);
  assert.deepEqual(closing.closed.map((item) => item.id), ["gate-00000002"]);
  const edited = await merge(start, base({ pending: [gate("gate-00000001", { question: "From A?" }), gate("gate-00000002")] }), base({ pending: [gate("gate-00000001", { question: "From B?" }), gate("gate-00000002")] }));
  assert.equal(typeof edited.conflict, "string", "a gate changed differently on both sides other than by its answer is a conflict");
});

test("a merged gate keeps the context, consequences, and recommendation it was asked with, and a gate recorded without them still merges", async () => {
  const explained = gate("gate-00000005", { context: "Two scripts read the old layout.", options: [{ id: "keep", label: "Keep", consequence: "Both layouts are written." }, { id: "drop", label: "Drop", consequence: "Only the new layout is written." }], recommended: { option: "keep", reason: "The scripts still need it." } });
  const assistance = gate("gate-00000006", { kind: "assistance", options: undefined, context: "Only you can add the signing key." });
  const start = base({ pending: [gate("gate-00000001")] });
  const answer = { choice: "keep", note: null, via: "browser", answeredAt: "2026-11-05T10:00:00.000Z", by: { name: "Ada", email: null, checkout: "reports/main on a" }, entry: "e1".padEnd(32, "0") };
  const result = await merged(start, base({ pending: [gate("gate-00000001", { answer }), explained] }), base({ pending: [gate("gate-00000001"), assistance] }));
  assert.deepEqual(result.pending.map((item) => item.id), ["gate-00000001", "gate-00000006", "gate-00000005"]);
  assert.equal(result.pending[0].context, undefined, "a gate recorded without context merges as it is");
  assert.deepEqual(result.pending[0].answer, answer);
  assert.deepEqual(result.pending.find((item) => item.id === "gate-00000005"), explained);
  assert.deepEqual(result.pending.find((item) => item.id === "gate-00000006"), JSON.parse(JSON.stringify(assistance)));
  const both = base({ pending: [explained] });
  const reworded = await merge(both, base({ pending: [{ ...explained, context: "Three scripts read the old layout." }] }), base({ pending: [{ ...explained, recommended: { option: "drop", reason: "The scripts move this week." } }] }));
  assert.equal(typeof reworded.conflict, "string", "a gate whose asked fields differ between the sides is a conflict");
});

test("active work merges per slice, closed gates and evidence keep both sides' additions, and other fields keep the unit rule", async () => {
  const work = (slice) => ({ slice, activity: "implementation", label: `Claude on ${slice}`, workers: [`worker-${slice}`], workspace: "." });
  const closedGate = (id, closedAt) => ({ ...gate(id), closedAt });
  const start = base({ active: [work("s0")], evidence: ["s0.md"], next: ["Start s1."] });
  const local = base({ active: [work("s0"), work("s1")], evidence: ["s0.md", "s1.md"], closed: [closedGate("gate-0000000a", "2026-11-05T10:00:00.000Z")], next: ["Start s1."] });
  const upstream = base({ active: [work("s2")], evidence: ["s0.md", "s2.md"], closed: [closedGate("gate-0000000b", "2026-11-05T09:00:00.000Z")], next: ["Start s1."] });
  const result = await merged(start, local, upstream);
  assert.deepEqual(result.active.map((item) => item.slice), ["s2", "s1"], "s0 ended on one side, s1 and s2 started on either");
  assert.deepEqual(result.evidence, ["s0.md", "s2.md", "s1.md"]);
  assert.deepEqual(result.closed.map((item) => item.id), ["gate-0000000b", "gate-0000000a"]);
  assert.deepEqual(result.next, ["Start s1."]);
  const next = await merge(start, base({ ...start, next: ["Start s2."] }), base({ ...start, next: ["Stop."] }));
  assert.equal(typeof next.conflict, "string", "next changed differently on both sides is a conflict");
  const invalid = await merge(base(), base({ active: [work("s1")] }), base({ active: [{ ...work("s1"), activity: "design" }] }));
  assert.equal(typeof invalid.conflict, "string", "one slice's work changed differently on both sides is a conflict");
  const broken = await merge(base(), base({ settings: { autonomy: "reckless" } }), base({ next: ["x"] }));
  assert.equal(typeof broken.conflict, "string", "a merged state that validation rejects is a conflict");
});

// Two machines: each has a Git checkout whose synced store is a clone of one bare remote.
async function machines(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-state-merge-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  forgetMigrations();
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", "remote.git", "store-a");
  const storeA = path.join(parent, "store-a");
  git(storeA, "checkout", "-q", "-b", "main");
  await writeFile(path.join(storeA, "README.md"), "Prism records\n");
  git(storeA, "add", ".");
  git(storeA, "commit", "-q", "-m", "init");
  git(storeA, "push", "-q", "-u", "origin", "main");
  git(parent, "clone", "-q", "remote.git", "store-b");
  const checkout = async (name, store, person) => {
    const root = path.join(parent, name);
    await mkdir(path.join(root, ".prism"), { recursive: true });
    await writeFile(path.join(root, ".prism/workflow.md"), `## Paths\n- Plans: docs/plans/\n\n## Workspace\n- Store: ../${store}\n- Repository: project\n- Store sync: on\n`);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", person);
    git(root, "config", "user.email", `${person.toLowerCase()}@example.invalid`);
    return realpath(root);
  };
  return { parent, storeA, storeB: path.join(parent, "store-b"), a: await checkout("project-a", "store-a", "Ada"), b: await checkout("project-b", "store-b", "Grace") };
}

const conflictsOf = async (store) => (await readdir(path.join(store, ".prism-sync", "conflicts")).catch(() => [])).length;

test("a person's change on one machine and an agent's state write on another within one sync window both survive", async (context) => {
  const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
  const value = await machines(context);
  await updateInitiative({ projectRoot: value.a, initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] });
  const created = await updateCoordinationState({ projectRoot: value.a, initiative: "reports", expectedRevision: null, changes: { next: ["Design reports."] } });
  assert.ok(created.revision);
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  const view = (await listActions({ projectRoot: value.a, target: "initiative:reports" })).actions.find((action) => action.id === "initiative.continuation");
  const { applied } = await applyAction({ projectRoot: value.a, target: "initiative:reports", action: "initiative.continuation", input: { value: "stepwise" }, revision: view.revision, via: "review-app" });
  const onB = await readCoordinationState({ projectRoot: value.b, initiative: "reports" });
  await updateCoordinationState({ projectRoot: value.b, initiative: "reports", expectedRevision: onB.revision, changes: { next: ["Implement reports."], settings: { review: "all" } } });
  const otherView = (await listActions({ projectRoot: value.b, target: "initiative:reports" })).actions.find((action) => action.id === "initiative.models");
  const { applied: fromB } = await applyAction({ projectRoot: value.b, target: "initiative:reports", action: "initiative.models", input: { mode: "custom", delivery: "opus", review: "opus", securityReview: "opus" }, revision: otherView.revision, via: "review-app" });
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  const status = await syncRecordStore(value.storeB);
  assert.deepEqual([status.state, status.conflicts], ["ok", []]);
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal(await conflictsOf(value.storeB), 0, "no conflict is saved");
  const [stateA, stateB] = [await readCoordinationState({ projectRoot: value.a, initiative: "reports" }), await readCoordinationState({ projectRoot: value.b, initiative: "reports" })];
  assert.equal(stateA.valid, true);
  assert.equal(stateA.revision, stateB.revision, "both machines hold the same state");
  assert.equal(await readFile(path.join(value.storeA, PATH), "utf8"), await readFile(path.join(value.storeB, PATH), "utf8"));
  const { state } = stateA;
  assert.deepEqual([state.settings.continuation, state.settings.review, state.next], ["stepwise", "all", ["Implement reports."]]);
  assert.deepEqual(state.settings.models, { delivery: "opus", review: "opus", securityReview: "opus" });
  assert.deepEqual(state.history.map((item) => item.id).sort(), [applied.id, fromB.id].sort());
  assert.deepEqual(state.history.find((item) => item.id === applied.id).by.name, "Ada");
  assert.deepEqual(state.history.find((item) => item.id === fromB.id).by.name, "Grace", "each entry names the machine's own author");
  assert.deepEqual(Object.keys(state.personSettings).sort(), ["continuation", "models"]);
});
