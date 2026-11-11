// Generated from src/server/repository-intelligence/index-store.mts by scripts/native-build/compile.mjs.
import { Worker } from "node:worker_threads";
import { errorFields, log } from "../log.mjs";
import { semanticError } from "./native-files.mjs";
import { indexMetadata, readIndex, storedEmbeddings, writeIndex } from "./index-files.mjs";
import { appendEmbeddings, readEmbeddings, replaceEmbeddings } from "./embedding-store.mjs";
import { structuralCoverage } from "./structural-coverage.mjs";
const REUSED_EMBEDDINGS = 4e4;
class LocalIndexStore {
  constructor(request, stopHelper = () => {
  }) {
    this.request = request;
    this.stopHelper = stopHelper;
  }
  built = /* @__PURE__ */ new Map();
  counter = 0;
  // Counts the calls of `stop`, so a build that a stop reached before it sent its request never sends it.
  stops = 0;
  async read(indexPath, revision) {
    return indexMetadata(await readIndex(indexPath, revision));
  }
  // The runtime's `structure` value is the index without embeddings; it is held for `structure`, never forwarded, and its phase alone is reported.
  async build({ runtime, directory, args, previous }, progress, structure) {
    const stops = this.stops;
    const indexed = previous && !args.fragmentsOnly ? await readIndex(previous.indexPath, previous.revision).then(storedEmbeddings, (error) => {
      log.warn("index_reuse_unreadable", { indexPath: previous.indexPath, ...errorFields(error) });
      return {};
    }) : {};
    const saved = args.fragmentsOnly ? {} : await readEmbeddings(directory, { limit: REUSED_EMBEDDINGS - Object.keys(indexed).length, skip: indexed });
    const previousEmbeddings = { ...indexed, ...saved };
    if (this.stops !== stops) throw semanticError("preparation_failed", "The index build was stopped before it started.");
    let saving = true;
    const forward = ({ vectors, index: index2, ...value }) => {
      if (value.phase === "structure" && index2 && structure) {
        const token2 = String(++this.counter);
        this.built.set(token2, index2);
        structure(token2);
      }
      if (vectors && saving) {
        try {
          appendEmbeddings(directory, vectors);
        } catch (error) {
          saving = false;
          log.warn("embedding_store_unwritable", { directory, ...errorFields(error) });
        }
      }
      progress(value, Boolean(vectors));
    };
    const started = performance.now();
    const index = await this.request(runtime, { ...args, previousEmbeddings }, forward);
    index.resources = { ...index.resources, indexMilliseconds: performance.now() - started };
    const token = String(++this.counter);
    this.built.set(token, index);
    return token;
  }
  async save(token, { directory, assetIdentity, incomplete }) {
    const index = this.built.get(token);
    if (!index) throw semanticError("preparation_failed", "The built index is no longer held.");
    this.built.delete(token);
    finished(index, assetIdentity, incomplete);
    const stored = await writeIndex(directory, index);
    await replaceEmbeddings(directory, index.chunks).catch((error) => log.warn("embedding_store_unwritable", { directory, ...errorFields(error) }));
    return { ...stored, index: indexMetadata(index) };
  }
  async saveStructure(token, { directory, assetIdentity, incomplete }) {
    const index = this.built.get(token);
    if (!index) throw semanticError("preparation_failed", "The reported structure is no longer held.");
    this.built.delete(token);
    for (const chunk of index.chunks) delete chunk.embedding;
    finished(index, assetIdentity, incomplete);
    const stored = await writeIndex(directory, index);
    return { ...stored, index: indexMetadata(index) };
  }
  async stop() {
    this.stops += 1;
    this.stopHelper();
  }
  async discard(token) {
    this.built.delete(token);
  }
  async close() {
    this.built.clear();
  }
}
function finished(index, assetIdentity, incomplete) {
  index.assetIdentity = assetIdentity;
  index.fileCoverage = structuralCoverage(index);
  if (incomplete) {
    index.structureComplete = false;
    index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." });
  }
}
class ThreadIndexStore {
  constructor(helper) {
    this.helper = helper;
  }
  worker = null;
  calls = /* @__PURE__ */ new Map();
  counter = 0;
  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./index-store-thread.mjs", import.meta.url), { workerData: { helper: this.helper, log: { name: log.name, directory: log.directory, level: log.level } }, execArgv: [] });
    this.worker = worker;
    worker.on("message", (message) => {
      const call = this.calls.get(message.id);
      if (!call) return;
      if (message.progress) {
        call.progress?.(message.progress, message.embedded);
        return;
      }
      if (message.structure !== void 0) {
        call.structure?.(message.structure);
        return;
      }
      this.calls.delete(message.id);
      if (!this.calls.size) worker.unref();
      if (message.error) call.reject(Object.assign(new Error(message.error.message), message.error.code === void 0 ? {} : { code: message.error.code }));
      else call.resolve(message.result);
    });
    const ended = (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.calls.size) log.error("index_thread_stopped", errorFields(error));
      for (const call of this.calls.values()) call.reject(semanticError("preparation_failed", `The index thread stopped: ${error.message}`));
      this.calls.clear();
    };
    worker.on("error", ended);
    worker.on("exit", (code) => ended(new Error(`it exited with code ${code}.`)));
    worker.unref();
    return worker;
  }
  call(op, args, progress, structure) {
    const worker = this.start(), id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve: (value) => resolve(value), reject, progress, structure });
      worker.ref();
      worker.postMessage({ id, op, args });
    });
  }
  read(indexPath, revision) {
    return this.call("read", [indexPath, revision]);
  }
  // The thread is told whether to hold a reported structure, so a build whose caller cannot save one never holds it.
  build(request, progress, structure) {
    return this.call("build", [request, Boolean(structure)], progress, structure);
  }
  saveStructure(token, finish) {
    return this.call("saveStructure", [token, finish]);
  }
  // A thread that never started runs no build, so there is nothing to stop.
  async stop() {
    if (this.worker) await this.call("stop", []);
  }
  save(token, finish) {
    return this.call("save", [token, finish]);
  }
  discard(token) {
    return this.call("discard", [token]);
  }
  // Resolves once the build helper has exited and the thread has ended, so a caller that exits next leaves no process holding the runtime's files open.
  async close() {
    const worker = this.worker;
    if (!worker) return;
    await Promise.race([this.call("close", []), new Promise((resolve) => setTimeout(resolve, 5e3).unref())]).catch(() => {
    });
    this.worker = null;
    await worker.terminate();
  }
}
export {
  LocalIndexStore,
  REUSED_EMBEDDINGS,
  ThreadIndexStore
};
