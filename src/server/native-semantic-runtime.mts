import path from "node:path";
import { pluginPath, pluginURL } from "./plugin-root.mjs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, readFile, open, rename, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withFileLock, withArtifactLock, writeAtomically } from "./artifact-store.mjs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { NativeSource, SourceSnapshot, ConceptIndex, PreparedIndex, Preparation, Progress, Diagnostic, WorkerMethods, SearchFilters, SemanticRuntime, Counts } from "./repository-concept-types.mjs";

interface Asset { url: string; bytes: number; sha256: string; unpackedBytes?: number }
interface AssetManifest { schemaVersion: 1; identity: string; assetVersion: string; bundles: Record<string, Asset>; model: { id: string; revision: string; files: (Omit<Asset, "url"> & { path: string; url?: string })[] } }
interface Options { directory?: string; manifestPath?: string; idleMs?: number }
interface Coverage extends Counts { structurallyCoveredFiles: number; complete: boolean }
interface Job { id: string; snapshot: string; status: Preparation["status"]; diagnostics: Diagnostic[]; promise: Promise<void>; prepared?: PreparedIndex; revision?: string; progress?: Progress; coverage?: Coverage }
interface Location { root: string; directory: string }
interface IndexPointer { snapshot?: string; revision?: string; chunkerVersion?: string; coverage?: Coverage; diagnostics?: Diagnostic[] }

export const semanticError = (code: string, message: string) => Object.assign(new Error(message), { code });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const supported = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);
const boundedWait = (promise: Promise<void>, ms: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
const indexMetadata = ({ chunks: _chunks, ...metadata }: ConceptIndex) => metadata;
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

export async function assertSafeAncestors(target: string): Promise<void> {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw semanticError("invalid_path", "Private storage must not follow a symlink ancestor.");
  }
}

