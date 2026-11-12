import { createHash } from "node:crypto";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";

/** A remote URL without its user, password, or token, so no credential ever reaches a record. */
// Only network remotes name a place others can find; local paths and helper transports such as ext:: are left out.
const REMOTE_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
export function publicRemote(url) {
  if (typeof url !== "string" || !url) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      // Scheme, host, and path only: user information, query, and fragment can all carry a token.
      return REMOTE_SCHEMES.has(parsed.protocol) && parsed.hostname ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : null;
    } catch { return null; }
  }
  // A scp-like address such as git@host:owner/repo names its user, and sometimes a password, before the host.
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]+):([^:?#\s][^?#\s]*)$/.exec(url.split(/[?#]/)[0]);
  return scp ? `${scp[1]}:${scp[2]}` : null;
}

// A record store named by its remote: a URL of one of these schemes, or the scp form user@host:path; any other value is a path.
const STORE_URL = /^(?:https?|ssh|git|file):\/\//i;
const STORE_SCP = /^[^@/\\\s]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+$/;

/** Whether a Workspace Store value names a Git remote rather than a folder. */
export function isRemoteStore(value) {
  return typeof value === "string" && (STORE_URL.test(value) || STORE_SCP.test(value));
}

// The remote as messages may name it: scheme, host, and path, never user information, query, or fragment.
function remoteParts(value) {
  if (!isRemoteStore(value)) return null;
  if (STORE_URL.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    if (parsed.protocol !== "file:" && !parsed.hostname) return null;
    const visible = parsed.protocol === "file:" ? `file://${parsed.host}${parsed.pathname}` : publicRemote(value);
    return visible && { visible, prefix: `${parsed.protocol}//${parsed.host.toLowerCase()}`, path: parsed.pathname };
  }
  const visible = publicRemote(value);
  const separator = visible?.indexOf(":") ?? -1;
  return separator > 0 && { visible, prefix: `${visible.slice(0, separator).toLowerCase()}:`, path: visible.slice(separator + 1) };
}

/** A remote store value without user information, query, or fragment, for messages; null when it names no remote. */
export function remoteLabel(value) {
  return remoteParts(value)?.visible ?? null;
}

/** The identity of a remote store: lowercase host, no user information, and no trailing .git or slash, so spellings of one remote share a clone. */
export function normalizeRemote(value) {
  const parts = remoteParts(value);
  if (!parts) return null;
  let tail = parts.path.replace(/\/+$/, "");
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4).replace(/\/+$/, "");
  return `${parts.prefix}${tail}`;
}

/** The folder name of a remote store's managed clone: the first 16 hex characters of the SHA-256 of its normalized remote. */
export function managedStoreId(value) {
  const normalized = normalizeRemote(value);
  return normalized && createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** The folder that holds managed store clones: one per machine in Prism's application folder, shared by every host, so a host need not give Prism a data directory. */
export function managedStoresDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), "stores");
}

/** The folder where Prism 0.16 kept managed clones, under the host's plugin data directory, or null when the host gives none. */
export function legacyStoresDirectory(env = process.env) {
  const data = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  return data ? path.join(path.resolve(data), "stores") : null;
}

/** Text without the user information of any URL in it, so a Git message never carries a credential. */
export function withoutCredentials(text) {
  return typeof text === "string" ? text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@'"]*@/gi, "$1") : text;
}
