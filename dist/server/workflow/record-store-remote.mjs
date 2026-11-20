// Generated from src/server/workflow/record-store-remote.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { gitTransportPath } from "./git-local-repository.mjs";
import { describeOversizedEntry, describeUnsafeEntry, unsafeEntryFix, gitTimeoutMs, gitTooOld, gitUrlText, helperForRepository, localRemoteRepository, markManagedStore, moveUnderSyncLock, oversizedStoreEntry, runGit, unsafeStoreEntry, writeCommitFiles } from "./record-store-sync.mjs";
import { legacyStoreId, legacyStoresDirectory, managedStoreId, managedStoresDirectory, remoteLabel, storeIdentity, withoutCredentials } from "./remote-url.mjs";
const clones = /* @__PURE__ */ new Map();
const reportedDirectories = /* @__PURE__ */ new Map();
const LOCK_STALE_MS = 3e4;
function useManagedStores(projectRoot, directory) {
  reportedDirectories.set(projectRoot, directory);
}
function managedStoresOf(projectRoot) {
  return reportedDirectories.get(projectRoot) ?? managedStoresDirectory();
}
const exists = (target) => lstat(target).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
async function originIs(base, identity) {
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  return origin.ok && await storeIdentity(origin.text, { root: base }) === identity;
}
async function adopt(target, configured, unavailable, advice = "move it away, or name its remote under Workspace.") {
  if (!await exists(target)) return null;
  const label = remoteLabel(configured) ?? "the configured remote";
  const refuse = (reason) => unavailable(`Its clone at ${target} ${reason} Prism never changes or deletes that folder; ${advice}`, "clone_folder_taken");
  let base;
  try {
    base = await realpath(target);
  } catch {
    throw refuse("cannot be resolved.");
  }
  const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) throw unavailable("Git is not available, so the remote store cannot be used.");
  if (!top.ok || await realpath(top.text).catch(() => null) !== base) throw refuse("is not a Git clone.");
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || await storeIdentity(origin.text, { root: base }) !== await storeIdentity(configured)) throw refuse(`has ${origin.ok ? `the origin ${remoteLabel(origin.text) ?? "of another remote"}` : "no origin"}, not ${label}.`);
  return base;
}
async function sweepAbandoned(directory, id) {
  const pattern = new RegExp(`^\\.${id}\\.(\\d+)\\.[0-9a-f]+\\.tmp$`);
  for (const name of await readdir(directory).catch(() => [])) {
    const owner = pattern.exec(name);
    if (owner && !alive(Number(owner[1]))) await rm(path.join(directory, name), { recursive: true, force: true });
  }
}
async function moveEarlierClone(source, target, configured, unavailable, move) {
  const identity = await storeIdentity(configured);
  const qualifies = async () => {
    if (!await exists(source) || await exists(target)) return false;
    let base;
    try {
      base = await realpath(source);
    } catch {
      return false;
    }
    const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || await realpath(top.text).catch(() => null) !== base) return false;
    return originIs(base, identity);
  };
  if (!await qualifies()) return;
  const kept = `Its clone from an earlier Prism version at ${source} keeps its files and commits`;
  try {
    await moveUnderSyncLock(source, target, qualifies, move);
  } catch (error) {
    if (error.code === "lock_timeout") throw unavailable(`${kept}, and a sync of that clone is still running; try again when it finishes.`);
    throw unavailable(`${kept}, and Prism could not move it to ${target}${error.code ? ` (${error.code})` : ""}; close any program that uses that folder and try again.`);
  }
}
async function renameSpellingClone(directory, target, configured, unavailable, renameFolder) {
  const old = legacyStoreId(configured);
  if (!old) return;
  const source = path.join(directory, old);
  if (source === target) return;
  await moveEarlierClone(source, target, configured, unavailable, renameFolder);
}
async function moveLegacyClone(directory, target, configured, unavailable, renameFolder) {
  const legacy = legacyStoresDirectory();
  const old = legacyStoreId(configured);
  if (!legacy || !old || path.resolve(legacy) === path.resolve(directory)) return;
  const move = async (source, destination) => {
    try {
      await renameFolder(source, destination);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      try {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
      } catch (copyError) {
        await rm(destination, { recursive: true, force: true });
        throw copyError;
      }
    }
  };
  await moveEarlierClone(path.join(legacy, old), target, configured, unavailable, move);
}
async function clonedUrl(directory, configured) {
  let local = null;
  try {
    local = gitTransportPath(configured);
  } catch {
    local = null;
  }
  const absolute = process.platform === "win32" ? /^(?:[\\/]|[^\0]:)/u.test(configured) : configured.startsWith("/");
  if (!local?.plain || absolute) return configured;
  const cwd = await realpath(directory);
  return `${process.platform === "win32" ? cwd.replaceAll("\\", "/") : cwd}/${configured}`;
}
async function cloneOnce(directory, id, target, configured, unavailable, renameFolder, { refuseEmpty = false, report = {}, advice } = {}) {
  const found = await adopt(target, configured, unavailable, advice);
  if (found) return found;
  await mkdir(directory, { recursive: true, mode: 448 });
  const lockError = () => unavailable("Another process is still cloning it; try again when that clone finishes.");
  return withArtifactLock(target, () => withFileLock(target, async () => {
    const again = await adopt(target, configured, unavailable, advice);
    if (again) return again;
    await renameSpellingClone(directory, target, configured, unavailable, renameFolder);
    await moveLegacyClone(directory, target, configured, unavailable, renameFolder);
    const moved = await adopt(target, configured, unavailable, advice);
    if (moved) return moved;
    await sweepAbandoned(directory, id);
    const temporary = path.join(directory, `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const url = await runGit(directory, ["ls-remote", "--get-url", configured]);
      let reached = configured;
      try {
        if (url.ok && url.text) reached = gitUrlText(url);
      } catch (error) {
        throw unavailable(error.message);
      }
      const local = await localRemoteRepository(reached, directory).catch((error) => {
        throw unavailable(error.message);
      });
      if (local?.stops) throw unavailable(`Git could not clone it: no Git repository is found at the local remote ${withoutCredentials(reached)}.`);
      const helper = local ? await helperForRepository("--upload-pack", local.path, directory).catch((error) => {
        throw unavailable(error.message);
      }) : [];
      const source = local ? ["--no-local", "--", local.path] : ["--", configured];
      const cloned = await runGit(directory, ["-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-checkout", "--origin", "origin", "--config", "core.longpaths=true", "--config", "core.symlinks=false", ...helper, ...source, temporary]);
      if (cloned.missing) throw unavailable("Git is not available, so the remote store cannot be cloned.");
      if (!cloned.ok) throw unavailable(`Git could not clone it: ${withoutCredentials(cloned.stderr) || `git clone exited with code ${cloned.code}.`}`, "clone_failed");
      if (local?.path) {
        const recorded = await runGit(temporary, ["config", "remote.origin.url", await clonedUrl(directory, configured)]);
        if (!recorded.ok) throw unavailable(`Git could not record its remote: ${recorded.stderr}`);
      }
      const head = await runGit(temporary, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (!head.ok && refuseEmpty) throw unavailable("Its repository holds no commit yet.", "store_empty");
      if (head.ok) {
        const unsafe = await unsafeStoreEntry(temporary, head.text);
        if (unsafe) throw unavailable(`Its branch holds ${describeUnsafeEntry(unsafe)}, so it was not cloned. ${unsafeEntryFix(unsafe)}`);
        const over = await oversizedStoreEntry(temporary, head.text);
        if (over) throw unavailable(`Its branch holds ${await describeOversizedEntry(over)}, so it was not cloned. Shrink or remove ${over.folder ? "comment files of that folder" : "that file"} on the remote's branch.`);
        await writeCommitFiles(temporary, head.text).catch((error) => {
          throw unavailable(`Git could not write its files: ${withoutCredentials(error.message)}`);
        });
      }
      await rename(temporary, target);
      report.cloned = true;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return realpath(target);
  }, lockError, { timeoutMs: gitTimeoutMs() + LOCK_STALE_MS, renew: true, staleMs: LOCK_STALE_MS }));
}
async function managedRecordStore(projectRoot, configured, makeUnavailable, { renameFolder = rename } = {}) {
  const label = remoteLabel(configured);
  const unavailable = (reason) => makeUnavailable(`The record store ${label ? `${label} ` : ""}named under Workspace in .prism/workflow.md is a Git remote. ${reason}`, label);
  const directory = managedStoresOf(projectRoot);
  const id = await managedStoreId(configured);
  if (!id) throw unavailable("It is not a usable remote address.");
  const tooOld = await gitTooOld();
  if (tooOld) throw unavailable(tooOld);
  const target = path.join(directory, id);
  const cached = clones.get(target);
  if (cached && (!cached.done || await exists(target))) return cached.pending;
  const entry = { done: false };
  entry.pending = cloneOnce(directory, id, target, configured, unavailable, renameFolder).then((base) => {
    entry.done = true;
    markManagedStore(base);
    return base;
  }, (error) => {
    if (clones.get(target) === entry) clones.delete(target);
    throw error;
  });
  clones.set(target, entry);
  return entry.pending;
}
async function cloneAddedStore(url, { directory = managedStoresDirectory(), refuseEmpty = true, renameFolder = rename } = {}) {
  const label = remoteLabel(url) ?? "the store";
  const unavailable = (reason, code = "clone_failed") => Object.assign(new Error(withoutCredentials(`Prism could not add ${label}. ${reason}`)), { code });
  const id = await managedStoreId(url);
  if (!id) throw unavailable("It is not a usable remote address.");
  const tooOld = await gitTooOld();
  if (tooOld) throw unavailable(tooOld);
  const target = path.join(directory, id);
  const report = { cloned: false };
  const base = await cloneOnce(directory, id, target, url, unavailable, renameFolder, { refuseEmpty, report, advice: "move it away, then add the store again." });
  markManagedStore(base);
  return { base, cloned: report.cloned };
}
export {
  cloneAddedStore,
  managedRecordStore,
  managedStoresOf,
  useManagedStores
};
