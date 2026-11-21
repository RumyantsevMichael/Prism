import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { ACP_HOST_PREFIX, ACP_ID_PATTERN, agentsFolder, launchRule, readInstalls } from "./acp-agents.mjs";
import { downloadUrlRefusal, npxPackage, readRegistry, uvxPackage, type RegistryAgent } from "./acp-registry.mjs";
import { ArchiveError, extractTarGz, extractZip } from "./archive-extract.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";
import { LaunchError, launchRunning, listLaunchRecords, processAlive } from "./launch-records.mjs";

// Installing, updating, and removing registry agents in the review app folder's agents/ folder, one at a time on this machine.
// Nothing of a download runs before the person confirms it in a native dialog, no install, build, or lifecycle script runs at any time,
// every download is checked against the registry, and an install changes nothing outside agents/: each version lives in
// agents/<id>/<version>/ beside its install.json, agents/<id>/current.json names the version that new runs use, and the downloads and the
// package programs' caches live in agents/.staging/, which each install removes when it ends.

const LOCK_FILE = ".install.lock";
const STAGING = ".staging";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REDIRECTS = 5;
const STDERR_TAIL = 16 * 1024;
const VERSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
// An earlier version that a launched session still runs on is checked again this often until it can be removed.
const SWEEP_MS = 5000;

/** What the install dialog names: the agent, its authors, its exact version, its license, its source, and the download or package. */
export interface InstallDetails { id: string; name: string; version: string; from: string | null; authors: string[]; license: string | null; source: string | null; download: string }

type Confirm = (details: InstallDetails) => Promise<unknown>;

const refuse = (code: string, message: string) => new LaunchError(code, message);
const agentFolder = (env: NodeJS.ProcessEnv, id: string) => path.join(agentsFolder(env), id);
const stagingFolder = (env: NodeJS.ProcessEnv) => path.join(agentsFolder(env), STAGING);

function checkedId(id: unknown): string {
  if (typeof id !== "string" || !ACP_ID_PATTERN.test(id)) throw refuse("action_unavailable", `${String(id)} is not the id of a registry agent.`);
  return id;
}

// ---- One install at a time on this machine ----

let busyHere = false;

/** Runs action while this process holds the machine's one install slot, or refuses with install_running while another holds it. */
async function withInstallSlot<T>(env: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
  const running = () => refuse("install_running", "Another install, update, or removal of a coding agent is running on this computer; try again once it ends.");
  // Taken before any await, so two requests of this process never both pass.
  if (busyHere) throw running();
  busyHere = true;
  const file = path.join(agentsFolder(env), LOCK_FILE);
  let taken = false;
  try {
    await mkdir(agentsFolder(env), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2 && !taken; attempt += 1) {
      try {
        await writeFile(file, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
        taken = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        // A lock whose process ended belongs to no install.
        const holder = await readFile(file, "utf8").then((text) => JSON.parse(text), () => null);
        if (holder && processAlive(holder.pid)) throw running();
        await rm(file, { force: true });
      }
    }
    if (!taken) throw running();
    // A staging folder left by an install that ended without removing it holds nothing of use.
    await rm(stagingFolder(env), { recursive: true, force: true });
    return await action();
  } finally {
    if (taken) {
      await rm(stagingFolder(env), { recursive: true, force: true }).catch(() => {});
      await rm(file, { force: true }).catch(() => {});
    }
    busyHere = false;
  }
}

// ---- Sessions on an agent ----

/** Whether a launched session of this machine runs on the agent now. */
export async function agentRunning(id: string, env: NodeJS.ProcessEnv = process.env) {
  const host = `${ACP_HOST_PREFIX}${id}`;
  return (await listLaunchRecords(env)).some(({ record }) => record?.host === host && launchRunning(record));
}

const currentVersion = async (env: NodeJS.ProcessEnv, id: string) => {
  const value = await readFile(path.join(agentFolder(env, id), "current.json"), "utf8").then((text) => JSON.parse(text), () => null);
  return typeof value?.version === "string" && VERSION_FOLDER.test(value.version) ? value.version : null;
};

const sweeping = new Map<string, NodeJS.Timeout>();

/** Removes every version folder of the agent but the current one once no launched session runs on the agent, checking again until then. */
async function removeEarlierVersions(env: NodeJS.ProcessEnv, id: string) {
  const sweep = async () => {
    if (await agentRunning(id, env)) return false;
    const current = await currentVersion(env, id);
    if (current === null) return true;
    const folder = agentFolder(env, id);
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== current) await rm(path.join(folder, entry.name), { recursive: true, force: true });
    }
    return true;
  };
  clearInterval(sweeping.get(id));
  sweeping.delete(id);
  if (await sweep()) return;
  const timer = setInterval(() => {
    sweep().then((done) => {
      if (done && sweeping.get(id) === timer) { clearInterval(timer); sweeping.delete(id); }
    }, () => {});
  }, SWEEP_MS);
  timer.unref();
  sweeping.set(id, timer);
}

