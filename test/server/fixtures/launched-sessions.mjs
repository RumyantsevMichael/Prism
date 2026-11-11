// Stub host executables and a project for the launched-session tests.
// The stubs stand in for the claude and codex command-line tools: each run appends what it was started with to a log
// and then follows the next plan for its host, so a test drives a session without any model.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { actionProject, INITIATIVE } from "./review-actions.mjs";
import { isolatedEnv } from "./isolated-env.mjs";

export { INITIATIVE };

// The host session variables that a review app started by an agent session inherits; a launched host must see none of them.
export const FOREIGN_SESSION = {
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "99999999-9999-4999-8999-999999999999",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/foreign.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "foreign-token",
  CLAUDE_PROJECT_DIR: "/tmp/foreign-project",
  CLAUDE_PLUGIN_ROOT: "/tmp/foreign-plugin",
  CLAUDE_PLUGIN_DATA: "/tmp/foreign-plugin-data",
  CODEX_THREAD_ID: "01a1c2bc-9999-7999-8999-999999999999"
};
export const STRIPPED = Object.keys(FOREIGN_SESSION);
export const CODEX_THREAD = "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4";
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LAUNCH_ID = /^launch-[0-9a-f]{16}$/;

// One stub serves both hosts; its file name says which host it is.
// The claude stub speaks Claude Code's stream-json input and output: it starts its turn on the first user message, answers an
// interrupt control request with a control response and ends a running turn with an error result, and exits when its input closes.
// The codex stub runs as `codex app-server`, answers the JSON-RPC requests initialize, thread/start, thread/resume, turn/start, and
// turn/interrupt, sends turn notifications, and exits when its input closes; any other codex command fails with exit code 2.
// A plan: { hold: "forever" | <ms until the turn ends>, exit, stderr, isError, denials: [{ tool, reason }], background: <ms> (claude:
// a background task that ends that long after the turn and is followed by one more turn), threadId (codex; null refuses thread/start),
// declined: [<command>] (codex), failed (codex), askApproval (codex: the stub asks the client for an approval), ignoreInterrupt
// (the stub answers no interrupt and keeps running after its input closes), children: ["attached" | "detached"] }.
// The log holds one { kind: "run" } entry per run, one { kind: "input" } entry per message the run read, and { kind: "closed" } when its input closed.
// Each stub names node by its absolute path, so PATH needs no folder of node's, which may also hold a real host.
const STUB = String.raw`#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const host = path.basename(process.argv[1]).startsWith("codex") ? "codex" : "claude";
const argv = process.argv.slice(2);
const logFile = process.env.PRISM_STUB_LOG;
const log = (entry) => appendFileSync(logFile, JSON.stringify({ host, pid: process.pid, ...entry }) + "\n");
let previous = [];
try { previous = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.host === host && entry.kind === "run"); } catch {}
let plans = {};
try { plans = JSON.parse(readFileSync(process.env.PRISM_STUB_PLANS, "utf8")); } catch {}
const list = plans[host] ?? [];
const plan = list[Math.min(previous.length, list.length - 1)] ?? {};
const watched = ${JSON.stringify(["PRISM_LAUNCH", "PRISM_STUB_MARKER"])}.concat(${JSON.stringify(Object.keys({ CLAUDECODE: 1, CLAUDE_CODE_SESSION_ID: 1, CLAUDE_CODE_ENTRYPOINT: 1, CLAUDE_CODE_MESSAGING_SOCKET: 1, CLAUDE_CODE_MESSAGING_TOKEN: 1, CLAUDE_PROJECT_DIR: 1, CLAUDE_PLUGIN_ROOT: 1, CLAUDE_PLUGIN_DATA: 1, CODEX_THREAD_ID: 1 }))});
const env = Object.fromEntries(watched.map((name) => [name, process.env[name] ?? null]));
const keep = "setInterval(() => {}, 1000)";
const children = (plan.children ?? []).map((kind) => {
  const child = spawn(process.execPath, ["-e", keep], { detached: kind === "detached", stdio: "ignore" });
  child.unref();
  return { kind, pid: child.pid };
});
log({ kind: "run", argv, cwd: process.cwd(), env, children });
if (plan.stderr) process.stderr.write(plan.stderr + "\n");
if (plan.ignoreInterrupt) setInterval(() => {}, 1000);
const write = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const valueAfter = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
const timers = new Set();
const later = (ms, action) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, ms); timers.add(timer); };
const cancel = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
let started = false;
let interrupted = false;
let results = 0;
let onMessage = () => {};
if (host === "codex" && argv[0] !== "app-server") {
  process.stderr.write("error: this stub runs only as codex app-server\n");
  process.exit(2);
}
if (host === "claude") {
  const id = valueAfter("--session-id") ?? valueAfter("--resume");
  let turn = false;
  const result = (fields) => { turn = false; results += 1; write({ type: "result", session_id: id, ...fields }); };
  const endTurn = () => {
    const denials = plan.denials ?? [];
    denials.forEach((denial, index) => {
      write({ type: "assistant", session_id: id, message: { content: [{ type: "tool_use", id: "toolu_" + index, name: denial.tool, input: {} }] } });
      write({ type: "user", session_id: id, message: { content: [{ type: "tool_result", tool_use_id: "toolu_" + index, is_error: true, content: denial.reason }] } });
    });
    result({ subtype: plan.isError ? "error_during_execution" : "success", is_error: Boolean(plan.isError), ...(plan.isError ? { errors: ["The API returned an error."] } : { result: "done" }),
      permission_denials: denials.map((denial, index) => ({ tool_name: denial.tool, tool_use_id: "toolu_" + index, tool_input: {} })) });
    if (plan.background !== undefined) later(plan.background, () => {
      write({ type: "system", subtype: "task_notification", task_id: "task_bg", status: "completed", session_id: id });
      turn = true;
      write({ type: "system", subtype: "init", session_id: id });
      result({ subtype: "success", is_error: false, result: "done", permission_denials: [] });
    });
  };
  onMessage = (message) => {
    if (message.type === "user" && !started) {
      started = true;
      later(300, () => {
        turn = true;
        write({ type: "system", subtype: "init", session_id: id, permissionMode: valueAfter("--permission-mode") });
        if (plan.background !== undefined) write({ type: "system", subtype: "task_started", task_id: "task_bg", task_type: "local_bash", session_id: id });
        if (plan.hold !== "forever") later(plan.hold ?? 0, endTurn);
      });
    }
    if (message.type === "control_request" && message.request?.subtype === "interrupt" && !plan.ignoreInterrupt) {
      interrupted = true;
      cancel();
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
      if (turn) result({ subtype: "error_during_execution", is_error: true, permission_denials: [] });
    }
  };
}
if (host === "codex") {
  let turnId = null;
  let threadId = null;
  let turns = 0;
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const refuse = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32600, message } });
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const complete = (status, error = null) => { results += 1; notify("turn/completed", { threadId, turn: { id: turnId, status, items: [], error } }); };
  onMessage = (message) => {
    if (message.method === undefined) return;
    if (message.method === "initialize") { started = true; respond(message.id, { userAgent: "codex-stub/0" }); return; }
    if (message.method === "initialized") return;
    if (message.method === "thread/start") {
      if (plan.threadId === null) { refuse(message.id, "The thread could not start."); return; }
      threadId = plan.threadId === undefined ? ${JSON.stringify(CODEX_THREAD)} : plan.threadId;
      respond(message.id, { thread: { id: threadId } });
      notify("thread/started", { thread: { id: threadId } });
      return;
    }
    if (message.method === "thread/resume") { threadId = message.params?.threadId ?? null; respond(message.id, { thread: { id: threadId } }); return; }
    if (message.method === "turn/start") {
      turns += 1;
      turnId = "turn-" + turns;
      respond(message.id, { turn: { id: turnId, status: "inProgress", items: [], error: null } });
      later(300, () => {
        notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });
        if (plan.askApproval) write({ jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "item_ask", command: "touch /etc/hosts" } });
        (plan.declined ?? []).forEach((command, index) => notify("item/completed", { threadId, turnId, item: { id: "item_" + index, type: "commandExecution", command, status: "declined" } }));
        if (plan.hold !== "forever") later(plan.hold ?? 0, () => plan.failed ? complete("failed", { message: "The model stream ended." }) : complete("completed"));
      });
      return;
    }
    if (message.method === "turn/interrupt") {
      if (plan.ignoreInterrupt) return;
      interrupted = true;
      cancel();
      respond(message.id, {});
      complete("interrupted");
      return;
    }
    if (message.id !== undefined) refuse(message.id, "Unknown method " + message.method + ".");
  };
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    log({ kind: "input", message });
    onMessage(message);
  }
});
process.stdin.on("end", () => {
  log({ kind: "closed", results, interrupted });
  if (plan.ignoreInterrupt) return;
  if (!started) {
    process.stderr.write("Error: no input arrived on standard input.\n");
    process.exit(1);
  }
  setTimeout(() => process.exit(plan.exit ?? (host === "claude" && interrupted ? 1 : 0)), 20);
});
process.stdin.on("error", () => {});
`;

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The executables that a launch resolves on PATH; a test PATH keeps no folder that holds one, so no real host can start.
const HOST_EXECUTABLES = ["claude", "codex"].flatMap((name) => process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name]);

