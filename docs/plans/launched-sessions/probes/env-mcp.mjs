// Minimal stdio MCP server that records its environment.
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ENV_OUT || "/dev/null", JSON.stringify({ hostKeys: Object.keys(process.env).filter((k) => /CLAUDE|CODEX|ANTHROPIC|OPENAI/.test(k)), PRISM_LAUNCH: process.env.PRISM_LAUNCH ?? null, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null, pid: process.pid, ppid: process.ppid }));
let buf = "";
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "envprobe", version: "1" } } }) + "\n");
  else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } }) + "\n");
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n"); } });
