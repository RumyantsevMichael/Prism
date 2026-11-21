// A project whose gates are asked by a real Prism server under a named harness session, stub hosts on a PATH that holds no
// other host, and a review page on the same machine, for the late gate answer tests.
// The claude stub answers `claude agents --json` and `claude -p <text> --cloud <id>` from plan files and runs every other
// command as the launched-session stub, so no test starts a real Claude Code or Codex.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./isolated-env.mjs";
import { INITIATIVE, launchFixture } from "./launched-sessions.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./review-actions.mjs";
import { defer } from "./teardown.mjs";

export { INITIATIVE, actionOf, apply, get, listing };

const SERVER_PATH = fileURLToPath(new URL("../../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url));

export const CLAUDE_SESSION = "5b1d7e2a-6c3f-4a8e-9d21-7f0c3b9e4a16";
export const CODEX_SESSION = "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4";
export const CLOUD_SESSION = "cse_01LateGateCloudSession7";
export const MACHINE = os.hostname().split(".")[0] || "an unnamed host";
export const CLAUDE_CLIENT = { name: "claude-code", version: "2.1.330" };
export const CODEX_CLIENT = { name: "codex-mcp-client", version: "0.155.1" };

// The claude wrapper: `agents` prints the agents plan's stdout and stderr and exits with its code, a `--cloud` run is logged as a
// wake and follows the wake plan, and any other command runs the launched-session stub, which the fixture renamed claude-session.
const WRAPPER = String.raw`#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const argv = process.argv.slice(2);
const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const log = (entry) => appendFileSync(process.env.PRISM_STUB_ASKER_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...entry }) + "\n");
if (argv[0] === "agents") {
  const plan = read(process.env.PRISM_STUB_AGENTS);
  log({ kind: "agents", argv });
  if (plan.stdout !== undefined) process.stdout.write(plan.stdout);
  if (plan.stderr) process.stderr.write(plan.stderr + "\n");
  process.exit(plan.code ?? 0);
}
if (argv.includes("--cloud")) {
  const plan = read(process.env.PRISM_STUB_WAKE);
  const env = Object.fromEntries(["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "PRISM_LAUNCH"].map((name) => [name, process.env[name] ?? null]));
  log({ kind: "wake", argv, env });
  if (plan.stderr) process.stderr.write(plan.stderr + "\n");
  setTimeout(() => process.exit(plan.code ?? 0), plan.hold ?? 0);
} else {
  const child = spawn(process.execPath, [path.join(__dirname, "claude-session"), ...argv], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => child.kill(name));
}
`;

/**
 * The launched-session fixture with a claude wrapper, a private CODEX_HOME, and plan files for `claude agents --json` and wakes.
 * `asker(...)` starts a Prism server that asks gates as a harness session, `review()` starts this machine's review page.
 */
export async function askerFixture(context, { hosts = ["claude", "codex"], dialog = null, plans = {} } = {}) {
  const fixture = await launchFixture(context, { hosts, dialog, plans, gates: false });
  const scratch = path.dirname(fixture.app);
  if (hosts.includes("claude")) {
    await rename(path.join(fixture.bin, "claude"), path.join(fixture.bin, "claude-session"));
    await writeFile(path.join(fixture.bin, "claude"), WRAPPER);
    chmodSync(path.join(fixture.bin, "claude"), 0o755);
  }
  const askerLog = path.join(scratch, "asker-stub.jsonl");
  const agentsFile = path.join(scratch, "agents-plan.json");
  const wakeFile = path.join(scratch, "wake-plan.json");
  const codexHome = path.join(scratch, "codex-home");
  await mkdir(codexHome, { recursive: true });
  Object.assign(fixture.env, { PRISM_STUB_ASKER_LOG: askerLog, PRISM_STUB_AGENTS: agentsFile, PRISM_STUB_WAKE: wakeFile, CODEX_HOME: codexHome });
  // The review page of these tests runs on a person's own computer, never in a cloud session, unless a test says so.
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_REMOTE", "CODEX_THREAD_ID"]) delete fixture.env[name];
  /** What `claude agents --json` answers: { stdout, stderr, code }. */
  const setAgents = (plan) => writeFile(agentsFile, JSON.stringify(plan));
  /** What a wake answers: { code, stderr, hold }. */
  const setWake = (plan) => writeFile(wakeFile, JSON.stringify(plan));
  await setAgents({ stdout: "[]\n" });
  await setWake({ code: 0 });
  const stubEntries = () => existsSync(askerLog) ? readFileSync(askerLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const wakes = () => stubEntries().filter((entry) => entry.kind === "wake");
  const lockFile = (thread) => path.join(codexHome, "thread-writer-locks", `${thread}.lock`);
  const openCodexThread = async (thread = CODEX_SESSION) => { await mkdir(path.dirname(lockFile(thread)), { recursive: true }); await writeFile(lockFile(thread), ""); };
  const closeCodexThread = (thread = CODEX_SESSION) => rm(lockFile(thread), { force: true });
  let review = null;
  /** This machine's review page, started once with the fixture's environment as the process environment. */
  const page = async () => {
    if (review) return review;
    fixture.useAsProcessEnv();
    const started = await startActionReview(context, fixture.root);
    const headers = await pageSession(started.review, started.opened);
    review = { ...started, headers };
    return review;
  };
  return { ...fixture, setAgents, setAgentsOpen: (ids) => setAgents({ stdout: `${JSON.stringify(ids.map((id) => ({ sessionId: id, kind: "interactive", status: "idle" })))}\n` }), setWake, wakes, stubEntries, openCodexThread, closeCodexThread, codexHome, page };
}

/**
 * A Prism server of the fixture's checkout that runs as one harness session: client is its MCP clientInfo, env its extra
 * environment such as CLAUDE_CODE_SESSION_ID, meta the _meta of each tool call, and app its review app folder, the fixture's own
 * by default, so the server runs on this machine; another folder stands for another machine.
 */
export async function askerServer(context, fixture, { client = CLAUDE_CLIENT, env = {}, meta = undefined, app = fixture.app } = {}) {
  const environment = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: app, PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, PATH: fixture.env.PATH, CODEX_HOME: fixture.codexHome, PRISM_GATE_WAIT_HEARTBEAT_MS: "200", CLAUDE_PROJECT_DIR: fixture.root, ...env });
  for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "PRISM_LAUNCH"]) if (!(name in env)) delete environment[name];
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_REMOTE", "CODEX_THREAD_ID"]) if (!(name in env)) delete environment[name];
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: fixture.root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const messages = [];
  const listeners = new Set();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  defer(context, async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await new Promise((resolve) => child.once("exit", resolve));
      clearTimeout(timer);
    }
  });
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = (id, timeout = 20000) => new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find((message) => message.id === id);
      if (found) { listeners.delete(check); clearTimeout(timer); resolve(found); }
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`No response to request ${id}: ${stderr}`)); }, timeout);
    listeners.add(check);
    check();
  });
  const request = (method, params) => { const id = next++; send({ id, method, params }); return { id, done: response(id) }; };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: client }).done;
  const params = (name, args) => ({ name, arguments: { projectRoot: fixture.root, ...args }, ...(meta === undefined ? {} : { _meta: meta }) });
  /** One tool call's raw JSON-RPC response. */
  const call = (name, args = {}) => request("tools/call", params(name, args)).done;
  /** A tool call that the test does not await, such as a wait, with cancel() sending notifications/cancelled. */
  const start = (name, args = {}) => {
    const { id, done } = request("tools/call", params(name, args));
    // A cancelled call gets no response, so its promise is left to time out unobserved.
    done.catch(() => {});
    return { id, done, cancel: () => send({ method: "notifications/cancelled", params: { requestId: id, reason: "test" } }) };
  };
  /** Ends the server at once, as a crash does, so nothing it holds is released. */
  const kill = () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once("exit", resolve); child.kill("SIGKILL"); } });
  return { call, start, kill, messages, stderr: () => stderr, root: fixture.root };
}

