import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";
import { createPrivateSessionStore, defaultIsProcessAlive } from "./private-session-store.mjs";

const SCHEMA_VERSION = 1;
const FACT_DIRECTORY = "session-capacity";
const MAX_FACT_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
export const HOST_FACT_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
export const HOST_FACT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const HOST_VALUE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:/@\[\]-]{0,255}$/;

export const HOST_FACT_REASON = Object.freeze({
  NO_DATA_DIRECTORY: "NO_DATA_DIRECTORY",
  NO_SESSION_ID: "NO_SESSION_ID",
  NO_CORRELATION_KEY: "NO_CORRELATION_KEY",
  INVALID_CORRELATION_KEY: "INVALID_CORRELATION_KEY",
  NO_PROJECT_ROOT: "NO_PROJECT_ROOT",
  INVALID_PROJECT_ROOT: "INVALID_PROJECT_ROOT",
  NO_SESSION_FACTS: "NO_SESSION_FACTS",
  INVALID_SESSION_FACTS: "INVALID_SESSION_FACTS",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  STALE_SESSION_FACTS: "STALE_SESSION_FACTS",
  FACTS_UNAVAILABLE: "FACTS_UNAVAILABLE",
  MISSING_HOST_VERSION: "MISSING_HOST_VERSION",
  INVALID_HOST_VERSION: "INVALID_HOST_VERSION",
  MISSING_MODEL: "MISSING_MODEL",
  INVALID_MODEL: "INVALID_MODEL",
  MISSING_PROVIDER: "MISSING_PROVIDER",
  HOST_METADATA_UNAVAILABLE: "HOST_METADATA_UNAVAILABLE",
  UNSUPPORTED_EXECUTION: "UNSUPPORTED_EXECUTION",
  HOST_CAPACITY_UNAVAILABLE: "HOST_CAPACITY_UNAVAILABLE",
  INVALID_EFFECTIVE_SETTINGS: "INVALID_EFFECTIVE_SETTINGS",
  EFFECTIVE_SETTINGS_UNAVAILABLE: "EFFECTIVE_SETTINGS_UNAVAILABLE",
  UNSUPPORTED_COMPACTION_SCOPE: "UNSUPPORTED_COMPACTION_SCOPE"
});

const REASON_MESSAGES = Object.freeze({
  [HOST_FACT_REASON.NO_DATA_DIRECTORY]: "The plugin data directory is unavailable.",
  [HOST_FACT_REASON.NO_SESSION_ID]: "The active host session identifier is unavailable.",
  [HOST_FACT_REASON.NO_CORRELATION_KEY]: "The active host session correlation key is unavailable.",
  [HOST_FACT_REASON.INVALID_CORRELATION_KEY]: "The active host session correlation key is invalid.",
  [HOST_FACT_REASON.NO_PROJECT_ROOT]: "The active project root is unavailable.",
  [HOST_FACT_REASON.INVALID_PROJECT_ROOT]: "The active project root is invalid.",
  [HOST_FACT_REASON.NO_SESSION_FACTS]: "No facts exist for the active host session.",
  [HOST_FACT_REASON.INVALID_SESSION_FACTS]: "The active host session facts are invalid.",
  [HOST_FACT_REASON.SESSION_MISMATCH]: "The stored facts belong to another host session.",
  [HOST_FACT_REASON.PROJECT_MISMATCH]: "The stored facts belong to another project root.",
  [HOST_FACT_REASON.STALE_SESSION_FACTS]: "The active host session facts are stale.",
  [HOST_FACT_REASON.FACTS_UNAVAILABLE]: "The active host session facts cannot be read.",
  [HOST_FACT_REASON.MISSING_HOST_VERSION]: "The active host version is unavailable.",
  [HOST_FACT_REASON.INVALID_HOST_VERSION]: "The active host version is invalid.",
  [HOST_FACT_REASON.MISSING_MODEL]: "The active model is unavailable.",
  [HOST_FACT_REASON.INVALID_MODEL]: "The active model identifier is invalid.",
  [HOST_FACT_REASON.MISSING_PROVIDER]: "The active model provider is unavailable.",
  [HOST_FACT_REASON.HOST_METADATA_UNAVAILABLE]: "The active host session metadata is unavailable or cannot be correlated.",
  [HOST_FACT_REASON.UNSUPPORTED_EXECUTION]: "The active host execution kind is unsupported.",
  [HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE]: "The active host did not attest complete capacity and compaction scope.",
  [HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS]: "The effective capacity settings are invalid.",
  [HOST_FACT_REASON.EFFECTIVE_SETTINGS_UNAVAILABLE]: "The effective capacity settings are unavailable.",
  [HOST_FACT_REASON.UNSUPPORTED_COMPACTION_SCOPE]: "The active compaction accounting scope is unsupported."
});

