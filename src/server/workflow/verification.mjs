import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { appendRecord, RECORD_DIRECTORY } from "./record-store.mjs";
import { contentTree } from "./slice-gate.mjs";
import { acceptedDesign, checkFrozenTests } from "./slice-design.mjs";
import { readCoordinationState, updateCoordinationState } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

const APPROVALS_FILE = "verification-approvals.json";
const OUTPUT_TAIL_BYTES = 64 * 1024;
const RECORDED_TAIL_CHARS = 4000;
const RETURNED_TAIL_CHARS = 20000;
const BRIEF_TAIL_CHARS = 1500;
const MAX_FAILING_NAMES = 20;
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
  properties: { projectRoot: text, initiative: slug, slice: slug, approvalGate: { type: "string", pattern: "^gate-[0-9a-f]{8,32}$" } },
  required: ["projectRoot", "initiative", "slice"]
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** The test command a project configures in .prism/workflow.md under Stack. */
export async function configuredTestCommand(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const command = config.sections?.Stack?.["Test command"]?.trim();
  return { config, command: command && !/^n\/a$/i.test(command) ? command : null };
}

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

function approvalQuestion(command, key) {
  return [
    "Allow Prism to run this test command to verify slices in this project?",
    "",
    command,
    "",
    "Prism runs it with your shell in the project root. A changed command asks again.",
    `Approval key: ${key.slice(0, 12)}`
  ].join("\n");
}

// Only the review browser records gate answers, so an Allow choice on the server's own gate is the user's approval.
async function approval({ root, initiative, slice, command, approvalGate, dataDirectory }) {
  const key = digest(`${root}\n${command}`);
  return withApprovals(dataDirectory, async (store) => {
    if (store.approved[key]) return { approved: true, key };
    if (approvalGate && store.requests[approvalGate] && store.requests[approvalGate].key !== key) throw fail("approval_mismatch", `The gate ${approvalGate} asked about another test command. Call verify_slice without approvalGate to ask about the configured one.`);
    const requested = approvalGate && store.requests[approvalGate] ? approvalGate : Object.entries(store.requests).find(([, item]) => item.key === key && item.initiative === initiative)?.[0];
    if (requested) {
      const request = store.requests[requested];
      const gate = await pendingGate(root, request.initiative, requested);
      if (!gate) {
        delete store.requests[requested];
      } else if (gate.answer?.via === "browser" && gate.answer.choice === ALLOW) {
        store.approved[key] = { root, command, approvedAt: gate.answer.answeredAt, gate: requested };
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {});
        return { approved: true, key };
      } else if (gate.answer) {
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {});
        return { approved: false, key, status: "declined", gateId: requested, note: gate.answer.note ?? null };
      } else {
        return { approved: false, key, status: "approval_needed", gateId: requested };
      }
    }
    const opened = await gateChange(root, initiative, { gateOperations: [{ op: "ask", kind: "decision", slice, question: approvalQuestion(command, key), artifacts: [".prism/workflow.md"], options: [{ id: ALLOW, label: "Allow this command" }, { id: DECLINE, label: "Decline" }] }] });
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

// The plugin's MCP definitions set NODE_USE_ENV_PROXY for the server's own downloads; a test command must not inherit it,
// because Node then warns on stderr and tests that assert stderr fail only under verification.
function commandEnvironment() {
  const { NODE_USE_ENV_PROXY: _serverOnly, ...environment } = process.env;
  return environment;
}

function execute(command, root, { signal, timeoutMs, onProgress }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "", timedOut = false, cancelled = false, forced = null;
    const child = spawn(command, { cwd: root, env: commandEnvironment(), shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => { output = tail(output + chunk.toString("utf8"), OUTPUT_TAIL_BYTES); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
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
      resolve({ exitCode, signal: exitSignal, timedOut, cancelled, output: spawnError ? `${output}${spawnError.message}\n` : output, durationMs: Date.now() - started });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, exitSignal) => finish(code, exitSignal));
  });
}

