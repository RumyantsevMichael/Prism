import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { findComponent, readComponents } from "./components.mjs";
import { appendRecord, listRecordEntries, locateRecord, RECORD_DIRECTORY, recordStoreOf } from "./record-store.mjs";
import { repositoryId } from "./repository-names.mjs";
import { changedPaths, contentTree, crossesComponent, setSliceRef, treeId, treeReadable } from "./slice-gate.mjs";
import { acceptedDesign, checkFrozenTests, designProblems } from "./slice-design.mjs";
import { readCoordinationState, updateCoordinationState } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { publicRemote } from "./remote-url.mjs";

export { publicRemote };

const APPROVALS_FILE = "verification-approvals.json";
const OUTPUT_TAIL_BYTES = 64 * 1024;
const RECORDED_TAIL_CHARS = 4000;
const RETURNED_TAIL_CHARS = 20000;
const BRIEF_TAIL_CHARS = 1500;
const MAX_FAILING_NAMES = 20;
const MAX_TRACKED_FAILURES = 1000;
const MAX_CROSSING_PATHS = 200;
const DEFAULT_TIMEOUT_MINUTES = 30;
const PROGRESS_MS = 30000;
const KILL_GRACE_MS = 5000;
const ALLOW = "allow";
const DECLINE = "decline";

export class VerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new VerificationError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 2000 };
const slug = { type: "string", minLength: 1, maxLength: 120 };
export const VERIFY_SLICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectRoot: text,
    initiative: slug,
    slice: slug,
    approvalGate: { type: "string", pattern: "^gate-[0-9a-f]{8,32}$" },
    chatApproval: { type: "object", additionalProperties: false, properties: { quote: { type: "string", minLength: 1, maxLength: 800 } }, required: ["quote"] },
    contractDefects: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", additionalProperties: false, properties: { clause: text, reason: text }, required: ["clause", "reason"] } }
  },
  required: ["projectRoot", "initiative", "slice"]
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** The test command a project configures in .prism/workflow.md under Stack. */
export async function configuredTestCommand(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const command = config.sections?.Stack?.["Test command"]?.trim();
  return { config, command: command && !/^n\/a$/i.test(command) ? command : null };
}

// The initiative's slices as its record holds them, or an empty object when it cannot be read.
async function recordedSlices(root, initiative) {
  const located = await locateRecord(root, { kind: "initiative", initiative });
  try { return JSON.parse(await readFile(located.target, "utf8"))?.slices ?? {}; }
  catch { return {}; }
}

// The component a slice's accepted design recorded, as <repository>/<component>, or undefined for a slice accepted before components existed.
async function recordedComponent(root, initiative, slice) {
  return (await recordedSlices(root, initiative))[slice]?.component ?? undefined;
}