/** `bin` followed by the inherited PATH folders that hold no host executable, so a launch finds only the stubs in `bin`. */
export function controlledPath(bin, inherited = "") {
  const kept = inherited.split(path.delimiter).filter(Boolean).filter((folder) => !HOST_EXECUTABLES.some((name) => existsSync(path.join(folder, name))));
  return [bin, ...kept].join(path.delimiter);
}

/** A folder of stub host executables: claude and codex by default, or only the names given. */
export async function stubBin(context, hosts = ["claude", "codex"]) {
  const bin = await temporary(context, "prism-launch-bin-");
  for (const name of hosts) {
    const file = path.join(bin, name);
    await writeFile(file, STUB);
    chmodSync(file, 0o755);
  }
  return bin;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Polls until `probe` answers a truthy value, or fails with the last answer after `ms`. */
export async function waitFor(probe, { ms = 15000, every = 100, what = "the condition" } = {}) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  throw new Error(`Timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

/**
 * A project with one initiative, a private review app folder, stub hosts on a PATH that holds no other host, and the environment that a launch reads.
 * `env` carries the foreign host session variables of clause 4, so a test can check that the launched host sees none of them.
 * Every process that the test's launches leave behind, the supervisors and every stub and its children, ends after the test.
 */
export async function launchFixture(context, { hosts = ["claude", "codex"], plans = {}, gates = false, dialog = null } = {}) {
  // Registered before any temporary folder, so it runs while the run log still exists: after hooks run in registration order.
  let ending = null;
  context.after(() => ending?.());
  const { root, gateIds } = await actionProject(context, { gates });
  const scratch = await temporary(context, "prism-launch-");
  const app = path.join(scratch, "app");
  await mkdir(app, { recursive: true });
  const bin = await stubBin(context, hosts);
  const log = path.join(scratch, "stub-runs.jsonl");
  const plansFile = path.join(scratch, "stub-plans.json");
  const setPlans = (value) => writeFile(plansFile, JSON.stringify(value));
  await setPlans(plans);
  // A zenity stub answers the native confirmation with dialog.code (0 confirms, 1 declines) and logs each dialog it shows.
  const dialogLog = path.join(scratch, "dialogs.jsonl");
  const dialogFile = path.join(scratch, "dialog.json");
  const setDialog = (value) => writeFile(dialogFile, JSON.stringify(value));
  if (dialog) {
    await setDialog(dialog);
    const file = path.join(bin, "zenity");
    await writeFile(file, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(dialogLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.exit(JSON.parse(fs.readFileSync(${JSON.stringify(dialogFile)}, "utf8")).code ?? 0);
`);
    chmodSync(file, 0o755);
  }
  const base = isolatedEnv();
  const env = { ...base, ...FOREIGN_SESSION, PATH: controlledPath(bin, base.PATH), PRISM_REVIEW_APP_DIR: app, PRISM_STUB_LOG: log, PRISM_STUB_PLANS: plansFile, PRISM_STUB_MARKER: "kept", PRISM_LAUNCH_STOP_GRACE_MS: "1500", ...(dialog ? { DISPLAY: ":0" } : {}) };
  delete env.WAYLAND_DISPLAY;
  if (!dialog) delete env.DISPLAY;
  const entries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const runs = (host = null) => entries().filter((entry) => entry.kind === "run" && (!host || entry.host === host));
  /** The messages that the run with this process id read from its standard input, in order. */
  const inputs = (pid) => entries().filter((entry) => entry.kind === "input" && entry.pid === pid).map((entry) => entry.message);
  /** `{ results, interrupted }` once the run's standard input closed, with the turns it had ended by then, or null while it is open. */
  const closed = (pid) => {
    const entry = entries().find((item) => item.kind === "closed" && item.pid === pid);
    return entry ? { results: entry.results, interrupted: entry.interrupted } : null;
  };
  const dialogs = () => existsSync(dialogLog) ? readFileSync(dialogLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  /** Makes this fixture's environment the process environment for the test, as the review server reads it, and restores it after. */
  const useAsProcessEnv = () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env, saved.PLUGIN_DATA ? { PLUGIN_DATA: saved.PLUGIN_DATA } : {});
    context.after(() => {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    });
  };
  ending = () => {
    const ended = [];
    if (process.platform !== "win32") {
      // Every supervisor names its launch folder, which lies in this test's review app folder, and every stub its file in bin, on its command line.
      ended.push(...processesNaming(app), ...processesNaming(bin));
    }
    for (const run of runs()) ended.push(run.pid, ...run.children.map((child) => child.pid));
    for (const pid of ended) if (pid !== process.pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  };
  return { root, gateIds, app, bin, log, env, setPlans, runs, inputs, closed, alive, dialogs, setDialog, useAsProcessEnv };
}

/** The process ids whose command line names a path, such as a launch folder. */
export function processesNaming(text) {
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match) => match && match[2].includes(text) && !match[2].startsWith("ps ")).map((match) => Number(match[1]));
}

export { alive };
