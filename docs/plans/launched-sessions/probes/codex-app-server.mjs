// Probe: a Codex run through `codex app-server` over standard input and output, against the scripted Responses API
// (fake-responses.mjs), never a real model. It starts or resumes a thread with the launch policy, starts a turn with the
// orchestrate prompt, sends turn/interrupt while a command runs, closes standard input, and prints every message with its time.
// usage: CODEX_BIN=<codex> node codex-app-server.mjs <work folder> <scenario: interrupt | declined | ask | finish | resume> [thread id]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [work, scenario = "finish", given] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const bin = process.env.CODEX_BIN ?? "codex";
const folder = path.resolve(work);
for (const sub of ["home", "codex-home", "proj"]) mkdirSync(path.join(folder, sub), { recursive: true });
try { execFileSync("git", ["init", "-q"], { cwd: path.join(folder, "proj") }); } catch {}
const plans = {
  interrupt: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "timeout 41 tail -f /dev/null" }) }],
  declined: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "touch /etc/prism-probe-outside", sandbox_permissions: "require_escalated", justification: "probe" }) }],
  ask: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "request_user_input", arguments: JSON.stringify({ questions: [{ id: "q1", header: "Probe", question: "Continue?", options: [{ label: "Yes", description: "go on" }, { label: "No", description: "stop" }] }] }) }],
  ignore: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "timeout 42 tail -f /dev/null" }) }]
};
const port = 20000 + Math.floor(Math.random() * 20000);
const fake = spawn(process.execPath, [path.join(here, "fake-responses.mjs")], { env: { ...process.env, PLAN: JSON.stringify(plans[scenario] ?? []), LOG: path.join(folder, `api-${scenario}.log`), PORT: String(port) }, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 500));
// The model lines go first and the rest of the file, such as an installed plugin, is kept.
const configFile = path.join(folder, "codex-home/config.toml");
const kept = existsSync(configFile) ? readFileSync(configFile, "utf8").split("\n").filter((line) => !/^(model|openai_base_url) = /.test(line)).join("\n") : "";
writeFileSync(configFile, `model = "gpt-5.1-codex"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n${kept}`);
const env = { PATH: process.env.PATH, HOME: path.join(folder, "home"), CODEX_HOME: path.join(folder, "codex-home"), NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
try { execFileSync(bin, ["login", "--with-api-key"], { env, input: "sk-probe\n", stdio: ["pipe", "ignore", "ignore"] }); } catch {}
const started = Date.now();
const t = () => Date.now() - started;
const server = spawn(bin, ["app-server"], { cwd: path.join(folder, "proj"), env, stdio: ["pipe", "pipe", "pipe"] });
let next = 1;
const pending = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = next++;
  pending.set(id, resolve);
  console.log(`${t()} SEND ${method} ${JSON.stringify(params).slice(0, 300)}`);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
let thread = null;
let turn = null;
let interrupted = false;
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let message;
    try { message = JSON.parse(line); } catch { console.log(`${t()} RAW ${line.slice(0, 200)}`); continue; }
    if (message.id !== undefined && message.method) {
      // A request from the server, such as an approval or a question: the probe answers it with a JSON-RPC error and prints it.
      console.log(`${t()} SERVER-REQUEST ${message.method} ${JSON.stringify(message.params).slice(0, 400)}`);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Prism answers no host requests." } }) + "\n");
      continue;
    }
    if (message.id !== undefined) {
      console.log(`${t()} RESPONSE ${message.id} ${JSON.stringify(message.result ?? message.error).slice(0, 500)}`);
      pending.get(message.id)?.(message);
      continue;
    }
    const p = message.params ?? {};
    const brief = { thread: p.thread?.id, turn: p.turn?.id, status: p.turn?.status, error: p.turn?.error ?? p.error, item: p.item ? { type: p.item.type, status: p.item.status, command: p.item.command } : undefined };
    if (!/delta|tokenUsage|rateLimits|mcpServer|skills|warning/i.test(message.method)) console.log(`${t()} NOTE ${message.method} ${JSON.stringify(brief)}`);
    if (message.method === "item/started" && p.item?.type === "commandExecution" && ["interrupt", "ignore"].includes(scenario) && !interrupted) {
      interrupted = true;
      setTimeout(() => { request("turn/interrupt", { threadId: thread, turnId: turn }); }, 500);
    }
    if (message.method === "turn/completed") {
      setTimeout(() => { console.log(`${t()} CLOSE stdin`); server.stdin.end(); }, 500);
    }
  }
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });
server.on("exit", (code, signal) => {
  let left = "";
  try { left = execFileSync("pgrep", ["-f", "^timeout 4[12] tail"], { encoding: "utf8" }); } catch {}
  console.log(`${t()} EXIT code=${code} signal=${signal} thread=${thread} commandLeft=${left.trim() || "none"} stderr=${JSON.stringify(stderr.slice(-400))}`);
  fake.kill();
  process.exit(0);
});
setTimeout(() => { console.log(`${t()} TIMEOUT, killing the probe app-server`); server.kill("SIGKILL"); }, 60000);
await request("initialize", { clientInfo: { name: "prism-launch-probe", version: "1" }, capabilities: { experimentalApi: true } });
notify("initialized", {});
const policy = { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
const opened = scenario === "resume"
  ? await request("thread/resume", { threadId: given, cwd: path.join(folder, "proj"), ...policy })
  : await request("thread/start", { cwd: path.join(folder, "proj"), ...policy });
thread = opened.result?.thread?.id ?? null;
const begun = await request("turn/start", { threadId: thread, input: [{ type: "text", text: "$prism:orchestrate demo" }] });
turn = begun.result?.turn?.id ?? null;
