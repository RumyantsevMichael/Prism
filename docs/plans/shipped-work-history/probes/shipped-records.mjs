// Probe: what the records of initiatives that shipped before shipped history hold, read through Prism's own MCP server.
// usage: node docs/plans/shipped-work-history/probes/shipped-records.mjs <projectRoot>
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(process.argv[2] ?? ".");
const server = fileURLToPath(new URL("../../../../dist/server/mcp.mjs", import.meta.url));
const child = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot, PRISM_REVIEW_APP: "off" }, stdio: ["pipe", "pipe", "ignore"] });
let buffer = "";
let next = 0;
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let index; (index = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  }
});
const rpc = (method, params) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
const call = async (name, args) => (await rpc("tools/call", { name, arguments: { projectRoot, ...args } })).result?.structuredContent ?? null;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });

const roadmap = await call("get_roadmap", {});
const exists = (file) => access(file).then(() => true, () => false);
const report = [];
for (const item of roadmap.record.initiatives.filter((entry) => entry.decision?.kind === "shipped")) {
  const initiative = await call("get_initiative", { initiative: item.id });
  const state = await call("get_coordination_state", { initiative: item.id });
  const slices = initiative?.record?.slices ?? {};
  const documents = [];
  for (const slug of Object.keys(slices)) {
    const folder = slices[slug].parent === null ? `docs/plans/${item.id}` : `docs/plans/${item.id}/${slug}`;
    if (await exists(path.join(projectRoot, folder, "slice.md"))) documents.push(`${folder}/slice.md`);
  }
  const pending = Array.isArray(state?.state?.pending) ? state.state.pending : [];
  report.push({
    initiative: item.id,
    decision: item.decision,
    recordExists: initiative?.exists ?? false,
    slices: Object.keys(slices).length,
    notDone: Object.entries(slices).filter(([, slice]) => !["done", "split"].includes(slice.status)).map(([slug, slice]) => `${slug}:${slice.status}`),
    proposals: Object.keys(initiative?.record?.proposals ?? {}),
    liveClaims: Object.keys(initiative?.claims ?? {}),
    stateExists: state?.exists ?? false,
    pendingGates: pending.length,
    unansweredGates: pending.filter((gate) => !gate?.answer).length,
    sliceDocuments: documents.length,
    shippedFieldToday: initiative?.shippedHistory ?? null
  });
}
console.log(JSON.stringify(report, null, 2));
child.kill();