export async function regularBytes(file: string, max = 512 * 1024 * 1024) {
  await assertSafeAncestors(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw semanticError("invalid_path", "A cache file must be a regular file.");
  if (info.size > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
    const bytes = await handle.readFile();
    if (bytes.length > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
    return bytes;
  } finally { await handle.close(); }
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse((await regularBytes(file)).toString("utf8")); }

async function download(asset: Asset, destination: string, allowFile: boolean) {
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
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw semanticError("preparation_failed", `The asset download returned HTTP ${response.status}.`);
    if (!response.body) throw semanticError("preparation_failed", "The asset download returned no body.");
    body = response.body;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600), digest = createHash("sha256");
  let length = 0;
  try {
    for await (const chunk of body) {
      length += chunk.length;
      if (length > asset.bytes) throw semanticError("corrupt_asset", "The downloaded asset exceeds its pinned size.");
      digest.update(chunk); await handle.writeFile(chunk);
    }
    if (length !== asset.bytes || digest.digest("hex") !== asset.sha256) throw semanticError("corrupt_asset", "The downloaded asset failed its integrity check.");
    await handle.sync(); await handle.close();
    await rename(temporary, destination);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}

class Helper {
  child: ChildProcessWithoutNullStreams | null = null;
  idle?: NodeJS.Timeout;
  requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; progress?: (value: Progress) => void }>();
  counter = 0;
  constructor(public runtime: string, private options: Options) {}
  start() {
    if (this.child) return;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(CODEGRAPH_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete environment[key];
    Object.assign(environment, { PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
    const args = ["--liftoff-only", "--permission", `--allow-fs-read=${this.runtime}`, `--allow-fs-read=${this.options.directory}`, `--allow-fs-write=${this.options.directory}`, "--allow-addons", path.join(this.runtime, "worker.mjs")];
    const child = spawn(path.join(this.runtime, process.platform === "win32" ? "node.exe" : "node"), args, { env: environment, cwd: this.runtime, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr.on("data", () => {});
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      let message: { id: number; progress?: Progress; error?: { code: string; message: string }; result?: unknown };
      try { message = JSON.parse(line); } catch { return this.stop(semanticError("preparation_failed", "The native helper returned invalid data.")); }
      const pending = this.requests.get(message.id);
      if (!pending) return;
      if (message.progress) { pending.progress?.(message.progress); return; }
      this.requests.delete(message.id); clearTimeout(pending.timeout);
      if (message.error) pending.reject(semanticError(message.error.code, message.error.message)); else pending.resolve(message.result);
      if (!this.requests.size) { this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 300000); this.idle.unref(); }
    });
    child.once("error", () => this.stop(semanticError("unsupported_runtime", "The bundled Node helper could not start.")));
    child.once("exit", () => { if (this.child === child) this.stop(semanticError("preparation_failed", "The native helper exited before completing its request.")); });
  }
  request<K extends keyof WorkerMethods>(method: K, args: WorkerMethods[K]["input"], progress?: (value: Progress) => void): Promise<WorkerMethods[K]["output"]> {
    clearTimeout(this.idle); this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timeout = setTimeout(() => this.stop(semanticError("resource_limit", "Native preparation exceeded its 30 minute operation limit.")), 30 * 60 * 1000);
      timeout.unref(); this.requests.set(id, { resolve: value => resolve(value as WorkerMethods[K]["output"]), reject, timeout, progress });
      this.child!.stdin.write(`${JSON.stringify({ id, method, args })}\n`, error => { if (error) this.stop(semanticError("preparation_failed", "The native helper input channel failed.")); });
    });
  }
  stop(error = semanticError("preparation_failed", "The native helper stopped.")) {
    clearTimeout(this.idle);
    const child = this.child; this.child = null; child?.kill();
    for (const request of this.requests.values()) { clearTimeout(request.timeout); request.reject(error); }
    this.requests.clear();
  }
}

export class NativeSemanticRuntime implements SemanticRuntime {
  directory: string;
  manifestPath: string;
  jobs = new Map<string, Job>();
  generations = new Map<string, Job>();
  sequence: Promise<void> = Promise.resolve();
  pinned?: AssetManifest;
  process?: Helper;
  verifiedRuntime?: string;
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
  async location(projectRoot: string): Promise<Location> {
    const root = await realpath(projectRoot);
    if (inside(root, this.directory)) throw semanticError("invalid_path", "Native storage must be outside the target project.");
    return { root, directory: path.join(this.directory, "projects", sha(root)) };
  }
  async status(projectRoot: string, waitMs = 0) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw semanticError("validation_failed", "waitMs must be from 0 through 30000.");
    const location = await this.location(projectRoot), job = this.jobs.get(location.root);
    if (waitMs && job?.status === "preparing") await boundedWait(job.promise, waitMs);
    const manifest = await this.manifest();
    let published: IndexPointer | undefined;
    try { published = await readJson<IndexPointer>(path.join(location.directory, "current.json")); } catch (error) { if (error.code !== "ENOENT") published = { diagnostics: [{ code: "corrupt_asset", message: "The previous index pointer is invalid. Rebuild the index." }] }; }
    return { status: job?.status || (published?.snapshot ? "indexed" : "unprepared"), preparationId: job?.id || null,
      snapshot: job?.snapshot || published?.snapshot || null, indexRevision: job?.revision || published?.revision || null,
      progress: job?.progress || null, coverage: job?.coverage || published?.coverage || null,
      versions: { runtime: manifest.assetVersion, model: `${manifest.model.id}@${manifest.model.revision}`, graph: "1.6.0",
        chunker: job?.prepared?.index.chunkerVersion || published?.chunkerVersion || null },
      runtime: { supported: supported.has(`${process.platform}-${process.arch}`), published: Boolean(manifest.bundles[`${process.platform}-${process.arch}`]) },
      structuralCapabilities: { code: ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C#", "C", "C++"], documents: ["Markdown", "JSON", "YAML"] },
      limits: { files: 20000, sourceBytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, sdkFileBytes: 1024 * 1024, modelTokens: 512 },
      diagnostics: job?.diagnostics || published?.diagnostics || [], freshness: "verify-on-use" };
  }
  async assets(progress: (value: Progress) => void) {
    const manifest = await this.manifest(), platform = `${process.platform}-${process.arch}`, asset = manifest.bundles[platform];
    if (!supported.has(platform)) throw semanticError("unsupported_runtime", `Native semantics does not support ${platform}.`);
    if (!asset) throw semanticError("unsupported_runtime", `No immutable native runtime asset is published for ${platform}.`);
    const assets = await privateDirectory(path.join(this.directory, "assets"));
    const runtime = path.join(assets, asset.sha256), modelDirectory = path.join(assets, sha(JSON.stringify(manifest.model)));
    const allowFile = Boolean(this.options.manifestPath || process.env.PRISM_NATIVE_ASSET_MANIFEST);
    await withArtifactLock(runtime, () => withFileLock(runtime, async () => {
      try { await this.verifyRuntime(runtime, platform); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      progress({ phase: "runtime-download" });
      const archive = `${runtime}.tar.gz`;
      await download(asset, archive, allowFile);
      const staging = await privateDirectory(`${runtime}.${randomUUID()}.tmp`);
      try {
        const { extractRuntime } = await import(pluginURL("vendor/native-runtime/extract.mjs").href);
        await extractRuntime(archive, staging, asset.unpackedBytes);
        await this.verifyRuntime(staging, platform);
        await chmod(path.join(staging, process.platform === "win32" ? "node.exe" : "node"), 0o700);
        await rename(staging, runtime);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }, semanticError, { renew: true, timeoutMs: 120000 })) ;
    await privateDirectory(modelDirectory);
    await withArtifactLock(modelDirectory, () => withFileLock(modelDirectory, async () => {
      for (const file of manifest.model.files) {
        if (file.path.includes("..") || path.isAbsolute(file.path)) throw semanticError("corrupt_asset", "The model asset path is invalid.");
        const target = path.join(modelDirectory, file.path); await privateDirectory(path.dirname(target));
        progress({ phase: "model-download", file: file.path });
        await download({ ...file, url: file.url || `https://huggingface.co/${manifest.model.id}/resolve/${manifest.model.revision}/${file.path}` }, target, allowFile);
      }
    }, semanticError, { renew: true, timeoutMs: 120000 }));
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
  async prepare(source: NativeSource, expectedSnapshot?: string, waitMs = 10000): Promise<Preparation> {
    if (expectedSnapshot !== undefined && (typeof expectedSnapshot !== "string" || !/^[a-f\d]{64}$/.test(expectedSnapshot))) throw semanticError("validation_failed", "expectedSnapshot must be a SHA-256 snapshot identity.");
    const snapshot = await source.snapshot(), location = await this.location(snapshot.root);
    if (expectedSnapshot && expectedSnapshot !== snapshot.sourceFingerprint) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
    const manifest = await this.manifest();
    const generationKey = `${location.root}\0${snapshot.sourceFingerprint}\0${manifest.identity}`;
    let job = this.generations.get(generationKey);
    if (job?.snapshot !== snapshot.sourceFingerprint || job?.status === "degraded") {
      job = { id: sha(`${location.root}\0${snapshot.sourceFingerprint}\0${manifest.identity}`), snapshot: snapshot.sourceFingerprint, status: "preparing", diagnostics: [], promise: Promise.resolve() };
      this.jobs.set(location.root, job);
      this.generations.set(generationKey, job);
      const preparing = job;
      job.promise = this.sequence = this.sequence.catch(() => {}).then(async () => {
        try { preparing.prepared = await this.build(source, snapshot, location, preparing); preparing.status = "ready"; }
        catch (error) { preparing.status = "degraded"; preparing.diagnostics = [{ code: stableFailure(error), message: error.message, recovery: "Retry preparation after correcting the reported runtime, network, or source problem." }]; }
      });
    }
    this.jobs.set(location.root, job);
    if (job.status === "preparing") await boundedWait(job.promise, Math.min(waitMs, 10000));
    return { status: job.status, preparationId: job.id, snapshot: job.snapshot, diagnostics: job.diagnostics, prepared: job.prepared };
  }
  async build(source: NativeSource, snapshot: SourceSnapshot, location: Location, job: Job): Promise<PreparedIndex> {
    await privateDirectory(this.directory);
    const assets = await this.assets(value => { job.progress = value; });
    const directory = await privateDirectory(location.directory);
    return withArtifactLock(directory, () => withFileLock(directory, async () => {
      let previous: ConceptIndex | undefined;
      try {
        const pointer = await readJson<IndexPointer>(path.join(directory, `generation-${snapshot.sourceFingerprint}-${assets.assetIdentity}.json`))
          .catch(error => { if (error.code !== "ENOENT") throw error; return readJson<IndexPointer>(path.join(directory, "current.json")); });
        if (!pointer.revision || !/^[a-f\d]{64}$/.test(pointer.revision)) throw semanticError("corrupt_asset", "The index pointer has an invalid revision.");
        const indexPath = path.join(directory, `${pointer.revision}.json`), bytes = await regularBytes(indexPath);
        if (sha(bytes) !== pointer.revision) throw semanticError("corrupt_asset", "The concept index failed its integrity check.");
        previous = JSON.parse(bytes.toString("utf8")) as ConceptIndex;
        if (previous.snapshot === snapshot.sourceFingerprint && previous.assetIdentity === assets.assetIdentity) {
          await source.verifySnapshot(); job.revision = pointer.revision; job.coverage = pointer.coverage; job.diagnostics = previous.diagnostics;
          return { ...assets, index: indexMetadata(previous), indexPath, revision: pointer.revision };
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const mirror = await privateDirectory(path.join(directory, `snapshot-${randomUUID()}`));
      try {
        for (const file of snapshot.files) {
          const target = path.resolve(mirror, file.file);
          if (!inside(mirror, target)) throw semanticError("invalid_path", "A snapshot path escapes its mirror.");
          await privateDirectory(path.dirname(target));
          const handle = await open(target, "wx", 0o400);
          try {
            const bytes = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
            if (sha(bytes) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
            await handle.writeFile(bytes);
          } finally { await handle.close(); }
        }
        await source.verifySnapshot();
        const previousEmbeddings = Object.fromEntries((previous?.chunks || []).filter(chunk => chunk.embeddingKey && chunk.embedding).map(chunk => [chunk.embeddingKey!, chunk.embedding!]));
        const indexStarted = performance.now();
        const index = await this.helper(assets.runtime).request("build", { mirror, files: snapshot.files.map(({ file, hash }) => ({ file, hash })),
          snapshot: snapshot.sourceFingerprint, modelDirectory: assets.modelDirectory, modelIdentity: assets.modelIdentity, previousEmbeddings }, progress => { job.progress = progress; });
        index.resources = { ...index.resources, indexMilliseconds: performance.now() - indexStarted };
        await source.verifySnapshot();
        index.assetIdentity = assets.assetIdentity;
        if (!snapshot.complete) { index.structureComplete = false; index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." }); }
        const contents = JSON.stringify(index), revision = sha(contents), indexPath = path.join(directory, `${revision}.json`);
        if (Buffer.byteLength(contents) > 512 * 1024 * 1024) throw semanticError("resource_limit", "The concept index exceeds 512 MiB.");
        await writeAtomically(indexPath, contents, { mode: 0o600 });
        const coverage = { ...index.counts, structurallyCoveredFiles: Object.values(index.fileCoverage).filter(Boolean).length, complete: index.structureComplete && Object.values(index.fileCoverage).every(Boolean) };
        const pointerContents = JSON.stringify({ snapshot: index.snapshot, revision, chunkerVersion: index.chunkerVersion, coverage, diagnostics: index.diagnostics });
        await writeAtomically(path.join(directory, `generation-${snapshot.sourceFingerprint}-${assets.assetIdentity}.json`), pointerContents, { mode: 0o600 });
        await writeAtomically(path.join(directory, "current.json"), pointerContents, { mode: 0o600 });
        job.revision = revision; job.coverage = coverage; job.diagnostics = index.diagnostics;
        return { ...assets, index: indexMetadata(index), indexPath, revision };
      } finally { await rm(mirror, { recursive: true, force: true }); }
    }, semanticError, { renew: true, timeoutMs: 120000 }));
  }
  helper(runtime: string): Helper {
    if (this.process?.runtime !== runtime) { this.process?.stop(); this.process = new Helper(runtime, { ...this.options, directory: this.directory }); }
    return this.process;
  }
  async search(prepared: PreparedIndex, source: NativeSource, query: string, filters: SearchFilters | undefined, limit: number) {
    await source.verifySnapshot();
    const results = await this.helper(prepared.runtime).request("search", { query, filters, limit, snapshot: prepared.index.snapshot,
      indexPath: prepared.indexPath, modelDirectory: prepared.modelDirectory, modelIdentity: prepared.modelIdentity });
    await source.verifySnapshot();
    return results;
  }
  close() { this.process?.stop(); }
}

export const nativeSemanticRuntime = new NativeSemanticRuntime();