// A project-relative folder with forward slashes, "" for the project root, or null for a path outside the project.
function projectFolder(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * What a slice's verification runs and where: { config, command, folder, declaredFolder, cwd, component, declaration }, where cwd is the real path the command runs in,
 * folder is that path project-relative and "" for the project root, declaredFolder is the component's folder as declared,
 * and component is null for a slice without one, which reads no components and runs the repository's command in the project root.
 * A slice with a component runs that component's own command in its folder, or the repository's command in the project root when it declares none.
 * Every refusal comes before any approval is asked.
 */
async function verificationTarget(root, initiative, slice) {
  const identity = await recordedComponent(root, initiative, slice);
  if (identity === undefined) {
    const { config, command } = await configuredTestCommand(root);
    if (!command) throw fail("test_command_missing", "The project configures no test command. Add one under ## Stack in .prism/workflow.md as - Test command: <command>.");
    return { config, command, folder: "", declaredFolder: "", cwd: root, component: null, declaration: null };
  }
  const config = await readWorkflowConfig(root);
  const declaration = readComponents(config);
  const component = findComponent(declaration, identity);
  if (component === null) {
    const components = declaration.components.map((item) => item.identity);
    throw fail("component_unknown", `The slice ${slice} records the component ${identity}, which is not a component of this repository now. Declare it again under ## Components in .prism/workflow.md, or accept the design again with one of ${components.join(", ")}.`, { slice, component: identity, components });
  }
  const own = component !== declaration.root && component.testCommand !== null;
  const command = own ? component.testCommand : declaration.root.testCommand;
  const declaredFolder = own ? component.folder : "";
  if (!command) {
    const message = component === declaration.root ? "The project configures no test command. Add one under ## Stack in .prism/workflow.md as - Test command: <command>." : `Neither the component ${component.identity} nor the project configures a test command. Add one under the component in ## Components as - Test command: <command>, or under ## Stack in .prism/workflow.md.`;
    throw fail("test_command_missing", message, { component: component.identity });
  }
  let cwd = null;
  try {
    const resolved = await realpath(path.join(root, declaredFolder));
    if ((await stat(resolved)).isDirectory()) cwd = resolved;
  } catch { cwd = null; }
  if (cwd === null) throw fail("component_folder_missing", `The folder ${declaredFolder} of the component ${component.identity}, where its test command runs, does not exist or is not a folder.`, { component: component.identity, folder: declaredFolder });
  // A folder is declared by its text, while a symbolic link on its path can lead anywhere, so the command runs only in a folder of the project.
  const folder = projectFolder(root, cwd);
  if (folder === null) throw fail("component_folder_outside", `The folder ${declaredFolder} of the component ${component.identity} leads outside the project through a symbolic link, so Prism does not run its test command there. Point the component at a folder inside the project.`, { component: component.identity, folder: declaredFolder });
  return { config, command, folder, declaredFolder, cwd, component, declaration };
}

// Every result that names a command also names the folder it runs in and, for a slice with a component, that component.
const named = (target) => ({ command: target.command, folder: target.folder, ...(target.component ? { component: target.component.identity } : {}) });

function dataDirectoryOf(dataDirectory) {
  return dataDirectory || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), RECORD_DIRECTORY);
}

// Approvals stay in local plugin data, so a repository change can never approve a command on its own.
async function withApprovals(dataDirectory, action) {
  const directory = dataDirectoryOf(dataDirectory);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, APPROVALS_FILE);
  return withArtifactLock(target, () => withFileLock(target, async () => {
    let store;
    try { store = JSON.parse(await readFile(target, "utf8")); }
    catch { store = null; }
    if (!store || store.schemaVersion !== 1 || typeof store.approved !== "object" || typeof store.requests !== "object") store = { schemaVersion: 1, approved: {}, requests: {} };
    const before = JSON.stringify(store);
    const result = await action(store);
    if (JSON.stringify(store) !== before) await writeAtomically(target, `${JSON.stringify(store, null, 2)}\n`);
    return result;
  }, fail));
}

async function gateChange(projectRoot, initiative, changes) {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readCoordinationState({ projectRoot, initiative });
    try {
      return await updateCoordinationState({ projectRoot, initiative, expectedRevision: current.revision, changes });
    } catch (error) {
      if (error.code !== "revision_conflict" || attempt >= 3) throw error;
    }
  }
}

async function pendingGate(projectRoot, initiative, id) {
  const state = await readCoordinationState({ projectRoot, initiative });
  return (state.state?.pending ?? []).find((item) => item && typeof item === "object" && item.id === id) ?? null;
}

// The folder is the one the command runs in, project-relative, and a component folder that leads there through a link is named beside it, so the question holds no path of the user's machine.
function approvalQuestion(command, folder, declaredFolder, key) {
  const place = `${folder === "" ? "the project root" : `the folder ${folder}`}${declaredFolder && declaredFolder !== folder ? `, where the component folder ${declaredFolder} leads` : ""}`;
  return [
    "Allow Prism to run this test command to verify slices in this project?",
    "",
    command,
    "",
    `Prism runs it with your shell in ${place}. A changed command, or the same command in another folder, asks again.`,
    `Approval key: ${key.slice(0, 12)}`
  ].join("\n");
}

/** Whether the person cannot open this session's review browser: Claude Code sets CLAUDE_CODE_REMOTE in a cloud session. */
export function reviewBrowserUnreachable(env = process.env) {
  return env.CLAUDE_CODE_REMOTE === "true";
}

