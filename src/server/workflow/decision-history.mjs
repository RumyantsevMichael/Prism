import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, lstat, writeFile } from "node:fs/promises";
import { readCoordinationState } from "./state.mjs";
import path from "node:path";
import { readHostSessionFacts } from "../session/host-session-facts.mjs";
import { SESSION_TRACE_MAX_AGE_MS, SESSION_TRACE_MAX_DIRECTORY_BYTES } from "../session/session-trace-store.mjs";

const DIRECTORY = "decision-history";
const MAX_RECORD_BYTES = 8192;
const MAX_RECORDS = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KINDS = new Set(["context_plan", "repository_fit", "design_fit", "review", "pause"]);
const OUTCOMES = new Set(["FIT", "SPLIT", "BLOCKED", "UNCERTAIN", "UNSUPPORTED", "SUCCESS", "FAILURE", "CLEAN", "FINDINGS", "PAUSED"]);
const READABILITY = new Set(["readable", "difficult", "unreadable", "not_assessed"]);
const DECISION_KEYS = ["kind", "outcome", "reasonCodes", "evidencePaths", "counts", "estimate", "requestedProvider", "selectedProvider", "readability", "splitAssessment", "reviewPhase", "findingIds", "dispositions", "stateRevision", "recoveryDigest", "activeSlices", "agentLabel"];
const locks = new Map();

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
}