// ---- Package programs ----

/** Runs an install program without a shell in cwd, refusing with install_failed and the last line it wrote when it fails. */
async function runTool(tool: "npm" | "uv", args: string[], { cwd, env, agent }: { cwd: string; env: NodeJS.ProcessEnv; agent: string }) {
  const resolved = await resolveDefinition({ host: tool, label: tool, executable: tool }, env);
  if (!resolved.available || !resolved.command) throw refuse("install_failed", `${tool} is not on PATH, and Prism installs ${agent} with it.`);
  const outcome = await new Promise<{ code: number | null; stderr: string; error: string | null }>((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(resolved.command!, [...resolved.prefix, ...args], { cwd, env, shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error: any) {
      resolve({ code: null, stderr, error: error?.message ?? "it could not be started" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stderr, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr, error: null }); });
  });
  if (outcome.code === 0) return;
  const line = outcome.error ?? outcome.stderr.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? `it exited with ${outcome.code}`;
  throw refuse("install_failed", `${tool} ${args.slice(0, 2).join(" ")} failed for ${agent}: ${line.slice(0, 300)}`);
}

// The environment of an install program: the review server's, with the package programs' caches inside the staging folder and every
// install script turned off as well as by the program's own flags.
function toolEnvironment(env: NodeJS.ProcessEnv, staging: string): NodeJS.ProcessEnv {
  return {
    ...env,
    npm_config_cache: path.join(staging, "npm-cache"),
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    UV_CACHE_DIR: path.join(staging, "uv-cache"),
    UV_NO_BUILD: "1",
    // uv uses only a Python already on the computer and never downloads one of its own outside agents/.
    UV_PYTHON_DOWNLOADS: "never"
  };
}

// ---- Downloads ----

/** Downloads url into file under the URL rule for every redirect, at most 1 GiB, and answers its SHA-256 in lowercase hexadecimal. */
async function download(url: string, file: string, agent: string) {
  let location = url;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = downloadUrlRefusal(location);
    if (refusal) throw refuse("install_failed", refusal);
    let response: Response;
    try {
      response = await fetch(location, { redirect: "manual", signal });
    } catch (error: any) {
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: ${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "the request failed"}.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => {});
      location = new URL(response.headers.get("location")!, location).toString();
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: it answered HTTP ${response.status}.`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const counted = Readable.fromWeb(response.body as any).map((chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw refuse("install_failed", `The download of ${agent} is larger than 1 GiB.`);
      hash.update(chunk);
      return chunk;
    });
    try {
      await pipeline(counted, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    } catch (error: any) {
      if (error instanceof LaunchError) throw error;
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: ${error?.message ?? "the download was cut off"}.`);
    }
    return hash.digest("hex");
  }
  throw refuse("install_failed", `The download of ${agent} redirects more than ${MAX_REDIRECTS} times.`);
}

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// ---- Installing one version ----

interface Prepared { details: InstallDetails; install: (folder: string) => Promise<{ command: string; args: string[]; env: Record<string, string> }> }

