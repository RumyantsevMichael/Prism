// Generated from src/server/repository-intelligence/native-semantic-runtime.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { pluginPath, pluginURL } from "../plugin-root.mjs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, readdir, open, rename, rm, chmod, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withFileLock, withArtifactLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { ProgressRecorder, componentStorageKey, gitFingerprint, projectStorageKey, sameFingerprint, writeFreshness } from "./index-progress.mjs";
const semanticError = (code, message) => Object.assign(new Error(message), { code });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const supported = /* @__PURE__ */ new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);
const boundedWait = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
const indexMetadata = ({ chunks: _chunks, ...metadata }) => metadata;
const busy = (job) => job?.status === "waiting" || job?.status === "preparing";
const LOCK_RETRY_MS = 2e3;
const UNRENEWED_LOCK_MS = 3e4;
const heldError = (code, message) => Object.assign(semanticError(code, message), { held: code === "lock_timeout" });
const stableFailure = (error) => ["invalid_path", "lock_timeout", "stale_snapshot", "unsupported_runtime", "corrupt_asset", "resource_limit", "validation_failed"].includes(error.code || "") ? error.code : error.code === "snapshot-changed" ? "stale_snapshot" : "preparation_failed";
async function privateDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try {
      await assertSafeAncestors(parent);
      const info2 = await lstat(parent);
      if (info2.isSymbolicLink() || !info2.isDirectory()) throw semanticError("invalid_path", "A private storage parent is not a directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await privateDirectory(parent);
    }
  }
  await mkdir(directory, { mode: 448 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== path.resolve(directory)) throw semanticError("invalid_path", "Private storage must not follow a symlink.");
  await chmod(directory, 448);
  return directory;
}
async function assertSafeAncestors(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw semanticError("invalid_path", "Private storage must not follow a symlink ancestor.");
  }
}
async function regularBytes(file, max = 512 * 1024 * 1024) {
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
  } finally {
    await handle.close();
  }
}
async function readJson(file) {
  return JSON.parse((await regularBytes(file)).toString("utf8"));
}
async function download(asset, destination, allowFile, onBytes = () => {
}) {
  const valid = async () => {
    try {
      const bytes = await regularBytes(destination, asset.bytes);
      return bytes.length === asset.bytes && sha(bytes) === asset.sha256;
    } catch (error) {
      if (error.code === "invalid_path") throw error;
      return false;
    }
  };
  if (await valid()) return;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f\d]{64}$/.test(asset.sha256)) throw semanticError("corrupt_asset", "The pinned asset metadata is invalid.");
  const url = new URL(asset.url);
  let body;
  if (allowFile && url.protocol === "file:") body = [await regularBytes(fileURLToPath(url), asset.bytes)];
  else {
    if (url.protocol !== "https:") throw semanticError("corrupt_asset", "Runtime assets require HTTPS.");
    const response = await fetch(url, { signal: AbortSignal.timeout(12e4) }).catch((error) => {
      throw semanticError("preparation_failed", `The asset download from ${url.host} failed: ${error.cause?.code || error.message}.`);
    });
    if (!response.ok) throw semanticError("preparation_failed", `The asset download from ${url.host} returned HTTP ${response.status}.`);
    if (!response.body) throw semanticError("preparation_failed", `The asset download from ${url.host} returned no body.`);
    body = response.body;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 384), digest = createHash("sha256");
  let length = 0;
  try {
    for await (const chunk of body) {
      length += chunk.length;
      if (length > asset.bytes) throw semanticError("corrupt_asset", "The downloaded asset exceeds its pinned size.");
      digest.update(chunk);
      await handle.writeFile(chunk);
      onBytes(length, asset.bytes);
    }
    if (length !== asset.bytes || digest.digest("hex") !== asset.sha256) throw semanticError("corrupt_asset", "The downloaded asset failed its integrity check.");
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } finally {
    await handle.close().catch(() => {
    });
    await rm(temporary, { force: true });
  }
}
async function downloadFirst(asset, urls, destination, allowFile, onBytes) {
  const failures = [];
  let code = "preparation_failed";
  for (const url of urls) {
    try {
      return await download({ ...asset, url }, destination, allowFile, onBytes);
    } catch (error) {
      if (error.code === "invalid_path") throw error;
      failures.push(error.message);
      code = error.code || code;
    }
  }
  throw semanticError(code, failures.join(" "));
}
const modelAssetName = (file) => `model-${file.split("/").join("-")}`;
const STALE_ASSET_MS = 14 * 24 * 60 * 60 * 1e3;
const KEPT_INDEX_REVISIONS = 4;
const UNITS_FILE = /^units-([a-f\d]{64})\.json$/;
const unitsFile = (revision) => `units-${revision}.json`;
function publishedUnits(index, revision) {
  const edges = /* @__PURE__ */ new Map();
  for (const edge of index.edges) if (edge.kind === "calls" || edge.kind === "references") edges.set(`${edge.source}\0${edge.target}`, [edge.source, edge.target]);
  return {
    schemaVersion: 1,
    snapshot: index.snapshot,
    revision,
    units: index.units.map(({ id, file, kind, name, qualifiedName, range, sourceHash }) => ({
      id,
      file,
      kind,
      name,
      ...qualifiedName === void 0 ? {} : { qualifiedName },
      range: { startLine: range.startLine, endLine: range.endLine },
      ...sourceHash === void 0 ? {} : { sourceHash }
    })),
    edges: [...edges.values()]
  };
}
async function pruneIndexes(directory, current, keep = KEPT_INDEX_REVISIONS) {
  const entries = await readdir(directory);
  const revisions = await Promise.all(entries.filter((name) => /^[a-f\d]{64}\.json$/.test(name)).map(async (name) => ({ name, used: (await lstat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const kept = /* @__PURE__ */ new Set([`${current}.json`, ...revisions.sort((a, b) => b.used - a.used).slice(0, keep).map((revision) => revision.name)]);
  for (const { name } of revisions) if (!kept.has(name)) await rm(path.join(directory, name), { force: true });
  for (const name of entries) {
    if (name.startsWith("snapshot-")) {
      await rm(path.join(directory, name), { recursive: true, force: true });
      continue;
    }
    const sidecar = UNITS_FILE.exec(name);
    if (sidecar) {
      if (!kept.has(`${sidecar[1]}.json`)) await rm(path.join(directory, name), { force: true });
      continue;
    }
    if (!/^generation-.+\.json$/.test(name)) continue;
    const pointer = await readJson(path.join(directory, name)).catch(() => ({}));
    if (!pointer.revision || !kept.has(`${pointer.revision}.json`)) await rm(path.join(directory, name), { force: true });
  }
}
async function pruneAssets(directory, keep, maxAgeMs = STALE_ASSET_MS, now = Date.now()) {
  const entries = await readdir(directory);
  for (const name of entries) {
    if (keep.has(name) || name.endsWith(".lock")) continue;
    const archive = name.endsWith(".tar.gz") && entries.includes(name.slice(0, -".tar.gz".length));
    const info = await lstat(path.join(directory, name)).catch(() => null);
    if (info && (archive || now - info.mtimeMs > maxAgeMs)) await rm(path.join(directory, name), { recursive: true, force: true });
  }
}
class Helper {
  constructor(runtime, options) {
    this.runtime = runtime;
    this.options = options;
  }
  child = null;
  idle;
  requests = /* @__PURE__ */ new Map();
  counter = 0;
  start() {
    if (this.child) return;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(CODEGRAPH_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete environment[key];
    Object.assign(environment, { PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
    const args = ["--liftoff-only", "--permission", `--allow-fs-read=${this.runtime}`, `--allow-fs-read=${this.options.directory}`, `--allow-fs-write=${this.options.directory}`, "--allow-addons", path.join(this.runtime, "worker.mjs")];
    const child = spawn(path.join(this.runtime, process.platform === "win32" ? "node.exe" : "node"), args, { env: environment, cwd: this.runtime, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr.on("data", () => {
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.stop(semanticError("preparation_failed", "The native helper returned invalid data."));
      }
      const pending = this.requests.get(message.id);
      if (!pending) return;
      if (message.progress) {
        pending.progress?.(message.progress);
        return;
      }
      this.requests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(semanticError(message.error.code, message.error.message));
      else pending.resolve(message.result);
      if (!this.requests.size) {
        this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 3e5);
        this.idle.unref();
      }
    });
    child.once("error", () => this.stop(semanticError("unsupported_runtime", "The bundled Node helper could not start.")));
    child.once("exit", () => {
      if (this.child === child) this.stop(semanticError("preparation_failed", "The native helper exited before completing its request."));
    });
  }
  request(method, args, progress) {
    clearTimeout(this.idle);
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timeout = setTimeout(() => this.stop(semanticError("resource_limit", "Native preparation exceeded its 30 minute operation limit.")), this.options.operationMs ?? 30 * 60 * 1e3);
      timeout.unref();
      this.requests.set(id, { resolve: (value) => resolve(value), reject, timeout, progress });
      this.child.stdin.write(`${JSON.stringify({ id, method, args })}
`, (error) => {
        if (error) this.stop(semanticError("preparation_failed", "The native helper input channel failed."));
      });
    });
  }
  stop(error = semanticError("preparation_failed", "The native helper stopped.")) {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.requests.clear();
  }
}
class NativeSemanticRuntime {
  constructor(options = {}) {
    this.options = options;
    const hostData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
    this.directory = path.resolve(options.directory || (hostData ? path.join(hostData, "native-intelligence") : path.join(os.homedir(), ".cache", "prism", "native-intelligence")));
    this.manifestPath = options.manifestPath || process.env.PRISM_NATIVE_ASSET_MANIFEST || pluginPath("vendor/native-runtime/manifest.json");
  }
  directory;
  manifestPath;
  // The latest job of each storage location, the jobs of recent contents, and the component contents that reached a native limit in this process.
  jobs = /* @__PURE__ */ new Map();
  generations = /* @__PURE__ */ new Map();
  limited = /* @__PURE__ */ new Map();
  // One preparation runs at a time; the jobs waiting for it are in queue order, which a later call can change.
  queue = [];
  running = null;
  // Settles when no job runs or waits.
  sequence = Promise.resolve();
  idle;
  pinned;
  // Builds and searches have a helper each, because a helper answers one request at a time and a build can run for many minutes,
  // while a search of a component that is ready must answer within its call's bound and must not fail when another component's build times out.
  processes = /* @__PURE__ */ new Map();
  // Counts snapshot reads, so a newer read of a location's live content can replace a job for content read before it.
  reads = 0;
  verifiedRuntime;
  async manifest() {
    if (!this.pinned) {
      const data = await regularBytes(this.manifestPath, 1024 * 1024), manifest = JSON.parse(data.toString("utf8"));
      if (manifest.schemaVersion !== 1 || !manifest.model?.revision || !manifest.bundles) throw semanticError("corrupt_asset", "The native asset manifest is invalid.");
      this.pinned = { ...manifest, identity: sha(data) };
    }
    return this.pinned;
  }
  async location(projectRoot, component) {
    const root = await realpath(projectRoot);
    if (inside(root, this.directory)) throw semanticError("invalid_path", "Native storage must be outside the target project.");
    const key = component ? componentStorageKey(root, component.folder === "" ? "" : component.name) : projectStorageKey(root);
    return { root, directory: path.join(this.directory, "projects", key) };
  }
  async published(directory) {
    try {
      return await readJson(path.join(directory, "current.json"));
    } catch (error) {
      if (error.code !== "ENOENT") return { diagnostics: [{ code: "corrupt_asset", message: "The previous index pointer is invalid. Rebuild the index." }] };
    }
    return void 0;
  }
  async status(projectRoot, waitMs = 0) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3e4) throw semanticError("validation_failed", "waitMs must be from 0 through 30000.");
    const location = await this.location(projectRoot);
    const { indexComponents, componentSources } = await import("./component-indexes.mjs");
    const declaration = await indexComponents(location.root);
    if (declaration) return this.componentStatus(location.root, componentSources(location.root, declaration), waitMs);
    const job = this.jobs.get(location.directory);
    if (waitMs && busy(job)) await boundedWait(job.promise, waitMs);
    const published = await this.published(location.directory);
    return {
      status: job ? this.legacyStatus(job) : published?.snapshot ? "indexed" : "unprepared",
      preparationId: job?.id || null,
      snapshot: job?.snapshot || published?.snapshot || null,
      indexRevision: job?.revision || published?.revision || null,
      progress: job?.progress || null,
      coverage: job?.coverage || published?.coverage || null,
      ...await this.statusFacts(job?.prepared?.index.chunkerVersion || published?.chunkerVersion || null),
      diagnostics: job?.diagnostics || published?.diagnostics || [],
      freshness: "verify-on-use"
    };
  }
  // A repository without components has one job, which reports a queued preparation as preparing, as it always has.
  legacyStatus(job) {
    return job.status === "waiting" ? "preparing" : job.status;
  }
  async statusFacts(chunker) {
    const manifest = await this.manifest();
    return {
      versions: { runtime: manifest.assetVersion, model: `${manifest.model.id}@${manifest.model.revision}`, graph: "1.6.0", chunker },
      runtime: await this.availability(),
      structuralCapabilities: { code: ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C#", "C", "C++"], documents: ["Markdown", "JSON", "YAML"] },
      limits: { files: 2e4, sourceBytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, sdkFileBytes: 1024 * 1024, modelTokens: 512 }
    };
  }
  // Each component that holds a scanned file, in component order, with the state of its latest job in this process or of its published index.
  async componentStatus(root, sources, waitMs) {
    const held = [];
    for (const entry of sources) if ((await entry.source.snapshot()).files.length) held.push({ ...entry, location: await this.location(root, { name: entry.name, identity: entry.component, folder: entry.folder }) });
    const directories = new Map(held.map((entry) => [entry.location.directory, entry.component]));
    if (waitMs && this.running && directories.has(this.running.directory)) await boundedWait(this.running.promise, waitMs);
    const components = [], diagnostics = [];
    let chunker = null;
    for (const { component, folder, location } of held) {
      const job = this.jobs.get(location.directory), published = await this.published(location.directory);
      const status2 = job ? job.status : published?.snapshot ? "indexed" : "unprepared", own = job ? job.diagnostics : published?.diagnostics || [];
      chunker ??= job?.prepared?.index.chunkerVersion || published?.chunkerVersion || null;
      components.push({
        component,
        folder,
        status: status2,
        preparationId: job?.id || null,
        snapshot: job?.snapshot || published?.snapshot || null,
        indexRevision: job?.revision || published?.revision || null,
        builtAt: job?.builtAt || published?.builtAt || null,
        progress: job?.status === "preparing" && job.progress ? { ...job.progress, component } : null,
        coverage: job?.coverage || published?.coverage || null,
        failure: job?.status === "degraded" ? job.failure : null,
        diagnosticCount: own.length
      });
      diagnostics.push(...own.map((item) => ({ ...item, component })));
    }
    const running = this.running && directories.has(this.running.directory) && this.running.progress ? { ...this.running.progress, component: directories.get(this.running.directory) } : null;
    const states = components.map((entry) => entry.status);
    const status = states.some((state) => state === "waiting" || state === "preparing") ? "preparing" : states.includes("degraded") ? "degraded" : components.some((entry) => entry.indexRevision) ? "indexed" : "unprepared";
    return {
      status,
      preparationId: null,
      snapshot: null,
      indexRevision: null,
      progress: running,
      coverage: null,
      ...await this.statusFacts(chunker),
      diagnostics,
      freshness: "verify-on-use",
      components
    };
  }
  async availability() {
    const manifest = await this.manifest(), platform = `${process.platform}-${process.arch}`;
    return { supported: supported.has(platform), published: Boolean(manifest.bundles[platform]) };
  }
  async assets(progress) {
    const manifest = await this.manifest(), platform = `${process.platform}-${process.arch}`, asset = manifest.bundles[platform];
    if (!supported.has(platform)) throw semanticError("unsupported_runtime", `Native semantics does not support ${platform}.`);
    if (!asset) throw semanticError("unsupported_runtime", `No immutable native runtime asset is published for ${platform}.`);
    const assets = await privateDirectory(path.join(this.directory, "assets"));
    const runtime = path.join(assets, asset.sha256), modelDirectory = path.join(assets, sha(JSON.stringify(manifest.model)));
    const allowFile = Boolean(this.options.manifestPath || process.env.PRISM_NATIVE_ASSET_MANIFEST);
    progress({ phase: "assets-check" });
    await withArtifactLock(runtime, () => withFileLock(runtime, async () => {
      try {
        await this.verifyRuntime(runtime, platform);
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      progress({ phase: "runtime-download", current: 0, total: asset.bytes, unit: "bytes" });
      const archive = `${runtime}.tar.gz`;
      await download(asset, archive, allowFile, (current, total) => progress({ phase: "runtime-download", current, total, unit: "bytes" }));
      const staging = await privateDirectory(`${runtime}.${randomUUID()}.tmp`);
      try {
        progress({ phase: "runtime-extract" });
        const { extractRuntime } = await import(pluginURL("vendor/native-runtime/extract.mjs").href);
        await extractRuntime(archive, staging, asset.unpackedBytes);
        await this.verifyRuntime(staging, platform);
        await chmod(path.join(staging, process.platform === "win32" ? "node.exe" : "node"), 448);
        await rename(staging, runtime);
      } finally {
        await rm(staging, { recursive: true, force: true });
        await rm(archive, { force: true });
      }
    }, semanticError, { renew: true, timeoutMs: 12e4 }));
    await privateDirectory(modelDirectory);
    await withArtifactLock(modelDirectory, () => withFileLock(modelDirectory, async () => {
      for (const [index, file] of manifest.model.files.entries()) {
        if (file.path.includes("..") || path.isAbsolute(file.path)) throw semanticError("corrupt_asset", "The model asset path is invalid.");
        const target = path.join(modelDirectory, file.path);
        await privateDirectory(path.dirname(target));
        const step = { phase: "model-download", file: file.path, item: index + 1, items: manifest.model.files.length, unit: "bytes" };
        const urls = file.url ? [file.url] : [
          ...manifest.modelMirror ? [`${manifest.modelMirror}/${modelAssetName(file.path)}`] : [],
          `https://huggingface.co/${manifest.model.id}/resolve/${manifest.model.revision}/${file.path}`
        ];
        await downloadFirst(file, urls, target, allowFile, (current, total) => progress({ ...step, current, total }));
      }
    }, semanticError, { renew: true, timeoutMs: 12e4 }));
    const used = /* @__PURE__ */ new Date();
    for (const directory of [runtime, modelDirectory]) await utimes(directory, used, used).catch(() => {
    });
    await pruneAssets(assets, /* @__PURE__ */ new Set([path.basename(runtime), path.basename(modelDirectory)])).catch(() => {
    });
    return { runtime, modelDirectory, modelIdentity: sha(JSON.stringify(manifest.model)), assetIdentity: manifest.identity };
  }
  async verifyRuntime(directory, platform) {
    if (this.verifiedRuntime === directory) return;
    const metadata = await readJson(path.join(directory, "runtime.json"));
    if (metadata.schemaVersion !== 1 || metadata.platform !== platform || metadata.node !== "24.16.0" || !metadata.files?.["worker.mjs"]) throw semanticError("corrupt_asset", "The runtime identity does not match the pinned platform.");
    for (const [relative, digest] of Object.entries(metadata.files)) {
      const file = path.resolve(directory, relative);
      if (!inside(directory, file) || sha(await regularBytes(file)) !== digest) throw semanticError("corrupt_asset", "A runtime file failed its integrity check.");
    }
    this.verifiedRuntime = directory;
  }
  async prepare(source, expectedSnapshot, waitMs = 1e4) {
    if (expectedSnapshot !== void 0 && (typeof expectedSnapshot !== "string" || !/^[a-f\d]{64}$/.test(expectedSnapshot))) throw semanticError("validation_failed", "expectedSnapshot must be a SHA-256 snapshot identity.");
    const [job] = await this.enqueue([{ source }], expectedSnapshot);
    if (busy(job)) await boundedWait(job.promise, Math.min(waitMs, 1e4));
    return { status: this.legacyStatus(job), preparationId: job.id, snapshot: job.snapshot, diagnostics: job.diagnostics, prepared: job.prepared };
  }
  // Queues the components a call needs, in the order given, and waits at most the call's bound in total for all of them.
  // `retryLimited` prepares again a component whose content reached a native limit in this process, as the review browser's rebuild does.
  async prepareComponents(entries, waitMs = 1e4, { retryLimited = false } = {}) {
    const jobs = await this.enqueue(entries, void 0, retryLimited);
    const pending = jobs.filter(busy);
    if (pending.length) await boundedWait(Promise.all(pending.map((job) => job.promise)).then(() => {
    }), Math.min(waitMs, 1e4));
    return jobs.map((job) => ({
      status: job.status,
      preparationId: job.id,
      snapshot: job.snapshot,
      diagnostics: job.diagnostics,
      prepared: job.prepared,
      component: job.component.identity,
      failure: job.status === "degraded" ? job.failure : null
    }));
  }
  // A job is shared by every call for the same content. A failed job is prepared again by the next call, except a component's job that reached
  // a native limit, which this process does not prepare again for the same content unless `retryLimited` asks for it.
  async enqueue(entries, expectedSnapshot, retryLimited = false) {
    const manifest = await this.manifest(), jobs = [];
    for (const { source, component } of entries) {
      const projectRoot = source.projectRoot, fingerprint = typeof projectRoot === "string" ? await gitFingerprint(projectRoot) : null;
      const read = ++this.reads, snapshot = await source.snapshot(), location = await this.location(snapshot.root, component);
      const live = snapshot.enumerator !== "retained";
      if (expectedSnapshot && expectedSnapshot !== snapshot.sourceFingerprint) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
      const generationKey = `${location.directory}\0${snapshot.sourceFingerprint}\0${manifest.identity}`;
      if (retryLimited && this.limited.get(generationKey)?.status === "degraded") this.limited.delete(generationKey);
      let job = this.limited.get(generationKey) ?? this.generations.get(generationKey);
      if (!job || job.status === "degraded" && !this.limited.has(generationKey)) {
        job = this.job(source, snapshot, location, generationKey, component ? sha(`${location.directory}\0${snapshot.sourceFingerprint}\0${manifest.identity}`) : sha(`${location.root}\0${snapshot.sourceFingerprint}\0${manifest.identity}`), live ? fingerprint : void 0, component, live, read);
      } else if (live && fingerprint && job.status === "ready" && !sameFingerprint(job.freshness ?? null, fingerprint)) {
        job.freshness = fingerprint;
        await writeFreshness(location.directory, job.snapshot, fingerprint);
      }
      job.read = Math.max(job.read, read);
      if (live) this.supersede(this.jobs.get(location.directory), job);
      this.jobs.set(location.directory, job);
      jobs.push(job);
    }
    const needed = [...new Set(jobs.filter((job) => job.status === "waiting"))];
    this.queue = [...needed, ...this.queue.filter((job) => !needed.includes(job))];
    this.pump();
    return jobs;
  }
  // A live job that has not started is dropped when a newer read of the same location's live content needs another job, because its source
  // has changed and its build could only fail; it ends as failed with stale_snapshot, without running and without a progress record.
  // The running job is marked instead, and is dropped the same way if it ends waiting for another session's lock, so it is not tried again.
  supersede(previous, next) {
    if (!previous || previous === next || !previous.live || previous.read >= next.read || !busy(previous)) return;
    if (previous === this.running) {
      previous.superseded = true;
      return;
    }
    clearTimeout(previous.retry);
    previous.retry = void 0;
    this.queue = this.queue.filter((job) => job !== previous);
    this.stale(previous);
    previous.finish();
  }
  stale(job) {
    const message = "The source changed before this preparation started, so a preparation of the newer content replaced it.";
    job.status = "degraded";
    job.failure = { code: "stale_snapshot", message };
    job.diagnostics = [{ code: "stale_snapshot", message, recovery: "Repeat the call to read the newer content." }];
  }
  job(source, snapshot, location, generationKey, id, freshness, component, live = true, read = 0) {
    let finish = () => {
    };
    const promise = new Promise((resolve) => {
      finish = resolve;
    });
    const job = { id, directory: location.directory, component, snapshot: snapshot.sourceFingerprint, status: "waiting", diagnostics: [], failure: null, promise, finish, freshness, live, read, run: async () => {
      const recorder = job.recorder = new ProgressRecorder(location.directory, job.id);
      const started = privateDirectory(location.directory).then(() => recorder.start()).catch(() => {
      });
      try {
        job.prepared = await this.build(source, snapshot, location, job);
        job.status = "ready";
        if (job.freshness !== void 0) await writeFreshness(location.directory, job.snapshot, job.freshness);
        await started;
        await recorder.succeed();
      } catch (error) {
        let recovery = "Retry preparation after correcting the reported runtime, network, or source problem.";
        if (component && error.held) {
          if (job.superseded && this.jobs.get(location.directory) !== job) {
            this.stale(job);
            await started;
            await recorder.succeed();
            return;
          }
          const lock = `${location.directory}.lock`, info = await lstat(lock).catch(() => null);
          if (!info || Date.now() - info.mtimeMs <= UNRENEWED_LOCK_MS) {
            job.progress = { phase: "waiting" };
            await started;
            await recorder.succeed();
            job.retry = setTimeout(() => {
              job.retry = void 0;
              this.queue.push(job);
              this.pump();
            }, LOCK_RETRY_MS);
            job.retry.unref();
            return;
          }
          error = semanticError("lock_timeout", `The storage lock of this component has not been renewed for ${Math.round((Date.now() - info.mtimeMs) / 1e3)} seconds, so no session is preparing it, but the process that the lock names is still running.`);
          recovery = `If no session is preparing this component, delete ${lock} and repeat the call.`;
        }
        const code = stableFailure(error);
        job.status = "degraded";
        job.failure = { code, message: error.message };
        job.diagnostics = [{ code, message: error.message, recovery }];
        if (component && code === "resource_limit") this.limited.set(generationKey, job);
        await started;
        await recorder.fail(job.diagnostics);
      } finally {
        job.recorder = void 0;
      }
    } };
    this.generations.set(generationKey, job);
    const same = [...this.generations].filter(([, generation]) => generation.directory === location.directory);
    let excess = same.length - KEPT_INDEX_REVISIONS;
    for (const [key, generation] of same) if (excess > 0 && !busy(generation)) {
      this.generations.delete(key);
      excess--;
    }
    return job;
  }
  pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) {
      this.idle?.();
      this.idle = void 0;
      return;
    }
    if (!this.idle) this.sequence = new Promise((resolve) => {
      this.idle = resolve;
    });
    this.running = job;
    job.status = "preparing";
    void job.run().catch(() => {
    }).finally(() => {
      this.running = null;
      if (!job.retry) job.finish();
      this.pump();
    });
  }
  report(job, progress) {
    job.progress = progress;
    job.recorder?.update(progress);
  }
  async build(source, snapshot, location, job) {
    await privateDirectory(this.directory);
    const assets = job.assets ??= await this.assets((value) => this.report(job, value));
    const directory = await privateDirectory(location.directory);
    const waiting = setTimeout(() => this.report(job, { phase: "waiting" }), 1e3);
    waiting.unref();
    try {
      return await withArtifactLock(directory, () => withFileLock(directory, async () => {
        clearTimeout(waiting);
        let previous;
        try {
          const pointer = await readJson(path.join(directory, `generation-${snapshot.sourceFingerprint}-${assets.assetIdentity}.json`)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return readJson(path.join(directory, "current.json"));
          });
          if (!pointer.revision || !/^[a-f\d]{64}$/.test(pointer.revision)) throw semanticError("corrupt_asset", "The index pointer has an invalid revision.");
          const indexPath = path.join(directory, `${pointer.revision}.json`), bytes = await regularBytes(indexPath);
          if (sha(bytes) !== pointer.revision) throw semanticError("corrupt_asset", "The semantic index failed its integrity check.");
          previous = JSON.parse(bytes.toString("utf8"));
          if (previous.snapshot === snapshot.sourceFingerprint && previous.assetIdentity === assets.assetIdentity) {
            await source.verifySnapshot();
            job.revision = pointer.revision;
            job.coverage = pointer.coverage;
            job.diagnostics = previous.diagnostics;
            job.builtAt = pointer.builtAt;
            const used = /* @__PURE__ */ new Date();
            await utimes(indexPath, used, used).catch(() => {
            });
            const sidecar = path.join(directory, unitsFile(pointer.revision));
            await lstat(sidecar).catch(() => writeAtomically(sidecar, JSON.stringify(publishedUnits(previous, pointer.revision)), { mode: 384 })).catch(() => {
            });
            return { ...assets, index: indexMetadata(previous), indexPath, revision: pointer.revision };
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const mirror = await privateDirectory(path.join(directory, `snapshot-${randomUUID()}`));
        try {
          this.report(job, { phase: "snapshot-copy", current: 0, total: snapshot.files.length, unit: "files" });
          for (const [index2, file] of snapshot.files.entries()) {
            const target = path.resolve(mirror, file.file);
            if (!inside(mirror, target)) throw semanticError("invalid_path", "A snapshot path escapes its mirror.");
            await privateDirectory(path.dirname(target));
            const handle = await open(target, "wx", 256);
            try {
              const bytes = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
              if (sha(bytes) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
              await handle.writeFile(bytes);
            } finally {
              await handle.close();
            }
            this.report(job, { phase: "snapshot-copy", current: index2 + 1, total: snapshot.files.length, unit: "files" });
          }
          await source.verifySnapshot();
          const previousEmbeddings = Object.fromEntries((previous?.chunks || []).filter((chunk) => chunk.embeddingKey && chunk.embedding).map((chunk) => [chunk.embeddingKey, chunk.embedding]));
          const indexStarted = performance.now();
          const index = await this.helper(assets.runtime).request("build", {
            mirror,
            files: snapshot.files.map(({ file, hash }) => ({ file, hash })),
            snapshot: snapshot.sourceFingerprint,
            modelDirectory: assets.modelDirectory,
            modelIdentity: assets.modelIdentity,
            previousEmbeddings
          }, (progress) => this.report(job, progress));
          index.resources = { ...index.resources, indexMilliseconds: performance.now() - indexStarted };
          this.report(job, { phase: "saving" });
          await source.verifySnapshot();
          index.assetIdentity = assets.assetIdentity;
          if (!snapshot.complete) {
            index.structureComplete = false;
            index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." });
          }
          const contents = JSON.stringify(index), revision = sha(contents), indexPath = path.join(directory, `${revision}.json`);
          if (Buffer.byteLength(contents) > 512 * 1024 * 1024) throw semanticError("resource_limit", "The semantic index exceeds 512 MiB.");
          await writeAtomically(indexPath, contents, { mode: 384 });
          await writeAtomically(path.join(directory, unitsFile(revision)), JSON.stringify(publishedUnits(index, revision)), { mode: 384 });
          const coverage = { ...index.counts, structurallyCoveredFiles: Object.values(index.fileCoverage).filter(Boolean).length, complete: index.structureComplete && Object.values(index.fileCoverage).every(Boolean) };
          const builtAt = (/* @__PURE__ */ new Date()).toISOString();
          const pointerContents = JSON.stringify({ snapshot: index.snapshot, revision, chunkerVersion: index.chunkerVersion, coverage, diagnostics: index.diagnostics, builtAt });
          await writeAtomically(path.join(directory, `generation-${snapshot.sourceFingerprint}-${assets.assetIdentity}.json`), pointerContents, { mode: 384 });
          await writeAtomically(path.join(directory, "current.json"), pointerContents, { mode: 384 });
          job.revision = revision;
          job.coverage = coverage;
          job.diagnostics = index.diagnostics;
          job.builtAt = builtAt;
          await rm(mirror, { recursive: true, force: true });
          await pruneIndexes(directory, revision).catch(() => {
          });
          return { ...assets, index: indexMetadata(index), indexPath, revision };
        } finally {
          await rm(mirror, { recursive: true, force: true });
        }
      }, job.component ? heldError : semanticError, { renew: true, timeoutMs: job.component ? 250 : 12e4 }));
    } finally {
      clearTimeout(waiting);
    }
  }
  helper(runtime, role = "build") {
    let helper = this.processes.get(role);
    if (helper?.runtime !== runtime) {
      helper?.stop();
      helper = new Helper(runtime, { ...this.options, directory: this.directory });
      this.processes.set(role, helper);
    }
    return helper;
  }
  async search(prepared, source, query, filters, limit) {
    await source.verifySnapshot();
    const results = await this.helper(prepared.runtime, "search").request("search", {
      query,
      filters,
      limit,
      snapshot: prepared.index.snapshot,
      indexPath: prepared.indexPath,
      modelDirectory: prepared.modelDirectory,
      modelIdentity: prepared.modelIdentity
    });
    await source.verifySnapshot();
    return results;
  }
  // Resolves once the helper processes have exited, so a caller that exits next leaves no helper holding the runtime's files open.
  close() {
    const exits = [...this.processes.values()].map((helper) => {
      const child = helper.child;
      helper.stop();
      if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => child.once("exit", () => resolve()));
    });
    return Promise.all(exits).then(() => {
    });
  }
}
const nativeSemanticRuntime = new NativeSemanticRuntime();
export {
  NativeSemanticRuntime,
  assertSafeAncestors,
  modelAssetName,
  nativeSemanticRuntime,
  privateDirectory,
  pruneAssets,
  pruneIndexes,
  publishedUnits,
  regularBytes,
  semanticError,
  unitsFile
};
