// Probe: whether Claude Code puts its Bash commands in its own process group, and what survives SIGTERM or SIGKILL to that group.
// Run from run-claude.sh's folder layout: node tree-probe.mjs <scripted API port> <work folder> SIGTERM|SIGKILL
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const [port, dir, signal] = process.argv.slice(2);
const env = { PATH: process.env.PATH, HOME: `${dir}/home`, CLAUDE_CONFIG_DIR: `${dir}/config`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-probe", NO_PROXY: "127.0.0.1", ENABLE_TOOL_SEARCH: "false" };
const child = spawn("claude", ["-p", "go", "--session-id", "44444444-2222-4333-8444-55555555555" + Math.floor(Math.random()*10), "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--permission-prompts", "none", "--allowedTools", "Bash(sleep *)", "--mcp-config", `${dir}/mcp.json`], { cwd: `${dir}/proj`, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
const ps = () => execFileSync("ps", ["-eo", "pid,pgid,sid,ppid,cmd"], { encoding: "utf8" }).split("\n").filter(l => /sleep 6[0-9]{2}|claude|env-mcp/.test(l) && !/ps -eo|tree-probe/.test(l));
child.stdout.on("data", async (c) => { out += c; if (out.includes('"subtype":"result"') || out.includes('"type":"result"')) {
  if (child.done) return; child.done = true;
  console.log("claude pid", child.pid); console.log(ps().join("\n"));
  process.kill(-child.pid, signal);
  setTimeout(() => { console.log("after", signal); console.log(ps().join("\n") || "(none)"); process.exit(0); }, 6000);
} });
child.on("exit", (code, sig) => console.log("claude exit", code, sig));