function assertKeys(value, allowed, name) {
  assertRecord(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name}.${key} is not allowed.`);
}

function codes(values, name) {
  if (!Array.isArray(values) || values.length > 32 || values.some((value) => typeof value !== "string" || !CODE.test(value))) {
    throw new Error(`${name} must contain at most 32 reason codes.`);
  }
  return [...new Set(values)];
}

function ids(values, name) {
  if (!Array.isArray(values) || values.length > 64 || values.some((value) => typeof value !== "string" || !ID.test(value))) {
    throw new Error(`${name} must contain at most 64 identifiers.`);
  }
  return [...new Set(values)];
}

function relativePaths(values) {
  if (!Array.isArray(values) || values.length > 16 || values.some((value) => (
    typeof value !== "string" || value.length > 240 || !value || path.isAbsolute(value)
    || value.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
  ))) throw new Error("evidencePaths must contain safe project-relative paths.");
  return [...new Set(values)];
}

function counts(value) {
  assertKeys(value, ["must", "likely", "possible", "elements", "links", "notes", "verifiedTokens"], "counts");
  for (const count of Object.values(value)) if (!Number.isSafeInteger(count) || count < 0) throw new Error("counts must be nonnegative integers.");
  return value;
}

function estimate(value) {
  assertKeys(value, ["lower", "expected", "upper"], "estimate");
  for (const count of Object.values(value)) if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error("estimate values must be nonnegative integers or null.");
  return value;
}

export function normalizeDecision(input, { allowHistoricalGap = false } = {}) {
  assertKeys(input, DECISION_KEYS, "decision");
  if (!KINDS.has(input.kind) || !OUTCOMES.has(input.outcome)) throw new Error("The decision kind or outcome is invalid.");
  const allowedOutcomes = {
    context_plan: ["SUCCESS", "FAILURE"], repository_fit: ["FIT", "SPLIT", "UNCERTAIN", "UNSUPPORTED"],
    design_fit: ["FIT", "SPLIT", "BLOCKED"], review: ["CLEAN", "FINDINGS"], pause: ["PAUSED"]
  };
  if (!allowedOutcomes[input.kind].includes(input.outcome)) throw new Error("The decision outcome does not match its kind.");
  const result = {
    kind: input.kind,
    outcome: input.outcome,
    reasonCodes: codes(input.reasonCodes || [], "reasonCodes"),
    evidencePaths: relativePaths(input.evidencePaths || [])
  };
  if (input.counts !== undefined) result.counts = counts(input.counts);
  if (input.estimate !== undefined) result.estimate = estimate(input.estimate);
  for (const key of ["requestedProvider", "selectedProvider"]) {
    if (input[key] !== undefined && input[key] !== null) {
      if (!["auto", "native", "codegraph", "codenib"].includes(input[key])) throw new Error(`${key} is invalid.`);
      result[key] = input[key];
    }
  }
  if (input.readability !== undefined) {
    if (!READABILITY.has(input.readability)) throw new Error("readability is invalid.");
    result.readability = input.readability;
  }
  if (input.splitAssessment !== undefined) {
    if (!new Set(["split", "keep", "undecided"]).has(input.splitAssessment)) throw new Error("splitAssessment is invalid.");
    result.splitAssessment = input.splitAssessment;
  }
  if (input.kind === "design_fit" && input.outcome === "FIT" && (!input.readability || (input.readability === "not_assessed" && !allowHistoricalGap))) {
    throw new Error("A FIT decision requires a diagram readability judgment.");
  }
  if (input.kind === "design_fit" && input.readability === "unreadable" && input.splitAssessment === undefined) {
    throw new Error("An unreadable diagram requires a split assessment.");
  }
  if (input.findingIds !== undefined) result.findingIds = ids(input.findingIds, "findingIds");
  if (input.reviewPhase !== undefined) {
    if (input.kind !== "review" || !["design_audit", "implementation_review", "security_review"].includes(input.reviewPhase)) throw new Error("reviewPhase is invalid.");
    result.reviewPhase = input.reviewPhase;
  }
  if (input.kind === "review" && input.reviewPhase === undefined) throw new Error("A review decision requires its phase.");
  if (input.dispositions !== undefined) result.dispositions = codes(input.dispositions, "dispositions");
  if (input.activeSlices !== undefined) result.activeSlices = ids(input.activeSlices, "activeSlices");
  if (input.stateRevision !== undefined) {
    if (typeof input.stateRevision !== "string" || !DIGEST.test(input.stateRevision)) throw new Error("stateRevision is invalid.");
    result.stateRevision = input.stateRevision;
  }
  if (input.recoveryDigest !== undefined) {
    if (input.kind !== "pause" || typeof input.recoveryDigest !== "string" || !DIGEST.test(input.recoveryDigest)) throw new Error("recoveryDigest is invalid.");
    result.recoveryDigest = input.recoveryDigest;
  }
  if (input.agentLabel !== undefined) {
    if (typeof input.agentLabel !== "string" || !ID.test(input.agentLabel)) throw new Error("agentLabel is invalid.");
    result.agentLabel = input.agentLabel;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RECORD_BYTES) throw new Error("The decision record is too large.");
  return result;
}

function validateStoredRecord(record, projectDigest) {
  assertKeys(record, ["schemaVersion", "id", "occurredAt", "projectDigest", "source", "actor", ...DECISION_KEYS], "storedDecision");
  if (record.schemaVersion !== 1 || typeof record.id !== "string" || !/^[a-f0-9-]{36}$/.test(record.id)
    || record.projectDigest !== projectDigest || !["mcp", "agent_checkpoint", "audit_reconstruction"].includes(record.source)
    || typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt))) {
    throw new Error("The stored decision record is invalid.");
  }
  assertKeys(record.actor, ["status", "sessionDigest", "reasonCode"], "storedDecision.actor");
  if (!(["verified_host_session", "unverified"].includes(record.actor.status))) throw new Error("The stored decision actor is invalid.");
  if (record.actor.status === "verified_host_session" && !DIGEST.test(record.actor.sessionDigest || "")) throw new Error("The stored decision session is invalid.");
  const decision = Object.fromEntries(DECISION_KEYS.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  normalizeDecision(decision, { allowHistoricalGap: record.source === "audit_reconstruction" });
  return record;
}

async function rootAndDirectory({ projectRoot, dataDirectory, create = false }) {
  if (!path.isAbsolute(projectRoot || "") || !path.isAbsolute(dataDirectory || "")) throw new Error("Absolute projectRoot and dataDirectory values are required.");
  const root = await realpath(projectRoot);
  if (create) await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(dataDirectory).catch((error) => {
    if (!create && error?.code === "ENOENT") return path.resolve(dataDirectory);
    throw error;
  });
  const directory = path.join(dataRoot, DIRECTORY);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory).catch((error) => {
    if (!create && error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { root, directory, projectDigest: digest(root) };
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("The decision directory is unsafe.");
  return { root, directory, projectDigest: digest(root) };
}

async function readJsonFile(file, fallback) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error("The decision file is unsafe.");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function withLock(directory, key, work) {
  const identity = `${directory}/${key}`;
  const previous = locks.get(identity) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  locks.set(identity, next);
  await previous;
  const lockPath = path.join(directory, `${key}.lock`);
  let handle;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const info = await lstat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) await rm(lockPath, { force: true });
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw new Error("The decision history is busy.");
    return await work();
  } finally {
    if (handle) {
      await handle.close();
      await rm(lockPath, { force: true });
    }
    release();
    if (locks.get(identity) === next) locks.delete(identity);
  }
}

async function enabled(directory, projectDigest) {
  const config = await readJsonFile(path.join(directory, `${projectDigest}.config.json`), { enabled: false });
  if (typeof config?.enabled !== "boolean") throw new Error("The decision setting is invalid.");
  return config.enabled;
}

export async function setDecisionRecording({ projectRoot, dataDirectory, enabled: value }) {
  if (typeof value !== "boolean") throw new Error("enabled must be a boolean.");
  const { directory, projectDigest } = await rootAndDirectory({ projectRoot, dataDirectory, create: true });
  await withLock(directory, projectDigest, () => atomicJson(path.join(directory, `${projectDigest}.config.json`), { enabled: value }));
  return { enabled: value, projectDigest };
}

async function attribution({ root, dataDirectory, correlationKey }) {
  if (!correlationKey) return { status: "unverified", reasonCode: "missing_correlation_key" };
  const facts = await readHostSessionFacts({ projectRoot: root, dataDirectory, correlationKey });
  return facts.status === "SUPPORTED"
    ? { status: "verified_host_session", sessionDigest: correlationKey }
    : { status: "unverified", reasonCode: String(facts.reasonCode || "unavailable").toLowerCase() };
}

async function prune(directory) {
  const entries = (await readdir(directory)).filter((name) => DIGEST.test(name.slice(0, 64)) && name.endsWith(".events.json"));
  const files = [];
  for (const name of entries) {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (Date.now() - info.mtimeMs > SESSION_TRACE_MAX_AGE_MS) await rm(file);
    else files.push({ file, size: info.size, mtime: info.mtimeMs });
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= SESSION_TRACE_MAX_DIRECTORY_BYTES) break;
    await rm(file.file);
    total -= file.size;
  }
}

export async function appendDecision({ projectRoot, dataDirectory, correlationKey, decision, source = "mcp", occurredAt }) {
  if (!["mcp", "agent_checkpoint", "audit_reconstruction"].includes(source)) throw new Error("The decision source is invalid.");
  if (occurredAt !== undefined && (source !== "audit_reconstruction" || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now())) {
    throw new Error("A historical occurrence time is valid only for audit reconstruction.");
  }
  const normalized = normalizeDecision(decision, { allowHistoricalGap: source === "audit_reconstruction" });
  const { root, directory, projectDigest } = await rootAndDirectory({ projectRoot, dataDirectory });
  if (!await enabled(directory, projectDigest)) return { status: "disabled" };
  const actor = await attribution({ root, dataDirectory, correlationKey });
  const record = { schemaVersion: 1, id: randomUUID(), occurredAt: occurredAt || new Date().toISOString(), projectDigest, source, actor, ...normalized };
  const file = path.join(directory, `${projectDigest}.events.json`);
  return withLock(directory, projectDigest, async () => {
    if (!await enabled(directory, projectDigest)) return { status: "disabled" };
    const current = await readJsonFile(file, { records: [] });
    if (!Array.isArray(current.records)) throw new Error("The decision history is invalid.");
    const records = [...current.records, record];
    let droppedCount = Number.isSafeInteger(current.droppedCount) && current.droppedCount >= 0 ? current.droppedCount : 0;
    while (records.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify({ records })) > MAX_FILE_BYTES) {
      records.shift();
      droppedCount += 1;
    }
    await atomicJson(file, { records, droppedCount });
    await prune(directory);
    return { status: "recorded", id: record.id, actor };
  });
}

export async function readDecisionHistory({ projectRoot, dataDirectory, correlationKey, statePath, recoveryPaths = [] }) {
  const { root, directory, projectDigest } = await rootAndDirectory({ projectRoot, dataDirectory });
  const isEnabled = await enabled(directory, projectDigest);
  const file = path.join(directory, `${projectDigest}.events.json`);
  const current = await readJsonFile(file, { records: [] });
  if (!Array.isArray(current.records)) throw new Error("The decision history is invalid.");
  if (current.droppedCount !== undefined && (!Number.isSafeInteger(current.droppedCount) || current.droppedCount < 0)) throw new Error("The decision history is invalid.");
  const cutoff = Date.now() - SESSION_TRACE_MAX_AGE_MS;
  const validated = current.records.map((item) => validateStoredRecord(item, projectDigest));
  const records = validated.filter((item) => Date.parse(item.occurredAt) >= cutoff)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const actor = await attribution({ root, dataDirectory, correlationKey });
  const coverageGaps = [];
  if (!isEnabled) coverageGaps.push("recording_disabled");
  if (current.droppedCount > 0) coverageGaps.push("record_limit_reached");
  if (records.length < validated.length) coverageGaps.push("retention_expired");
  if (correlationKey && actor.status !== "verified_host_session") coverageGaps.push("reader_identity_unverified");
  if (records.some((item) => item.actor.status !== "verified_host_session")) coverageGaps.push("unverified_execution");
  if (records.some((item) => item.agentLabel)) coverageGaps.push("subagent_attribution_unverified");
  if (records.some((item) => item.kind === "design_fit" && item.readability === "not_assessed")) coverageGaps.push("legacy_fit_readability_unobserved");
  let recovery = [];
  if (statePath !== undefined) {
    const state = await readCoordinationState({ projectRoot: root, statePath });
    if (!state.valid || !state.exists) throw new Error("The coordination state is missing or invalid.");
    recovery = await assessRecovery({ root, state, recoveryPaths: relativePaths(recoveryPaths), records });
  }
  return { enabled: isEnabled, projectDigest, records, coverageGaps: [...new Set(coverageGaps)], recovery };
}

async function assessRecovery({ root, state, recoveryPaths, records }) {
  const active = new Set(state.state.active.map((item) => item.slice));
  const stateDirectory = path.posix.dirname(state.statePath);
  const stateRecoveryPaths = state.state.evidence.filter((item) => item.endsWith("/recovery.md")).map((item) => {
    const absolute = path.isAbsolute(item) ? item : path.resolve(root, stateDirectory, item);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("A state recovery path leaves the project root.");
    return relative;
  });
  const paths = [...new Set([...recoveryPaths, ...stateRecoveryPaths])];
  const result = [];
  for (const recoveryPath of paths) {
    const owner = path.basename(path.dirname(recoveryPath));
    if (!active.has(owner)) {
      result.push({ recoveryPath, slice: owner, status: "historical" });
      continue;
    }
    const absolute = path.resolve(root, recoveryPath);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("The recovery path leaves the project root.");
    let content;
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("The recovery note is unsafe.");
      content = await readFile(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        result.push({ recoveryPath, slice: owner, status: "missing" });
        continue;
      }
      throw error;
    }
    const last = [...records].reverse().find((item) => item.kind === "pause" && item.evidencePaths.includes(recoveryPath));
    const status = !last?.recoveryDigest ? "unverified" : last.recoveryDigest === digest(content) ? "current" : "stale";
    result.push({ recoveryPath, slice: owner, status });
  }
  return result;
}
