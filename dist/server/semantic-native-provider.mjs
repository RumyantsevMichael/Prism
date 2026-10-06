// Generated from src/server/semantic-native-provider.mts by scripts/native-build/compile.mjs.
import { openNativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";
import { nativeSemanticRuntime, semanticError } from "./native-semantic-runtime.mjs";
import { domainFor } from "../native-runtime/domains.mjs";
import { conservationStore } from "./conservation-store.mjs";
import { retainAnalysis } from "./conservation-analysis.mjs";
const domains = /* @__PURE__ */ new Set(["code", "instruction", "documentation", "configuration"]);
const exact = (node, value) => [node.name, node.qualifiedName, node.selector].includes(value);
const pinned = (hit) => hit.reasons?.some((reason) => ["explicit-design-reference", "expected-modification-target", "exact-symbol"].includes(reason));
const NATIVE_INTELLIGENCE_TOOLS = [
  {
    name: "discover_repository_intelligence",
    description: "Read native runtime, model, index, and structural capability status without downloads or index preparation.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string" } }, required: ["projectRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_repository_intelligence_status",
    description: "Read native preparation progress, versions, coverage, and diagnostics. Optionally wait up to thirty seconds for an existing preparation.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 3e4, default: 0 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "search_repository_concepts",
    description: "Search code, instructions, documentation, and configuration for reusable concepts. Downloads pinned runtime/model assets on first use and writes only private caches. Similarity ranks candidates and does not establish conceptual equivalence.",
    inputSchema: { type: "object", required: ["projectRoot", "query"], additionalProperties: false, properties: {
      projectRoot: { type: "string" },
      query: { type: "string", minLength: 1, maxLength: 4096 },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      filters: { type: "object", additionalProperties: false, properties: {
        domains: { type: "array", maxItems: 50, items: { type: "string", enum: [...domains] } },
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes, such as server or server/mcp.mjs. Use forward slashes without trailing slashes, empty segments, dot segments, or colons.", items: { type: "string", minLength: 1, maxLength: 512 } },
        kinds: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];
function validateConceptSearch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw semanticError("validation_failed", "Search arguments must be an object.");
  const input = value;
  for (const key of Object.keys(input)) if (!["projectRoot", "query", "filters", "expectedSnapshot", "snapshotId", "limit"].includes(key)) throw semanticError("validation_failed", `Unknown search field: ${key}.`);
  if (input.snapshotId !== void 0 && (typeof input.snapshotId !== "string" || !/^[a-f\d]{64}$/.test(input.snapshotId))) throw semanticError("validation_failed", "snapshotId must be a retained SHA-256 identity.");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4096) throw semanticError("validation_failed", "query must contain 1 through 4096 characters.");
  if (input.limit !== void 0 && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw semanticError("validation_failed", "limit must be from 1 through 50.");
  if (input.expectedSnapshot !== void 0 && (typeof input.expectedSnapshot !== "string" || !/^[a-f\d]{64}$/.test(input.expectedSnapshot))) throw semanticError("validation_failed", "expectedSnapshot must be a SHA-256 snapshot identity.");
  if (input.filters !== void 0) {
    if (!input.filters || typeof input.filters !== "object" || Array.isArray(input.filters)) throw semanticError("validation_failed", "filters must be an object.");
    for (const [key, values] of Object.entries(input.filters)) {
      if (!["domains", "paths", "kinds"].includes(key) || !Array.isArray(values) || values.length > 50 || values.some((value2) => typeof value2 !== "string" || !value2 || value2.length > 512)) throw semanticError("validation_failed", `Invalid filters.${key}.`);
      if (key === "domains" && values.some((value2) => !domains.has(value2))) throw semanticError("validation_failed", "filters.domains contains an unsupported domain.");
      if (key === "paths" && values.some((value2) => value2.startsWith("/") || value2.includes("\\") || value2.includes(":") || value2.split("/").some((part) => ["", ".", ".."].includes(part)))) throw semanticError("invalid_path", "filters.paths must use project-relative paths such as 'server', without trailing slashes, empty segments, '.', '..', backslashes, or colons.");
    }
  }
}
class SemanticNativeRepositoryIntelligence {
  constructor(source, preparation, runtime = nativeSemanticRuntime) {
    this.source = source;
    this.preparation = preparation;
    this.runtime = runtime;
    this.prepared = preparation.prepared;
  }
  prepared;
  snapshot() {
    return this.source.snapshot();
  }
  read(range) {
    return this.source.read(range);
  }
  validateSourceRange(range) {
    return this.source.validateSourceRange(range);
  }
  async verifySnapshot() {
    try {
      return await this.source.verifySnapshot();
    } catch (error) {
      if (error.code === "snapshot-changed") throw semanticError("stale_snapshot", "The repository changed during semantic analysis. Repeat the request.");
      throw error;
    }
  }
  async describe() {
    const description = await this.source.describe();
    return {
      ...description,
      preparation: { ...this.preparation, prepared: void 0 },
      capabilities: { ...description.capabilities, semanticSearch: Boolean(this.prepared), hybridSearch: Boolean(this.prepared), symbolGraph: Boolean(this.prepared), documentGraph: Boolean(this.prepared) }
    };
  }
  async semanticSearch(query, filters, limit) {
    if (!this.prepared) return null;
    try {
      return await this.runtime.search(this.prepared, this.source, query, filters, limit);
    } catch (error) {
      if (["stale_snapshot", "snapshot-changed"].includes(error.code)) throw semanticError("stale_snapshot", "The repository changed during semantic analysis. Repeat the request.");
      if (!["preparation_failed", "unsupported_runtime", "corrupt_asset"].includes(error.code)) throw error;
      this.prepared = void 0;
      this.preparation = {
        ...this.preparation,
        status: "degraded",
        prepared: void 0,
        diagnostics: [...this.preparation.diagnostics, { code: error.code, message: error.message, recovery: "Repeat the request to restart local semantic analysis." }]
      };
      return null;
    }
  }
  async search(task, hints = {}, options = {}) {
    const lexical = await this.source.search(task, hints, options);
    const results = await this.semanticSearch(task, void 0, Math.min(options.topK || 12, 50));
    if (!this.prepared || results === null) return { ...lexical, diagnostics: [...lexical.diagnostics, ...this.preparation.diagnostics] };
    const index = this.prepared.index, topK = options.topK || 12;
    const exactNodes = index.units.filter((node) => hints.symbols?.some((symbol) => exact(node, symbol))).map((node) => ({ node, score: 1, reasons: ["exact-symbol"] }));
    const exactHits = [...lexical.hits.filter(pinned), ...exactNodes];
    const hits = [...exactHits, ...results.map((node) => ({ node, score: node.fusedScore || 0, reasons: ["semantic-candidate"], retrievalScores: { cosineSimilarity: node.cosineSimilarity, lexicalScore: node.lexicalScore, fusedRank: node.fusedRank } }))];
    const byId = /* @__PURE__ */ new Map();
    for (const hit of hits) if (!byId.has(hit.node.id)) byId.set(hit.node.id, hit);
    const unique = [...byId.values()];
    const unresolvedRequired = lexical.unresolvedRequired.filter((item) => item.kind !== "symbol" || !exactNodes.some((hit) => exact(hit.node, item.value)));
    const requiredEvidenceComplete = lexical.requiredEvidenceComplete && exactHits.length <= topK;
    return {
      ...lexical,
      hits: unique.slice(0, topK),
      unresolvedRequired,
      requiredEvidenceComplete,
      estimateEligible: requiredEvidenceComplete && index.structureComplete,
      diagnostics: [...lexical.diagnostics.filter((item) => !["semantic_unavailable", "structural_unavailable"].includes(item.code)), ...index.diagnostics],
      retrievalPlan: { fusion: "reciprocal-rank-fusion", offset: 60, weights: [1, 1], modelIdentity: this.prepared.modelIdentity, indexRevision: this.prepared.revision, snapshot: index.snapshot, semanticCandidatesResolveHints: false }
    };
  }
  async neighbors(nodes, options = {}) {
    if (!this.prepared) return this.source.neighbors();
    const { index } = this.prepared, byId = new Map(index.units.map((node) => [node.id, node]));
    const seeds = new Set(nodes.flatMap((node) => byId.has(node.id) ? [node.id] : index.units.filter((item) => item.file === node.file && item.range.startLine <= node.range.endLine && item.range.endLine >= node.range.startLine).map((item) => item.id)));
    const expanded = [];
    for (const edge of index.edges) {
      if (!seeds.has(edge.source) && !seeds.has(edge.target)) continue;
      const from = seeds.has(edge.source) ? edge.source : edge.target, target = from === edge.source ? edge.target : edge.source;
      if (seeds.has(target) || !byId.has(target)) continue;
      expanded.push({ node: byId.get(target), from, relationship: edge.kind, score: 1, provenance: edge.provenance });
    }
    const all = [...new Map(expanded.map((item) => [`${item.from}:${item.relationship}:${item.node.id}`, item])).values()];
    const max = options.maxNodes || 24, covered = [...nodes, ...all.map((item) => item.node)].every((node) => index.fileCoverage[node.file]);
    const complete = index.structureComplete && covered && all.length <= max;
    return {
      neighbors: all.slice(0, max),
      graphCoverage: complete ? 1 : 0,
      estimateEligible: complete,
      diagnostics: complete ? [] : [{ code: "incomplete_structure", message: "Relevant structure is incomplete or exceeds the graph expansion limit." }]
    };
  }
}
async function prepareNativeProvider(projectRoot, options = {}) {
  const source = options.nativeSource || await openNativeRepositoryIntelligence(projectRoot, options.source);
  const runtime = options.runtime || nativeSemanticRuntime;
  const preparation = await runtime.prepare(source, options.expectedSnapshot, options.waitMs);
  return { provider: new SemanticNativeRepositoryIntelligence(source, preparation, runtime), preparation };
}
async function searchRepositoryConcepts(input, options = {}) {
  validateConceptSearch(input);
  const nativeSource = input.snapshotId ? await conservationStore.source(input.projectRoot, input.snapshotId) : options.nativeSource;
  const { provider, preparation } = await prepareNativeProvider(input.projectRoot, { ...options, nativeSource, expectedSnapshot: input.expectedSnapshot });
  if (preparation.status === "preparing") return { ...preparation, prepared: void 0, results: [] };
  let results = await provider.semanticSearch(input.query, input.filters, input.limit || 10);
  if (results === null) {
    const { hits } = await provider.source.search(input.query, {}, { topK: input.limit || 10, filters: input.filters });
    results = [];
    for (const { node, score } of hits) {
      const domain = domainFor(node.file);
      const source = await provider.source.read({ file: node.file, range: node.range });
      results.push({ ...node, domain, selector: node.name, sourceHash: (await provider.snapshot()).filesByPath.get(node.file).hash, excerpt: source.content.slice(0, 600), lexicalScore: score, cosineSimilarity: null, fusedRank: results.length + 1 });
      if (results.length >= (input.limit || 10)) break;
    }
  }
  await provider.verifySnapshot();
  if (input.snapshotId && provider.prepared) await retainAnalysis(input.projectRoot, input.snapshotId, provider.prepared);
  const capabilities = (await provider.describe()).capabilities;
  const receipt = {
    kind: "search",
    schemaVersion: 1,
    project: (await conservationStore.location(input.projectRoot)).root,
    snapshotId: input.snapshotId || null,
    snapshot: preparation.snapshot,
    query: input.query,
    filters: input.filters || null,
    limit: input.limit || 10,
    status: provider.preparation.status,
    capabilities,
    modelIdentity: provider.prepared?.modelIdentity || null,
    indexRevision: provider.prepared?.revision || null,
    versions: { graph: "1.6.0", extractor: provider.prepared?.index.chunkerVersion || "unavailable", tokenizer: provider.prepared?.modelIdentity || "unavailable", runtime: provider.prepared?.assetIdentity || "unavailable" },
    coverage: provider.prepared ? { files: provider.prepared.index.fileCoverage, counts: provider.prepared.index.counts } : null,
    diagnostics: provider.preparation.diagnostics,
    candidates: results
  };
  const receiptId = await conservationStore.put(input.projectRoot, receipt);
  return {
    status: provider.preparation.status,
    preparationId: preparation.preparationId,
    snapshot: preparation.snapshot,
    snapshotId: input.snapshotId || null,
    receiptId,
    indexRevision: provider.prepared?.revision || null,
    modelIdentity: provider.prepared?.modelIdentity || null,
    capabilities,
    diagnostics: provider.preparation.diagnostics.slice(0, 20),
    diagnosticCount: provider.preparation.diagnostics.length,
    results
  };
}
export {
  NATIVE_INTELLIGENCE_TOOLS,
  SemanticNativeRepositoryIntelligence,
  prepareNativeProvider,
  searchRepositoryConcepts,
  validateConceptSearch
};
