import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeRepositorySourcePath } from "./repository-source-path.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;
const MAX_QUERY_LENGTH = 16384;
const MAX_HINTS_PER_KIND = 32;
const MAX_SYMBOL_HINT_MATCHES = 4;
const CONTEXT_NODES_BY_BUDGET = Object.freeze({ fast: 50, balanced: 100, thorough: 200 });
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;

export const CODEGRAPH_SUPPORTED_VERSION = Object.freeze({
  minimum: "1.6.0",
  maximumExclusive: "1.7.0"
});

export const CODEGRAPH_CAPABILITIES = Object.freeze({
  lexicalSearch: true,
  semanticSearch: false,
  hybridSearch: false,
  symbolGraph: true,
  verifiedSource: true
});
const CAPABILITIES = CODEGRAPH_CAPABILITIES;

const REMEDIATION = Object.freeze({
  "not-installed": "Install CodeGraph 1.6.0 up to but not including 1.7.0, then retry the request.",
  "not-indexed": "Initialize the project with CodeGraph outside Prism, then retry the request.",
  "incompatible-version": "Install a CodeGraph version from 1.6.0 up to but not including 1.7.0.",
  "invalid-status": "Update CodeGraph or rebuild its index, then retry the request.",
  "project-mismatch": "Create an index at the exact project root instead of using an index from another directory.",
  "worktree-mismatch": "Create or select a CodeGraph index for the active worktree.",
  "stale-index": "Run CodeGraph sync outside Prism, then retry the request.",
  "incomplete-index": "Run a complete CodeGraph index outside Prism, then retry the request.",
  "incompatible-index": "Rebuild the CodeGraph index with the installed CodeGraph version.",
  "snapshot-changed": "Retry repository planning after CodeGraph finishes its index update."
});

export class CodeGraphAvailabilityError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodeGraphAvailabilityError";
    this.code = code;
    this.recoverable = true;
    this.remediation = options.remediation || REMEDIATION[code] || "Select another repository-intelligence provider and retry the request.";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CodeGraphRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodeGraphRuntimeError";
    this.code = code;
    this.recoverable = options.recoverable !== false;
    this.remediation = options.remediation || REMEDIATION[code] || null;
    if (options.details !== undefined) this.details = options.details;
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function createCodeGraphCommandRunner(options = {}) {
  const command = options.command || process.env.PRISM_CODEGRAPH_COMMAND || "codegraph";
  const spawnImpl = options.spawnImpl || spawn;
  const environment = options.env || process.env;
  const defaultTimeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const defaultMaxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS);

  return async function runCodeGraph(args, invocation = {}) {
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
      throw new TypeError("CodeGraph command arguments must be strings.");
    }
    const timeoutMs = positiveInteger(invocation.timeoutMs, defaultTimeoutMs);
    const maxOutputBytes = positiveInteger(invocation.maxOutputBytes, defaultMaxOutputBytes);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd: invocation.cwd,
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(new CodeGraphRuntimeError("process-start-failed", "CodeGraph could not start.", { cause: error }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timeout;
      const onStdout = (chunk) => append("stdout", chunk);
      const onStderr = (chunk) => append("stderr", chunk);
      const cleanup = () => {
        child.stdout?.off?.("data", onStdout);
        child.stderr?.off?.("data", onStderr);
        child.off?.("error", onError);
        child.off?.("close", onClose);
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
      };
      const terminate = () => {
        try {
          child.kill?.("SIGTERM");
        } catch {
        }
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill?.("SIGKILL");
            } catch {
            }
          }
        }, killGraceMs);
        force.unref?.();
      };
      const finish = (callback, value, terminateChild = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        callback(value);
        if (terminateChild) terminate();
      };
      const fail = (error, kill = false) => {
        finish(reject, error, kill);
      };
      const append = (stream, chunk) => {
        if (settled) return;
        const text = String(chunk);
        const chunkBytes = byteLength(text);
        if (stdoutBytes + stderrBytes + chunkBytes > maxOutputBytes) {
          fail(new CodeGraphRuntimeError("output-too-large", `CodeGraph output exceeded ${maxOutputBytes} bytes.`), true);
          return;
        }
        if (stream === "stdout") {
          stdout += text;
          stdoutBytes += chunkBytes;
        } else {
          stderr += text;
          stderrBytes += chunkBytes;
        }
      };
      const onError = (error) => {
        fail(new CodeGraphRuntimeError("process-start-failed", "CodeGraph could not start.", { cause: error }));
      };
      const onClose = (exitCode, signal) => {
        if (settled) return;
        if (exitCode !== 0) {
          const detail = stderr.trim();
          fail(new CodeGraphRuntimeError(
            "process-failed",
            `CodeGraph exited without a successful result.${detail ? ` ${detail}` : ""}`,
            { details: { exitCode, signal: signal || null } }
          ));
          return;
        }
        finish(resolve, { stdout, stderr, exitCode });
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      timeout = setTimeout(() => {
        fail(new CodeGraphRuntimeError("timeout", `CodeGraph did not finish within ${timeoutMs}ms.`), true);
      }, timeoutMs);
    });
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function supportedVersion(value) {
  const parsed = parseVersion(value);
  const minimum = parseVersion(CODEGRAPH_SUPPORTED_VERSION.minimum);
  const maximum = parseVersion(CODEGRAPH_SUPPORTED_VERSION.maximumExclusive);
  return parsed && compareVersions(parsed, minimum) >= 0 && compareVersions(parsed, maximum) < 0;
}

