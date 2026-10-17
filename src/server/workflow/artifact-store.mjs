import { randomBytes } from "node:crypto";
import { open, lstat, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const artifactLocks = new Map();

function defaultError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireFileLock(artifactPath, makeError, options) {
  const lockPath = `${artifactPath}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = randomBytes(16).toString("hex");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, renewable: options.renew === true, at: new Date().toISOString() }));
      return { handle, lockPath, token };
    } catch (caught) {
      if (caught.code !== "EEXIST") {
        throw caught;
      }
      try {
        const lockInfo = await lstat(lockPath);
        if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) throw makeError("invalid_path", "The artifact lock must be a regular file.");
        let live = false;
        const owner = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => ({}));
        if (options.renew) {
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); live = true; }
            catch (error) { live = error.code !== "ESRCH"; }
          }
        }
        // A dead owner is conclusive, but a live pid is not: after a reboot it can belong to an unrelated process.
        const old = Date.now() - lockInfo.mtimeMs > (options.staleMs ?? LOCK_STALE_MS);
        // A lock still being written has no token yet, so only its age can abandon it.
        if (options.abandonWhenUnrenewed ? (typeof owner.token === "string" && !live) || old : !live && old) {
          // Another starter may have reclaimed the lock since it was read, so only the judged owner's file is removed.
          const current = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => ({}));
          if (current.token === owner.token) await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") {
          throw lockError;
        }
      }
      await wait(25);
    }
  }
  throw makeError("lock_timeout", "The artifact file is locked by another writer.");
}

export async function withFileLock(artifactPath, action, makeError = defaultError, options = {}) {
  const lock = await acquireFileLock(artifactPath, makeError, options);
  const heartbeat = options.renew ? setInterval(async () => {
    const now = new Date();
    lock.handle.utimes(now, now).catch(() => {});
    if (options.onRenew) {
      const owner = await readFile(lock.lockPath, "utf8").then(JSON.parse).catch(() => null);
      options.onRenew(owner?.token === lock.token);
    }
  }, options.heartbeatMs ?? 5000) : null;
  heartbeat?.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await lock.handle.close().catch(() => {});
    const owner = await readFile(lock.lockPath, "utf8").then(JSON.parse).catch(() => null);
    if (owner?.token === lock.token) await rm(lock.lockPath, { force: true }).catch(() => {});
  }
}

export async function withArtifactLock(artifactPath, action) {
  const previous = artifactLocks.get(artifactPath) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  artifactLocks.set(artifactPath, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (artifactLocks.get(artifactPath) === current) {
      artifactLocks.delete(artifactPath);
    }
  }
}

/** @param {string} artifactPath @param {string | Uint8Array} contents @param {{ renameFile?: typeof rename, mode?: number, beforeTemporary?: (path: string) => Promise<void>, afterTemporary?: (path: string) => Promise<void> }} options */
export async function writeAtomically(artifactPath, contents, { renameFile = rename, mode: requestedMode, beforeTemporary, afterTemporary } = {}) {
  let mode = requestedMode ?? 0o644;
  try {
    const info = await lstat(artifactPath);
    if (info.isSymbolicLink() || !info.isFile()) throw defaultError("invalid_path", "The artifact must be a regular file.");
    mode = requestedMode ?? (info.mode & 0o777);
  } catch (caught) {
    if (caught.code !== "ENOENT") {
      throw caught;
    }
  }
  const temporaryPath = path.join(path.dirname(artifactPath), `.${path.basename(artifactPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  await beforeTemporary?.(temporaryPath);
  let committed = false;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFile(temporaryPath, artifactPath);
    committed = true;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
      await afterTemporary?.(temporaryPath);
    } catch (error) {
      // Publication is the commit point. Cleanup cannot turn a committed write into a rollback request.
      if (!committed) throw error;
    }
  }
}
