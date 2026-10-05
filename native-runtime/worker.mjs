// Generated from worker.mts by scripts/native-build/compile.mjs.
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { create, insertMultiple, search } from "@orama/orama";
import { AutoTokenizer, AutoModel, env } from "@huggingface/transformers";
import { Tokenizer } from "@huggingface/tokenizers";
import { CHUNKER_VERSION, CODE_EXTENSIONS, extractTextConcepts, resolveTextLinks, fragmentConcept, bgeSourceBoundaries } from "./concepts.mjs";
import { extractGraph } from "./graph.mjs";
import { embedFragments } from "./embeddings.mjs";
const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
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
let current;
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
async function database(index) {
  const db = create({
    schema: { text: "string", domain: "enum", file: "string", kind: "enum", embedding: "vector[384]" },
    components: { tokenizer: { stemming: false } }
  });
  await insertMultiple(db, index.chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text.replace(/([a-z])([A-Z])/g, "$1 $2"),
    domain: chunk.domain,
    file: chunk.file,
    kind: chunk.kind,
    embedding: chunk.embedding
  })));
  return db;
}
async function build(args, progress) {
  await loadModel(args.modelDirectory, args.modelIdentity);
  const files = [];
  for (const meta of args.files) {
    const text = await readFile(path.join(args.mirror, meta.file), "utf8");
    if (sha(text) !== meta.hash) throw Object.assign(new Error("The snapshot mirror changed."), { code: "stale_snapshot" });
    files.push({ ...meta, content: text });
  }
  const graph = await extractGraph(args.mirror, files, runtimeDirectory, progress);
  const groups = files.map(extractTextConcepts);
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
  const detailedFiles = new Set(units.filter((item) => item.kind !== "file").map((item) => item.file));
  const chunks = [];
  for (const concept of units) {
    if (concept.kind === "file" && detailedFiles.has(concept.file) && fileCoverage[concept.file]) continue;
    chunks.push(...fragmentConcept(concept, byFile.get(concept.file), countTokens, 512, boundaries));
    if (chunks.length > 1e5) throw Object.assign(new Error("The concept index exceeds 100,000 fragments."), { code: "resource_limit" });
  }
  const embeddingCounts = await embedFragments(chunks, modelIdentity, args.previousEmbeddings || {}, embed, progress);
  const index = {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    modelIdentity,
    snapshot: args.snapshot,
    units,
    edges,
    chunks,
    fileCoverage,
    diagnostics,
    syntaxCoverage,
    structureCounts: Object.fromEntries(groups.map((group) => [group.units[0].file, group.counts])),
    tokenCounts: Object.fromEntries(files.map((file) => [file.file, tokenizer.encode(file.content, { add_special_tokens: false }).length])),
    counts: { files: files.length, concepts: units.length, fragments: chunks.length, ...embeddingCounts },
    structureComplete: !diagnostics.some((item) => !item.file),
    resources: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  };
  current = { index, db: await database(index) };
  return index;
}
async function query(args) {
  await loadModel(args.modelDirectory, args.modelIdentity);
  if (!current || current.index.snapshot !== args.snapshot || current.index.modelIdentity !== args.modelIdentity) {
    const index = JSON.parse(await readFile(args.indexPath, "utf8"));
    if (index.snapshot !== args.snapshot || index.modelIdentity !== args.modelIdentity) throw Object.assign(new Error("The concept index is stale."), { code: "stale_snapshot" });
    current = { index, db: await database(index) };
  }
  const prefix = "Represent this sentence for searching relevant passages: ";
  if (countTokens(prefix + args.query) > 512) throw Object.assign(new Error("The search query exceeds the model token limit."), { code: "validation_failed" });
  const where = {};
  if (args.filters?.domains?.length) where.domain = { in: args.filters.domains };
  if (args.filters?.kinds?.length) where.kind = { in: args.filters.kinds };
  const candidateLimit = current.index.chunks.length;
  if (candidateLimit === 0) return [];
  const lexical = await search(current.db, { term: args.query.replace(/([a-z])([A-Z])/g, "$1 $2"), limit: candidateLimit, where });
  const dense = args.mode === "lexical" ? { hits: [] } : await search(current.db, { mode: "vector", vector: { property: "embedding", value: (await embed([prefix + args.query]))[0] }, similarity: -1, limit: candidateLimit, where });
  const chunks = new Map(current.index.chunks.map((chunk) => [chunk.id, chunk]));
  const allowed = (id) => !args.filters?.paths?.length || args.filters.paths.some((prefix2) => chunks.get(id).file === prefix2 || chunks.get(id).file.startsWith(`${prefix2}/`));
  const fused = /* @__PURE__ */ new Map();
  for (const [mode, hits] of [["lexicalScore", lexical.hits], ["cosineSimilarity", dense.hits]]) {
    for (const [rank, hit] of hits.filter((hit2) => allowed(hit2.id)).entries()) {
      const item = fused.get(hit.id) || { id: hit.id, fusedScore: 0, lexicalScore: null, cosineSimilarity: null };
      item[mode] = hit.score;
      item.fusedScore += 1 / (60 + rank + 1);
      fused.set(hit.id, item);
    }
  }
  const exactHint = (id) => {
    const chunk = chunks.get(id);
    return [chunk.file, chunk.name, chunk.qualifiedName, chunk.selector].includes(args.query.trim()) ? 1 : 0;
  };
  return [...fused.values()].sort((a, b) => exactHint(b.id) - exactHint(a.id) || b.fusedScore - a.fusedScore || a.id.localeCompare(b.id)).slice(0, args.limit).map((score, index) => {
    const { text, embeddingText, embedding, embeddingKey, prefixLength, ...concept } = chunks.get(score.id);
    return { ...concept, ...score, fusedRank: index + 1, excerpt: text.slice(prefixLength, prefixLength + 600) };
  });
}
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
