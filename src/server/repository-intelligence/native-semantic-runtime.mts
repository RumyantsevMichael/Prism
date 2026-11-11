import path from "node:path";
import { pluginPath, pluginURL } from "../plugin-root.mjs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, readdir, open, rename, rm, chmod, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withFileLock, withArtifactLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { errorFields, log } from "../log.mjs";
import { ProgressRecorder, componentStorageKey, gitFingerprint, projectStorageKey, sameFingerprint, writeFreshness } from "./index-progress.mjs";
import { assertSafeAncestors, regularBytes, semanticError } from "./native-files.mjs";
import { publishedUnits, unitsFile } from "./index-files.mjs";
import { Helper } from "./native-helper.mjs";
import { LocalIndexStore, ThreadIndexStore } from "./index-store.mjs";
import type { IndexStore } from "./index-store.mjs";
import type { GitFingerprint } from "./index-progress.mjs";
import type { NativeSource, SourceSnapshot, IndexMetadata, IndexStage, PreparedIndex, Preparation, PrepareOptions, Progress, Diagnostic, SearchFilters, ComponentRuntime, Counts, IndexComponent, ComponentFailure } from "./repository-unit-types.mjs";

export { assertSafeAncestors, regularBytes, semanticError } from "./native-files.mjs";
export { publishedUnits, unitsFile } from "./index-files.mjs";

interface Asset { url: string; bytes: number; sha256: string; unpackedBytes?: number }
interface AssetManifest { schemaVersion: 1; identity: string; assetVersion: string; bundles: Record<string, Asset>; modelMirror?: string; model: { id: string; revision: string; files: (Omit<Asset, "url"> & { path: string; url?: string })[] } }
// `stallMs` replaces the stall period that PRISM_INDEX_STALL_MINUTES or the default sets.
interface Options { directory?: string; manifestPath?: string; idleMs?: number; operationMs?: number; stallMs?: number }
interface Coverage extends Counts { structurallyCoveredFiles: number; complete: boolean }
// A job prepares one storage location: the whole project in a repository without components, otherwise one component.
// `read` orders the jobs of one storage location by when their content was read, `retry` is set while another session holds the component's lock,
// `superseded` is set when a newer read replaced the job while it ran, and `assets` keeps the checked assets for the job's next lock attempt.
// `watchdog` restarts the stall period on each progress of the running job, and `stalled` is set once it fired.
// `structure` is the structure-only index of the job's content, published by its build or stored by an earlier one, and `structured` settles once it is set.
interface Job { id: string; directory: string; component?: IndexComponent; snapshot: string; status: "waiting" | "preparing" | "ready" | "degraded"; diagnostics: Diagnostic[]; failure: ComponentFailure | null;
  promise: Promise<void>; finish: () => void; run: () => Promise<void>; prepared?: PreparedIndex; revision?: string; builtAt?: string; progress?: Progress; coverage?: Coverage; recorder?: ProgressRecorder; freshness?: GitFingerprint | null;
  live: boolean; read: number; retry?: NodeJS.Timeout; superseded?: boolean; assets?: Assets; reload?: boolean; requeue?: boolean; watchdog?: () => void; stallTimer?: NodeJS.Timeout; stalled?: boolean;
  structure?: PreparedIndex; structured: Promise<void>; publish: () => void }
