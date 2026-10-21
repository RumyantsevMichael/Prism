import { openNativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";
import { nativeSemanticRuntime, semanticError } from "./native-semantic-runtime.mjs";
import { domainFor, searchExclusion } from "../../native-runtime/domains.mjs";
import { isTestUnit, sharedDependencyGroups } from "./shared-dependencies.mjs";
import { moduleInterfaceReport } from "./module-interfaces.mjs";
import { cohesionReport } from "./cohesion.mjs";
import { sharedLiteralGroups } from "./shared-literals.mjs";
import { sharedShapes } from "./shared-shapes.mjs";
import { sameNameGroups } from "./same-name-units.mjs";
import { complexUnits } from "./complex-units.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { retainAnalysis } from "../conservation/conservation-analysis.mjs";
import type { AnalysisReceipt, SearchReceipt } from "../conservation/conservation-types.mjs";
import type { SourceUnit, Domain, NativeSource, Neighbor, Preparation, PreparedIndex, RetrievalEvidence, SearchFilters, SearchHints, SearchHit, SearchResult, SemanticRuntime, SourceRange, StructuralEvidence } from "./repository-unit-types.mjs";

interface ConceptSearchInput { projectRoot: string; query: string; filters?: SearchFilters; expectedSnapshot?: string; snapshotId?: string; limit?: number }
interface SharedDependencyInput { projectRoot: string; filters?: { paths?: string[] }; includeTests?: boolean; expectedSnapshot?: string; snapshotId?: string; limit?: number }
interface ModuleInterfaceInput { projectRoot: string; filters?: { paths?: string[] }; allModules?: boolean; expectedSnapshot?: string; snapshotId?: string; limit?: number; offset?: number }
interface ScopedAnalysisInput { projectRoot: string; filters?: { paths?: string[] }; includeTests?: boolean; expectedSnapshot?: string; snapshotId?: string; limit?: number }
interface ProviderOptions { source?: Record<string, unknown>; nativeSource?: NativeSource; runtime?: SemanticRuntime; expectedSnapshot?: string; waitMs?: number }

const domains = new Set(["code", "instruction", "documentation", "configuration"]);
const exact = (node: SourceUnit, value: string) => [node.name, node.qualifiedName, node.selector].includes(value);
const pinned = (hit: SearchHit) => hit.reasons?.some(reason => ["explicit-design-reference", "expected-modification-target", "exact-symbol"].includes(reason));

export const NATIVE_INTELLIGENCE_TOOLS = [
  {
    name: "discover_repository_intelligence",
    description: "Read native runtime, model, index, and structural capability status without downloads or index preparation.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string" } }, required: ["projectRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_repository_intelligence_status",
    description: "Read native preparation progress, versions, coverage, and diagnostics. Optionally wait up to thirty seconds for an existing preparation.",
    inputSchema: { type: "object", properties: { projectRoot: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 30000, default: 0 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["projectRoot"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "search_repository_concepts",
    description: "Search code, instructions, documentation, and configuration for reusable concepts. Downloads pinned runtime/model assets on first use and writes only private caches. Similarity ranks candidates and does not establish conceptual equivalence.",
    inputSchema: { type: "object", required: ["projectRoot", "query"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, query: { type: "string", minLength: 1, maxLength: 4096 },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      filters: { type: "object", additionalProperties: false, properties: {
        domains: { type: "array", maxItems: 50, items: { type: "string", enum: [...domains] } },
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes, such as server or server/mcp.mjs. Use forward slashes without trailing slashes, empty segments, dot segments, or colons.", items: { type: "string", minLength: 1, maxLength: 512 } },
        kinds: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "find_shared_dependencies",
    description: "Group functions and methods in different files that call the same rare set of operations, such as a repeated safety check, write protocol, or copied helper. Uses the same prepared index as search_repository_concepts. A shared dependency set identifies candidates for investigation and does not establish equivalent behavior.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test files, which often repeat setup code on purpose." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes. A group is reported when at least two of its members are inside these paths.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "report_module_interfaces",
    description: "Report JavaScript and TypeScript module exports with the modules that import each one, exports that no other module imports, exports that only tests import, and classes that forward most public methods to one field. Uses the same prepared index as search_repository_concepts. The report gives facts for interface design review and does not decide whether an interface is too shallow.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, offset: { type: "integer", minimum: 0, default: 0 },
      allModules: { type: "boolean", default: false, description: "Report every exporting module, not only modules with unused or test-only exports." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes of the modules and classes to report. Importers anywhere in the project still count.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "find_shared_literals",
    description: "Group functions, methods, classes, constants, and instruction list items or paragraphs in different files that spell the same rare set of identifier-like literals, such as ids, states, keys, event names, method names, or tool names in backticks. Also report key sets that several objects, interfaces, or schemas repeat. Uses the same prepared index as search_repository_concepts. A shared literal set or shape shows names that several places must know and does not establish that one owner is better.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test files, which often repeat expected values on purpose." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes. A group is reported when at least two of its members are inside these paths.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "report_cohesion_clusters",
    description: "Report large classes, Rust and Go types, and modules whose members fall into separate clusters of shared state and calls, with the members and state of each cluster. Uses the same prepared index as search_repository_concepts. Clusters identify candidate responsibilities for investigation and do not decide whether a split is better.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test classes and modules." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes of the classes, types, and modules to report.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "find_same_name_units",
    description: "Group functions in different files that have the same name: identical copies, and diverged variants with the dependencies that only each variant uses and its throw count. Uses the same prepared index as search_repository_concepts. A diverged name shows candidates for one contract and does not establish that the variants should behave alike.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test code, which often repeats small helpers on purpose." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes. A group is reported when at least two of its functions are inside these paths.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "report_complex_units",
    description: "Report long or branchy functions and methods with their lines, branches, nesting depth, parameters, nested functions, and the expression that they compare with the most literal values. Uses the same prepared index as search_repository_concepts. The facts identify candidates for a split and do not decide that a unit is too complex.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" }, expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test code." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes of the units to report.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];

// Path filters are project-relative prefixes. Absolute paths, backslashes, colons, and empty or dot segments could leave the project or match nothing.
const unsafePath = (value: string) => value.startsWith("/") || value.includes("\\") || value.includes(":") || value.split("/").some(part => ["", ".", ".."].includes(part));
const pathError = () => semanticError("invalid_path", "filters.paths must use project-relative paths such as 'server', without trailing slashes, empty segments, '.', '..', backslashes, or colons.");

export function validateConceptSearch(value: unknown): asserts value is ConceptSearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw semanticError("validation_failed", "Search arguments must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["projectRoot", "query", "filters", "expectedSnapshot", "snapshotId", "limit"].includes(key)) throw semanticError("validation_failed", `Unknown search field: ${key}.`);
  if (input.snapshotId !== undefined && (typeof input.snapshotId !== "string" || !/^[a-f\d]{64}$/.test(input.snapshotId))) throw semanticError("validation_failed", "snapshotId must be a retained SHA-256 identity.");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4096) throw semanticError("validation_failed", "query must contain 1 through 4096 characters.");
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw semanticError("validation_failed", "limit must be from 1 through 50.");
  if (input.expectedSnapshot !== undefined && (typeof input.expectedSnapshot !== "string" || !/^[a-f\d]{64}$/.test(input.expectedSnapshot))) throw semanticError("validation_failed", "expectedSnapshot must be a SHA-256 snapshot identity.");
  if (input.filters !== undefined) {
    if (!input.filters || typeof input.filters !== "object" || Array.isArray(input.filters)) throw semanticError("validation_failed", "filters must be an object.");
    for (const [key, values] of Object.entries(input.filters)) {
      if (!["domains", "paths", "kinds"].includes(key) || !Array.isArray(values) || values.length > 50 || values.some(value => typeof value !== "string" || !value || value.length > 512)) throw semanticError("validation_failed", `Invalid filters.${key}.`);
      if (key === "domains" && values.some(value => !domains.has(value))) throw semanticError("validation_failed", "filters.domains contains an unsupported domain.");
      if (key === "paths" && values.some(unsafePath)) throw pathError();
    }
  }
}

export class SemanticNativeRepositoryIntelligence {
  prepared?: PreparedIndex;
  constructor(public source: NativeSource, public preparation: Preparation, public runtime: SemanticRuntime = nativeSemanticRuntime) { this.prepared = preparation.prepared; }
  snapshot() { return this.source.snapshot(); }
  read(range: { file: string; range: SourceRange }) { return this.source.read(range); }
  validateSourceRange(range: { file: string; range: SourceRange }) { return this.source.validateSourceRange(range); }
  async verifySnapshot() {
    try { return await this.source.verifySnapshot(); }
    catch (error) { if (error.code === "snapshot-changed") throw semanticError("stale_snapshot", "The repository changed during semantic analysis. Repeat the request."); throw error; }
  }
  async describe() {
    const description = await this.source.describe();
    return { ...description, preparation: { ...this.preparation, prepared: undefined },
      capabilities: { ...description.capabilities, semanticSearch: Boolean(this.prepared), hybridSearch: Boolean(this.prepared), symbolGraph: Boolean(this.prepared), documentGraph: Boolean(this.prepared) } };
  }
  async semanticSearch(query: string, filters: SearchFilters | undefined, limit: number): Promise<SearchResult[] | null> {
    if (!this.prepared) return null;
    try { return await this.runtime.search(this.prepared, this.source, query, filters, limit); }
    catch (error) {
      if (["stale_snapshot", "snapshot-changed"].includes(error.code)) throw semanticError("stale_snapshot", "The repository changed during semantic analysis. Repeat the request.");
      if (!["preparation_failed", "unsupported_runtime", "corrupt_asset"].includes(error.code)) throw error;
      this.prepared = undefined;
      this.preparation = { ...this.preparation, status: "degraded", prepared: undefined,
        diagnostics: [...this.preparation.diagnostics, { code: error.code, message: error.message, recovery: "Repeat the request to restart local semantic analysis." }] };
      return null;
    }
  }
  async search(task: string, hints: SearchHints = {}, options: { topK?: number; budget?: string } = {}): Promise<RetrievalEvidence> {
    const lexical = await this.source.search(task, hints, options);
    const results = await this.semanticSearch(task, undefined, Math.min(options.topK || 12, 50));
    if (!this.prepared || results === null) return { ...lexical, diagnostics: [...lexical.diagnostics, ...this.preparation.diagnostics] };
    const index = this.prepared.index, topK = options.topK || 12;
    const exactNodes = index.units.filter(node => hints.symbols?.some(symbol => exact(node, symbol))).map(node => ({ node, score: 1, reasons: ["exact-symbol"] }));
    const exactHits = [...lexical.hits.filter(pinned), ...exactNodes];
    const hits: SearchHit[] = [...exactHits, ...results.map(node => ({ node, score: node.fusedScore || 0, reasons: ["semantic-candidate"], retrievalScores: { cosineSimilarity: node.cosineSimilarity, lexicalScore: node.lexicalScore, fusedRank: node.fusedRank } }))];
    const byId = new Map();
    for (const hit of hits) if (!byId.has(hit.node.id)) byId.set(hit.node.id, hit);
    const unique = [...byId.values()];
    const unresolvedRequired = lexical.unresolvedRequired.filter(item => item.kind !== "symbol" || !exactNodes.some(hit => exact(hit.node, item.value)));
    const requiredEvidenceComplete = lexical.requiredEvidenceComplete && exactHits.length <= topK;
    return { ...lexical, hits: unique.slice(0, topK), unresolvedRequired, requiredEvidenceComplete,
      estimateEligible: requiredEvidenceComplete && index.structureComplete,
      diagnostics: [...lexical.diagnostics.filter(item => !["semantic_unavailable", "structural_unavailable"].includes(item.code)), ...index.diagnostics],
      retrievalPlan: { fusion: "reciprocal-rank-fusion", offset: 60, weights: { dense: 1, lexical: 0.25, identifierLexical: 0.5 }, modelIdentity: this.prepared.modelIdentity, indexRevision: this.prepared.revision, snapshot: index.snapshot, semanticCandidatesResolveHints: false } };
  }
  async neighbors(nodes: SourceUnit[], options: { maxNodes?: number } = {}): Promise<StructuralEvidence> {
    if (!this.prepared) return this.source.neighbors();
    const { index } = this.prepared, byId = new Map(index.units.map(node => [node.id, node]));
    const seeds = new Set(nodes.flatMap(node => byId.has(node.id) ? [node.id] : index.units.filter(item => item.file === node.file && item.range.startLine <= node.range.endLine && item.range.endLine >= node.range.startLine).map(item => item.id)));
    const expanded: Neighbor[] = [];
    for (const edge of index.edges) {
      if (!seeds.has(edge.source) && !seeds.has(edge.target)) continue;
      const from = seeds.has(edge.source) ? edge.source : edge.target, target = from === edge.source ? edge.target : edge.source;
      if (seeds.has(target) || !byId.has(target)) continue;
      expanded.push({ node: byId.get(target)!, from, relationship: edge.kind, score: 1, provenance: edge.provenance });
    }
    const all = [...new Map(expanded.map(item => [`${item.from}:${item.relationship}:${item.node.id}`, item])).values()];
    const max = options.maxNodes || 24, covered = [...nodes, ...all.map(item => item.node)].every(node => index.fileCoverage[node.file]);
    const complete = index.structureComplete && covered && all.length <= max;
    return { neighbors: all.slice(0, max), graphCoverage: complete ? 1 : 0, estimateEligible: complete,
      diagnostics: complete ? [] : [{ code: "incomplete_structure", message: "Relevant structure is incomplete or exceeds the graph expansion limit." }] };
  }
}

export async function prepareNativeProvider(projectRoot: string, options: ProviderOptions = {}) {
  const source = options.nativeSource || await openNativeRepositoryIntelligence(projectRoot, options.source) as unknown as NativeSource;
  const runtime = options.runtime || nativeSemanticRuntime;
  const preparation = await runtime.prepare(source, options.expectedSnapshot, options.waitMs);
  return { provider: new SemanticNativeRepositoryIntelligence(source, preparation, runtime), preparation };
}

export async function searchRepositoryConcepts(input: ConceptSearchInput, options: ProviderOptions = {}) {
  validateConceptSearch(input);
  const nativeSource = input.snapshotId ? await conservationStore.source(input.projectRoot, input.snapshotId) : options.nativeSource;
  const { provider, preparation } = await prepareNativeProvider(input.projectRoot, { ...options, nativeSource, expectedSnapshot: input.expectedSnapshot });
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, results: [] };
  let results = await provider.semanticSearch(input.query, input.filters, input.limit || 10);
  if (results === null) {
    const { hits } = await provider.source.search(input.query, {}, { topK: input.limit || 10, filters: input.filters });
    results = [];
    for (const { node, score } of hits) {
      const domain = domainFor(node.file);
      const source = await provider.source.read({ file: node.file, range: node.range });
      results.push({ ...node, domain, selector: node.name, sourceHash: (await provider.snapshot()).filesByPath.get(node.file)!.hash, excerpt: source.content.slice(0, 600), lexicalScore: score, cosineSimilarity: null, fusedRank: results.length + 1 });
      if (results.length >= (input.limit || 10)) break;
    }
  }
  await provider.verifySnapshot();
  if (input.snapshotId && provider.prepared) await retainAnalysis(input.projectRoot, input.snapshotId, provider.prepared);
  const capabilities = (await provider.describe()).capabilities;
  const receipt: SearchReceipt = { kind: "search", schemaVersion: 1, project: (await conservationStore.location(input.projectRoot)).root,
    snapshotId: input.snapshotId || null, snapshot: preparation.snapshot, query: input.query, filters: input.filters || null, limit: input.limit || 10,
    status: provider.preparation.status, capabilities, modelIdentity: provider.prepared?.modelIdentity || null, indexRevision: provider.prepared?.revision || null,
    versions: { graph: "1.6.0", extractor: provider.prepared?.index.chunkerVersion || "unavailable", tokenizer: provider.prepared?.modelIdentity || "unavailable", runtime: provider.prepared?.assetIdentity || "unavailable" },
    coverage: provider.prepared ? { files: provider.prepared.index.fileCoverage, counts: provider.prepared.index.counts } : null,
    diagnostics: provider.preparation.diagnostics, candidates: results };
  const receiptId = await conservationStore.put(input.projectRoot, receipt);
  return { status: provider.preparation.status, preparationId: preparation.preparationId, snapshot: preparation.snapshot,
    snapshotId: input.snapshotId || null, receiptId,
    indexRevision: provider.prepared?.revision || null, modelIdentity: provider.prepared?.modelIdentity || null,
    capabilities, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, results };
}

// Both repository analyses take a snapshot, an optional path filter, a result limit, and their own boolean switches.
function validateAnalysis(value: unknown, booleans: string[], extra: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw semanticError("validation_failed", "Arguments must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["projectRoot", "filters", "expectedSnapshot", "snapshotId", "limit", ...booleans, ...extra].includes(key)) throw semanticError("validation_failed", `Unknown field: ${key}.`);
  for (const key of ["snapshotId", "expectedSnapshot"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !/^[a-f\d]{64}$/.test(input[key] as string))) throw semanticError("validation_failed", `${key} must be a SHA-256 identity.`);
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw semanticError("validation_failed", "limit must be from 1 through 100.");
  if (input.offset !== undefined && (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 0)) throw semanticError("validation_failed", "offset must be a nonnegative integer.");
  for (const key of booleans) if (input[key] !== undefined && typeof input[key] !== "boolean") throw semanticError("validation_failed", `${key} must be a boolean.`);
  if (input.filters !== undefined) {
    const filters = input.filters as Record<string, unknown>;
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some(key => key !== "paths")) throw semanticError("validation_failed", "filters accepts only paths.");
    const paths = filters.paths;
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > 50 || paths.some(value => typeof value !== "string" || !value || value.length > 512))) throw semanticError("validation_failed", "Invalid filters.paths.");
    if (Array.isArray(paths) && paths.some(unsafePath)) throw pathError();
  }
}

export function validateSharedDependencies(value: unknown): asserts value is SharedDependencyInput { validateAnalysis(value, ["includeTests"]); }
export function validateModuleInterfaces(value: unknown): asserts value is ModuleInterfaceInput { validateAnalysis(value, ["allModules"], ["offset"]); }
export function validateSharedLiterals(value: unknown): asserts value is SharedDependencyInput { validateAnalysis(value, ["includeTests"]); }
export function validateCohesion(value: unknown): asserts value is ScopedAnalysisInput { validateAnalysis(value, ["includeTests"]); }
export function validateSameNameUnits(value: unknown): asserts value is ScopedAnalysisInput { validateAnalysis(value, ["includeTests"]); }
export function validateComplexUnits(value: unknown): asserts value is ScopedAnalysisInput { validateAnalysis(value, ["includeTests"]); }

// Prepare the snapshot that an analysis reads: the retained baseline when the caller names one, or the live project.
async function preparedAnalysis(input: { projectRoot: string; snapshotId?: string; expectedSnapshot?: string }, options: ProviderOptions) {
  const nativeSource = input.snapshotId ? await conservationStore.source(input.projectRoot, input.snapshotId) : options.nativeSource;
  const { provider, preparation } = await prepareNativeProvider(input.projectRoot, { ...options, nativeSource, expectedSnapshot: input.expectedSnapshot });
  const identity = { status: provider.preparation.status, preparationId: preparation.preparationId, snapshot: preparation.snapshot, snapshotId: input.snapshotId || null };
  return { provider, preparation, identity };
}

export async function findSharedDependencies(input: SharedDependencyInput, options: ProviderOptions = {}) {
  validateSharedDependencies(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, groups: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, groups: [] };
  const { index } = provider.prepared, contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = sharedDependencyGroups(index, { include, limit: 100 });
  const groups = result.groups.filter(group => group.members.filter(member => inside(member.file)).length >= 2);
  await provider.verifySnapshot();
  const diagnostics = [...(index.structureComplete ? [] : [{ code: "incomplete_structure", message: "Some code structure is incomplete, so a group can miss members." }]),
    ...(result.coverage.unresolvedNames ? [] : [{ code: "dependency_names_unavailable", message: "The index has no library call names, so groups use project calls only.", recovery: "Prepare the index again with the current native runtime." }]),
    ...provider.preparation.diagnostics];
  const receiptId = await retainResult(input, provider, "find_shared_dependencies", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, result.coverage, diagnostics, { groups });
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage: result.coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length, totalGroups: groups.length, groups: groups.slice(0, input.limit || 20) };
}

export async function reportModuleInterfaces(input: ModuleInterfaceInput, options: ProviderOptions = {}) {
  validateModuleInterfaces(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, modules: [], delegatingClasses: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, modules: [], delegatingClasses: [] };
  const contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { inside } = analysisScope(input, contents);
  const report = moduleInterfaceReport(provider.prepared.index, contents, { include: inside, allModules: input.allModules });
  await provider.verifySnapshot();
  const offset = input.offset || 0, limit = input.limit || 20;
  const diagnostics = [...(report.coverage.unresolvedLocalImports ? [{ code: "unresolved_imports", count: report.coverage.unresolvedLocalImports, message: "Some local imports did not resolve, so an export can look unused although a module imports it." }] : []),
    ...(report.coverage.importAnalysisSkipped.length ? [{ code: "unsupported_language", message: `Import analysis covers JavaScript and TypeScript, not ${report.coverage.importAnalysisSkipped.join(", ")} files.` }] : []),
    ...provider.preparation.diagnostics];
  const receiptId = await retainResult(input, provider, "report_module_interfaces", { paths: input.filters?.paths || [], allModules: Boolean(input.allModules) }, report.coverage, diagnostics,
    { modules: report.modules, delegatingClasses: report.delegatingClasses });
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage: report.coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length,
    totalModules: report.modules.length, nextOffset: offset + limit < report.modules.length ? offset + limit : null,
    modules: report.modules.slice(offset, offset + limit), delegatingClasses: report.delegatingClasses.slice(0, 50) };
}

// Retain the complete result of an analysis, before the response limit, so that a report or a review view can cite it by receiptId.
// The hash of each file that the result names lets a reader detect results that a later edit made stale.
async function retainResult(input: { projectRoot: string; snapshotId?: string }, provider: SemanticNativeRepositoryIntelligence, tool: AnalysisReceipt["tool"],
  scope: Record<string, unknown>, coverage: unknown, diagnostics: AnalysisReceipt["diagnostics"], results: Pick<AnalysisReceipt, "groups" | "modules" | "delegatingClasses" | "containers" | "units" | "shapes">) {
  const snapshot = await provider.snapshot(), prepared = provider.prepared!, named = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) key === "file" && typeof item === "string" ? named.add(item) : collect(item);
  };
  collect(results);
  const files = [...named].sort().flatMap(file => snapshot.filesByPath.has(file) ? [{ file, hash: snapshot.filesByPath.get(file)!.hash }] : []);
  const receipt: AnalysisReceipt = { kind: "repository-analysis", schemaVersion: 1, project: (await conservationStore.location(input.projectRoot)).root, tool,
    snapshotId: input.snapshotId || null, snapshot: provider.preparation.snapshot, indexRevision: prepared.revision,
    versions: { extractor: prepared.index.chunkerVersion || "unavailable", runtime: prepared.assetIdentity || "unavailable" },
    scope, coverage, diagnostics, files, ...results };
  return conservationStore.put(input.projectRoot, receipt);
}

// Production code by default: test code, and generated, vendored, or minified files repeat values and grow large by design.
function analysisScope(input: { includeTests?: boolean; filters?: { paths?: string[] } }, contents: Map<string, string>) {
  const include = (unit: SourceUnit) => (input.includeTests || !isTestUnit(unit, contents.get(unit.file))) && !searchExclusion(unit.file, contents.get(unit.file) || "");
  const paths = input.filters?.paths || [];
  const inside = (file: string) => !paths.length || paths.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
  return { include, inside };
}

export async function findSharedLiterals(input: SharedDependencyInput, options: ProviderOptions = {}) {
  validateSharedLiterals(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, groups: [], shapes: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, groups: [], shapes: [] };
  const contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = sharedLiteralGroups(provider.prepared.index, contents, { include, limit: 100 });
  const groups = result.groups.filter(group => [...group.members, ...group.clients].filter(member => inside(member.file)).length >= 2);
  const shaped = sharedShapes(provider.prepared.index, contents, { include, limit: 100 });
  const shapes = shaped.shapes.filter(shape => shape.locations.some(location => inside(location.file)));
  await provider.verifySnapshot();
  const diagnostics = provider.preparation.diagnostics, coverage = { ...result.coverage, objects: shaped.coverage.objects };
  const receiptId = await retainResult(input, provider, "find_shared_literals", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, coverage, diagnostics, { groups, shapes });
  // A host can move a long tool result out of the conversation, so the response keeps the strongest facts and the receipt keeps all of them.
  const brief = groups.slice(0, input.limit || 20).map(group => ({ ...group, literals: group.literals.slice(0, 10), literalCount: group.literals.length }));
  const briefShapes = shapes.slice(0, Math.min(input.limit || 20, 8)).map(shape => ({ ...shape, locations: shape.locations.slice(0, 4) }));
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length, totalGroups: groups.length, groups: brief, totalShapes: shapes.length, shapes: briefShapes };
}