// Only the review browser records gate answers, so an Allow choice on the server's own gate is the user's approval.
// Where the person cannot open the browser, the agent records the person's chat answer instead, quoted in the approval and the gate's history.
// An approval is keyed by the real working folder and the command text, so an approval given before components existed, keyed by the project root, still allows that command there.
async function approval({ root, initiative, slice, command, folder, declaredFolder, cwd, approvalGate, chatApproval, dataDirectory }) {
  const key = digest(`${cwd}\n${command}`);
  if (chatApproval && !reviewBrowserUnreachable()) throw fail("chat_approval_unavailable", "This session can open the review browser, so the user allows the test command there, not in chat. Call verify_slice without chatApproval.");
  return withApprovals(dataDirectory, async (store) => {
    if (store.approved[key]) return { approved: true, key };
    if (approvalGate && store.requests[approvalGate] && store.requests[approvalGate].key !== key) throw fail("approval_mismatch", `The gate ${approvalGate} asked about another test command or folder. Call verify_slice without approvalGate to ask about the configured one.`);
    if (chatApproval && !(approvalGate && store.requests[approvalGate])) throw fail("validation_failed", "chatApproval answers the approval gate that verify_slice opened, so pass that gate's id as approvalGate.");
    const requested = approvalGate && store.requests[approvalGate] ? approvalGate : Object.entries(store.requests).find(([, item]) => item.key === key && item.initiative === initiative)?.[0];
    if (requested) {
      const request = store.requests[requested];
      const gate = await pendingGate(root, request.initiative, requested);
      if (!gate) {
        delete store.requests[requested];
      } else if (gate.answer?.via === "browser" && gate.answer.choice === ALLOW) {
        store.approved[key] = { root, folder, command, approvedAt: gate.answer.answeredAt, gate: requested };
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {});
        return { approved: true, key };
      } else if (gate.answer) {
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {});
        // An answer with a note and no choice neither allows nor declines the command.
        return { approved: false, key, status: gate.answer.choice === DECLINE ? "declined" : "approval_unclear", gateId: requested, note: gate.answer.note ?? null };
      } else if (chatApproval) {
        const quote = chatApproval.quote.trim();
        const approvedAt = new Date().toISOString();
        store.approved[key] = { root, folder, command, approvedAt, gate: requested, via: "chat", quote };
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested, reason: `The user allowed this command in chat, as recorded by the agent: "${quote}"` }] }).catch(() => {});
        return { approved: true, key };
      } else {
        return { approved: false, key, status: "approval_needed", gateId: requested };
      }
    }
    const opened = await gateChange(root, initiative, { gateOperations: [{ op: "ask", kind: "decision", slice, question: approvalQuestion(command, folder, declaredFolder, key), artifacts: [".prism/workflow.md"], options: [{ id: ALLOW, label: "Allow this command" }, { id: DECLINE, label: "Decline" }] }] });
    const gateId = opened.openedGates[0].id;
    store.requests[gateId] = { key, initiative, askedAt: new Date().toISOString() };
    return { approved: false, key, status: "approval_needed", gateId };
  });
}

function tail(value, limit) {
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* The process already ended. */ } }
}

// The plugin's MCP definitions set NODE_USE_ENV_PROXY for the server's own downloads, and the host sets the plugin's root and data
// directories for the server. A test command inherits none of them, so it runs as it would in the user's shell: Node would warn on
// stderr under the proxy setting, and a project that reads plugin data, such as Prism itself, would read the host's.
const SERVER_ONLY = /^(?:NODE_USE_ENV_PROXY|CLAUDE_PLUGIN_\w+|PLUGIN_DATA|PLUGIN_ROOT)$/;
function commandEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SERVER_ONLY.test(name)));
}

