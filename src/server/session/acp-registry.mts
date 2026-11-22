import { ACP_ID_PATTERN, OWN_INTEGRATION_IDS } from "./acp-agents.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";

// The public Agent Client Protocol registry: its index, read under the URL rule and kept for 10 minutes, the agents that have a
// build or a package for this computer, and whether Prism can install each one safely and, if not, why.

export const DEFAULT_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const REGISTRY_KEPT_MS = 10 * 60 * 1000;
const READ_TIMEOUT_MS = 30_000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const ARCHIVE_SUFFIXES = Object.freeze([".tar.gz", ".tgz", ".zip"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const UV_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9._,-]+\])?==([A-Za-z0-9][A-Za-z0-9.+!_-]*)$/;

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2000) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 2000) : []);

/** What the registry says about itself: ready with the time of the kept read, or unavailable with why. */
export interface RegistryState { state: "ready" | "unavailable"; reason: string | null; readAt: string | null }

/** The build or package of an agent that this computer takes. */
export type RegistryDistribution =
  | { kind: "binary"; platform: string; archive: string; cmd: string; args: string[]; env: Record<string, string>; sha256: string | null }
  | { kind: "npx"; package: string; args: string[]; env: Record<string, string> }
  | { kind: "uvx"; package: string; args: string[]; env: Record<string, string> };

/** One registry agent that this computer can run: its details, the distribution Prism would install, and whether it can. */
export interface RegistryAgent {
  id: string; name: string; version: string; authors: string[]; license: string | null; source: string | null; description: string | null;
  distribution: RegistryDistribution; install: { available: boolean; reason: string | null }; entry: Record<string, any>;
}

/**
 * This computer's registry platform key: os darwin, linux, or windows, arch x86_64 or aarch64, and -musl on a musl Linux;
 * null on a system or architecture that the registry names no build for.
 */
export function platformKey(): string | null {
  const system = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform];
  const arch = ({ x64: "x86_64", arm64: "aarch64" } as Record<string, string>)[process.arch];
  if (!system || !arch) return null;
  return `${system}-${arch}${system === "linux" && isMusl() ? "-musl" : ""}`;
}

function isMusl() {
  try {
    const header = (process.report?.getReport() as any)?.header;
    return header ? !header.glibcVersionRuntime : false;
  } catch {
    return false;
  }
}

