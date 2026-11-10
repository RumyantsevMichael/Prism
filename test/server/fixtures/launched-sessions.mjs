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
// A plan: { hold: "forever" | <ms>, exit, stderr, isError, denials: [{ tool, reason }], threadId (codex; null emits no thread.started),
// declined: [<command>] (codex), failed (codex), ignoreTerm, children: ["group" | "session" | "stubborn"], noEvents }.
// Each stub names node by its absolute path, so PATH needs no folder of node's, which may also hold a real host.
const STUB = String.raw`#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const host = path.basename(process.argv[1]).startsWith("codex") ? "codex" : "claude";
const argv = process.argv.slice(2);
const logFile = process.env.PRISM_STUB_LOG;
let previous = [];
try { previous = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.host === host); } catch {}
let plans = {};
try { plans = JSON.parse(readFileSync(process.env.PRISM_STUB_PLANS, "utf8")); } catch {}
const list = plans[host] ?? [];
const plan = list[Math.min(previous.length, list.length - 1)] ?? {};
const watched = ${JSON.stringify(["PRISM_LAUNCH", "PRISM_STUB_MARKER"])}.concat(${JSON.stringify(Object.keys({ CLAUDECODE: 1, CLAUDE_CODE_SESSION_ID: 1, CLAUDE_CODE_ENTRYPOINT: 1, CLAUDE_CODE_MESSAGING_SOCKET: 1, CLAUDE_CODE_MESSAGING_TOKEN: 1, CLAUDE_PROJECT_DIR: 1, CLAUDE_PLUGIN_ROOT: 1, CLAUDE_PLUGIN_DATA: 1, CODEX_THREAD_ID: 1 }))});
const env = Object.fromEntries(watched.map((name) => [name, process.env[name] ?? null]));
const keep = "setInterval(() => {}, 1000)";
const children = (plan.children ?? []).map((kind) => {
  const code = kind === "stubborn" ? "process.on('SIGTERM', () => {}); " + keep : keep;
  const child = spawn(process.execPath, ["-e", code], { detached: kind === "session", stdio: "ignore" });
  child.unref();
  return { kind, pid: child.pid };
});
let stdin = "open";
let stdinBytes = 0;
process.stdin.on("data", (chunk) => { stdinBytes += chunk.length; });
process.stdin.on("end", () => { stdin = stdinBytes ? "data" : "empty"; });
process.stdin.on("error", () => { stdin = "empty"; });
const write = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const valueAfter = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
if (plan.ignoreTerm) process.on("SIGTERM", () => {});
setTimeout(() => {
  appendFileSync(logFile, JSON.stringify({ host, argv, cwd: process.cwd(), pid: process.pid, env, stdin, children }) + "\n");
  if (plan.stderr) process.stderr.write(plan.stderr + "\n");
  const finish = () => {
    if (host === "claude" && !plan.noEvents) {
      const id = valueAfter("--session-id") ?? valueAfter("--resume");
      const denials = plan.denials ?? [];
      denials.forEach((denial, index) => {
        write({ type: "assistant", session_id: id, message: { content: [{ type: "tool_use", id: "toolu_" + index, name: denial.tool, input: {} }] } });
        write({ type: "user", session_id: id, message: { content: [{ type: "tool_result", tool_use_id: "toolu_" + index, is_error: true, content: denial.reason }] } });
      });
      write({ type: "result", subtype: plan.isError ? "error_during_execution" : "success", is_error: Boolean(plan.isError), session_id: id, result: plan.isError ? "The API returned an error." : "done",
        permission_denials: denials.map((denial, index) => ({ tool_name: denial.tool, tool_use_id: "toolu_" + index, tool_input: {} })) });
    }
    if (host === "codex" && !plan.noEvents) {
      write({ type: "turn.started" });
      (plan.declined ?? []).forEach((command, index) => write({ type: "item.completed", item: { id: "item_" + index, type: "command_execution", command, aggregated_output: "", exit_code: null, status: "declined" } }));
      write(plan.failed ? { type: "turn.failed", error: { message: "The model stream ended." } } : { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    setTimeout(() => process.exit(plan.exit ?? 0), 20);
  };
  if (host === "claude" && !plan.noEvents) write({ type: "system", subtype: "init", session_id: valueAfter("--session-id") ?? valueAfter("--resume"), permissionMode: valueAfter("--permission-mode") });
  if (host === "codex" && !plan.noEvents) {
    const resumed = argv[1] === "resume" ? argv.find((value, index) => index > 1 && /^[0-9a-f-]{36}$/.test(value)) : null;
    const thread = resumed ?? (plan.threadId === undefined ? ${JSON.stringify(CODEX_THREAD)} : plan.threadId);
    if (thread) write({ type: "thread.started", thread_id: thread });
  }
  if (plan.hold === "forever") setInterval(() => {}, 1000);
  else setTimeout(finish, plan.hold ?? 0);
}, 300);
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
  const runs = (host = null) => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !host || entry.host === host) : [];
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
  return { root, gateIds, app, bin, log, env, setPlans, runs, alive, dialogs, setDialog, useAsProcessEnv };
}

/** The process ids whose command line names a path, such as a launch folder. */
export function processesNaming(text) {
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match) => match && match[2].includes(text) && !match[2].startsWith("ps ")).map((match) => Number(match[1]));
}

export { alive };
