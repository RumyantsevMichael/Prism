// Shared setup for the review demo seeds: a fresh project directory, its private data directory, and the real Prism MCP tools.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = path.join(ROOT, "dist/server/mcp.mjs");
const MANIFEST = path.join(ROOT, "test/server/fixtures/native-manifest-unavailable.json");

// A requested directory is replaced; without one the project lands in a new temporary directory.
export async function prepareProject(requested, prefix) {
  const projectRoot = requested ? path.resolve(requested) : await mkdtemp(path.join(os.tmpdir(), prefix));
  if (requested) {
    await rm(projectRoot, { recursive: true, force: true });
  }
  await mkdir(projectRoot, { recursive: true });
  const realRoot = await realpath(projectRoot);
  const dataDir = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-data`);
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  async function write(relative, content) {
    const target = path.join(realRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { realRoot, dataDir, write };
}

// Starts the MCP server for the project, so every record is written exactly as an agent writes it.
export function startTools(realRoot, dataDir) {
  const env = { ...process.env, PRISM_REVIEW_APP: "off", PLUGIN_DATA: dataDir, PRISM_NATIVE_ASSET_MANIFEST: MANIFEST };
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [SERVER], { cwd: realRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  let nextId = 0;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });

  async function call(name, args) {
    const id = ++nextId;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} timed out: ${stderr}`)), 120000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
    if (response.error || response.result?.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(response.error ?? response.result)}`);
    }
    return response.result.structuredContent;
  }

  return { call, close: () => child.stdin.end() };
}