export async function reportCohesionClusters(input: ScopedAnalysisInput, options: ProviderOptions = {}) {
  validateCohesion(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, containers: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, containers: [] };
  const contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const report = cohesionReport(provider.prepared.index, contents, { include: unit => include(unit) && inside(unit.file) });
  await provider.verifySnapshot();
  const { index } = provider.prepared;
  const diagnostics = [...(index.structureComplete ? [] : [{ code: "incomplete_structure", message: "Some code structure is incomplete, so a cluster can miss members or calls." }]), ...provider.preparation.diagnostics];
  const receiptId = await retainResult(input, provider, "report_cohesion_clusters", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, report.coverage, diagnostics, { containers: report.containers });
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage: report.coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length, totalContainers: report.containers.length, containers: report.containers.slice(0, input.limit || 20) };
}

export async function findSameNameUnits(input: ScopedAnalysisInput, options: ProviderOptions = {}) {
  validateSameNameUnits(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, groups: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, groups: [] };
  const contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = sameNameGroups(provider.prepared.index, contents, { include });
  const groups = result.groups.filter(group => group.variants.flatMap(variant => variant.members).filter(member => inside(member.file)).length >= 2);
  await provider.verifySnapshot();
  const diagnostics = [...(provider.prepared.index.unresolvedReferences ? [] : [{ code: "dependency_names_unavailable", message: "The index has no library call names, so variants compare project calls only.", recovery: "Prepare the index again with the current native runtime." }]), ...provider.preparation.diagnostics];
  const receiptId = await retainResult(input, provider, "find_same_name_units", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, result.coverage, diagnostics, { groups });
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage: result.coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length, totalGroups: groups.length, groups: groups.slice(0, input.limit || 20) };
}

export async function reportComplexUnits(input: ScopedAnalysisInput, options: ProviderOptions = {}) {
  validateComplexUnits(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: undefined, units: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, units: [] };
  const contents = new Map((await provider.snapshot()).files.map(file => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = complexUnits(provider.prepared.index, contents, { include: unit => include(unit) && inside(unit.file) });
  await provider.verifySnapshot();
  const diagnostics = provider.preparation.diagnostics;
  const receiptId = await retainResult(input, provider, "report_complex_units", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, result.coverage, diagnostics, { units: result.units });
  return { ...identity, receiptId, indexRevision: provider.prepared.revision, coverage: result.coverage,
    diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length, totalUnits: result.units.length, units: result.units.slice(0, input.limit || 20) };
}
