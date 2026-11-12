import { Worker } from "node:worker_threads";
import { errorFields, log } from "../log.mjs";
import { semanticError } from "./native-files.mjs";
import { indexMetadata, readIndex, storedEmbeddings, writeIndex } from "./index-files.mjs";
import type { HelperOptions } from "./native-helper.mjs";
import type { BuildArguments, IndexMetadata, Progress, UnitIndex } from "./repository-unit-types.mjs";

// The index store reads, builds, and writes the full indexes, whose fragment vectors make them the largest data Prism handles.
// The default store does this in a thread of its own, which also talks to the build helper, so a full index is parsed, hashed, and
// serialized there and only its metadata, without fragments, reaches the event loop that answers pages and agents.

export interface StoreBuild { runtime: string; args: Omit<BuildArguments, "previousEmbeddings">; previous?: { indexPath: string; revision: string } }
export interface StoreFinish { directory: string; assetIdentity: string; incomplete: boolean }
export interface StoredIndex { revision: string; indexPath: string; bytes: number; index: IndexMetadata }
export interface IndexStore {
  /** The metadata of a stored index, after its bytes match its revision. */
  read(indexPath: string, revision: string): Promise<IndexMetadata>;
  /** Builds an index, reusing the embeddings of `previous`, and holds it until it is saved or discarded; resolves to its token. */
  build(request: StoreBuild, progress: (value: Progress) => void): Promise<string>;
  /** Writes a built index under its revision, with its units sidecar. */
  save(token: string, finish: StoreFinish): Promise<StoredIndex>;
  discard(token: string): Promise<void>;
  close(): Promise<void>;
}
export type BuildRequest = (runtime: string, args: BuildArguments, progress: (value: Progress) => void) => Promise<UnitIndex>;

/** A store that does its work where it is called; the thread store runs one, and tests use one with an in-process helper. */
export class LocalIndexStore implements IndexStore {
  built = new Map<string, UnitIndex>();
  counter = 0;
  constructor(private request: BuildRequest) {}
  async read(indexPath: string, revision: string) { return indexMetadata(await readIndex(indexPath, revision)); }
  async build({ runtime, args, previous }: StoreBuild, progress: (value: Progress) => void) {
    // Reuse saves embedding time only, so a previous index that can no longer be read leaves the build to embed every fragment.
    const previousEmbeddings = previous ? await readIndex(previous.indexPath, previous.revision).then(storedEmbeddings, error => {
      log.warn("index_reuse_unreadable", { indexPath: previous.indexPath, ...errorFields(error) });
      return {};
    }) : {};
    const started = performance.now();
    const index = await this.request(runtime, { ...args, previousEmbeddings }, progress);
    index.resources = { ...index.resources, indexMilliseconds: performance.now() - started };
    const token = String(++this.counter);
    this.built.set(token, index);
    return token;
  }
  async save(token: string, { directory, assetIdentity, incomplete }: StoreFinish) {
    const index = this.built.get(token);
    if (!index) throw semanticError("preparation_failed", "The built index is no longer held.");
    this.built.delete(token);
    index.assetIdentity = assetIdentity;
    if (incomplete) { index.structureComplete = false; index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." }); }
    return { ...await writeIndex(directory, index), index: indexMetadata(index) };
  }
  async discard(token: string) { this.built.delete(token); }
  async close() { this.built.clear(); }
}

type Call = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (value: Progress) => void };

/** The default store: a LocalIndexStore in a worker thread whose build helper is a bundled Node process. */
export class ThreadIndexStore implements IndexStore {
  worker: Worker | null = null;
  calls = new Map<number, Call>();
  counter = 0;
  constructor(private helper: HelperOptions) {}
  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./index-store-thread.mjs", import.meta.url), { workerData: { helper: this.helper, log: { name: log.name, directory: log.directory, level: log.level } }, execArgv: [] });
    this.worker = worker;
    worker.on("message", (message: { id: number; progress?: Progress; result?: unknown; error?: { code?: string; message: string } }) => {
      const call = this.calls.get(message.id);
      if (!call) return;
      if (message.progress) { call.progress?.(message.progress); return; }
      this.calls.delete(message.id);
      if (!this.calls.size) worker.unref();
      if (message.error) call.reject(Object.assign(new Error(message.error.message), message.error.code === undefined ? {} : { code: message.error.code }));
      else call.resolve(message.result);
    });
    const ended = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.calls.size) log.error("index_thread_stopped", errorFields(error));
      for (const call of this.calls.values()) call.reject(semanticError("preparation_failed", `The index thread stopped: ${error.message}`));
      this.calls.clear();
    };
    worker.on("error", ended);
    worker.on("exit", code => ended(new Error(`it exited with code ${code}.`)));
    worker.unref();
    return worker;
  }
  call<T>(op: string, args: unknown[], progress?: (value: Progress) => void): Promise<T> {
    const worker = this.start(), id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: value => resolve(value as T), reject, progress });
      worker.ref();
      worker.postMessage({ id, op, args });
    });
  }
  read(indexPath: string, revision: string) { return this.call<IndexMetadata>("read", [indexPath, revision]); }
  build(request: StoreBuild, progress: (value: Progress) => void) { return this.call<string>("build", [request], progress); }
  save(token: string, finish: StoreFinish) { return this.call<StoredIndex>("save", [token, finish]); }
  discard(token: string) { return this.call<void>("discard", [token]); }
  // Resolves once the build helper has exited and the thread has ended, so a caller that exits next leaves no process holding the runtime's files open.
  async close() {
    const worker = this.worker;
    if (!worker) return;
    await Promise.race([this.call<void>("close", []), new Promise(resolve => setTimeout(resolve, 5000).unref())]).catch(() => {});
    this.worker = null;
    await worker.terminate();
  }
}
