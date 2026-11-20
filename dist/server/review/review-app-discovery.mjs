// Generated from src/server/review/review-app-discovery.mts by scripts/native-build/compile.mjs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
const REVIEW_APP_PROTOCOL = 1;
const DISCOVERY_FILE = "review-app.json";
const PROJECTS_FILE = "review-app-projects.json";
const PORT_FILE = "review-app-port.json";
const LOCK_BASE = "review-app";
const FALLBACK_LOG = "fallbacks.log";
const FALLBACK_LOG_BYTES = 256 * 1024;
function reviewAppDirectory(env = process.env) {
  if (env.PRISM_REVIEW_APP_DIR) {
    return path.resolve(env.PRISM_REVIEW_APP_DIR);
  }
  if (env.NODE_TEST_CONTEXT) {
    return path.join(tmpdir(), `prism-test-app-${process.getuid?.() ?? "user"}`);
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Prism");
  }
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Prism");
  }
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "prism");
}
function reviewAppDisabled(env = process.env) {
  return env.PRISM_REVIEW_APP === "off";
}
function openAtStartDisabled(env = process.env) {
  return env.PRISM_REVIEW_BROWSER_ON_START === "off";
}
function olderVersion(candidate, reference) {
  const parse = (version) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""))?.slice(1).map(Number) ?? null;
  const left = parse(candidate);
  const right = parse(reference);
  if (!left || !right) return false;
  const index = left.findIndex((part, position) => part !== right[position]);
  return index >= 0 && left[index] < right[index];
}
const discoveryPath = (directory) => path.join(directory, DISCOVERY_FILE);
const projectsPath = (directory) => path.join(directory, PROJECTS_FILE);
const lockBase = (directory) => path.join(directory, LOCK_BASE);
const lockPath = (directory) => `${lockBase(directory)}.lock`;
const APP_LOCK_STALE_MS = 30 * 1e3;
async function appAlive(directory, discovery, now = Date.now()) {
  if (!discovery) return false;
  const info = await stat(lockPath(directory)).catch(() => null);
  if (!info || now - info.mtimeMs > APP_LOCK_STALE_MS) return false;
  try {
    process.kill(discovery.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function projectId(projectRoot) {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}
function trustedEntry(info, kind) {
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return false;
  if (info.isSymbolicLink()) return false;
  if (process.platform === "win32") return true;
  return info.uid === process.getuid() && (info.mode & 63) === 0;
}
async function trustedDirectory(directory) {
  try {
    return trustedEntry(await lstat(directory), "directory");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}
async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  if (!await trustedDirectory(directory)) {
    throw new Error("The review app state directory is not private to this user.");
  }
}
function validDiscovery(value) {
  return value !== null && typeof value === "object" && Number.isSafeInteger(value.protocol) && value.protocol >= 0 && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535 && typeof value.controlToken === "string" && value.controlToken.length >= 16 && typeof value.viewerToken === "string" && value.viewerToken.length >= 16 && Number.isSafeInteger(value.pid) && value.pid > 0;
}
async function readDiscovery(directory) {
  try {
    if (!await trustedDirectory(directory)) return null;
    const file = discoveryPath(directory);
    if (!trustedEntry(await lstat(file), "file")) return null;
    const value = parseStoreJson(await readFile(file, "utf8"));
    return validDiscovery(value) ? value : null;
  } catch {
    return null;
  }
}
async function writeDiscovery(directory, value) {
  await writeAtomically(discoveryPath(directory), `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
}
async function removeDiscovery(directory, controlToken) {
  const current = await readDiscovery(directory);
  if (current?.controlToken === controlToken) {
    await rm(discoveryPath(directory), { force: true });
  }
}
async function readProjectRoots(directory) {
  try {
    const value = parseStoreJson(await readFile(projectsPath(directory), "utf8"));
    return Array.isArray(value?.projects) ? value.projects.filter((root) => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}
async function readProjectDirectories(directory, field) {
  try {
    const value = parseStoreJson(await readFile(projectsPath(directory), "utf8"))?.[field];
    const valid = (stores) => Array.isArray(stores) && stores.length > 0 && stores.every((store) => typeof store === "string" && path.isAbsolute(store));
    return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([root, stores]) => path.isAbsolute(root) && valid(stores)));
  } catch {
    return {};
  }
}
async function writeProjectRoots(directory, roots, { evidence = {}, intelligence = {}, records = {} } = {}) {
  await writeAtomically(projectsPath(directory), `${JSON.stringify({ projects: roots, evidence, intelligence, records }, null, 2)}
`, { mode: 384 });
}
async function readLastPort(directory) {
  try {
    if (!await trustedDirectory(directory)) return null;
    const file = path.join(directory, PORT_FILE);
    if (!trustedEntry(await lstat(file), "file")) return null;
    const port = parseStoreJson(await readFile(file, "utf8"))?.port;
    return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}
async function writeLastPort(directory, port) {
  await writeAtomically(path.join(directory, PORT_FILE), `${JSON.stringify({ port })}
`, { mode: 384 });
}
const newCredential = () => randomBytes(24).toString("base64url");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const mac = (key, text) => createHmac("sha256", key).update(text).digest("hex");
function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function signRequest(controlToken, method, route, body) {
  const nonce = randomBytes(16).toString("hex");
  return { nonce, header: `${nonce}.${mac(controlToken, `${method}
${route}
${nonce}
${sha256(body)}`)}` };
}
function verifyRequest(controlToken, header, method, route, body) {
  const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(header ?? ""));
  if (!match) return null;
  return sameText(match[2], mac(controlToken, `${method}
${route}
${match[1]}
${sha256(body)}`)) ? match[1] : null;
}
function proveResponse(controlToken, nonce, body) {
  return mac(controlToken, `${nonce}
${sha256(body)}`);
}
function verifyResponse(controlToken, nonce, body, proof) {
  return typeof proof === "string" && sameText(proof, proveResponse(controlToken, nonce, body));
}
async function recordFallback(directory, { projectRoot, reason, pluginVersion = null }) {
  process.stderr.write(`Prism serves ${projectRoot} from this session's own review server, because the shared review app could not be reached: ${reason}
`);
  try {
    await prepareDirectory(directory);
    const file = path.join(directory, FALLBACK_LOG);
    if (((await stat(file).catch(() => null))?.size ?? 0) > FALLBACK_LOG_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, projectRoot, reason, ...pluginVersion ? { pluginVersion } : {} })}
`, { mode: 384 });
  } catch {
  }
}
export {
  APP_LOCK_STALE_MS,
  REVIEW_APP_PROTOCOL,
  appAlive,
  lockBase,
  lockPath,
  newCredential,
  olderVersion,
  openAtStartDisabled,
  prepareDirectory,
  projectId,
  proveResponse,
  readDiscovery,
  readLastPort,
  readProjectDirectories,
  readProjectRoots,
  recordFallback,
  removeDiscovery,
  reviewAppDirectory,
  reviewAppDisabled,
  signRequest,
  trustedDirectory,
  verifyRequest,
  verifyResponse,
  writeDiscovery,
  writeLastPort,
  writeProjectRoots
};
