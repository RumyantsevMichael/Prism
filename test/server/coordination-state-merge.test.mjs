import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const { readCoordinationState, recordPersonAction, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
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

// History and closed gates are the only parts that give way to the 1 MiB limit, oldest first, so a valid answer is never refused for good.
const LIMIT = 1024 * 1024;
const stateFile = (target) => path.join(target.projectRoot, ".prism/initiatives", target.initiative, "state.json");
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : text(value));

async function project(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-state-fit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot: root, initiative: "demo" };
}

const asked = (extra = {}) => ({ op: "ask", kind: "decision", question: "Pick?", context: "Why.", options: [{ id: "a", label: "A", consequence: "A happens." }, { id: "b", label: "B", consequence: "B happens." }], recommended: { option: "a", reason: "Simpler." }, ...extra });
const personEntry = (target, action, after, index) => ({ id: randomBytes(16).toString("hex"), action, target, before: null, after, at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), by: { name: "Ada", email: null, checkout: "demo/main on a" }, via: "review-app" });
const revisionOf = async (target) => (await readCoordinationState(target)).revision;

test("a person's answers with notes at the note limit keep being accepted while the oldest history entries give way to 1 MiB", async (context) => {
  const target = await project(context);
  await updateCoordinationState({ ...target, expectedRevision: null, changes: { evidence: ["e"] } });
  const note = "中".repeat(4000);
  const ids = [];
  for (let index = 0; index < 70; index += 1) {
    const result = await updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { gateOperations: [asked()] } });
    const gate = result.state.pending.at(-1);
    const entry = personEntry(`gate:demo/${gate.id}`, "gate.answer", { choice: "a", note }, index);
    const applied = await recordPersonAction({ ...target, prepare: () => ({ entry, answer: { id: gate.id, choice: "a", note } }) });
    assert.equal(applied.state.history.at(-1).id, entry.id, `answer ${index + 1} is accepted with its entry`);
    ids.push(entry.id);
    await updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { gateOperations: [{ op: "resolve", id: gate.id }] } });
  }
  const { state } = await readCoordinationState(target);
  assert.ok(bytes(await readFile(stateFile(target), "utf8")) <= LIMIT);
  assert.ok(state.history.length > 0 && state.history.length < 70, "the oldest entries gave way");
  assert.deepEqual(state.history.map((item) => item.id), ids.slice(-state.history.length), "the newest entries stay, in order");
  assert.equal(state.closed.length, 20, "closed gates give way only after history");
});

test("a state write drops the oldest history entries, then the oldest closed gates, and never pending gates, settings, or the person's marks", async (context) => {
  const target = await project(context);
  await updateCoordinationState({ ...target, expectedRevision: null, changes: { evidence: ["x"] } });
  for (let index = 0; index < 4; index += 1) await updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { gateOperations: [asked({ question: `Pick ${index}?` })] } });
  const gates = (await readCoordinationState(target)).state.pending.map((item) => item.id);
  for (const id of gates.slice(0, 3)) await updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { gateOperations: [{ op: "resolve", id, reason: "No longer needed." }] } });
  const entries = [];
  for (const [index, [name, value]] of [["continuation", "stepwise"], ["push", "on"], ["commit", "on"]].entries()) {
    const entry = personEntry("initiative:demo", `initiative.${name}`, value, index);
    entries.push(entry.id);
    await recordPersonAction({ ...target, prepare: () => ({ entry, setting: { name, value } }) });
  }
  const kept = (state) => ({ pending: state.pending, settings: state.settings, personSettings: state.personSettings });
  const start = JSON.parse(await readFile(stateFile(target), "utf8"));
  assert.deepEqual(start.closed.map((item) => item.id), gates.slice(0, 3));
  // Grows the state to `over` bytes past the limit as it would be with the given history.
  const grow = async (history, over = 100) => {
    const current = JSON.parse(await readFile(stateFile(target), "utf8"));
    const length = current.evidence[0].length + LIMIT + over - bytes({ ...current, history });
    return updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { evidence: ["x".repeat(length)] } });
  };
  await grow(start.history);
  let state = JSON.parse(await readFile(stateFile(target), "utf8"));
  assert.ok(bytes(state) <= LIMIT);
  assert.deepEqual(state.history.map((item) => item.id), entries.slice(1), "only the oldest entry gave way");
  assert.deepEqual(state.closed.map((item) => item.id), gates.slice(0, 3));
  assert.deepEqual(kept(state), kept(start));
  await grow([]);
  state = JSON.parse(await readFile(stateFile(target), "utf8"));
  assert.ok(bytes(state) <= LIMIT);
  assert.deepEqual(state.history ?? [], [], "every history entry gave way before a closed gate");
  assert.deepEqual(state.closed.map((item) => item.id), gates.slice(1, 3), "then the oldest closed gate");
  assert.deepEqual(kept(state), kept(start), "a person's mark keeps the id of its dropped entry");
  await grow([], -10);
  assert.deepEqual(JSON.parse(await readFile(stateFile(target), "utf8")).closed.map((item) => item.id), gates.slice(1, 3), "a state that fits drops nothing");
  const added = personEntry("initiative:demo", "initiative.continuation", "auto", 10);
  const applied = await recordPersonAction({ ...target, prepare: () => ({ entry: added, setting: { name: "continuation", value: "auto" } }) });
  assert.deepEqual(applied.state.history.map((item) => item.id), [added.id], "the entry a write adds never gives way");
  assert.deepEqual(applied.state.closed.map((item) => item.id), gates.slice(2, 3));
  assert.ok(bytes(await readFile(stateFile(target), "utf8")) <= LIMIT);
  const before = await readFile(stateFile(target), "utf8");
  await assert.rejects(
    updateCoordinationState({ ...target, expectedRevision: await revisionOf(target), changes: { evidence: ["x".repeat(LIMIT)] } }),
    (caught) => caught.code === "artifact_too_large",
    "a state over the limit without anything droppable is refused"
  );
  assert.equal(await readFile(stateFile(target), "utf8"), before, "a refused write drops nothing");
});

