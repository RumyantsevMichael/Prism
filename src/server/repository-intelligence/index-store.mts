import { Worker } from "node:worker_threads";
import { errorFields, log } from "../log.mjs";
import { semanticError } from "./native-files.mjs";
import { indexMetadata, readIndex, storedEmbeddings, writeIndex } from "./index-files.mjs";
import { appendEmbeddings, readEmbeddings, replaceEmbeddings } from "./embedding-store.mjs";
import { structuralCoverage } from "./structural-coverage.mjs";
import type { HelperOptions } from "./native-helper.mjs";
import type { BuildArguments, IndexMetadata, Progress, UnitIndex } from "./repository-unit-types.mjs";

// The index store reads, builds, and writes the full indexes, whose fragment vectors make them the largest data Prism handles.
// The default store does this in a thread of its own, which also talks to the build helper, so a full index is parsed, hashed, and
// serialized there and only its metadata, without fragments, reaches the event loop that answers pages and agents.

// `directory` is the storage location whose embedding store the build appends to and reuses.
export interface StoreBuild { runtime: string; directory: string; args: Omit<BuildArguments, "previousEmbeddings">; previous?: { indexPath: string; revision: string } }
// A forwarded progress value never carries vectors or an index; `embedded` is true when the runtime's value carried vectors, which counts as progress.
export type StoreProgress = (value: Progress, embedded?: boolean) => void;
export interface StoreFinish { directory: string; assetIdentity: string; incomplete: boolean }
export interface StoredIndex { revision: string; indexPath: string; bytes: number; index: IndexMetadata }
export interface IndexStore {
  /** The metadata of a stored index, after its bytes match its revision. */
  read(indexPath: string, revision: string): Promise<IndexMetadata>;
  /** Builds an index, reusing the embeddings of `previous`, and holds it until it is saved or discarded; resolves to its token. */
  build(request: StoreBuild, progress: StoreProgress): Promise<string>;
  /** Stops the helper that runs the build request, without waiting for that request to end. */
  stop(): Promise<void>;
  /** Writes a built index under its revision, with its units sidecar, and replaces the location's embedding store with its embeddings. */
  save(token: string, finish: StoreFinish): Promise<StoredIndex>;
  discard(token: string): Promise<void>;
  close(): Promise<void>;
}
export type BuildRequest = (runtime: string, args: BuildArguments, progress: (value: Progress) => void) => Promise<UnitIndex>;

/** A store that does its work where it is called; the thread store runs one, and tests use one with an in-process helper. */
export class LocalIndexStore implements IndexStore {
  built = new Map<string, UnitIndex>();
  counter = 0;
  constructor(private request: BuildRequest, private stopHelper: () => void = () => {}) {}
  async read(indexPath: string, revision: string) { return indexMetadata(await readIndex(indexPath, revision)); }
  async build({ runtime, directory, args, previous }: StoreBuild, progress: StoreProgress) {
    // Reuse saves embedding time only, so a previous index that can no longer be read leaves the build to embed every fragment.
    const indexed = previous ? await readIndex(previous.indexPath, previous.revision).then(storedEmbeddings, error => {
      log.warn("index_reuse_unreadable", { indexPath: previous.indexPath, ...errorFields(error) });
      return {};
    }) : {};
    // The embedding store holds what earlier builds of this location embedded, including builds that never saved an index.
    const previousEmbeddings = { ...indexed, ...await readEmbeddings(directory) };
    let saving = true;
    const forward = ({ vectors, index: _index, ...value }: Progress & { index?: unknown }) => {
      // Each batch is written before the next message is handled; a store that cannot be written costs only reuse, never the build.
      if (vectors && saving) {
        try { appendEmbeddings(directory, vectors); }
        catch (error) { saving = false; log.warn("embedding_store_unwritable", { directory, ...errorFields(error) }); }
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
  async save(token: string, { directory, assetIdentity, incomplete }: StoreFinish) {
    const index = this.built.get(token);
    if (!index) throw semanticError("preparation_failed", "The built index is no longer held.");
    this.built.delete(token);
    index.assetIdentity = assetIdentity;
    // Prism decides which unresolved references leave a file uncovered, so the stored coverage and every count read from it agree.
    index.fileCoverage = structuralCoverage(index);
    if (incomplete) { index.structureComplete = false; index.diagnostics.push({ code: "resource_limit", message: "The native source snapshot is incomplete." }); }
    const stored = await writeIndex(directory, index);
    await replaceEmbeddings(directory, index.chunks).catch(error => log.warn("embedding_store_unwritable", { directory, ...errorFields(error) }));
    return { ...stored, index: indexMetadata(index) };
  }
  async stop() { this.stopHelper(); }
  async discard(token: string) { this.built.delete(token); }
  async close() { this.built.clear(); }
}

type Call = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: StoreProgress };

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
    worker.on("message", (message: { id: number; progress?: Progress; embedded?: boolean; result?: unknown; error?: { code?: string; message: string } }) => {
      const call = this.calls.get(message.id);
      if (!call) return;
      if (message.progress) { call.progress?.(message.progress, message.embedded); return; }
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
  call<T>(op: string, args: unknown[], progress?: StoreProgress): Promise<T> {
    const worker = this.start(), id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: value => resolve(value as T), reject, progress });
      worker.ref();
      worker.postMessage({ id, op, args });
    });
  }
  read(indexPath: string, revision: string) { return this.call<IndexMetadata>("read", [indexPath, revision]); }
  build(request: StoreBuild, progress: StoreProgress) { return this.call<string>("build", [request], progress); }
  // A thread that never started runs no build, so there is nothing to stop.
  async stop() { if (this.worker) await this.call<void>("stop", []); }
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
