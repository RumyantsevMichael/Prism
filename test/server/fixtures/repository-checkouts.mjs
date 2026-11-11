import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnv } from "./isolated-env.mjs";
import { defer } from "./teardown.mjs";

// Git checkouts of separate repositories that share one record store, each driven by a real Prism server over stdio.
// A test file sets HOME, the Git configuration, and the Git identity in process.env before it uses these helpers, as the M1 tests do.
const SERVER_PATH = fileURLToPath(new URL("../../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url));

const running = new Set();
// A server that exits leaves running every Git process its store sync started, such as a push that still writes the remote's objects,
// so each server leads a process group of its own, which those processes stay in, and closing it waits until that group has ended.
const OWN_GROUP = process.platform !== "win32";

// Whether any process of a group still runs; a group that has ended, or that the platform cannot signal, has none.
function groupRuns(group) {
  try { process.kill(-group, 0); return true; } catch { return false; }
}

// Wait until a server's process group has ended; one that runs ten seconds longer is killed.
async function groupEnded(group) {
  if (!OWN_GROUP) return;
  const deadline = Date.now() + 10000;
  while (groupRuns(group)) {
    if (Date.now() > deadline) { try { process.kill(-group, "SIGKILL"); } catch { /* It ended meanwhile. */ } }
    if (Date.now() > deadline + 5000) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Stop every server these helpers started, so a test removes its folders only after no server still writes them. */
export async function closeServers() {
  await Promise.all([...running].map((close) => close()));
}

// A store file may hold up to 16 MiB, so Git output is taken up to well past that.
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 }).toString().trim();

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
 * client is the clientInfo the server is initialized with, such as a Claude Code version that moves long tool calls to the background.
 * call(name, args) resolves to the JSON-RPC response: { result } or { error }.
 */
export async function prismServer(context, root, { appFolder, hostRoot = true, env = {}, client = { name: "repository-names-test", version: "1" } } = {}) {
  const environment = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, ...(appFolder ? { PRISM_REVIEW_APP_DIR: appFolder } : {}), ...env });
  if (hostRoot) environment.CLAUDE_PROJECT_DIR = root;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: OWN_GROUP });
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
  // Closing ends once every process the server started has ended too, so no Git process it left still writes a folder the test removes.
  const close = async () => {
    running.delete(close);
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(timer);
    }
    await groupEnded(child.pid);
  };
  running.add(close);
  defer(context, close);
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, resolve);
    exited.then((code) => reject(new Error(`The Prism server exited with code ${code}: ${stderr}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: client });
  return {
    root,
    call: (name, args = {}) => request("tools/call", { name, arguments: { projectRoot: root, ...args } }),
    close
  };
}

/** The text items of a tool result after its first one, where Prism adds notes such as migration reports and saved sync conflicts. */
export const notes = (response) => (response.result?.content ?? []).slice(1).map((item) => item.text).join("\n");

/** Create an initiative through the server, a record write that opens the store. */
// The server also claims the root slice for design, since an agent's design proposal needs its holder's live claim, unless claim is false;
// it returns the create's response, or the refused create or claim.
export const createInitiative = async (server, slug = "reports", { claim = true } = {}) => {
  const created = await server.call("update_initiative", { initiative: slug, expectedRevision: null, operations: [{ op: "create", slug, title: "Reports", requirements: ["r.md#1"] }] });
  if (!claim || created.error || created.result?.isError) return created;
  const claimed = await server.call("update_initiative", { initiative: slug, expectedRevision: created.result.structuredContent.revision, operations: [{ op: "claim", slug }] });
  return claimed.error || claimed.result?.isError ? claimed : created;
};
