// Probe: how a Prism MCP server can tell which agent of a host session made a tool call.
// A scripted model makes the main agent call a logging MCP tool, start one sub-agent that calls it, and call it again.
// The probe prints, per call, the server process, the call's _meta, and for Claude Code the PreToolUse hook input of the same tool use.
// Run: node docs/plans/initiative-settings-actions/probes/agent-identity.mjs claude|codex (CLAUDE_BIN and CODEX_BIN override the executables).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const host = process.argv[2] === "codex" ? "codex" : "claude";
const work = mkdtempSync(path.join(os.tmpdir(), "prism-agent-identity-"));
const log = path.join(work, "log.jsonl");
writeFileSync(log, "");
const server = path.join(work, "server.mjs");
writeFileSync(server, `import readline from "node:readline"; import { appendFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => { const r = JSON.parse(line);
  if (r.method === "initialize") return send({ jsonrpc: "2.0", id: r.id, result: { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
  if (r.method === "tools/list") return send({ jsonrpc: "2.0", id: r.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: { who: { type: "string" } } } }] } });
  if (r.method === "tools/call") { appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: "call", pid: process.pid, session: process.env.CLAUDE_CODE_SESSION_ID ?? null, params: r.params }) + "\\n"); return send({ jsonrpc: "2.0", id: r.id, result: { content: [{ type: "text", text: "pong" }] } }); }
  if (r.id !== undefined) send({ jsonrpc: "2.0", id: r.id, result: {} }); });`);
const hook = path.join(work, "hook.mjs");
writeFileSync(hook, `import { appendFileSync } from "node:fs"; let s = ""; for await (const c of process.stdin) s += c; appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: "hook", input: JSON.parse(s) }) + "\\n");`);
const project = path.join(work, "project");
mkdirSync(path.join(project, ".claude"), { recursive: true });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_)/.test(key))), HOME: path.join(work, "home"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
mkdirSync(env.HOME, { recursive: true });

// The main agent pings, starts a sub-agent that pings, then pings again; a request whose first user message is the sub-agent's task is the sub-agent's.
const step = (isChild, results) => isChild ? (results ? null : ["ping", { who: "sub-agent" }]) : [["ping", { who: "main-before" }], ["spawn", null], ...(host === "codex" ? [["wait", null]] : []), ["ping", { who: "main-after" }]][results] ?? null;

function sse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.end();
}

const model = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const json = body ? JSON.parse(body) : {};
  if (host === "claude") {
    if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ input_tokens: 1 })); return; }
    const isChild = JSON.stringify(json.messages?.[0] ?? "").includes("SUB-AGENT-TASK");
    const results = (json.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []).length;
    const next = (json.tools ?? []).some((t) => t.name === "mcp__probe__ping") ? step(isChild, results) : null;
    const block = !next ? { type: "text", text: "done" } : next[0] === "ping" ? { type: "tool_use", id: `toolu_${next[1].who.replace("-", "_")}`, name: "mcp__probe__ping", input: next[1] } : { type: "tool_use", id: "toolu_spawn", name: "Agent", input: { description: "probe", prompt: "SUB-AGENT-TASK ping", subagent_type: "general-purpose" } };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    const message = { id: `msg_${results}${isChild ? "c" : "m"}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
    const delta = block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
    sse(response, [["message_start", { message }], ["content_block_start", { index: 0, content_block: start }], ["content_block_delta", { index: 0, delta }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }], ["message_stop", {}]]);
    return;
  }
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  const input = json.input ?? [];
  const users = JSON.stringify(input.filter((item) => item.role === "user"));
  const isChild = users.includes("SUB-AGENT-TASK") && !users.includes("MAIN-TASK");
  const outputs = input.filter((item) => item.type === "function_call_output");
  const next = step(isChild, outputs.length);
  const call = (namespace, name, args, id) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, namespace, name, arguments: JSON.stringify(args) });
  const spawned = outputs[1] ? JSON.parse(outputs[1].output).agent_id : null;
  const item = !next ? { type: "message", id: `msg_${outputs.length}`, role: "assistant", content: [{ type: "output_text", text: "done" }] }
    : next[0] === "ping" ? call("mcp__probe", "ping", next[1], next[1].who.replace("-", "_"))
    : next[0] === "spawn" ? call("multi_agent_v1", "spawn_agent", { message: "SUB-AGENT-TASK ping" }, "spawn")
    : call("multi_agent_v1", "wait_agent", { targets: [spawned], timeout_ms: 60000 }, "wait");
  const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
  sse(response, [["response.created", { response: { id: `resp_${outputs.length}` } }], ["response.output_item.done", { output_index: 0, item }], ["response.completed", { response: { id: `resp_${outputs.length}`, usage } }]]);
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${model.address().port}`;
let command;
if (host === "claude") {
  env.CLAUDE_CONFIG_DIR = path.join(work, "config");
  writeFileSync(path.join(project, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__probe__ping", hooks: [{ type: "command", command: `node ${hook}` }] }] } }));
  writeFileSync(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: "node", args: [server] } } }));
  command = [process.env.CLAUDE_BIN || "claude", ["-p", "MAIN-TASK", "--mcp-config", path.join(work, "mcp.json"), "--allowedTools", "mcp__probe__ping,Agent", "--output-format", "json"], { ...env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sk-ant-probe", ENABLE_TOOL_SEARCH: "false" }];
} else {
  env.CODEX_HOME = path.join(work, "codex-home");
  mkdirSync(env.CODEX_HOME, { recursive: true });
  writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `model = "gpt-5.1-codex"\nopenai_base_url = ${JSON.stringify(`${base}/v1`)}\n\n[mcp_servers.probe]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`);
  const bin = process.env.CODEX_BIN || "codex";
  execFileSync(bin, ["login", "--with-api-key"], { env, input: "sk-probe", stdio: ["pipe", "pipe", "pipe"] });
  command = [bin, ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "MAIN-TASK"], env];
}
const [bin, args, childEnv] = command;
const child = spawn(bin, args, { cwd: project, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const code = await new Promise((resolve) => child.on("close", resolve));
model.close();
if (code !== 0) console.log(`${host} exited with ${code}: ${output.slice(-2000)}`);
for (const line of readFileSync(log, "utf8").trim().split("\n").filter(Boolean)) {
  const entry = JSON.parse(line);
  if (entry.kind === "hook") {
    const { session_id, agent_id, agent_type, tool_use_id, tool_input } = entry.input;
    console.log(JSON.stringify({ hook: tool_input?.who, session_id, agent_id: agent_id ?? null, agent_type: agent_type ?? null, tool_use_id }));
  } else {
    const turn = entry.params._meta?.["x-codex-turn-metadata"] ?? {};
    console.log(JSON.stringify({ call: entry.params.arguments.who, pid: entry.pid, session: entry.session, meta: Object.fromEntries(Object.entries(entry.params._meta ?? {}).filter(([key]) => key !== "x-codex-turn-metadata")), turn: { session_id: turn.session_id, thread_id: turn.thread_id, parent_thread_id: turn.parent_thread_id, thread_source: turn.thread_source } }));
  }
}
