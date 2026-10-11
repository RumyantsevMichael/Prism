// Generated from src/server/repository-intelligence/semantic-native-provider.mts by scripts/native-build/compile.mjs.
import { openNativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";
import { nativeSemanticRuntime, semanticError } from "./native-semantic-runtime.mjs";
import { domainFor, searchExclusion } from "../../native-runtime/domains.mjs";
import { isTestUnit, sharedDependencyGroups } from "./shared-dependencies.mjs";
import { moduleInterfaceReport } from "./module-interfaces.mjs";
import { cohesionReport } from "./cohesion.mjs";
import { sharedLiteralGroups } from "./shared-literals.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { retainAnalysis } from "../conservation/conservation-analysis.mjs";
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
  },
  {
    name: "find_shared_dependencies",
    description: "Group functions and methods in different files that call the same rare set of operations, such as a repeated safety check, write protocol, or copied helper. Uses the same prepared index as search_repository_concepts. A shared dependency set identifies candidates for investigation and does not establish equivalent behavior.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test files, which often repeat setup code on purpose." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes. A group is reported when at least two of its members are inside these paths.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "report_module_interfaces",
    description: "Report JavaScript and TypeScript module exports with the modules that import each one, exports that no other module imports, exports that only tests import, and classes that forward most public methods to one field. Uses the same prepared index as search_repository_concepts. The report gives facts for interface design review and does not decide whether an interface is too shallow.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, default: 0 },
      allModules: { type: "boolean", default: false, description: "Report every exporting module, not only modules with unused or test-only exports." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes of the modules and classes to report. Importers anywhere in the project still count.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "find_shared_literals",
    description: "Group functions, methods, classes, and constants in different files that spell the same rare set of identifier-like string literals, such as ids, states, keys, event names, or method names. Uses the same prepared index as search_repository_concepts. A shared literal set shows values that several units must know and does not establish that one owner is better.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test files, which often repeat expected values on purpose." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes. A group is reported when at least two of its members are inside these paths.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "report_cohesion_clusters",
    description: "Report large classes, Rust and Go types, and modules whose members fall into separate clusters of shared state and calls, with the members and state of each cluster. Uses the same prepared index as search_repository_concepts. Clusters identify candidate responsibilities for investigation and do not decide whether a split is better.",
    inputSchema: { type: "object", required: ["projectRoot"], additionalProperties: false, properties: {
      projectRoot: { type: "string" },
      expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
      snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      includeTests: { type: "boolean", default: false, description: "Include test classes and modules." },
      filters: { type: "object", additionalProperties: false, properties: {
        paths: { type: "array", maxItems: 50, description: "Project-relative files or directory prefixes of the classes, types, and modules to report.", items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];
const unsafePath = (value) => value.startsWith("/") || value.includes("\\") || value.includes(":") || value.split("/").some((part) => ["", ".", ".."].includes(part));
const pathError = () => semanticError("invalid_path", "filters.paths must use project-relative paths such as 'server', without trailing slashes, empty segments, '.', '..', backslashes, or colons.");
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
      if (key === "paths" && values.some(unsafePath)) throw pathError();
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
      retrievalPlan: { fusion: "reciprocal-rank-fusion", offset: 60, weights: { dense: 1, lexical: 0.25, identifierLexical: 0.5 }, modelIdentity: this.prepared.modelIdentity, indexRevision: this.prepared.revision, snapshot: index.snapshot, semanticCandidatesResolveHints: false }
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
function validateAnalysis(value, booleans, extra = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw semanticError("validation_failed", "Arguments must be an object.");
  const input = value;
  for (const key of Object.keys(input)) if (!["projectRoot", "filters", "expectedSnapshot", "snapshotId", "limit", ...booleans, ...extra].includes(key)) throw semanticError("validation_failed", `Unknown field: ${key}.`);
  for (const key of ["snapshotId", "expectedSnapshot"]) if (input[key] !== void 0 && (typeof input[key] !== "string" || !/^[a-f\d]{64}$/.test(input[key]))) throw semanticError("validation_failed", `${key} must be a SHA-256 identity.`);
  if (input.limit !== void 0 && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw semanticError("validation_failed", "limit must be from 1 through 100.");
  if (input.offset !== void 0 && (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 0)) throw semanticError("validation_failed", "offset must be a nonnegative integer.");
  for (const key of booleans) if (input[key] !== void 0 && typeof input[key] !== "boolean") throw semanticError("validation_failed", `${key} must be a boolean.`);
  if (input.filters !== void 0) {
    const filters = input.filters;
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => key !== "paths")) throw semanticError("validation_failed", "filters accepts only paths.");
    const paths = filters.paths;
    if (paths !== void 0 && (!Array.isArray(paths) || paths.length > 50 || paths.some((value2) => typeof value2 !== "string" || !value2 || value2.length > 512))) throw semanticError("validation_failed", "Invalid filters.paths.");
    if (Array.isArray(paths) && paths.some(unsafePath)) throw pathError();
  }
}
function validateSharedDependencies(value) {
  validateAnalysis(value, ["includeTests"]);
}
function validateModuleInterfaces(value) {
  validateAnalysis(value, ["allModules"], ["offset"]);
}
function validateSharedLiterals(value) {
  validateAnalysis(value, ["includeTests"]);
}
function validateCohesion(value) {
  validateAnalysis(value, ["includeTests"]);
}
async function preparedAnalysis(input, options) {
  const nativeSource = input.snapshotId ? await conservationStore.source(input.projectRoot, input.snapshotId) : options.nativeSource;
  const { provider, preparation } = await prepareNativeProvider(input.projectRoot, { ...options, nativeSource, expectedSnapshot: input.expectedSnapshot });
  const identity = { status: provider.preparation.status, preparationId: preparation.preparationId, snapshot: preparation.snapshot, snapshotId: input.snapshotId || null };
  return { provider, preparation, identity };
}
async function findSharedDependencies(input, options = {}) {
  validateSharedDependencies(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: void 0, groups: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, groups: [] };
  const { index } = provider.prepared, contents = new Map((await provider.snapshot()).files.map((file) => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = sharedDependencyGroups(index, { include, limit: 100 });
  const groups = result.groups.filter((group) => group.members.filter((member) => inside(member.file)).length >= 2);
  await provider.verifySnapshot();
  const diagnostics = [
    ...index.structureComplete ? [] : [{ code: "incomplete_structure", message: "Some code structure is incomplete, so a group can miss members." }],
    ...result.coverage.unresolvedNames ? [] : [{ code: "dependency_names_unavailable", message: "The index has no library call names, so groups use project calls only.", recovery: "Prepare the index again with the current native runtime." }],
    ...provider.preparation.diagnostics
  ];
  const receiptId = await retainResult(input, provider, "find_shared_dependencies", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, result.coverage, diagnostics, { groups });
  return {
    ...identity,
    receiptId,
    indexRevision: provider.prepared.revision,
    coverage: result.coverage,
    diagnostics: diagnostics.slice(0, 20),
    diagnosticCount: diagnostics.length,
    totalGroups: groups.length,
    groups: groups.slice(0, input.limit || 20)
  };
}
async function reportModuleInterfaces(input, options = {}) {
  validateModuleInterfaces(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: void 0, modules: [], delegatingClasses: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, modules: [], delegatingClasses: [] };
  const contents = new Map((await provider.snapshot()).files.map((file) => [file.file, file.content]));
  const { inside } = analysisScope(input, contents);
  const report = moduleInterfaceReport(provider.prepared.index, contents, { include: inside, allModules: input.allModules });
  await provider.verifySnapshot();
  const offset = input.offset || 0, limit = input.limit || 20;
  const diagnostics = [
    ...report.coverage.unresolvedLocalImports ? [{ code: "unresolved_imports", count: report.coverage.unresolvedLocalImports, message: "Some local imports did not resolve, so an export can look unused although a module imports it." }] : [],
    ...report.coverage.importAnalysisSkipped.length ? [{ code: "unsupported_language", message: `Import analysis covers JavaScript and TypeScript, not ${report.coverage.importAnalysisSkipped.join(", ")} files.` }] : [],
    ...provider.preparation.diagnostics
  ];
  const receiptId = await retainResult(
    input,
    provider,
    "report_module_interfaces",
    { paths: input.filters?.paths || [], allModules: Boolean(input.allModules) },
    report.coverage,
    diagnostics,
    { modules: report.modules, delegatingClasses: report.delegatingClasses }
  );
  return {
    ...identity,
    receiptId,
    indexRevision: provider.prepared.revision,
    coverage: report.coverage,
    diagnostics: diagnostics.slice(0, 20),
    diagnosticCount: diagnostics.length,
    totalModules: report.modules.length,
    nextOffset: offset + limit < report.modules.length ? offset + limit : null,
    modules: report.modules.slice(offset, offset + limit),
    delegatingClasses: report.delegatingClasses.slice(0, 50)
  };
}
async function retainResult(input, provider, tool, scope, coverage, diagnostics, results) {
  const snapshot = await provider.snapshot(), prepared = provider.prepared, named = /* @__PURE__ */ new Set();
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) key === "file" && typeof item === "string" ? named.add(item) : collect(item);
  };
  collect(results);
  const files = [...named].sort().flatMap((file) => snapshot.filesByPath.has(file) ? [{ file, hash: snapshot.filesByPath.get(file).hash }] : []);
  const receipt = {
    kind: "repository-analysis",
    schemaVersion: 1,
    project: (await conservationStore.location(input.projectRoot)).root,
    tool,
    snapshotId: input.snapshotId || null,
    snapshot: provider.preparation.snapshot,
    indexRevision: prepared.revision,
    versions: { extractor: prepared.index.chunkerVersion || "unavailable", runtime: prepared.assetIdentity || "unavailable" },
    scope,
    coverage,
    diagnostics,
    files,
    ...results
  };
  return conservationStore.put(input.projectRoot, receipt);
}
function analysisScope(input, contents) {
  const include = (unit) => (input.includeTests || !isTestUnit(unit, contents.get(unit.file))) && !searchExclusion(unit.file, contents.get(unit.file) || "");
  const paths = input.filters?.paths || [];
  const inside = (file) => !paths.length || paths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
  return { include, inside };
}
async function findSharedLiterals(input, options = {}) {
  validateSharedLiterals(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: void 0, groups: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, groups: [] };
  const contents = new Map((await provider.snapshot()).files.map((file) => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const result = sharedLiteralGroups(provider.prepared.index, contents, { include, limit: 100 });
  const groups = result.groups.filter((group) => group.members.filter((member) => inside(member.file)).length >= 2);
  await provider.verifySnapshot();
  const diagnostics = provider.preparation.diagnostics;
  const receiptId = await retainResult(input, provider, "find_shared_literals", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, result.coverage, diagnostics, { groups });
  return {
    ...identity,
    receiptId,
    indexRevision: provider.prepared.revision,
    coverage: result.coverage,
    diagnostics: diagnostics.slice(0, 20),
    diagnosticCount: diagnostics.length,
    totalGroups: groups.length,
    groups: groups.slice(0, input.limit || 20)
  };
}
async function reportCohesionClusters(input, options = {}) {
  validateCohesion(input);
  const { provider, preparation, identity } = await preparedAnalysis(input, options);
  if (preparation.status === "preparing") return { ...preparation, prepared: void 0, containers: [] };
  if (!provider.prepared) return { ...identity, indexRevision: null, coverage: null, diagnostics: provider.preparation.diagnostics.slice(0, 20), diagnosticCount: provider.preparation.diagnostics.length, containers: [] };
  const contents = new Map((await provider.snapshot()).files.map((file) => [file.file, file.content]));
  const { include, inside } = analysisScope(input, contents);
  const report = cohesionReport(provider.prepared.index, contents, { include: (unit) => include(unit) && inside(unit.file) });
  await provider.verifySnapshot();
  const { index } = provider.prepared;
  const diagnostics = [...index.structureComplete ? [] : [{ code: "incomplete_structure", message: "Some code structure is incomplete, so a cluster can miss members or calls." }], ...provider.preparation.diagnostics];
  const receiptId = await retainResult(input, provider, "report_cohesion_clusters", { paths: input.filters?.paths || [], includeTests: Boolean(input.includeTests) }, report.coverage, diagnostics, { containers: report.containers });
  return {
    ...identity,
    receiptId,
    indexRevision: provider.prepared.revision,
    coverage: report.coverage,
    diagnostics: diagnostics.slice(0, 20),
    diagnosticCount: diagnostics.length,
    totalContainers: report.containers.length,
    containers: report.containers.slice(0, input.limit || 20)
  };
}
export {
  NATIVE_INTELLIGENCE_TOOLS,
  SemanticNativeRepositoryIntelligence,
  findSharedDependencies,
  findSharedLiterals,
  prepareNativeProvider,
  reportCohesionClusters,
  reportModuleInterfaces,
  searchRepositoryConcepts,
  validateCohesion,
  validateConceptSearch,
  validateModuleInterfaces,
  validateSharedDependencies,
  validateSharedLiterals
};