const PERSISTED_KEYS = [
  "schemaVersion",
  "status",
  "reasonCode",
  "sessionDigest",
  "projectDigest",
  "observedAt",
  "host",
  "capacityOverrides",
  "compactionScope",
  "sources"
];
const HOST_KEYS = ["harness", "harnessVersion", "provider", "model"];
const CAPACITY_KEYS = ["contextWindowTokens", "compactionThresholdTokens"];
const SOURCE_KEYS = [
  "harness",
  "harnessVersion",
  "provider",
  "model",
  "contextWindowTokens",
  "compactionThresholdTokens",
  "compactionScope"
];
const SOURCE_VALUES = Object.freeze({
  harness: new Set(["codex-adapter", "claude-code-adapter"]),
  harnessVersion: new Set(["transcript.session_meta.cli_version", "transcript.version", null]),
  provider: new Set(["transcript.session_meta.model_provider", "environment.claude_code_provider", null]),
  model: new Set(["hook.model", "transcript.message.model", null]),
  contextWindowTokens: new Set([
    "hook.model_context_window",
    "transcript.event_msg.token_count.info.model_context_window",
    "estimate.claude_code.context_window",
    null
  ]),
  compactionThresholdTokens: new Set([
    "hook.model_auto_compact_token_limit",
    "config.model_auto_compact_token_limit",
    "config.absent.model_auto_compact_token_limit",
    "registry.derived.model_auto_compact_token_limit",
    "estimate.claude_code.auto_compact_threshold",
    null
  ]),
  compactionScope: new Set([
    "hook.model_auto_compact_token_limit_scope",
    "config.model_auto_compact_token_limit_scope",
    "config.default.model_auto_compact_token_limit_scope",
    "claude_code.total_input_tokens",
    null
  ])
});
const HARNESS_ADAPTERS = Object.freeze({
  "codex-cli": "codex-adapter",
  "claude-code": "claude-code-adapter"
});
const REASON_CODES = new Set(Object.values(HOST_FACT_REASON));

