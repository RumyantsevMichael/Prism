// Generated from src/server/repository-intelligence/native-semantic-runtime.mts by scripts/native-build/compile.mjs.
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
import { assertSafeAncestors as assertSafeAncestors2, regularBytes as regularBytes2, semanticError as semanticError2 } from "./native-files.mjs";
import { publishedUnits as publishedUnits2, unitsFile as unitsFile2 } from "./index-files.mjs";
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
const busy = (job) => job?.status === "waiting" || job?.status === "preparing";
const LOCK_RETRY_MS = 2e3;
const RELOAD_CONCURRENCY = 4;
const reloadMiss = () => Object.assign(semanticError("preparation_failed", "The stored index no longer matches its content."), { reloadMiss: true });
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
  indexStore;
  // Counts snapshot reads, so a newer read of a location's live content can replace a job for content read before it.
  reads = 0;
  verifiedRuntime;
  // The model files as last checked, by size and modification time, so each component's preparation does not hash the model again.
  verifiedModel;
  // Jobs that load a stored index, and those of them that are loading now.
  reloads = [];
  reloading = /* @__PURE__ */ new Set();
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
    const stamp = async () => (await Promise.all(manifest.model.files.map((file) => lstat(path.join(modelDirectory, file.path)).then((info) => `${info.size}:${info.mtimeMs}`, () => "missing")))).join("\0");
    if (this.verifiedModel?.directory !== modelDirectory || this.verifiedModel.stamp !== await stamp()) await withArtifactLock(modelDirectory, () => withFileLock(modelDirectory, async () => {
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
      this.verifiedModel = { directory: modelDirectory, stamp: await stamp() };
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
    const fingerprints = /* @__PURE__ */ new Map();
    for (const { source, component } of entries) {
      const projectRoot = source.projectRoot;
      if (typeof projectRoot === "string" && !fingerprints.has(projectRoot)) fingerprints.set(projectRoot, gitFingerprint(projectRoot));
      const fingerprint = typeof projectRoot === "string" ? await fingerprints.get(projectRoot) : null;
      const read = ++this.reads, snapshot = await source.snapshot(), location = await this.location(snapshot.root, component);
      const live = snapshot.enumerator !== "retained";
      if (expectedSnapshot && expectedSnapshot !== snapshot.sourceFingerprint) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
      const generationKey = `${location.directory}\0${snapshot.sourceFingerprint}\0${manifest.identity}`;
      if (retryLimited && this.limited.get(generationKey)?.status === "degraded") this.limited.delete(generationKey);
      let job = this.limited.get(generationKey) ?? this.generations.get(generationKey);
      if (!job || job.status === "degraded" && !this.limited.has(generationKey)) {
        job = this.job(source, snapshot, location, generationKey, component ? this.componentPreparationId(location.directory, snapshot.sourceFingerprint, manifest.identity) : sha(`${location.root}\0${snapshot.sourceFingerprint}\0${manifest.identity}`), live ? fingerprint : void 0, component, live, read);
        if (component) job.reload = (await readdir(location.directory).catch(() => [])).some((name) => name.startsWith(`generation-${snapshot.sourceFingerprint}-`));
      } else if (live && fingerprint && job.status === "ready" && !sameFingerprint(job.freshness ?? null, fingerprint)) {
        job.freshness = fingerprint;
        await writeFreshness(location.directory, job.snapshot, fingerprint);
      }
      job.read = Math.max(job.read, read);
      if (live) this.supersede(this.jobs.get(location.directory), job);
      this.jobs.set(location.directory, job);
      jobs.push(job);
    }
    for (const job of new Set(jobs)) if (job.reload && job.status === "waiting" && !job.retry) this.reload(job);
    const last = (job) => job.component?.folder === "" ? 1 : 0;
    const needed = [...new Set(jobs.filter((job) => job.status === "waiting" && !job.reload))].sort((left, right) => last(left) - last(right));
    this.queue = [...needed, ...this.queue.filter((job) => !needed.includes(job))];
    this.pump();
    return jobs;
  }
  // The preparation id of a component's content, which its progress records carry.
  componentPreparationId(directory, snapshot, assetIdentity) {
    return sha(`${directory}\0${snapshot}\0${assetIdentity}`);
  }
  reload(job) {
    if (!this.reloads.includes(job)) this.reloads.push(job);
    this.pumpReloads();
  }
  pumpReloads() {
    while (this.reloading.size < RELOAD_CONCURRENCY && this.reloads.length) {
      const job = this.reloads.shift();
      if (!this.idle) this.sequence = new Promise((resolve) => {
        this.idle = resolve;
      });
      this.reloading.add(job);
      job.status = "preparing";
      job.progress = { phase: "loading" };
      void job.run().catch(() => {
      }).finally(() => {
        this.reloading.delete(job);
        if (job.requeue) {
          job.requeue = false;
          this.queue.push(job);
          this.pump();
        } else if (!job.retry) job.finish();
        this.pumpReloads();
        this.settle();
      });
    }
  }
  // Resolves the sequence once no build or load runs or waits.
  settle() {
    if (this.running || this.queue.length || this.reloading.size || this.reloads.length) return;
    this.idle?.();
    this.idle = void 0;
  }
  // A live job that has not started is dropped when a newer read of the same location's live content needs another job, because its source
  // has changed and its build could only fail; it ends as failed with stale_snapshot, without running and without a progress record.
  // The running job is marked instead, and is dropped the same way if it ends waiting for another session's lock, so it is not tried again.
  supersede(previous, next) {
    if (!previous || previous === next || !previous.live || previous.read >= next.read || !busy(previous)) return;
    if (previous === this.running || this.reloading.has(previous)) {
      previous.superseded = true;
      return;
    }
    clearTimeout(previous.retry);
    previous.retry = void 0;
    this.queue = this.queue.filter((job) => job !== previous);
    this.reloads = this.reloads.filter((job) => job !== previous);
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
        if (error.reloadMiss) {
          job.reload = false;
          job.requeue = true;
          job.status = "waiting";
          job.progress = void 0;
          await started;
          await recorder.succeed();
          return;
        }
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
        log.warn("index_failed", { directory: location.directory, component: component?.identity, code, ...errorFields(error) });
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
      this.settle();
      return;
    }
    if (!this.idle) this.sequence = new Promise((resolve) => {
      this.idle = resolve;
    });
    this.running = job;
    job.status = "preparing";
    const started = performance.now();
    log.info("index_started", { directory: job.directory, component: job.component?.identity, queued: this.queue.length });
    void job.run().catch(() => {
    }).finally(() => {
      log.info("index_finished", { directory: job.directory, component: job.component?.identity, status: job.status, ms: Math.round(performance.now() - started) });
      log.activity.delete("index");
      this.running = null;
      if (!job.retry) job.finish();
      this.pump();
    });
  }
  report(job, progress) {
    if (job.progress?.phase !== progress.phase) {
      log.debug("index_phase", { directory: job.directory, component: job.component?.identity, phase: progress.phase, total: progress.total });
      if (job === this.running) log.activity.set("index", `${job.component?.identity ?? "project"} ${progress.phase}`);
    }
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
          const indexPath = path.join(directory, `${pointer.revision}.json`);
          const index = await this.store.read(indexPath, pointer.revision);
          previous = { index, indexPath, revision: pointer.revision };
          if (index.snapshot === snapshot.sourceFingerprint && index.assetIdentity === assets.assetIdentity) {
            await source.verifySnapshot();
            job.revision = pointer.revision;
            job.coverage = pointer.coverage;
            job.diagnostics = index.diagnostics;
            job.builtAt = pointer.builtAt;
            const used = /* @__PURE__ */ new Date();
            await utimes(indexPath, used, used).catch(() => {
            });
            const sidecar = path.join(directory, unitsFile(pointer.revision));
            await lstat(sidecar).catch(() => writeAtomically(sidecar, JSON.stringify(publishedUnits(index, pointer.revision)), { mode: 384 })).catch(() => {
            });
            log.info("index_reused", { directory, revision: pointer.revision, component: job.component?.identity });
            return { ...assets, index, indexPath, revision: pointer.revision };
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (job.reload && this.running !== job) throw reloadMiss();
        const mirror = await privateDirectory(path.join(directory, `snapshot-${randomUUID()}`));
        try {
          this.report(job, { phase: "snapshot-copy", current: 0, total: snapshot.files.length, unit: "files" });
          for (const [index2, file] of snapshot.files.entries()) {
            const target = path.resolve(mirror, file.file);
            if (!inside(mirror, target)) throw semanticError("invalid_path", "A snapshot path escapes its mirror.");
            await privateDirectory(path.dirname(target));
            const handle = await open(target, "wx", 256);
            try {
              const bytes2 = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
              if (sha(bytes2) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
              await handle.writeFile(bytes2);
            } finally {
              await handle.close();
            }
            this.report(job, { phase: "snapshot-copy", current: index2 + 1, total: snapshot.files.length, unit: "files" });
          }
          await source.verifySnapshot();
          const token = await this.store.build({
            runtime: assets.runtime,
            args: {
              mirror,
              files: snapshot.files.map(({ file, hash }) => ({ file, hash })),
              snapshot: snapshot.sourceFingerprint,
              modelDirectory: assets.modelDirectory,
              modelIdentity: assets.modelIdentity
            },
            ...previous ? { previous: { indexPath: previous.indexPath, revision: previous.revision } } : {}
          }, (progress) => this.report(job, progress));
          this.report(job, { phase: "saving" });
          try {
            await source.verifySnapshot();
          } catch (error) {
            await this.store.discard(token).catch(() => {
            });
            throw error;
          }
          const { revision, indexPath, bytes, index } = await this.store.save(token, { directory, assetIdentity: assets.assetIdentity, incomplete: !snapshot.complete });
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
          log.info("index_built", {
            directory,
            revision,
            component: job.component?.identity,
            files: snapshot.files.length,
            bytes,
            counts: index.counts,
            indexMs: Math.round(index.resources?.indexMilliseconds ?? 0),
            diagnostics: index.diagnostics.length
          });
          return { ...assets, index, indexPath, revision };
        } finally {
          await rm(mirror, { recursive: true, force: true });
        }
      }, job.component ? heldError : semanticError, { renew: true, timeoutMs: job.component ? 250 : 12e4 }));
    } finally {
      clearTimeout(waiting);
    }
  }
  // A build goes to the index store, whose default runs in a thread with its own helper; a search goes to the search helper here,
  // because a search answers with a few results and must not wait behind a build.
  get store() {
    return this.indexStore ??= new ThreadIndexStore({ ...this.options, directory: this.directory });
  }
  set store(store) {
    this.indexStore = store;
  }
  /** A store that builds through this runtime's `helper` in this thread, for a helper that runs in process. */
  inProcessStore() {
    return new LocalIndexStore((runtime, args, progress) => this.helper(runtime, "build").request("build", args, progress));
  }
  helper(runtime, role = "search") {
    let helper = this.processes.get(role);
    if (helper?.runtime !== runtime) {
      helper?.stop();
      helper = new Helper(runtime, { ...this.options, directory: this.directory }, role);
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
  // Resolves once the helper processes and the index thread have ended, so a caller that exits next leaves no helper holding the runtime's files open.
  async close() {
    const exits = [...this.processes.values()].map((helper) => helper.close());
    this.processes.clear();
    await Promise.all([...exits, this.indexStore?.close()]);
    this.indexStore = void 0;
  }
}
const nativeSemanticRuntime = new NativeSemanticRuntime();
export {
  NativeSemanticRuntime,
  assertSafeAncestors2 as assertSafeAncestors,
  modelAssetName,
  nativeSemanticRuntime,
  privateDirectory,
  pruneAssets,
  pruneIndexes,
  publishedUnits2 as publishedUnits,
  regularBytes2 as regularBytes,
  semanticError2 as semanticError,
  unitsFile2 as unitsFile
};