test("a merged state drops the oldest history entries to fit 1 MiB, the same from either side, and keeps what either side dropped dropped", async () => {
  const big = (id, at) => entry(id, at, "gate.answer", { before: null, after: { choice: "keep", note: "n".repeat(10000) } });
  const [h0, h1, h2] = ["d0", "d1", "d2"].map((id, index) => big(id, `2026-11-05T0${index}:00:00.000Z`));
  const a = big("aa", "2026-11-05T10:00:00.000Z");
  const c = big("cc", "2026-11-05T09:00:00.000Z");
  const pad = (state, size) => ({ ...state, evidence: ["p".repeat(size - bytes({ ...state, evidence: [""] }))] });
  const start = pad(base({ pending: [gate("gate-00000001")], history: [h0, h1, h2] }), LIMIT - 5000);
  const local = { ...start, history: [h1, h2, a] };
  const upstream = { ...start, history: [h1, h2, c] };
  const result = await merge(start, local, upstream);
  assert.equal(result.conflict, undefined, result.conflict);
  assert.ok(Buffer.byteLength(result.contents) <= LIMIT);
  const fitted = JSON.parse(result.contents);
  assert.deepEqual(fitted.history.map((item) => item.id), [h2.id, c.id, a.id], "h0 stays dropped and h1 gives way");
  assert.deepEqual(fitted.pending, start.pending);
  assert.equal((await merge(start, upstream, local)).contents, result.contents, "both machines compute the same state");

  const closedGate = (id, closedAt) => ({ ...gate(id), closedAt });
  const [k0, k1] = [closedGate("gate-0000000a", "2026-11-05T01:00:00.000Z"), closedGate("gate-0000000b", "2026-11-05T02:00:00.000Z")];
  const shared = base({ history: [h0, h1, h2], closed: [k0, k1], evidence: ["p".repeat(1000)] });
  const kept = await merged(shared, { ...shared, history: [a], closed: [k1] }, { ...shared, evidence: [] });
  assert.deepEqual(kept.history.map((item) => item.id), [a.id], "entries one side dropped do not come back although they would fit");
  assert.deepEqual(kept.closed.map((item) => item.id), [k1.id], "a closed gate one side dropped does not come back");

  const half = "q".repeat(600 * 1024);
  const small = base({ history: [h0] });
  const tooLarge = await merge(small, { ...small, evidence: [half] }, { ...small, evidence: [`${half}r`] });
  assert.equal(typeof tooLarge.conflict, "string", "a merged state over 1 MiB without its history and closed gates is a conflict");
});
