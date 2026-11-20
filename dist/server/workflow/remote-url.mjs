// Generated from src/server/workflow/remote-url.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
const REMOTE_SCHEMES = /* @__PURE__ */ new Set(["https:", "http:", "ssh:", "git:"]);
function publicRemote(url) {
  if (typeof url !== "string" || !url) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return REMOTE_SCHEMES.has(parsed.protocol) && parsed.hostname ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : null;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]+):([^:?#\s][^?#\s]*)$/.exec(url.split(/[?#]/)[0]);
  return scp ? `${scp[1]}:${scp[2]}` : null;
}
const STORE_URL = /^(?:https?|ssh|git|file):\/\//i;
const NETWORK_URL = /^(?:https?|ssh|git):\/\//i;
const PLAINTEXT_URL = /^(?:http|git):\/\//i;
const STORE_SCP = /^(?:[^@/\\\s]+@)?[A-Za-z0-9][A-Za-z0-9.-]+:[^:\s][^\s]*$/;
function isRemoteStore(value) {
  return typeof value === "string" && (STORE_URL.test(value) || STORE_SCP.test(value));
}
function remoteParts(value) {
  if (!isRemoteStore(value)) return null;
  if (STORE_URL.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== "file:" && !parsed.hostname) return null;
    const visible2 = parsed.protocol === "file:" ? `file://${parsed.host}${parsed.pathname}` : publicRemote(value);
    return visible2 && { visible: visible2, prefix: `${parsed.protocol}//${parsed.host.toLowerCase()}`, path: parsed.pathname };
  }
  const visible = publicRemote(value);
  const separator = visible?.indexOf(":") ?? -1;
  return separator > 0 && { visible, prefix: `${visible.slice(0, separator).toLowerCase()}:`, path: visible.slice(separator + 1) };
}
function remoteLabel(value) {
  return remoteParts(value)?.visible ?? null;
}
function legacyKey(value) {
  const parts = remoteParts(value);
  if (!parts) return null;
  let tail = parts.path.replace(/\/+$/, "");
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4).replace(/\/+$/, "");
  return `${parts.prefix}${tail}`;
}
const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
function legacyStoreId(value) {
  const key = legacyKey(value);
  return key && sha16(key);
}
function networkIdentity(host, pathname) {
  let tail = pathname.replace(/^\/+|\/+$/g, "");
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4).replace(/\/+$/, "");
  return host && tail ? `${host.toLowerCase()}/${tail}` : null;
}
async function realFolder(folder) {
  const bare = path.resolve(folder);
  for (const candidate of [bare, `${bare}.git`]) {
    try {
      return await realpath(candidate);
    } catch {
    }
  }
  return bare;
}
function networkStoreIdentity(value) {
  if (NETWORK_URL.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    let decoded = parsed.pathname;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
    }
    const identity = networkIdentity(parsed.hostname, decoded);
    return identity && (PLAINTEXT_URL.test(value) ? `${parsed.protocol}//${identity}` : identity);
  }
  if (!STORE_SCP.test(value)) return null;
  const scp = /^(?:[^@/\\\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]+):([^?#\s]*)/.exec(value);
  return scp && networkIdentity(scp[1], scp[2]);
}
async function storeIdentity(value, { root = process.cwd() } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (NETWORK_URL.test(value)) return networkStoreIdentity(value);
  if (/^file:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    let folder;
    try {
      folder = fileURLToPath(parsed);
    } catch {
      return parsed.host && parsed.host !== "localhost" ? null : `file:${parsed.pathname.replace(/\/+$/, "")}`;
    }
    return `file:${await realFolder(folder)}`;
  }
  if (STORE_SCP.test(value)) return networkStoreIdentity(value);
  return `file:${await realFolder(path.resolve(root, value))}`;
}
async function managedStoreId(value) {
  if (!isRemoteStore(value)) return null;
  const identity = await storeIdentity(value);
  return identity && sha16(identity);
}
function managedStoresDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), "stores");
}
function legacyStoresDirectory(env = process.env) {
  const data = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  return data ? path.join(path.resolve(data), "stores") : null;
}
function withoutCredentials(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s'"`<>]*)/gi, (whole, scheme, rest) => {
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const afterUser = rest.slice(authority.lastIndexOf("@") + 1);
    return `${scheme}${afterUser.replace(/[?#].*$/s, "")}`;
  });
}
function storeForm(value) {
  if (NETWORK_URL.test(value)) return /^[a-z][a-z0-9+.-]*:/i.exec(value)[0].toLowerCase();
  if (/^file:\/\//i.test(value)) return null;
  return STORE_SCP.test(value) ? "scp" : null;
}
function addressWithoutCredentials(value) {
  if (typeof value !== "string") return null;
  if (!credentialsIn(value)) return value;
  if (!isRemoteStore(value)) return null;
  let stripped;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)?.[0];
  if (scheme) {
    const rest = value.slice(scheme.length);
    const authority = rest.split(/[/?#]/, 1)[0];
    stripped = `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${rest.slice(authority.length)}`.replace(/[?#].*$/s, "");
  } else {
    stripped = value.replace(/^[^/\\\s]*@(?=[A-Za-z0-9][A-Za-z0-9.-]+:)/, "");
  }
  if (!stripped || credentialsIn(stripped) || !isRemoteStore(stripped)) return null;
  const form = storeForm(value);
  if (!form || storeForm(stripped) !== form) return null;
  const identity = networkStoreIdentity(value);
  return identity && networkStoreIdentity(stripped) === identity ? stripped : null;
}
function credentialsIn(value) {
  if (typeof value !== "string") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme && ["http", "https", "git", "ssh"].includes(scheme)) {
    const rest = value.slice(scheme.length + 3);
    const authority = rest.split(/[/?#]/, 1)[0];
    const at = authority.lastIndexOf("@");
    if (/[?#]/.test(rest)) return true;
    if (at < 0) return false;
    return scheme === "ssh" ? authority.slice(0, at).includes(":") : true;
  }
  if (scheme) return false;
  const scp = /^([^/\\\s]*)@[A-Za-z0-9][A-Za-z0-9.-]+:/.exec(value);
  return Boolean(scp && scp[1].includes(":"));
}
export {
  addressWithoutCredentials,
  credentialsIn,
  isRemoteStore,
  legacyStoreId,
  legacyStoresDirectory,
  managedStoreId,
  managedStoresDirectory,
  publicRemote,
  remoteLabel,
  storeIdentity,
  withoutCredentials
};
