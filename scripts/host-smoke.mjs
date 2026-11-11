#!/usr/bin/env node
// Installs this checkout into real Claude Code and Codex CLIs and calls a Prism record tool through each host, as an agent would.
// No model or API key is needed: Codex calls the tool through its app server, and Claude Code talks to a scripted local Messages API.
// The project names a remote record store, so the call proves the server starts the way the host starts it and can clone that store.
// A third check, codex-turn, runs one real Codex model turn against a scripted local Responses API, so the hooks run too.
// Usage: node scripts/host-smoke.mjs [claude|codex|codex-turn]...  (all by default; CLAUDE_BIN and CODEX_BIN override the executables)
// A CLAUDE_BIN or CODEX_BIN that names a JavaScript file runs under this Node, which is how Windows starts an npm launcher without its .cmd shim.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hosts = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "codex-turn"];
const TOOL = "get_roadmap";
const TIMEOUT_MS = 180000;

const work = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-host-smoke-")));
const launcher = (bin, args) => /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
const run = (command, args, options = {}) => execFileSync(...launcher(command, args), { stdio: "pipe", encoding: "utf8", ...options });
const start = (command, args, options) => spawn(...launcher(command, args), options);
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
  await writeFile(path.join(project, ".prism/workflow.md"), `# Workflow config\n\n## Workspace\n- Store: ${url}\n- Repository: project\n`);
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
  let announced = false;
  const model = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    let json = {};
    try { json = JSON.parse(body); } catch {}
    // The SessionStart hook adds the session key to the context, so seeing it here proves the plugin's hooks ran.
    announced ||= /Prism session correlation key: [0-9a-f]{64}/.test(body);
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
      const child = start(bin, ["-p", "Call the Prism roadmap tool.", "--allowedTools", tool, "--output-format", "json"], {
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
  if (!announced) throw new Error("claude: no Prism hook announced the session key, so the hooks did not run");
  if (!offered) throw new Error(`claude: the model was never offered ${tool}, so the plugin's MCP server did not load`);
  if (!result) throw new Error(`claude: ${tool} was offered but no tool result came back`);
  const text = typeof result.content === "string" ? result.content : firstText(result.content);
  if (result.is_error) throw new Error(`claude: ${TOOL} failed: ${text.slice(0, 1000)}`);
  parseResult("claude", text);
  checkClone("claude", appFolder, id);
}

// Starts `codex app-server` in a folder and returns a JSON-RPC `request` and a `close`.
async function appServer(bin, cwd, env) {
  const child = start(bin, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
  } catch (error) {
    child.kill();
    throw error;
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  return { request, close: () => child.kill() };
}

// Codex: install from the checkout's marketplace into a private home.
function installCodex(name) {
  const bin = process.env.CODEX_BIN || "codex";
  const host = hostEnvironment(name);
  host.env.CODEX_HOME = path.join(host.root, "codex-home");
  return { bin, ...host };
}

async function addCodexPlugin({ bin, env }) {
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  run(bin, ["plugin", "marketplace", "add", checkout], { env });
  run(bin, ["plugin", "add", "prism@prism"], { env });
}

// Codex: start a thread in the project and call the tool through the app server.
async function codex({ project, id }) {
  const host = installCodex("codex");
  await addCodexPlugin(host);
  const server = await appServer(host.bin, project, host.env);
  try {
    const started = await server.request("thread/start", { cwd: project });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`codex: thread/start returned no thread id: ${JSON.stringify(started).slice(0, 500)}`);
    const called = await server.request("mcpServer/tool/call", { threadId, server: "prism-review", tool: TOOL, arguments: { projectRoot: project } });
    const text = firstText(called.content);
    if (called.isError) throw new Error(`codex: ${TOOL} failed: ${text.slice(0, 1000)}`);
    parseResult("codex", text);
    checkClone("codex", host.appFolder, id);
  } finally {
    server.close();
  }
}

// Codex model turn: trusts Prism's hooks the way `/hooks` does, then runs one `codex exec` turn of a code-mode model
// against a scripted local Responses API. The scripted model writes one script that calls Prism tools, as gpt-6 models
// do, so the turn proves the hooks run, announce the session key, give the first call a context window, and link a
// Prism call that names an initiative to that initiative's run cost.
async function codexTurn() {
  const host = installCodex("codex-turn");
  await addCodexPlugin(host);
  const { bin, env } = host;
  const project = path.join(work, "turn-project");
  const initiative = path.join(project, ".prism", "initiatives", "demo");
  await mkdir(path.join(initiative, "slices", "alpha"), { recursive: true });
  await writeFile(path.join(project, ".prism", "workflow.md"), "# Workflow config\n\n## Workspace\n- Repository: turn-project\n\n## Run statistics\n- Collection: on\n");
  await writeFile(path.join(initiative, "state.json"), JSON.stringify({ schemaVersion: 1, settings: {}, active: [{ slice: "alpha", activity: "implementation", label: "alpha", workers: ["worker"] }], pending: [], next: [], evidence: [] }));
  git(project, "init", "-q");

  const listed = await (async () => {
    const server = await appServer(bin, project, env);
    try { return await server.request("hooks/list", { cwds: [project] }); } finally { server.close(); }
  })();
  const hooks = (listed?.data ?? []).flatMap((entry) => entry.hooks ?? []).filter((hook) => hook.pluginId === "prism@prism");
  if (hooks.length === 0) throw new Error(`codex: hooks/list shows no Prism hooks: ${JSON.stringify(listed).slice(0, 500)}`);
  const trust = hooks.map((hook) => {
    const [hash, contentHash] = hook.currentHash.split("/");
    return `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n${contentHash ? `trusted_content_hash = ${JSON.stringify(contentHash)}\n` : ""}`;
  }).join("");

  const results = [];
  let announced = false;
  const model = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST" || !request.url.endsWith("/responses")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const json = JSON.parse(body);
    const key = body.match(/Prism session correlation key: ([0-9a-f]{64})/)?.[1];
    const dataDirectory = body.match(/Prism plugin data directory: (.+?)\. Pass both/)?.[1];
    announced ||= Boolean(key && dataDirectory);
    const output = (json.input ?? []).find((item) => item.type === "custom_tool_call_output");
    if (output) results.push(...[output.output].flat().map((part) => typeof part === "string" ? part : part.text ?? ""));
    const session = JSON.stringify({ mode: "active", correlationKey: key, dataDirectory });
    const script = [
      `const capacity = await tools.mcp__prism_review__resolve_session_capacity({ projectRoot: ${JSON.stringify(project)}, session: ${session} });`,
      `await tools.mcp__prism_review__get_initiative({ projectRoot: ${JSON.stringify(project)}, initiative: "demo" });`,
      `const consumption = await tools.mcp__prism_review__summarize_session_consumption({ projectRoot: ${JSON.stringify(project)}, correlationKey: ${JSON.stringify(key)}, dataDirectory: ${JSON.stringify(dataDirectory)} });`,
      `text(JSON.stringify({ capacity: capacity.structuredContent, consumption: consumption.structuredContent }));`
    ].join("\n");
    const item = output || !key
      ? { type: "message", id: "msg_turn", role: "assistant", content: [{ type: "output_text", text: "done" }] }
      : { type: "custom_tool_call", id: "ct_turn", call_id: "call_turn", name: "exec", input: script };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("response.created", { response: { id: "resp_turn" } });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id: "resp_turn", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1010 } } });
    response.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${model.address().port}/v1`;
    const config = path.join(env.CODEX_HOME, "config.toml");
    const existing = existsSync(config) ? await readFile(config, "utf8") : "";
    await writeFile(config, `model = "gpt-6-luna"\nopenai_base_url = ${JSON.stringify(base)}\n${existing}${trust}`);
    const turnEnv = { ...env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    run(bin, ["login", "--with-api-key"], { env: turnEnv, input: "sk-prism-smoke", stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const child = start(bin, ["exec", "--skip-git-repo-check", "-s", "read-only", "-c", "approval_policy=\"never\"", "Run the Prism checks."], { cwd: project, env: turnEnv, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-4000); });
      child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-4000); });
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}: ${log}`)); });
    });
  } finally {
    model.close();
  }
  if (!announced) throw new Error("no Prism hook announced the session key, so the hooks did not run");
  const reported = results.map((text) => text.match(/\{"capacity".*\}/s)?.[0]).find(Boolean);
  if (!reported) throw new Error(`the script returned no result: ${results.join("\n").slice(0, 1000)}`);
  const { capacity, consumption } = JSON.parse(reported);
  if (capacity?.status !== "SUPPORTED") throw new Error(`the first call's capacity is ${capacity?.status} (${capacity?.reasonCode})`);
  const targets = consumption?.runMeasures?.attribution?.targets ?? [];
  if (!targets.some((entry) => entry.target?.initiative === "demo")) {
    throw new Error(`the get_initiative call was not linked to initiative demo: ${JSON.stringify(consumption?.runMeasures?.attribution).slice(0, 1000)}`);
  }
}

const runners = { claude, codex, "codex-turn": codexTurn };
let failed = false;
try {
  const setup = await fixture();
  for (const host of hosts) {
    if (!runners[host]) throw new Error(`Unknown host ${host}; use claude, codex, or codex-turn.`);
    try {
      await runners[host](setup);
      console.log(host === "codex-turn" ? "ok - codex-turn ran a code-mode model turn with Prism hooks, capacity, and run attribution" : `ok - ${host} called ${TOOL} on a remote record store`);
    } catch (error) {
      failed = true;
      console.log(`not ok - ${host}: ${error.stderr || error.message}`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
