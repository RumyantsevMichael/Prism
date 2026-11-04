#!/usr/bin/env node
// Installs this checkout into real Claude Code and Codex CLIs and calls a Prism record tool through each host, as an agent would.
// No model or API key is needed: Codex calls the tool through its app server, and Claude Code talks to a scripted local Messages API.
// The project names a remote record store, so the call proves the server starts the way the host starts it and can clone that store.
// Usage: node scripts/host-smoke.mjs [claude|codex]...  (both hosts by default; CLAUDE_BIN and CODEX_BIN override the executables)
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hosts = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"];
const TOOL = "get_roadmap";
const TIMEOUT_MS = 180000;

const work = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-host-smoke-")));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
const git = (cwd, ...args) => run("git", ["-c", "user.name=Prism Smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd });

// A bare remote with one commit, and a project whose workflow config names it as the record store.
async function fixture() {
  git(work, "init", "-q", "--bare", "-b", "main", "store.git");
  const seed = path.join(work, "seed");
  git(work, "clone", "-q", path.join(work, "store.git"), seed);
  git(seed, "checkout", "-q", "-b", "main");
  git(seed, "commit", "-q", "--allow-empty", "-m", "init");
  git(seed, "push", "-q", "-u", "origin", "main");
  const url = pathToFileURL(path.join(work, "store.git")).href;
  const project = path.join(work, "project");
  await mkdir(path.join(project, ".prism"), { recursive: true });
  await writeFile(path.join(project, ".prism/workflow.md"), `# Workflow config\n\n## Workspace\n- Store: ${url}\n`);
  git(project, "init", "-q");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "init");
  // The clone path Prism promises, computed here independently: SHA-256 of the remote without .git, first 16 hex characters.
  const id = createHash("sha256").update(url.replace(/\.git$/, "")).digest("hex").slice(0, 16);
  return { project, id };
}

// Each host gets a private home, config, and Prism app folder, so nothing touches the runner's own installation.
function hostEnvironment(name) {
  const root = path.join(work, name);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_|PLUGIN_|PRISM_|XDG_STATE_HOME$)/.test(key)));
  return { root, appFolder: path.join(root, "app"), env: { ...environment, HOME: path.join(root, "home"), PRISM_REVIEW_APP_DIR: path.join(root, "app"), PRISM_REVIEW_BROWSER_ON_START: "off", GIT_CONFIG_NOSYSTEM: "1" } };
}

// The first text block is the tool's JSON result; later blocks are notes for the agent, such as sync reports or a missing repository name.
function firstText(content) {
  return (content || []).find((part) => part.type === "text")?.text ?? "";
}

function parseResult(name, text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${name}: ${TOOL} returned text that is not JSON: ${text.slice(0, 500)}`); }
  if (!("exists" in value && "valid" in value)) throw new Error(`${name}: ${TOOL} returned an unexpected shape: ${text.slice(0, 500)}`);
  return value;
}

function checkClone(name, appFolder, id) {
  const clone = path.join(appFolder, "stores", id);
  if (!existsSync(path.join(clone, ".git"))) throw new Error(`${name}: the remote store was not cloned to ${clone}`);
}

// Claude Code: install from the checkout's marketplace, then run one print-mode turn against a scripted model that calls the tool once.
async function claude({ project, id }) {
  const bin = process.env.CLAUDE_BIN || "claude";
  const { root, appFolder, env } = hostEnvironment("claude");
  env.CLAUDE_CONFIG_DIR = path.join(root, "config");
  await mkdir(env.HOME, { recursive: true });
  run(bin, ["plugin", "marketplace", "add", checkout], { env });
  run(bin, ["plugin", "install", "prism@prism"], { env });
  const tool = `mcp__plugin_prism_prism-review__${TOOL}`;
  let result = null;
  let offered = false;
  const model = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    let json = {};
    try { json = JSON.parse(body); } catch {}
    if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const last = json.messages?.at(-1);
    const answered = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    if (answered) result = answered;
    const hasTool = (json.tools || []).some((entry) => entry.name === tool);
    offered ||= hasTool;
    const block = hasTool && !answered && !result ? { type: "tool_use", id: "toolu_prism_smoke", name: tool, input: {} } : { type: "text", text: "done" };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    const message = { id: "msg_prism_smoke", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!json.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...message, content: [block], stop_reason: stop }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message });
    if (block.type === "text") {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
    } else {
      event("content_block_start", { index: 0, content_block: { ...block, input: {} } });
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    event("message_stop", {});
    response.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${model.address().port}`;
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ["-p", "Call the Prism roadmap tool.", "--allowedTools", tool, "--output-format", "json"], {
        cwd: project, stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sk-ant-prism-smoke", ENABLE_TOOL_SEARCH: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`claude exited with ${code}: ${output.slice(-2000)}`)); });
    });
  } finally {
    model.close();
  }
  if (!offered) throw new Error(`claude: the model was never offered ${tool}, so the plugin's MCP server did not load`);
  if (!result) throw new Error(`claude: ${tool} was offered but no tool result came back`);
  const text = typeof result.content === "string" ? result.content : firstText(result.content);
  if (result.is_error) throw new Error(`claude: ${TOOL} failed: ${text.slice(0, 1000)}`);
  parseResult("claude", text);
  checkClone("claude", appFolder, id);
}

// Codex: install from the checkout's marketplace, start a thread in the project, and call the tool through the app server.
async function codex({ project, id }) {
  const bin = process.env.CODEX_BIN || "codex";
  const { root, appFolder, env } = hostEnvironment("codex");
  env.CODEX_HOME = path.join(root, "codex-home");
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  run(bin, ["plugin", "marketplace", "add", checkout], { env });
  run(bin, ["plugin", "add", "prism@prism"], { env });
  const child = spawn(bin, ["app-server"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const pending = new Map();
  let buffer = "";
  let next = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const request = (method, params) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`codex: ${method} timed out; app server log: ${stderr}`)), TIMEOUT_MS).unref());
    const gone = exited.then((code) => { throw new Error(`codex: the app server exited with ${code} during ${method}: ${stderr}`); });
    return Promise.race([answer, timeout, gone]).then((message) => {
      if (message.error) throw new Error(`codex: ${method} failed: ${message.error.message}`);
      return message.result;
    });
  };
  try {
    await request("initialize", { clientInfo: { name: "prism-host-smoke", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const started = await request("thread/start", { cwd: project });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`codex: thread/start returned no thread id: ${JSON.stringify(started).slice(0, 500)}`);
    const called = await request("mcpServer/tool/call", { threadId, server: "prism-review", tool: TOOL, arguments: { projectRoot: project } });
    const text = firstText(called.content);
    if (called.isError) throw new Error(`codex: ${TOOL} failed: ${text.slice(0, 1000)}`);
    parseResult("codex", text);
    checkClone("codex", appFolder, id);
  } finally {
    child.kill();
  }
}

const runners = { claude, codex };
let failed = false;
try {
  const setup = await fixture();
  for (const host of hosts) {
    if (!runners[host]) throw new Error(`Unknown host ${host}; use claude or codex.`);
    try {
      await runners[host](setup);
      console.log(`ok - ${host} called ${TOOL} on a remote record store`);
    } catch (error) {
      failed = true;
      console.log(`not ok - ${host}: ${error.stderr || error.message}`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
