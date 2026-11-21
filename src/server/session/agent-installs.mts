import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream, existsSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { ACP_HOST_PREFIX, ACP_ID_PATTERN, agentsFolder, launchRule, readInstalls } from "./acp-agents.mjs";
import { downloadUrlRefusal, npxPackage, readRegistry, uvxPackage, type RegistryAgent } from "./acp-registry.mjs";
import { ArchiveError, extractTarGz, extractZip } from "./archive-extract.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";
import { LaunchError, launchRunInUse, launchStarting, listLaunchRecords, processAlive } from "./launch-records.mjs";

// Installing, updating, and removing registry agents in the review app folder's agents/ folder, one at a time on this machine.
// Nothing of a download runs before the person confirms it in a native dialog, no install, build, or lifecycle script runs at any time,
// every download is checked against the registry, and an install changes nothing outside agents/: each version lives in
// agents/<id>/<version>/ beside its install.json, agents/<id>/current.json names the version that new runs use, and each install lays out
// its downloads, the package programs' caches, and the new version in a staging folder of its own under agents/.staging/, which it removes
// when it ends, moving the version into place only after every check passed.

const LOCK_FILE = ".install.lock";
const STAGING = ".staging";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REDIRECTS = 5;
const STDERR_TAIL = 16 * 1024;
const VERSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
// An installer that finds a sweep of unused versions holding the install slot waits this long for it, since a sweep only removes folders.
const SWEEP_WAIT_MS = 5000;
const SWEEP_POLL_MS = 50;

/** What the install dialog names: the agent, its authors, its exact version, its license, its source, and the download or package. */
export interface InstallDetails { id: string; name: string; version: string; from: string | null; authors: string[]; license: string | null; source: string | null; download: string }

type Confirm = (details: InstallDetails) => Promise<unknown>;

const refuse = (code: string, message: string) => new LaunchError(code, message);
const agentFolder = (env: NodeJS.ProcessEnv, id: string) => path.join(agentsFolder(env), id);
const stagingRoot = (env: NodeJS.ProcessEnv) => path.join(agentsFolder(env), STAGING);

function checkedId(id: unknown): string {
  if (typeof id !== "string" || !ACP_ID_PATTERN.test(id)) throw refuse("action_unavailable", `${String(id)} is not the id of a registry agent.`);
  return id;
}

// ---- One install at a time on this machine ----

let busyHere = false;

// A lock is held while its holder could still be installing: a holder of this computer whose process runs, or any holder, also one whose
// lock is unreadable or still being written, whose lock was refreshed within LOCK_STALE_MS. A holder refreshes its lock every
// LOCK_REFRESH_MS, and a lock of this computer is never older than LOCK_MAX_MS, so a reused process id cannot keep a lock forever.
const LOCK_REFRESH_MS = 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;
// A stale lock is removed only by the one process that holds its breaking guard, which lives for a moment, so a guard older than this was
// left by a process that ended while it broke a lock.
const GUARD_STALE_MS = 60 * 1000;
const lockFile = (env: NodeJS.ProcessEnv) => path.join(agentsFolder(env), LOCK_FILE);
const ownName = () => `${process.pid}-${randomBytes(8).toString("hex")}`;

