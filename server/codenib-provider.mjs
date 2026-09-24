import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { readCodeNibCommand } from "./repository-intelligence-config.mjs";
import { normalizeRepositorySourcePath, normalizeRepositorySourceRange } from "./repository-source-path.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_DEFINITION_RESULTS = 4;
const MAX_REGEX_RESULTS = 8;
export const CODENIB_SUPPORTED_VERSION = "0.2.3";

export const CODENIB_CAPABILITIES = Object.freeze({
  lexicalSearch: true,
  semanticSearch: true,
  hybridSearch: true,
  symbolGraph: true,
  verifiedSource: true
});

export class CodeNibRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodeNibRuntimeError";
    this.provider = "codenib";
    this.code = code;
    this.recoverable = options.recoverable !== false;
    if (options.version !== undefined) this.version = String(options.version);
  }
}

function supportedServerInfo(value) {
  if (!value || typeof value !== "object" || String(value.name || "").toLowerCase() !== "codenib") {
    throw new CodeNibRuntimeError("invalid-server-identity", "The MCP server did not identify itself as CodeNib.");
  }
  const version = String(value.version || "");
  if (version !== CODENIB_SUPPORTED_VERSION) {
    throw new CodeNibRuntimeError("incompatible-version", `CodeNib executable version ${version || "unknown"} is unsupported.`, { version });
  }
  return { name: "codenib", version };
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find?.((item) => item.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { content: text };
    }
  }
  return result ?? {};
}

function sourceNode(value, { compact = false, projectRoot } = {}) {
  if (typeof value?.file !== "string" || !value.file) {
    return null;
  }
  let file;
  try {
    file = normalizeRepositorySourcePath(value.file, { projectRoot });
  } catch (error) {
    throw new CodeNibRuntimeError("invalid-response", "CodeNib returned an unsafe source path.", { cause: error });
  }
  const validStartLine = (Number.isInteger(value.start_line) && value.start_line > 0) || (Number.isInteger(value.line) && value.line > 0);
  const startLine = Number.isInteger(value.start_line) && value.start_line > 0 ? value.start_line : Number.isInteger(value.line) && value.line > 0 ? value.line : 1;
  const validEndLine = Number.isInteger(value.end_line) && value.end_line >= startLine;
  const endLine = validEndLine ? value.end_line : startLine;
  const name = String(value.node_name || value.name || value.node_id || file);
  return {
    id: String(value.node_id || `${file}:${startLine}:${name}`),
    file,
    range: { startLine, endLine },
    kind: String(value.type || value.kind || "symbol"),
    name,
    rangeComplete: validStartLine && validEndLine,
    ...(value.qualified_name ? { qualifiedName: String(value.qualified_name) } : {}),
    ...(value.signature ? { signature: String(value.signature) } : {})
  };
}

function hintReasons(node, hints) {
  const files = Array.isArray(hints?.files) ? hints.files : [];
  const symbols = Array.isArray(hints?.symbols) ? hints.symbols : [];
  const expectedModifiedFiles = Array.isArray(hints?.expectedModifiedFiles) ? hints.expectedModifiedFiles : [];
  const reasons = [];
  if (files.includes(node.file) || symbols.some((symbol) => symbolIdentityMatches(node.qualifiedName || node.name, symbol))) {
    reasons.push("explicit-design-reference");
  }
  if (expectedModifiedFiles.includes(node.file)) reasons.push("expected-modification-target");
  return reasons;
}

function searchReasons(plan) {
  const engines = new Set((plan?.stages || []).map(({ engine }) => engine));
  const reasons = ["provider-ranked-match"];
  if (engines.has("sparse") && engines.has("dense")) reasons.push("hybrid-match");
  else if (engines.has("sparse")) reasons.push("lexical-match");
  else if (engines.has("dense")) reasons.push("semantic-match");
  if (plan?.graph) reasons.push("graph-expansion");
  return reasons;
}

function unresolvedConcepts(concepts, results) {
  const searchable = results.map((result) => [result.node_name, result.name, result.file, result.content].filter(Boolean).join(" ").toLowerCase()).join("\n");
  return (Array.isArray(concepts) ? concepts : []).map(String).filter((concept) => !searchable.includes(concept.toLowerCase()));
}

