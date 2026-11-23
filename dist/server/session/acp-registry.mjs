// Generated from src/server/session/acp-registry.mts by scripts/native-build/compile.mjs.
import { ACP_ID_PATTERN, OWN_INTEGRATION_IDS } from "./acp-agents.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";
const DEFAULT_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_KEPT_MS = 10 * 60 * 1e3;
const READ_TIMEOUT_MS = 3e4;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const UNSUPPORTED_SUFFIXES = Object.freeze([".dmg", ".pkg", ".deb", ".rpm", ".msi", ".tar.xz", ".txz", ".xz", ".tar.zst", ".zst", ".7z", ".rar", ".tar"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const UV_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9._,-]+\])?==([A-Za-z0-9][A-Za-z0-9.+!_-]*)$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 2e3) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length <= 2e3) : [];
function platformKey() {
  const system = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!system || !arch) return null;
  return `${system}-${arch}${system === "linux" && isMusl() ? "-musl" : ""}`;
}
function isMusl() {
  try {
    const header = process.report?.getReport()?.header;
    return header ? !header.glibcVersionRuntime : false;
  } catch {
    return false;
  }
}
function registryUrl(env = process.env) {
  const url = env.PRISM_ACP_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  return { url, refusal: downloadUrlRefusal(url, "The agent registry URL") };
}
function downloadUrlRefusal(value, subject = "The download URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `${subject} ${value} is not a URL; it must use https, or http to 127.0.0.1 or localhost.`;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) return null;
  return `${subject} ${value} must use https, or http to 127.0.0.1 or localhost.`;
}
const TEST_REFUSAL = "Prism reads no agent registry under the test runner unless PRISM_ACP_REGISTRY_URL names one.";
const kept = /* @__PURE__ */ new Map();
const reading = /* @__PURE__ */ new Map();
async function fetchIndex(url) {
  const at = Date.now();
  const unavailable = (why) => ({ index: null, reason: `Prism cannot read the agent registry at ${url}: ${why}.`, at });
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error" });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "the request failed";
    return unavailable(error?.name === "TimeoutError" ? `it did not answer within ${READ_TIMEOUT_MS / 1e3} seconds` : String(cause));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {
    });
    return unavailable(`it answered HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INDEX_BYTES) {
    await response.body?.cancel().catch(() => {
    });
    return unavailable(`its index is larger than ${MAX_INDEX_BYTES / 1024 / 1024} MiB`);
  }
  let body;
  try {
    body = await response.text();
  } catch (error) {
    return unavailable(String(error?.message ?? "the answer was cut off"));
  }
  if (body.length > MAX_INDEX_BYTES) return unavailable(`its index is larger than ${MAX_INDEX_BYTES / 1024 / 1024} MiB`);
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return unavailable("its index is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.agents)) return unavailable("its index holds no agents list");
  return { index: value, reason: null, at };
}
async function readIndex(url, fresh) {
  const hit = kept.get(url);
  if (!fresh && hit && Date.now() - hit.at < REGISTRY_KEPT_MS) return { index: hit.index, reason: null, at: hit.at };
  let pending = reading.get(url);
  if (!pending) {
    pending = fetchIndex(url).finally(() => reading.delete(url));
    reading.set(url, pending);
  }
  const result = await pending;
  if (result.index) kept.set(url, { at: result.at, index: result.index });
  return result;
}
const stringMap = (value) => isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) : {};
function distributionsFor(entry, platform) {
  const distribution = isRecord(entry.distribution) ? entry.distribution : {};
  const found = [];
  const binary = platform && isRecord(distribution.binary) ? distribution.binary[platform] : void 0;
  if (isRecord(binary) && typeof binary.archive === "string" && typeof binary.cmd === "string") {
    found.push({ kind: "binary", platform, archive: binary.archive, cmd: binary.cmd, args: strings(binary.args), env: stringMap(binary.env), sha256: typeof binary.sha256 === "string" ? binary.sha256 : null });
  }
  for (const kind of ["npx", "uvx"]) {
    const item = distribution[kind];
    if (isRecord(item) && typeof item.package === "string") found.push({ kind, package: item.package, args: strings(item.args), env: stringMap(item.env) });
  }
  return found;
}
function npxPackage(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return NPM_NAME.test(name) && EXACT_VERSION.test(version) ? { name, version } : null;
}
function uvxPackage(spec) {
  const match = UV_PIN.exec(spec);
  return match ? { name: match[1], extras: match[2] ?? null, version: match[3] } : null;
}
const SHA256 = /^[0-9a-f]{64}$/i;
async function installRefusal(name, distribution, env) {
  if (distribution.kind === "binary") {
    if (!distribution.sha256 || !SHA256.test(distribution.sha256)) return `The registry lists no SHA-256 checksum for the ${distribution.platform} build of ${name}, so Prism cannot check its download.`;
    const archive = (() => {
      try {
        return new URL(distribution.archive).pathname.toLowerCase();
      } catch {
        return distribution.archive.toLowerCase();
      }
    })();
    if (UNSUPPORTED_SUFFIXES.some((suffix) => archive.endsWith(suffix))) return `The ${distribution.platform} download of ${name} is not a .zip, .tar.gz, .tgz, .tar.bz2, or .tbz2 archive or the program itself, so Prism cannot unpack it.`;
    return null;
  }
  const tool = distribution.kind === "npx" ? "npm" : "uv";
  if (distribution.kind === "npx" && !npxPackage(distribution.package)) return `The npx package ${distribution.package} of ${name} does not name an exact version, so Prism cannot lock what it installs.`;
  if (distribution.kind === "uvx" && !uvxPackage(distribution.package)) return `The uvx package ${distribution.package} of ${name} does not pin ==<version>, so Prism cannot lock what it installs.`;
  const resolved = await resolveDefinition({ host: tool, label: tool, executable: tool }, env);
  if (!resolved.available) return `${tool} is not on PATH, and Prism installs the ${distribution.kind} package of ${name} with it.`;
  return null;
}
function sourceOf(entry, distribution) {
  return text(entry.repository) ?? text(entry.website) ?? (distribution.kind === "binary" ? distribution.archive : distribution.package);
}
async function readRegistry({ env = process.env, fresh = false } = {}) {
  if (env.NODE_TEST_CONTEXT && !env.PRISM_ACP_REGISTRY_URL) return { state: "unavailable", reason: TEST_REFUSAL, readAt: null, agents: [] };
  const { url, refusal } = registryUrl(env);
  if (refusal) return { state: "unavailable", reason: refusal, readAt: null, agents: [] };
  const read = await readIndex(url, fresh);
  if (!read.index) return { state: "unavailable", reason: read.reason, readAt: null, agents: [] };
  const platform = platformKey();
  const agents = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of read.index.agents) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !ACP_ID_PATTERN.test(entry.id) || OWN_INTEGRATION_IDS.has(entry.id) || seen.has(entry.id)) continue;
    const version = text(entry.version, 100);
    if (!version) continue;
    const candidates = distributionsFor(entry, platform);
    if (candidates.length === 0) continue;
    seen.add(entry.id);
    const name = text(entry.name, 60) ?? entry.id;
    let chosen = candidates[0];
    let reason = null;
    for (const [position, candidate] of candidates.entries()) {
      const why = await installRefusal(name, candidate, env);
      if (why === null) {
        chosen = candidate;
        reason = null;
        break;
      }
      if (position === 0) reason = why;
    }
    agents.push({
      id: entry.id,
      name,
      version,
      authors: strings(entry.authors).filter((author) => author.length <= 200),
      license: text(entry.license, 200),
      source: sourceOf(entry, chosen),
      description: text(entry.description),
      distribution: chosen,
      install: { available: reason === null, reason },
      entry
    });
  }
  return { state: "ready", reason: null, readAt: new Date(read.at).toISOString(), agents };
}
export {
  DEFAULT_REGISTRY_URL,
  REGISTRY_KEPT_MS,
  downloadUrlRefusal,
  npxPackage,
  platformKey,
  readRegistry,
  registryUrl,
  uvxPackage
};