/** Creates file holding text, complete from its first moment, only when no file has that name, and answers whether it did. */
async function createExclusive(file: string, text: string) {
  const temporary = `${file}.${ownName()}.tmp`;
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, file);
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    // A file system without hard links takes the lock by an exclusive create, which a reader that finds it still empty treats as held.
    if (!["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP", "EXDEV"].includes(error?.code)) throw error;
    try {
      await writeFile(file, text, { flag: "wx", mode: 0o600 });
      return true;
    } catch (again: any) {
      if (again?.code === "EEXIST") return false;
      throw again;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** The lock at file as it stands, or null when there is none: its identity, its age, and its holder when it reads as a whole record. */
async function readLock(file: string) {
  const info = await lstat(file).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (!info) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  let holder: any = null;
  try { holder = text === null ? null : JSON.parse(text); } catch { holder = null; }
  return { ino: info.ino, ageMs: Date.now() - info.mtimeMs, text, holder };
}

/** Whether the lock's holder is provably gone, so the lock belongs to no install. */
function lockStale(lock: NonNullable<Awaited<ReturnType<typeof readLock>>>) {
  const { holder, ageMs } = lock;
  const ours = holder && holder.host === os.hostname() && Number.isSafeInteger(holder.pid);
  if (ours) return !processAlive(holder.pid) || ageMs > LOCK_MAX_MS;
  return ageMs > LOCK_STALE_MS;
}

/** Removes the stale lock that was read, under the breaking guard, after checking again that the same lock still stands and is stale. */
async function breakStaleLock(file: string, seen: NonNullable<Awaited<ReturnType<typeof readLock>>>) {
  const guard = `${file}.break`;
  if (!(await createExclusive(guard, `${JSON.stringify({ pid: process.pid, host: os.hostname() })}\n`))) {
    const left = await lstat(guard).catch(() => null);
    if (left && Date.now() - left.mtimeMs > GUARD_STALE_MS) await rm(guard, { force: true });
    return;
  }
  try {
    const now = await readLock(file);
    if (now && now.ino === seen.ino && now.text === seen.text && lockStale(now)) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true }).catch(() => {});
  }
}

