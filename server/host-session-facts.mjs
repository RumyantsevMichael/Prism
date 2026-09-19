import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const FACT_DIRECTORY = "session-capacity";
const MAX_FACT_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
export const HOST_FACT_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
export const HOST_FACT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_RETRY_COUNT = 20;
const LOCK_STALE_MS = 30_000;
const MAX_LOCK_OWNER_BYTES = 128;
const LOCK_DIRECTORY_NAME = ".retention.lock";
const LOCK_OWNER_PREFIX = "owner-";
const LOCK_OWNER_PATTERN = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const PENDING_LOCK_PATTERN = /^\.retention\.lock\.pending\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const STALE_LOCK_PATTERN = /^\.retention\.lock\.stale\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const RELEASE_LOCK_PATTERN = /^\.retention\.lock\.release\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
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
  harness: new Set(["codex-adapter"]),
  harnessVersion: new Set(["transcript.session_meta.cli_version", null]),
  provider: new Set(["transcript.session_meta.model_provider", null]),
  model: new Set(["hook.model", null]),
  contextWindowTokens: new Set(["hook.model_context_window", null]),
  compactionThresholdTokens: new Set(["hook.model_auto_compact_token_limit", null]),
  compactionScope: new Set(["hook.model_auto_compact_token_limit_scope", null])
});
const REASON_CODES = new Set(Object.values(HOST_FACT_REASON));

class UnsafeHostFactPathError extends Error {
  constructor(message) {
    super(message);
    this.code = "UNSAFE_HOST_FACT_PATH";
  }
}

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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function noFollowFlags(flags) {
  return Number.isInteger(fileConstants.O_NOFOLLOW) ? flags | fileConstants.O_NOFOLLOW : flags;
}

function isDirectChild(directory, candidate) {
  return path.dirname(candidate) === directory && path.basename(candidate) !== "";
}

function assertDirectChild(directory, candidate, name) {
  if (!isDirectChild(directory, candidate)) {
    throw new UnsafeHostFactPathError(`${name} escapes the host-session fact directory.`);
  }
}

