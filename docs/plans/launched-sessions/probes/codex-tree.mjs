// Probe: whether a SIGTERM to codex ends its sandboxed command. Run: node codex-tree.mjs <codex binary> <work folder from run-codex.sh> SIGTERM
import { spawn, execFileSync } from "node:child_process";
const [bin, dir, signal] = process.argv.slice(2);
const env = { PATH: process.env.PATH, HOME: `${dir}/home`, CODEX_HOME: `${dir}/codex-home`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
const child = spawn(bin, ["exec", "--json", "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"', "-c", 'sandbox_mode="workspace-write"', "go"], { cwd: `${dir}/proj`, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
const ps = () => execFileSync("ps", ["-eo", "pid,pgid,sid,ppid,args"], { encoding: "utf8" }).split("\n").filter((l) => /sleep 60|codex|env-mcp/.test(l) && !/ps -eo|codex-tree|grep/.test(l)).map((l) => l.slice(0, 120));
child.stdout.on("data", (c) => { out += c; if (!child.done && out.includes('"item.started"')) { child.done = true; setTimeout(() => {
  console.log(ps().join("\n")); process.kill(child.pid, signal);
  setTimeout(() => { console.log("after", signal); console.log(ps().join("\n") || "(none)"); process.exit(0); }, 4000); }, 1500); } });
child.on("exit", (code, sig) => console.log("codex exit", code, sig));
