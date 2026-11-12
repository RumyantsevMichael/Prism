import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./isolated-env.mjs";
import { defer } from "./teardown.mjs";

// Projects with shipped and finished initiatives, built from records written directly and driven through Prism's MCP server,
// because a real completion gate needs verification and review evidence that these tests do not build.

const SERVER = fileURLToPath(new URL("../../../dist/server/mcp.mjs", import.meta.url));
const MANIFEST = fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url));
export const WORKFLOW = "## Paths\n- Requirements: docs/requirements/\n- Plans: docs/plans/\n- Roadmap: docs/roadmap.md\n\n## Stack\n- Test command: node -e \"process.exit(0)\"\n";
export const REQUIREMENT = "docs/requirements/reports.md#1";

/** A slice record entry. */
export const slice = (title, status, parent = null, requirements = [REQUIREMENT], extra = {}) => ({ title, status, parent, requirements, dependencies: [], ...extra });

/** Two finished slices under a split root, the usual shape of a shipped initiative. */
export const finished = () => ({
  root: slice("Reports", "split", null, ["docs/requirements/reports.md#1", "docs/requirements/reports.md#2"]),
  download: slice("Download reports", "done", "root", ["docs/requirements/reports.md#1"]),
  audit: slice("Audit downloads", "done", "root", ["docs/requirements/reports.md#2"], { dependencies: ["download"] })
});

export async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "docs/requirements"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), WORKFLOW);
  await writeFile(path.join(root, "docs/requirements/reports.md"), "# Reports\n\nStatus: Approved\n\n## 1. Download\n\n## 2. Audit\n");
  return root;
}

export const recordFile = (root, initiative, name = "initiative.json") => path.join(root, ".prism/initiatives", initiative, name);
export const folderOf = (initiative, slices, slug) => slices[slug].parent === null ? `docs/plans/${initiative}` : `docs/plans/${initiative}/${slug}`;

export async function writeInitiative(root, initiative, slices, extra = {}) {
  await mkdir(path.dirname(recordFile(root, initiative)), { recursive: true });
  await writeFile(recordFile(root, initiative), `${JSON.stringify({ schemaVersion: 1, id: initiative, slices, history: [], ...extra }, null, 2)}\n`);
}

/** Each slice's slice.md, as design writes it: a title, an outcome, and its body. */
export async function writeSliceDocs(root, initiative, slices) {
  const written = [];
  for (const slug of Object.keys(slices)) {
    const file = `${folderOf(initiative, slices, slug)}/slice.md`;
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), `# ${slices[slug].title}\n\n## Outcome\n\n${slices[slug].title} works.\n`);
    written.push(file);
  }
  return written.sort();
}

export const readText = (root, file) => readFile(path.join(root, file), "utf8");

/** A live claim record of another holder on a slice. */
export async function writeClaim(root, initiative, slug, activity = "implementation") {
  const now = Date.now();
  const claim = { schemaVersion: 1, slug, holder: "other-holder", label: "main on other-host", activity, claimedAt: new Date(now).toISOString(), renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20 * 60000).toISOString(), nonce: "0123456789abcdef01234567" };
  await mkdir(path.join(root, ".prism/initiatives", initiative, "claims"), { recursive: true });
  await writeFile(path.join(root, ".prism/initiatives", initiative, "claims", `${slug}.json`), `${JSON.stringify(claim, null, 2)}\n`);
}

/** One Prism MCP server for a project: call(name, args) answers { result, error, text, value }, where value is the structured result or the error data. */
export async function mcp(context, root) {
  const data = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-data-")));
  const child = spawn(process.execPath, [SERVER], { cwd: root, env: isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: MANIFEST, PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: root }), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const waiting = new Map();
  let next = 0;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });
  defer(context, async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(data, { recursive: true, force: true });
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shipped-work-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return async (name, args = {}) => {
    const message = await rpc("tools/call", { name, arguments: { projectRoot: root, ...args } });
    const text = (message.result?.content ?? []).map((item) => item.text ?? "").join("\n");
    return { result: message.result ?? null, error: message.error ?? null, text, value: message.result?.structuredContent ?? message.error?.data ?? null };
  };
}

/** Add roadmap entries through update_roadmap, creating the record when needed. */
export async function addEntries(call, entries) {
  const current = await call("get_roadmap");
  return call("update_roadmap", { expectedRevision: current.value.revision ?? null, operations: entries.map((entry) => ({ op: "add_initiative", title: `Title ${entry.id}`, intent: `Intent ${entry.id}.`, band: "Now", requirements: [REQUIREMENT], ...entry })) });
}

export async function roadmapOperation(call, operation) {
  const current = await call("get_roadmap");
  return call("update_roadmap", { expectedRevision: current.value.revision, operations: [operation] });
}

export const ship = (call, id) => roadmapOperation(call, { op: "ship", id });

/** A project whose initiative finished both slices, with slice documents and a roadmap entry, ready to ship. */
export async function finishedProject(context, initiative = "reports", slices = finished(), extra = {}) {
  const root = await project(context);
  await writeInitiative(root, initiative, slices, extra);
  const documents = await writeSliceDocs(root, initiative, slices);
  const call = await mcp(context, root);
  const added = await addEntries(call, [{ id: initiative }]);
  if (added.error) throw new Error(`The roadmap entry was not added: ${added.error.message}`);
  return { root, call, documents, initiative, slices };
}

/** A project whose initiative shipped through update_roadmap ship. */
export async function shippedProject(context, initiative = "reports", slices = finished()) {
  const setup = await finishedProject(context, initiative, slices);
  const shipped = await ship(setup.call, initiative);
  if (shipped.error) throw new Error(`The initiative did not ship: ${shipped.error.message}`);
  return { ...setup, shipped, shippedAt: shipped.value.record.initiatives.find((item) => item.id === initiative).decision.at };
}

/**
 * A project with an initiative that shipped before shipped history existed: a decision with kind, at, and actor only, written directly,
 * with its initiative record and slice documents kept.
 */
export async function earlierShippedProject(context, initiative = "reports", slices = finished(), { record = true, documents = true } = {}) {
  const root = await project(context);
  if (record) await writeInitiative(root, initiative, slices);
  const written = documents ? await writeSliceDocs(root, initiative, slices) : [];
  const at = "2026-11-03T23:35:20.345Z";
  const roadmap = { schemaVersion: 1, serves: "", initiatives: [{ id: initiative, title: `Title ${initiative}`, intent: `Intent ${initiative}.`, band: "Now", requirements: [REQUIREMENT], requires: [], decision: { kind: "shipped", at, actor: "orchestrator" } }], openQuestions: [], history: [] };
  await writeFile(path.join(root, ".prism/roadmap.json"), `${JSON.stringify(roadmap, null, 2)}\n`);
  const call = await mcp(context, root);
  return { root, call, documents: written, initiative, slices, shippedAt: at };
}