function execute(command, cwd, { signal, timeoutMs, onProgress, logPath = null }) {
  return new Promise((resolve) => {
    // The log receives every byte as it arrives, so it holds the whole output while memory keeps only the end.
    let log = logPath ? createWriteStream(logPath) : null;
    log?.on("error", () => { log = null; });
    const started = Date.now();
    let output = "", timedOut = false, cancelled = false, forced = null;
    const child = spawn(command, { cwd, env: commandEnvironment(), shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    // Only the end of the output is kept, so failing test names are read line by line as the output arrives, before it is cut.
    const failing = new Set();
    const scanners = new Map();
    const scan = (stream, text, end = false) => {
      const lines = `${scanners.get(stream) ?? ""}${text}`.split(/\r?\n/);
      scanners.set(stream, end ? "" : tail(lines.pop(), OUTPUT_TAIL_BYTES));
      for (const line of lines) if (failing.size < MAX_TRACKED_FAILURES) { const name = failingName(line); if (name) failing.add(name); }
    };
    const collect = (stream) => (chunk) => {
      const text = chunk.toString("utf8");
      log?.write(chunk);
      output = tail(output + text, OUTPUT_TAIL_BYTES);
      scan(stream, text);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const stop = () => {
      killGroup(child, "SIGTERM");
      forced = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      forced.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const ticker = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1000), tail(output, 300)), PROGRESS_MS) : null;
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode, exitSignal, spawnError) => {
      clearTimeout(timer);
      clearTimeout(forced);
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener("abort", abort);
      for (const stream of scanners.keys()) scan(stream, "", true);
      if (spawnError) log?.write(`${spawnError.message}\n`);
      const done = { exitCode, signal: exitSignal, timedOut, cancelled, output: spawnError ? `${output}${spawnError.message}\n` : output, failing: [...failing], durationMs: Date.now() - started };
      if (!log) { resolve({ ...done, logged: false }); return; }
      const written = log;
      written.end(() => resolve({ ...done, logged: log === written }));
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, exitSignal) => finish(code, exitSignal));
  });
}

// The full output stays in local plugin data, outside the project, so a caller reads it only when the brief result is not enough.
async function logPathFor(dataDirectory, root, initiative, slice, id) {
  try {
    const directory = path.join(dataDirectoryOf(dataDirectory), "verification-logs", digest(root).slice(0, 16), initiative, slice);
    await mkdir(directory, { recursive: true });
    return path.join(directory, `${id}.log`);
  } catch { return null; }
}

/**
 * The changed paths since a slice started that a change of another slice explains:
 * a frozen test of another slice that holds its frozen content, or is absent while that slice is not started,
 * and a path that another slice's latest passing run changed, when that run finished after this slice's start content was recorded and the path still holds the content it tested.
 * An exception whose contents Git cannot read does not apply, including one whose recorded tree is not a Git object identifier.
 */
async function othersChanges(root, initiative, slice, design, changed) {
  const explained = new Set();
  const slices = await recordedSlices(root, initiative);
  const pending = new Set(changed);
  for (const [key, other] of Object.entries(slices)) {
    if (key === slice || !Array.isArray(other?.design?.frozenTests)) continue;
    for (const item of other.design.frozenTests) {
      if (!pending.has(item?.path)) continue;
      const state = await checkFrozenTests(root, [item]);
      if (!state.changed.length && (!state.missing.length || other.status === "not-started")) explained.add(item.path);
    }
  }
  const since = Date.parse(design.startRecordedAt ?? "");
  if (Number.isNaN(since)) return explained;
  for (const [key, other] of Object.entries(slices)) {
    const theirs = other?.design;
    if (key === slice || !theirs?.startTree || designProblems(theirs).length) continue;
    const runs = await listRecordEntries(root, { kind: "runs", initiative, slice: key }).catch(() => []);
    const latest = runs.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true).at(-1)?.entry;
    // Only a run of the other slice's current start, finished after this slice's start content, explains a change, and only when its tree is a Git object identifier.
    if (!latest || !treeId(latest.tree) || !treeId(theirs.startTree) || !(Date.parse(latest.finishedAt) > since) || (theirs.startRecordedAt && !(Date.parse(latest.finishedAt) > Date.parse(theirs.startRecordedAt)))) continue;
    const made = await changedPaths(root, theirs.startTree, latest.tree);
    const differs = made === null ? null : await changedPaths(root, latest.tree, design.currentTree);
    if (made === null || differs === null) continue;
    const moved = new Set(differs);
    for (const file of made) if (pending.has(file) && !moved.has(file)) explained.add(file);
  }
  return explained;
}

/**
 * The changed paths since a slice started that leave its component, sorted, or null when Git can no longer read or compare the start content.
 * Every path added, changed, or removed counts, except those another slice's change explains, and a path crosses by the declaration recorded with the start content, which the caller checked is there.
 */
async function crossingPaths(root, initiative, slice, { component, declaration }, design, tree) {
  if (!await treeReadable(root, design.startTree)) return null;
  const changed = await changedPaths(root, design.startTree, tree);
  if (changed === null) return null;
  if (!changed.length) return [];
  const explained = await othersChanges(root, initiative, slice, { ...design, currentTree: tree }, changed);
  const folder = component === declaration.root ? "" : component.folder;
  return changed.filter((file) => !explained.has(file) && crossesComponent(design.startDeclaration, component.identity, folder, file)).sort();
}