/** Resolves what an install needs before the dialog, running no code of the download, and answers how to install it after the dialog. */
async function prepare(agent: RegistryAgent, from: string | null, env: NodeJS.ProcessEnv, staging: string): Promise<Prepared> {
  const { distribution } = agent;
  const toolEnv = toolEnvironment(env, staging);
  const label = `${agent.name} ${agent.version}`;
  const base = { id: agent.id, name: agent.name, version: agent.version, from, authors: agent.authors, license: agent.license, source: agent.source };
  if (distribution.kind === "binary") {
    return {
      details: { ...base, download: distribution.archive },
      install: async (folder) => {
        const archive = path.join(staging, "download");
        const found = await download(distribution.archive, archive, label);
        const expected = distribution.sha256!.toLowerCase();
        if (found !== expected) {
          throw refuse("install_mismatch", `The download of ${label} has the SHA-256 checksum ${found}, but the registry lists ${expected}, so Prism installed nothing.`);
        }
        const name = new URL(distribution.archive).pathname.toLowerCase();
        try {
          if (name.endsWith(".zip")) await extractZip(archive, folder);
          else await extractTarGz(archive, folder);
        } catch (error) {
          if (error instanceof ArchiveError) throw refuse("install_refused", `Prism did not install ${label}: ${error.message}`);
          throw error;
        }
        await rm(archive, { force: true });
        const command = path.resolve(folder, distribution.cmd);
        const info = inside(folder, command) ? await lstat(command).catch(() => null) : null;
        if (!info?.isFile()) throw refuse("install_refused", `Prism did not install ${label}: its archive holds no program ${distribution.cmd}.`);
        return { command, args: distribution.args, env: distribution.env };
      }
    };
  }
  if (distribution.kind === "npx") {
    const spec = npxPackage(distribution.package)!;
    const project = path.join(staging, "npm");
    await mkdir(project, { recursive: true });
    const manifest = `${JSON.stringify({ name: "prism-agent-install", version: "0.0.0", private: true, dependencies: { [spec.name]: spec.version } }, null, 2)}\n`;
    await writeFile(path.join(project, "package.json"), manifest);
    // Only the lockfile is resolved before the dialog: npm reads the registry's metadata and runs nothing.
    await runTool("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, env: toolEnv, agent: label });
    if (!existsSync(path.join(project, "package-lock.json"))) throw refuse("install_failed", `npm wrote no package-lock.json for ${label}.`);
    return {
      details: { ...base, download: `the npm package ${spec.name}@${spec.version} and the dependencies its lockfile names` },
      install: async (folder) => {
        await copyFile(path.join(project, "package.json"), path.join(folder, "package.json"), constants.COPYFILE_EXCL);
        await copyFile(path.join(project, "package-lock.json"), path.join(folder, "package-lock.json"), constants.COPYFILE_EXCL);
        await runTool("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: folder, env: toolEnv, agent: label });
        const packageFolder = path.join(folder, "node_modules", ...spec.name.split("/"));
        const installed = await readFile(path.join(packageFolder, "package.json"), "utf8").then((text) => JSON.parse(text), () => null);
        const found = typeof installed?.version === "string" ? installed.version : "none";
        if (found !== spec.version) throw refuse("install_mismatch", `npm installed ${spec.name} ${found}, but the registry lists ${spec.version}, so Prism installed nothing.`);
        const bins = typeof installed.bin === "string" ? { [spec.name.split("/").at(-1)!]: installed.bin } : installed.bin && typeof installed.bin === "object" ? installed.bin : {};
        const names = Object.keys(bins).filter((key) => typeof bins[key] === "string");
        const chosen = names.length === 1 ? names[0] : names.find((key) => key === spec.name.split("/").at(-1));
        if (!chosen) throw refuse("install_refused", `Prism did not install ${label}: its package names no single program to run.`);
        const command = path.resolve(packageFolder, bins[chosen]);
        if (!inside(packageFolder, command) || !(await lstat(command).catch(() => null))?.isFile()) throw refuse("install_refused", `Prism did not install ${label}: its program ${bins[chosen]} is not in its package.`);
        return { command, args: distribution.args, env: distribution.env };
      }
    };
  }
  const spec = uvxPackage(distribution.package)!;
  const project = path.join(staging, "uv");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "requirements.in"), `${distribution.package}\n`);
  // Only the locked requirements are resolved before the dialog, from wheels alone, so no build backend runs.
  await runTool("uv", ["pip", "compile", "requirements.in", "-o", "requirements.txt", "--generate-hashes", "--no-build"], { cwd: project, env: toolEnv, agent: label });
  if (!existsSync(path.join(project, "requirements.txt"))) throw refuse("install_failed", `uv wrote no locked requirements for ${label}.`);
  const locked = lockedVersions(await readFile(path.join(project, "requirements.txt"), "utf8"), spec.name);
  if (!locked.includes(spec.version)) {
    throw refuse("install_mismatch", `uv locked ${spec.name} ${locked.join(", ") || "at no version"}, but the registry lists ${spec.version}, so Prism installed nothing.`);
  }
  return {
    details: { ...base, download: `the Python package ${distribution.package} and the requirements it locks` },
    install: async (folder) => {
      await copyFile(path.join(project, "requirements.txt"), path.join(folder, "requirements.txt"), constants.COPYFILE_EXCL);
      const venv = path.join(folder, "venv");
      await runTool("uv", ["venv", venv], { cwd: folder, env: toolEnv, agent: label });
      const scripts = process.platform === "win32" ? path.join(venv, "Scripts") : path.join(venv, "bin");
      const python = path.join(scripts, process.platform === "win32" ? "python.exe" : "python");
      await runTool("uv", ["pip", "sync", "requirements.txt", "--python", python, "--no-build", "--require-hashes"], { cwd: folder, env: toolEnv, agent: label });
      const command = path.join(scripts, process.platform === "win32" ? `${spec.name}.exe` : spec.name);
      if (!(await lstat(command).catch(() => null))?.isFile()) throw refuse("install_failed", `Prism did not install ${agent.name}: its virtual environment holds no program ${spec.name}.`);
      return { command, args: distribution.args, env: distribution.env };
    }
  };
}

// A Python package name as Python compares it: letter case and each run of -, _, and . alike.
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The versions that the locked requirements pin with == for the package, in lock order. */
function lockedVersions(text: string, name: string) {
  const wanted = pythonName(name);
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;\\]+)/.exec(line.trim());
    return match && pythonName(match[1]) === wanted ? [match[2]] : [];
  });
}

