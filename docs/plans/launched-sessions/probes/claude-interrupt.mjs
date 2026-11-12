// Probe: Claude Code headless with stream-json input, against the scripted Messages API (fake-messages.mjs), never a real model.
// It sends the prompt as a stream-json user message, keeps standard input open, sends the interrupt control request while a
// Bash command runs, and then closes standard input; it prints every host event with its time and the host's exit.
// Set CLOSE_ON=response to close the input on the interrupt's control_response.
// usage: node claude-interrupt.mjs <work folder> <scenario: foreground | background | bgclose | bgopen | finish | resume> [session id]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [work, scenario = "foreground", given] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
// A resume continues the session of an earlier finish run, in that run's folder.
const folder = path.resolve(work, scenario === "resume" ? "finish" : scenario);
if (scenario !== "resume") rmSync(folder, { recursive: true, force: true });
for (const sub of ["home", "config", "proj", "plug/.claude-plugin", "plug/skills/orchestrate"]) mkdirSync(path.join(folder, sub), { recursive: true });
if (scenario !== "resume") execFileSync("git", ["init", "-q"], { cwd: path.join(folder, "proj") });
writeFileSync(path.join(folder, "plug/.claude-plugin/plugin.json"), JSON.stringify({ name: "probeplug", version: "0.0.1" }));
writeFileSync(path.join(folder, "plug/skills/orchestrate/SKILL.md"), "---\nname: orchestrate\ndescription: probe\n---\nPROBE-SKILL-BODY-MARKER for $ARGUMENTS\n");
const tool = { foreground: { command: "timeout 31 tail -f /dev/null", description: "wait" }, background: { command: "timeout 32 tail -f /dev/null", description: "wait", run_in_background: true } };
tool.bgclose = tool.background;
tool.bgopen = { command: "timeout 3 tail -f /dev/null", description: "wait", run_in_background: true };
const toolInput = tool[scenario];
const plan = toolInput ? [{ type: "tool_use", id: "toolu_1", name: "Bash", input: toolInput }] : [];
const port = 20000 + Math.floor(Math.random() * 20000);
const fake = spawn(process.execPath, [path.join(here, "fake-messages.mjs")], { env: { ...process.env, PLAN: JSON.stringify(plan), LOG: path.join(folder, "api.log"), PORT: String(port) }, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 500));
const session = given ?? randomUUID();
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", scenario === "resume" ? "--resume" : "--session-id", session,
  "--permission-mode", toolInput ? "default" : "auto", "--permission-prompts", "none", "--allowedTools", "Bash", "--plugin-dir", path.join(folder, "plug")];
const env = { PATH: process.env.PATH, HOME: path.join(folder, "home"), CLAUDE_CONFIG_DIR: path.join(folder, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-probe", NO_PROXY: "127.0.0.1", ENABLE_TOOL_SEARCH: "false" };
const started = Date.now();
const t = () => Date.now() - started;
const host = spawn("claude", args, { cwd: path.join(folder, "proj"), env, stdio: ["pipe", "pipe", "pipe"] });
const send = (message) => { console.log(`${t()} SEND ${JSON.stringify(message)}`); host.stdin.write(JSON.stringify(message) + "\n"); };
let buffer = "";
let interrupted = false;
let results = 0;
host.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { console.log(`${t()} RAW ${line.slice(0, 200)}`); continue; }
    const brief = { type: event.type, subtype: event.subtype, session_id: event.session_id, is_error: event.is_error, result: typeof event.result === "string" ? event.result.slice(0, 120) : undefined, response: event.response, tool: event.message?.content?.find?.((block) => block.type === "tool_use")?.name, stop_reason: event.stop_reason };
    console.log(`${t()} EVENT ${JSON.stringify(brief)}`);
    if (event.type === "system" && /^task_/.test(event.subtype ?? "")) console.log(`${t()} TASK ${JSON.stringify(event).slice(0, 400)}`);
    // With CLOSE_ON=response, the input closes as soon as the host answers the interrupt, without waiting for a result.
    if (process.env.CLOSE_ON === "response" && event.type === "control_response" && !host.stdin.writableEnded) { console.log(`${t()} CLOSE stdin on the interrupt's answer`); host.stdin.end(); }
    if (event.type === "result") {
      results += 1;
      if (scenario === "background" && !interrupted) {
        // The turn ended with the background command running: interrupt now, then close the input after the next result or 3 s.
        interrupted = true;
        setTimeout(() => { send({ type: "control_request", request_id: "req-bg", request: { subtype: "interrupt" } }); setTimeout(() => { if (!host.stdin.writableEnded) { console.log(`${t()} CLOSE stdin`); host.stdin.end(); } }, 3000); }, 1500);
      } else if (scenario === "bgopen") {
        // Input stays open while the background command runs; it closes after the turn that follows the command's end.
        if (results === 2) { console.log(`${t()} CLOSE stdin after the follow-up turn`); host.stdin.end(); }
      } else if (scenario !== "background") {
        setTimeout(() => { if (!host.stdin.writableEnded) { console.log(`${t()} CLOSE stdin (alive=${host.exitCode === null})`); host.stdin.end(); } }, 1500);
      }
    }
  }
});
let stderr = "";
host.stderr.on("data", (chunk) => { stderr += chunk; });
send({ type: "user", message: { role: "user", content: scenario === "resume" ? "continue" : "/probeplug:orchestrate demo-init" } });
if (scenario === "foreground") {
  // Interrupt once the Bash command runs.
  const poll = setInterval(() => {
    let found = "";
    try { found = execFileSync("pgrep", ["-f", "^timeout 31 tail"], { encoding: "utf8" }); } catch {}
    if (found.trim() && !interrupted) {
      interrupted = true;
      clearInterval(poll);
      console.log(`${t()} BASH running as ${found.trim()}`);
      send({ type: "control_request", request_id: "req-1", request: { subtype: "interrupt" } });
      setTimeout(() => { let left = ""; try { left = execFileSync("pgrep", ["-f", "^timeout 31 tail"], { encoding: "utf8" }); } catch {} console.log(`${t()} BASH after interrupt: ${left.trim() || "gone"}`); }, 1000);
    }
  }, 100);
}
const timeout = setTimeout(() => { console.log(`${t()} TIMEOUT, killing the probe host`); host.kill("SIGKILL"); }, 60000);
host.on("exit", (code, signal) => {
  clearTimeout(timeout);
  let left = "";
  try { left = execFileSync("pgrep", ["-f", "^timeout 3[12] tail"], { encoding: "utf8" }); } catch {}
  console.log(`${t()} EXIT code=${code} signal=${signal} session=${session} sleepLeft=${left.trim() || "none"} stderr=${JSON.stringify(stderr.slice(-300))}`);
  fake.kill();
});
