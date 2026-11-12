import { randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import path from "node:path";

export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_COUNT = 20;
const LOCK_DIRECTORY_NAME = ".retention.lock";
const LOCK_OWNER_PREFIX = "owner-";
const TOKEN_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LOCK_OWNER_PATTERN = new RegExp(`^owner-(${TOKEN_PATTERN})$`);
const PENDING_LOCK_PATTERN = new RegExp(`^\\.retention\\.lock\\.pending\\.(${TOKEN_PATTERN})$`);
const STALE_LOCK_PATTERN = new RegExp(`^\\.retention\\.lock\\.stale\\.(${TOKEN_PATTERN})$`);
const RELEASE_LOCK_PATTERN = new RegExp(`^\\.retention\\.lock\\.release\\.(${TOKEN_PATTERN})$`);
const LOCK_PROTOCOLS = new Set(["direct", "staged"]);

class UnsafeStorePathError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noFollowFlags(flags) {
  return Number.isInteger(fileConstants.O_NOFOLLOW) ? flags | fileConstants.O_NOFOLLOW : flags;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lockOwnerName(token) {
  return `${LOCK_OWNER_PREFIX}${token}`;
}

function lockOwnerText(token, pid) {
  return `${JSON.stringify({ token, pid })}\n`;
}

export function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
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

function unsafe(store, message) {
  return new UnsafeStorePathError(store.unsafePathCode, message);
}

function isUnsafePath(store, error) {
  return error instanceof UnsafeStorePathError && error.code === store.unsafePathCode;
}

function assertDirectChild(store, directory, candidate, name) {
  if (path.dirname(candidate) !== directory || path.basename(candidate) === "") {
    throw unsafe(store, `${name} escapes the ${store.subject} directory.`);
  }
}

async function resolveDirectory(store, dataDirectory, { create, fileSystem }) {
  if (create) {
    await fileSystem.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  }
  const dataRoot = await fileSystem.realpath(dataDirectory);
  const rootMetadata = await fileSystem.lstat(dataRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw unsafe(store, "The plugin data directory is not a regular directory.");
  }

  const requestedDirectory = path.join(dataRoot, store.directoryName);
  if (create) {
    try {
      await fileSystem.mkdir(requestedDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const directoryMetadata = await fileSystem.lstat(requestedDirectory);
  if (directoryMetadata.isSymbolicLink()) {
    throw unsafe(store, `The ${store.subject} directory cannot be a symbolic link.`);
  }
  if (!directoryMetadata.isDirectory()) {
    throw unsafe(store, `The ${store.subject} directory is not a directory.`);
  }
  const directory = await fileSystem.realpath(requestedDirectory);
  if (path.relative(dataRoot, directory) !== store.directoryName) {
    throw unsafe(store, `The ${store.subject} directory escapes the plugin data directory.`);
  }
  if (create && process.platform !== "win32") {
    const flags = noFollowFlags(
      fileConstants.O_RDONLY | (Number.isInteger(fileConstants.O_DIRECTORY) ? fileConstants.O_DIRECTORY : 0)
    );
    const handle = await fileSystem.open(directory, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory()) {
        throw unsafe(store, `The ${store.subject} directory changed during validation.`);
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

async function assertDirectory(store, location, fileSystem) {
  const metadata = await fileSystem.lstat(location.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafe(store, `The ${store.subject} directory changed during use.`);
  }
  const canonical = await fileSystem.realpath(location.directory);
  if (canonical !== location.directory || path.relative(location.dataRoot, canonical) !== store.directoryName) {
    throw unsafe(store, `The ${store.subject} directory escapes the plugin data directory.`);
  }
  return metadata;
}

async function inspectRegularFile(store, target, directory, fileSystem, { missing = false } = {}) {
  assertDirectChild(store, directory, target, `The ${store.subject} path`);
  let metadata;
  try {
    metadata = await fileSystem.lstat(target);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw unsafe(store, `The ${store.subject} record cannot be a symbolic link.`);
  }
  if (!metadata.isFile()) {
    throw unsafe(store, `The ${store.subject} record is not a regular file.`);
  }
  if (metadata.nlink !== 1) {
    throw unsafe(store, `The ${store.subject} record cannot have multiple links.`);
  }
  const canonical = await fileSystem.realpath(target);
  if (canonical !== target || path.dirname(canonical) !== directory) {
    throw unsafe(store, `The ${store.subject} record escapes its storage directory.`);
  }
  return metadata;
}

async function openExistingRegularFile(store, target, directory, fileSystem, { missing = false } = {}) {
  const expected = await inspectRegularFile(store, target, directory, fileSystem, { missing });
  if (expected === null) return null;
  const handle = await fileSystem.open(target, noFollowFlags(fileConstants.O_RDONLY));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw unsafe(store, `The ${store.subject} record changed during validation.`);
    }
    return { handle, metadata: opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openPrivateFile(store, target, fileSystem) {
  const flags = noFollowFlags(fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL);
  return fileSystem.open(target, flags, 0o600);
}

async function inspectLockPath(store, lockPath, directory, fileSystem) {
  assertDirectChild(store, directory, lockPath, "The retention lock path");
  const metadata = await fileSystem.lstat(lockPath);
  if (metadata.isSymbolicLink()) {
    throw unsafe(store, "The retention lock cannot be a symbolic link.");
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw unsafe(store, "The retention lock has an unsupported file type.");
  }
  const canonical = await fileSystem.realpath(lockPath);
  if (canonical !== lockPath || path.dirname(canonical) !== directory) {
    throw unsafe(store, `The retention lock escapes the ${store.subject} directory.`);
  }
  return metadata;
}

// The direct protocol rejects an invalid owner record, while the store.staged protocol reads it as no owner.
function invalidOwner(store, message) {
  if (store.staged) return null;
  throw unsafe(store, message);
}

async function readLockOwner(store, lockPath, directory, fileSystem) {
  const metadata = await inspectLockPath(store, lockPath, directory, fileSystem);
  if (!metadata.isDirectory()) return null;
  const entries = await fileSystem.readdir(lockPath);
  if (entries.length !== 1) {
    return invalidOwner(store, `The ${store.subject} lock has invalid ownership metadata.`);
  }
  const ownerName = entries[0];
  const match = LOCK_OWNER_PATTERN.exec(ownerName);
  if (!match) {
    return invalidOwner(store, `The ${store.subject} lock owner name is invalid.`);
  }
  const ownerPath = path.join(lockPath, ownerName);
  const opened = await openExistingRegularFile(store, ownerPath, lockPath, fileSystem);
  try {
    if (opened.metadata.size > store.maxLockOwnerBytes) {
      return invalidOwner(store, `The ${store.subject} lock owner is too large.`);
    }
    let owner;
    try {
      owner = JSON.parse(await opened.handle.readFile("utf8"));
    } catch (error) {
      if (store.staged) return null;
      throw error;
    }
    if (
      !isObject(owner)
      || Object.keys(owner).length !== 2
      || owner.token !== match[1]
      || !Number.isSafeInteger(owner.pid)
      || owner.pid < 1
    ) {
      return invalidOwner(store, `The ${store.subject} lock owner is invalid.`);
    }
    return { lockPath, ownerName, token: owner.token, pid: owner.pid };
  } finally {
    await opened.handle.close();
  }
}

async function ownsLock(store, lock, directory, fileSystem) {
  if (!lock) return false;
  try {
    const owner = await readLockOwner(store, lock.lockPath, directory, fileSystem);
    return owner?.token === lock.token && owner.ownerName === lock.ownerName && owner.pid === lock.pid;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertOwnedLock(store, lock, directory, fileSystem) {
  if (!await ownsLock(store, lock, directory, fileSystem)) {
    throw new Error(`The ${store.subject} store lock ownership was lost.`);
  }
  return true;
}

async function writeOwner(store, ownerPath, token, pid, fileSystem) {
  const handle = await openPrivateFile(store, ownerPath, fileSystem);
  try {
    await handle.writeFile(lockOwnerText(token, pid), "utf8");
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectLock(store, lockPath, token, pid, fileSystem) {
  await fileSystem.mkdir(lockPath, { mode: 0o700 });
  const ownerName = lockOwnerName(token);
  const ownerPath = path.join(lockPath, ownerName);
  try {
    await writeOwner(store, ownerPath, token, pid, fileSystem);
    return { lockPath, ownerName, token, pid };
  } catch (error) {
    await fileSystem.unlink(ownerPath).catch(() => {});
    await fileSystem.rmdir(lockPath).catch(() => {});
    throw error;
  }
}

async function createStagedLock(store, lockPath, token, pid, fileSystem) {
  const directory = path.dirname(lockPath);
  const pendingPath = path.join(directory, `${LOCK_DIRECTORY_NAME}.pending.${token}`);
  await fileSystem.mkdir(pendingPath, { mode: 0o700 });
  const ownerName = lockOwnerName(token);
  const ownerPath = path.join(pendingPath, ownerName);
  try {
    await writeOwner(store, ownerPath, token, pid, fileSystem);
    try {
      await fileSystem.lstat(lockPath);
      const conflict = new Error(`The ${store.subject} store is busy.`);
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
        const owner = await readLockOwner(store, lockPath, directory, fileSystem);
        published = owner?.token === token && owner.pid === pid;
      } catch {
      }
      if (!published) throw error;
    }
    return { lockPath, ownerName, token, pid };
  } catch (error) {
    await fileSystem.unlink(ownerPath).catch(() => {});
    await fileSystem.rmdir(pendingPath).catch(() => {});
    if (error?.code === "ENOTEMPTY") error.code = "EEXIST";
    throw error;
  }
}

async function removeDirectLock(store, lock, directory, fileSystem) {
  if (!await ownsLock(store, lock, directory, fileSystem)) return false;
  await fileSystem.unlink(path.join(lock.lockPath, lock.ownerName));
  try {
    await fileSystem.rmdir(lock.lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
  return true;
}

async function removeOwnedLockArtifact(store, lock, directory, fileSystem) {
  const current = await readLockOwner(store, lock.lockPath, directory, fileSystem);
  if (!current || current.token !== lock.token || current.pid !== lock.pid) return false;
  await fileSystem.unlink(path.join(lock.lockPath, current.ownerName));
  await fileSystem.rmdir(lock.lockPath);
  return true;
}

async function removeEmptyLockArtifact(store, lockPath, directory, fileSystem) {
  const metadata = await inspectLockPath(store, lockPath, directory, fileSystem);
  if (!metadata.isDirectory()) return false;
  if ((await fileSystem.readdir(lockPath)).length !== 0) return false;
  await fileSystem.rmdir(lockPath);
  return true;
}

async function cleanupAbandonedLockArtifacts(store, directory, fileSystem, isProcessAlive, assertOwnership) {
  for (const entry of await fileSystem.readdir(directory)) {
    const isStale = STALE_LOCK_PATTERN.test(entry);
    const isRelease = RELEASE_LOCK_PATTERN.test(entry);
    const isPending = PENDING_LOCK_PATTERN.test(entry);
    if (!isStale && !isRelease && !isPending) continue;
    const artifactPath = path.join(directory, entry);
    const owner = await readLockOwner(store, artifactPath, directory, fileSystem);
    if (!owner) {
      await assertOwnership();
      if (await removeEmptyLockArtifact(store, artifactPath, directory, fileSystem)) continue;
      throw new Error(`The ${store.subject} store is busy because an abandoned lock owner is unknown.`);
    }
    if (!isRelease && await processState(owner.pid, isProcessAlive) !== "dead") {
      if (isPending) continue;
      throw new Error(`The ${store.subject} store is busy because a stale lock owner is active or unknown.`);
    }
    await assertOwnership();
    if (!await removeOwnedLockArtifact(store, owner, directory, fileSystem)) {
      throw new Error(`The ${store.subject} store is busy because an abandoned lock owner changed during cleanup.`);
    }
  }
}

async function releaseStagedLock(store, lock, directory, fileSystem) {
  if (!lock) return false;
  const releasePath = path.join(directory, `${LOCK_DIRECTORY_NAME}.release.${randomUUID()}`);
  try {
    const current = await readLockOwner(store, lock.lockPath, directory, fileSystem);
    if (!current || current.token !== lock.token || current.pid !== lock.pid) return false;
    try {
      await fileSystem.rename(lock.lockPath, releasePath);
    } catch (error) {
      let movedOwner = null;
      try {
        movedOwner = await readLockOwner(store, releasePath, directory, fileSystem);
      } catch {
      }
      if (!movedOwner || movedOwner.token !== lock.token || movedOwner.pid !== lock.pid) {
        const publicOwner = await readLockOwner(store, lock.lockPath, directory, fileSystem).catch(() => null);
        if (!publicOwner || publicOwner.token !== lock.token || publicOwner.pid !== lock.pid) throw error;
        await fileSystem.rename(lock.lockPath, releasePath);
      }
    }
    const movedOwner = await readLockOwner(store, releasePath, directory, fileSystem);
    if (!movedOwner || movedOwner.token !== lock.token || movedOwner.pid !== lock.pid) return false;
    return removeOwnedLockArtifact(store, movedOwner, directory, fileSystem);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// An aged lock is reclaimed only from a matching owner that is confirmed dead.
async function reclaimDirectLock(store, lockPath, metadata, directory, fileSystem, isProcessAlive) {
  const owner = metadata.isDirectory() ? await readLockOwner(store, lockPath, directory, fileSystem) : null;
  if (!owner || await processState(owner.pid, isProcessAlive) !== "dead") return false;
  return removeDirectLock(store, owner, directory, fileSystem);
}

async function reclaimStagedLock(store, lockPath, metadata, directory, fileSystem, isProcessAlive) {
  const owner = await readLockOwner(store, lockPath, directory, fileSystem);
  const empty = !owner && metadata.isDirectory() && (await fileSystem.readdir(lockPath)).length === 0;
  if (!empty && !(owner && await processState(owner.pid, isProcessAlive) === "dead")) return false;
  const stalePath = path.join(directory, `${LOCK_DIRECTORY_NAME}.stale.${randomUUID()}`);
  await fileSystem.rename(lockPath, stalePath);
  const movedOwner = await readLockOwner(store, stalePath, directory, fileSystem);
  return (empty && !movedOwner && (await fileSystem.readdir(stalePath)).length === 0)
    || Boolean(movedOwner && movedOwner.token === owner.token && movedOwner.pid === owner.pid);
}

async function publishLock(store, lockPath, token, pid, directory, fileSystem, isProcessAlive) {
  if (!store.staged) return createDirectLock(store, lockPath, token, pid, fileSystem);
  const lock = await createStagedLock(store, lockPath, token, pid, fileSystem);
  const assertOwnership = () => assertOwnedLock(store, lock, directory, fileSystem);
  try {
    await assertOwnership();
    await cleanupAbandonedLockArtifacts(store, directory, fileSystem, isProcessAlive, assertOwnership);
    await assertOwnership();
  } catch (error) {
    await releaseStagedLock(store, lock, directory, fileSystem).catch(() => {});
    throw error;
  }
  return lock;
}

async function acquireLock(store, directory, fileSystem, isProcessAlive) {
  const lockPath = path.join(directory, LOCK_DIRECTORY_NAME);
  const token = randomUUID();
  const pid = process.pid;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      return await publishLock(store, lockPath, token, pid, directory, fileSystem, isProcessAlive);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const metadata = await inspectLockPath(store, lockPath, directory, fileSystem);
        if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
          const reclaim = store.staged ? reclaimStagedLock : reclaimDirectLock;
          if (await reclaim(store, lockPath, metadata, directory, fileSystem, isProcessAlive)) continue;
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

async function releaseLock(store, lock, directory, fileSystem) {
  return store.staged ? releaseStagedLock(store, lock, directory, fileSystem) : removeDirectLock(store, lock, directory, fileSystem);
}

/**
 * Creates the path checks, private file creation, and retention lock for one plugin-local store.
 * The direct lock protocol rejects an invalid owner record as an unsafe path.
 * The staged lock protocol treats an invalid owner record as an absent owner.
 */
export function createPrivateSessionStore({ directoryName, subject, unsafePathCode, maxLockOwnerBytes, lockProtocol }) {
  if (!LOCK_PROTOCOLS.has(lockProtocol)) {
    throw new Error(`Unknown session store lock protocol: ${lockProtocol}.`);
  }
  if (!Number.isSafeInteger(maxLockOwnerBytes) || maxLockOwnerBytes < 1) {
    throw new Error("The session store lock owner limit must be a positive integer.");
  }

  const store = { directoryName, subject, unsafePathCode, maxLockOwnerBytes, staged: lockProtocol === "staged" };
  return {
    isUnsafePath: (...args) => isUnsafePath(store, ...args),
    assertDirectChild: (...args) => assertDirectChild(store, ...args),
    resolveDirectory: (...args) => resolveDirectory(store, ...args),
    assertDirectory: (...args) => assertDirectory(store, ...args),
    inspectRegularFile: (...args) => inspectRegularFile(store, ...args),
    openExistingRegularFile: (...args) => openExistingRegularFile(store, ...args),
    openPrivateFile: (...args) => openPrivateFile(store, ...args),
    acquireLock: (...args) => acquireLock(store, ...args),
    ownsLock: (...args) => ownsLock(store, ...args),
    assertOwnedLock: (...args) => assertOwnedLock(store, ...args),
    releaseLock: (...args) => releaseLock(store, ...args)
  };
}
