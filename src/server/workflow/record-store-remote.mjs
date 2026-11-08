import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { describeUnsafeEntry, gitTimeoutMs, gitTooOld, markManagedStore, runGit, unsafeStoreEntry, writeCommitFiles } from "./record-store-sync.mjs";
import { legacyStoresDirectory, managedStoreId, managedStoresDirectory, normalizeRemote, remoteLabel, withoutCredentials } from "./remote-url.mjs";

// A record store named by its remote lives in a clone Prism keeps in its application folder, one per remote, shared by every checkout and host that names it.
// Prism creates that clone because no checkout owns it, and never changes, replaces, or deletes a folder it finds there.
const clones = new Map();
// The review app serves projects of sessions whose hosts keep their data in different folders, so each project uses the folder its sessions report.
const reportedDirectories = new Map();
const LOCK_STALE_MS = 30000;

/** Use this folder of managed clones for one project's remote store, as the session that registered the project reports it. */
export function useManagedStores(projectRoot, directory) {
  reportedDirectories.set(projectRoot, directory);
}

/** The folder of managed clones a project's remote store resolves in: the one its sessions reported, or this machine's. */
export function managedStoresOf(projectRoot) {
  return reportedDirectories.get(projectRoot) ?? managedStoresDirectory();
}

const exists = (target) => lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

// A folder already at the clone path is used only when it is the top of a Git checkout whose origin is the configured remote.
async function adopt(target, configured, unavailable) {
  if (!(await exists(target))) return null;
  const label = remoteLabel(configured) ?? "the configured remote";
  const refuse = (reason) => unavailable(`Its clone at ${target} ${reason} Prism never changes or deletes that folder; move it away, or name its remote under Workspace.`);
  let base;
  try { base = await realpath(target); } catch { throw refuse("cannot be resolved."); }
  const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) throw unavailable("Git is not available, so the remote store cannot be used.");
  if (!top.ok || await realpath(top.text).catch(() => null) !== base) throw refuse("is not a Git clone.");
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || normalizeRemote(origin.text) !== normalizeRemote(configured)) throw refuse(`has ${origin.ok ? `the origin ${remoteLabel(origin.text) ?? "of another remote"}` : "no origin"}, not ${label}.`);
  return base;
}

// A clone that a killed process left half done keeps its temporary name, and only the clone lock's holder removes it.
async function sweepAbandoned(directory, id) {
  const pattern = new RegExp(`^\\.${id}\\.(\\d+)\\.[0-9a-f]+\\.tmp$`);
  for (const name of await readdir(directory).catch(() => [])) {
    const owner = pattern.exec(name);
    if (owner && !alive(Number(owner[1]))) await rm(path.join(directory, name), { recursive: true, force: true });
  }
}

// Prism 0.16 kept clones under each host's plugin data directory; the first access here moves that clone, so commits it has not pushed yet stay.
// A copy replaces the move when the two folders sit on different file systems, and a folder there with another origin stays where it is.
async function moveLegacyClone(directory, id, target, configured) {
  const legacy = legacyStoresDirectory();
  if (!legacy || path.resolve(legacy) === path.resolve(directory)) return;
  const source = path.join(legacy, id);
  if (!(await exists(source))) return;
  const origin = await runGit(source, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || normalizeRemote(origin.text) !== normalizeRemote(configured)) return;
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") return;
    await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true }).catch(() => rm(target, { recursive: true, force: true }));
  }
}

// One process at a time clones a remote, into a temporary sibling that is renamed into place, so the clone path never holds a partial clone.
async function cloneOnce(directory, id, target, configured, unavailable) {
  const found = await adopt(target, configured, unavailable);
  if (found) return found;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockError = () => unavailable("Another process is still cloning it; try again when that clone finishes.");
  return withArtifactLock(target, () => withFileLock(target, async () => {
    const again = await adopt(target, configured, unavailable);
    if (again) return again;
    await moveLegacyClone(directory, id, target, configured);
    const moved = await adopt(target, configured, unavailable);
    if (moved) return moved;
    await sweepAbandoned(directory, id);
    const temporary = path.join(directory, `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      // Long paths keep deep record paths usable on Windows, where Git otherwise stops at 260 characters.
      // Git checks every object the remote sends, so a tree that a teammate built with a name such as ".." or ".git" fails the clone,
      // and the clone writes no file until the remote's whole tree holds no entry that a store may not hold, as every sync checks an upstream's tree.
      // The files are written from their blobs' bytes, never checked out, so no line-ending setting or attributes file makes a file differ from what every sync expects.
      // The remote is named origin, as every sync of a managed clone expects, whatever the person's clone.defaultRemoteName.
      const cloned = await runGit(directory, ["-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-checkout", "--origin", "origin", "--config", "core.longpaths=true", "--config", "core.symlinks=false", "--", configured, temporary]);
      if (cloned.missing) throw unavailable("Git is not available, so the remote store cannot be cloned.");
      if (!cloned.ok) throw unavailable(`Git could not clone it: ${withoutCredentials(cloned.stderr) || `git clone exited with code ${cloned.code}.`}`);
      const head = await runGit(temporary, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (head.ok) {
        const unsafe = await unsafeStoreEntry(temporary, head.text);
        if (unsafe) throw unavailable(`Its branch holds ${describeUnsafeEntry(unsafe)}, so it was not cloned. Remove that path from the remote's branch.`);
        await writeCommitFiles(temporary, head.text).catch((error) => { throw unavailable(`Git could not write its files: ${withoutCredentials(error.message)}`); });
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return realpath(target);
  }, lockError, { timeoutMs: gitTimeoutMs() + LOCK_STALE_MS, renew: true, staleMs: LOCK_STALE_MS }));
}

/**
 * The folder of a remote store's managed clone, cloned on first use and reused by every later access in this process.
 * makeUnavailable(message, remote) builds the store_unavailable error, so every refusal names the remote without its user information.
 */
export async function managedRecordStore(projectRoot, configured, makeUnavailable) {
  const label = remoteLabel(configured);
  const unavailable = (reason) => makeUnavailable(`The record store ${label ? `${label} ` : ""}named under Workspace in .prism/workflow.md is a Git remote. ${reason}`, label);
  const directory = managedStoresOf(projectRoot);
  const id = managedStoreId(configured);
  if (!id) throw unavailable("It is not a usable remote address.");
  // A Git older than the store sync needs would fail some of the clone's or a sync's commands midway, so the store is refused before either runs.
  const tooOld = await gitTooOld();
  if (tooOld) throw unavailable(tooOld);
  const target = path.join(directory, id);
  const cached = clones.get(target);
  // A clone that disappeared since it was cached is looked for again, so the access reports what is there now.
  if (cached && (!cached.done || await exists(target))) return cached.pending;
  const entry = { done: false };
  entry.pending = cloneOnce(directory, id, target, configured, unavailable).then((base) => {
    entry.done = true;
    markManagedStore(base);
    return base;
  }, (error) => {
    // A failed clone is not remembered, so the next access tries again.
    if (clones.get(target) === entry) clones.delete(target);
    throw error;
  });
  clones.set(target, entry);
  return entry.pending;
}