const factStore = createPrivateSessionStore({
  directoryName: FACT_DIRECTORY,
  subject: "host-session fact",
  unsafePathCode: "UNSAFE_HOST_FACT_PATH",
  maxLockOwnerBytes: 128,
  lockProtocol: "staged"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, required, name) {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${name} contains an unknown property: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${name}.${key} is required.`);
    }
  }
}

function assertNullableHostValue(value, name, pattern) {
  if (value !== null && (typeof value !== "string" || !pattern.test(value))) {
    throw new Error(`${name} is invalid.`);
  }
}

function assertTokenCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function assertIsoDate(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be an ISO date string.`);
  }
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${name} must be a SHA-256 digest.`);
  }
}

function normalizedIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function projectIdentity(value) {
  const normalized = normalizedIdentifier(value);
  if (!normalized || !path.isAbsolute(normalized)) {
    return null;
  }
  return path.normalize(normalized);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createSessionCorrelationKey(sessionId) {
  const normalized = normalizedIdentifier(sessionId);
  if (!normalized) {
    throw new Error(REASON_MESSAGES[HOST_FACT_REASON.NO_SESSION_ID]);
  }
  return digest(normalized);
}

function factPath(directory, sessionDigest) {
  return path.join(directory, `${sessionDigest}.json`);
}

async function readStoredFactRecord(target, directory, fileSystem) {
  const opened = await factStore.openExistingRegularFile(target, directory, fileSystem, { missing: true });
  if (!opened) return null;
  try {
    if (opened.metadata.size > MAX_FACT_BYTES) {
      throw new Error("The stored host-session fact record is too large.");
    }
    let record;
    try {
      record = JSON.parse(await opened.handle.readFile("utf8"));
      validateHostSessionFacts(record);
    } catch {
      throw new Error("The stored host-session fact record is invalid.");
    }
    if (factPath(directory, record.sessionDigest) !== target) {
      throw new Error("The stored host-session fact record has an invalid session identity.");
    }
    return { record, metadata: opened.metadata };
  } finally {
    await opened.handle.close();
  }
}

function materialFactText(record) {
  const capacityOverrides = {};
  for (const key of CAPACITY_KEYS) {
    if (Object.hasOwn(record.capacityOverrides, key)) {
      capacityOverrides[key] = record.capacityOverrides[key];
    }
  }
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    status: record.status,
    reasonCode: record.reasonCode,
    sessionDigest: record.sessionDigest,
    projectDigest: record.projectDigest,
    host: Object.fromEntries(HOST_KEYS.map((key) => [key, record.host[key]])),
    capacityOverrides,
    compactionScope: record.compactionScope,
    sources: Object.fromEntries(SOURCE_KEYS.map((key) => [key, record.sources[key]]))
  });
}

function positiveSafeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function storedFactFiles(directory, target, fileSystem, assertOwnership) {
  const facts = [];
  for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && /^[a-f0-9]{64}\.json\..+\.tmp$/.test(entry.name)) {
      try {
        await factStore.inspectRegularFile(entryPath, directory, fileSystem);
        await assertOwnership();
        await fileSystem.unlink(entryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name) || entryPath === target) {
      continue;
    }
    try {
      const metadata = await factStore.inspectRegularFile(entryPath, directory, fileSystem);
      facts.push({
        name: entry.name,
        path: entryPath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return facts;
}

async function enforceFactDirectoryLimits({
  directory,
  target,
  candidateBytes,
  existingTargetBytes,
  maxDirectoryBytes,
  maxFactAgeMs,
  now,
  fileSystem,
  assertOwnership
}) {
  const observedNow = clockMilliseconds(now);
  const nowMs = Number.isFinite(observedNow) ? observedNow : Date.now();
  const cutoff = nowMs - maxFactAgeMs;
  const retained = [];
  for (const record of await storedFactFiles(directory, target, fileSystem, assertOwnership)) {
    if (record.mtimeMs < cutoff) {
      await assertOwnership();
      await fileSystem.unlink(record.path);
    } else {
      retained.push(record);
    }
  }
  if (candidateBytes + existingTargetBytes > maxDirectoryBytes) {
    return false;
  }
  retained.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  let aggregateBytes = candidateBytes + existingTargetBytes + retained.reduce((total, record) => total + record.size, 0);
  for (const record of retained) {
    if (aggregateBytes <= maxDirectoryBytes) break;
    await assertOwnership();
    await fileSystem.unlink(record.path);
    aggregateBytes -= record.size;
  }
  return aggregateBytes <= maxDirectoryBytes;
}

function unsupported(reasonCode, extra = {}) {
  if (!REASON_CODES.has(reasonCode)) {
    throw new Error(`Unknown host-fact reason code: ${reasonCode}.`);
  }
  return {
    status: "UNSUPPORTED",
    reasonCode,
    reason: REASON_MESSAGES[reasonCode],
    ...extra
  };
}

export function unsupportedHostSessionFacts(reasonCode, extra = {}) {
  return unsupported(reasonCode, extra);
}

export function validateHostSessionFacts(record) {
  assertExactKeys(record, PERSISTED_KEYS, PERSISTED_KEYS, "hostSessionFacts");
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported host-session fact schema version: ${record.schemaVersion}.`);
  }
  if (record.status !== "SUPPORTED" && record.status !== "UNSUPPORTED") {
    throw new Error("hostSessionFacts.status is invalid.");
  }
  if (record.reasonCode !== null && !REASON_CODES.has(record.reasonCode)) {
    throw new Error("hostSessionFacts.reasonCode is invalid.");
  }
  if (record.status === "SUPPORTED" && record.reasonCode !== null) {
    throw new Error("Supported host-session facts cannot contain a reason code.");
  }
  if (record.status === "UNSUPPORTED" && record.reasonCode === null) {
    throw new Error("Unsupported host-session facts require a reason code.");
  }

  assertDigest(record.sessionDigest, "hostSessionFacts.sessionDigest");
  assertDigest(record.projectDigest, "hostSessionFacts.projectDigest");
  assertIsoDate(record.observedAt, "hostSessionFacts.observedAt");

  assertExactKeys(record.host, HOST_KEYS, HOST_KEYS, "hostSessionFacts.host");
  if (!Object.hasOwn(HARNESS_ADAPTERS, record.host.harness)) {
    throw new Error("hostSessionFacts.host.harness is invalid.");
  }
  assertNullableHostValue(record.host.harnessVersion, "hostSessionFacts.host.harnessVersion", VERSION_PATTERN);
  assertNullableHostValue(record.host.provider, "hostSessionFacts.host.provider", HOST_VALUE_PATTERN);
  assertNullableHostValue(record.host.model, "hostSessionFacts.host.model", HOST_VALUE_PATTERN);

  assertExactKeys(record.capacityOverrides, CAPACITY_KEYS, [], "hostSessionFacts.capacityOverrides");
  for (const key of CAPACITY_KEYS) {
    if (Object.hasOwn(record.capacityOverrides, key)) {
      assertTokenCount(record.capacityOverrides[key], `hostSessionFacts.capacityOverrides.${key}`);
    }
  }
  if (
    Object.hasOwn(record.capacityOverrides, "contextWindowTokens")
    && Object.hasOwn(record.capacityOverrides, "compactionThresholdTokens")
    && record.capacityOverrides.compactionThresholdTokens > record.capacityOverrides.contextWindowTokens
  ) {
    throw new Error("The compaction threshold cannot exceed the context window.");
  }

  if (!["total", "body_after_prefix", null].includes(record.compactionScope)) {
    throw new Error("hostSessionFacts.compactionScope is invalid.");
  }

  assertExactKeys(record.sources, SOURCE_KEYS, SOURCE_KEYS, "hostSessionFacts.sources");
  for (const key of SOURCE_KEYS) {
    if (!SOURCE_VALUES[key].has(record.sources[key])) {
      throw new Error(`hostSessionFacts.sources.${key} is invalid.`);
    }
  }
  if (record.sources.harness !== HARNESS_ADAPTERS[record.host.harness]) {
    throw new Error("hostSessionFacts.sources.harness does not match the host harness.");
  }
  for (const key of ["harnessVersion", "provider", "model"]) {
    if ((record.host[key] === null) !== (record.sources[key] === null)) {
      throw new Error(`hostSessionFacts.${key} value and source must be present together.`);
    }
  }
  for (const key of CAPACITY_KEYS) {
    const absentThresholdProof = key === "compactionThresholdTokens"
      && record.sources[key] === "config.absent.model_auto_compact_token_limit";
    if (absentThresholdProof && Object.hasOwn(record.capacityOverrides, key)) {
      throw new Error("An absent threshold proof cannot accompany a threshold value.");
    }
    if (Object.hasOwn(record.capacityOverrides, key) !== (record.sources[key] !== null) && !absentThresholdProof) {
      throw new Error(`hostSessionFacts.${key} value and source must be present together.`);
    }
  }
  if ((record.compactionScope === null) !== (record.sources.compactionScope === null)) {
    throw new Error("hostSessionFacts.compactionScope value and source must be present together.");
  }

  if (record.status === "SUPPORTED") {
    for (const key of ["harnessVersion", "provider", "model"]) {
      if (record.host[key] === null) {
        throw new Error(`Supported host-session facts require host.${key}.`);
      }
    }
    if (record.compactionScope !== "total") {
      throw new Error("Supported host-session facts require total compaction accounting.");
    }
    if (!Object.hasOwn(record.capacityOverrides, "contextWindowTokens")) {
      throw new Error("Supported host-session facts require capacityOverrides.contextWindowTokens.");
    }
    const hasThreshold = Object.hasOwn(record.capacityOverrides, "compactionThresholdTokens");
    const provesDefaultThreshold = record.sources.compactionThresholdTokens
      === "config.absent.model_auto_compact_token_limit";
    if (!hasThreshold && !provesDefaultThreshold) {
      throw new Error("Supported host-session facts require a threshold or proof that its override is absent.");
    }
  }
  return true;
}

