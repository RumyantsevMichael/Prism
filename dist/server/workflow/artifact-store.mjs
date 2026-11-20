// Generated from src/server/workflow/artifact-store.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { open, lstat, readFile, rm, rename, utimes } from "node:fs/promises";
import path from "node:path";
import { parseStoreJson } from "./store-json.mjs";
const LOCK_TIMEOUT_MS = 5e3;
const LOCK_STALE_MS = 3e4;
const RECLAIM_STALE_MS = 1e4;
const artifactLocks = /* @__PURE__ */ new Map();
function defaultError(code, message) {
  return Object.assign(new Error(message), { code });
}
async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function removeAbandonedLock(lockPath, token) {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    await (await open(reclaimPath, "wx", 384)).close();
  } catch (caught) {
    if (caught.code !== "EEXIST") throw caught;
    const info = await lstat(reclaimPath).catch(() => null);
    if (info && Date.now() - info.mtimeMs > RECLAIM_STALE_MS) await rm(reclaimPath, { force: true });
    return false;
  }
  try {
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
  for (let first = true; first || Date.now() < deadline; ) {
    first = false;
    try {
      const handle = await open(lockPath, "wx", 384);
      const token = randomBytes(16).toString("hex");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, renewable: options.renew === true, at: (/* @__PURE__ */ new Date()).toISOString() }));
      } finally {
        await handle.close();
      }
      return { lockPath, token };
    } catch (caught) {
      if (caught.code !== "EEXIST") {
        if (process.platform === "win32" && (caught.code === "EPERM" || caught.code === "EACCES") && Date.now() < deadline) {
          await wait(25);
          continue;
        }
        throw caught;
      }
      try {
        const lockInfo = await lstat(lockPath);
        if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) throw makeError("invalid_path", "The artifact lock must be a regular file.");
        let live = false;
        const owner = await readFile(lockPath, "utf8").then(parseStoreJson).catch(() => ({}));
        if (options.renew) {
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0);
              live = true;
            } catch (error) {
              live = error.code !== "ESRCH";
            }
          }
        }
        const old = Date.now() - lockInfo.mtimeMs > (options.staleMs ?? LOCK_STALE_MS);
        if (options.abandonWhenUnrenewed ? typeof owner.token === "string" && !live || old : !live && old) {
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
async function withFileLock(artifactPath, action, makeError = defaultError, options = {}) {
  const lock = await acquireFileLock(artifactPath, makeError, options);
  const heartbeat = options.renew && !options.closeHandle ? setInterval(async () => {
    const owner = await readFile(lock.lockPath, "utf8").then(parseStoreJson).catch(() => null);
    const now = /* @__PURE__ */ new Date();
    if (owner?.token === lock.token) await utimes(lock.lockPath, now, now).catch(() => {
    });
    options.onRenew?.(owner?.token === lock.token);
  }, options.heartbeatMs ?? 5e3) : null;
  heartbeat?.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    const owner = await readFile(lock.lockPath, "utf8").then(parseStoreJson).catch(() => null);
    if (owner?.token === lock.token) await rm(lock.lockPath, { force: true }).catch(() => {
    });
  }
}
async function withArtifactLock(artifactPath, action) {
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
async function renameWhenFree(from, to) {
  for (let delay = 10; ; delay *= 2) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || delay > 2560) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
async function writeAtomically(artifactPath, contents, { renameFile = renameWhenFree, mode: requestedMode, beforeTemporary, afterTemporary } = {}) {
  let mode = requestedMode ?? 420;
  try {
    const info = await lstat(artifactPath);
    if (info.isSymbolicLink() || !info.isFile()) throw defaultError("invalid_path", "The artifact must be a regular file.");
    mode = requestedMode ?? info.mode & 511;
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
      if (!committed) throw error;
    }
  }
}
export {
  renameWhenFree,
  withArtifactLock,
  withFileLock,
  writeAtomically
};
