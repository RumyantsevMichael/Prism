// Generated from src/native-runtime/worker.mts by scripts/native-build/compile.mjs.
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
import { searchExclusion } from "./domains.mjs";
import { extractGraph } from "./graph.mjs";
import { embedFragments, embeddingKey } from "./embeddings.mjs";
import { FUSION_OFFSET, fusionWeights } from "./fusion.mjs";
const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_BOOST = 0.5;
const STOP_WORDS = /* @__PURE__ */ new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "this", "to", "what", "when", "where", "which", "while", "who", "why", "with"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}
`);
console.log = (...args) => console.error(...args);
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
let tokenizer;
let model;
let modelIdentity;
const LOADED_BYTES = 1.5 * 1024 * 1024 * 1024;
const loaded = /* @__PURE__ */ new Map();
const loadedKey = (snapshot, identity, indexPath) => `${snapshot}\0${identity}\0${indexPath}`;
function keep(value, indexPath) {
  const key = loadedKey(value.index.snapshot, value.index.modelIdentity, indexPath);
  loaded.delete(key);
  loaded.set(key, value);
  for (const chunk of value.index.chunks) delete chunk.embedding;
  for (const [other] of loaded) {
    if (loaded.size <= 1 || process.memoryUsage().rss <= LOADED_BYTES) break;
    loaded.delete(other);
  }
}
let lastQuery;
let boundaries;
async function loadModel(directory, identity) {
  if (model && modelIdentity === identity) return;
  await model?.dispose();
  tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const configuration = JSON.parse(await readFile(path.join(directory, "tokenizer.json"), "utf8"));
  const settings = JSON.parse(await readFile(path.join(directory, "tokenizer_config.json"), "utf8"));
  boundaries = bgeSourceBoundaries(new Tokenizer(configuration, settings), configuration);
  model = await AutoModel.from_pretrained(directory, {
    local_files_only: true,
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
  });
  modelIdentity = identity;
}
const countTokens = (text) => tokenizer.encode(text).length;
async function embed(texts) {
  const inputs = tokenizer(texts, { padding: true, truncation: false });
  if (inputs.input_ids.dims.at(-1) > 512) throw Object.assign(new Error("The model input exceeds 512 tokens."), { code: "resource_limit" });
  const output = await model(inputs);
  const tensor = output.last_hidden_state;
  if (!(tensor.data instanceof Float32Array)) throw new Error("The pinned model returned an unexpected tensor type.");
  const [batch, sequence, dimensions] = tensor.dims;
  const vectors = [];
  for (let b = 0; b < batch; b++) {
    const vector = Array.from(tensor.data.slice(b * sequence * dimensions, b * sequence * dimensions + dimensions));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    vectors.push(vector.map((value) => value / norm));
  }
  for (const value of Object.values(output)) value.dispose?.();
  for (const value of Object.values(inputs)) value.dispose?.();
  return vectors;
}
const hasEmbeddings = (index) => index.chunks.length > 0 && index.chunks.every((chunk) => Array.isArray(chunk.embedding));
async function database(index) {
  const vectors = hasEmbeddings(index);
  const db = create({
    schema: { text: "string", context: "string", domain: "enum", kind: "enum", ...vectors ? { embedding: "vector[384]" } : {} },
    components: { tokenizer: { stemming: false } }
  });
  const split = (value) => value.replace(/([a-z])([A-Z])/g, "$1 $2");
  await insertMultiple(db, index.chunks.map((chunk) => ({
    id: chunk.id,
    text: split(chunk.text),
    context: split(chunk.context || ""),
    domain: chunk.domain,
    kind: chunk.kind,
    ...vectors ? { embedding: chunk.embedding } : {}
  })));
  return db;
}
async function build(args, progress) {
  await loadModel(args.modelDirectory, args.modelIdentity);
  const index = await structure(args, progress, { countTokens, fileTokens: (text) => tokenizer.encode(text, { add_special_tokens: false }).length, boundaries });
  progress({ phase: "structure", index });
  if (args.fragmentsOnly) return index;
  const embeddingCounts = await embedFragments(index.chunks, modelIdentity, args.previousEmbeddings || {}, embed, progress);
  index.counts = { ...index.counts, ...embeddingCounts };
  index.resources = { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  return index;
}
const DERIVED_STATE = "derived.json";
const stateDirectory = (mirror) => path.basename(mirror) === "mirror" ? path.join(path.dirname(mirror), "runtime-state") : void 0;
async function readDerived(directory, modelIdentity2) {
  try {
    const derived = JSON.parse(await readFile(path.join(directory, DERIVED_STATE), "utf8"));
    return derived?.schemaVersion === 1 && derived.chunkerVersion === CHUNKER_VERSION && derived.modelIdentity === modelIdentity2 && derived.files && typeof derived.files === "object" ? derived.files : {};
  } catch {
    return {};
  }
}
async function writeDerived(directory, modelIdentity2, files) {
  try {
    await mkdir(directory, { recursive: true, mode: 448 });
    const temporary = path.join(directory, `${DERIVED_STATE}.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, chunkerVersion: CHUNKER_VERSION, modelIdentity: modelIdentity2, files }), { mode: 384 });
    await rename(temporary, path.join(directory, DERIVED_STATE));
  } catch {
  }
}
const fragmentKey = (hash, structured, units) => sha(JSON.stringify([hash, structured, units]));
async function structure(args, progress, tools) {
  const files = [];
  for (const meta of args.files) {
    const text = await readFile(path.join(args.mirror, meta.file), "utf8");
    if (sha(text) !== meta.hash) throw Object.assign(new Error("The snapshot mirror changed."), { code: "stale_snapshot" });
    files.push({ ...meta, content: text });
  }
  const state = stateDirectory(args.mirror);
  const changes = args.changedFiles && args.removedFiles ? { changedFiles: args.changedFiles, removedFiles: args.removedFiles } : void 0;
  const previous = state && changes ? await readDerived(state, args.modelIdentity) : {};
  const derived = {};
  const reusable = (file) => previous[file.file]?.hash === file.hash ? previous[file.file] : void 0;
  const graph = await extractGraph(args.mirror, files, runtimeDirectory, progress, state ? { directory: state, ...changes ? { changes } : {} } : void 0);
  const groups = files.map((file) => {
    const kept = reusable(file)?.group;
    const group = kept ? structuredClone(kept) : extractTextUnits(file);
    derived[file.file] = { hash: file.hash, group: kept ?? structuredClone(group) };
    return group;
  });
  resolveTextLinks(groups);
  const units = [...graph.nodes];
  const edges = [...graph.edges];
  const diagnostics = [...graph.diagnostics];
  const fileCoverage = {};
  const syntaxCoverage = {};
  for (const group of groups) {
    const file = group.units[0].file, code = CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
    syntaxCoverage[file] = code ? graph.parsedFiles.includes(file) : group.supported && !group.diagnostics.length;
    if (code) {
      units.push(group.units[0]);
      for (const node of graph.nodes.filter((node2) => node2.file === file)) edges.push({ source: group.units[0].id, target: node.id, kind: "contains", provenance: "parser" });
      fileCoverage[file] = graph.files.includes(file);
    } else {
      units.push(...group.units);
      edges.push(...group.edges);
      fileCoverage[file] = group.supported;
    }
    diagnostics.push(...group.diagnostics);
  }
  for (const diagnostic of diagnostics) if (diagnostic.file) fileCoverage[diagnostic.file] = false;
  const byFile = new Map(files.map((file) => [file.file, file]));
  const excluded = new Set(files.filter((file) => searchExclusion(file.file, file.content)).map((file) => file.file));
  assignContainers(units, edges, byFile);
  const cache = {
    get(file, list) {
      const kept = reusable(byFile.get(file))?.fragments;
      if (!kept || kept.key !== fragmentKey(byFile.get(file).hash, Boolean(syntaxCoverage[file]), list)) return void 0;
      derived[file].fragments = kept;
      return new Map(structuredClone(kept.planned));
    },
    set(file, list, planned) {
      derived[file].fragments = { key: fragmentKey(byFile.get(file).hash, Boolean(syntaxCoverage[file]), list), planned: structuredClone([...planned]) };
    }
  };
  const chunks = planFragments(units, byFile, {
    countTokens: tools.countTokens,
    boundaries: tools.boundaries,
    limit: 512,
    isCandidate: (unit) => !excluded.has(unit.file) && unit.kind !== "import",
    isStructured: (file) => Boolean(syntaxCoverage[file]),
    ...state ? { cache } : {}
  });
  if (chunks.length > 1e5) throw Object.assign(new Error("The semantic index exceeds 100,000 fragments."), { code: "resource_limit" });
  for (const chunk of chunks) chunk.embeddingKey = embeddingKey(args.modelIdentity, chunk.embeddingText);
  const index = {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    modelIdentity: args.modelIdentity,
    snapshot: args.snapshot,
    units,
    edges,
    unresolvedReferences: graph.references,
    unresolvedByFile: graph.unresolvedByFile,
    chunks,
    fileCoverage,
    diagnostics,
    syntaxCoverage,
    structureCounts: Object.fromEntries(groups.map((group) => [group.units[0].file, group.counts])),
    tokenCounts: Object.fromEntries(files.map((file) => [file.file, derived[file.file].tokens = reusable(file)?.tokens ?? tools.fileTokens(file.content)])),
    counts: { files: files.length, units: units.length, fragments: chunks.length, searchExcludedFiles: excluded.size, reusedEmbeddings: 0, newEmbeddings: 0 },
    structureComplete: !diagnostics.some((item) => !item.file),
    resources: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  };
  if (state) await writeDerived(state, args.modelIdentity, derived);
  return index;
}
async function query(args) {
  let current = loaded.get(loadedKey(args.snapshot, args.modelIdentity, args.indexPath));
  if (!current) {
    const index = JSON.parse(await readFile(args.indexPath, "utf8"));
    if (index.snapshot !== args.snapshot || index.modelIdentity !== args.modelIdentity) throw Object.assign(new Error("The semantic index is stale."), { code: "stale_snapshot" });
    current = { index, db: await database(index), vectors: hasEmbeddings(index) };
  }
  keep(current, args.indexPath);
  const lexicalOnly = args.mode === "lexical" || !current.vectors;
  if (!lexicalOnly) await loadModel(args.modelDirectory, args.modelIdentity);
  const prefix = "Represent this sentence for searching relevant passages: ";
  if (!lexicalOnly && countTokens(prefix + args.query) > 512) throw Object.assign(new Error("The search query exceeds the model token limit."), { code: "validation_failed" });
  const where = {};
  if (args.filters?.domains?.length) where.domain = { in: args.filters.domains };
  if (args.filters?.kinds?.length) where.kind = { in: args.filters.kinds };
  const candidateLimit = current.index.chunks.length;
  if (candidateLimit === 0) return [];
  const words = args.query.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
  const term = words.filter((word) => !STOP_WORDS.has(word.toLowerCase())).join(" ") || words.join(" ");
  const lexical = await search(current.db, { term, properties: ["text", "context"], boost: { context: CONTEXT_BOOST }, limit: candidateLimit, where });
  if (!lexicalOnly && (lastQuery?.text !== args.query || lastQuery.identity !== args.modelIdentity))
    lastQuery = { text: args.query, identity: args.modelIdentity, vector: (await embed([prefix + args.query]))[0] };
  const dense = lexicalOnly ? { hits: [] } : await search(current.db, { mode: "vector", vector: { property: "embedding", value: lastQuery.vector }, similarity: -1, limit: candidateLimit, where });
  const chunks = new Map(current.index.chunks.map((chunk) => [chunk.id, chunk]));
  const allowed = (id) => !args.filters?.paths?.length || args.filters.paths.some((prefix2) => chunks.get(id).file === prefix2 || chunks.get(id).file.startsWith(`${prefix2}/`));
  const fused = /* @__PURE__ */ new Map();
  const weights = fusionWeights(args.query);
  for (const [mode, hits] of [["lexicalScore", lexical.hits], ["cosineSimilarity", dense.hits]]) {
    for (const [rank, hit] of hits.filter((hit2) => allowed(hit2.id)).entries()) {
      const item = fused.get(hit.id) || { id: hit.id, fusedScore: 0, lexicalScore: null, cosineSimilarity: null };
      item[mode] = hit.score;
      item.fusedScore += weights[mode] / (FUSION_OFFSET + rank + 1);
      fused.set(hit.id, item);
    }
  }
  const exactHint = (id) => {
    const chunk = chunks.get(id);
    return [chunk.file, chunk.name, chunk.qualifiedName, chunk.selector].includes(args.query.trim()) ? 1 : 0;
  };
  const ranked = [...fused.values()].sort((a, b) => exactHint(b.id) - exactHint(a.id) || b.fusedScore - a.fusedScore || a.id.localeCompare(b.id));
  const units = new Map(current.index.units.map((unit) => [unit.id, unit]));
  const containers = new Map(current.index.units.map((unit) => [unit.id, unit.containerId]));
  const related = (a, b) => {
    for (let id = containers.get(a); id; id = containers.get(id)) if (id === b) return true;
    for (let id = containers.get(b); id; id = containers.get(id)) if (id === a) return true;
    return false;
  };
  const selected = [];
  for (const score of ranked) {
    if (selected.length >= args.limit) break;
    const chunk = chunks.get(score.id);
    if (selected.some((item) => {
      const other = chunks.get(item.id);
      if (other.parentId === chunk.parentId) return true;
      return other.file === chunk.file && other.range.startLine <= chunk.range.endLine && chunk.range.startLine <= other.range.endLine && !related(other.parentId, chunk.parentId);
    })) continue;
    selected.push(score);
  }
  const parentOf = (id) => containers.get(chunks.get(id).parentId);
  const members = /* @__PURE__ */ new Map();
  for (const item of selected) {
    const parent = parentOf(item.id);
    if (parent && units.get(parent).kind !== "file") members.set(parent, (members.get(parent) || 0) + 1);
  }
  for (const [parent, count] of members) {
    const outline = chunks.get(parent);
    if (count < 2 || outline?.role !== "outline" || args.filters?.kinds?.length && !args.filters.kinds.includes(outline.kind) || selected.some((item) => chunks.get(item.id).parentId === parent)) continue;
    const at = selected.findIndex((item) => parentOf(item.id) === parent);
    selected.splice(at + 1, 0, { id: parent, fusedScore: selected[at].fusedScore, lexicalScore: null, cosineSimilarity: null, groupedMembers: count });
  }
  selected.length = Math.min(selected.length, args.limit);
  const ancestry = (id) => {
    const names = [];
    for (let parent = containers.get(id); parent && units.get(parent).kind !== "file"; parent = containers.get(parent)) names.unshift(units.get(parent).name);
    return names;
  };
  return selected.map((score, index) => {
    const { text, embeddingText, embedding, embeddingKey: embeddingKey2, prefixLength, context, excerpt, ...unit } = chunks.get(score.id);
    return { ...unit, ...score, ancestry: ancestry(unit.parentId), fusedRank: index + 1, excerpt: excerpt ?? text.slice(prefixLength, prefixLength + 600) };
  });
}
if (!process.env.PRISM_WORKER_LIBRARY) serve();
function serve() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on("line", (line) => {
    pending = pending.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
        const progress = (value) => send({ id: request.id, progress: value });
        if (!request) throw new Error("The worker request is missing.");
        const result = request.method === "build" ? await build(request.args, progress) : request.method === "search" ? await query(request.args) : (() => {
          throw new Error("Unknown native worker method.");
        })();
        send({ id: request.id, result });
      } catch (error) {
        send({ id: request?.id, error: { code: error.code || "preparation_failed", message: error.message } });
      }
    });
  });
}
export {
  hasEmbeddings,
  query,
  stateDirectory,
  structure
};
