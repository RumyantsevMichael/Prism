import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { manifestPath } from "./component-indexes.mjs";

// A NativeSemanticRuntime whose helper builds in stages as the index-preparation contract's runtime protocol describes, for its acceptance tests.
// A test file sets PLUGIN_DATA and PRISM_NATIVE_ASSET_MANIFEST before it uses these helpers, because Prism modules read their data folder when they load.
//
// Each file of a build becomes one file unit, one function unit per `export function`, and one fragment whose embedding text is the file's content.
// A build reports graph progress per file, then { phase: "structure", index } without embeddings, then one embedding value with vectors per fragment
// that has no previous embedding, in path order. control.builds lists each build's arguments as { files, mirror, changedFiles, removedFiles, previousEmbeddings,
// fragmentsOnly }, with previousEmbeddings as the sorted keys it received; control.hold(file, point) stops a build that holds the file before it
// reports structure (point "structure") or before it embeds the file (point "embedding", the default) until control.release(file);
// control.reached(file) settles once a build stopped there, and fails after five seconds; while control.heartbeat is set, a stopped build repeats its latest progress value every
// 20 ms; control.delayMs makes each embedding take that long; control.fail(file) makes a build fail when it is about to embed the file.
// control.stops counts calls of the helper's stop(), which rejects every build request that has not answered.
// A search answers each function unit with control.cosine[file] (0.5 by default) and control.lexical[file] (1 by default) as its scores, ordered by
// lexical score and then path, except that a lexical search, or a search of an index without embeddings, answers cosineSimilarity null;
// control.searches lists each search's { mode, indexPath }.

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const embeddingKey = (text) => sha256(`fake-model\0${text}`);
// Each value is a multiple of 1/128, which a 32-bit float holds exactly, so a vector read back from the embedding store equals the one reported.
export const fakeVector = (key) => Array.from({ length: 384 }, (_, index) => (Buffer.from(key, "hex")[index % 32] - 128) / 128);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stagedRuntime(storage, { stallMs } = {}) {
  const { NativeSemanticRuntime } = await import("../../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath, ...(stallMs === undefined ? {} : { stallMs }) });
  runtime.assets = async () => ({ runtime: "fake-runtime", modelDirectory: "fake-model", modelIdentity: "fake-model", assetIdentity: "fake-assets" });
  const holds = new Map(), reached = new Map(), failures = new Set(), pending = new Set();
  const arrival = (file) => {
    if (!reached.has(file)) { let resolve; const promise = new Promise((done) => { resolve = done; }); reached.set(file, { promise, resolve }); }
    return reached.get(file);
  };
  const control = {
    builds: [], searches: [], stops: 0, heartbeat: false, delayMs: 0, cosine: {}, lexical: {},
    hold(file, point = "embedding") { let release; const promise = new Promise((resolve) => { release = resolve; }); holds.set(file, { point, promise, release }); },
    release(file) { holds.get(file)?.release(); holds.delete(file); },
    // A build that never reaches the hold fails the waiting test after a bound, instead of leaving the event loop with nothing to do.
    reached(file, ms = 5000) {
      let timer;
      const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No build stopped at ${file} within ${ms} ms.`)), ms); });
      return Promise.race([arrival(file).promise, bound]).finally(() => clearTimeout(timer));
    },
    fail(file) { failures.add(file); },
    recover(file) { failures.delete(file); }
  };
  const wait = async (file, point, request, last) => {
    const hold = holds.get(file);
    if (!hold || hold.point !== point) return;
    arrival(file).resolve();
    // A repeated value leaves out vectors, which would count as new progress.
    const { vectors: _vectors, ...repeated } = last ?? {};
    const beat = control.heartbeat && last ? setInterval(() => request.progress({ ...repeated }), 20) : null;
    try { await Promise.race([hold.promise, request.stopped]); } finally { clearInterval(beat); }
  };
  const build = async (args, request) => {
    const files = args.files.map((file) => file.file).sort();
    control.builds.push({ files, mirror: args.mirror, changedFiles: args.changedFiles, removedFiles: args.removedFiles, previousEmbeddings: Object.keys(args.previousEmbeddings || {}).sort(), fragmentsOnly: Boolean(args.fragmentsOnly) });
    const units = [], chunks = [], fileCoverage = {}, syntaxCoverage = {};
    let last = null;
    const report = (value) => { last = value; request.progress(value); };
    for (const [position, { file, hash }] of [...args.files].sort((left, right) => left.file < right.file ? -1 : 1).entries()) {
      const content = await readFile(path.join(args.mirror, file), "utf8");
      if (sha256(content) !== hash) throw Object.assign(new Error("The snapshot mirror changed."), { code: "stale_snapshot" });
      report({ phase: "graph:parsing", current: position + 1, total: args.files.length });
      fileCoverage[file] = true;
      syntaxCoverage[file] = true;
      const lines = Math.max(1, content.split("\n").length - (content.endsWith("\n") ? 1 : 0));
      units.push({ id: `file:${file}`, file, kind: "file", name: file, domain: "code", range: { startLine: 1, endLine: lines }, sourceHash: hash, rangeComplete: true });
      for (const match of content.matchAll(/export function (\w+)/g)) {
        units.push({ id: `function:${file}#${match[1]}`, file, kind: "function", name: match[1], qualifiedName: match[1], selector: match[1], domain: "code",
          range: { startLine: 1, endLine: lines }, span: { start: match.index, end: content.length - 1 }, contentHash: sha256(content.slice(match.index, content.length - 1)),
          sourceHash: hash, rangeComplete: true, isExported: true });
      }
      chunks.push({ id: `chunk:${file}`, parentId: `file:${file}`, file, kind: "file", name: file, role: "whole", range: { startLine: 1, endLine: lines },
        rangeComplete: true, sourceStart: 0, sourceEnd: content.length, prefixLength: 0, text: content, embeddingText: content, context: "", embeddingKey: embeddingKey(content) });
    }
    const index = { schemaVersion: 1, chunkerVersion: "fake-chunker", modelIdentity: "fake-model", snapshot: args.snapshot, units, edges: [], unresolvedReferences: [], chunks,
      fileCoverage, syntaxCoverage, diagnostics: [], counts: { files: args.files.length, units: units.length, fragments: chunks.length, reusedEmbeddings: 0, newEmbeddings: 0 },
      structureComplete: true, resources: { rssBytes: 0, peakRssBytes: 0 } };
    for (const file of files) await wait(file, "structure", request, last);
    report({ phase: "structure", index: structuredClone(index) });
    if (args.fragmentsOnly) return index;
    const missing = chunks.filter((chunk) => !args.previousEmbeddings?.[chunk.embeddingKey]);
    report({ phase: "embedding", current: 0, total: missing.length });
    for (const chunk of chunks) {
      const previous = args.previousEmbeddings?.[chunk.embeddingKey];
      if (previous) { chunk.embedding = previous; continue; }
      await wait(chunk.file, "embedding", request, last);
      if (failures.has(chunk.file)) throw Object.assign(new Error("The native helper exited before completing its request."), { code: "preparation_failed" });
      if (control.delayMs) await Promise.race([delay(control.delayMs), request.stopped]);
      chunk.embedding = fakeVector(chunk.embeddingKey);
      report({ phase: "embedding", current: missing.indexOf(chunk) + 1, total: missing.length, vectors: [[chunk.embeddingKey, chunk.embedding]] });
    }
    index.counts = { ...index.counts, reusedEmbeddings: chunks.length - missing.length, newEmbeddings: missing.length };
    return index;
  };
  const search = async (args) => {
    const index = JSON.parse(await readFile(args.indexPath, "utf8"));
    const lexical = args.mode === "lexical" || index.chunks.some((chunk) => !chunk.embedding);
    control.searches.push({ mode: args.mode ?? null, indexPath: args.indexPath });
    const paths = args.filters?.paths || [];
    return index.units
      .filter((unit) => unit.kind === "function" && (!paths.length || paths.some((prefix) => unit.file === prefix || unit.file.startsWith(`${prefix}/`))))
      .map((unit) => ({ ...unit, cosineSimilarity: lexical ? null : control.cosine[unit.file] ?? 0.5, lexicalScore: control.lexical[unit.file] ?? 1, fusedScore: 0, excerpt: "" }))
      .sort((left, right) => right.lexicalScore - left.lexicalScore || left.file.localeCompare(right.file))
      .slice(0, args.limit)
      .map((result, position) => ({ ...result, fusedRank: position + 1 }));
  };
  const helper = {
    async request(method, args, progress = () => {}) {
      if (method !== "build") return search(args);
      let stop;
      const request = { progress, stopped: new Promise((_, reject) => { stop = reject; }) };
      request.stopped.catch(() => {});
      pending.add(stop);
      try { return await Promise.race([build(args, request), request.stopped]); } finally { pending.delete(stop); }
    },
    stop() {
      control.stops += 1;
      for (const stop of pending) stop(Object.assign(new Error("The native helper stopped."), { code: "preparation_failed" }));
      pending.clear();
    }
  };
  runtime.helper = () => helper;
  runtime.store = runtime.inProcessStore();
  return { runtime, control };
}

/** Polls until `check` returns a truthy value, or fails after about four seconds. */
export async function until(check, message = "The expected state did not arrive.", { timeoutMs = null } = {}) {
  // Without a timeout the check runs 200 times; a wait that outlasts a stall period names its own timeout instead.
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  for (let attempt = 0; deadline === null ? attempt < 200 : Date.now() < deadline; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}