/** Removes what crashed installs left in the staging folder, keeping every staging folder whose process still runs. */
async function removeLeftStaging(env: NodeJS.ProcessEnv) {
  const entries = await readdir(stagingRoot(env), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const pid = Number(/^(\d+)-[0-9a-f]{16}$/.exec(entry.name)?.[1]);
    if (entry.isDirectory() && processAlive(pid)) continue;
    await rm(path.join(stagingRoot(env), entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs action with a staging folder of its own while this process holds the machine's one install slot, or refuses with install_running
 * while another holds it.
 */
async function withInstallSlot<T>(env: NodeJS.ProcessEnv, action: (staging: string) => Promise<T>, { sweep = false } = {}): Promise<T> {
  const running = () => refuse("install_running", "Another install, update, or removal of a coding agent is running on this computer; try again once it ends.");
  // Taken before any await, so two requests of this process never both pass.
  if (busyHere) throw running();
  busyHere = true;
  const file = lockFile(env);
  const text = `${JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomBytes(16).toString("hex"), startedAt: new Date().toISOString(), ...(sweep ? { purpose: "sweep" } : {}) })}\n`;
  let taken = false;
  let refresh: NodeJS.Timeout | undefined;
  const staging = path.join(stagingRoot(env), ownName());
  const waitUntil = Date.now() + SWEEP_WAIT_MS;
  try {
    await mkdir(agentsFolder(env), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 5 && !taken; attempt += 1) {
      if (await createExclusive(file, text)) { taken = true; break; }
      const lock = await readLock(file);
      // A lock that its holder released since is gone, and a lock that cannot be read whole is being written or held.
      if (lock === null) continue;
      if (!lockStale(lock)) {
        // A sweep of unused versions ends within moments, so an install waits for it rather than being refused; a sweep never waits.
        if (sweep || lock.holder?.purpose !== "sweep" || Date.now() > waitUntil) throw running();
        await new Promise((done) => setTimeout(done, SWEEP_POLL_MS));
        attempt -= 1;
        continue;
      }
      await breakStaleLock(file, lock);
    }
    if (!taken) throw running();
    refresh = setInterval(() => { const at = new Date(); utimes(file, at, at).catch(() => {}); }, LOCK_REFRESH_MS);
    refresh.unref();
    await removeLeftStaging(env);
    if (!sweep) await mkdir(staging, { recursive: true, mode: 0o700 });
    return await action(staging);
  } finally {
    clearInterval(refresh);
    if (taken) {
      if (!sweep) await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rmdir(stagingRoot(env)).catch(() => {});
      // Only this process's own lock is removed, never one that another process took after a stale lock was broken.
      const lock = await readLock(file).catch(() => null);
      if (lock?.text === text) await rm(file, { force: true }).catch(() => {});
    }
    busyHere = false;
  }
}

// ---- Sessions on an agent ----

// The launches on the agent whose last run has not ended while its supervisor or host process lives, however late its heartbeat, or
// whose supervisor is starting a run, which has not yet recorded the version it starts on.
const runningOn = async (env: NodeJS.ProcessEnv, id: string) => {
  const host = `${ACP_HOST_PREFIX}${id}`;
  const now = Date.now();
  return (await listLaunchRecords(env)).filter(({ record }) => record?.host === host && (launchRunInUse(record, now) || launchStarting(record, now))).map(({ record }) => record);
};

/** Whether a launched session of this machine runs on the agent now, or is starting on it, on any version. */
export async function agentRunning(id: string, env: NodeJS.ProcessEnv = process.env) {
  return (await runningOn(env, id)).length > 0;
}

/**
 * The version folders of the agent, in lowercase, that the running launched sessions of this machine run on, as each run's record names
 * the version it started on, or null when a running session's run names none or a session is starting a run on the agent, since it
 * may start on any version, so that every version counts as in use.
 */
export async function versionsInUse(id: string, env: NodeJS.ProcessEnv = process.env): Promise<Set<string> | null> {
  const used = new Set<string>();
  for (const record of await runningOn(env, id)) {
    if (launchStarting(record)) return null;
    const version = record.runs.at(-1)?.agentVersion;
    if (typeof version !== "string" || !VERSION_FOLDER.test(version)) return null;
    used.add(version.toLowerCase());
  }
  return used;
}

const currentVersion = async (env: NodeJS.ProcessEnv, id: string) => {
  const value = await readFile(path.join(agentFolder(env, id), "current.json"), "utf8").then((text) => JSON.parse(text), () => null);
  return typeof value?.version === "string" && VERSION_FOLDER.test(value.version) ? value.version : null;
};

/** The version folders of the agent other than the current one, or none when no version is current. */
async function earlierFolders(env: NodeJS.ProcessEnv, id: string) {
  const current = await currentVersion(env, id);
  if (current === null) return [];
  const entries = await readdir(agentFolder(env, id), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && entry.name !== current).map((entry) => entry.name);
}

/** Removes every earlier version folder of the agent that no running launched session runs on; the caller holds the install slot. */
async function sweepAgent(env: NodeJS.ProcessEnv, id: string) {
  const earlier = await earlierFolders(env, id);
  if (earlier.length === 0) return;
  const used = await versionsInUse(id, env);
  if (used === null) return;
  for (const name of earlier) {
    if (!used.has(name.toLowerCase())) await rm(path.join(agentFolder(env, id), name), { recursive: true, force: true });
  }
}

/**
 * Removes the earlier version folders that no running launched session of this machine runs on, of the agents named or of every
 * installed agent, inside the install slot, so a sweep never removes a folder that an install is laying out. Any review server or
 * supervisor of this machine runs it, so an earlier version goes once its last session ends whichever process updated the agent;
 * it does nothing while an install holds the slot, or when nothing is left to remove, and never throws.
 */
export async function sweepUnusedVersions(env: NodeJS.ProcessEnv = process.env, ids: string[] | null = null) {
  try {
    const names = ids ?? (await readdir(agentsFolder(env), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && ACP_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
    const pending: string[] = [];
    for (const id of names) if (ACP_ID_PATTERN.test(id) && (await earlierFolders(env, id)).length > 0) pending.push(id);
    if (pending.length === 0 || busyHere) return;
    await withInstallSlot(env, async () => { for (const id of pending) await sweepAgent(env, id); }, { sweep: true });
  } catch {
    // A sweep that cannot run now runs again at the next launch end or periodic sweep.
  }
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
      // The environment is laid out in the staging folder and then moved into place, so its programs must not name its own path.
      await runTool("uv", ["venv", venv, "--relocatable"], { cwd: folder, env: toolEnv, agent: label });
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

// The version folder of the agent that names version, ignoring letter case, as a case-insensitive file system does, or null.
async function versionFolderOf(folder: string, version: string) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === version.toLowerCase())?.name ?? null;
}

// Installs the registry's version of the agent into a staging folder of this install, checks it, and only then moves it into place beside
// any installed version and makes it current; a failure leaves every existing version folder as it was.
async function installVersion({ id, env, confirm, update, staging }: { id: string; env: NodeJS.ProcessEnv; confirm: Confirm; update: boolean; staging: string }) {
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
  if (update && agent.version.toLowerCase() === installed!.toLowerCase()) throw refuse("action_unavailable", `${agent.name} ${installed} is the version the registry lists.`);
  const folder = agentFolder(env, id);
  // A folder of this version kept for a launched session that still runs on it is never replaced, so the update waits until it ends.
  const inUse = async () => {
    const left = await versionFolderOf(folder, agent.version);
    if (left === null) return false;
    const used = await versionsInUse(id, env);
    return used === null || used.has(left.toLowerCase());
  };
  const busy = () => refuse("agent_running", `${agent.name} ${agent.version} is still in use by a launched session on this computer; stop that session before you install this version again.`);
  if (await inUse()) throw busy();
  const prepared = await prepare(agent, update ? installed : null, env, staging);
  await confirm(prepared.details);
  const laid = path.join(staging, "version");
  await mkdir(laid, { mode: 0o755 });
  const launch = await prepared.install(laid);
  const versionFolder = path.join(folder, agent.version);
  const command = path.join(versionFolder, path.relative(laid, launch.command));
  const rule = launchRule({ ...launch, command });
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
    command,
    args: launch.args,
    env: launch.env,
    installedAt: new Date().toISOString()
  };
  // Prism's own record replaces anything the archive placed at its name, and its write follows no link: wx never opens an existing name.
  const recordFile = path.join(laid, "install.json");
  await rm(recordFile, { recursive: true, force: true });
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  // The checked version moves into place only now; a leftover folder of the same version, which no session runs on, moves aside first.
  if (await inUse()) throw busy();
  const createdAgentFolder = !existsSync(folder);
  await mkdir(folder, { recursive: true, mode: 0o755 });
  const left = await versionFolderOf(folder, agent.version);
  const aside = path.join(staging, "replaced");
  let moved = false;
  try {
    if (left !== null) await rename(path.join(folder, left), aside);
    await rename(laid, versionFolder);
    moved = true;
    // Only now does the new version become current, so a failed update keeps the earlier one in use.
    await writeAtomically(path.join(folder, "current.json"), `${JSON.stringify({ version: agent.version }, null, 2)}\n`, { mode: 0o644 });
  } catch (error) {
    if (moved) await rename(versionFolder, laid).catch(() => {});
    if (left !== null && existsSync(aside)) await rename(aside, path.join(folder, left)).catch(() => {});
    if (createdAgentFolder) await rmdir(folder).catch(() => {});
    throw error;
  }
  return { id, name: agent.name, version: agent.version, from: update ? installed : null };
}

/** Installs the version of a registry agent that the registry lists now, after the person confirmed it in confirm's native dialog. */
export async function installAgent({ id, env = process.env, confirm }: { id: string; env?: NodeJS.ProcessEnv; confirm: Confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, (staging) => installVersion({ id: agent, env, confirm, update: false, staging }));
}

/**
 * Installs the registry's newer version of an installed agent after the person confirmed it, makes it current once it installed, and
 * removes the earlier version's folder once no launched session runs on that version.
 */
export async function updateAgent({ id, env = process.env, confirm }: { id: string; env?: NodeJS.ProcessEnv; confirm: Confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, async (staging) => {
    const updated = await installVersion({ id: agent, env, confirm, update: true, staging });
    // An earlier version that a session still runs on stays; the sweep after that session's run ends removes it.
    await sweepAgent(env, agent);
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
    await rm(folder, { recursive: true, force: true });
    return { id: agent, name: label };
  });
}