export function createHostSessionFactRecord({
  sessionId,
  projectRoot,
  observedAt,
  status,
  reasonCode = null,
  host,
  capacityOverrides = {},
  compactionScope = null,
  sources
}) {
  const normalizedSessionId = normalizedIdentifier(sessionId);
  const normalizedProjectRoot = projectIdentity(projectRoot);
  if (!normalizedSessionId) {
    throw new Error(REASON_MESSAGES[HOST_FACT_REASON.NO_SESSION_ID]);
  }
  if (!normalizedProjectRoot) {
    throw new Error(REASON_MESSAGES[HOST_FACT_REASON.NO_PROJECT_ROOT]);
  }
  const record = {
    schemaVersion: SCHEMA_VERSION,
    status,
    reasonCode,
    sessionDigest: createSessionCorrelationKey(normalizedSessionId),
    projectDigest: digest(normalizedProjectRoot),
    observedAt,
    host,
    capacityOverrides,
    compactionScope,
    sources
  };
  validateHostSessionFacts(record);
  return record;
}

export async function writeHostSessionFacts(record, {
  dataDirectory,
  fileSystem = defaultFileSystem,
  isProcessAlive = defaultIsProcessAlive,
  maxDirectoryBytes = HOST_FACT_MAX_DIRECTORY_BYTES,
  maxFactAgeMs = HOST_FACT_MAX_AGE_MS,
  now = () => new Date()
} = {}) {
  validateHostSessionFacts(record);
  if (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) {
    throw new Error(REASON_MESSAGES[HOST_FACT_REASON.NO_DATA_DIRECTORY]);
  }
  const recordText = `${JSON.stringify(record)}\n`;
  const recordBytes = Buffer.byteLength(recordText, "utf8");
  if (recordBytes > MAX_FACT_BYTES) {
    throw new Error("The host-session fact record is too large.");
  }
  const store = await factStore.resolveDirectory(dataDirectory, { create: true, fileSystem });
  const target = factPath(store.directory, record.sessionDigest);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const directoryByteLimit = positiveSafeInteger(maxDirectoryBytes, HOST_FACT_MAX_DIRECTORY_BYTES);
  const factAgeLimit = positiveSafeInteger(maxFactAgeMs, HOST_FACT_MAX_AGE_MS);
  let directoryLock = null;
  let handle;
  try {
    directoryLock = await factStore.acquireLock(store.directory, fileSystem, isProcessAlive);
    if (!directoryLock) {
      throw new Error("The host-session fact store is busy.");
    }
    const assertOwnership = () => factStore.assertOwnedLock(directoryLock, store.directory, fileSystem);
    await assertOwnership();
    await factStore.assertDirectory(store, fileSystem);
    const existing = await readStoredFactRecord(target, store.directory, fileSystem);
    if (existing) {
      const existingTime = Date.parse(existing.record.observedAt);
      const candidateTime = Date.parse(record.observedAt);
      if (candidateTime < existingTime) {
        throw new Error("The host-session fact record is older than the stored record.");
      }
      if (candidateTime === existingTime) {
        if (materialFactText(record) !== materialFactText(existing.record)) {
          throw new Error("The host-session fact record conflicts with stored facts at the same observation time.");
        }
        return target;
      }
    }
    const withinLimits = await enforceFactDirectoryLimits({
      directory: store.directory,
      target,
      candidateBytes: recordBytes,
      existingTargetBytes: existing?.metadata.size ?? 0,
      maxDirectoryBytes: directoryByteLimit,
      maxFactAgeMs: factAgeLimit,
      now,
      fileSystem,
      assertOwnership
    });
    if (!withinLimits) {
      throw new Error("The host-session fact store reached its storage limit.");
    }
    await assertOwnership();
    handle = await factStore.openPrivateFile(temporary, fileSystem);
    await handle.writeFile(recordText, "utf8");
    if (typeof handle.sync === "function") {
      await handle.sync();
    }
    await handle.close();
    handle = null;
    await assertOwnership();
    await factStore.assertDirectory(store, fileSystem);
    const currentTarget = await factStore.inspectRegularFile(target, store.directory, fileSystem, { missing: true });
    if (
      (existing === null && currentTarget !== null)
      || (existing !== null && (
        currentTarget === null
        || currentTarget.dev !== existing.metadata.dev
        || currentTarget.ino !== existing.metadata.ino
        || currentTarget.nlink !== 1
      ))
    ) {
      throw new Error("The host-session fact record changed during replacement.");
    }
    await assertOwnership();
    await fileSystem.rename(temporary, target);
    return target;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (typeof fileSystem.unlink === "function") {
      try {
        await factStore.assertDirectory(store, fileSystem);
        const metadata = await fileSystem.lstat(temporary);
        if (!metadata.isDirectory()) await fileSystem.unlink(temporary);
      } catch {
        // Best-effort cleanup must not follow a replaced store path.
      }
    }
    throw error;
  } finally {
    if (directoryLock) {
      await factStore.releaseLock(directoryLock, store.directory, fileSystem).catch(() => {});
    }
  }
}

