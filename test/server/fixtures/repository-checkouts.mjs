import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "./isolated-env.mjs";

// Git checkouts of separate repositories that share one record store, each driven by a real Prism server over stdio.
// A test file sets HOME, the Git configuration, and the Git identity in process.env before it uses these helpers, as the M1 tests do.
const SERVER_PATH = fileURLToPath(new URL("../../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url));

const running = new Set();

/** Stop every server these helpers started, so a test removes its folders only after no server still writes them. */
export async function closeServers() {
  await Promise.all([...running].map((close) => close()));
}

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** The workflow configuration of a checkout: a store, optional Repository and Store sync lines, and a test command that passes. */
export function workflowConfig({ store = "../store", repository, sync } = {}) {
  const workspace = [`- Store: ${store}`, ...(repository === undefined ? [] : [`- Repository: ${repository}`]), ...(sync === undefined ? [] : [`- Store sync: ${sync}`])];
  return `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n\n## Workspace\n${workspace.join("\n")}\n`;
}

/** Write a checkout's workflow configuration and commit it, as a team commits its repository name. */
export async function configure(root, options) {
  await writeFile(path.join(root, ".prism", "workflow.md"), workflowConfig(options));
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "configure Prism");
}

/**
 * A new repository with its own history: one commit whose content names the repository, so every repository has its own root commit.
 * remote is the origin URL, or null for a repository without one.
 */
export async function repository(parent, name, { remote = null, ...config } = {}) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "README.md"), `# ${name}\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  git(root, "init", "-q", "-b", "main");
  if (remote) git(root, "remote", "add", "origin", remote);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `start ${name}`);
  await configure(root, config);
  return realpath(root);
}

/**
 * Another checkout of an existing repository, sharing its history: a full clone, or a shallow clone of depth 1 when shallow is set.
 * remote replaces the clone's origin URL, or removes it when null, as a repository moved on its host or copied without a remote would have.
 */
export async function cloneOf(source, parent, name, { remote, shallow = false, ...config } = {}) {
  const root = path.join(parent, name);
  git(parent, "clone", "-q", ...(shallow ? ["--depth", "1"] : []), pathToFileURL(source).href, root);
  if (remote === null) git(root, "remote", "remove", "origin");
  else if (remote !== undefined) git(root, "remote", "set-url", "origin", remote);
  if (Object.keys(config).length) await configure(root, config);
  return realpath(root);
}

/** A record store folder beside the checkouts. */
export async function storeFolder(parent, name = "store") {
  await mkdir(path.join(parent, name), { recursive: true });
  return realpath(path.join(parent, name));
}

/** Every file under a folder, outside .git, as relative paths with their bytes as text. */
export async function snapshot(folder) {
  const files = {};
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) await visit(child);
      else files[child] = await readFile(path.join(folder, child), "utf8");
    }
  };
  await visit("");
  return files;
}

/** A store's registration of a repository name, or null. */
export async function registration(store, name) {
  try { return JSON.parse(await readFile(path.join(store, "repositories", `${name}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/**
 * A Prism server over stdio for one checkout, with this machine's Prism application folder.
 * hostRoot names the checkout at start as Claude Code does; without it the server learns the checkout from its first tool call, as in Codex.
 * call(name, args) resolves to the JSON-RPC response: { result } or { error }.
 */
export async function prismServer(context, root, { appFolder, hostRoot = true, env = {} } = {}) {
  const environment = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, ...(appFolder ? { PRISM_REVIEW_APP_DIR: appFolder } : {}), ...env });
  if (hostRoot) environment.CLAUDE_PROJECT_DIR = root;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // A server ends when its input closes; one that has not ended after ten seconds is killed, so a test never hangs on it.
  const close = async () => {
    running.delete(close);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timer);
  };
  running.add(close);
  context.after(close);
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, resolve);
    exited.then((code) => reject(new Error(`The Prism server exited with code ${code}: ${stderr}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repository-names-test", version: "1" } });
  return {
    root,
    call: (name, args = {}) => request("tools/call", { name, arguments: { projectRoot: root, ...args } }),
    close
  };
}

/** The text items of a tool result after its first one, where Prism adds notes such as migration reports and warnings. */
export const notes = (response) => (response.result?.content ?? []).slice(1).map((item) => item.text).join("\n");

/** Create an initiative through the server, a record write that opens the store. */
export const createInitiative = (server, slug = "reports") => server.call("update_initiative", { initiative: slug, expectedRevision: null, operations: [{ op: "create", slug, title: "Reports", requirements: ["r.md#1"] }] });