async function resolveFactDirectory(dataDirectory, { create, fileSystem }) {
  if (create) {
    await fileSystem.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  }
  const dataRoot = await fileSystem.realpath(dataDirectory);
  const rootMetadata = await fileSystem.lstat(dataRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new UnsafeHostFactPathError("The plugin data directory is not a regular directory.");
  }

  const requestedDirectory = path.join(dataRoot, FACT_DIRECTORY);
  if (create) {
    try {
      await fileSystem.mkdir(requestedDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const directoryMetadata = await fileSystem.lstat(requestedDirectory);
  if (directoryMetadata.isSymbolicLink()) {
    throw new UnsafeHostFactPathError("The host-session fact directory cannot be a symbolic link.");
  }
  if (!directoryMetadata.isDirectory()) {
    throw new UnsafeHostFactPathError("The host-session fact directory is not a directory.");
  }
  const directory = await fileSystem.realpath(requestedDirectory);
  if (path.relative(dataRoot, directory) !== FACT_DIRECTORY) {
    throw new UnsafeHostFactPathError("The host-session fact directory escapes the plugin data directory.");
  }

  if (create && process.platform !== "win32") {
    const directoryFlags = noFollowFlags(
      fileConstants.O_RDONLY | (Number.isInteger(fileConstants.O_DIRECTORY) ? fileConstants.O_DIRECTORY : 0)
    );
    const handle = await fileSystem.open(directory, directoryFlags);
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isDirectory()) {
        throw new UnsafeHostFactPathError("The host-session fact directory changed during validation.");
      }
      if (typeof handle.chmod === "function") {
        await handle.chmod(0o700);
      }
    } finally {
      await handle.close();
    }
  }
  return { dataRoot, directory };
}

async function assertFactDirectory(store, fileSystem) {
  const metadata = await fileSystem.lstat(store.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new UnsafeHostFactPathError("The host-session fact directory changed during use.");
  }
  const canonical = await fileSystem.realpath(store.directory);
  if (canonical !== store.directory || path.relative(store.dataRoot, canonical) !== FACT_DIRECTORY) {
    throw new UnsafeHostFactPathError("The host-session fact directory escapes the plugin data directory.");
  }
  return metadata;
}

async function inspectRegularFile(target, directory, fileSystem, { missing = false } = {}) {
  assertDirectChild(directory, target, "The host-session fact path");
  let metadata;
  try {
    metadata = await fileSystem.lstat(target);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new UnsafeHostFactPathError("The host-session fact record cannot be a symbolic link.");
  }
  if (!metadata.isFile()) {
    throw new UnsafeHostFactPathError("The host-session fact record is not a regular file.");
  }
  if (metadata.nlink !== 1) {
    throw new UnsafeHostFactPathError("The host-session fact record cannot have multiple links.");
  }
  const canonical = await fileSystem.realpath(target);
  if (canonical !== target || path.dirname(canonical) !== directory) {
    throw new UnsafeHostFactPathError("The host-session fact record escapes its storage directory.");
  }
  return metadata;
}

async function openExistingRegularFile(target, directory, fileSystem, { missing = false } = {}) {
  const expected = await inspectRegularFile(target, directory, fileSystem, { missing });
  if (expected === null) return null;
  const handle = await fileSystem.open(target, noFollowFlags(fileConstants.O_RDONLY));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new UnsafeHostFactPathError("The host-session fact record changed during validation.");
    }
    return { handle, metadata: opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openPrivateFile(target, fileSystem) {
  const flags = noFollowFlags(fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL);
  return fileSystem.open(target, flags, 0o600);
}

async function readStoredFactRecord(target, directory, fileSystem) {
  const opened = await openExistingRegularFile(target, directory, fileSystem, { missing: true });
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

function lockOwnerName(token) {
  return `${LOCK_OWNER_PREFIX}${token}`;
}

function lockOwnerText(token, pid) {
  return `${JSON.stringify({ token, pid })}\n`;
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

async function createOwnedLock(lockPath, token, pid, fileSystem) {
  const directory = path.dirname(lockPath);
  const pendingPath = path.join(directory, `.retention.lock.pending.${token}`);
  await fileSystem.mkdir(pendingPath, { mode: 0o700 });
  const ownerName = lockOwnerName(token);
  const ownerPath = path.join(pendingPath, ownerName);
  let handle;
  try {
    handle = await openPrivateFile(ownerPath, fileSystem);
    await handle.writeFile(lockOwnerText(token, pid), "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fileSystem.lstat(lockPath);
      const conflict = new Error("The host-session fact store is busy.");
      conflict.code = "EEXIST";
      throw conflict;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fileSystem.rename(pendingPath, lockPath);
    } catch (error) {
      let published = false;
      try {
        const owner = await readLockOwner(lockPath, directory, fileSystem);
        published = owner?.token === token && owner.pid === pid;
      } catch {
      }
      if (!published) throw error;
    }
    return { lockPath, ownerName, token, pid };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.unlink(ownerPath).catch(() => {});
    await fileSystem.rmdir(pendingPath).catch(() => {});
    if (error?.code === "ENOTEMPTY") error.code = "EEXIST";
    throw error;
  }
}

async function inspectLockPath(lockPath, directory, fileSystem) {
  assertDirectChild(directory, lockPath, "The retention lock path");
  const metadata = await fileSystem.lstat(lockPath);
  if (metadata.isSymbolicLink()) {
    throw new UnsafeHostFactPathError("The retention lock cannot be a symbolic link.");
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new UnsafeHostFactPathError("The retention lock has an unsupported file type.");
  }
  const canonical = await fileSystem.realpath(lockPath);
  if (canonical !== lockPath || path.dirname(canonical) !== directory) {
    throw new UnsafeHostFactPathError("The retention lock escapes the host-session fact directory.");
  }
  return metadata;
}

async function readLockOwner(lockPath, directory, fileSystem) {
  const metadata = await inspectLockPath(lockPath, directory, fileSystem);
  if (!metadata.isDirectory()) return null;
  const entries = await fileSystem.readdir(lockPath);
  if (entries.length !== 1) return null;
  const ownerName = entries[0];
  const match = LOCK_OWNER_PATTERN.exec(ownerName);
  if (!match) return null;
  const ownerPath = path.join(lockPath, ownerName);
  const opened = await openExistingRegularFile(ownerPath, lockPath, fileSystem);
  try {
    if (opened.metadata.size > MAX_LOCK_OWNER_BYTES) return null;
    let value;
    try {
      value = JSON.parse(await opened.handle.readFile("utf8"));
    } catch {
      return null;
    }
    if (
      !isObject(value)
      || Object.keys(value).length !== 2
      || value.token !== match[1]
      || !Number.isSafeInteger(value.pid)
      || value.pid < 1
    ) {
      return null;
    }
    return { lockPath, ownerName, token: value.token, pid: value.pid };
  } finally {
    await opened.handle.close();
  }
}

async function processState(pid, isProcessAlive) {
  try {
    const result = await isProcessAlive(pid);
    return result === true ? "active" : result === false ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
}

async function removeOwnedLockArtifact(lock, directory, fileSystem) {
  const current = await readLockOwner(lock.lockPath, directory, fileSystem);
  if (!current || current.token !== lock.token || current.pid !== lock.pid) return false;
  await fileSystem.unlink(path.join(lock.lockPath, current.ownerName));
  await fileSystem.rmdir(lock.lockPath);
  return true;
}

async function removeEmptyLockArtifact(lockPath, directory, fileSystem) {
  const metadata = await inspectLockPath(lockPath, directory, fileSystem);
  if (!metadata.isDirectory()) return false;
  if ((await fileSystem.readdir(lockPath)).length !== 0) return false;
  await fileSystem.rmdir(lockPath);
  return true;
}

async function cleanupAbandonedLockArtifacts(directory, fileSystem, isProcessAlive, assertOwnership) {
  const entries = await fileSystem.readdir(directory);
  for (const entry of entries) {
    const isStale = STALE_LOCK_PATTERN.test(entry);
    const isRelease = RELEASE_LOCK_PATTERN.test(entry);
    const isPending = PENDING_LOCK_PATTERN.test(entry);
    if (!isStale && !isRelease && !isPending) continue;
    const artifactPath = path.join(directory, entry);
    const owner = await readLockOwner(artifactPath, directory, fileSystem);
    if (!owner) {
      await assertOwnership();
      if (await removeEmptyLockArtifact(artifactPath, directory, fileSystem)) continue;
      throw new Error("The host-session fact store is busy because an abandoned lock owner is unknown.");
    }
    if (!isRelease && await processState(owner.pid, isProcessAlive) !== "dead") {
      if (isPending) continue;
      throw new Error("The host-session fact store is busy because a stale lock owner is active or unknown.");
    }
    await assertOwnership();
    if (!await removeOwnedLockArtifact(owner, directory, fileSystem)) {
      throw new Error("The host-session fact store is busy because an abandoned lock owner changed during cleanup.");
    }
  }
}

async function assertOwnedLock(lock, directory, fileSystem) {
  let owner;
  try {
    owner = await readLockOwner(lock.lockPath, directory, fileSystem);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("The host-session fact store lock ownership was lost.");
    }
    throw error;
  }
  if (!owner || owner.token !== lock.token || owner.pid !== lock.pid) {
    throw new Error("The host-session fact store lock ownership was lost.");
  }
  return true;
}

async function acquireLock(lockPath, directory, fileSystem, isProcessAlive) {
  const token = randomUUID();
  const pid = process.pid;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const lock = await createOwnedLock(lockPath, token, pid, fileSystem);
      const assertOwnership = () => assertOwnedLock(lock, directory, fileSystem);
      try {
        await assertOwnership();
        await cleanupAbandonedLockArtifacts(directory, fileSystem, isProcessAlive, assertOwnership);
        await assertOwnership();
      } catch (error) {
        await releaseOwnedLock(lock, directory, fileSystem).catch(() => {});
        throw error;
      }
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const metadata = await inspectLockPath(lockPath, directory, fileSystem);
        if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
          const owner = await readLockOwner(lockPath, directory, fileSystem);
          const empty = !owner && metadata.isDirectory() && (await fileSystem.readdir(lockPath)).length === 0;
          if (empty || (owner && await processState(owner.pid, isProcessAlive) === "dead")) {
            const stalePath = path.join(directory, `.retention.lock.stale.${randomUUID()}`);
            await fileSystem.rename(lockPath, stalePath);
            const movedOwner = await readLockOwner(stalePath, directory, fileSystem);
            if (
              (empty && !movedOwner && (await fileSystem.readdir(stalePath)).length === 0)
              || (movedOwner && movedOwner.token === owner.token && movedOwner.pid === owner.pid)
            ) {
              continue;
            }
          }
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") {
          continue;
        }
        throw lockError;
      }
      await wait(Math.min(5 * (attempt + 1), 50));
    }
  }
  return null;
}

