// P1: how a RecordStoreError reaches an MCP client over stdio, and whether a record tool result can carry a text note after its JSON.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import os from "node:os"; import path from "node:path"; import readline from "node:readline";
const { isolatedEnv } = await import(new URL("../../../../test/server/fixtures/isolated-env.mjs", import.meta.url).href);
const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "probe-mcp-")));
const root = path.join(parent, "api"); await mkdir(path.join(root, ".prism"), { recursive: true });
await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n\n## Workspace\n- Store: ../missing-store\n");
const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: path.join(parent, "app"), CLAUDE_PROJECT_DIR: root });
const child = spawn(process.execPath, [new URL("../../../../dist/server/mcp.mjs", import.meta.url).pathname], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout }); const queue = []; const waiters = [];
lines.on("line", (l) => { const m = JSON.parse(l); (waiters.shift() ?? ((x) => queue.push(x)))(m); });
const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r));
const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }); await next();
send({ id: 2, method: "tools/call", params: { name: "get_roadmap", arguments: { projectRoot: root } } });
console.log(JSON.stringify(await next()).slice(0, 600));
child.stdin.end();
child.kill();
