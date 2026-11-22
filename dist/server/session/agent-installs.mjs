// Generated from src/server/session/agent-installs.mts by scripts/native-build/compile.mjs.
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
import { downloadUrlRefusal, npxPackage, readRegistry, uvxPackage } from "./acp-registry.mjs";
import { ArchiveError, extractTarGz, extractZip } from "./archive-extract.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";
import { LaunchError, launchRunInUse, launchStarting, listLaunchRecords, processAlive } from "./launch-records.mjs";
const LOCK_FILE = ".install.lock";
const STAGING = ".staging";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
const TOOL_TIMEOUT_MS = 15 * 60 * 1e3;
const MAX_REDIRECTS = 5;
const STDERR_TAIL = 16 * 1024;
const VERSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const SWEEP_WAIT_MS = 5e3;
const SWEEP_POLL_MS = 50;
const refuse = (code, message) => new LaunchError(code, message);
const agentFolder = (env, id) => path.join(agentsFolder(env), id);
const stagingRoot = (env) => path.join(agentsFolder(env), STAGING);
function checkedId(id) {
  if (typeof id !== "string" || !ACP_ID_PATTERN.test(id)) throw refuse("action_unavailable", `${String(id)} is not the id of a registry agent.`);
  return id;
}
let busyHere = false;
const LOCK_REFRESH_MS = 60 * 1e3;
const LOCK_STALE_MS = 10 * 60 * 1e3;
const LOCK_MAX_MS = 24 * 60 * 60 * 1e3;
const GUARD_STALE_MS = 60 * 1e3;
const lockFile = (env) => path.join(agentsFolder(env), LOCK_FILE);
const ownName = () => `${process.pid}-${randomBytes(8).toString("hex")}`;
async function createExclusive(file, text) {
  const temporary = `${file}.${ownName()}.tmp`;
  await writeFile(temporary, text, { flag: "wx", mode: 384 });
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP", "EXDEV"].includes(error?.code)) throw error;
    try {
      await writeFile(file, text, { flag: "wx", mode: 384 });
      return true;
    } catch (again) {
      if (again?.code === "EEXIST") return false;
      throw again;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {
    });
  }
}
async function readLock(file) {
  const info = await lstat(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  let holder = null;
  try {
    holder = text === null ? null : JSON.parse(text);
  } catch {
    holder = null;
  }
  return { ino: info.ino, ageMs: Date.now() - info.mtimeMs, text, holder };
}
function lockStale(lock) {
  const { holder, ageMs } = lock;
  const ours = holder && holder.host === os.hostname() && Number.isSafeInteger(holder.pid);
  if (ours) return !processAlive(holder.pid) || ageMs > LOCK_MAX_MS;
  return ageMs > LOCK_STALE_MS;
}
async function breakStaleLock(file, seen) {
  const guard = `${file}.break`;
  if (!await createExclusive(guard, `${JSON.stringify({ pid: process.pid, host: os.hostname() })}
`)) {
    const left = await lstat(guard).catch(() => null);
    if (left && Date.now() - left.mtimeMs > GUARD_STALE_MS) await rm(guard, { force: true });
    return;
  }
  try {
    const now = await readLock(file);
    if (now && now.ino === seen.ino && now.text === seen.text && lockStale(now)) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true }).catch(() => {
    });
  }
}
async function removeLeftStaging(env) {
  const entries = await readdir(stagingRoot(env), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const pid = Number(/^(\d+)-[0-9a-f]{16}$/.exec(entry.name)?.[1]);
    if (entry.isDirectory() && processAlive(pid)) continue;
    await rm(path.join(stagingRoot(env), entry.name), { recursive: true, force: true }).catch(() => {
    });
  }
}
async function withInstallSlot(env, action, { sweep = false } = {}) {
  const running = () => refuse("install_running", "Another install, update, or removal of a coding agent is running on this computer; try again once it ends.");
  if (busyHere) throw running();
  busyHere = true;
  const file = lockFile(env);
  const text = `${JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomBytes(16).toString("hex"), startedAt: (/* @__PURE__ */ new Date()).toISOString(), ...sweep ? { purpose: "sweep" } : {} })}
`;
  let taken = false;
  let refresh;
  const staging = path.join(stagingRoot(env), ownName());
  const waitUntil = Date.now() + SWEEP_WAIT_MS;
  try {
    await mkdir(agentsFolder(env), { recursive: true, mode: 448 });
    for (let attempt = 0; attempt < 5 && !taken; attempt += 1) {
      if (await createExclusive(file, text)) {
        taken = true;
        break;
      }
      const lock = await readLock(file);
      if (lock === null) continue;
      if (!lockStale(lock)) {
        if (sweep || lock.holder?.purpose !== "sweep" || Date.now() > waitUntil) throw running();
        await new Promise((done) => setTimeout(done, SWEEP_POLL_MS));
        attempt -= 1;
        continue;
      }
      await breakStaleLock(file, lock);
    }
    if (!taken) throw running();
    refresh = setInterval(() => {
      const at = /* @__PURE__ */ new Date();
      utimes(file, at, at).catch(() => {
      });
    }, LOCK_REFRESH_MS);
    refresh.unref();
    await removeLeftStaging(env);
    if (!sweep) await mkdir(staging, { recursive: true, mode: 448 });
    return await action(staging);
  } finally {
    clearInterval(refresh);
    if (taken) {
      if (!sweep) await rm(staging, { recursive: true, force: true }).catch(() => {
      });
      await rmdir(stagingRoot(env)).catch(() => {
      });
      const lock = await readLock(file).catch(() => null);
      if (lock?.text === text) await rm(file, { force: true }).catch(() => {
      });
    }
    busyHere = false;
  }
}
const runningOn = async (env, id) => {
  const host = `${ACP_HOST_PREFIX}${id}`;
  const now = Date.now();
  return (await listLaunchRecords(env)).filter(({ record }) => record?.host === host && (launchRunInUse(record, now) || launchStarting(record, now))).map(({ record }) => record);
};
async function agentRunning(id, env = process.env) {
  return (await runningOn(env, id)).length > 0;
}
async function versionsInUse(id, env = process.env) {
  const used = /* @__PURE__ */ new Set();
  for (const record of await runningOn(env, id)) {
    if (launchStarting(record)) return null;
    const version = record.runs.at(-1)?.agentVersion;
    if (typeof version !== "string" || !VERSION_FOLDER.test(version)) return null;
    used.add(version.toLowerCase());
  }
  return used;
}
const currentVersion = async (env, id) => {
  const value = await readFile(path.join(agentFolder(env, id), "current.json"), "utf8").then((text) => JSON.parse(text), () => null);
  return typeof value?.version === "string" && VERSION_FOLDER.test(value.version) ? value.version : null;
};
async function earlierFolders(env, id) {
  const current = await currentVersion(env, id);
  if (current === null) return [];
  const entries = await readdir(agentFolder(env, id), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && entry.name !== current).map((entry) => entry.name);
}
async function sweepAgent(env, id) {
  const earlier = await earlierFolders(env, id);
  if (earlier.length === 0) return;
  const used = await versionsInUse(id, env);
  if (used === null) return;
  for (const name of earlier) {
    if (!used.has(name.toLowerCase())) await rm(path.join(agentFolder(env, id), name), { recursive: true, force: true });
  }
}
async function sweepUnusedVersions(env = process.env, ids = null) {
  try {
    const names = ids ?? (await readdir(agentsFolder(env), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && ACP_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
    const pending = [];
    for (const id of names) if (ACP_ID_PATTERN.test(id) && (await earlierFolders(env, id)).length > 0) pending.push(id);
    if (pending.length === 0 || busyHere) return;
    await withInstallSlot(env, async () => {
      for (const id of pending) await sweepAgent(env, id);
    }, { sweep: true });
  } catch {
  }
}
async function runTool(tool, args, { cwd, env, agent }) {
  const resolved = await resolveDefinition({ host: tool, label: tool, executable: tool }, env);
  if (!resolved.available || !resolved.command) throw refuse("install_failed", `${tool} is not on PATH, and Prism installs ${agent} with it.`);
  const outcome = await new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd, env, shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stderr, error: error?.message ?? "it could not be started" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, error: null });
    });
  });
  if (outcome.code === 0) return;
  const line = outcome.error ?? outcome.stderr.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? `it exited with ${outcome.code}`;
  throw refuse("install_failed", `${tool} ${args.slice(0, 2).join(" ")} failed for ${agent}: ${line.slice(0, 300)}`);
}
function toolEnvironment(env, staging) {
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
async function download(url, file, agent) {
  let location = url;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = downloadUrlRefusal(location);
    if (refusal) throw refuse("install_failed", refusal);
    let response;
    try {
      response = await fetch(location, { redirect: "manual", signal });
    } catch (error) {
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: ${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "the request failed"}.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => {
      });
      location = new URL(response.headers.get("location"), location).toString();
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {
      });
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: it answered HTTP ${response.status}.`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const counted = Readable.fromWeb(response.body).map((chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw refuse("install_failed", `The download of ${agent} is larger than 1 GiB.`);
      hash.update(chunk);
      return chunk;
    });
    try {
      await pipeline(counted, createWriteStream(file, { flags: "wx", mode: 384 }));
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw refuse("install_failed", `Prism could not download ${agent} from ${location}: ${error?.message ?? "the download was cut off"}.`);
    }
    return hash.digest("hex");
  }
  throw refuse("install_failed", `The download of ${agent} redirects more than ${MAX_REDIRECTS} times.`);
}
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
async function prepare(agent, from, env, staging) {
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
        const expected = distribution.sha256.toLowerCase();
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
    const spec2 = npxPackage(distribution.package);
    const project2 = path.join(staging, "npm");
    await mkdir(project2, { recursive: true });
    const manifest = `${JSON.stringify({ name: "prism-agent-install", version: "0.0.0", private: true, dependencies: { [spec2.name]: spec2.version } }, null, 2)}
`;
    await writeFile(path.join(project2, "package.json"), manifest);
    await runTool("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project2, env: toolEnv, agent: label });
    if (!existsSync(path.join(project2, "package-lock.json"))) throw refuse("install_failed", `npm wrote no package-lock.json for ${label}.`);
    return {
      details: { ...base, download: `the npm package ${spec2.name}@${spec2.version} and the dependencies its lockfile names` },
      install: async (folder) => {
        await copyFile(path.join(project2, "package.json"), path.join(folder, "package.json"), constants.COPYFILE_EXCL);
        await copyFile(path.join(project2, "package-lock.json"), path.join(folder, "package-lock.json"), constants.COPYFILE_EXCL);
        await runTool("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: folder, env: toolEnv, agent: label });
        const packageFolder = path.join(folder, "node_modules", ...spec2.name.split("/"));
        const installed = await readFile(path.join(packageFolder, "package.json"), "utf8").then((text) => JSON.parse(text), () => null);
        const found = typeof installed?.version === "string" ? installed.version : "none";
        if (found !== spec2.version) throw refuse("install_mismatch", `npm installed ${spec2.name} ${found}, but the registry lists ${spec2.version}, so Prism installed nothing.`);
        const bins = typeof installed.bin === "string" ? { [spec2.name.split("/").at(-1)]: installed.bin } : installed.bin && typeof installed.bin === "object" ? installed.bin : {};
        const names = Object.keys(bins).filter((key) => typeof bins[key] === "string");
        const chosen = names.length === 1 ? names[0] : names.find((key) => key === spec2.name.split("/").at(-1));
        if (!chosen) throw refuse("install_refused", `Prism did not install ${label}: its package names no single program to run.`);
        const command = path.resolve(packageFolder, bins[chosen]);
        if (!inside(packageFolder, command) || !(await lstat(command).catch(() => null))?.isFile()) throw refuse("install_refused", `Prism did not install ${label}: its program ${bins[chosen]} is not in its package.`);
        return { command, args: distribution.args, env: distribution.env };
      }
    };
  }
  const spec = uvxPackage(distribution.package);
  const project = path.join(staging, "uv");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "requirements.in"), `${distribution.package}
`);
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
const pythonName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
function lockedVersions(text, name) {
  const wanted = pythonName(name);
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;\\]+)/.exec(line.trim());
    return match && pythonName(match[1]) === wanted ? [match[2]] : [];
  });
}
async function versionFolderOf(folder, version) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === version.toLowerCase())?.name ?? null;
}
async function installVersion({ id, env, confirm, update, staging }) {
  const installed = await currentVersion(env, id);
  if (update && installed === null) throw refuse("action_unavailable", `${id} is not installed, so there is nothing to update.`);
  if (!update && installed !== null) throw refuse("action_unavailable", `${id} ${installed} is already installed.`);
  const registry = await readRegistry({ env, fresh: true });
  if (registry.state !== "ready") throw refuse("action_unavailable", registry.reason ?? "Prism cannot read the agent registry.");
  const agent = registry.agents.find((item) => item.id === id);
  if (!agent) throw refuse("action_unavailable", `The agent registry lists no agent ${id} for this computer.`);
  if (!agent.install.available) throw refuse("action_unavailable", agent.install.reason);
  if (!VERSION_FOLDER.test(agent.version)) throw refuse("action_unavailable", `The registry's version ${agent.version} of ${agent.name} cannot name a folder.`);
  if (update && agent.version.toLowerCase() === installed.toLowerCase()) throw refuse("action_unavailable", `${agent.name} ${installed} is the version the registry lists.`);
  const folder = agentFolder(env, id);
  const inUse = async () => {
    const left2 = await versionFolderOf(folder, agent.version);
    if (left2 === null) return false;
    const used = await versionsInUse(id, env);
    return used === null || used.has(left2.toLowerCase());
  };
  const busy = () => refuse("agent_running", `${agent.name} ${agent.version} is still in use by a launched session on this computer; stop that session before you install this version again.`);
  if (await inUse()) throw busy();
  const prepared = await prepare(agent, update ? installed : null, env, staging);
  await confirm(prepared.details);
  const laid = path.join(staging, "version");
  await mkdir(laid, { mode: 493 });
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
    installedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const recordFile = path.join(laid, "install.json");
  await rm(recordFile, { recursive: true, force: true });
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}
`, { mode: 420, flag: "wx" });
  if (await inUse()) throw busy();
  const createdAgentFolder = !existsSync(folder);
  await mkdir(folder, { recursive: true, mode: 493 });
  const left = await versionFolderOf(folder, agent.version);
  const aside = path.join(staging, "replaced");
  let moved = false;
  try {
    if (left !== null) await rename(path.join(folder, left), aside);
    await rename(laid, versionFolder);
    moved = true;
    await writeAtomically(path.join(folder, "current.json"), `${JSON.stringify({ version: agent.version }, null, 2)}
`, { mode: 420 });
  } catch (error) {
    if (moved) await rename(versionFolder, laid).catch(() => {
    });
    if (left !== null && existsSync(aside)) await rename(aside, path.join(folder, left)).catch(() => {
    });
    if (createdAgentFolder) await rmdir(folder).catch(() => {
    });
    throw error;
  }
  return { id, name: agent.name, version: agent.version, from: update ? installed : null };
}
async function installAgent({ id, env = process.env, confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, (staging) => installVersion({ id: agent, env, confirm, update: false, staging }));
}
async function updateAgent({ id, env = process.env, confirm }) {
  const agent = checkedId(id);
  return withInstallSlot(env, async (staging) => {
    const updated = await installVersion({ id: agent, env, confirm, update: true, staging });
    await sweepAgent(env, agent);
    return updated;
  });
}
async function removeAgent({ id, env = process.env }) {
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
export {
  agentRunning,
  installAgent,
  removeAgent,
  sweepUnusedVersions,
  updateAgent,
  versionsInUse
};
