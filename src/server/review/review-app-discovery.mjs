import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";

// Raise this when a control route or field changes meaning, so a newer client replaces an older app.
// The cross-version contract is review-app-protocol.schema.json beside this file.
export const REVIEW_APP_PROTOCOL = 1;
const DISCOVERY_FILE = "review-app.json";
const PROJECTS_FILE = "review-app-projects.json";
const LOCK_BASE = "review-app";

export function reviewAppDirectory(env = process.env) {
  if (env.PRISM_REVIEW_APP_DIR) {
    return path.resolve(env.PRISM_REVIEW_APP_DIR);
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

const discoveryPath = (directory) => path.join(directory, DISCOVERY_FILE);
const projectsPath = (directory) => path.join(directory, PROJECTS_FILE);
// withFileLock locks `${path}.lock`, so this names review-app.lock.
export const lockBase = (directory) => path.join(directory, LOCK_BASE);
export const lockPath = (directory) => `${lockBase(directory)}.lock`;

export function projectId(projectRoot) {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

// Windows protects %LOCALAPPDATA% with a per-user ACL; elsewhere the owner and mode must keep other users out.
function trustedEntry(info, kind) {
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return false;
  if (info.isSymbolicLink()) return false;
  if (process.platform === "win32") return true;
  return info.uid === process.getuid() && (info.mode & 0o077) === 0;
}

// Answers whether the state directory can be used: a missing directory is trusted because the app creates it privately.
export async function trustedDirectory(directory) {
  try {
    return trustedEntry(await lstat(directory), "directory");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await trustedDirectory(directory))) {
    throw new Error("The review app state directory is not private to this user.");
  }
}

function validDiscovery(value) {
  return value !== null && typeof value === "object"
    && Number.isSafeInteger(value.protocol) && value.protocol >= 0
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
    && typeof value.controlToken === "string" && value.controlToken.length >= 16
    && typeof value.viewerToken === "string" && value.viewerToken.length >= 16
    && Number.isSafeInteger(value.pid) && value.pid > 0;
}

// Only the known fields are checked, so a newer app's extra fields never make its discovery file unreadable.
export async function readDiscovery(directory) {
  try {
    if (!(await trustedDirectory(directory))) return null;
    const file = discoveryPath(directory);
    if (!trustedEntry(await lstat(file), "file")) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    return validDiscovery(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeDiscovery(directory, value) {
  await writeAtomically(discoveryPath(directory), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function removeDiscovery(directory, controlToken) {
  const current = await readDiscovery(directory);
  if (current?.controlToken === controlToken) {
    await rm(discoveryPath(directory), { force: true });
  }
}

export async function readProjectRoots(directory) {
  try {
    const value = JSON.parse(await readFile(projectsPath(directory), "utf8"));
    return Array.isArray(value?.projects) ? value.projects.filter((root) => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

export async function writeProjectRoots(directory, roots) {
  await writeAtomically(projectsPath(directory), `${JSON.stringify({ projects: roots }, null, 2)}\n`, { mode: 0o600 });
}

export const newCredential = () => randomBytes(24).toString("base64url");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const mac = (key, text) => createHmac("sha256", key).update(text).digest("hex");

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

// The control credential signs requests and responses instead of travelling, so a listener that took the port learns nothing usable.
export function signRequest(controlToken, method, route, body) {
  const nonce = randomBytes(16).toString("hex");
  return { nonce, header: `${nonce}.${mac(controlToken, `${method}\n${route}\n${nonce}\n${sha256(body)}`)}` };
}

export function verifyRequest(controlToken, header, method, route, body) {
  const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(header ?? ""));
  if (!match) return null;
  return sameText(match[2], mac(controlToken, `${method}\n${route}\n${match[1]}\n${sha256(body)}`)) ? match[1] : null;
}

export function proveResponse(controlToken, nonce, body) {
  return mac(controlToken, `${nonce}\n${sha256(body)}`);
}

export function verifyResponse(controlToken, nonce, body, proof) {
  return typeof proof === "string" && sameText(proof, proveResponse(controlToken, nonce, body));
}
