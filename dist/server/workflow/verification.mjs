// Generated from src/server/workflow/verification.mts by scripts/native-build/compile.mjs.
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
import { changedBlobs, objectsAt } from "./git-objects.mjs";
import { appendRecord, listRecordEntries, locateRecord, readStoreFileBytes, RECORD_DIRECTORY, recordStoreOf, STORE_FILE_BOUNDS } from "./record-store.mjs";
import { repositoryId } from "./repository-names.mjs";
import { changedPaths, contentTree, crossesComponent, setSliceRef, treeId, treeReadable } from "./slice-gate.mjs";
import { acceptedDesign, checkFrozenTests, designProblems } from "./slice-design.mjs";
import { readCoordinationState, updateCoordinationState } from "./state.mjs";
import { refuseShipped } from "./shipped-history.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { publicRemote } from "./remote-url.mjs";
import { parseStoreJson } from "./store-json.mjs";
const APPROVALS_FILE = "verification-approvals.json";
const OUTPUT_TAIL_BYTES = 64 * 1024;
const RECORDED_TAIL_CHARS = 4e3;
const RETURNED_TAIL_CHARS = 2e4;
const BRIEF_TAIL_CHARS = 1500;
const MAX_FAILING_NAMES = 20;
const MAX_TRACKED_FAILURES = 1e3;
const MAX_CROSSING_PATHS = 200;
const MAX_RUN_FILES = 2e3;
const DEFAULT_TIMEOUT_MINUTES = 30;
const PROGRESS_MS = 3e4;
const KILL_GRACE_MS = 5e3;
const ALLOW = "allow";
const DECLINE = "decline";
class VerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new VerificationError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 2e3 };
const slug = { type: "string", minLength: 1, maxLength: 120 };
const VERIFY_SLICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectRoot: text,
    initiative: slug,
    slice: slug,
    approvalGate: { type: "string", pattern: "^gate-[0-9a-f]{8,32}$" },
    chatApproval: { type: "object", additionalProperties: false, properties: { quote: { type: "string", minLength: 1, maxLength: 800 } }, required: ["quote"] },
    contractDefects: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", additionalProperties: false, properties: { clause: text, reason: text }, required: ["clause", "reason"] } },
    dependents: { type: "boolean" }
  },
  required: ["projectRoot", "initiative", "slice"]
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const approvalKey = (cwd, command) => digest(`${cwd}
${command}`);
const TEST_COMMAND_PLACEHOLDER = /^none yet$/i;
const PLACEHOLDER_MESSAGE = "The project has no tests yet: its test command is the placeholder none yet, so Prism has nothing to run. The slice that adds the project's test runner sets the real command in .prism/workflow.md, and verification runs that command once it is set.";
function refusePlaceholder(command, details = {}) {
  if (TEST_COMMAND_PLACEHOLDER.test(command)) throw fail("test_command_placeholder", PLACEHOLDER_MESSAGE, details);
}
async function configuredTestCommand(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const command = config.sections?.Stack?.["Test command"]?.trim();
  return { config, command: command && !/^n\/a$/i.test(command) ? command : null };
}
async function recordedSlices(root, initiative) {
  const located = await locateRecord(root, { kind: "initiative", initiative });
  try {
    return parseStoreJson((await readStoreFileBytes(located.target, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null")?.slices ?? {};
  } catch {
    return {};
  }
}
async function recordedComponent(root, initiative, slice) {
  return (await recordedSlices(root, initiative))[slice]?.component ?? void 0;
}
function projectFolder(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
async function verificationTarget(root, initiative, slice) {
  const identity = await recordedComponent(root, initiative, slice);
  if (identity === void 0) {
    const { config: config2, command } = await configuredTestCommand(root);
    if (!command) throw fail("test_command_missing", "The project configures no test command. Add one under ## Stack in .prism/workflow.md as - Test command: <command>, or - Test command: none yet while the project has no tests.");
    refusePlaceholder(command);
    return { config: config2, command, folder: "", declaredFolder: "", cwd: root, component: null, declaration: null };
  }
  const config = await readWorkflowConfig(root);
  const declaration = readComponents(config);
  const component = findComponent(declaration, identity);
  if (component === null) {
    const components = declaration.components.map((item) => item.identity);
    throw fail("component_unknown", `The slice ${slice} records the component ${identity}, which is not a component of this repository now. Declare it again under ## Components in .prism/workflow.md, or accept the design again with one of ${components.join(", ")}.`, { slice, component: identity, components });
  }
  return { config, ...await componentTarget(root, declaration, component), component, declaration };
}
async function componentTarget(root, declaration, component) {
  const own = component !== declaration.root && component.testCommand !== null;
  const command = own ? component.testCommand : declaration.root.testCommand;
  const declaredFolder = own ? component.folder : "";
  if (!command) {
    const message = component === declaration.root ? "The project configures no test command. Add one under ## Stack in .prism/workflow.md as - Test command: <command>." : `Neither the component ${component.identity} nor the project configures a test command. Add one under the component in ## Components as - Test command: <command>, or under ## Stack in .prism/workflow.md.`;
    throw fail("test_command_missing", message, { component: component.identity });
  }
  refusePlaceholder(command, { component: component.identity });
  let cwd = null;
  try {
    const resolved = await realpath(path.join(root, declaredFolder));
    if ((await stat(resolved)).isDirectory()) cwd = resolved;
  } catch {
    cwd = null;
  }
  if (cwd === null) throw fail("component_folder_missing", `The folder ${declaredFolder} of the component ${component.identity}, where its test command runs, does not exist or is not a folder.`, { component: component.identity, folder: declaredFolder });
  const folder = projectFolder(root, cwd);
  if (folder === null) throw fail("component_folder_outside", `The folder ${declaredFolder} of the component ${component.identity} leads outside the project through a symbolic link, so Prism does not run its test command there. Point the component at a folder inside the project.`, { component: component.identity, folder: declaredFolder });
  return { command, folder, declaredFolder, cwd };
}
const named = (target) => ({ command: target.command, folder: target.folder, ...target.component ? { component: target.component.identity } : {} });
function dataDirectoryOf(dataDirectory) {
  return dataDirectory || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), RECORD_DIRECTORY);
}
async function withApprovals(dataDirectory, action) {
  const directory = dataDirectoryOf(dataDirectory);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, APPROVALS_FILE);
  return withArtifactLock(target, () => withFileLock(target, async () => {
    let store;
    try {
      store = parseStoreJson(await readFile(target, "utf8"));
    } catch {
      store = null;
    }
    if (!store || store.schemaVersion !== 1 || typeof store.approved !== "object" || typeof store.requests !== "object") store = { schemaVersion: 1, approved: {}, requests: {} };
    const before = JSON.stringify(store);
    const result = await action(store);
    if (JSON.stringify(store) !== before) await writeAtomically(target, `${JSON.stringify(store, null, 2)}
`);
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
const APPROVAL_CONTEXT = "A slice is done only when Prism itself runs the project's tests and they pass. The command comes from `.prism/workflow.md`, and Prism has not run it in this folder before, so it asks you once. Whatever the command runs, runs with your shell, so check that it is the test command you expect.";
const APPROVAL_RECOMMENDATION = { option: ALLOW, reason: "Allow it when it is the test command you configured for this project; decline when you do not recognize it." };
function approvalQuestion(command, folder, declaredFolder, key) {
  const place2 = `${folder === "" ? "the project root" : `the folder ${folder}`}${declaredFolder && declaredFolder !== folder ? `, where the component folder ${declaredFolder} leads` : ""}`;
  return [
    "Allow Prism to run this test command to verify slices in this project?",
    "",
    command,
    "",
    `Prism runs it with your shell in ${place2}. A changed command, or the same command in another folder, asks again.`,
    `Approval key: ${key.slice(0, 12)}`
  ].join("\n");
}
function reviewBrowserUnreachable(env = process.env) {
  return env.CLAUDE_CODE_REMOTE === "true";
}
async function approval({ root, initiative, slice, command, folder, declaredFolder, cwd, approvalGate, chatApproval, dataDirectory }) {
  const key = approvalKey(cwd, command);
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
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {
        });
        return { approved: true, key };
      } else if (gate.answer) {
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {
        });
        return { approved: false, key, status: gate.answer.choice === DECLINE ? "declined" : "approval_unclear", gateId: requested, note: gate.answer.note ?? null };
      } else if (chatApproval) {
        const quote = chatApproval.quote.trim();
        const approvedAt = (/* @__PURE__ */ new Date()).toISOString();
        store.approved[key] = { root, folder, command, approvedAt, gate: requested, via: "chat", quote };
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested, reason: `The user allowed this command in chat, as recorded by the agent: "${quote}"` }] }).catch(() => {
        });
        return { approved: true, key };
      } else {
        return { approved: false, key, status: "approval_needed", gateId: requested };
      }
    }
    const opened = await gateChange(root, initiative, { gateOperations: [{ op: "ask", kind: "decision", slice, question: approvalQuestion(command, folder, declaredFolder, key), context: APPROVAL_CONTEXT, artifacts: [".prism/workflow.md"], options: [
      { id: ALLOW, label: "Allow this command", consequence: "Prism runs it now and on every later verification that uses this exact command in this folder." },
      { id: DECLINE, label: "Decline", consequence: "Prism does not run it, and the slice stays unverified until the command changes or you allow it." }
    ], recommended: APPROVAL_RECOMMENDATION }] });
    const gateId = opened.openedGates[0].id;
    store.requests[gateId] = { key, initiative, askedAt: (/* @__PURE__ */ new Date()).toISOString() };
    return { approved: false, key, status: "approval_needed", gateId };
  });
}
function tail(value, limit) {
  return value.length > limit ? value.slice(value.length - limit) : value;
}
function killGroup(child, signal) {
  if (process.platform === "win32") {
    if (!child.pid) return;
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
const SERVER_ONLY = /^(?:NODE_USE_ENV_PROXY|CLAUDE_PLUGIN_\w+|PLUGIN_DATA|PLUGIN_ROOT)$/;
function commandEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SERVER_ONLY.test(name)));
}
function execute(command, cwd, { signal, timeoutMs, onProgress, logPath = null }) {
  return new Promise((resolve) => {
    let log = logPath ? createWriteStream(logPath) : null;
    log?.on("error", () => {
      log = null;
    });
    const started = Date.now();
    let output = "", timedOut = false, cancelled = false, forced = null;
    const child = spawn(command, { cwd, env: commandEnvironment(), shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const failing = /* @__PURE__ */ new Set();
    const scanners = /* @__PURE__ */ new Map();
    const scan = (stream, text2, end = false) => {
      const lines = `${scanners.get(stream) ?? ""}${text2}`.split(/\r?\n/);
      scanners.set(stream, end ? "" : tail(lines.pop(), OUTPUT_TAIL_BYTES));
      for (const line of lines) if (failing.size < MAX_TRACKED_FAILURES) {
        const name = failingName(line);
        if (name) failing.add(name);
      }
    };
    const collect = (stream) => (chunk) => {
      const text2 = chunk.toString("utf8");
      log?.write(chunk);
      output = tail(output + text2, OUTPUT_TAIL_BYTES);
      scan(stream, text2);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const stop = () => {
      killGroup(child, "SIGTERM");
      forced = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      forced.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const ticker = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1e3), tail(output, 300)), PROGRESS_MS) : null;
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (exitCode, exitSignal, spawnError) => {
      clearTimeout(timer);
      clearTimeout(forced);
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener("abort", abort);
      for (const stream of scanners.keys()) scan(stream, "", true);
      if (spawnError) log?.write(`${spawnError.message}
`);
      const done = { exitCode, signal: exitSignal, timedOut, cancelled, output: spawnError ? `${output}${spawnError.message}
` : output, failing: [...failing], durationMs: Date.now() - started };
      if (!log) {
        resolve({ ...done, logged: false });
        return;
      }
      const written = log;
      written.end(() => resolve({ ...done, logged: log === written }));
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, exitSignal) => finish(code, exitSignal));
  });
}
function homeRelative(file) {
  const home = os.homedir();
  const relative = path.relative(home, file);
  return home && relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~/${relative.split(path.sep).join("/")}` : file;
}
async function logPathFor(dataDirectory, root, initiative, slice, id) {
  try {
    const directory = path.join(dataDirectoryOf(dataDirectory), "verification-logs", digest(root).slice(0, 16), initiative, slice);
    await mkdir(directory, { recursive: true });
    return path.join(directory, `${id}.log`);
  } catch {
    return null;
  }
}
async function othersChanges(root, initiative, slice, design, changed) {
  const explained = /* @__PURE__ */ new Set();
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
    if (!latest || !treeId(latest.tree) || !treeId(theirs.startTree) || !(Date.parse(latest.finishedAt) > since) || theirs.startRecordedAt && !(Date.parse(latest.finishedAt) > Date.parse(theirs.startRecordedAt))) continue;
    const made = await changedPaths(root, theirs.startTree, latest.tree);
    const differs = made === null ? null : await changedPaths(root, latest.tree, design.currentTree);
    if (made === null || differs === null) continue;
    const moved = new Set(differs);
    for (const file of made) if (pending.has(file) && !moved.has(file)) explained.add(file);
  }
  return explained;
}
async function crossingPaths(root, initiative, slice, { component, declaration }, design, tree) {
  if (!await treeReadable(root, design.startTree)) return null;
  const changed = await changedPaths(root, design.startTree, tree);
  if (changed === null) return null;
  if (!changed.length) return [];
  const explained = await othersChanges(root, initiative, slice, { ...design, currentTree: tree }, changed);
  const folder = component === declaration.root ? "" : component.folder;
  return changed.filter((file) => !explained.has(file) && crossesComponent(design.startDeclaration, component.identity, folder, file)).sort();
}
async function runFiles(root, design, tree) {
  const frozen = design.frozenTests.map((item) => item?.path).filter((item) => typeof item === "string");
  const changed = treeId(design.startTree) && await treeReadable(root, design.startTree) ? await changedBlobs(root, design.startTree, tree) : null;
  const blobs = new Map((changed ?? []).map((item) => [item.path, item.blob]));
  const tested = await objectsAt(root, tree, frozen);
  for (const file of frozen) blobs.set(file, tested?.get(file) ?? null);
  const files = [...blobs].map(([file, blob]) => ({ path: file, blob })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.slice(0, MAX_RUN_FILES), filesFrom: changed === null ? "frozen-tests" : "start-content", ...files.length > MAX_RUN_FILES ? { filesTruncated: true } : {} };
}
async function verificationRun({ root, initiative, slice, target, key, design, signal, onProgress, dataDirectory }) {
  const { command, config } = target;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const id = `verification-${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const frozen = await checkFrozenTests(root, design.frozenTests);
  let log = null;
  const base = { kind: "verification", startedAt, command, folder: target.folder, ...target.component ? { component: target.component.identity } : {}, commandDigest: key, designAcceptedAt: design.acceptedAt, frozen };
  const stopped = { durationMs: 0, exitCode: null, signal: null, timedOut: false, passed: false, outputTail: "" };
  let entry;
  if (frozen.changed.length || frozen.missing.length) {
    entry = { ...base, ...target.component ? { boundary: "unchecked" } : {}, finishedAt: startedAt, ...stopped, reason: "frozen_tests_changed", tree: null };
  } else {
    const before = await contentTree(root, config);
    const checking = Boolean(target.component && design.startTree);
    const undeclared = checking && !design.startDeclaration;
    const crossing = checking && !undeclared ? await crossingPaths(root, initiative, slice, target, design, before) : null;
    const boundary = target.component ? { boundary: crossing === null ? "unchecked" : "checked" } : {};
    if (checking && crossing === null) {
      entry = { ...base, ...boundary, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), ...stopped, reason: "start_content_missing", startContent: undeclared ? "undeclared" : "unreadable", tree: before };
    } else if (crossing?.length) {
      entry = { ...base, ...boundary, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), ...stopped, reason: "component_boundary", crossing: crossing.slice(0, MAX_CROSSING_PATHS), crossingCount: crossing.length, tree: before };
    } else {
      const timeoutMs = Number(process.env.PRISM_VERIFY_TIMEOUT_MINUTES || DEFAULT_TIMEOUT_MINUTES) * 6e4;
      const logPath = await logPathFor(dataDirectory, root, initiative, slice, id);
      const outcome = await execute(command, target.cwd, { signal, timeoutMs, onProgress, logPath });
      if (outcome.logged) log = logPath;
      const after = await contentTree(root, config).catch(() => null);
      const reason = outcome.cancelled ? "cancelled" : outcome.timedOut ? "timed_out" : outcome.exitCode !== 0 ? "command_failed" : after !== before ? "tracked_files_changed" : null;
      const snapshotId = reason === null && design.baselineId ? await conservationStore.capture(root, { initiative, slice }).then((captured) => captured.snapshotId, () => null) : null;
      if (reason === null && design.startTree) await setSliceRef(root, initiative, slice, "passed", before);
      entry = { ...base, ...boundary, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), durationMs: outcome.durationMs, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, passed: reason === null, ...reason ? { reason } : {}, tree: before, ...after !== before ? { treeAfter: after } : {}, ...snapshotId ? { snapshotId } : {}, ...reason === "command_failed" && outcome.failing.length ? { failing: outcome.failing.slice(0, MAX_FAILING_NAMES), failingCount: outcome.failing.length } : {}, outputTail: tail(outcome.output, RECORDED_TAIL_CHARS), output: outcome.output };
    }
  }
  if (treeId(entry.tree)) Object.assign(entry, await runFiles(root, design, entry.tree));
  entry.checkout = await checkoutOf(root, config, entry.tree).catch(() => null);
  if (log) entry.log = homeRelative(log);
  const { output = entry.outputTail, ...recorded } = entry;
  const stored = await appendRecord(root, { kind: "runs", initiative, slice }, id, recorded);
  return { id, path: stored.path, ...recorded, ...log ? { log } : {}, output };
}
function gitValue(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 1e4, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}
const DIRTY_TIMEOUT_MS = 3e4;
async function repositoryOf(root) {
  const store = await recordStoreOf(root).catch(() => null);
  return store?.repository ?? repositoryId(root);
}
const hostName = () => os.hostname().split(".")[0];
async function checkoutOf(root, config, tree = null) {
  const [repository, remote, branch, head] = await Promise.all([
    repositoryOf(root),
    gitValue(root, ["config", "--get", "remote.origin.url"]).then(publicRemote),
    gitValue(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitValue(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ]);
  let dirty = null;
  if (head && typeof tree === "string") {
    const committed = await contentTree(root, config, { commit: head, timeoutMs: DIRTY_TIMEOUT_MS }).catch(() => null);
    if (committed) dirty = tree !== committed;
  }
  return { repository, remote, branch, head, dirty, host: hostName() };
}
const jobs = /* @__PURE__ */ new Map();
const REASONS = {
  frozen_tests_changed: "The frozen acceptance tests changed since the design was accepted, so the command did not run.",
  cancelled: "The run was cancelled.",
  timed_out: "The command exceeded the verification timeout.",
  command_failed: "The test command failed.",
  tracked_files_changed: "The command changed project files while it ran, so the run does not identify one tested state. Run verify_slice again.",
  component_boundary: "The changes since the slice started leave its component at the crossing paths, so the command did not run. Move each change this slice made back inside the component or under a shared path, or report the contract clause that needs it as a contract defect; report a crossing path that holds work this slice did not make instead of moving it.",
  start_content_missing: "Git can no longer read the content this slice started from, so its component boundary cannot be checked and the command did not run. Ask the user to set the slice back to not-started with the update_initiative set_status operation and start it again, which records the current content, the slice's earlier changes included, as new start content."
};
const UNDECLARED_START = "This slice started while the ## Components declaration in .prism/workflow.md was invalid or did not hold its component, so its start content has no declaration to check the component boundary by and the command did not run. Ask the user to make the ## Components declaration valid and hold the slice's component, then set the slice back to not-started with the update_initiative set_status operation and start it again, which records the current content, the slice's earlier changes included, as new start content with that declaration.";
function resultOf(run) {
  const { output, ...rest } = run;
  const message = run.reason === "start_content_missing" && run.startContent === "undeclared" ? UNDECLARED_START : REASONS[run.reason];
  return { status: run.passed ? "passed" : "failed", ...rest, ...run.reason ? { message } : {}, outputTail: tail(output ?? "", RETURNED_TAIL_CHARS) };
}
async function verifySlice({ projectRoot, initiative, slice, approvalGate, chatApproval, contractDefects, dependents, dataDirectory, signal, onProgress, maxWaitMs = Infinity }) {
  try {
    assertInput(VERIFY_SLICE_SCHEMA, { projectRoot, initiative, slice, ...approvalGate ? { approvalGate } : {}, ...chatApproval ? { chatApproval } : {}, ...contractDefects ? { contractDefects } : {}, ...dependents === void 0 ? {} : { dependents } });
  } catch (error) {
    throw fail("validation_failed", `The verification arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors });
  }
  const root = await realpath(projectRoot);
  await refuseShipped(root, initiative);
  if (dependents === true) return dependentsRun({ root, initiative, scope: slice, approvalGate, chatApproval, contractDefects, dataDirectory, signal, onProgress, maxWaitMs });
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
  const signature = `${command}\0${cwd}\0${design.acceptedAt}\0${design.startTree ?? ""}`;
  const unreturned = jobs.has(jobKey) ? null : unreturnedRuns.get(jobKey);
  let rerunMessage = null;
  if (unreturned) {
    unreturnedRuns.delete(jobKey);
    const change = await changeSince(root, target, design, unreturned, signature);
    if (!change) return { ...resultOf(unreturned.run), repeated: true, repeatMessage: `This is the result of the run that finished at ${unreturned.run.finishedAt}, which no call had returned yet. The work tree and the frozen tests are unchanged since it started, so the command did not run again.` };
    rerunMessage = `${change}, so the command ran again.`;
  }
  const waited = await awaitJob(jobKey, signature, (jobSignal, progress) => verificationRun({ root, initiative, slice, target, key: allowed.key, design, dataDirectory, signal: jobSignal, onProgress: progress }).then((run) => completeSlice(root, initiative, slice, design, run)), { signal, onProgress, maxWaitMs, keepUnreturned: true });
  const rerun = rerunMessage ? { rerunMessage } : {};
  if (waited.running) return { status: "running", ...names, startedAt: waited.startedAt, ...rerun, message: "The run continues in the Prism server. Call verify_slice again with the same arguments to keep waiting for its result." };
  return waited.finished.reason === "cancelled" && signal?.aborted ? { status: "cancelled" } : { ...resultOf(waited.finished), ...rerun };
}
const unreturnedRuns = /* @__PURE__ */ new Map();
const RERUN_REASONS = /* @__PURE__ */ new Set(["cancelled", "tracked_files_changed"]);
async function changeSince(root, target, design, unreturned, signature) {
  const { run } = unreturned;
  const since = `since the run that finished at ${run.finishedAt} started`;
  if (unreturned.signature !== signature) return `The test command, its folder, or the slice's design changed ${since}`;
  if (!treeId(run.tree) || RERUN_REASONS.has(run.reason)) return `The run that finished at ${run.finishedAt} tested no single state of the work tree`;
  const frozen = await checkFrozenTests(root, design.frozenTests);
  if (frozen.changed.length || frozen.missing.length) return `The frozen tests changed ${since}`;
  const tree = await contentTree(root, target.config).catch(() => null);
  return tree === run.tree ? null : `The work tree changed ${since}`;
}
async function awaitJob(jobKey, signature, start, { signal, onProgress, maxWaitMs, keepUnreturned = false }, info = null) {
  let job = jobs.get(jobKey);
  if (!job || job.signature !== signature) {
    const controller = new AbortController();
    const listeners = /* @__PURE__ */ new Set();
    job = { signature, controller, listeners, startedAt: (/* @__PURE__ */ new Date()).toISOString(), promise: null, info, waiting: 0 };
    const started = job;
    if (keepUnreturned) unreturnedRuns.delete(jobKey);
    job.promise = start(controller.signal, (seconds, latest) => listeners.forEach((listener) => listener(seconds, latest))).then((finished) => {
      if (keepUnreturned && !started.waiting) unreturnedRuns.set(jobKey, { signature, run: { ...finished, output: tail(finished.output ?? "", RETURNED_TAIL_CHARS) } });
      return finished;
    }).finally(() => {
      if (jobs.get(jobKey) === started) jobs.delete(jobKey);
    });
    job.promise.catch(() => {
    });
    jobs.set(jobKey, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  const abort = () => job.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  job.waiting += 1;
  try {
    const early = Number.isFinite(maxWaitMs) ? new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), maxWaitMs);
    }) : new Promise(() => {
    });
    const finished = await Promise.race([job.promise, early]);
    return finished === null ? { running: true, startedAt: job.startedAt, info: job.info } : { finished };
  } finally {
    job.waiting -= 1;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (onProgress) job.listeners.delete(onProgress);
  }
}
async function reportContractDefects(root, initiative, slice, design, defects) {
  const id = `contract-defect-${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const checkout = await checkoutOf(root, await readWorkflowConfig(root)).catch(() => null);
  const stored = await appendRecord(root, { kind: "runs", initiative, slice }, id, { kind: "contract-defect", reportedAt: (/* @__PURE__ */ new Date()).toISOString(), designAcceptedAt: design.acceptedAt, defects, checkout });
  const { readInitiative, updateInitiative } = await import("./initiative.mjs");
  for (let attempt = 0; ; attempt += 1) {
    try {
      const current = (await readInitiative(root, initiative)).loaded;
      const updated = await updateInitiative({ projectRoot: root, initiative, expectedRevision: current.revision, actor: "verify_slice", operations: [{ op: "report_contract_defects", slug: slice, defects }] });
      return { status: "defects_recorded", sliceStatus: "blocked", initiativeRevision: updated.revision, run: stored.path, message: `The contract defects of ${slice} are recorded and the slice is blocked until design revises its contract. Stop implementing it.` };
    } catch (error) {
      if (error.code === "revision_conflict" && attempt < 3) continue;
      throw error;
    }
  }
}
async function completeSlice(root, initiative, slice, design, run) {
  if (!run.passed || design.review === "required") return run;
  const { readInitiative, updateInitiative } = await import("./initiative.mjs");
  for (let attempt = 0; ; attempt += 1) {
    try {
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
const GATE_QUESTION_LIMIT = 4e3;
const DEPENDENTS_CONTEXT = "Every slice of the scope passed its own tests. Before the initiative can ship, Prism runs the tests of the components that depend on the changed ones, so a break there shows now rather than after release. These commands come from `.prism/workflow.md`, and Prism has not run them in these folders before. Whatever they run, runs with your shell.";
const DEPENDENT_TAILS = 5;
const listed = (pairs) => pairs.map(({ command, folder, components }) => ({ command, folder, components: [...components] }));
const place = (folder, declaredFolder) => `${folder === "" ? "the project root" : `the folder ${folder}`}${declaredFolder && declaredFolder !== folder ? `, where the component folder ${declaredFolder} leads` : ""}`;
function dependentsQuestion(scope, pairs, key) {
  const build = (withComponents) => {
    const lines = [`Allow Prism to run these test commands to check the components that depend on the finished scope ${scope}?`, ""];
    for (const command of [...new Set(pairs.map((pair) => pair.command))]) {
      lines.push(command);
      for (const pair of pairs.filter((item) => item.command === command)) lines.push(`  in ${place(pair.folder, pair.declaredFolder)}${withComponents ? `, for ${pair.components.join(", ")}` : ""}`);
      lines.push("");
    }
    lines.push("Prism runs each command with your shell in each folder named under it. Allowing allows every command listed in those folders; declining runs none of them and blocks the components they test. A changed command, or the same command in another folder, asks again.", `Approval key: ${key.slice(0, 12)}`);
    return lines.join("\n");
  };
  const full = build(true);
  if (full.length <= GATE_QUESTION_LIMIT) return full;
  const brief = build(false);
  if (brief.length <= GATE_QUESTION_LIMIT) return brief;
  throw fail("approval_too_large", `The dependents of ${scope} need ${pairs.length} test commands that one approval question cannot list in full, so nothing was asked or run. Give the components fewer distinct test commands or folders, for example by running one command in the project root.`, { scope });
}
async function dependentsApproval({ root, initiative, scope, pairs, approvalGate, chatApproval, dataDirectory }) {
  if (chatApproval && !reviewBrowserUnreachable()) throw fail("chat_approval_unavailable", "This session can open the review browser, so the user allows the test commands there, not in chat. Call verify_slice without chatApproval.");
  return withApprovals(dataDirectory, async (store) => {
    const pending = pairs.filter((pair) => !store.approved[pair.key]);
    if (!pending.length) return { approved: true, declined: /* @__PURE__ */ new Set(), gateId: null };
    const wanted = pending.map((pair) => pair.key).sort().join("\n");
    const covers = (request) => request?.kind === "dependents" && request.initiative === initiative && request.scope === scope && Array.isArray(request.pairs) && request.pairs.filter((item) => !store.approved[item?.key]).map((item) => item?.key).sort().join("\n") === wanted;
    if (approvalGate && store.requests[approvalGate] && !covers(store.requests[approvalGate])) throw fail("approval_mismatch", `The gate ${approvalGate} asked about other test commands or folders. Call verify_slice with dependents and without approvalGate to ask about the ones this run needs.`);
    if (chatApproval && !(approvalGate && store.requests[approvalGate])) throw fail("validation_failed", "chatApproval answers the approval gate that verify_slice opened, so pass that gate's id as approvalGate.");
    const requested = approvalGate && store.requests[approvalGate] ? approvalGate : Object.entries(store.requests).find(([, item]) => covers(item))?.[0];
    if (requested) {
      const request = store.requests[requested];
      const gate = await pendingGate(root, request.initiative, requested);
      const allowAll = (approvedAt, extra = {}) => {
        for (const item of request.pairs) store.approved[item.key] ??= { root, folder: item.folder, command: item.command, approvedAt, gate: requested, ...extra };
        delete store.requests[requested];
      };
      if (!gate) {
        delete store.requests[requested];
      } else if (gate.answer?.via === "browser" && gate.answer.choice === ALLOW) {
        allowAll(gate.answer.answeredAt);
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {
        });
        return { approved: true, declined: /* @__PURE__ */ new Set(), gateId: requested };
      } else if (gate.answer) {
        delete store.requests[requested];
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested }] }).catch(() => {
        });
        if (gate.answer.choice === DECLINE) return { approved: true, declined: new Set(pending.map((pair) => pair.key)), gateId: requested, note: gate.answer.note ?? null };
        return { approved: false, status: "approval_unclear", gateId: requested, pending, note: gate.answer.note ?? null };
      } else if (chatApproval) {
        const quote = chatApproval.quote.trim();
        allowAll((/* @__PURE__ */ new Date()).toISOString(), { via: "chat", quote });
        await gateChange(root, request.initiative, { gateOperations: [{ op: "resolve", id: requested, reason: `The user allowed these commands in chat, as recorded by the agent: "${quote}"` }] }).catch(() => {
        });
        return { approved: true, declined: /* @__PURE__ */ new Set(), gateId: requested };
      } else {
        return { approved: false, status: "approval_needed", gateId: requested, pending };
      }
    }
    const key = digest(pending.map((pair) => pair.key).sort().join("\n"));
    const opened = await gateChange(root, initiative, { gateOperations: [{ op: "ask", kind: "decision", slice: scope, question: dependentsQuestion(scope, pending, key), context: DEPENDENTS_CONTEXT, artifacts: [".prism/workflow.md"], options: [
      { id: ALLOW, label: "Allow these commands", consequence: "Prism runs every listed command in its folder now and on later runs of the same commands there." },
      { id: DECLINE, label: "Decline", consequence: "Prism runs none of them, and the components they test block shipping until a later run passes." }
    ], recommended: APPROVAL_RECOMMENDATION }] });
    const gateId = opened.openedGates[0].id;
    store.requests[gateId] = { kind: "dependents", initiative, scope, pairs: pending.map(({ key: pairKey, command, folder }) => ({ key: pairKey, command, folder })), askedAt: (/* @__PURE__ */ new Date()).toISOString() };
    return { approved: false, status: "approval_needed", gateId, pending };
  });
}
async function dependentsRun({ root, initiative, scope, approvalGate, chatApproval, contractDefects, dataDirectory, signal, onProgress, maxWaitMs }) {
  if (contractDefects) throw fail("validation_failed", "A dependents' run takes no contract defects. Report a wrong contract clause with verify_slice on the slice whose contract it is, without dependents.");
  const { fitScopes, readInitiative, scopeDependents, scopeLeaves } = await import("./initiative.mjs");
  const { loaded } = await readInitiative(root, initiative);
  const record = loaded.valid ? loaded.record : null;
  if (!record || !fitScopes(record).includes(scope)) throw fail("validation_failed", `The slice ${scope} is not a fit scope of ${initiative}, so it has no dependents' run. Run the dependents of the scope whose design accepted the slice plan, or of a leaf that is a scope of its own.`);
  const leaves = scopeLeaves(record, scope);
  const waiting = leaves.filter((leaf) => record.slices[leaf]?.status !== "done");
  if (waiting.length) throw fail("scope_unfinished", `The scope ${scope} is not finished, so its dependents do not run yet. Finish ${waiting.join(", ")} first.`, { scope, waiting });
  const jobKey = `${root}\0${initiative}\0${scope}\0dependents`;
  const running = jobs.get(jobKey);
  if (running) return dependentsWaited(await awaitJob(jobKey, running.signature, null, { signal, onProgress, maxWaitMs }), scope, signal);
  const settled = settledDependents.get(jobKey);
  if (settled && approvalGate && settled.gate === approvalGate) return dependentsResult(settled.run);
  settledDependents.delete(jobKey);
  const config = await readWorkflowConfig(root);
  const declaration = readComponents(config);
  const dependents = scopeDependents(record, scope, declaration);
  if (!dependents.length) return { status: "no_dependents", scope, components: [], message: `No component of this repository depends on the components of ${scope}, so nothing ran and nothing was recorded.` };
  const pairs = [];
  const byKey = /* @__PURE__ */ new Map();
  const placed = [];
  for (const component of dependents) {
    const target = await componentTarget(root, declaration, component);
    const key = approvalKey(target.cwd, target.command);
    let pair = byKey.get(key);
    if (!pair) {
      pair = { key, ...target, components: [] };
      byKey.set(key, pair);
      pairs.push(pair);
    }
    pair.components.push(component.identity);
    placed.push({ name: component.identity, pair });
  }
  const allowed = await dependentsApproval({ root, initiative, scope, pairs, approvalGate, chatApproval, dataDirectory });
  if (!allowed.approved) {
    const commands = listed(allowed.pending);
    if (allowed.status === "approval_unclear") return { status: "approval_unclear", gateId: allowed.gateId, scope, commands, note: allowed.note, message: "The user answered the approval question with a note and neither allowed nor declined the commands, so nothing ran. Read the note, then call verify_slice with dependents and without approvalGate to ask again." };
    const asked = commands.map((item) => `${item.command} in ${item.folder === "" ? "the project root" : `the folder ${item.folder}`} (${item.components.join(", ")})`).join("; ");
    if (reviewBrowserUnreachable()) return { status: "approval_needed", gateId: allowed.gateId, scope, commands, chatApproval: true, message: `The user cannot open the review browser from this cloud session. Ask them in chat whether Prism may run each of these exact test commands in the folder named: ${asked}. When they allow all of them, call verify_slice again with dependents true, approvalGate ${allowed.gateId}, and chatApproval quoting their answer word for word.` };
    return { status: "approval_needed", gateId: allowed.gateId, scope, commands, message: `The user must allow the dependents' test commands in the review browser first. Wait with wait_for_user_gate on ${allowed.gateId}, then call verify_slice again with dependents true and approvalGate ${allowed.gateId}.` };
  }
  const declined = allowed.declined;
  const gate = allowed.gateId ?? approvalGate ?? null;
  const signature = pairs.map((pair) => `${pair.key}${declined.has(pair.key) ? "-" : "+"}`).join(",");
  const start = (jobSignal, progress) => inWorkTree(root, () => dependentsExecution({ root, initiative, scope, config, pairs, placed, declined, dataDirectory, signal: jobSignal, onProgress: progress })).then((run) => {
    if (gate && declined.size) settledDependents.set(jobKey, { gate, run });
    return run;
  });
  return dependentsWaited(await awaitJob(jobKey, signature, start, { signal, onProgress, maxWaitMs }, { commands: listed(pairs) }), scope, signal);
}
function dependentsWaited(waited, scope, signal) {
  if (waited.running) return { status: "running", scope, commands: waited.info.commands, startedAt: waited.startedAt, message: "The dependents' run continues in the Prism server. Call verify_slice again with the same arguments to keep waiting for its result." };
  return waited.finished.reason === "cancelled" && signal?.aborted ? { status: "cancelled", scope } : dependentsResult(waited.finished);
}
const settledDependents = /* @__PURE__ */ new Map();
const workTreeRuns = /* @__PURE__ */ new Map();
function inWorkTree(root, action) {
  const run = (workTreeRuns.get(root) ?? Promise.resolve()).then(action);
  const settledRun = run.then(() => {
  }, () => {
  });
  workTreeRuns.set(root, settledRun);
  settledRun.then(() => {
    if (workTreeRuns.get(root) === settledRun) workTreeRuns.delete(root);
  });
  return run;
}
async function dependentsExecution({ root, initiative, scope, config, pairs, placed, declined, dataDirectory, signal, onProgress }) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const started = Date.now();
  const id = `dependents-${String(started).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const timeoutMs = Number(process.env.PRISM_VERIFY_TIMEOUT_MINUTES || DEFAULT_TIMEOUT_MINUTES) * 6e4;
  const before = await contentTree(root, config);
  const commands = [];
  const statusOf = /* @__PURE__ */ new Map();
  for (const [index, pair] of pairs.entries()) {
    const entry2 = { command: pair.command, folder: pair.folder, components: [...pair.components] };
    if (declined.has(pair.key)) {
      statusOf.set(pair.key, "declined");
      commands.push({ ...entry2, status: "declined" });
      continue;
    }
    if (signal.aborted) {
      statusOf.set(pair.key, "failed");
      commands.push({ ...entry2, status: "failed", reason: "cancelled" });
      continue;
    }
    const logPath = await logPathFor(dataDirectory, root, initiative, scope, `${id}-${index + 1}`);
    const outcome = await execute(pair.command, pair.cwd, { signal, timeoutMs, onProgress, logPath });
    const reason2 = outcome.cancelled ? "cancelled" : outcome.timedOut ? "timed_out" : outcome.exitCode !== 0 ? "command_failed" : null;
    statusOf.set(pair.key, reason2 ? "failed" : "passed");
    commands.push({ ...entry2, status: reason2 ? "failed" : "passed", ...reason2 ? { reason: reason2 } : {}, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, durationMs: outcome.durationMs, outputTail: tail(outcome.output, RECORDED_TAIL_CHARS), ...outcome.logged ? { log: logPath } : {} });
  }
  const after = await contentTree(root, config).catch(() => null);
  const cancelled = commands.some((item) => item.reason === "cancelled");
  const components = placed.map(({ name, pair }) => ({ name, folder: pair.folder, command: pair.command, status: statusOf.get(pair.key) }));
  const reason = cancelled ? "cancelled" : after !== before ? "tracked_files_changed" : null;
  const blocked = reason ? components.map((item) => item.name) : components.filter((item) => item.status !== "passed").map((item) => item.name);
  const entry = { kind: "dependents", scope, startedAt, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), durationMs: Date.now() - started, passed: blocked.length === 0, ...reason ? { reason } : {}, components, blocked, commands: commands.map(({ log, ...rest }) => rest), tree: before, ...after !== before ? { treeAfter: after } : {} };
  entry.checkout = await checkoutOf(root, config, before).catch(() => null);
  const stored = await appendRecord(root, { kind: "runs", initiative, slice: scope }, id, entry);
  return { id, path: stored.path, ...entry, commands };
}
const DEPENDENTS_REASONS = {
  cancelled: "The dependents' run was cancelled, so every dependent is blocked until a later run passes.",
  tracked_files_changed: "The dependents' test commands changed project files while they ran, so the run does not identify one tested state and every dependent is blocked. Run the dependents again."
};
const ASK_AGAIN = "The user declined some of these commands, so calling with the same approvalGate returns this run again; call verify_slice with dependents and without approvalGate to ask and run again.";
function dependentsResult(run) {
  const base = DEPENDENTS_REASONS[run.reason] ?? (run.passed ? `Every dependent of ${run.scope} passed.` : `The scope ${run.scope} is blocked by ${run.blocked.join(", ")}: a dependent whose tests failed or were declined blocks shipping until a later dependents' run passes.`);
  const message = run.commands.some((item) => item.status === "declined") ? `${base} ${ASK_AGAIN}` : base;
  return { status: run.passed ? "passed" : "failed", scope: run.scope, ...run.reason ? { reason: run.reason } : {}, message, components: run.components, blocked: run.blocked, commands: run.commands, durationMs: run.durationMs, run: run.path, ...run.checkout ? { code: run.checkout } : {}, kind: "dependents" };
}
const FAILING_PATTERNS = [
  /^test (\S+) \.\.\. FAILED$/,
  /^---- (\S+) stdout ----$/,
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/,
  /^FAILED (\S+)/,
  /^--- FAIL: (\S+)/,
  /^\s*[✖✕×] (.+?)(?: \(\d+(?:\.\d+)?\s*m?s\))?$/
];
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
function failingTests(output) {
  const names = /* @__PURE__ */ new Set();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const name = failingName(line);
    if (name) names.add(name);
  }
  return [...names];
}
function verificationBrief(value) {
  if (!["passed", "failed"].includes(value.status)) return value;
  if (value.kind === "dependents") {
    let tails = 0;
    const commands = value.commands.map(({ command, folder, components, status, reason, log, outputTail }) => ({ command, folder, components, status, ...reason ? { reason } : {}, ...log ? { log } : {}, ...status === "failed" && outputTail && tails++ < DEPENDENT_TAILS ? { outputTail: tail(outputTail, BRIEF_TAIL_CHARS) } : {} }));
    return { status: value.status, scope: value.scope, ...value.reason ? { reason: value.reason } : {}, message: value.message, components: value.components, blocked: value.blocked, commands, durationMs: value.durationMs, run: value.run, ...value.code ? { code: value.code } : {} };
  }
  const failing = value.status !== "failed" ? [] : value.failing ?? failingTests(value.outputTail);
  const failingCount = value.failingCount ?? failing.length;
  const frozen = value.frozen && (value.frozen.changed.length || value.frozen.missing.length) ? { frozenChanged: value.frozen.changed, frozenMissing: value.frozen.missing } : {};
  return {
    status: value.status,
    ...value.reason ? { reason: value.reason, message: value.message } : {},
    // A run that left its component lists the paths to move back, so the brief keeps them.
    ...value.crossing ? { crossing: value.crossing, crossingCount: value.crossingCount } : {},
    ...value.component ? { component: value.component } : {},
    ...value.folder !== void 0 ? { folder: value.folder } : {},
    ...value.boundary ? { boundary: value.boundary } : {},
    ...failing.length ? { failing: failing.slice(0, MAX_FAILING_NAMES), failingCount } : {},
    ...frozen,
    ...value.sliceStatus ? { sliceStatus: value.sliceStatus } : {},
    // Marking the slice done writes the initiative record, so the caller's next update needs this revision.
    ...value.initiativeRevision ? { initiativeRevision: value.initiativeRevision } : {},
    ...value.statusMessage ? { statusMessage: value.statusMessage } : {},
    ...value.repeated ? { repeated: true, repeatMessage: value.repeatMessage } : {},
    ...value.rerunMessage ? { rerunMessage: value.rerunMessage } : {},
    durationMs: value.durationMs,
    run: value.path,
    ...value.log ? { log: value.log } : {},
    ...value.status === "passed" && value.checkout ? { code: value.checkout } : {},
    ...value.status === "failed" && value.outputTail ? { outputTail: tail(value.outputTail, BRIEF_TAIL_CHARS) } : {}
  };
}
function runningVerifications() {
  return jobs.size;
}
function cancelVerifications() {
  for (const job of jobs.values()) job.controller.abort();
}
export {
  TEST_COMMAND_PLACEHOLDER,
  VERIFY_SLICE_SCHEMA,
  VerificationError,
  cancelVerifications,
  checkoutOf,
  configuredTestCommand,
  failingTests,
  homeRelative,
  publicRemote,
  reportContractDefects,
  repositoryOf,
  reviewBrowserUnreachable,
  runningVerifications,
  verificationBrief,
  verifySlice
};