async function exactIndexExists(projectRoot) {
  try {
    const metadata = await lstat(path.join(projectRoot, ".codegraph"));
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function unavailable(projectRoot, code, reason, details) {
  return {
    provider: "codegraph",
    status: "UNAVAILABLE",
    projectRoot,
    code,
    reason,
    remediation: REMEDIATION[code] || "Select another repository-intelligence provider and retry the request.",
    ...(details === undefined ? {} : { details })
  };
}

function jsonFromCommand(result, label) {
  if (!result || result.exitCode !== 0 || typeof result.stdout !== "string") {
    throw new CodeGraphRuntimeError("invalid-response", `CodeGraph ${label} returned no usable output.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new CodeGraphRuntimeError("invalid-json", `CodeGraph ${label} returned invalid JSON.`, { cause: error });
  }
}

function statusShapeIsValid(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (typeof status.initialized !== "boolean" || typeof status.version !== "string" || typeof status.projectPath !== "string" || typeof status.indexPath !== "string") return false;
  if (!status.initialized) return true;
  if (typeof status.lastIndexed !== "string" || !status.lastIndexed) return false;
  if (![status.fileCount, status.nodeCount, status.edgeCount].every(nonnegativeInteger)) return false;
  if (!status.pendingChanges || ![status.pendingChanges.added, status.pendingChanges.modified, status.pendingChanges.removed].every(nonnegativeInteger)) return false;
  if (!status.index || typeof status.index !== "object") return false;
  if (!nonnegativeInteger(status.index.pendingRefs) || typeof status.index.reindexRecommended !== "boolean") return false;
  return typeof status.index.state === "string" || status.index.state === null;
}

function snapshotOf(status) {
  return {
    version: status.version,
    projectPath: status.projectPath,
    lastIndexed: status.lastIndexed,
    fileCount: status.fileCount,
    nodeCount: status.nodeCount,
    edgeCount: status.edgeCount,
    builtWithVersion: status.index.builtWithVersion ?? null,
    builtWithExtractionVersion: status.index.builtWithExtractionVersion ?? null,
    currentExtractionVersion: status.index.currentExtractionVersion ?? null
  };
}

async function inspectStatus(projectRoot, version, runner) {
  const result = await runner(["status", "--json", projectRoot], { cwd: projectRoot });
  const status = jsonFromCommand(result, "status");
  if (!statusShapeIsValid(status)) return unavailable(projectRoot, "invalid-status", "CodeGraph returned an incompatible status response.");
  if (!status.initialized) return unavailable(projectRoot, "not-indexed", "CodeGraph has no initialized index at the project root.");
  if (status.version !== version || !supportedVersion(status.version)) {
    return unavailable(projectRoot, "incompatible-version", `CodeGraph status reported unsupported version ${status.version}.`);
  }
  let statusRoot;
  try {
    statusRoot = await realpath(status.projectPath);
  } catch (error) {
    return unavailable(projectRoot, "project-mismatch", "CodeGraph status identified an unavailable project root.", { cause: error.message });
  }
  if (statusRoot !== projectRoot) return unavailable(projectRoot, "project-mismatch", "CodeGraph resolved an index from a different project root.");
  if (path.resolve(status.indexPath) !== path.join(projectRoot, ".codegraph")) {
    return unavailable(projectRoot, "project-mismatch", "CodeGraph resolved an index directory outside the project root.");
  }
  if (status.worktreeMismatch !== null && status.worktreeMismatch !== undefined) {
    return unavailable(projectRoot, "worktree-mismatch", "CodeGraph reported that the index belongs to another worktree.");
  }
  if (status.index.state !== "complete") return unavailable(projectRoot, "incomplete-index", `CodeGraph index state is ${status.index.state ?? "unknown"}.`);
  if (status.index.pendingRefs !== 0) return unavailable(projectRoot, "incomplete-index", "CodeGraph has unresolved graph references.");
  if (status.index.reindexRecommended) return unavailable(projectRoot, "incompatible-index", "CodeGraph recommends rebuilding this index.");
  if (status.pendingChanges.added || status.pendingChanges.modified || status.pendingChanges.removed) {
    return unavailable(projectRoot, "stale-index", "CodeGraph has pending source changes.");
  }
  return { provider: "codegraph", status: "AVAILABLE", projectRoot, version, capabilities: CAPABILITIES, snapshot: snapshotOf(status) };
}

function asAvailabilityFailure(projectRoot, error) {
  if (error instanceof CodeGraphAvailabilityError) {
    return unavailable(projectRoot, error.code, error.message, error.details);
  }
  if (error instanceof CodeGraphRuntimeError && (error.code === "process-start-failed" || error.cause?.code === "ENOENT")) {
    return unavailable(projectRoot, "not-installed", "CodeGraph is not installed or cannot start.");
  }
  if (error instanceof CodeGraphRuntimeError) {
    return unavailable(projectRoot, error.code, error.message, error.details);
  }
  throw error;
}

export async function probeCodeGraphAvailability(projectRoot, options = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new TypeError("The CodeGraph project root must be an absolute path.");
  }
  const canonicalRoot = await realpath(projectRoot);
  if (!(await exactIndexExists(canonicalRoot))) {
    return unavailable(canonicalRoot, "not-indexed", "CodeGraph has no index at the exact project root.");
  }
  const runner = options.runner || createCodeGraphCommandRunner(options);
  try {
    const versionResult = await runner(["--version"], { cwd: canonicalRoot });
    const version = String(versionResult?.stdout || "").trim().replace(/^v/, "");
    if (!supportedVersion(version)) {
      return unavailable(canonicalRoot, "incompatible-version", `CodeGraph version ${version || "unknown"} is unsupported.`);
    }
    return await inspectStatus(canonicalRoot, version, runner);
  } catch (error) {
    return asAvailabilityFailure(canonicalRoot, error);
  }
}

function normalizeRelativePath(projectRoot, value) {
  try {
    return normalizeRepositorySourcePath(value, { projectRoot });
  } catch (error) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an unsafe source path.");
  }
}

function normalizeNode(projectRoot, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an invalid source node.");
  }
  const startLine = value.startLine;
  const endLine = value.endLine;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an invalid source range.");
  }
  if (typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name || typeof value.kind !== "string" || !value.kind) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an incomplete source node.");
  }
  return {
    id: value.id,
    file: normalizeRelativePath(projectRoot, value.filePath),
    range: { startLine, endLine },
    kind: value.kind === "type_alias" ? "type" : value.kind,
    name: value.name,
    rangeComplete: true,
    ...(typeof value.qualifiedName === "string" && value.qualifiedName ? { qualifiedName: value.qualifiedName } : {}),
    ...(typeof value.signature === "string" && value.signature ? { signature: value.signature } : {})
  };
}

function normalizeEdge(value) {
  if (!value || typeof value !== "object" || typeof value.source !== "string" || !value.source || typeof value.target !== "string" || !value.target || typeof value.kind !== "string" || !value.kind) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an invalid graph edge.");
  }
  return { source: value.source, target: value.target, kind: value.kind };
}

function normalizeContext(projectRoot, payload, limits) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph returned an invalid context response.");
  }
  for (const field of ["entryPoints", "nodes", "edges", "relatedFiles"]) {
    if (!Array.isArray(payload[field])) throw new CodeGraphRuntimeError("invalid-response", `CodeGraph context omitted ${field}.`);
  }
  if (!payload.stats || typeof payload.stats !== "object" || Array.isArray(payload.stats)) {
    throw new CodeGraphRuntimeError("invalid-response", "CodeGraph context omitted its statistics.");
  }
  const affirmativelyComplete = payload.truncated === false || payload.complete === true;
  const boundedFields = [];
  const fieldIsBounded = (values, limit, name) => {
    const bounded = values.length > limit || (values.length === limit && !affirmativelyComplete);
    if (bounded) boundedFields.push({ field: name, returned: values.length, limit });
    return bounded;
  };
  fieldIsBounded(payload.entryPoints, limits.maxEntryPoints, "entryPoints");
  fieldIsBounded(payload.nodes, limits.maxNodes, "nodes");
  fieldIsBounded(payload.edges, limits.maxEdges, "edges");
  const nodes = new Map();
  const entryPoints = [];
  for (const value of payload.entryPoints.slice(0, limits.maxEntryPoints)) {
    const node = normalizeNode(projectRoot, value);
    if (nodes.size >= limits.maxNodes && !nodes.has(node.id)) continue;
    nodes.set(node.id, node);
    entryPoints.push(node);
  }
  for (const value of payload.nodes.slice(0, limits.maxNodes)) {
    const node = normalizeNode(projectRoot, value);
    if (nodes.size >= limits.maxNodes && !nodes.has(node.id)) continue;
    nodes.set(node.id, node);
  }
  const edges = payload.edges.slice(0, limits.maxEdges).map(normalizeEdge);
  const missingEdgeEndpoints = edges.filter(({ source, target }) => !nodes.has(source) || !nodes.has(target)).length;
  const diagnostics = boundedFields.length
    ? [{ code: "context_results_bounded", message: "CodeGraph context results reached or exceeded Prism consumer limits.", details: { fields: boundedFields } }]
    : [];
  return { entryPoints, nodes, edges, missingEdgeEndpoints, bounded: boundedFields.length > 0, affirmativelyComplete, diagnostics };
}

function normalizeQueryResults(projectRoot, payload, limit) {
  if (!Array.isArray(payload)) throw new CodeGraphRuntimeError("invalid-response", "CodeGraph query returned an invalid result list.");
  const results = payload.slice(0, limit).map((result) => {
    if (!result || typeof result !== "object" || !result.node) {
      throw new CodeGraphRuntimeError("invalid-response", "CodeGraph query returned an invalid result.");
    }
    return { node: normalizeNode(projectRoot, result.node), score: Number.isFinite(result.score) ? Number(result.score) : null };
  });
  return { results, bounded: payload.length > limit };
}

function symbolIdentityMatches(candidate, expected) {
  const normalizedCandidate = String(candidate || "").trim().toLowerCase();
  const normalizedExpected = String(expected || "").trim().toLowerCase();
  if (!normalizedCandidate || !normalizedExpected) return false;
  if (normalizedCandidate === normalizedExpected) return true;
  const candidateParts = normalizedCandidate.split(/::|[.#/\\]/).filter(Boolean);
  const expectedParts = normalizedExpected.split(/::|[.#/\\]/).filter(Boolean);
  if (candidateParts.length > 1 && expectedParts.length > 1) return false;
  return candidateParts.at(-1)?.replace(/\(.*$/, "") === expectedParts.at(-1)?.replace(/\(.*$/, "");
}

function stringHints(hints, name) {
  if (hints?.[name] === undefined) return [];
  if (!Array.isArray(hints[name]) || hints[name].length > MAX_HINTS_PER_KIND || hints[name].some((value) => typeof value !== "string" || !value.trim())) {
    throw new CodeGraphRuntimeError("invalid-input", `CodeGraph accepts at most ${MAX_HINTS_PER_KIND} nonempty ${name} hints.`);
  }
  return [...new Set(hints[name].map((value) => value.trim()))];
}

function inputSourcePaths(projectRoot, values) {
  try {
    return values.map((value) => normalizeRepositorySourcePath(value, { projectRoot }));
  } catch (error) {
    throw new CodeGraphRuntimeError("invalid-input", "CodeGraph requires safe project-relative file hints.", { cause: error });
  }
}

function hintSet(projectRoot, hints) {
  return {
    files: inputSourcePaths(projectRoot, stringHints(hints, "files")),
    symbols: stringHints(hints, "symbols"),
    concepts: stringHints(hints, "concepts"),
    expectedModifiedFiles: inputSourcePaths(projectRoot, stringHints(hints, "expectedModifiedFiles"))
  };
}

function reasonsFor(node, hints) {
  const reasons = [];
  if (hints.files.includes(node.file) || hints.symbols.some((symbol) => symbolIdentityMatches(node.qualifiedName || node.name, symbol))) {
    reasons.push("explicit-design-reference");
  }
  if (hints.expectedModifiedFiles.includes(node.file)) reasons.push("expected-modification-target");
  return reasons;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function addHit(hits, byId, hit) {
  const existing = byId.get(hit.node.id);
  if (existing) {
    existing.reasons = unique([...existing.reasons, ...hit.reasons]);
    if (Number.isFinite(hit.score) && (!Number.isFinite(existing.score) || hit.score > existing.score)) existing.score = hit.score;
    return;
  }
  byId.set(hit.node.id, hit);
  hits.push(hit);
}

function relationshipFor(edge, anchorIsSource, neighbor) {
  if (edge.kind === "calls") {
    if (!anchorIsSource && TEST_PATH.test(neighbor.file)) return "tests";
    return anchorIsSource ? "callee" : "caller";
  }
  if (["implements", "extends", "overrides"].includes(edge.kind)) return anchorIsSource ? "definition" : "implementation";
  if (edge.kind === "contains") return anchorIsSource ? "reference" : "definition";
  if (["type_of", "returns", "instantiates"].includes(edge.kind)) return "type-dependency";
  if (["references", "imports", "exports", "decorates"].includes(edge.kind)) return "reference";
  return "related";
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CodeGraphRepositoryIntelligence {
  constructor({ projectRoot, sourceProvider, runner, availability }) {
    if (!sourceProvider || typeof sourceProvider.describe !== "function" || typeof sourceProvider.read !== "function") {
      throw new TypeError("CodeGraph requires a native source provider with describe and read methods.");
    }
    this.projectRoot = projectRoot;
    this.sourceProvider = sourceProvider;
    this.runner = runner;
    this.version = availability.version;
    this.snapshot = availability.snapshot;
    this.graph = null;
  }

  async currentAvailability() {
    return inspectStatus(this.projectRoot, this.version, this.runner);
  }

  async assertFreshSnapshot() {
    let current;
    try {
      current = await this.currentAvailability();
    } catch (error) {
      if (error instanceof CodeGraphRuntimeError) throw error;
      throw new CodeGraphRuntimeError("status-failed", "CodeGraph freshness validation failed.", { cause: error });
    }
    if (current.status !== "AVAILABLE") {
      throw new CodeGraphRuntimeError(current.code, current.reason, { remediation: current.remediation, details: current.details });
    }
    if (!sameSnapshot(this.snapshot, current.snapshot)) {
      throw new CodeGraphRuntimeError("snapshot-changed", "The CodeGraph index changed during repository planning.", {
        remediation: REMEDIATION["snapshot-changed"],
        details: { before: this.snapshot, after: current.snapshot }
      });
    }
    return current.snapshot;
  }

  async verifySnapshot() {
    await this.assertFreshSnapshot();
    return { provider: "codegraph", version: this.version, snapshot: this.snapshot };
  }

  async describe() {
    await this.assertFreshSnapshot();
    const source = await this.sourceProvider.describe();
    return {
      name: "codegraph",
      version: this.version,
      commit: source?.commit,
      ...(source?.sourceFingerprint ? { sourceFingerprint: source.sourceFingerprint } : {}),
      ...(source?.snapshotIdentity ? { snapshotIdentity: { ...source.snapshotIdentity } } : {}),
      capabilities: { ...CAPABILITIES },
      contributors: [
        { name: String(source?.name || "native"), role: "source" },
        { name: "codegraph", version: this.version, role: "discovery" }
      ]
    };
  }

  async search(task, hints = {}, options = {}) {
    if (typeof task !== "string" || !task.trim()) throw new CodeGraphRuntimeError("invalid-input", "CodeGraph requires a nonempty task.");
    const normalizedHints = hintSet(this.projectRoot, hints);
    const query = unique([
      task.trim(),
      ...normalizedHints.symbols,
      ...normalizedHints.concepts,
      ...normalizedHints.files,
      ...normalizedHints.expectedModifiedFiles
    ]).join("\n");
    if (query.length > MAX_QUERY_LENGTH) throw new CodeGraphRuntimeError("invalid-input", `The CodeGraph query exceeds ${MAX_QUERY_LENGTH} characters.`);
    await this.assertFreshSnapshot();
    const topK = Math.min(100, positiveInteger(options.topK, 12));
    const budget = Object.hasOwn(CONTEXT_NODES_BY_BUDGET, options.budget) ? options.budget : "balanced";
    const maxNodes = Math.max(topK, CONTEXT_NODES_BY_BUDGET[budget]);
    const result = await this.runner([
      "context", "--path", this.projectRoot, "--format", "json", "--max-nodes", String(maxNodes), "--no-code", "--", query
    ], { cwd: this.projectRoot });
    const normalized = normalizeContext(this.projectRoot, jsonFromCommand(result, "context"), {
      maxEntryPoints: topK,
      maxNodes,
      maxEdges: Math.min(800, maxNodes * 4)
    });
    this.graph = normalized;

    const hits = [];
    const hitsById = new Map();
    for (const node of normalized.entryPoints.slice(0, topK)) {
      addHit(hits, hitsById, {
        node,
        score: null,
        reasons: [...reasonsFor(node, normalizedHints), "provider-ranked-match", "lexical-match", "graph-expansion"]
      });
    }

    const explicitFiles = new Set([...normalizedHints.files, ...normalizedHints.expectedModifiedFiles]);
    const anchoredFiles = new Set(hits.filter(({ node }) => explicitFiles.has(node.file)).map(({ node }) => node.file));
    for (const node of normalized.nodes.values()) {
      if (!explicitFiles.has(node.file) || anchoredFiles.has(node.file)) continue;
      addHit(hits, hitsById, { node, score: null, reasons: reasonsFor(node, normalizedHints) });
      anchoredFiles.add(node.file);
    }

    const unresolvedRequired = [];
    const boundedSymbols = [];
    for (const file of normalizedHints.files) {
      if (!anchoredFiles.has(file)) unresolvedRequired.push({ kind: "file", value: file });
    }
    for (const file of normalizedHints.expectedModifiedFiles) {
      if (!anchoredFiles.has(file) && !unresolvedRequired.some((item) => item.kind === "file" && item.value === file)) {
        unresolvedRequired.push({ kind: "file", value: file });
      }
    }
    for (const symbol of normalizedHints.symbols) {
      const existing = [...normalized.nodes.values()].filter((node) => symbolIdentityMatches(node.qualifiedName || node.name, symbol));
      let matches = existing.slice(0, MAX_SYMBOL_HINT_MATCHES).map((node) => ({ node, score: null }));
      let matchesBounded = existing.length > MAX_SYMBOL_HINT_MATCHES
        || (existing.length === MAX_SYMBOL_HINT_MATCHES && !normalized.affirmativelyComplete);
      if (matches.length === 0) {
        const queryLimit = MAX_SYMBOL_HINT_MATCHES + 1;
        const queryResult = await this.runner([
          "query", "--path", this.projectRoot, "--limit", String(queryLimit), "--json", "--", symbol
        ], { cwd: this.projectRoot });
        const queryMatches = normalizeQueryResults(this.projectRoot, jsonFromCommand(queryResult, "query"), MAX_SYMBOL_HINT_MATCHES);
        matches = queryMatches.results
          .filter(({ node }) => symbolIdentityMatches(node.qualifiedName || node.name, symbol));
        matchesBounded = queryMatches.bounded;
      }
      if (matches.length === 0) {
        unresolvedRequired.push({ kind: "symbol", value: symbol });
        continue;
      }
      if (matchesBounded) boundedSymbols.push(symbol);
      for (const match of matches) {
        addHit(hits, hitsById, { node: match.node, score: match.score, reasons: ["explicit-design-reference", "lexical-match"] });
      }
    }

    await this.assertFreshSnapshot();
    const searchable = unique([...normalized.nodes.values(), ...hits.map(({ node }) => node)].map((node) => node.id))
      .map((id) => hits.find(({ node }) => node.id === id)?.node || normalized.nodes.get(id))
      .map((node) => [node.name, node.qualifiedName, node.signature, node.file].filter(Boolean).join(" ").toLowerCase())
      .join("\n");
    const unresolvedConcepts = normalizedHints.concepts.filter((concept) => !searchable.includes(concept.toLowerCase()));
    const diagnostics = [
      { code: "semantic_unavailable", message: "CodeGraph does not provide embedding retrieval for this context plan." },
      ...normalized.diagnostics
    ];
    for (const symbol of boundedSymbols) {
      diagnostics.push({ code: "symbol_matches_bounded", message: `CodeGraph bounded explicit matches for the symbol ${symbol}.` });
    }
    if (normalized.missingEdgeEndpoints) {
      diagnostics.push({ code: "graph_edges_bounded", message: `CodeGraph omitted ${normalized.missingEdgeEndpoints} graph edge endpoints from the bounded context.` });
    }
    return {
      hits,
      retrievalCoverage: null,
      unresolvedConcepts,
      unresolvedRequired,
      estimateEligible: unresolvedRequired.length === 0 && normalized.missingEdgeEndpoints === 0 && !normalized.bounded && boundedSymbols.length === 0,
      diagnostics,
      retrievalPlan: {
        engines: ["exact-symbol", "fts5", "symbol-graph"],
        fusion: "provider-rank",
        graphExpanded: true,
        budget
      }
    };
  }

  async neighbors(nodes, options = {}) {
    if (!this.graph) throw new CodeGraphRuntimeError("search-required", "CodeGraph search must run before graph expansion.");
    await this.assertFreshSnapshot();
    const maxNodes = Math.min(100, positiveInteger(options.maxNodes, 24));
    const relationships = Array.isArray(options.relationships) ? new Set(options.relationships.map(String)) : null;
    const neighbors = [];
    const seen = new Set();
    let neighborsBounded = false;
    for (const anchor of Array.isArray(nodes) ? nodes : []) {
      for (const edge of this.graph.edges) {
        const anchorIsSource = edge.source === anchor.id;
        const anchorIsTarget = edge.target === anchor.id;
        if (!anchorIsSource && !anchorIsTarget) continue;
        const neighbor = this.graph.nodes.get(anchorIsSource ? edge.target : edge.source);
        if (!neighbor || neighbor.id === anchor.id) continue;
        const relationship = relationshipFor(edge, anchorIsSource, neighbor);
        if (relationships && !relationships.has(relationship)) continue;
        const key = `${anchor.id}\0${neighbor.id}\0${relationship}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (neighbors.length >= maxNodes) {
          neighborsBounded = true;
          break;
        }
        neighbors.push({ node: neighbor, from: String(anchor.id), relationship, score: null });
      }
      if (neighborsBounded) break;
    }
    await this.assertFreshSnapshot();
    return {
      neighbors,
      graphCoverage: null,
      estimateEligible: this.graph.missingEdgeEndpoints === 0 && !this.graph.bounded && !neighborsBounded,
      diagnostics: [
        ...this.graph.diagnostics,
        ...(neighborsBounded
          ? [{ code: "graph_neighbor_limit", message: `CodeGraph graph expansion exceeded Prism's limit of ${maxNodes} neighbors.` }]
          : []),
        ...(this.graph.missingEdgeEndpoints
          ? [{ code: "graph_edges_bounded", message: `CodeGraph omitted ${this.graph.missingEdgeEndpoints} graph edge endpoints from the bounded context.` }]
          : [])
      ]
    };
  }

  async read(sourceRange) {
    if (!sourceRange || typeof sourceRange !== "object") throw new CodeGraphRuntimeError("invalid-input", "CodeGraph requires a source range.");
    const file = normalizeRelativePath(this.projectRoot, sourceRange.file);
    const range = sourceRange.range;
    if (!Number.isSafeInteger(range?.startLine) || range.startLine < 1 || !Number.isSafeInteger(range?.endLine) || range.endLine < range.startLine) {
      throw new CodeGraphRuntimeError("invalid-input", "CodeGraph requires a valid source range.");
    }
    await this.assertFreshSnapshot();
    const result = await this.sourceProvider.read({ file, range: { startLine: range.startLine, endLine: range.endLine } });
    await this.assertFreshSnapshot();
    return result;
  }
}

export async function openCodeGraphRepositoryIntelligence(projectRoot, sourceProvider, options = {}) {
  const runner = options.runner || createCodeGraphCommandRunner(options);
  const availability = await probeCodeGraphAvailability(projectRoot, { ...options, runner });
  if (availability.status !== "AVAILABLE") {
    throw new CodeGraphAvailabilityError(availability.code, availability.reason, {
      remediation: availability.remediation,
      details: availability.details
    });
  }
  return new CodeGraphRepositoryIntelligence({
    projectRoot: availability.projectRoot,
    sourceProvider,
    runner,
    availability
  });
}

export async function withCodeGraphRepositoryIntelligence(projectRoot, sourceProvider, action, options = {}) {
  if (typeof action !== "function") throw new TypeError("CodeGraph requires an adapter action.");
  const provider = await openCodeGraphRepositoryIntelligence(projectRoot, sourceProvider, options);
  return action(provider);
}