/** The index URL that env names and why it cannot be read, or null when it can: https, or http to 127.0.0.1 or localhost. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): { url: string; refusal: string | null } {
  const url = env.PRISM_ACP_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  return { url, refusal: downloadUrlRefusal(url, "The agent registry URL") };
}

/** Why a registry or download URL may not be read, or null: it must use https, or http to 127.0.0.1 or localhost. */
export function downloadUrlRefusal(value: string, subject = "The download URL"): string | null {
  let parsed: URL;
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

const kept = new Map<string, { at: number; index: Record<string, any> }>();
const reading = new Map<string, Promise<{ index: Record<string, any> | null; reason: string | null; at: number }>>();

async function fetchIndex(url: string) {
  const at = Date.now();
  const unavailable = (why: string) => ({ index: null, reason: `Prism cannot read the agent registry at ${url}: ${why}.`, at });
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), redirect: "error" });
  } catch (error: any) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "the request failed";
    return unavailable(error?.name === "TimeoutError" ? `it did not answer within ${READ_TIMEOUT_MS / 1000} seconds` : String(cause));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return unavailable(`it answered HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INDEX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return unavailable(`its index is larger than ${MAX_INDEX_BYTES / 1024 / 1024} MiB`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error: any) {
    return unavailable(String(error?.message ?? "the answer was cut off"));
  }
  if (body.length > MAX_INDEX_BYTES) return unavailable(`its index is larger than ${MAX_INDEX_BYTES / 1024 / 1024} MiB`);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unavailable("its index is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.agents)) return unavailable("its index holds no agents list");
  return { index: value, reason: null, at };
}

// The index of url: the kept read while it is under 10 minutes old, unless fresh asks for a new one; a failed read is not kept.
async function readIndex(url: string, fresh: boolean) {
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

const stringMap = (value: unknown): Record<string, string> => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string> : {});

// The distributions of an entry that this computer takes, in Prism's order of preference: this platform's binary build, npx, uvx.
function distributionsFor(entry: Record<string, any>, platform: string | null): RegistryDistribution[] {
  const distribution = isRecord(entry.distribution) ? entry.distribution : {};
  const found: RegistryDistribution[] = [];
  const binary = platform && isRecord(distribution.binary) ? distribution.binary[platform] : undefined;
  if (isRecord(binary) && typeof binary.archive === "string" && typeof binary.cmd === "string") {
    found.push({ kind: "binary", platform: platform!, archive: binary.archive, cmd: binary.cmd, args: strings(binary.args), env: stringMap(binary.env), sha256: typeof binary.sha256 === "string" ? binary.sha256 : null });
  }
  for (const kind of ["npx", "uvx"] as const) {
    const item = distribution[kind];
    if (isRecord(item) && typeof item.package === "string") found.push({ kind, package: item.package, args: strings(item.args), env: stringMap(item.env) });
  }
  return found;
}

/** The npm package name and exact version of an npx package such as @scope/name@1.2.3, or null when it names no exact version. */
export function npxPackage(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return NPM_NAME.test(name) && EXACT_VERSION.test(version) ? { name, version } : null;
}

/** The requirement name and pinned version of a uvx package such as name==1.2.3, or null when it pins no version with ==. */
export function uvxPackage(spec: string): { name: string; extras: string | null; version: string } | null {
  const match = UV_PIN.exec(spec);
  return match ? { name: match[1], extras: match[2] ?? null, version: match[3] } : null;
}

const SHA256 = /^[0-9a-f]{64}$/i;

// Why Prism cannot install this distribution of the agent safely, or null when it can.
async function installRefusal(name: string, distribution: RegistryDistribution, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (distribution.kind === "binary") {
    if (!distribution.sha256 || !SHA256.test(distribution.sha256)) return `The registry lists no SHA-256 checksum for the ${distribution.platform} build of ${name}, so Prism cannot check its download.`;
    const archive = (() => { try { return new URL(distribution.archive).pathname.toLowerCase(); } catch { return distribution.archive.toLowerCase(); } })();
    if (!ARCHIVE_SUFFIXES.some((suffix) => archive.endsWith(suffix))) return `The ${distribution.platform} archive of ${name} is not a .tar.gz, .tgz, or .zip file, so Prism cannot unpack it.`;
    return null;
  }
  const tool = distribution.kind === "npx" ? "npm" : "uv";
  if (distribution.kind === "npx" && !npxPackage(distribution.package)) return `The npx package ${distribution.package} of ${name} does not name an exact version, so Prism cannot lock what it installs.`;
  if (distribution.kind === "uvx" && !uvxPackage(distribution.package)) return `The uvx package ${distribution.package} of ${name} does not pin ==<version>, so Prism cannot lock what it installs.`;
  const resolved = await resolveDefinition({ host: tool, label: tool, executable: tool }, env);
  if (!resolved.available) return `${tool} is not on PATH, and Prism installs the ${distribution.kind} package of ${name} with it.`;
  return null;
}

/** Where an agent's source can be read: its repository, else its website, else its download. */
function sourceOf(entry: Record<string, any>, distribution: RegistryDistribution) {
  return text(entry.repository) ?? text(entry.website) ?? (distribution.kind === "binary" ? distribution.archive : distribution.package);
}

/**
 * The registry as read now: its state, and each agent with a build or package for this computer, in index order, leaving out the
 * agents Prism runs through its own integrations and every entry whose id cannot be a host. fresh reads the index again rather than
 * from the read kept for 10 minutes. While the index cannot be read, the state is unavailable with why and no agent is listed.
 */
export async function readRegistry({ env = process.env, fresh = false }: { env?: NodeJS.ProcessEnv; fresh?: boolean } = {}): Promise<RegistryState & { agents: RegistryAgent[] }> {
  // A process under Node's test runner reads only the registry that PRISM_ACP_REGISTRY_URL names, so no test reaches the public one.
  if (env.NODE_TEST_CONTEXT && !env.PRISM_ACP_REGISTRY_URL) return { state: "unavailable", reason: TEST_REFUSAL, readAt: null, agents: [] };
  const { url, refusal } = registryUrl(env);
  if (refusal) return { state: "unavailable", reason: refusal, readAt: null, agents: [] };
  const read = await readIndex(url, fresh);
  if (!read.index) return { state: "unavailable", reason: read.reason, readAt: null, agents: [] };
  const platform = platformKey();
  const agents: RegistryAgent[] = [];
  const seen = new Set<string>();
  for (const entry of read.index.agents) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !ACP_ID_PATTERN.test(entry.id) || OWN_INTEGRATION_IDS.has(entry.id) || seen.has(entry.id)) continue;
    const version = text(entry.version, 100);
    if (!version) continue;
    const candidates = distributionsFor(entry, platform);
    if (candidates.length === 0) continue;
    seen.add(entry.id);
    const name = text(entry.name, 60) ?? entry.id;
    let chosen = candidates[0];
    let reason: string | null = null;
    for (const [position, candidate] of candidates.entries()) {
      const why = await installRefusal(name, candidate, env);
      if (why === null) { chosen = candidate; reason = null; break; }
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