function symbolIdentityMatches(candidate, expected) {
  const normalizedCandidate = String(candidate || "").trim().toLowerCase();
  const normalizedExpected = String(expected || "").trim().toLowerCase();
  if (!normalizedCandidate || !normalizedExpected) return false;
  if (normalizedCandidate === normalizedExpected) return true;
  const candidateParts = normalizedCandidate.split(/::|[.#/\\]/).filter(Boolean);
  const expectedParts = normalizedExpected.split(/::|[.#/\\]/).filter(Boolean);
  if (candidateParts.length > 1 && expectedParts.length > 1) return false;
  const terminalCandidate = candidateParts.at(-1)?.replace(/\(.*$/, "");
  const terminalExpected = expectedParts.at(-1)?.replace(/\(.*$/, "");
  return terminalCandidate === terminalExpected;
}

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function concreteCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function normalizedSnapshotIdentity(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.scheme !== "string" || !value.scheme || typeof value.commit !== "string" || !value.commit || typeof value.fingerprint !== "string" || !value.fingerprint) {
    return null;
  }
  return { scheme: value.scheme, commit: value.commit, fingerprint: value.fingerprint };
}

function sameSnapshotIdentity(left, right) {
  return left?.scheme === right?.scheme && left?.commit === right?.commit && left?.fingerprint === right?.fingerprint;
}

export class McpStdioClient {
  constructor(child, { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    this.child = child;
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxResponseBytes = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.responseBuffer = "";
    this.responseBytes = 0;
    this.transportError = null;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.receiveChunk(chunk));
    child.once("error", (error) => this.failTransport(new CodeNibRuntimeError("process-start-failed", "CodeNib MCP could not start.", { cause: error })));
    child.once("exit", (code, signal) => this.failTransport(new CodeNibRuntimeError("process-exited", `CodeNib MCP exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`)));
  }

  receiveChunk(chunk) {
    if (this.transportError) return;
    const text = String(chunk);
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(cursor, end);
      const segmentBytes = Buffer.byteLength(segment, "utf8");
      if (this.responseBytes + segmentBytes > this.maxResponseBytes) {
        this.failTransport(new CodeNibRuntimeError("response-too-large", `CodeNib MCP response exceeded ${this.maxResponseBytes} bytes.`), true);
        return;
      }
      this.responseBuffer += segment;
      this.responseBytes += segmentBytes;
      if (newline === -1) return;
      const line = this.responseBuffer.endsWith("\r") ? this.responseBuffer.slice(0, -1) : this.responseBuffer;
      this.responseBuffer = "";
      this.responseBytes = 0;
      if (line) this.receive(line);
      cursor = newline + 1;
    }
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new CodeNibRuntimeError("request-failed", message.error.message || "CodeNib MCP request failed."));
    } else {
      pending.resolve(message.result);
    }
  }

  failTransport(error, terminate = false) {
    if (!this.transportError) this.transportError = error;
    this.failAll(this.transportError);
    if (terminate) {
      try {
        this.child.kill?.();
      } catch {
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.transportError) return Promise.reject(this.transportError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodeNibRuntimeError("request-timeout", `CodeNib MCP request timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "prism", version: "0" }
    });
    this.serverInfo = supportedServerInfo(result?.serverInfo);
    this.notify("notifications/initialized");
    return this.serverInfo;
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError) {
      const message = result.content?.find?.((item) => item.type === "text")?.text || `CodeNib tool ${name} failed.`;
      throw new CodeNibRuntimeError("tool-failed", message);
    }
    return { payload: payloadOf(result), rendered: JSON.stringify(result) };
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export async function openCodeNibClient(projectRoot, options = {}) {
  const canonicalRoot = await realpath(projectRoot);
  const configuredCommand = options.command || process.env.PRISM_CODENIB_COMMAND || await readCodeNibCommand(canonicalRoot);
  const command = configuredCommand || "codenib";
  const child = spawn(command, ["mcp", canonicalRoot], {
    cwd: canonicalRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new McpStdioClient(child, options);
  client.projectRoot = canonicalRoot;
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    if (error.code === "ENOENT" || error.cause?.code === "ENOENT" || /ENOENT/.test(error.message)) {
      throw new CodeNibRuntimeError("not-installed", "CodeNib is unavailable. Install and index CodeNib before repository context planning.", { cause: error });
    }
    throw error;
  }
}

export class CodeNibRepositoryIntelligence {
  constructor(client, { projectRoot = null, sourceProvider = null, sourceDescription = null } = {}) {
    this.client = client;
    this.projectRoot = projectRoot;
    this.sourceProvider = sourceProvider;
    this.sourceDescription = sourceDescription;
    this.manifest = null;
    this.manifestCommit = null;
    this.manifestFingerprint = null;
    this.manifestRoot = null;
    this.manifestSchemaVersion = null;
  }

  snapshotFailure(code, message, cause) {
    return new CodeNibRuntimeError(code, message, { cause });
  }

  async manifestValues(payload, { requireRoot = Boolean(this.projectRoot || this.sourceProvider) } = {}) {
    const commit = payload?.repo?.commit;
    const fingerprint = payload?.repo?.source_fingerprint || null;
    if (!commit) throw new Error("CodeNib manifest did not include a repository commit.");
    if (!fingerprint) throw new Error("CodeNib manifest did not include a source fingerprint.");
    let root = null;
    if (requireRoot) {
      const reportedRoot = payload?.repo?.path;
      if (typeof reportedRoot !== "string" || !reportedRoot || !path.isAbsolute(reportedRoot)) {
        throw new Error("CodeNib manifest did not include an absolute repository root.");
      }
      try {
        root = await realpath(reportedRoot);
      } catch (error) {
        throw new Error("CodeNib manifest repository root is unavailable.", { cause: error });
      }
    }
    return { commit, fingerprint, root };
  }

  async bindNativeSnapshot(source, payload, manifest, code = "snapshot-mismatch", { verifyNative = true } = {}) {
    const identity = normalizedSnapshotIdentity(source?.snapshotIdentity);
    const nativeRoot = this.sourceProvider?.projectRoot;
    if (!identity || identity.commit !== source?.commit || identity.fingerprint !== source?.sourceFingerprint) {
      throw this.snapshotFailure(code, "The native source provider did not supply a consistent snapshot identity.");
    }
    let canonicalProjectRoot;
    let canonicalNativeRoot;
    try {
      [canonicalProjectRoot, canonicalNativeRoot] = await Promise.all([realpath(this.projectRoot), realpath(nativeRoot)]);
    } catch (error) {
      throw this.snapshotFailure(code, "CodeNib and native source roots are unavailable.", error);
    }
    if (!manifest.root || manifest.root !== canonicalProjectRoot || manifest.root !== canonicalNativeRoot) {
      throw this.snapshotFailure(code, "CodeNib and native source do not use the same canonical project root.");
    }
    if (payload?.runtime?.source_read?.verified !== true) {
      throw this.snapshotFailure(code, "CodeNib did not enable verified source reads for its current checkout.");
    }
    if (!concreteCommit(source.commit) || !concreteCommit(manifest.commit) || source.commit.toLowerCase() !== manifest.commit.toLowerCase()) {
      throw this.snapshotFailure(code, "CodeNib does not describe the native source commit.");
    }
    if (!verifyNative) return identity;
    if (typeof this.sourceProvider?.verifySnapshot !== "function") {
      throw this.snapshotFailure(code, "The native source provider cannot verify whole-snapshot freshness.");
    }
    let verified;
    try {
      verified = await this.sourceProvider.verifySnapshot({ requireComplete: true });
    } catch (error) {
      throw this.snapshotFailure(code, "The native source snapshot is not fresh after CodeNib startup verification.", error);
    }
    if (!sameSnapshotIdentity(identity, normalizedSnapshotIdentity(verified?.snapshotIdentity))) {
      throw this.snapshotFailure(code, "The native source snapshot changed during CodeNib binding.");
    }
    return identity;
  }

  async describe() {
    const serverInfo = supportedServerInfo(this.client?.serverInfo);
    const { payload } = await this.client.callTool("get_manifest");
    if (payload?.error) throw new Error(`CodeNib manifest failed: ${payload.error}`);
    this.manifest = payload;
    let manifest;
    try {
      manifest = await this.manifestValues(payload);
    } catch (error) {
      if (this.projectRoot || this.sourceProvider) {
        throw this.snapshotFailure("snapshot-mismatch", "CodeNib returned an incomplete source binding manifest.", error);
      }
      throw error;
    }
    this.manifestCommit = manifest.commit;
    this.manifestFingerprint = manifest.fingerprint;
    this.manifestRoot = manifest.root;
    this.manifestSchemaVersion = payload?.version === undefined ? null : String(payload.version);
    const source = this.sourceDescription || (this.sourceProvider ? await this.sourceProvider.describe() : null);
    const boundIdentity = source ? await this.bindNativeSnapshot(source, payload, manifest) : null;
    if (boundIdentity) this.sourceDescription = source;
    const loaded = new Set(payload?.runtime?.loaded_views || []);
    return {
      name: "codenib",
      version: serverInfo.version,
      commit: source?.commit || this.manifestCommit,
      sourceFingerprint: source?.sourceFingerprint || this.manifestFingerprint,
      ...(boundIdentity ? { snapshotIdentity: { ...boundIdentity } } : {}),
      capabilities: {
        lexicalSearch: loaded.has("bm25"),
        semanticSearch: loaded.has("vector"),
        hybridSearch: loaded.has("bm25") && loaded.has("vector"),
        symbolGraph: loaded.has("symbol_graph"),
        verifiedSource: payload?.runtime?.source_read?.verified === true
      }
    };
  }

  async verifySnapshot() {
    if (!this.manifestCommit || !this.manifestFingerprint) {
      throw this.snapshotFailure("snapshot-changed", "CodeNib has no source snapshot to verify.");
    }
    const { payload } = await this.client.callTool("get_manifest");
    if (payload?.error) throw this.snapshotFailure("snapshot-changed", `CodeNib manifest failed: ${payload.error}`);
    let current;
    try {
      current = await this.manifestValues(payload);
    } catch (error) {
      throw this.snapshotFailure("snapshot-changed", "CodeNib returned an incomplete manifest during snapshot verification.", error);
    }
    if (current.commit !== this.manifestCommit || current.fingerprint !== this.manifestFingerprint || current.root !== this.manifestRoot) {
      throw this.snapshotFailure("snapshot-changed", "The CodeNib source snapshot changed during repository planning.");
    }
    if (!this.sourceDescription) {
      return { provider: "codenib", commit: current.commit, sourceFingerprint: current.fingerprint };
    }
    const snapshotIdentity = await this.bindNativeSnapshot(this.sourceDescription, payload, current, "snapshot-changed", { verifyNative: false });
    return { provider: "codenib", snapshotIdentity };
  }

  async completeNodeRange(node) {
    if (node.rangeComplete) return node;
    const { payload } = await this.client.callTool("search_regex", {
      pattern: escapedRegex(node.name),
      top_k: MAX_REGEX_RESULTS,
      file_glob: node.file,
      node_type: node.kind === "symbol" ? "" : node.kind,
      case_sensitive: true
    });
    const matches = Array.isArray(payload) ? payload.slice(0, MAX_REGEX_RESULTS) : [];
    const candidates = matches.map((value) => sourceNode(value, { projectRoot: this.projectRoot })).filter((candidate) => candidate && candidate.file === node.file && candidate.rangeComplete && symbolIdentityMatches(candidate.qualifiedName || candidate.name, node.qualifiedName || node.name));
    const containing = candidates.filter((candidate) => candidate.range.startLine <= node.range.startLine && node.range.startLine <= candidate.range.endLine);
    containing.sort((left, right) => (left.range.endLine - left.range.startLine) - (right.range.endLine - right.range.startLine));
    const match = containing[0];
    if (!match) return node;
    return {
      ...node,
      id: match.id,
      range: match.range,
      rangeComplete: true,
      ...(node.qualifiedName || !match.qualifiedName ? {} : { qualifiedName: match.qualifiedName }),
      ...(node.signature || !match.signature ? {} : { signature: match.signature })
    };
  }

  async search(task, hints = {}, options = {}) {
    let normalizedHints;
    try {
      normalizedHints = {
        ...hints,
        files: (Array.isArray(hints.files) ? hints.files : []).map((file) => normalizeRepositorySourcePath(String(file), { projectRoot: this.projectRoot })),
        expectedModifiedFiles: (Array.isArray(hints.expectedModifiedFiles) ? hints.expectedModifiedFiles : []).map((file) => normalizeRepositorySourcePath(String(file), { projectRoot: this.projectRoot }))
      };
    } catch (error) {
      throw new CodeNibRuntimeError("invalid-input", error.message, { cause: error });
    }
    const topK = Math.min(MAX_SEARCH_RESULTS, positiveInteger(options.topK, 12, "topK"));
    const { payload } = await this.client.callTool("search_context", {
      query: task,
      top_k: topK,
      budget: options.budget,
      level: "l2",
      filter_test: false
    });
    if (payload?.error) throw new Error(`CodeNib search failed: ${payload.error}`);
    if (!payload?.plan || !Array.isArray(payload?.results)) throw new Error("CodeNib search returned an unusable response.");
    if (this.manifestCommit && payload?.source?.commit !== this.manifestCommit) {
      throw new Error("CodeNib search provenance does not match its loaded manifest.");
    }
    if (this.manifestFingerprint && payload?.source?.source_fingerprint !== this.manifestFingerprint) {
      throw new Error("CodeNib search provenance does not match its loaded manifest.");
    }
    const results = Array.isArray(payload?.results) ? payload.results.slice(0, topK) : [];
    const searchEngines = new Set((payload.plan.stages || []).map(({ engine }) => String(engine)));
    const baseReasons = searchReasons(payload?.plan);
    const hits = [];
    for (const result of results) {
      const node = sourceNode(result, { projectRoot: this.projectRoot });
      if (!node) continue;
      const reasons = hintReasons(node, normalizedHints);
      hits.push({
        node,
        score: Number.isFinite(result.score) ? Number(result.score) : null,
        reasons: [...reasons, ...baseReasons]
      });
    }
    const diagnostics = [];
    const unresolvedRequired = [];
    const explicitSymbols = Array.isArray(normalizedHints?.symbols) ? normalizedHints.symbols.map(String) : [];
    for (const symbol of explicitSymbols) {
      if (hits.some(({ node }) => symbolIdentityMatches(node.qualifiedName || node.name, symbol))) continue;
      const { payload: definitions } = await this.client.callTool("lsp_definition", { symbol, top_k: 4 });
      let resolved = false;
      for (const definition of Array.isArray(definitions) ? definitions.slice(0, MAX_DEFINITION_RESULTS) : []) {
        const compactNode = sourceNode(definition, { compact: true, projectRoot: this.projectRoot });
        if (!compactNode || !symbolIdentityMatches(compactNode.qualifiedName || compactNode.name, symbol)) continue;
        const node = await this.completeNodeRange(compactNode);
        hits.push({ node, score: null, reasons: ["explicit-design-reference", "definition"] });
        resolved = true;
      }
      if (!resolved) {
        diagnostics.push({ code: "explicit_symbol_unresolved", message: `CodeNib could not resolve the explicit symbol ${symbol}.` });
        unresolvedRequired.push({ kind: "symbol", value: symbol });
      }
    }
    const fileHints = new Map();
    for (const file of normalizedHints.files) {
      fileHints.set(String(file), [...(fileHints.get(String(file)) || []), "explicit-design-reference"]);
    }
    for (const file of normalizedHints.expectedModifiedFiles) {
      fileHints.set(String(file), [...(fileHints.get(String(file)) || []), "expected-modification-target"]);
    }
    for (const [file, reasons] of fileHints) {
      if (hits.some(({ node }) => node.file === file)) continue;
      const { payload: matches } = await this.client.callTool("search_regex", { pattern: ".", top_k: MAX_REGEX_RESULTS, file_glob: file, node_type: "file", case_sensitive: false });
      let resolved = false;
      for (const match of Array.isArray(matches) ? matches.slice(0, MAX_REGEX_RESULTS) : []) {
        const node = sourceNode(match, { compact: !Number.isInteger(match.end_line), projectRoot: this.projectRoot });
        if (!node || node.file !== file) continue;
        hits.push({ node, score: null, reasons });
        resolved = true;
      }
      if (!resolved) {
        hits.push({ node: { id: `file:${file}`, file, range: { startLine: 1, endLine: 200 }, kind: "file", name: file, rangeComplete: false }, score: null, reasons });
        diagnostics.push({ code: "explicit_file_bounded", message: `CodeNib exposed only a bounded initial source range for the explicit file ${file}.` });
      }
    }
    if (!searchEngines.has("dense")) {
      diagnostics.push({ code: "semantic_unavailable", message: "CodeNib did not use a semantic retrieval stage for this plan." });
    }
    return {
      hits,
      retrievalCoverage: null,
      unresolvedConcepts: unresolvedConcepts(normalizedHints?.concepts, results),
      unresolvedRequired,
      estimateEligible: searchEngines.has("sparse") && searchEngines.has("dense"),
      diagnostics,
      retrievalPlan: {
        engines: [...searchEngines],
        fusion: payload.plan.fusion || null,
        graphExpanded: Boolean(payload.plan.graph),
        budget: payload.plan.budget || options.budget
      }
    };
  }

  async neighbors(nodes, options) {
    const neighbors = [];
    const diagnostics = [];
    let estimateEligible = true;
    if (nodes.length > 3) {
      diagnostics.push({ code: "graph_seed_limit", message: `CodeNib graph expansion used the first 3 of ${nodes.length} ranked anchors.` });
      estimateEligible = false;
    }
    const perSeedLimit = Math.max(1, Math.floor(options.maxNodes / Math.max(1, Math.min(nodes.length, 3))));
    for (const anchor of nodes.slice(0, 3)) {
      const { payload } = await this.client.callTool("dependency_subgraph", {
        symbol: anchor.qualifiedName || anchor.name,
        direction: "both",
        depth: 1,
        max_nodes: perSeedLimit,
        max_edges: Math.min(80, options.maxNodes * 4)
      });
      if (payload?.error || payload?.note) {
        diagnostics.push({ code: payload?.error ? "graph_unavailable" : "graph_note", message: String(payload.error || payload.note) });
        estimateEligible = false;
      }
      if (payload?.truncated === true) {
        diagnostics.push({ code: "graph_truncated", message: "CodeNib truncated the graph response at its node or edge limit." });
        estimateEligible = false;
      }
      if (!Array.isArray(payload?.nodes)) {
        diagnostics.push({ code: "graph_invalid_response", message: "CodeNib returned no graph node list." });
        estimateEligible = false;
      }
      const values = Array.isArray(payload?.nodes) ? payload.nodes : [];
      if (values.length >= perSeedLimit) {
        diagnostics.push({ code: "graph_node_limit", message: `CodeNib graph expansion reached its limit of ${perSeedLimit} nodes for one anchor.` });
        estimateEligible = false;
      }
      for (const value of values.slice(0, perSeedLimit)) {
        const compactNode = sourceNode(value, { compact: true, projectRoot: this.projectRoot });
        if (!compactNode) {
          estimateEligible = false;
          continue;
        }
        if (compactNode.id === anchor.id || compactNode.name === payload.root) continue;
        const node = await this.completeNodeRange(compactNode);
        if (!node.rangeComplete) {
          diagnostics.push({ code: "graph_range_incomplete", message: `CodeNib could not resolve the complete source range for ${node.name}.` });
          estimateEligible = false;
        }
        neighbors.push({ node, from: anchor.id, relationship: "reference", score: Number.isInteger(value.depth) ? 1 / (value.depth + 1) : null });
        if (neighbors.length >= options.maxNodes) {
          estimateEligible = false;
          break;
        }
      }
      if (neighbors.length >= options.maxNodes) break;
    }
    return {
      neighbors,
      graphCoverage: null,
      estimateEligible,
      diagnostics
    };
  }

  async read(sourceRange) {
    let validatedRange;
    try {
      validatedRange = normalizeRepositorySourceRange(sourceRange, { projectRoot: this.projectRoot });
    } catch (error) {
      throw new CodeNibRuntimeError("invalid-input", error.message, { cause: error });
    }
    const contents = [];
    const rendered = [];
    let nextLine = validatedRange.range.startLine;
    let lastLine = nextLine - 1;
    let rangeComplete = true;
    while (nextLine <= validatedRange.range.endLine) {
      const requestedEnd = Math.min(validatedRange.range.endLine, nextLine + 199);
      const result = await this.client.callTool("read_source", {
        file_path: validatedRange.file,
        start_line: nextLine,
        end_line: requestedEnd
      });
      if (result.payload?.source?.verified !== true) {
        throw new Error(`CodeNib could not verify source for ${validatedRange.file}.`);
      }
      if (typeof result.payload?.content !== "string" || result.payload.content.length === 0) {
        throw new Error(`CodeNib returned no source content for ${validatedRange.file}.`);
      }
      const responseFiles = [result.payload?.file, result.payload?.file_path].filter((value) => value !== undefined);
      let normalizedResponseFiles;
      try {
        normalizedResponseFiles = responseFiles.map((value) => normalizeRepositorySourcePath(value, { projectRoot: this.projectRoot }));
      } catch (error) {
        throw new CodeNibRuntimeError("invalid-response", "CodeNib returned an unsafe source path.", { cause: error });
      }
      if (normalizedResponseFiles.length === 0 || normalizedResponseFiles.some((value) => value !== validatedRange.file)) {
        throw new Error(`CodeNib returned a different source identity for ${validatedRange.file}.`);
      }
      if (this.manifestCommit && result.payload?.source?.commit !== this.manifestCommit) {
        throw new Error(`CodeNib returned mismatched source provenance for ${validatedRange.file}.`);
      }
      if (this.manifestFingerprint && result.payload?.source?.source_fingerprint !== this.manifestFingerprint) {
        throw new Error(`CodeNib returned mismatched source provenance for ${validatedRange.file}.`);
      }
      if (result.payload?.content_projection?.line_truncated) {
        throw new Error(`CodeNib truncated a source line while reading ${validatedRange.file}.`);
      }
      if (result.payload?.start_line !== nextLine) {
        throw new Error(`CodeNib returned a discontinuous source range for ${validatedRange.file}.`);
      }
      contents.push(result.payload.content);
      rendered.push(result.rendered);
      lastLine = result.payload.end_line;
      if (!Number.isInteger(lastLine) || lastLine < nextLine) {
        throw new Error(`CodeNib returned an invalid source range for ${validatedRange.file}.`);
      }
      if (lastLine < requestedEnd && !result.payload?.content_projection?.next_start_line) break;
      const candidateLine = result.payload?.content_projection?.next_start_line || lastLine + 1;
      if (!Number.isInteger(candidateLine) || candidateLine <= nextLine) {
        throw new Error(`CodeNib did not advance its source range for ${validatedRange.file}.`);
      }
      if (candidateLine !== lastLine + 1) {
        rangeComplete = false;
        break;
      }
      nextLine = candidateLine;
    }
    return {
      content: contents.join(""),
      rendered: rendered.join("\n"),
      range: { startLine: validatedRange.range.startLine, endLine: lastLine },
      rangeComplete: rangeComplete && lastLine >= validatedRange.range.endLine
    };
  }
}

export async function withCodeNibRepositoryIntelligence(projectRoot, action, options = {}) {
  const client = await openCodeNibClient(projectRoot, options);
  try {
    return await action(new CodeNibRepositoryIntelligence(client, { projectRoot: client.projectRoot }));
  } finally {
    await client.close();
  }
}
