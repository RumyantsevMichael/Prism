import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { create, insertMultiple, search } from "@orama/orama";
import { AutoTokenizer, AutoModel, env } from "@huggingface/transformers";
import { Tokenizer } from "@huggingface/tokenizers";
import { CHUNKER_VERSION, CODE_EXTENSIONS, extractTextUnits, resolveTextLinks, bgeSourceBoundaries } from "./units.mjs";
import { assignContainers, planFragments } from "./fragments.mjs";
import type { FragmentCache } from "./fragments.mjs";
import { searchExclusion } from "./domains.mjs";
import { extractGraph } from "./graph.mjs";
import { embedFragments, embeddingKey } from "./embeddings.mjs";
import { FUSION_OFFSET, fusionWeights } from "./fusion.mjs";
import type { UnitIndex, Fragment, SourceUnit, BuildArguments, SearchArguments, SearchResult, Progress, WorkerRequest } from "../server/repository-intelligence/repository-unit-types.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_BOOST = 0.5;
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "this", "to", "what", "when", "where", "which", "while", "who", "why", "with"]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
console.log = (...args) => console.error(...args);
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | undefined;
let modelIdentity: string;
// The index that the latest search read, with its database; a build keeps none, because searches go to a helper of their own.
type Loaded = { index: UnitIndex; db: Awaited<ReturnType<typeof database>>; vectors: boolean };
// Searches over many component indexes read each one, so recently used indexes stay loaded, most recent last, while memory allows.
// The newest index always stays, and older ones leave while the process holds more than this many bytes.
const LOADED_BYTES = 1.5 * 1024 * 1024 * 1024;
const loaded = new Map<string, Loaded>();
// A structure-only index and the complete index of one snapshot are different files, so the key names the file too.
const loadedKey = (snapshot: string, identity: string, indexPath: string) => `${snapshot}\0${identity}\0${indexPath}`;
function keep(value: Loaded, indexPath: string) {
  const key = loadedKey(value.index.snapshot, value.index.modelIdentity, indexPath);
  loaded.delete(key); loaded.set(key, value);
  // The database holds each vector, so the fragments no longer need their own copy.
  for (const chunk of value.index.chunks) delete chunk.embedding;
  for (const [other] of loaded) {
    if (loaded.size <= 1 || process.memoryUsage().rss <= LOADED_BYTES) break;
    loaded.delete(other);
  }
}
// One query embedding serves every component index that the same search reads.
let lastQuery: { text: string; identity: string; vector: number[] } | undefined;
let boundaries: (text: string) => number[];