interface Assets { runtime: string; modelDirectory: string; modelIdentity: string; assetIdentity: string }
interface Location { root: string; directory: string }
interface Entry { source: NativeSource; component?: IndexComponent }
// A pointer without `stage` was written before structure-only indexes existed and names a complete index.
interface IndexPointer { snapshot?: string; revision?: string; stage?: IndexStage; chunkerVersion?: string; coverage?: Coverage; diagnostics?: Diagnostic[]; builtAt?: string }

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const supported = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);
const boundedWait = (promise: Promise<void>, ms: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
const busy = (job: Job | undefined) => job?.status === "waiting" || job?.status === "preparing";
// A component whose lock another session holds is retried after this delay instead of holding the queue while that session builds it.
const LOCK_RETRY_MS = 2000;
// Loading an index that is already on disk reads files and builds nothing, so a few loads run beside the one build instead of queueing behind it.
const RELOAD_CONCURRENCY = 4;
const reloadMiss = () => Object.assign(semanticError("preparation_failed", "The stored index no longer matches its content."), { reloadMiss: true });
// A writer renews its storage lock every five seconds, so a lock left unrenewed for longer than the lock stale period has no live writer,
// even when the process it names is running, as a reused process id after a restart can be.
const UNRENEWED_LOCK_MS = 30000;
const heldError = (code: string, message: string) => Object.assign(semanticError(code, message), { held: code === "lock_timeout" });
// A build has no limit on its total duration; it is stopped only after it reports no progress for the stall period.
const DEFAULT_STALL_MS = 10 * 60 * 1000;
const STALL_RECOVERY = "Repeat the call to resume the build from its saved work.";
export function stallPeriod(stallMs?: number, minutes = process.env.PRISM_INDEX_STALL_MINUTES) {
  if (stallMs !== undefined) return stallMs;
  const value = /^\d+$/.test(minutes?.trim() ?? "") ? Number(minutes!.trim()) : NaN;
  return value >= 1 && value <= 1440 ? value * 60 * 1000 : DEFAULT_STALL_MS;
}
export function stallDuration(ms: number) {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)} seconds`;
  const minutes = Math.round(ms / 60000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
// A value is progress when its phase, count, item, or file moved, or when it brought new vectors; a repeated heartbeat is not.
const progressed = (previous: Progress | undefined, next: Progress, embedded: boolean) => embedded || !previous || previous.phase !== next.phase
  || previous.current !== next.current || previous.item !== next.item || previous.file !== next.file;
const stalledError = (phase: string, ms: number) => Object.assign(semanticError("stalled", `The index build made no progress for ${stallDuration(ms)} during ${phase}.`), { stalled: true, phase });
const pointerStage = (pointer: IndexPointer | null | undefined): IndexStage => pointer?.stage === "structure" ? "structure" : "complete";
// The stage of the index that answers for a storage location: its job's complete index or published structure, else the published pointer's.
const indexStage = (job: Job | undefined, published: IndexPointer | undefined): IndexStage | "none" =>
  job?.prepared ? job.prepared.stage ?? "complete" : job?.structure ? "structure" : published?.revision ? pointerStage(published) : "none";
const coverageOf = (index: IndexMetadata): Coverage => ({ ...index.counts, structurallyCoveredFiles: Object.values(index.fileCoverage).filter(Boolean).length,
  complete: index.structureComplete && Object.values(index.fileCoverage).every(Boolean) });
const optionalJson = (file: string) => readJson<IndexPointer>(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const stableFailure = (error: Error & { code?: string }) => ["invalid_path", "lock_timeout", "stale_snapshot", "unsupported_runtime", "corrupt_asset", "resource_limit", "validation_failed"].includes(error.code || "") ? error.code! : error.code === "snapshot-changed" ? "stale_snapshot" : "preparation_failed";

export async function privateDirectory(directory: string): Promise<string> {
  // Check each existing ancestor before creating children or following paths.
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try {
      await assertSafeAncestors(parent);
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw semanticError("invalid_path", "A private storage parent is not a directory.");
    } catch (error) { if (error.code !== "ENOENT") throw error; await privateDirectory(parent); }
  }
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== path.resolve(directory)) throw semanticError("invalid_path", "Private storage must not follow a symlink.");
  await chmod(directory, 0o700);
  return directory;
}



async function readJson<T>(file: string): Promise<T> { return JSON.parse((await regularBytes(file)).toString("utf8")); }

async function download(asset: Asset, destination: string, allowFile: boolean, onBytes: (current: number, total: number) => void = () => {}) {
  const valid = async () => {
    try { const bytes = await regularBytes(destination, asset.bytes); return bytes.length === asset.bytes && sha(bytes) === asset.sha256; }
    catch (error) { if (error.code === "invalid_path") throw error; return false; }
  };
  if (await valid()) return;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f\d]{64}$/.test(asset.sha256)) throw semanticError("corrupt_asset", "The pinned asset metadata is invalid.");
  const url = new URL(asset.url);
  let body: AsyncIterable<Uint8Array> | Uint8Array[];
  if (allowFile && url.protocol === "file:") body = [await regularBytes(fileURLToPath(url), asset.bytes)];
  else {
    if (url.protocol !== "https:") throw semanticError("corrupt_asset", "Runtime assets require HTTPS.");
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) }).catch(error => {
      throw semanticError("preparation_failed", `The asset download from ${url.host} failed: ${error.cause?.code || error.message}.`);
    });
    if (!response.ok) throw semanticError("preparation_failed", `The asset download from ${url.host} returned HTTP ${response.status}.`);
    if (!response.body) throw semanticError("preparation_failed", `The asset download from ${url.host} returned no body.`);
    body = response.body;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600), digest = createHash("sha256");
  let length = 0;
  try {
    for await (const chunk of body) {
      length += chunk.length;
      if (length > asset.bytes) throw semanticError("corrupt_asset", "The downloaded asset exceeds its pinned size.");
      digest.update(chunk); await handle.writeFile(chunk); onBytes(length, asset.bytes);
    }
    if (length !== asset.bytes || digest.digest("hex") !== asset.sha256) throw semanticError("corrupt_asset", "The downloaded asset failed its integrity check.");
    await handle.sync(); await handle.close();
    await rename(temporary, destination);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}

// Try each source in order, so a release mirror can serve the model where its origin host is unreachable.
async function downloadFirst(asset: Omit<Asset, "url">, urls: string[], destination: string, allowFile: boolean, onBytes?: (current: number, total: number) => void) {
  const failures: string[] = [];
  let code = "preparation_failed";
  for (const url of urls) {
    try { return await download({ ...asset, url }, destination, allowFile, onBytes); }
    catch (error) { if (error.code === "invalid_path") throw error; failures.push(error.message); code = error.code || code; }
  }
  throw semanticError(code, failures.join(" "));
}

export const modelAssetName = (file: string) => `model-${file.split("/").join("-")}`;

const STALE_ASSET_MS = 14 * 24 * 60 * 60 * 1000;
const KEPT_INDEX_REVISIONS = 4;
const UNITS_FILE = /^units-([a-f\d]{64})\.json$/;


// Keep the current index and the most recently used earlier revisions, so a retained before-change snapshot still reuses its index.
// Each source change writes a complete index, so older revisions, their generation pointers, and abandoned snapshot mirrors are removed.
// A structure-only index that a complete index replaced is removed with its sidecar and never takes a kept slot.
// Call only while holding the project directory lock.
export async function pruneIndexes(directory: string, current: string, keep = KEPT_INDEX_REVISIONS, replaced: string[] = []) {
  const entries = await readdir(directory);
  const removed = new Set(replaced.filter(revision => revision !== current).map(revision => `${revision}.json`));
  const revisions = await Promise.all(entries.filter(name => /^[a-f\d]{64}\.json$/.test(name) && !removed.has(name))
    .map(async name => ({ name, used: (await lstat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const name of removed) if (entries.includes(name)) await rm(path.join(directory, name), { force: true });
  const kept = new Set([`${current}.json`, ...revisions.sort((a, b) => b.used - a.used).slice(0, keep).map(revision => revision.name)]);
  for (const { name } of revisions) if (!kept.has(name)) await rm(path.join(directory, name), { force: true });
  for (const name of entries) {
    if (name.startsWith("snapshot-")) { await rm(path.join(directory, name), { recursive: true, force: true }); continue; }
    const sidecar = UNITS_FILE.exec(name);
    if (sidecar) { if (!kept.has(`${sidecar[1]}.json`)) await rm(path.join(directory, name), { force: true }); continue; }
    if (!/^generation-.+\.json$/.test(name)) continue;
    const pointer = await readJson<IndexPointer>(path.join(directory, name)).catch(() => ({} as IndexPointer));
    if (!pointer.revision || !kept.has(`${pointer.revision}.json`)) await rm(path.join(directory, name), { force: true });
  }
}

// Remove assets that no plugin version has used recently, and downloaded archives whose runtime is already extracted.
// Each version marks its own runtime and model as used, so a session on an older plugin version keeps its assets.
export async function pruneAssets(directory: string, keep: Set<string>, maxAgeMs = STALE_ASSET_MS, now = Date.now()) {
  const entries = await readdir(directory);
  for (const name of entries) {
    if (keep.has(name) || name.endsWith(".lock")) continue;
    const archive = name.endsWith(".tar.gz") && entries.includes(name.slice(0, -".tar.gz".length));
    const info = await lstat(path.join(directory, name)).catch(() => null);
    if (info && (archive || now - info.mtimeMs > maxAgeMs)) await rm(path.join(directory, name), { recursive: true, force: true });
  }
}


export class NativeSemanticRuntime implements ComponentRuntime {
  directory: string;
  manifestPath: string;
  // The latest job of each storage location, the jobs of recent contents, and the component contents that reached a native limit in this process.
  jobs = new Map<string, Job>();
  generations = new Map<string, Job>();
  limited = new Map<string, Job>();
  // One preparation runs at a time; the jobs waiting for it are in queue order, which a later call can change.
  queue: Job[] = [];
  running: Job | null = null;
  // Settles when no job runs or waits.
  sequence: Promise<void> = Promise.resolve();
  idle?: () => void;
  pinned?: AssetManifest;
  // Builds and searches have a helper each, because a helper answers one request at a time and a build can run for many minutes,
  // while a search of a component that is ready must answer within its call's bound and must not fail when another component's build times out.
  processes = new Map<"build" | "search", Helper>();
  indexStore?: IndexStore;
  // Counts snapshot reads, so a newer read of a location's live content can replace a job for content read before it.
  reads = 0;
  verifiedRuntime?: string;
  // The model files as last checked, by size and modification time, so each component's preparation does not hash the model again.
  verifiedModel?: { directory: string; stamp: string };
  // Jobs that load a stored index, and those of them that are loading now.
  reloads: Job[] = [];
  reloading = new Set<Job>();
  constructor(private options: Options = {}) {
    const hostData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
    this.directory = path.resolve(options.directory || (hostData ? path.join(hostData, "native-intelligence") : path.join(os.homedir(), ".cache", "prism", "native-intelligence")));
    this.manifestPath = options.manifestPath || process.env.PRISM_NATIVE_ASSET_MANIFEST || pluginPath("vendor/native-runtime/manifest.json");
  }
  async manifest() {
    if (!this.pinned) {
      const data = await regularBytes(this.manifestPath, 1024 * 1024), manifest = JSON.parse(data.toString("utf8")) as AssetManifest;
      if (manifest.schemaVersion !== 1 || !manifest.model?.revision || !manifest.bundles) throw semanticError("corrupt_asset", "The native asset manifest is invalid.");
      this.pinned = { ...manifest, identity: sha(data) };
    }
    return this.pinned;
  }
  async location(projectRoot: string, component?: IndexComponent): Promise<Location> {
    const root = await realpath(projectRoot);
    if (inside(root, this.directory)) throw semanticError("invalid_path", "Native storage must be outside the target project.");
    const key = component ? componentStorageKey(root, component.folder === "" ? "" : component.name) : projectStorageKey(root);
    return { root, directory: path.join(this.directory, "projects", key) };
  }
  async published(directory: string): Promise<IndexPointer | undefined> {
    try { return await readJson<IndexPointer>(path.join(directory, "current.json")); }
    catch (error) { if (error.code !== "ENOENT") return { diagnostics: [{ code: "corrupt_asset", message: "The previous index pointer is invalid. Rebuild the index." }] }; }
    return undefined;
  }
  async status(projectRoot: string, waitMs = 0) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw semanticError("validation_failed", "waitMs must be from 0 through 30000.");
    const location = await this.location(projectRoot);
    const { indexComponents, componentSources } = await import("./component-indexes.mjs");
    const declaration = await indexComponents(location.root);
    if (declaration) return this.componentStatus(location.root, componentSources(location.root, declaration), waitMs);
    const job = this.jobs.get(location.directory);
    if (waitMs && busy(job)) await boundedWait(job!.promise, waitMs);
    const published = await this.published(location.directory);
    return { status: job ? this.legacyStatus(job) : published?.snapshot ? "indexed" : "unprepared", preparationId: job?.id || null, stage: indexStage(job, published),
      snapshot: job?.snapshot || published?.snapshot || null, indexRevision: job?.revision || job?.structure?.revision || published?.revision || null,
      progress: job?.progress || null, coverage: job?.coverage || published?.coverage || null,
      ...await this.statusFacts(job?.prepared?.index.chunkerVersion || published?.chunkerVersion || null),
      diagnostics: job?.diagnostics || published?.diagnostics || [], freshness: "verify-on-use" };
  }
  // A repository without components has one job, which reports a queued preparation as preparing, as it always has.
  legacyStatus(job: Job): Preparation["status"] { return job.status === "waiting" ? "preparing" : job.status; }
  async statusFacts(chunker: string | null) {
    const manifest = await this.manifest();
    return { versions: { runtime: manifest.assetVersion, model: `${manifest.model.id}@${manifest.model.revision}`, graph: "1.6.0", chunker },
      runtime: await this.availability(),
      structuralCapabilities: { code: ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C#", "C", "C++"], documents: ["Markdown", "JSON", "YAML"] },
      limits: { files: 20000, sourceBytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, sdkFileBytes: 1024 * 1024, modelTokens: 512 } };
  }
  // Each component that holds a scanned file, in component order, with the state of its latest job in this process or of its published index.
  async componentStatus(root: string, sources: { component: string; name: string; folder: string; source: NativeSource }[], waitMs: number) {
    const held = [];
    for (const entry of sources) if ((await entry.source.snapshot()).files.length) held.push({ ...entry, location: await this.location(root, { name: entry.name, identity: entry.component, folder: entry.folder }) });
    const directories = new Map(held.map(entry => [entry.location.directory, entry.component]));
    if (waitMs && this.running && directories.has(this.running.directory)) await boundedWait(this.running.promise, waitMs);
    const components = [], diagnostics: (Diagnostic & { component: string })[] = [];
    let chunker: string | null = null;
    for (const { component, folder, location } of held) {
      const job = this.jobs.get(location.directory), published = await this.published(location.directory);
      const status = job ? job.status : published?.snapshot ? "indexed" : "unprepared", own = job ? job.diagnostics : published?.diagnostics || [];
      chunker ??= job?.prepared?.index.chunkerVersion || published?.chunkerVersion || null;
      components.push({ component, folder, status, preparationId: job?.id || null, stage: indexStage(job, published), snapshot: job?.snapshot || published?.snapshot || null,
        indexRevision: job?.revision || job?.structure?.revision || published?.revision || null, builtAt: job?.builtAt || published?.builtAt || null,
        progress: job?.status === "preparing" && job.progress ? { ...job.progress, component } : null, coverage: job?.coverage || published?.coverage || null,
        failure: job?.status === "degraded" ? job.failure : null, diagnosticCount: own.length });
      diagnostics.push(...own.map(item => ({ ...item, component })));
    }
    const running = this.running && directories.has(this.running.directory) && this.running.progress ? { ...this.running.progress, component: directories.get(this.running.directory)! } : null;
    const states = components.map(entry => entry.status);
    const status = states.some(state => state === "waiting" || state === "preparing") ? "preparing" : states.includes("degraded") ? "degraded"
      : components.some(entry => entry.indexRevision) ? "indexed" : "unprepared";
    return { status, preparationId: null, snapshot: null, indexRevision: null, progress: running, coverage: null, ...await this.statusFacts(chunker),
      diagnostics, freshness: "verify-on-use", components };
  }
  async availability() {
    const manifest = await this.manifest(), platform = `${process.platform}-${process.arch}`;
    return { supported: supported.has(platform), published: Boolean(manifest.bundles[platform]) };
  }
  async assets(progress: (value: Progress) => void): Promise<Assets> {
    const manifest = await this.manifest(), platform = `${process.platform}-${process.arch}`, asset = manifest.bundles[platform];
    if (!supported.has(platform)) throw semanticError("unsupported_runtime", `Native semantics does not support ${platform}.`);
    if (!asset) throw semanticError("unsupported_runtime", `No immutable native runtime asset is published for ${platform}.`);
    const assets = await privateDirectory(path.join(this.directory, "assets"));
    const runtime = path.join(assets, asset.sha256), modelDirectory = path.join(assets, sha(JSON.stringify(manifest.model)));
    const allowFile = Boolean(this.options.manifestPath || process.env.PRISM_NATIVE_ASSET_MANIFEST);
    progress({ phase: "assets-check" });
    await withArtifactLock(runtime, () => withFileLock(runtime, async () => {
      try { await this.verifyRuntime(runtime, platform); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      progress({ phase: "runtime-download", current: 0, total: asset.bytes, unit: "bytes" });
      const archive = `${runtime}.tar.gz`;
      await download(asset, archive, allowFile, (current, total) => progress({ phase: "runtime-download", current, total, unit: "bytes" }));
      const staging = await privateDirectory(`${runtime}.${randomUUID()}.tmp`);
      try {
        progress({ phase: "runtime-extract" });
        const { extractRuntime } = await import(pluginURL("vendor/native-runtime/extract.mjs").href);
        await extractRuntime(archive, staging, asset.unpackedBytes);
        await this.verifyRuntime(staging, platform);
        await chmod(path.join(staging, process.platform === "win32" ? "node.exe" : "node"), 0o700);
        await rename(staging, runtime);
      } finally { await rm(staging, { recursive: true, force: true }); await rm(archive, { force: true }); }
    }, semanticError, { renew: true, timeoutMs: 120000 })) ;
    await privateDirectory(modelDirectory);
    const stamp = async () => (await Promise.all(manifest.model.files.map(file => lstat(path.join(modelDirectory, file.path)).then(info => `${info.size}:${info.mtimeMs}`, () => "missing")))).join("\0");
    if (this.verifiedModel?.directory !== modelDirectory || this.verifiedModel.stamp !== await stamp()) await withArtifactLock(modelDirectory, () => withFileLock(modelDirectory, async () => {
      for (const [index, file] of manifest.model.files.entries()) {
        if (file.path.includes("..") || path.isAbsolute(file.path)) throw semanticError("corrupt_asset", "The model asset path is invalid.");
        const target = path.join(modelDirectory, file.path); await privateDirectory(path.dirname(target));
        const step = { phase: "model-download", file: file.path, item: index + 1, items: manifest.model.files.length, unit: "bytes" as const };
        const urls = file.url ? [file.url] : [...(manifest.modelMirror ? [`${manifest.modelMirror}/${modelAssetName(file.path)}`] : []),
          `https://huggingface.co/${manifest.model.id}/resolve/${manifest.model.revision}/${file.path}`];
        await downloadFirst(file, urls, target, allowFile, (current, total) => progress({ ...step, current, total }));
      }
      this.verifiedModel = { directory: modelDirectory, stamp: await stamp() };
    }, semanticError, { renew: true, timeoutMs: 120000 }));
    const used = new Date();
    for (const directory of [runtime, modelDirectory]) await utimes(directory, used, used).catch(() => {});
    await pruneAssets(assets, new Set([path.basename(runtime), path.basename(modelDirectory)])).catch(() => {});
    return { runtime, modelDirectory, modelIdentity: sha(JSON.stringify(manifest.model)), assetIdentity: manifest.identity };
  }
  async verifyRuntime(directory: string, platform: string) {
    if (this.verifiedRuntime === directory) return;
    const metadata = await readJson<{ schemaVersion: number; platform: string; node: string; files: Record<string, string> }>(path.join(directory, "runtime.json"));
    if (metadata.schemaVersion !== 1 || metadata.platform !== platform || metadata.node !== "24.16.0" || !metadata.files?.["worker.mjs"]) throw semanticError("corrupt_asset", "The runtime identity does not match the pinned platform.");
    for (const [relative, digest] of Object.entries(metadata.files)) {
      const file = path.resolve(directory, relative);
      if (!inside(directory, file) || sha(await regularBytes(file)) !== digest) throw semanticError("corrupt_asset", "A runtime file failed its integrity check.");
    }
    this.verifiedRuntime = directory;
  }
  // With `structureSuffices`, the wait also ends once the job's structure is published, because the caller needs nothing more.
  async prepare(source: NativeSource, expectedSnapshot?: string, waitMs = 10000, options: PrepareOptions = {}): Promise<Preparation> {
    if (expectedSnapshot !== undefined && (typeof expectedSnapshot !== "string" || !/^[a-f\d]{64}$/.test(expectedSnapshot))) throw semanticError("validation_failed", "expectedSnapshot must be a SHA-256 snapshot identity.");
    const [job] = await this.enqueue([{ source }], expectedSnapshot);
    if (busy(job)) await boundedWait(this.awaited(job, options), Math.min(waitMs, 10000));
    return { status: this.legacyStatus(job), preparationId: job.id, snapshot: job.snapshot, diagnostics: job.diagnostics, prepared: job.prepared, ...this.structureOf(job, options) };
  }
  awaited(job: Job, { structureSuffices = false }: PrepareOptions) { return structureSuffices ? Promise.race([job.promise, job.structured]) : job.promise; }
  // The published structure of a job that has no complete index yet, for a caller that can answer from it.
  structureOf(job: Job, { structure = false }: PrepareOptions): { structure?: PreparedIndex } { return structure && job.structure && !job.prepared ? { structure: job.structure } : {}; }
  // Queues the components a call needs, in the order given, and waits at most the call's bound in total for all of them.
  // `retryLimited` prepares again a component whose content reached a native limit in this process, as the review browser's rebuild does.
  async prepareComponents(entries: { source: NativeSource; component: IndexComponent }[], waitMs = 10000, { retryLimited = false, ...options }: { retryLimited?: boolean } & PrepareOptions = {}): Promise<Preparation[]> {
    const jobs = await this.enqueue(entries, undefined, retryLimited);
    const pending = jobs.filter(busy);
    if (pending.length) await boundedWait(Promise.all(pending.map(job => this.awaited(job, options))).then(() => {}), Math.min(waitMs, 10000));
    return jobs.map(job => ({ status: job.status, preparationId: job.id, snapshot: job.snapshot, diagnostics: job.diagnostics, prepared: job.prepared, ...this.structureOf(job, options),
      component: job.component!.identity, failure: job.status === "degraded" ? job.failure : null }));
  }
  // A job is shared by every call for the same content. A failed job is prepared again by the next call, except a component's job that reached
  // a native limit, which this process does not prepare again for the same content unless `retryLimited` asks for it.
  async enqueue(entries: Entry[], expectedSnapshot?: string, retryLimited = false): Promise<Job[]> {
    const manifest = await this.manifest(), jobs: Job[] = [];
    // Every component of a call lives in one project, so the call reads its Git fingerprint once.
    const fingerprints = new Map<string, Promise<GitFingerprint | null>>();
    for (const { source, component } of entries) {
      // The Git fingerprint is read before the snapshot, so a concurrent edit can only make the index look stale, never fresh.
      const projectRoot = (source as { projectRoot?: unknown }).projectRoot;
      if (typeof projectRoot === "string" && !fingerprints.has(projectRoot)) fingerprints.set(projectRoot, gitFingerprint(projectRoot));
      const fingerprint = typeof projectRoot === "string" ? await fingerprints.get(projectRoot)! : null;
      const read = ++this.reads, snapshot = await source.snapshot(), location = await this.location(snapshot.root, component);
      // A retained baseline is not the working tree, so its index records no freshness.
      const live = (snapshot as { enumerator?: string }).enumerator !== "retained";
      if (expectedSnapshot && expectedSnapshot !== snapshot.sourceFingerprint) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
      const generationKey = `${location.directory}\0${snapshot.sourceFingerprint}\0${manifest.identity}`;
      if (retryLimited && this.limited.get(generationKey)?.status === "degraded") this.limited.delete(generationKey);
      let job = this.limited.get(generationKey) ?? this.generations.get(generationKey);
      if (!job || (job.status === "degraded" && !this.limited.has(generationKey))) {
        job = this.job(source, snapshot, location, generationKey, component ? this.componentPreparationId(location.directory, snapshot.sourceFingerprint, manifest.identity) : sha(`${location.root}\0${snapshot.sourceFingerprint}\0${manifest.identity}`), live ? fingerprint : undefined, component, live, read);
        // A component whose index for this content is already stored only loads it, which needs no place in the build queue.
        if (component) job.reload = (await readdir(location.directory).catch(() => [] as string[])).some(name => name.startsWith(`generation-${snapshot.sourceFingerprint}-`));
      } else if (live && fingerprint && job.status === "ready" && !sameFingerprint(job.freshness ?? null, fingerprint)) {
        // A commit or checkout that leaves indexed content unchanged reuses the index, so only its freshness record moves forward.
        job.freshness = fingerprint;
        await writeFreshness(location.directory, job.snapshot, fingerprint);
      }
      job.read = Math.max(job.read, read);
      if (live) this.supersede(this.jobs.get(location.directory), job);
      this.jobs.set(location.directory, job);
      jobs.push(job);
    }
    // A stored index loads at once. The builds this call needs move ahead of every waiting build that it does not need, in the order of the call,
    // except that the root component builds after the declared ones: it holds everything outside them, often a large documentation tree, and
    // building it first would hold back every package queued with it. The running build is never interrupted.
    for (const job of new Set(jobs)) if (job.reload && job.status === "waiting" && !job.retry) this.reload(job);
    const last = (job: Job) => job.component?.folder === "" ? 1 : 0;
    const needed = [...new Set(jobs.filter(job => job.status === "waiting" && !job.reload))].sort((left, right) => last(left) - last(right));
    this.queue = [...needed, ...this.queue.filter(job => !needed.includes(job))];
    this.pump();
    return jobs;
  }
  // The preparation id of a component's content, which its progress records carry.
  componentPreparationId(directory: string, snapshot: string, assetIdentity: string) { return sha(`${directory}\0${snapshot}\0${assetIdentity}`); }
  reload(job: Job) {
    if (!this.reloads.includes(job)) this.reloads.push(job);
    this.pumpReloads();
  }
  pumpReloads() {
    while (this.reloading.size < RELOAD_CONCURRENCY && this.reloads.length) {
      const job = this.reloads.shift()!;
      if (!this.idle) this.sequence = new Promise<void>(resolve => { this.idle = resolve; });
      this.reloading.add(job); job.status = "preparing"; job.progress = { phase: "loading" };
      // A load that finds no matching index goes back to the build queue as waiting, and finishes when that build does.
      void job.run().catch(() => {}).finally(() => {
        this.reloading.delete(job);
        if (job.requeue) { job.requeue = false; this.queue.push(job); this.pump(); } else if (!job.retry) job.finish();
        this.pumpReloads(); this.settle();
      });
    }
  }
  // Resolves the sequence once no build or load runs or waits.
  settle() {
    if (this.running || this.queue.length || this.reloading.size || this.reloads.length) return;
    this.idle?.(); this.idle = undefined;
  }
  // A live job that has not started is dropped when a newer read of the same location's live content needs another job, because its source
  // has changed and its build could only fail; it ends as failed with stale_snapshot, without running and without a progress record.
  // The running job is marked instead, and is dropped the same way if it ends without an index, so it is not tried again and records no failure.
  supersede(previous: Job | undefined, next: Job) {
    if (!previous || previous === next || !previous.live || previous.read >= next.read || !busy(previous)) return;
    if (previous === this.running || this.reloading.has(previous)) { previous.superseded = true; return; }
    clearTimeout(previous.retry); previous.retry = undefined;
    this.queue = this.queue.filter(job => job !== previous);
    this.reloads = this.reloads.filter(job => job !== previous);
    this.stale(previous);
    previous.finish();
  }
  stale(job: Job) {
    const message = "The source changed before this preparation started, so a preparation of the newer content replaced it.";
    job.status = "degraded"; job.failure = { code: "stale_snapshot", message };
    job.diagnostics = [{ code: "stale_snapshot", message, recovery: "Repeat the call to read the newer content." }];
  }
  job(source: NativeSource, snapshot: SourceSnapshot, location: Location, generationKey: string, id: string, freshness: GitFingerprint | null | undefined, component?: IndexComponent, live = true, read = 0): Job {
    let finish = () => {}, publish = () => {};
    const promise = new Promise<void>(resolve => { finish = resolve; }), structured = new Promise<void>(resolve => { publish = resolve; });
    const job: Job = { id, directory: location.directory, component, snapshot: snapshot.sourceFingerprint, status: "waiting", diagnostics: [], failure: null, promise, finish, structured, publish, freshness, live, read, run: async () => {
      // Progress is reported to a file beside the index, so the review app can show builds that run in any session's process.
      const recorder = job.recorder = new ProgressRecorder(location.directory, job.id);
      const started = privateDirectory(location.directory).then(() => recorder.start()).catch(() => {});
      const stalled = this.watch(job);
      // A job's new status is set only once its progress record is final, so a caller that sees the job end never finds its record still being written.
      try {
        // A stalled build fails at once, without waiting for its stopped request to end.
        job.prepared = await Promise.race([this.build(source, snapshot, location, job), stalled]);
        if (job.freshness !== undefined) await writeFreshness(location.directory, job.snapshot, job.freshness);
        await started; await recorder.succeed();
        job.status = "ready";
      } catch (error) {
        if (error.reloadMiss) {
          job.reload = false; job.progress = undefined;
          await started; await recorder.succeed();
          job.requeue = true; job.status = "waiting";
          return;
        }
        // A job that a newer read replaced while it ran is dropped, as a waiting one is, and leaves no progress record, whether it ended
        // waiting for another session's lock or failed on the source that changed under it.
        if (job.superseded && this.jobs.get(location.directory) !== job) { await started; await recorder.succeed(); this.stale(job); return; }
        // A stall is not a native limit: the build's saved embeddings stay, and the next call that needs the content prepares it again.
        if (error.stalled) {
          const failure = { code: "stalled", message: error.message, phase: error.phase as string };
          log.warn("index_stalled", { directory: location.directory, component: component?.identity, phase: failure.phase });
          const diagnostics = [{ ...failure, recovery: STALL_RECOVERY }];
          await started; await recorder.fail(diagnostics);
          job.status = "degraded"; job.failure = failure; job.diagnostics = diagnostics;
          return;
        }
        let recovery = "Retry preparation after correcting the reported runtime, network, or source problem.";
        if (component && error.held) {
          const lock = `${location.directory}.lock`, info = await lstat(lock).catch(() => null);
          if (!info || Date.now() - info.mtimeMs <= UNRENEWED_LOCK_MS) {
            // Another session is preparing this component, so it stays preparing here and is tried again later, while the queue moves on.
            job.progress = { phase: "waiting" };
            await started; await recorder.succeed();
            job.retry = setTimeout(() => { job.retry = undefined; this.queue.push(job); this.pump(); }, LOCK_RETRY_MS);
            job.retry.unref();
            return;
          }
          error = semanticError("lock_timeout", `The storage lock of this component has not been renewed for ${Math.round((Date.now() - info.mtimeMs) / 1000)} seconds, so no session is preparing it, but the process that the lock names is still running.`);
          recovery = `If no session is preparing this component, delete ${lock} and repeat the call.`;
        }
        const code = stableFailure(error);
        log.warn("index_failed", { directory: location.directory, component: component?.identity, code, ...errorFields(error) });
        const diagnostics = [{ code, message: error.message, recovery }];
        await started; await recorder.fail(diagnostics);
        job.status = "degraded"; job.failure = { code, message: error.message }; job.diagnostics = diagnostics;
        if (component && code === "resource_limit") this.limited.set(generationKey, job);
      } finally { job.recorder = undefined; job.watchdog = undefined; clearTimeout(job.stallTimer); }
    } };
    this.generations.set(generationKey, job);
    // Each generation holds index metadata in memory, so forget the oldest finished ones of the same storage; their indexes stay reusable on disk.
    const same = [...this.generations].filter(([, generation]) => generation.directory === location.directory);
    let excess = same.length - KEPT_INDEX_REVISIONS;
    for (const [key, generation] of same) if (excess > 0 && !busy(generation)) { this.generations.delete(key); excess--; }
    return job;
  }
  pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) { this.settle(); return; }
    if (!this.idle) this.sequence = new Promise<void>(resolve => { this.idle = resolve; });
    this.running = job; job.status = "preparing";
    const started = performance.now();
    log.info("index_started", { directory: job.directory, component: job.component?.identity, queued: this.queue.length });
    void job.run().catch(() => {}).finally(() => {
      log.info("index_finished", { directory: job.directory, component: job.component?.identity, status: job.status, ms: Math.round(performance.now() - started) });
      log.activity.delete("index");
      this.running = null; if (!job.retry) job.finish(); this.pump();
    });
  }
  // Starts the stall period of a job that runs; the returned promise rejects with the stalled failure once the job makes no progress for that period.
  watch(job: Job): Promise<never> {
    const period = stallPeriod(this.options.stallMs);
    let reject: (error: Error) => void = () => {};
    const stalled = new Promise<never>((_, fail) => { reject = fail; });
    stalled.catch(() => {});
    const fire = () => {
      if (!job.watchdog) return;
      job.stalled = true; job.watchdog = undefined;
      const phase = job.progress?.phase ?? "starting";
      // The build helper is stopped without waiting for its request, which then ends with the build it ran; a load that stalls beside the
      // running build has no request there, so the running build's helper is left alone.
      if (job === this.running) void Promise.resolve().then(() => this.store.stop()).catch(error => log.warn("index_stop_failed", { directory: job.directory, ...errorFields(error) }));
      reject(stalledError(phase, period));
    };
    job.stalled = false;
    job.watchdog = () => { clearTimeout(job.stallTimer); job.stallTimer = setTimeout(fire, period); job.stallTimer.unref(); };
    job.watchdog();
    return stalled;
  }
  // A job that stalled has failed, so its abandoned build may not go on to copy, build, or save.
  alive(job: Job) { if (job.stalled) throw semanticError("preparation_failed", "The stalled build was stopped."); }
  report(job: Job, value: Progress & { index?: unknown }, embedded = Boolean(value.vectors)) {
    // A stopped build's late messages change nothing, and no reported value keeps vectors or an index.
    if (job.stalled) return;
    const { vectors: _vectors, index: _index, ...progress } = value;
    if (progressed(job.progress, progress, embedded)) job.watchdog?.();
    // A phase change is logged once, and the phase stays the index activity that a record of a stalled event loop names.
    if (job.progress?.phase !== progress.phase) {
      log.debug("index_phase", { directory: job.directory, component: job.component?.identity, phase: progress.phase, total: progress.total });
      if (job === this.running) log.activity.set("index", `${job.component?.identity ?? "project"} ${progress.phase}`);
    }
    job.progress = progress;
    job.recorder?.update(progress);
  }
  async build(source: NativeSource, snapshot: SourceSnapshot, location: Location, job: Job): Promise<PreparedIndex> {
    await privateDirectory(this.directory);
    // A component that waits for another session's lock keeps the assets it checked, so a later attempt does not hash the model files again.
    const assets = job.assets ??= await this.assets(value => this.report(job, value));
    const directory = await privateDirectory(location.directory);
    const generation = path.join(directory, `generation-${snapshot.sourceFingerprint}-${assets.assetIdentity}.json`);
    // A structure that a build of this content stored, in this session or another, answers structure at once, also while another session holds the lock.
    await this.loadStructure(job, directory, generation, snapshot, assets);
    // Another session's build holds the project lock, so a wait longer than a moment is reported rather than shown as the last step.
    const waiting = setTimeout(() => this.report(job, { phase: "waiting" }), 1000);
    waiting.unref();
    try {
      return await withArtifactLock(directory, () => withFileLock(directory, async () => {
        clearTimeout(waiting);
        this.alive(job);
        let previous: { index: IndexMetadata; indexPath: string; revision: string } | undefined;
        try {
          // A structure-only index answers structure but is never reused as complete, and its fragments hold no embedding that a build could reuse.
          let pointer = await optionalJson(generation);
          if (pointer && pointerStage(pointer) === "structure") { await this.loadStructure(job, directory, generation, snapshot, assets); pointer = null; }
          pointer ??= await optionalJson(path.join(directory, "current.json"));
          if (pointer && pointerStage(pointer) === "structure") pointer = null;
          if (!pointer) throw Object.assign(new Error("No complete index is stored."), { code: "ENOENT" });
          if (!pointer.revision || !/^[a-f\d]{64}$/.test(pointer.revision)) throw semanticError("corrupt_asset", "The index pointer has an invalid revision.");
          const indexPath = path.join(directory, `${pointer.revision}.json`);
          // The full index is read and checked in the index store's thread; only its metadata comes back.
          const index = await this.store.read(indexPath, pointer.revision);
          previous = { index, indexPath, revision: pointer.revision };
          if (index.snapshot === snapshot.sourceFingerprint && index.assetIdentity === assets.assetIdentity) {
            await source.verifySnapshot(); job.revision = pointer.revision; job.coverage = pointer.coverage; job.diagnostics = index.diagnostics; job.builtAt = pointer.builtAt;
            const used = new Date(); await utimes(indexPath, used, used).catch(() => {});
            // An index built before units sidecars existed gets its sidecar when it is reused.
            const sidecar = path.join(directory, unitsFile(pointer.revision));
            await lstat(sidecar).catch(() => writeAtomically(sidecar, JSON.stringify(publishedUnits(index, pointer.revision!)), { mode: 0o600 })).catch(() => {});
            log.info("index_reused", { directory, revision: pointer.revision, component: job.component?.identity });
            return { ...assets, index, indexPath, revision: pointer.revision, stage: "complete" };
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        // A load never builds beside the running build; it hands the job back to the build queue.
        if (job.reload && this.running !== job) throw reloadMiss();
        const mirror = await privateDirectory(path.join(directory, `snapshot-${randomUUID()}`));
        try {
          this.report(job, { phase: "snapshot-copy", current: 0, total: snapshot.files.length, unit: "files" });
          for (const [index, file] of snapshot.files.entries()) {
            this.alive(job);
            const target = path.resolve(mirror, file.file);
            if (!inside(mirror, target)) throw semanticError("invalid_path", "A snapshot path escapes its mirror.");
            await privateDirectory(path.dirname(target));
            const handle = await open(target, "wx", 0o400);
            try {
              const bytes = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
              if (sha(bytes) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
              await handle.writeFile(bytes);
            } finally { await handle.close(); }
            this.report(job, { phase: "snapshot-copy", current: index + 1, total: snapshot.files.length, unit: "files" });
          }
          await source.verifySnapshot();
          this.alive(job);
          // The structure is stored while the build goes on embedding, and the complete index is saved only after it, so the complete index replaces it.
          let structureSaved = Promise.resolve();
          const structure = (token: string) => { structureSaved = this.publishStructure(job, token, directory, generation, snapshot, assets); };
          const token = await this.store.build({ runtime: assets.runtime, directory, args: { mirror, files: snapshot.files.map(({ file, hash }) => ({ file, hash })),
            snapshot: snapshot.sourceFingerprint, modelDirectory: assets.modelDirectory, modelIdentity: assets.modelIdentity },
          ...(previous ? { previous: { indexPath: previous.indexPath, revision: previous.revision } } : {}) }, (progress, embedded) => this.report(job, progress, embedded), structure);
          this.report(job, { phase: "saving" });
          await structureSaved;
          try { this.alive(job); await source.verifySnapshot(); } catch (error) { await this.store.discard(token).catch(() => {}); throw error; }
          // The structure-only index that this complete index replaces, which no pointer names once the complete pointers are written.
          const replacedPointer = await optionalJson(generation).catch(() => null);
          const replaced = replacedPointer && pointerStage(replacedPointer) === "structure" && /^[a-f\d]{64}$/.test(replacedPointer.revision ?? "") ? [replacedPointer.revision!] : [];
          const { revision, indexPath, bytes, index } = await this.store.save(token, { directory, assetIdentity: assets.assetIdentity, incomplete: !snapshot.complete });
          const coverage = coverageOf(index);
          const builtAt = new Date().toISOString();
          const pointerContents = JSON.stringify({ snapshot: index.snapshot, revision, stage: "complete", chunkerVersion: index.chunkerVersion, coverage, diagnostics: index.diagnostics, builtAt });
          await writeAtomically(generation, pointerContents, { mode: 0o600 });
          await writeAtomically(path.join(directory, "current.json"), pointerContents, { mode: 0o600 });
          job.revision = revision; job.coverage = coverage; job.diagnostics = index.diagnostics; job.builtAt = builtAt;
          await rm(mirror, { recursive: true, force: true });
          await pruneIndexes(directory, revision, KEPT_INDEX_REVISIONS, replaced).catch(() => {});
          log.info("index_built", { directory, revision, component: job.component?.identity, files: snapshot.files.length, bytes, counts: index.counts,
            indexMs: Math.round(index.resources?.indexMilliseconds ?? 0), diagnostics: index.diagnostics.length });
          return { ...assets, index, indexPath, revision, stage: "complete" };
        } finally { await rm(mirror, { recursive: true, force: true }); }
      }, job.component ? heldError : semanticError, { renew: true, timeoutMs: job.component ? 250 : 120000 }));
    } finally { clearTimeout(waiting); }
  }
  // Sets a job's published structure once.
  structured(job: Job, prepared: PreparedIndex) {
    if (job.structure) return;
    job.structure = prepared;
    job.publish();
  }
  // Reads the structure-only index that the content's generation pointer names, when it names one; an unreadable one leaves the job to build.
  async loadStructure(job: Job, directory: string, generation: string, snapshot: SourceSnapshot, assets: Assets) {
    if (job.structure) return;
    try {
      const pointer = await optionalJson(generation);
      if (!pointer || pointerStage(pointer) !== "structure" || !/^[a-f\d]{64}$/.test(pointer.revision ?? "")) return;
      const indexPath = path.join(directory, `${pointer.revision}.json`), index = await this.store.read(indexPath, pointer.revision!);
      if (index.snapshot !== snapshot.sourceFingerprint || index.assetIdentity !== assets.assetIdentity) return;
      this.structured(job, { ...assets, index, indexPath, revision: pointer.revision!, stage: "structure" });
    } catch (error) { log.warn("index_structure_unreadable", { directory, component: job.component?.identity, ...errorFields(error) }); }
  }
  // Stores the structure that a running build reported, with its sidecar and pointers, unless a complete index of the same content is stored.
  // A structure that cannot be stored costs only the early answer, never the build.
  async publishStructure(job: Job, token: string, directory: string, generation: string, snapshot: SourceSnapshot, assets: Assets) {
    try {
      if (job.stalled) { await this.store.discard(token); return; }
      const existing = await optionalJson(generation).catch(() => null);
      if (existing?.revision && pointerStage(existing) === "complete") { await this.store.discard(token); return; }
      const { revision, indexPath, index } = await this.store.saveStructure(token, { directory, assetIdentity: assets.assetIdentity, incomplete: !snapshot.complete });
      if (job.stalled) return;
      const pointerContents = JSON.stringify({ snapshot: index.snapshot, revision, stage: "structure", chunkerVersion: index.chunkerVersion, coverage: coverageOf(index),
        diagnostics: index.diagnostics, builtAt: new Date().toISOString() });
      await writeAtomically(generation, pointerContents, { mode: 0o600 });
      await writeAtomically(path.join(directory, "current.json"), pointerContents, { mode: 0o600 });
      log.info("index_structure_published", { directory, revision, component: job.component?.identity });
      job.structure = undefined;
      this.structured(job, { ...assets, index, indexPath, revision, stage: "structure" });
    } catch (error) { log.warn("index_structure_unwritable", { directory, component: job.component?.identity, ...errorFields(error) }); }
  }
  // A build goes to the index store, whose default runs in a thread with its own helper; a search goes to the search helper here,
  // because a search answers with a few results and must not wait behind a build.
  get store(): IndexStore { return this.indexStore ??= new ThreadIndexStore({ ...this.options, directory: this.directory }); }
  set store(store: IndexStore) { this.indexStore = store; }
  /** A store that builds through this runtime's `helper` in this thread, for a helper that runs in process. */
  inProcessStore(): IndexStore {
    let used: string | undefined;
    return new LocalIndexStore((runtime, args, progress) => { used = runtime; return this.helper(runtime, "build").request("build", args, progress); },
      () => { if (used) this.helper(used, "build").stop?.(); });
  }
  helper(runtime: string, role: "build" | "search" = "search"): Pick<Helper, "request"> & Partial<Pick<Helper, "stop">> {
    let helper = this.processes.get(role);
    if (helper?.runtime !== runtime) { helper?.stop(); helper = new Helper(runtime, { ...this.options, directory: this.directory }, role); this.processes.set(role, helper); }
    return helper;
  }
  async search(prepared: PreparedIndex, source: NativeSource, query: string, filters: SearchFilters | undefined, limit: number) {
    await source.verifySnapshot();
    // A structure-only index holds no embeddings, so the runtime answers it from fragment text alone.
    const results = await this.helper(prepared.runtime, "search").request("search", { query, filters, limit, snapshot: prepared.index.snapshot,
      indexPath: prepared.indexPath, modelDirectory: prepared.modelDirectory, modelIdentity: prepared.modelIdentity, ...(prepared.stage === "structure" ? { mode: "lexical" as const } : {}) });
    await source.verifySnapshot();
    return results;
  }
  // Resolves once the helper processes and the index thread have ended, so a caller that exits next leaves no helper holding the runtime's files open.
  async close(): Promise<void> {
    const exits = [...this.processes.values()].map(helper => helper.close());
    this.processes.clear();
    await Promise.all([...exits, this.indexStore?.close()]);
    this.indexStore = undefined;
  }
}

export const nativeSemanticRuntime = new NativeSemanticRuntime();
