import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";

// Raise this when a control route or field changes meaning, so a newer client replaces an older app.
// The cross-version contract is review-app-protocol.schema.json beside this file.
export const REVIEW_APP_PROTOCOL = 1;
const DISCOVERY_FILE = "review-app.json";
const PROJECTS_FILE = "review-app-projects.json";
const PORT_FILE = "review-app-port.json";
const LOCK_BASE = "review-app";
const FALLBACK_LOG = "fallbacks.log";
const FALLBACK_LOG_BYTES = 256 * 1024;

/** The file through which a review app announces itself to sessions; a newer app may add fields. */
export interface Discovery { protocol: number; port: number; controlToken: string; viewerToken: string; pid: number; [field: string]: unknown }

export function reviewAppDirectory(env = process.env) {
  if (env.PRISM_REVIEW_APP_DIR) {
    return path.resolve(env.PRISM_REVIEW_APP_DIR);
  }
  // The person's folder holds the review app's state and every managed store clone, so a process under Node's test runner, and every server or hook it spawns with its environment,
  // uses one temporary folder of its own instead, and no test, run by CI or by hand, can sync or change a real store's clone.
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

export function reviewAppDisabled(env = process.env) {
  return env.PRISM_REVIEW_APP === "off";
}

// Turns off the browser that a session opens at start; tests and users who never want that window set it.
export function openAtStartDisabled(env = process.env) {
  return env.PRISM_REVIEW_BROWSER_ON_START === "off";
}

// Answers whether a release version is older than another; an unreadable version is never older, so it never causes a replacement.
export function olderVersion(candidate: unknown, reference: unknown) {
  const parse = (version: unknown) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""))?.slice(1).map(Number) ?? null;
  const left = parse(candidate);
  const right = parse(reference);
  if (!left || !right) return false;
  const index = left.findIndex((part, position) => part !== right[position]);
  return index >= 0 && left[index] < right[index];
}

const discoveryPath = (directory: string) => path.join(directory, DISCOVERY_FILE);
const projectsPath = (directory: string) => path.join(directory, PROJECTS_FILE);
// withFileLock locks `${path}.lock`, so this names review-app.lock.
export const lockBase = (directory: string) => path.join(directory, LOCK_BASE);
export const lockPath = (directory: string) => `${lockBase(directory)}.lock`;
// The app renews its lock every few seconds; a lock older than this belongs to an app that stopped renewing it.
export const APP_LOCK_STALE_MS = 30 * 1000;