function clockMilliseconds(now) {
  const value = typeof now === "function" ? now() : new Date();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
}

/**
 * This function returns a session object that resolveSessionCapacity accepts.
 */
export async function readHostSessionFacts({
  dataDirectory,
  correlationKey,
  projectRoot,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = () => new Date(),
  fileSystem = defaultFileSystem
} = {}) {
  if (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) {
    return unsupported(HOST_FACT_REASON.NO_DATA_DIRECTORY);
  }
  if (correlationKey === undefined || correlationKey === null || correlationKey === "") {
    return unsupported(HOST_FACT_REASON.NO_CORRELATION_KEY);
  }
  if (typeof correlationKey !== "string" || !DIGEST_PATTERN.test(correlationKey)) {
    return unsupported(HOST_FACT_REASON.INVALID_CORRELATION_KEY);
  }
  const normalizedProjectRoot = projectIdentity(projectRoot);
  if (!normalizedProjectRoot) {
    return unsupported(HOST_FACT_REASON.NO_PROJECT_ROOT);
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    return unsupported(HOST_FACT_REASON.INVALID_SESSION_FACTS);
  }

  const sessionDigest = correlationKey;
  let store;
  try {
    store = await factStore.resolveDirectory(dataDirectory, { create: false, fileSystem });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return unsupported(HOST_FACT_REASON.NO_SESSION_FACTS);
    }
    return unsupported(HOST_FACT_REASON.FACTS_UNAVAILABLE);
  }
  const target = factPath(store.directory, sessionDigest);
  let text;
  let opened;
  try {
    await factStore.assertDirectory(store, fileSystem);
    opened = await factStore.openExistingRegularFile(target, store.directory, fileSystem);
    if (opened.metadata.size > MAX_FACT_BYTES) {
      return unsupported(HOST_FACT_REASON.INVALID_SESSION_FACTS);
    }
    text = await opened.handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return unsupported(HOST_FACT_REASON.NO_SESSION_FACTS);
    }
    if (error?.code === "UNSAFE_HOST_FACT_PATH") {
      return unsupported(HOST_FACT_REASON.INVALID_SESSION_FACTS);
    }
    return unsupported(HOST_FACT_REASON.FACTS_UNAVAILABLE);
  } finally {
    if (opened) await opened.handle.close().catch(() => {});
  }

  let record;
  try {
    record = JSON.parse(text);
    validateHostSessionFacts(record);
  } catch {
    return unsupported(HOST_FACT_REASON.INVALID_SESSION_FACTS);
  }
  if (record.sessionDigest !== sessionDigest) {
    return unsupported(HOST_FACT_REASON.SESSION_MISMATCH);
  }
  if (record.projectDigest !== digest(normalizedProjectRoot)) {
    return unsupported(HOST_FACT_REASON.PROJECT_MISMATCH);
  }

  const currentTime = clockMilliseconds(now);
  const observedTime = Date.parse(record.observedAt);
  if (!Number.isFinite(currentTime) || observedTime - currentTime > MAX_FUTURE_SKEW_MS) {
    return unsupported(HOST_FACT_REASON.INVALID_SESSION_FACTS);
  }
  if (currentTime - observedTime > maxAgeMs) {
    return unsupported(HOST_FACT_REASON.STALE_SESSION_FACTS);
  }

  const provenance = {
    source: "active-host-session",
    observedAt: record.observedAt,
    fields: { ...record.sources }
  };
  const session = {
    harness: record.host.harness,
    harnessVersion: record.host.harnessVersion,
    provider: record.host.provider,
    model: record.host.model
  };
  if (Object.keys(record.capacityOverrides).length > 0) {
    session.capacityOverrides = { ...record.capacityOverrides };
  }
  if (record.status === "UNSUPPORTED") {
    const hasCompleteIdentity = [session.harness, session.harnessVersion, session.provider, session.model]
      .every((value) => typeof value === "string" && value.length > 0);
    return unsupported(record.reasonCode, {
      provenance,
      ...(hasCompleteIdentity ? { session, compactionScope: record.compactionScope } : {})
    });
  }
  return { status: "SUPPORTED", session, compactionScope: record.compactionScope, provenance };
}