async function releaseOwnedLock(lock, directory, fileSystem) {
  if (!lock) return false;
  const releasePath = path.join(directory, `.retention.lock.release.${randomUUID()}`);
  try {
    const current = await readLockOwner(lock.lockPath, directory, fileSystem);
    if (!current || current.token !== lock.token || current.pid !== lock.pid) return false;
    try {
      await fileSystem.rename(lock.lockPath, releasePath);
    } catch (error) {
      let movedOwner = null;
      try {
        movedOwner = await readLockOwner(releasePath, directory, fileSystem);
      } catch {
      }
      if (!movedOwner || movedOwner.token !== lock.token || movedOwner.pid !== lock.pid) {
        const publicOwner = await readLockOwner(lock.lockPath, directory, fileSystem).catch(() => null);
        if (!publicOwner || publicOwner.token !== lock.token || publicOwner.pid !== lock.pid) throw error;
        await fileSystem.rename(lock.lockPath, releasePath);
      }
    }
    const movedOwner = await readLockOwner(releasePath, directory, fileSystem);
    if (!movedOwner || movedOwner.token !== lock.token || movedOwner.pid !== lock.pid) return false;
    return removeOwnedLockArtifact(movedOwner, directory, fileSystem);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
        await inspectRegularFile(entryPath, directory, fileSystem);
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
      const metadata = await inspectRegularFile(entryPath, directory, fileSystem);
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
  if (record.host.harness !== "codex-cli") {
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
  for (const key of ["harnessVersion", "provider", "model"]) {
    if ((record.host[key] === null) !== (record.sources[key] === null)) {
      throw new Error(`hostSessionFacts.${key} value and source must be present together.`);
    }
  }
  for (const key of CAPACITY_KEYS) {
    if (Object.hasOwn(record.capacityOverrides, key) !== (record.sources[key] !== null)) {
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
    for (const key of CAPACITY_KEYS) {
      if (!Object.hasOwn(record.capacityOverrides, key)) {
        throw new Error(`Supported host-session facts require capacityOverrides.${key}.`);
      }
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
  const store = await resolveFactDirectory(dataDirectory, { create: true, fileSystem });
  const target = factPath(store.directory, record.sessionDigest);
  const directoryLockPath = path.join(store.directory, LOCK_DIRECTORY_NAME);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const directoryByteLimit = positiveSafeInteger(maxDirectoryBytes, HOST_FACT_MAX_DIRECTORY_BYTES);
  const factAgeLimit = positiveSafeInteger(maxFactAgeMs, HOST_FACT_MAX_AGE_MS);
  let directoryLock = null;
  let handle;
  try {
    directoryLock = await acquireLock(directoryLockPath, store.directory, fileSystem, isProcessAlive);
    if (!directoryLock) {
      throw new Error("The host-session fact store is busy.");
    }
    const assertOwnership = () => assertOwnedLock(directoryLock, store.directory, fileSystem);
    await assertOwnership();
    await assertFactDirectory(store, fileSystem);
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
    handle = await openPrivateFile(temporary, fileSystem);
    await handle.writeFile(recordText, "utf8");
    if (typeof handle.sync === "function") {
      await handle.sync();
    }
    await handle.close();
    handle = null;
    await assertOwnership();
    await assertFactDirectory(store, fileSystem);
    const currentTarget = await inspectRegularFile(target, store.directory, fileSystem, { missing: true });
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
        await assertFactDirectory(store, fileSystem);
        const metadata = await fileSystem.lstat(temporary);
        if (!metadata.isDirectory()) await fileSystem.unlink(temporary);
      } catch {
        // Best-effort cleanup must not follow a replaced store path.
      }
    }
    throw error;
  } finally {
    if (directoryLock) {
      await releaseOwnedLock(directoryLock, store.directory, fileSystem).catch(() => {});
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
    store = await resolveFactDirectory(dataDirectory, { create: false, fileSystem });
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
    await assertFactDirectory(store, fileSystem);
    opened = await openExistingRegularFile(target, store.directory, fileSystem);
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