// Whether the app that a discovery file names is still running: its lock is renewed and its process exists.
// A slow app that misses a request is alive, and only a dead one justifies serving a project elsewhere or starting another app.
export async function appAlive(directory: string, discovery: Discovery | null, now = Date.now()) {
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

export function projectId(projectRoot: string) {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

// Windows protects %LOCALAPPDATA% with a per-user ACL; elsewhere the owner and mode must keep other users out.
function trustedEntry(info: Stats, kind: "directory" | "file") {
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return false;
  if (info.isSymbolicLink()) return false;
  if (process.platform === "win32") return true;
  return info.uid === process.getuid!() && (info.mode & 0o077) === 0;
}

// Answers whether the state directory can be used: a missing directory is trusted because the app creates it privately.
export async function trustedDirectory(directory: string) {
  try {
    return trustedEntry(await lstat(directory), "directory");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

export async function prepareDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await trustedDirectory(directory))) {
    throw new Error("The review app state directory is not private to this user.");
  }
}

function validDiscovery(value: any): value is Discovery {
  return value !== null && typeof value === "object"
    && Number.isSafeInteger(value.protocol) && value.protocol >= 0
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
    && typeof value.controlToken === "string" && value.controlToken.length >= 16
    && typeof value.viewerToken === "string" && value.viewerToken.length >= 16
    && Number.isSafeInteger(value.pid) && value.pid > 0;
}

// Only the known fields are checked, so a newer app's extra fields never make its discovery file unreadable.
export async function readDiscovery(directory: string): Promise<Discovery | null> {
  try {
    if (!(await trustedDirectory(directory))) return null;
    const file = discoveryPath(directory);
    if (!trustedEntry(await lstat(file), "file")) return null;
    const value = parseStoreJson(await readFile(file, "utf8"));
    return validDiscovery(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeDiscovery(directory: string, value: any) {
  await writeAtomically(discoveryPath(directory), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function removeDiscovery(directory: string, controlToken: string) {
  const current = await readDiscovery(directory);
  if (current?.controlToken === controlToken) {
    await rm(discoveryPath(directory), { force: true });
  }
}

export async function readProjectRoots(directory: string) {
  try {
    const value = parseStoreJson(await readFile(projectsPath(directory), "utf8"));
    return Array.isArray(value?.projects) ? value.projects.filter((root: string) => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

// Maps each project root to the private storage directories of one kind, such as evidence stores or index storage, that its sessions reported,
// most recent first, so a restarted app keeps reading the right ones.
export async function readProjectDirectories(directory: string, field: string) {
  try {
    const value = parseStoreJson(await readFile(projectsPath(directory), "utf8"))?.[field];
    const valid = (stores: unknown) => Array.isArray(stores) && stores.length > 0 && stores.every((store) => typeof store === "string" && path.isAbsolute(store));
    return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([root, stores]) => path.isAbsolute(root) && valid(stores)));
  } catch {
    return {};
  }
}

export async function writeProjectRoots(directory: string, roots: string[], { evidence = {}, intelligence = {}, records = {} }: { evidence?: Record<string, string[]>; intelligence?: Record<string, string[]>; records?: Record<string, string[]> } = {}) {
  await writeAtomically(projectsPath(directory), `${JSON.stringify({ projects: roots, evidence, intelligence, records }, null, 2)}\n`, { mode: 0o600 });
}

// The last bound port outlives the app, so a cold restart can serve the same origin, where the browser keeps site permissions and storage.
export async function readLastPort(directory: string) {
  try {
    if (!(await trustedDirectory(directory))) return null;
    const file = path.join(directory, PORT_FILE);
    if (!trustedEntry(await lstat(file), "file")) return null;
    const port = parseStoreJson(await readFile(file, "utf8"))?.port;
    return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function writeLastPort(directory: string, port: number) {
  await writeAtomically(path.join(directory, PORT_FILE), `${JSON.stringify({ port })}\n`, { mode: 0o600 });
}

export const newCredential = () => randomBytes(24).toString("base64url");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const mac = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex");

function sameText(left: unknown, right: unknown) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

// The control credential signs requests and responses instead of travelling, so a listener that took the port learns nothing usable.
export function signRequest(controlToken: string, method: string, route: string, body: string) {
  const nonce = randomBytes(16).toString("hex");
  return { nonce, header: `${nonce}.${mac(controlToken, `${method}\n${route}\n${nonce}\n${sha256(body)}`)}` };
}

export function verifyRequest(controlToken: string, header: unknown, method: string, route: string, body: string) {
  const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(header ?? ""));
  if (!match) return null;
  return sameText(match[2], mac(controlToken, `${method}\n${route}\n${match[1]}\n${sha256(body)}`)) ? match[1] : null;
}

export function proveResponse(controlToken: string, nonce: string, body: string) {
  return mac(controlToken, `${nonce}\n${sha256(body)}`);
}

export function verifyResponse(controlToken: string, nonce: string, body: string, proof: unknown) {
  return typeof proof === "string" && sameText(proof, proveResponse(controlToken, nonce, body));
}

// A session that serves its project from its own review server says why on stderr and in a log beside the app's state, because two
// review pages for one project are otherwise unexplained. The log keeps one older file once it grows past its limit.
export async function recordFallback(directory: string, { projectRoot, reason, pluginVersion = null }: { projectRoot: string; reason: string; pluginVersion?: string | null }) {
  process.stderr.write(`Prism serves ${projectRoot} from this session's own review server, because the shared review app could not be reached: ${reason}\n`);
  try {
    await prepareDirectory(directory);
    const file = path.join(directory, FALLBACK_LOG);
    if (((await stat(file).catch(() => null))?.size ?? 0) > FALLBACK_LOG_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, projectRoot, reason, ...(pluginVersion ? { pluginVersion } : {}) })}\n`, { mode: 0o600 });
  } catch {
    // A directory the app cannot use either leaves the stderr line as the only record.
  }
}
