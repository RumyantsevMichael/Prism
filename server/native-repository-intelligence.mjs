import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeRepositorySourcePath, normalizeRepositorySourceRange } from "./repository-source-path.mjs";

const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 5000;
const DEFAULT_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
export const NATIVE_SNAPSHOT_IDENTITY_SCHEME = "prism-native-sha256-v1";
const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".venv",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv"
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "change",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with"
]);

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedRepositoryPath(value) {
  try {
    return normalizeRepositorySourcePath(value);
  } catch {
    return null;
  }
}

function isContained(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function lineSegments(content) {
  if (content.length === 0) return [""];
  return content.match(/[^\n]*\n|[^\n]+$/g) || [""];
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactLexicalPattern(value, flags = "m") {
  const unicodeFlags = flags.includes("u") ? flags : `${flags}u`;
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapedRegex(value)}(?![\\p{L}\\p{N}_$])`, unicodeFlags);
}

function queryTokens(values) {
  const tokens = String(values).toLowerCase().match(/[\p{L}\p{N}_$-]+/gu) || [];
  return unique(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function countMatches(content, token) {
  const pattern = exactLexicalPattern(token, "gim");
  let count = 0;
  while (pattern.exec(content) && count < 20) count += 1;
  return count;
}

function nodeFor(file, name = file.file) {
  return {
    id: `native:file:${file.file}`,
    file: file.file,
    range: { startLine: 1, endLine: file.lineCount },
    kind: "file",
    name,
    rangeComplete: true
  };
}

function diagnostic(code, message, details) {
  return { code, message, ...(details ? { details } : {}) };
}

function commandFailure(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function runCommand(command, args, { cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(commandFailure("command_timeout", "Git source discovery timed out.")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(() => reject(commandFailure("command_output_limit", "Git source discovery exceeded its output limit.")));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", (error) => finish(() => reject(commandFailure("command_unavailable", "Git source discovery is unavailable.", error))));
    child.once("close", (code, signal) => finish(() => {
      if (code !== 0) {
        reject(commandFailure("command_failed", `Git source discovery failed with code ${code ?? "none"} and signal ${signal ?? "none"}.`));
        return;
      }
      resolve(Buffer.concat(stdout));
    }));
  });
}

async function gitFiles(root, options) {
  const output = await runCommand(
    options.gitCommand,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd: root, timeoutMs: options.gitTimeoutMs, maxOutputBytes: options.gitOutputBytes }
  );
  const rawPaths = output.toString("utf8").split("\0").filter(Boolean);
  const rejectedPaths = [];
  const normalizedGroups = new Map();
  for (const rawPath of rawPaths) {
    const normalized = normalizedRepositoryPath(rawPath);
    if (!normalized) {
      rejectedPaths.push(rawPath);
      continue;
    }
    const group = normalizedGroups.get(normalized) || [];
    group.push(rawPath);
    normalizedGroups.set(normalized, group);
  }
  const files = [];
  let aliasedPaths = 0;
  let collidingPaths = 0;
  for (const [normalized, group] of normalizedGroups) {
    if (group.length > 1) {
      collidingPaths += group.length;
      continue;
    }
    if (group[0] !== normalized) {
      aliasedPaths += 1;
      continue;
    }
    files.push(normalized);
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, rejectedPaths: rejectedPaths.length, aliasedPaths, collidingPaths };
}

async function gitCommit(root, options) {
  try {
    const output = await runCommand(
      options.gitCommand,
      ["rev-parse", "--verify", "HEAD"],
      { cwd: root, timeoutMs: options.gitTimeoutMs, maxOutputBytes: 1024 }
    );
    const commit = output.toString("utf8").trim();
    return /^[a-f0-9]{40,64}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

async function filesystemFiles(root, maxFiles) {
  const files = [];
  let skippedSymlinks = 0;
  let unreadableDirectories = 0;
  let truncated = false;
  const visit = async (directory, relativeDirectory = "") => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        if (!FALLBACK_EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visit(path.join(directory, entry.name), relativePath);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  await visit(root);
  return { files, skippedSymlinks, unreadableDirectories, truncated };
}

async function enumerateFiles(root, options) {
  try {
    return { ...(await gitFiles(root, options)), enumerator: "git", diagnostics: [], skippedSymlinks: 0 };
  } catch {
    const fallback = await filesystemFiles(root, options.maxFiles);
    return {
      ...fallback,
      enumerator: "filesystem",
      rejectedPaths: 0,
      aliasedPaths: 0,
      collidingPaths: 0,
      diagnostics: [diagnostic("git_unavailable", "Git file discovery was unavailable, so Prism used its bounded filesystem scanner.")]
    };
  }
}

async function sourceRecord(root, relativePath, limits) {
  const normalized = normalizedRepositoryPath(relativePath);
  if (!normalized) return { status: "unsafe" };
  const absolutePath = path.resolve(root, ...normalized.split("/"));
  if (!isContained(root, absolutePath)) return { status: "unsafe" };
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch {
    return { status: "unreadable" };
  }
  if (metadata.isSymbolicLink()) return { status: "symlink" };
  if (!metadata.isFile()) return { status: "not-file" };
  if (metadata.size > limits.maxFileBytes) return { status: "oversized" };
  let canonicalPath;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    return { status: "unreadable" };
  }
  if (!isContained(root, canonicalPath)) return { status: "unsafe" };
  let buffer;
  try {
    buffer = await readFile(canonicalPath);
  } catch {
    return { status: "unreadable" };
  }
  if (isBinary(buffer)) return { status: "binary" };
  const content = decodeUtf8(buffer);
  if (content === null) return { status: "binary" };
  return {
    status: "source",
    file: {
      file: normalized,
      absolutePath: canonicalPath,
      bytes: buffer.length,
      content,
      hash: sha256(buffer),
      lineCount: lineSegments(content).length,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    }
  };
}

async function buildSnapshot(projectRoot, options) {
  const root = await realpath(projectRoot);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) throw new TypeError("The native repository root must be a directory.");
  const enumeration = await enumerateFiles(root, options);
  const diagnostics = [...enumeration.diagnostics];
  const counters = {
    binary: 0,
    notFile: 0,
    oversized: 0,
    symlink: enumeration.skippedSymlinks,
    unreadable: 0,
    unsafe: 0
  };
  let complete = enumeration.truncated !== true
    && !enumeration.unreadableDirectories
    && enumeration.rejectedPaths === 0
    && enumeration.aliasedPaths === 0
    && enumeration.collidingPaths === 0;
  let candidates = enumeration.files;
  if (candidates.length > options.maxFiles) {
    candidates = candidates.slice(0, options.maxFiles);
    complete = false;
  }
  const files = [];
  let totalBytes = 0;
  for (const relativePath of candidates) {
    const record = await sourceRecord(root, relativePath, options);
    if (record.status !== "source") {
      if (record.status === "not-file") counters.notFile += 1;
      else if (Object.hasOwn(counters, record.status)) counters[record.status] += 1;
      if (["not-file", "oversized", "symlink", "unreadable", "unsafe"].includes(record.status)) complete = false;
      continue;
    }
    if (totalBytes + record.file.bytes > options.maxBytes) {
      complete = false;
      break;
    }
    files.push(record.file);
    totalBytes += record.file.bytes;
  }
  if (counters.symlink) diagnostics.push(diagnostic("symlink_skipped", "The native scanner skipped symbolic links.", { count: counters.symlink }));
  if (counters.binary) diagnostics.push(diagnostic("binary_skipped", "The native scanner skipped binary or non-UTF-8 files.", { count: counters.binary }));
  if (counters.notFile) diagnostics.push(diagnostic("non_file_skipped", "The native scanner skipped an enumerated path that was not a regular file.", { count: counters.notFile }));
  if (counters.oversized) diagnostics.push(diagnostic("oversized_file_skipped", "The native scanner skipped files above its per-file limit.", { count: counters.oversized }));
  if (counters.unreadable) diagnostics.push(diagnostic("unreadable_file_skipped", "The native scanner skipped unreadable files.", { count: counters.unreadable }));
  if (counters.unsafe) diagnostics.push(diagnostic("unsafe_path_skipped", "The native scanner skipped paths outside the repository root.", { count: counters.unsafe }));
  if (enumeration.rejectedPaths) diagnostics.push(diagnostic("portable_path_rejected", "The native scanner rejected Git paths outside its portable path domain.", { count: enumeration.rejectedPaths }));
  if (enumeration.aliasedPaths) diagnostics.push(diagnostic("portable_path_aliased", "The native scanner rejected Git paths whose portable form changes their identity.", { count: enumeration.aliasedPaths }));
  if (enumeration.collidingPaths) diagnostics.push(diagnostic("portable_path_collision", "The native scanner rejected Git paths that collide in its portable path domain.", { count: enumeration.collidingPaths }));
  if (enumeration.unreadableDirectories) diagnostics.push(diagnostic("unreadable_directory_skipped", "The native scanner skipped unreadable directories.", { count: enumeration.unreadableDirectories }));
  if (!complete) diagnostics.push(diagnostic("scan_incomplete", "The native source scan is incomplete, so its context estimate is not fit-eligible."));
  const fingerprintHash = createHash("sha256");
  for (const file of files) {
    fingerprintHash.update(file.file);
    fingerprintHash.update("\0");
    fingerprintHash.update(file.hash);
    fingerprintHash.update("\0");
  }
  const sourceFingerprint = fingerprintHash.digest("hex");
  const head = enumeration.enumerator === "git" ? await gitCommit(root, options) : null;
  return {
    root,
    commit: head || `snapshot:${sourceFingerprint}`,
    sourceFingerprint,
    files,
    filesByPath: new Map(files.map((file) => [file.file, file])),
    complete,
    totalBytes,
    enumerator: enumeration.enumerator,
    diagnostics
  };
}

function scoreFile(file, tokens, task) {
  const lowerPath = file.file.toLowerCase();
  const lowerContent = file.content.toLowerCase();
  const basename = path.posix.basename(lowerPath).replace(/\.[^.]+$/, "");
  let score = 0;
  for (const token of tokens) {
    if (basename === token) score += 20;
    else if (lowerPath.includes(token)) score += 6;
    score += countMatches(lowerContent, token);
  }
  const phrase = task.trim().toLowerCase();
  if (phrase.length > 3 && lowerContent.includes(phrase)) score += 12;
  return score;
}

function hintValues(hints, name) {
  return unique(Array.isArray(hints?.[name]) ? hints[name].map(String).filter(Boolean) : []);
}

export class NativeRepositoryIntelligence {
  constructor(projectRoot, options = {}) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      throw new TypeError("The native repository root must be an absolute path.");
    }
    this.projectRoot = projectRoot;
    this.options = {
      gitCommand: options.gitCommand || "git",
      gitTimeoutMs: positiveInteger(options.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, "gitTimeoutMs"),
      gitOutputBytes: positiveInteger(options.gitOutputBytes, DEFAULT_GIT_OUTPUT_BYTES, "gitOutputBytes"),
      maxFiles: positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
      maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
      maxFileBytes: positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes")
    };
    this.snapshotPromise = null;
  }

  snapshot() {
    if (!this.snapshotPromise) {
      this.snapshotPromise = buildSnapshot(this.projectRoot, this.options).catch((error) => {
        this.snapshotPromise = null;
        throw error;
      });
    }
    return this.snapshotPromise;
  }

  async describe() {
    const snapshot = await this.snapshot();
    return {
      name: "native",
      commit: snapshot.commit,
      sourceFingerprint: snapshot.sourceFingerprint,
      snapshotIdentity: {
        scheme: NATIVE_SNAPSHOT_IDENTITY_SCHEME,
        commit: snapshot.commit,
        fingerprint: snapshot.sourceFingerprint
      },
      capabilities: {
        lexicalSearch: true,
        semanticSearch: false,
        hybridSearch: false,
        symbolGraph: false,
        verifiedSource: true
      }
    };
  }

  async search(task, hints = {}, options = {}) {
    if (typeof task !== "string" || !task.trim()) throw new TypeError("The native search task must be a non-empty string.");
    const snapshot = await this.snapshot();
    const topK = Math.min(MAX_SEARCH_RESULTS, positiveInteger(options.topK, 12, "topK"));
    const requiredReasons = new Map();
    const requiredNames = new Map();
    const unresolvedRequired = [];
    const diagnostics = [...snapshot.diagnostics];
    const addRequired = (file, reason, name) => {
      const reasons = requiredReasons.get(file.file) || new Set();
      reasons.add(reason);
      requiredReasons.set(file.file, reasons);
      if (name && !requiredNames.has(file.file)) requiredNames.set(file.file, name);
    };
    for (const fileHint of hintValues(hints, "files")) {
      const normalized = normalizedRepositoryPath(fileHint);
      const file = normalized ? snapshot.filesByPath.get(normalized) : null;
      if (file) addRequired(file, "explicit-design-reference");
      else unresolvedRequired.push({ kind: "file", value: fileHint });
    }
    for (const fileHint of hintValues(hints, "expectedModifiedFiles")) {
      const normalized = normalizedRepositoryPath(fileHint);
      const file = normalized ? snapshot.filesByPath.get(normalized) : null;
      if (file) addRequired(file, "expected-modification-target");
      else unresolvedRequired.push({ kind: "file", value: fileHint });
    }
    if (requiredReasons.size > topK) {
      throw new RangeError(`The ${requiredReasons.size} explicit file hints exceed the native result bound of ${topK}.`);
    }
    let requiredEvidenceComplete = true;
    for (const symbol of hintValues(hints, "symbols")) {
      const matches = snapshot.files.filter((file) => exactLexicalPattern(symbol).test(file.content));
      if (matches.length === 0) {
        unresolvedRequired.push({ kind: "symbol", value: symbol });
        diagnostics.push(diagnostic("explicit_symbol_unresolved", `The native provider could not resolve the explicit symbol ${symbol}.`));
      } else {
        const available = Math.max(0, topK - requiredReasons.size);
        const newMatches = matches.filter((file) => !requiredReasons.has(file.file));
        for (const file of newMatches.slice(0, available)) addRequired(file, "explicit-design-reference", symbol);
        for (const file of matches.filter((file) => requiredReasons.has(file.file))) addRequired(file, "explicit-design-reference", symbol);
        if (newMatches.length > available) {
          requiredEvidenceComplete = false;
          diagnostics.push(diagnostic("explicit_symbol_matches_truncated", `The native provider bounded matches for the explicit symbol ${symbol}.`, {
            symbol,
            included: available,
            omitted: newMatches.length - available
          }));
        }
      }
    }
    if (!snapshot.complete) unresolvedRequired.push({ kind: "repository-scan", value: "incomplete" });
    const concepts = hintValues(hints, "concepts");
    const tokens = queryTokens([task, ...concepts].join(" "));
    const scored = snapshot.files.map((file) => ({ file, score: scoreFile(file, tokens, task) }));
    scored.sort((left, right) => right.score - left.score || left.file.file.localeCompare(right.file.file));
    const requiredHits = [...requiredReasons.entries()].map(([filePath, reasons]) => {
      const file = snapshot.filesByPath.get(filePath);
      const score = scored.find((item) => item.file.file === filePath)?.score || 0;
      return {
        node: nodeFor(file, requiredNames.get(filePath)),
        score: 1000000 + score,
        reasons: unique([...reasons, ...(score > 0 ? ["lexical-match"] : [])])
      };
    });
    requiredHits.sort((left, right) => right.score - left.score || left.node.file.localeCompare(right.node.file));
    const rankedHits = scored
      .filter(({ file, score }) => score > 0 && !requiredReasons.has(file.file))
      .slice(0, Math.max(0, topK - requiredHits.length))
      .map(({ file, score }) => ({ node: nodeFor(file), score, reasons: ["provider-ranked-match", "lexical-match"] }));
    const unresolvedConcepts = concepts.filter((concept) => {
      const lower = concept.toLowerCase();
      return !snapshot.files.some((file) => file.file.toLowerCase().includes(lower) || file.content.toLowerCase().includes(lower));
    });
    diagnostics.push(diagnostic("semantic_unavailable", "The native provider supplies lexical retrieval without semantic search."));
    return {
      hits: [...requiredHits, ...rankedHits],
      retrievalCoverage: snapshot.complete ? 1 : null,
      unresolvedConcepts,
      unresolvedRequired,
      requiredEvidenceComplete,
      estimateEligible: false,
      diagnostics,
      retrievalPlan: {
        engines: ["native-lexical"],
        fusion: null,
        graphExpanded: false,
        budget: options.budget || "balanced",
        corpus: {
          enumerator: snapshot.enumerator,
          files: snapshot.files.length,
          bytes: snapshot.totalBytes,
          complete: snapshot.complete
        }
      }
    };
  }

  async neighbors() {
    return {
      neighbors: [],
      graphCoverage: 0,
      estimateEligible: false,
      diagnostics: [diagnostic("structural_unavailable", "The native provider does not supply structural graph expansion.")]
    };
  }

  async read(sourceRange) {
    const snapshot = await this.snapshot();
    const validated = await this.validateSourceRange(sourceRange);
    const normalized = validated.file;
    const file = normalized ? snapshot.filesByPath.get(normalized) : null;
    if (!file) throw new Error("The requested path is not part of the native repository snapshot.");
    const startLine = validated.range.startLine;
    const requestedEndLine = validated.range.endLine;
    let metadata;
    let canonicalPath;
    let buffer;
    try {
      metadata = await lstat(file.absolutePath);
      canonicalPath = await realpath(file.absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || !isContained(snapshot.root, canonicalPath)) throw new Error("unsafe");
      buffer = await readFile(canonicalPath);
    } catch (error) {
      throw new Error(`Source ${file.file} changed after the native snapshot was created.`, { cause: error });
    }
    if (sha256(buffer) !== file.hash) {
      throw new Error(`Source ${file.file} changed after the native snapshot was created.`);
    }
    const segments = lineSegments(file.content);
    if (startLine > segments.length) throw new RangeError(`The requested range starts after the end of ${file.file}.`);
    const endLine = Math.min(requestedEndLine, segments.length);
    const content = segments.slice(startLine - 1, endLine).join("");
    return {
      content,
      rendered: content,
      range: { startLine, endLine },
      rangeComplete: endLine >= requestedEndLine
    };
  }

  async validateSourceRange(sourceRange) {
    const snapshot = await this.snapshot();
    const validated = normalizeRepositorySourceRange(sourceRange, { projectRoot: snapshot.root });
    if (!snapshot.filesByPath.has(validated.file)) {
      throw new Error("The requested path is not part of the native repository snapshot.");
    }
    return validated;
  }

  async verifySnapshot(options = {}) {
    const snapshot = await this.snapshot();
    if (options.requireComplete === true && !snapshot.complete) {
      const error = new Error("The native source snapshot is incomplete.");
      error.code = "snapshot-changed";
      throw error;
    }
    const current = await buildSnapshot(this.projectRoot, this.options);
    if (current.complete !== snapshot.complete || current.commit !== snapshot.commit || current.sourceFingerprint !== snapshot.sourceFingerprint) {
      const error = new Error("The native source snapshot changed.");
      error.code = "snapshot-changed";
      throw error;
    }
    return {
      snapshotIdentity: {
        scheme: NATIVE_SNAPSHOT_IDENTITY_SCHEME,
        commit: snapshot.commit,
        fingerprint: snapshot.sourceFingerprint
      }
    };
  }
}

export async function openNativeRepositoryIntelligence(projectRoot, options = {}) {
  const root = await realpath(projectRoot);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new TypeError("The native repository root must be a directory.");
  return new NativeRepositoryIntelligence(root, options);
}

export async function withNativeRepositoryIntelligence(projectRoot, action, options = {}) {
  if (typeof action !== "function") throw new TypeError("The native repository action must be a function.");
  const provider = await openNativeRepositoryIntelligence(projectRoot, options);
  return action(provider);
}