// Installs the registry's version of the agent beside any installed one, then makes it current; a failure removes what it laid out.
async function installVersion({ id, env, confirm, update }: { id: string; env: NodeJS.ProcessEnv; confirm: Confirm; update: boolean }) {
  const installed = await currentVersion(env, id);
  if (update && installed === null) throw refuse("action_unavailable", `${id} is not installed, so there is nothing to update.`);
  if (!update && installed !== null) throw refuse("action_unavailable", `${id} ${installed} is already installed.`);
  // The registry is read again rather than from the kept read, so the version installed is the one it lists now.
  const registry = await readRegistry({ env, fresh: true });
  if (registry.state !== "ready") throw refuse("action_unavailable", registry.reason ?? "Prism cannot read the agent registry.");
  const agent = registry.agents.find((item) => item.id === id);
  if (!agent) throw refuse("action_unavailable", `The agent registry lists no agent ${id} for this computer.`);
  if (!agent.install.available) throw refuse("action_unavailable", agent.install.reason!);
  if (!VERSION_FOLDER.test(agent.version)) throw refuse("action_unavailable", `The registry's version ${agent.version} of ${agent.name} cannot name a folder.`);
  if (update && agent.version === installed) throw refuse("action_unavailable", `${agent.name} ${installed} is the version the registry lists.`);
  const staging = stagingFolder(env);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const prepared = await prepare(agent, update ? installed : null, env, staging);
  await confirm(prepared.details);
  const folder = agentFolder(env, id);
  const versionFolder = path.join(folder, agent.version);
  const createdAgentFolder = !existsSync(folder);
  try {
    await mkdir(folder, { recursive: true, mode: 0o755 });
    await rm(versionFolder, { recursive: true, force: true });
    await mkdir(versionFolder, { mode: 0o755 });
    const launch = await prepared.install(versionFolder);
    const rule = launchRule(launch);
    if (rule) throw refuse("install_failed", `Prism did not install ${agent.name} ${agent.version}: the registry's command, arguments, or environment break a rule: ${rule}`);
    const record = {
      id,
      name: agent.name,
      version: agent.version,
      authors: agent.authors,
      license: agent.license,
      source: agent.source,
      description: agent.description,
      distribution: agent.distribution.kind,
      entry: agent.entry,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      installedAt: new Date().toISOString()
    };
    // Prism's own record replaces anything the archive placed at its name, and its write follows no link: wx never opens an existing name.
    const recordFile = path.join(versionFolder, "install.json");
    await rm(recordFile, { recursive: true, force: true });
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    // Only now does the new version become current, so a failed update keeps the earlier one in use.
    await writeAtomically(path.join(folder, "current.json"), `${JSON.stringify({ version: agent.version }, null, 2)}\n`, { mode: 0o644 });
    return { id, name: agent.name, version: agent.version, from: update ? installed : null };
  } catch (error) {
    await rm(versionFolder, { recursive: true, force: true }).catch(() => {});
    if (createdAgentFolder) await rmdir(folder).catch(() => {});
    throw error;
  }
}

/** Installs the version of a registry agent that the registry lists now, after the person confirmed it in confirm's native dialog. */
export async function installAgent({ id, env = process.env, confirm }: { id: string; env?: NodeJS.ProcessEnv; confirm: Confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, () => installVersion({ id: agent, env, confirm, update: false }));
}

/**
 * Installs the registry's newer version of an installed agent after the person confirmed it, makes it current once it installed, and
 * removes the earlier version's folder once no launched session runs on the agent.
 */
export async function updateAgent({ id, env = process.env, confirm }: { id: string; env?: NodeJS.ProcessEnv; confirm: Confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, async () => {
    const updated = await installVersion({ id: agent, env, confirm, update: true });
    await removeEarlierVersions(env, agent);
    return updated;
  });
}

/** Removes every folder of an installed agent while no launched session runs on it, reading nothing from the registry. */
export async function removeAgent({ id, env = process.env }: { id: string; env?: NodeJS.ProcessEnv }) {
  const agent = checkedId(id);
  return withInstallSlot(env, async () => {
    const folder = agentFolder(env, agent);
    if (!existsSync(folder)) throw refuse("action_unavailable", `${agent} is not installed.`);
    const label = readInstalls(env).find((item) => item.id === agent)?.label ?? agent;
    if (await agentRunning(agent, env)) throw refuse("agent_running", `${label} runs in a launched session on this computer; stop that session before you remove it.`);
    clearInterval(sweeping.get(agent));
    sweeping.delete(agent);
    await rm(folder, { recursive: true, force: true });
    return { id: agent, name: label };
  });
}