async function loadModel(directory: string, identity: string) {
  if (model && modelIdentity === identity) return;
  await model?.dispose();
  tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const configuration = JSON.parse(await readFile(path.join(directory, "tokenizer.json"), "utf8"));
  const settings = JSON.parse(await readFile(path.join(directory, "tokenizer_config.json"), "utf8"));
  boundaries = bgeSourceBoundaries(new Tokenizer(configuration, settings), configuration);
  model = await AutoModel.from_pretrained(directory, { local_files_only: true, dtype: "q8", device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
  modelIdentity = identity;
}

const countTokens = (text: string) => tokenizer.encode(text).length;
async function embed(texts: string[]): Promise<number[][]> {
  const inputs = tokenizer(texts, { padding: true, truncation: false });
  if (inputs.input_ids.dims.at(-1)! > 512) throw Object.assign(new Error("The model input exceeds 512 tokens."), { code: "resource_limit" });
  const output = await model!(inputs);
  const tensor = output.last_hidden_state as import("@huggingface/transformers").Tensor;
  if (!(tensor.data instanceof Float32Array)) throw new Error("The pinned model returned an unexpected tensor type.");
  const [batch, sequence, dimensions] = tensor.dims;
  const vectors = [];
  for (let b = 0; b < batch; b++) {
    const vector = Array.from(tensor.data.slice(b * sequence * dimensions, b * sequence * dimensions + dimensions));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    vectors.push(vector.map(value => value / norm));
  }
  for (const value of Object.values(output) as import("@huggingface/transformers").Tensor[]) value.dispose?.();
  for (const value of Object.values(inputs)) value.dispose?.();
  return vectors;
}

// An index whose fragments carry no embedding, such as a structure-only index, gets a database without vectors, which answers lexically only.
export const hasEmbeddings = (index: UnitIndex) => index.chunks.length > 0 && index.chunks.every(chunk => Array.isArray(chunk.embedding));

async function database(index: UnitIndex) {
  // The file path is not a lexical field. The context field holds the logical path and module name with a lower weight.
  const vectors = hasEmbeddings(index);
  const db = create({ schema: { text: "string", context: "string", domain: "enum", kind: "enum", ...(vectors ? { embedding: "vector[384]" as const } : {}) },
    components: { tokenizer: { stemming: false } } });
  const split = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2");
  await insertMultiple(db, index.chunks.map(chunk => ({ id: chunk.id, text: split(chunk.text), context: split(chunk.context || ""), domain: chunk.domain,
    kind: chunk.kind, ...(vectors ? { embedding: chunk.embedding! } : {}) })));
  return db;
}

// What planning fragments needs from the model's tokenizer, so the structure of a build can be computed without the model.
export interface StructureTools { countTokens: (text: string) => number; fileTokens: (text: string) => number; boundaries?: (text: string) => number[] }

async function build(args: BuildArguments, progress: (value: Progress) => void): Promise<UnitIndex> {
  await loadModel(args.modelDirectory, args.modelIdentity);
  const index = await structure(args, progress, { countTokens, fileTokens: text => tokenizer.encode(text, { add_special_tokens: false }).length, boundaries });
  // The structure is reported once, before any fragment is embedded, so Prism can publish it while embeddings fill.
  progress({ phase: "structure", index } as Progress);
  if (args.fragmentsOnly) return index;
  const embeddingCounts = await embedFragments(index.chunks, modelIdentity, args.previousEmbeddings || {}, embed, progress);
  index.counts = { ...index.counts, ...embeddingCounts };
  index.resources = { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  return index;
}

// What a build derived from each file, kept in the runtime's state folder so a later build of the same file reuses it: its text units before
// links between files were resolved, its token count, and its fragments by the units they were planned from. Each entry is keyed by the file's hash,
// and the whole record by the chunker version and the model whose tokenizer counted the tokens, so a stale entry is never reused.
type Group = ReturnType<typeof extractTextUnits>;
interface DerivedFile { hash: string; group?: Group; tokens?: number; fragments?: { key: string; planned: [string, Fragment[]][] } }
interface Derived { schemaVersion: 1; chunkerVersion: string; modelIdentity: string; files: Record<string, DerivedFile> }
const DERIVED_STATE = "derived.json";

// A mirror named `mirror` keeps the runtime's state in `runtime-state` beside it, which Prism empties whenever it cannot trust the mirror.
export const stateDirectory = (mirror: string) => path.basename(mirror) === "mirror" ? path.join(path.dirname(mirror), "runtime-state") : undefined;

async function readDerived(directory: string, modelIdentity: string): Promise<Derived["files"]> {
  try {
    const derived: Derived = JSON.parse(await readFile(path.join(directory, DERIVED_STATE), "utf8"));
    return derived?.schemaVersion === 1 && derived.chunkerVersion === CHUNKER_VERSION && derived.modelIdentity === modelIdentity && derived.files && typeof derived.files === "object" ? derived.files : {};
  } catch { return {}; }
}

async function writeDerived(directory: string, modelIdentity: string, files: Derived["files"]) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `${DERIVED_STATE}.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, chunkerVersion: CHUNKER_VERSION, modelIdentity, files } satisfies Derived), { mode: 0o600 });
    await rename(temporary, path.join(directory, DERIVED_STATE));
  } catch { /* A state that cannot be written costs only the next build's reuse. */ }
}

// The units a file's fragments are planned from, with their containers, decide its fragments, together with whether its structure is complete.
const fragmentKey = (hash: string, structured: boolean, units: SourceUnit[]) => sha(JSON.stringify([hash, structured, units]));

/** The complete index of a build's files except that no fragment carries an embedding. */
export async function structure(args: BuildArguments, progress: (value: Progress) => void, tools: StructureTools): Promise<UnitIndex> {
  const files = [];
  for (const meta of args.files) {
    const text = await readFile(path.join(args.mirror, meta.file), "utf8");
    if (sha(text) !== meta.hash) throw Object.assign(new Error("The snapshot mirror changed."), { code: "stale_snapshot" });
    files.push({ ...meta, content: text });
  }
  // A build with change lists reuses what earlier builds derived from unchanged files; a full build derives everything and keeps it for the next build.
  const state = stateDirectory(args.mirror);
  const changes = args.changedFiles && args.removedFiles ? { changedFiles: args.changedFiles, removedFiles: args.removedFiles } : undefined;
  const previous = state && changes ? await readDerived(state, args.modelIdentity) : {};
  const derived: Derived["files"] = {};
  const reusable = (file: { file: string; hash: string }) => previous[file.file]?.hash === file.hash ? previous[file.file] : undefined;
  const graph = await extractGraph(args.mirror, files, runtimeDirectory, progress, state ? { directory: state, ...(changes ? { changes } : {}) } : undefined);
  const groups = files.map(file => {
    const kept = reusable(file)?.group;
    const group = kept ? structuredClone(kept) : extractTextUnits(file);
    // Resolving links changes a group, so the state keeps the group as its file alone gave it.
    derived[file.file] = { hash: file.hash, group: kept ?? structuredClone(group) };
    return group;
  });
  resolveTextLinks(groups);
  const units = [...graph.nodes];
  const edges = [...graph.edges];
  const diagnostics = [...graph.diagnostics];
  const fileCoverage: Record<string, boolean> = {};
  const syntaxCoverage: Record<string, boolean> = {};
  for (const group of groups) {
    const file = group.units[0].file, code = CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
    syntaxCoverage[file] = code ? graph.parsedFiles.includes(file) : group.supported && !group.diagnostics.length;
    if (code) {
      units.push(group.units[0]);
      for (const node of graph.nodes.filter(node => node.file === file)) edges.push({ source: group.units[0].id, target: node.id, kind: "contains", provenance: "parser" });
      fileCoverage[file] = graph.files.includes(file);
    } else { units.push(...group.units); edges.push(...group.edges); fileCoverage[file] = group.supported; }
    diagnostics.push(...group.diagnostics);
  }
  for (const diagnostic of diagnostics) if (diagnostic.file) fileCoverage[diagnostic.file] = false;
  const byFile = new Map(files.map(file => [file.file, file]));
  // Excluded files keep structural coverage for conservation evidence, but supply no search candidates.
  const excluded = new Set(files.filter(file => searchExclusion(file.file, file.content)).map(file => file.file));
  assignContainers(units, edges, byFile);
  // Unresolved references clear file coverage, but parsed symbols still represent the file.
  const cache: FragmentCache = {
    get(file, list) {
      const kept = reusable(byFile.get(file)!)?.fragments;
      if (!kept || kept.key !== fragmentKey(byFile.get(file)!.hash, Boolean(syntaxCoverage[file]), list)) return undefined;
      derived[file].fragments = kept;
      return new Map(structuredClone(kept.planned));
    },
    set(file, list, planned) {
      derived[file].fragments = { key: fragmentKey(byFile.get(file)!.hash, Boolean(syntaxCoverage[file]), list), planned: structuredClone([...planned]) };
    }
  };
  const chunks: Fragment[] = planFragments(units, byFile, { countTokens: tools.countTokens, boundaries: tools.boundaries, limit: 512,
    isCandidate: unit => !excluded.has(unit.file) && unit.kind !== "import", isStructured: file => Boolean(syntaxCoverage[file]), ...(state ? { cache } : {}) });
  if (chunks.length > 100000) throw Object.assign(new Error("The semantic index exceeds 100,000 fragments."), { code: "resource_limit" });
  // The structure names each fragment's embedding key as the complete index does, and only the embeddings are missing.
  for (const chunk of chunks) chunk.embeddingKey = embeddingKey(args.modelIdentity, chunk.embeddingText);
  const index: UnitIndex = { schemaVersion: 1, chunkerVersion: CHUNKER_VERSION, modelIdentity: args.modelIdentity, snapshot: args.snapshot, units, edges, unresolvedReferences: graph.references, unresolvedByFile: graph.unresolvedByFile, chunks, fileCoverage, diagnostics,
    syntaxCoverage, structureCounts: Object.fromEntries(groups.map(group => [group.units[0].file, group.counts])),
    tokenCounts: Object.fromEntries(files.map(file => [file.file, derived[file.file].tokens = reusable(file)?.tokens ?? tools.fileTokens(file.content)])),
    counts: { files: files.length, units: units.length, fragments: chunks.length, searchExcludedFiles: excluded.size, reusedEmbeddings: 0, newEmbeddings: 0 },
    structureComplete: !diagnostics.some(item => !item.file), resources: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 } };
  if (state) await writeDerived(state, args.modelIdentity, derived);
  return index;
}

/** Answers a search; `mode: "lexical"`, or an index without embeddings, answers from fragment text alone without loading the model. */
export async function query(args: SearchArguments): Promise<SearchResult[]> {
  let current = loaded.get(loadedKey(args.snapshot, args.modelIdentity, args.indexPath));
  if (!current) {
    const index: UnitIndex = JSON.parse(await readFile(args.indexPath, "utf8"));
    if (index.snapshot !== args.snapshot || index.modelIdentity !== args.modelIdentity) throw Object.assign(new Error("The semantic index is stale."), { code: "stale_snapshot" });
    current = { index, db: await database(index), vectors: hasEmbeddings(index) };
  }
  keep(current, args.indexPath);
  const lexicalOnly = args.mode === "lexical" || !current.vectors;
  if (!lexicalOnly) await loadModel(args.modelDirectory, args.modelIdentity);
  const prefix = "Represent this sentence for searching relevant passages: ";
  // Bound long queries through the same tokenizer instead of silently truncating.
  if (!lexicalOnly && countTokens(prefix + args.query) > 512) throw Object.assign(new Error("The search query exceeds the model token limit."), { code: "validation_failed" });
  const where: { domain?: { in: string[] }; kind?: { in: string[] } } = {};
  if (args.filters?.domains?.length) where.domain = { in: args.filters.domains };
  if (args.filters?.kinds?.length) where.kind = { in: args.filters.kinds };
  const candidateLimit = current.index.chunks.length;
  if (candidateLimit === 0) return [];
  const words = args.query.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
  const term = words.filter(word => !STOP_WORDS.has(word.toLowerCase())).join(" ") || words.join(" ");
  const lexical = await search(current.db, { term, properties: ["text", "context"], boost: { context: CONTEXT_BOOST }, limit: candidateLimit, where });
  if (!lexicalOnly && (lastQuery?.text !== args.query || lastQuery.identity !== args.modelIdentity))
    lastQuery = { text: args.query, identity: args.modelIdentity, vector: (await embed([prefix + args.query]))[0] };
  const dense = lexicalOnly ? { hits: [] } : await search(current.db, { mode: "vector", vector: { property: "embedding", value: lastQuery!.vector }, similarity: -1, limit: candidateLimit, where });
  const chunks = new Map(current.index.chunks.map(chunk => [chunk.id, chunk]));
  const allowed = (id: string) => !args.filters?.paths?.length || args.filters.paths.some(prefix => chunks.get(id)!.file === prefix || chunks.get(id)!.file.startsWith(`${prefix}/`));
  const fused = new Map<string, { id: string; fusedScore: number; lexicalScore: number | null; cosineSimilarity: number | null }>();
  const weights = fusionWeights(args.query);
  for (const [mode, hits] of [["lexicalScore", lexical.hits], ["cosineSimilarity", dense.hits]] as const) {
    for (const [rank, hit] of hits.filter(hit => allowed(hit.id)).entries()) {
      const item = fused.get(hit.id) || { id: hit.id, fusedScore: 0, lexicalScore: null, cosineSimilarity: null };
      item[mode] = hit.score;
      item.fusedScore += weights[mode] / (FUSION_OFFSET + rank + 1);
      fused.set(hit.id, item);
    }
  }
  const exactHint = (id: string) => {
    const chunk = chunks.get(id)!;
    return [chunk.file, chunk.name, chunk.qualifiedName, chunk.selector].includes(args.query.trim()) ? 1 : 0;
  };
  const ranked = [...fused.values()].sort((a, b) => exactHint(b.id) - exactHint(a.id) || b.fusedScore - a.fusedScore || a.id.localeCompare(b.id));
  // Return distinct candidates: one fragment per unit, and no range that overlaps a better unrelated result in the same file.
  // An outline and its members answer different questions, so an ancestor and its descendant can both appear.
  const units = new Map(current.index.units.map(unit => [unit.id, unit]));
  const containers = new Map(current.index.units.map(unit => [unit.id, unit.containerId]));
  const related = (a: string, b: string) => {
    for (let id = containers.get(a); id; id = containers.get(id)) if (id === b) return true;
    for (let id = containers.get(b); id; id = containers.get(id)) if (id === a) return true;
    return false;
  };
  const selected: (typeof ranked[number] & { groupedMembers?: number })[] = [];
  for (const score of ranked) {
    if (selected.length >= args.limit) break;
    const chunk = chunks.get(score.id)!;
    if (selected.some(item => {
      const other = chunks.get(item.id)!;
      if (other.parentId === chunk.parentId) return true;
      return other.file === chunk.file && other.range.startLine <= chunk.range.endLine && chunk.range.startLine <= other.range.endLine && !related(other.parentId, chunk.parentId);
    })) continue;
    selected.push(score);
  }
  // When several results share a class or section, that container is also a candidate, placed after its best member.
  const parentOf = (id: string) => containers.get(chunks.get(id)!.parentId);
  const members = new Map<string, number>();
  for (const item of selected) { const parent = parentOf(item.id); if (parent && units.get(parent)!.kind !== "file") members.set(parent, (members.get(parent) || 0) + 1); }
  for (const [parent, count] of members) {
    const outline = chunks.get(parent);
    if (count < 2 || outline?.role !== "outline" || (args.filters?.kinds?.length && !args.filters.kinds.includes(outline.kind)) || selected.some(item => chunks.get(item.id)!.parentId === parent)) continue;
    const at = selected.findIndex(item => parentOf(item.id) === parent);
    selected.splice(at + 1, 0, { id: parent, fusedScore: selected[at].fusedScore, lexicalScore: null, cosineSimilarity: null, groupedMembers: count });
  }
  selected.length = Math.min(selected.length, args.limit);
  const ancestry = (id: string) => {
    const names: string[] = [];
    for (let parent = containers.get(id); parent && units.get(parent)!.kind !== "file"; parent = containers.get(parent)) names.unshift(units.get(parent)!.name);
    return names;
  };
  return selected.map((score, index) => {
    const { text, embeddingText, embedding, embeddingKey, prefixLength, context, excerpt, ...unit } = chunks.get(score.id)!;
    return { ...unit, ...score, ancestry: ancestry(unit.parentId), fusedRank: index + 1, excerpt: excerpt ?? text.slice(prefixLength, prefixLength + 600) };
  });
}

// A test that imports the worker's functions sets PRISM_WORKER_LIBRARY, so importing it does not start reading requests.
if (!process.env.PRISM_WORKER_LIBRARY) serve();
function serve() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on("line", line => {
    pending = pending.then(async () => {
      let request: WorkerRequest | undefined;
      try {
        request = JSON.parse(line);
        const progress = (value: Progress) => send({ id: request!.id, progress: value });
        if (!request) throw new Error("The worker request is missing.");
        const result = request.method === "build" ? await build(request.args, progress) : request.method === "search" ? await query(request.args) : (() => { throw new Error("Unknown native worker method."); })();
        send({ id: request.id, result });
      } catch (error) { send({ id: request?.id, error: { code: error.code || "preparation_failed", message: error.message } }); }
    });
  });
}
