import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// A record store named by its remote: a URL of one of these schemes, or the scp form [user@]host:path; any other value is a path.
// A one-letter host is a Windows drive, as Git reads it, so C:store stays a path.
const STORE_URL = /^(?:https?|ssh|git|file):\/\//i;
const NETWORK_URL = /^(?:https?|ssh|git):\/\//i;
const PLAINTEXT_URL = /^(?:http|git):\/\//i;
// A path that begins with a second ':' is Git's <transport>::<address> form, which starts the remote helper git-remote-<transport>, so it names no network store.
const STORE_SCP = /^(?:[^@/\\\s]+@)?[A-Za-z0-9][A-Za-z0-9.-]+:[^:\s][^\s]*$/;

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

// The key Prism 0.20 hashed for a remote store's clone folder: scheme, lowercase host and port, and path without trailing slashes and one trailing .git, or lowercase host:path for the scp form.
function legacyKey(value) {
  const parts = remoteParts(value);
  if (!parts) return null;
  let tail = parts.path.replace(/\/+$/, "");
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4).replace(/\/+$/, "");
  return `${parts.prefix}${tail}`;
}

const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The folder name that Prism 0.20 gave a remote store's managed clone, or null when the value names no remote. */
export function legacyStoreId(value) {
  const key = legacyKey(value);
  return key && sha16(key);
}

// The network part of an identity: lowercase host, a slash, and the path without leading and trailing slashes and one trailing .git.
function networkIdentity(host, pathname) {
  let tail = pathname.replace(/^\/+|\/+$/g, "");
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4).replace(/\/+$/, "");
  return host && tail ? `${host.toLowerCase()}/${tail}` : null;
}

// The real path of a store folder, or of the folder.git that Git also finds for it, or the path itself when neither exists yet.
async function realFolder(folder) {
  const bare = path.resolve(folder);
  for (const candidate of [bare, `${bare}.git`]) {
    try { return await realpath(candidate); } catch { /* Try the next spelling Git accepts. */ }
  }
  return bare;
}

// The identity of a network URL or scp-form remote, which needs no file system, or null for any other value.
function networkStoreIdentity(value) {
  if (NETWORK_URL.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    // The URL parser percent-encodes the path that the scp form spells as it is, so the decoded path gives both spellings one identity.
    let decoded = parsed.pathname;
    try { decoded = decodeURIComponent(decoded); } catch { /* A malformed escape stays as it is spelled. */ }
    const identity = networkIdentity(parsed.hostname, decoded);
    return identity && (PLAINTEXT_URL.test(value) ? `${parsed.protocol}//${identity}` : identity);
  }
  if (!STORE_SCP.test(value)) return null;
  const scp = /^(?:[^@/\\\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]+):([^?#\s]*)/.exec(value);
  return scp && networkIdentity(scp[1], scp[2]);
}

/**
 * The identity of a Workspace Store value, which every spelling of one store shares: host/path for an https://, ssh://, or scp-form remote, without scheme, user information, port, query, fragment, or a trailing .git,
 * the same after its scheme for an http:// or git:// remote, which Git reaches without encryption, so a plaintext spelling never shares a clone with an encrypted one,
 * or file: and the real path of a folder store or a file:// URL, a relative path resolved from root; null when the value names no usable store.
 */
export async function storeIdentity(value, { root = process.cwd() } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (NETWORK_URL.test(value)) return networkStoreIdentity(value);
  if (/^file:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    // A path whose bytes are not UTF-8 has no real path that Node can name, so its encoded spelling stands for it, as Git reads it.
    let folder;
    try { folder = fileURLToPath(parsed); } catch { return parsed.host && parsed.host !== "localhost" ? null : `file:${parsed.pathname.replace(/\/+$/, "")}`; }
    return `file:${await realFolder(folder)}`;
  }
  if (STORE_SCP.test(value)) return networkStoreIdentity(value);
  return `file:${await realFolder(path.resolve(root, value))}`;
}

/** The folder name of a remote store's managed clone: the first 16 hex characters of the SHA-256 of its store identity, or null when it names no remote. */
export async function managedStoreId(value) {
  if (!isRemoteStore(value)) return null;
  const identity = await storeIdentity(value);
  return identity && sha16(identity);
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

/**
 * A store address with any credential taken out, or null when none can be taken out cleanly: the user information of a URL, a URL's query and fragment,
 * and the user of an scp-form address with a password. An address without a credential comes back as it is.
 * Only the leading user information is taken out, and the result must name the same remote store as the value, so a credential is never removed by turning the value into another store.
 */
export function addressWithoutCredentials(value) {
  if (typeof value !== "string") return null;
  if (!credentialsIn(value)) return value;
  // A value that names a folder has no user information to take out.
  if (!isRemoteStore(value)) return null;
  let stripped;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)?.[0];
  if (scheme) {
    // The authority ends at the first '/', '?', or '#'; its user information ends at its last '@'.
    const rest = value.slice(scheme.length);
    const authority = rest.split(/[/?#]/, 1)[0];
    stripped = `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${rest.slice(authority.length)}`.replace(/[?#].*$/s, "");
  } else {
    stripped = value.replace(/^[^/\\\s]*@(?=[A-Za-z0-9][A-Za-z0-9.-]+:)/, "");
  }
  if (!stripped || credentialsIn(stripped) || !isRemoteStore(stripped)) return null;
  const identity = networkStoreIdentity(value);
  return identity && networkStoreIdentity(stripped) === identity ? stripped : null;
}

/**
 * Whether a store value carries a credential: any user information before the host of an http:// or https:// URL, where it is how tokens are passed,
 * any user information of a git:// URL, which has no login at all, or a password, a ':' in the user information, of an ssh:// or scp-form address.
 * An SSH login name such as the git of git@github.com:acme/store.git only selects the host's account, since SSH authenticates with the machine's keys, so it is no credential.
 * A query or fragment of a network URL can carry a token too, and Git uses neither to find a store, so either counts as a credential.
 */
export function credentialsIn(value) {
  if (typeof value !== "string") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme && ["http", "https", "git", "ssh"].includes(scheme)) {
    // The authority ends at the first '/', '?', or '#', so an '@' further on belongs to the path.
    const rest = value.slice(scheme.length + 3);
    const authority = rest.split(/[/?#]/, 1)[0];
    const at = authority.lastIndexOf("@");
    if (/[?#]/.test(rest)) return true;
    if (at < 0) return false;
    return scheme === "ssh" ? authority.slice(0, at).includes(":") : true;
  }
  if (scheme) return false;
  // The scp form [user@]host:path names its user before the last '@' ahead of the host's ':'.
  const scp = /^([^/\\\s]*)@[A-Za-z0-9][A-Za-z0-9.-]+:/.exec(value);
  return Boolean(scp && scp[1].includes(":"));
}