// The full output stays in local plugin data, outside the project, so a caller reads it only when the brief result is not enough.
async function writeLog(dataDirectory, root, initiative, slice, id, output) {
  try {
    const directory = path.join(dataDirectoryOf(dataDirectory), "verification-logs", digest(root).slice(0, 16), initiative, slice);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${id}.log`);
    await writeFile(target, output);
    return target;
  } catch { return null; }
}

async function verificationRun({ root, initiative, slice, command, key, config, design, signal, onProgress, dataDirectory }) {
  const startedAt = new Date().toISOString();
  const frozen = await checkFrozenTests(root, design.frozenTests);
  const base = { kind: "verification", startedAt, command, commandDigest: key, designAcceptedAt: design.acceptedAt, frozen };
  let entry;
  if (frozen.changed.length || frozen.missing.length) {
    entry = { ...base, finishedAt: startedAt, durationMs: 0, exitCode: null, signal: null, timedOut: false, passed: false, reason: "frozen_tests_changed", tree: null, outputTail: "" };
  } else {
    const before = await contentTree(root, config);
    const timeoutMs = Number(process.env.PRISM_VERIFY_TIMEOUT_MINUTES || DEFAULT_TIMEOUT_MINUTES) * 60000;
    const outcome = await execute(command, root, { signal, timeoutMs, onProgress });
    const after = await contentTree(root, config).catch(() => null);
    const reason = outcome.cancelled ? "cancelled" : outcome.timedOut ? "timed_out" : outcome.exitCode !== 0 ? "command_failed" : after !== before ? "tracked_files_changed" : null;
    // A passing run keeps a snapshot of the verified source, which the derived change map compares with the design baseline.
    const snapshotId = reason === null && design.baselineId ? await conservationStore.capture(root, { initiative, slice }).then((captured) => captured.snapshotId, () => null) : null;
    entry = { ...base, finishedAt: new Date().toISOString(), durationMs: outcome.durationMs, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, passed: reason === null, ...(reason ? { reason } : {}), tree: before, ...(after !== before ? { treeAfter: after } : {}), ...(snapshotId ? { snapshotId } : {}), outputTail: tail(outcome.output, RECORDED_TAIL_CHARS), output: outcome.output };
  }
  const { output = entry.outputTail, ...recorded } = entry;
  const id = `verification-${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const stored = await appendRecord(root, { kind: "runs", initiative, slice }, id, recorded);
  const log = output ? await writeLog(dataDirectory, root, initiative, slice, id, output) : null;
  return { id, path: stored.path, ...recorded, ...(log ? { log } : {}), output };
}

// One run per slice at a time: a repeated call joins the running one, so a host that returns early can call again to keep waiting.
const jobs = new Map();

const REASONS = {
  frozen_tests_changed: "The frozen acceptance tests changed since the design was accepted, so the command did not run.",
  cancelled: "The run was cancelled.",
  timed_out: "The command exceeded the verification timeout.",
  command_failed: "The test command failed.",
  tracked_files_changed: "The command changed project files while it ran, so the run does not identify one tested state. Run verify_slice again."
};

function resultOf(run) {
  const { output, ...rest } = run;
  return { status: run.passed ? "passed" : "failed", ...rest, ...(run.reason ? { message: REASONS[run.reason] } : {}), outputTail: tail(output ?? "", RETURNED_TAIL_CHARS) };
}

/** Run the project's approved test command for a slice with an accepted design, check its frozen tests, and record the run. */
export async function verifySlice({ projectRoot, initiative, slice, approvalGate, dataDirectory, signal, onProgress, maxWaitMs = Infinity }) {
  try { assertInput(VERIFY_SLICE_SCHEMA, { projectRoot, initiative, slice, ...(approvalGate ? { approvalGate } : {}) }); }
  catch (error) { throw fail("validation_failed", `The verification arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors }); }
  const root = await realpath(projectRoot);
  const design = await acceptedDesign(root, initiative, slice);
  if (!design) throw fail("design_missing", `The slice ${slice} has no accepted design. Accept it with the update_initiative accept_design operation before verification.`);
  if (design.staged) throw fail("slice_not_started", `The slice ${slice} has not started, so its frozen tests are not in place. Start it with the update_initiative set_status in-progress operation.`);
  const { config, command } = await configuredTestCommand(root);
  if (!command) throw fail("test_command_missing", "The project configures no test command. Add one under ## Stack in .prism/workflow.md as - Test command: <command>.");
  const allowed = await approval({ root, initiative, slice, command, approvalGate, dataDirectory });
  if (!allowed.approved) {
    if (allowed.status === "declined") return { status: "declined", gateId: allowed.gateId, command, note: allowed.note, message: "The user declined this test command, so it did not run." };
    return { status: "approval_needed", gateId: allowed.gateId, command, message: `The user must allow the test command in the review browser first. Wait with wait_for_user_gate on ${allowed.gateId}, then call verify_slice again with approvalGate ${allowed.gateId}.` };
  }
  const jobKey = `${root}\0${initiative}\0${slice}`;
  let job = jobs.get(jobKey);
  if (!job || job.command !== command) {
    const controller = new AbortController();
    const listeners = new Set();
    job = { command, controller, listeners, startedAt: new Date().toISOString(), promise: null };
    job.promise = verificationRun({ root, initiative, slice, command, key: allowed.key, config, design, dataDirectory, signal: controller.signal, onProgress: (seconds, latest) => listeners.forEach((listener) => listener(seconds, latest)) })
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
      return { status: "running", command, startedAt: job.startedAt, message: "The run continues in the Prism server. Call verify_slice again with the same arguments to keep waiting for its result." };
    }
    return finished.reason === "cancelled" && signal?.aborted ? { status: "cancelled" } : resultOf(finished);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (onProgress) job.listeners.delete(onProgress);
  }
}

// A passing run completes a slice whose design marks no review, so the coordinator never records that step itself.
async function completeSlice(root, initiative, slice, design, run) {
  if (!run.passed || design.review === "required") return run;
  const { getInitiative, updateInitiative } = await import("./initiative.mjs");
  // Another writer can update the record between the read and the write, so a revision conflict reads it again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const current = await getInitiative({ projectRoot: root, initiative });
      if (current.record?.slices?.[slice]?.status === "done") return { ...run, sliceStatus: "done" };
      await updateInitiative({ projectRoot: root, initiative, expectedRevision: current.revision, actor: "verify_slice", operations: [{ op: "set_status", slug: slice, status: "done" }] });
      return { ...run, sliceStatus: "done" };
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
  /^not ok \d+ - (.+?)(?:\s+#.*)?$/,
  /^FAILED (\S+)/,
  /^--- FAIL: (\S+)/,
  /^\s*[✖✕×] (.+?)(?: \(\d+(?:\.\d+)?\s*m?s\))?$/
];

export function failingTests(output) {
  const names = new Set();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    for (const pattern of FAILING_PATTERNS) {
      const match = pattern.exec(line.trimEnd());
      if (match) { names.add(match[1].trim()); break; }
    }
  }
  return [...names];
}

/** What a coordinator needs from a run: the verdict, the failing tests, and where the full log is; the record keeps the rest. */
export function verificationBrief(value) {
  if (!["passed", "failed"].includes(value.status)) return value;
  const failing = value.status === "failed" ? failingTests(value.outputTail) : [];
  const frozen = value.frozen && (value.frozen.changed.length || value.frozen.missing.length) ? { frozenChanged: value.frozen.changed, frozenMissing: value.frozen.missing } : {};
  return {
    status: value.status,
    ...(value.reason ? { reason: value.reason, message: value.message } : {}),
    ...(failing.length ? { failing: failing.slice(0, MAX_FAILING_NAMES), failingCount: failing.length } : {}),
    ...frozen,
    ...(value.sliceStatus ? { sliceStatus: value.sliceStatus } : {}),
    ...(value.statusMessage ? { statusMessage: value.statusMessage } : {}),
    durationMs: value.durationMs,
    run: value.path,
    ...(value.log ? { log: value.log } : {}),
    ...(value.status === "failed" && value.outputTail ? { outputTail: tail(value.outputTail, BRIEF_TAIL_CHARS) } : {})
  };
}

/** Abort every running verification, as the server does when its host disconnects. */
export function cancelVerifications() {
  for (const job of jobs.values()) job.controller.abort();
}
