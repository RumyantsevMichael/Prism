// Generated from src/server/repository-intelligence/index-store.mts by scripts/native-build/compile.mjs.
import { Worker } from "node:worker_threads";
import { errorFields, log } from "../log.mjs";
import { semanticError } from "./native-files.mjs";
import { indexMetadata, readIndex, storedEmbeddings, writeIndex } from "./index-files.mjs";
import { appendEmbeddings, readEmbeddings, replaceEmbeddings } from "./embedding-store.mjs";
class LocalIndexStore {
  constructor(request, stopHelper = () => {
  }) {
    this.request = request;
    this.stopHelper = stopHelper;
  }
  built = /* @__PURE__ */ new Map();
  counter = 0;
  async read(indexPath, revision) {
    return indexMetadata(await readIndex(indexPath, revision));
  }
  async build({ runtime, directory, args, previous }, progress) {
    const indexed = previous ? await readIndex(previous.indexPath, previous.revision).then(storedEmbeddings, (error) => {
      log.warn("index_reuse_unreadable", { indexPath: previous.indexPath, ...errorFields(error) });
      return {};
    }) : {};
    const previousEmbeddings = { ...indexed, ...await readEmbeddings(directory) };
    let saving = true;
    const forward = ({ vectors, index: _index, ...value }) => {
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
    index.assetIdentity = assetIdentity;
    if (incomplete) {
      index.structureComplete = false;
      index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." });
    }
    const stored = await writeIndex(directory, index);
    await replaceEmbeddings(directory, index.chunks).catch((error) => log.warn("embedding_store_unwritable", { directory, ...errorFields(error) }));
    return { ...stored, index: indexMetadata(index) };
  }
  async stop() {
    this.stopHelper();
  }
  async discard(token) {
    this.built.delete(token);
  }
  async close() {
    this.built.clear();
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
  call(op, args, progress) {
    const worker = this.start(), id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve: (value) => resolve(value), reject, progress });
      worker.ref();
      worker.postMessage({ id, op, args });
    });
  }
  read(indexPath, revision) {
    return this.call("read", [indexPath, revision]);
  }
  build(request, progress) {
    return this.call("build", [request], progress);
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
  ThreadIndexStore
};