/** The structured result of a tool call that must succeed. */
export function result(response) {
  if (response.error) throw new Error(response.error.message);
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? "tool error");
  return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
}

/** Asks one decision gate of the fixture's initiative through a Prism server and returns its id. */
export async function askGate(server, { initiative = INITIATIVE, question = "Keep the old export layout?" } = {}) {
  const read = result(await server.call("get_coordination_state", { initiative }));
  const changed = result(await server.call("update_coordination_state", { initiative, expectedRevision: read.exists ? read.revision : null, changes: { gateOperations: [
    { op: "ask", kind: "decision", question, context: "Two scripts still read the old layout, so dropping it breaks them until they move.", artifacts: [], options: [{ id: "keep", label: "Keep", consequence: "Exports write both layouts." }, { id: "drop", label: "Drop", consequence: "Exports write only the new layout." }], recommended: { option: "keep", reason: "Both scripts still read it." } }
  ] } }));
  return changed.openedGates[0].id;
}

/** The gate's Attention item on this machine's page, from Needs you or Answered, or undefined. */
export async function card(review, id) {
  const data = (await get(review.base, "api/entity?ref=attention", review.headers)).json.data;
  return [...data.needsYou, ...data.answered].find((item) => item.type === "gate" && item.id === id);
}

/** Answers a gate of the initiative on this machine's page. */
export async function answer(review, id, choice = "keep", initiative = INITIATIVE) {
  const target = `gate:${initiative}/${id}`;
  const listed = await listing(review.base, target, review.headers);
  const action = actionOf(listed, "gate.answer");
  return apply(review.base, { action: "gate.answer", target, input: { choice }, revision: action.revision }, review.headers);
}

/** Every file below a folder, with its text, skipping Git's own objects. */
export function filesBelow(folder) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue;
      const file = path.join(current, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else found.push({ file, text: readFileSync(file, "utf8") });
    }
  };
  if (existsSync(folder)) walk(folder);
  return found;
}