async function verificationRun({ root, initiative, slice, target, key, design, signal, onProgress, dataDirectory }) {
  const { command, config } = target;
  const startedAt = new Date().toISOString();
  const id = `verification-${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const frozen = await checkFrozenTests(root, design.frozenTests);
  let log = null;
  const base = { kind: "verification", startedAt, command, folder: target.folder, ...(target.component ? { component: target.component.identity } : {}), commandDigest: key, designAcceptedAt: design.acceptedAt, frozen };
  const stopped = { durationMs: 0, exitCode: null, signal: null, timedOut: false, passed: false, outputTail: "" };
  let entry;
  if (frozen.changed.length || frozen.missing.length) {
    // A run that stops at its frozen tests compares nothing with the start content, so its boundary is unchecked.
    entry = { ...base, ...(target.component ? { boundary: "unchecked" } : {}), finishedAt: startedAt, ...stopped, reason: "frozen_tests_changed", tree: null };
  } else {
    const before = await contentTree(root, config);
    // A slice with a component and start content checks, before the command runs, that its changes stay inside the component.
    // Only a slice started where Git could not hash the work tree, which has no start content, runs unchecked;
    // start content recorded without a declaration, or that Git can no longer read, fails the run, since no later declaration may decide its boundary.
    const checking = Boolean(target.component && design.startTree);
    const undeclared = checking && !design.startDeclaration;
    const crossing = checking && !undeclared ? await crossingPaths(root, initiative, slice, target, design, before) : null;
    const boundary = target.component ? { boundary: crossing === null ? "unchecked" : "checked" } : {};
    if (checking && crossing === null) {
      entry = { ...base, ...boundary, finishedAt: new Date().toISOString(), ...stopped, reason: "start_content_missing", startContent: undeclared ? "undeclared" : "unreadable", tree: before };
    } else if (crossing?.length) {
      entry = { ...base, ...boundary, finishedAt: new Date().toISOString(), ...stopped, reason: "component_boundary", crossing: crossing.slice(0, MAX_CROSSING_PATHS), crossingCount: crossing.length, tree: before };
    } else {
      const timeoutMs = Number(process.env.PRISM_VERIFY_TIMEOUT_MINUTES || DEFAULT_TIMEOUT_MINUTES) * 60000;
      const logPath = await logPathFor(dataDirectory, root, initiative, slice, id);
      const outcome = await execute(command, target.cwd, { signal, timeoutMs, onProgress, logPath });
      if (outcome.logged) log = logPath;
      const after = await contentTree(root, config).catch(() => null);
      const reason = outcome.cancelled ? "cancelled" : outcome.timedOut ? "timed_out" : outcome.exitCode !== 0 ? "command_failed" : after !== before ? "tracked_files_changed" : null;
      // A passing run keeps a snapshot of the verified source, which the derived change map compares with the design baseline.
      const snapshotId = reason === null && design.baselineId ? await conservationStore.capture(root, { initiative, slice }).then((captured) => captured.snapshotId, () => null) : null;
      // The content a passing run tested stays under the slice's passed ref while the slice has start content, so another slice's boundary check can still read it.
      if (reason === null && design.startTree) await setSliceRef(root, initiative, slice, "passed", before);
      entry = { ...base, ...boundary, finishedAt: new Date().toISOString(), durationMs: outcome.durationMs, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, passed: reason === null, ...(reason ? { reason } : {}), tree: before, ...(after !== before ? { treeAfter: after } : {}), ...(snapshotId ? { snapshotId } : {}), ...(reason === "command_failed" && outcome.failing.length ? { failing: outcome.failing.slice(0, MAX_FAILING_NAMES), failingCount: outcome.failing.length } : {}), outputTail: tail(outcome.output, RECORDED_TAIL_CHARS), output: outcome.output };
    }
  }
  entry.checkout = await checkoutOf(root, config, entry.tree).catch(() => null);
  const { output = entry.outputTail, ...recorded } = entry;
  const stored = await appendRecord(root, { kind: "runs", initiative, slice }, id, recorded);
  return { id, path: stored.path, ...recorded, ...(log ? { log } : {}), output };
}

// Git answers about the checkout are optional, so any error is an unknown value rather than a failed run.
function gitValue(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

// Hashing the committed content reads the head commit's tree into a scratch index, which a huge repository must not let stall a run.
const DIRTY_TIMEOUT_MS = 30000;

// A checkout's repository is the name its record store accepted, or its root commit when it names none or has no store.
async function repositoryOf(root) {
  const store = await recordStoreOf(root).catch(() => null);
  return store?.repository ?? repositoryId(root);
}

/** Where a run's code lives: { repository, remote, branch, head, dirty }; dirty is known only when the run hashed its work tree. */
export async function checkoutOf(root, config, tree = null) {
  const [repository, remote, branch, head] = await Promise.all([
    repositoryOf(root),
    gitValue(root, ["config", "--get", "remote.origin.url"]).then(publicRemote),
    gitValue(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitValue(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ]);
  let dirty = null;
  if (head && typeof tree === "string") {
    // Uncommitted changes count as verification's own content tree does, so records, plans, and the roadmap never make a checkout dirty.
    const committed = await contentTree(root, config, { commit: head, timeoutMs: DIRTY_TIMEOUT_MS }).catch(() => null);
    if (committed) dirty = tree !== committed;
  }
  return { repository, remote, branch, head, dirty };
}

// One run per slice at a time: a repeated call joins the running one, so a host that returns early can call again to keep waiting.
const jobs = new Map();

const REASONS = {
  frozen_tests_changed: "The frozen acceptance tests changed since the design was accepted, so the command did not run.",
  cancelled: "The run was cancelled.",
  timed_out: "The command exceeded the verification timeout.",
  command_failed: "The test command failed.",
  tracked_files_changed: "The command changed project files while it ran, so the run does not identify one tested state. Run verify_slice again.",
  component_boundary: "The changes since the slice started leave its component at the crossing paths, so the command did not run. Move each change this slice made back inside the component or under a shared path, or report the contract clause that needs it as a contract defect; report a crossing path that holds work this slice did not make instead of moving it.",
  start_content_missing: "Git can no longer read the content this slice started from, so its component boundary cannot be checked and the command did not run. Ask the user to set the slice back to not-started with the update_initiative set_status operation and start it again, which records the current content, the slice's earlier changes included, as new start content."
};

// Start content recorded while the ## Components declaration was invalid or lacked the slice's component has no declaration to check the boundary by.
const UNDECLARED_START = "This slice started while the ## Components declaration in .prism/workflow.md was invalid or did not hold its component, so its start content has no declaration to check the component boundary by and the command did not run. Ask the user to make the ## Components declaration valid and hold the slice's component, then set the slice back to not-started with the update_initiative set_status operation and start it again, which records the current content, the slice's earlier changes included, as new start content with that declaration.";

function resultOf(run) {
  const { output, ...rest } = run;
  const message = run.reason === "start_content_missing" && run.startContent === "undeclared" ? UNDECLARED_START : REASONS[run.reason];
  return { status: run.passed ? "passed" : "failed", ...rest, ...(run.reason ? { message } : {}), outputTail: tail(output ?? "", RETURNED_TAIL_CHARS) };
}

/** Run the approved test command of a slice with an accepted design in its working folder, after checking its frozen tests and, for a slice with a component, its component boundary, and record the run. */
export async function verifySlice({ projectRoot, initiative, slice, approvalGate, chatApproval, contractDefects, dataDirectory, signal, onProgress, maxWaitMs = Infinity }) {
  try { assertInput(VERIFY_SLICE_SCHEMA, { projectRoot, initiative, slice, ...(approvalGate ? { approvalGate } : {}), ...(chatApproval ? { chatApproval } : {}), ...(contractDefects ? { contractDefects } : {}) }); }
  catch (error) { throw fail("validation_failed", `The verification arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors }); }
  const root = await realpath(projectRoot);
  const design = await acceptedDesign(root, initiative, slice);
  if (!design) throw fail("design_missing", `The slice ${slice} has no accepted design. Accept it with the update_initiative accept_design operation before verification.`);
  if (design.staged) throw fail("slice_not_started", `The slice ${slice} has not started, so its frozen tests are not in place. Start it with the update_initiative set_status in-progress operation.`);
  if (contractDefects) return reportContractDefects(root, initiative, slice, design, contractDefects);
  const target = await verificationTarget(root, initiative, slice);
  const { command, folder, declaredFolder, cwd } = target;
  const names = named(target);
  const where = folder === "" ? "the project root" : `the folder ${folder}`;
  const allowed = await approval({ root, initiative, slice, command, folder, declaredFolder, cwd, approvalGate, chatApproval, dataDirectory });
  if (!allowed.approved) {
    if (allowed.status === "declined") return { status: "declined", gateId: allowed.gateId, ...names, note: allowed.note, message: "The user declined this test command, so it did not run." };
    if (allowed.status === "approval_unclear") return { status: "approval_unclear", gateId: allowed.gateId, ...names, note: allowed.note, message: "The user answered the approval question with a note and neither allowed nor declined the command, so it did not run. Read the note, then call verify_slice without approvalGate to ask again." };
    if (reviewBrowserUnreachable()) return { status: "approval_needed", gateId: allowed.gateId, ...names, chatApproval: true, message: `The user cannot open the review browser from this cloud session. Ask them in chat whether Prism may run this exact test command in ${where}: ${command}. When they allow it, call verify_slice again with approvalGate ${allowed.gateId} and chatApproval quoting their answer word for word.` };
    return { status: "approval_needed", gateId: allowed.gateId, ...names, message: `The user must allow the test command in the review browser first. Wait with wait_for_user_gate on ${allowed.gateId}, then call verify_slice again with approvalGate ${allowed.gateId}.` };
  }
  const jobKey = `${root}\0${initiative}\0${slice}`;
  let job = jobs.get(jobKey);
  if (!job || job.command !== command || job.cwd !== cwd) {
    const controller = new AbortController();
    const listeners = new Set();
    job = { command, cwd, controller, listeners, startedAt: new Date().toISOString(), promise: null };
    job.promise = verificationRun({ root, initiative, slice, target, key: allowed.key, design, dataDirectory, signal: controller.signal, onProgress: (seconds, latest) => listeners.forEach((listener) => listener(seconds, latest)) })
      .then((run) => completeSlice(root, initiative, slice, design, run))
      .finally(() => { if (jobs.get(jobKey) === job) jobs.delete(jobKey); });
    // A caller that returned early no longer awaits the run, so its failure must not go unhandled.
    job.promise.catch(() => {});
    jobs.set(jobKey, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  const abort = () => job.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    const early = Number.isFinite(maxWaitMs) ? new Promise((resolve) => { timer = setTimeout(() => resolve(null), maxWaitMs); }) : new Promise(() => {});
    const finished = await Promise.race([job.promise, early]);
    if (finished === null) {
      return { status: "running", ...names, startedAt: job.startedAt, message: "The run continues in the Prism server. Call verify_slice again with the same arguments to keep waiting for its result." };
    }
    return finished.reason === "cancelled" && signal?.aborted ? { status: "cancelled" } : resultOf(finished);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (onProgress) job.listeners.delete(onProgress);
  }
}

