import { randomBytes } from "node:crypto";
import { open, lstat, readFile, rm, rename, utimes } from "node:fs/promises";
import path from "node:path";
import { parseStoreJson } from "./store-json.mjs";

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
// A reclaimer holds its reclaim lock only while it reads and removes one file, so an older reclaim lock belongs to a reclaimer that died.
const RECLAIM_STALE_MS = 10000;
const artifactLocks = new Map();

function defaultError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Removes an abandoned lock under a reclaim lock and reports whether it ran.
// Without it, two starters that both judged one lock abandoned could each remove it, and the later removal would take away the lock the earlier one had just created.
async function removeAbandonedLock(lockPath, token) {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    await (await open(reclaimPath, "wx", 0o600)).close();
  } catch (caught) {
    if (caught.code !== "EEXIST") throw caught;
    const info = await lstat(reclaimPath).catch(() => null);
    if (info && Date.now() - info.mtimeMs > RECLAIM_STALE_MS) await rm(reclaimPath, { force: true });
    return false;
  }
  try {
    // Only the judged owner's file is removed, since another starter may have reclaimed the lock since it was read.
    const current = await readFile(lockPath, "utf8").then(parseStoreJson).catch(() => ({}));
    if (current.token === token) await rm(lockPath, { force: true });
  } finally {
    await rm(reclaimPath, { force: true });
  }
  return true;
}

async function acquireFileLock(artifactPath, makeError, options) {
  const lockPath = `${artifactPath}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  // The first attempt always runs, so a short timeout such as the sync lock's one millisecond never times out untried, and so does the attempt after an abandoned lock is removed.
  for (let first = true; first || Date.now() < deadline;) {
    first = false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = randomBytes(16).toString("hex");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, renewable: options.renew === true, at: new Date().toISOString() }));
      } finally {
        // The lock is the file and its token, never an open handle: Windows refuses to rename a folder while a file in it is open, as a store sync does when another machine changed the folder's letter case.
        await handle.close();
      }
      return { lockPath, token };
    } catch (caught) {
      if (caught.code !== "EEXIST") {
        throw caught;
      }
      try {
        const lockInfo = await lstat(lockPath);
        if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) throw makeError("invalid_path", "The artifact lock must be a regular file.");
        let live = false;
        const owner = await readFile(lockPath, "utf8").then(parseStoreJson).catch(() => ({}));
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
          if (await removeAbandonedLock(lockPath, owner.token)) {
            first = true;
            continue;
          }
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
  // A lock never keeps its file open, and a lock whose action moves the folder that holds it is never renewed there, since the folder moves away from the lock's path.
  const heartbeat = options.renew && !options.closeHandle ? setInterval(async () => {
    const owner = await readFile(lock.lockPath, "utf8").then(parseStoreJson).catch(() => null);
    const now = new Date();
    if (owner?.token === lock.token) await utimes(lock.lockPath, now, now).catch(() => {});
    options.onRenew?.(owner?.token === lock.token);
  }, options.heartbeatMs ?? 5000) : null;
  heartbeat?.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    const owner = await readFile(lock.lockPath, "utf8").then(parseStoreJson).catch(() => null);
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

// Windows refuses to rename a file or folder while another process holds it, as another reader, Git that has just exited, or a virus scanner reading new files does,
// so there a rename is retried for a few seconds while the refusal says the path is in use.
export async function renameWhenFree(from, to) {
  for (let delay = 10; ; delay *= 2) {
    try { return await rename(from, to); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || delay > 2560) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** @param {string} artifactPath @param {string | Uint8Array} contents @param {{ renameFile?: typeof rename, mode?: number, beforeTemporary?: (path: string) => Promise<void>, afterTemporary?: (path: string) => Promise<void> }} options */
export async function writeAtomically(artifactPath, contents, { renameFile = renameWhenFree, mode: requestedMode, beforeTemporary, afterTemporary } = {}) {
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