// Reported defects are kept as a run entry, which outlives the initiative record, and block the slice until design revises the contract.
async function reportContractDefects(root, initiative, slice, design, defects) {
  const id = `contract-defect-${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  // A defect report hashes no work tree, so its checkout leaves dirty unknown.
  const checkout = await checkoutOf(root, await readWorkflowConfig(root)).catch(() => null);
  const stored = await appendRecord(root, { kind: "runs", initiative, slice }, id, { kind: "contract-defect", reportedAt: new Date().toISOString(), designAcceptedAt: design.acceptedAt, defects, checkout });
  const { readInitiative, updateInitiative } = await import("./initiative.mjs");
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Only the revision is needed, so the retry never reads the slices' run entries that get_initiative summarizes.
      const current = (await readInitiative(root, initiative)).loaded;
      const updated = await updateInitiative({ projectRoot: root, initiative, expectedRevision: current.revision, actor: "verify_slice", operations: [{ op: "report_contract_defects", slug: slice, defects }] });
      return { status: "defects_recorded", sliceStatus: "blocked", initiativeRevision: updated.revision, run: stored.path, message: `The contract defects of ${slice} are recorded and the slice is blocked until design revises its contract. Stop implementing it.` };
    } catch (error) {
      if (error.code === "revision_conflict" && attempt < 3) continue;
      throw error;
    }
  }
}

// A passing run completes a slice whose design marks no review, so the coordinator never records that step itself.
async function completeSlice(root, initiative, slice, design, run) {
  if (!run.passed || design.review === "required") return run;
  const { readInitiative, updateInitiative } = await import("./initiative.mjs");
  // Another writer can update the record between the read and the write, so a revision conflict reads it again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Only the revision is needed, so the retry never reads the slices' run entries that get_initiative summarizes.
      const current = (await readInitiative(root, initiative)).loaded;
      if (current.record?.slices?.[slice]?.status === "done") return { ...run, sliceStatus: "done", initiativeRevision: current.revision };
      const updated = await updateInitiative({ projectRoot: root, initiative, expectedRevision: current.revision, actor: "verify_slice", operations: [{ op: "set_status", slug: slice, status: "done" }] });
      return { ...run, sliceStatus: "done", initiativeRevision: updated.revision };
    } catch (error) {
      if (error.code === "revision_conflict" && attempt < 3) continue;
      return { ...run, sliceStatus: "unchanged", statusMessage: `The run passed, but the slice was not marked done: ${error.message} Call update_initiative with set_status done.` };
    }
  }
}

// Test names a failing run reports, read from common runner formats: cargo, Node, TAP, pytest, Go, Jest, and Vitest.
const FAILING_PATTERNS = [
  /^test (\S+) \.\.\. FAILED$/,
  /^---- (\S+) stdout ----$/,
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/,
  /^FAILED (\S+)/,
  /^--- FAIL: (\S+)/,
  /^\s*[✖✕×] (.+?)(?: \(\d+(?:\.\d+)?\s*m?s\))?$/
];

// A TAP line marked TODO or SKIP is an expected failure, not a broken test.
const EXPECTED_FAILURE = /^\s*not ok \d+\b.*\s#\s*(?:TODO|SKIP)\b/i;

function failingName(line) {
  const trimmed = line.trimEnd();
  if (EXPECTED_FAILURE.test(trimmed)) return null;
  for (const pattern of FAILING_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

export function failingTests(output) {
  const names = new Set();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const name = failingName(line);
    if (name) names.add(name);
  }
  return [...names];
}

/** What a coordinator needs from a run: the verdict, the failing tests, and where the full log is; the record keeps the rest. */
export function verificationBrief(value) {
  if (!["passed", "failed"].includes(value.status)) return value;
  // A run reads failing names from its whole output; the tail is only a fallback for a result without them.
  const failing = value.status !== "failed" ? [] : value.failing ?? failingTests(value.outputTail);
  const failingCount = value.failingCount ?? failing.length;
  const frozen = value.frozen && (value.frozen.changed.length || value.frozen.missing.length) ? { frozenChanged: value.frozen.changed, frozenMissing: value.frozen.missing } : {};
  return {
    status: value.status,
    ...(value.reason ? { reason: value.reason, message: value.message } : {}),
    // A run that left its component lists the paths to move back, so the brief keeps them.
    ...(value.crossing ? { crossing: value.crossing, crossingCount: value.crossingCount } : {}),
    ...(value.component ? { component: value.component } : {}),
    ...(value.folder !== undefined ? { folder: value.folder } : {}),
    ...(value.boundary ? { boundary: value.boundary } : {}),
    ...(failing.length ? { failing: failing.slice(0, MAX_FAILING_NAMES), failingCount } : {}),
    ...frozen,
    ...(value.sliceStatus ? { sliceStatus: value.sliceStatus } : {}),
    // Marking the slice done writes the initiative record, so the caller's next update needs this revision.
    ...(value.initiativeRevision ? { initiativeRevision: value.initiativeRevision } : {}),
    ...(value.statusMessage ? { statusMessage: value.statusMessage } : {}),
    durationMs: value.durationMs,
    run: value.path,
    ...(value.log ? { log: value.log } : {}),
    ...(value.status === "passed" && value.checkout ? { code: value.checkout } : {}),
    ...(value.status === "failed" && value.outputTail ? { outputTail: tail(value.outputTail, BRIEF_TAIL_CHARS) } : {})
  };
}

/** Abort every running verification, as the server does when its host disconnects. */
export function cancelVerifications() {
  for (const job of jobs.values()) job.controller.abort();
}
