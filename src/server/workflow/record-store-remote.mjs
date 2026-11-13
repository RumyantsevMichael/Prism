import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { gitTransportPath } from "./git-local-repository.mjs";
import { describeOversizedEntry, describeUnsafeEntry, unsafeEntryFix, gitTimeoutMs, gitTooOld, gitUrlText, helperForRepository, localRemoteRepository, markManagedStore, moveUnderSyncLock, oversizedStoreEntry, runGit, unsafeStoreEntry, writeCommitFiles } from "./record-store-sync.mjs";
import { legacyStoreId, legacyStoresDirectory, managedStoreId, managedStoresDirectory, remoteLabel, storeIdentity, withoutCredentials } from "./remote-url.mjs";

// A record store named by its remote lives in a clone Prism keeps in its application folder, one per store identity, shared by every checkout and host that names any spelling of that identity.
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

// Whether a clone's origin names the store of this identity, in any spelling.
async function originIs(base, identity) {
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  return origin.ok && await storeIdentity(origin.text, { root: base }) === identity;
}

// A folder already at the clone path is used only when it is the top of a Git checkout whose origin has the configured store's identity.
// A folder there that is no such clone refuses with the code clone_folder_taken, and advice says what the person can do about it.
async function adopt(target, configured, unavailable, advice = "move it away, or name its remote under Workspace.") {
  if (!(await exists(target))) return null;
  const label = remoteLabel(configured) ?? "the configured remote";
  const refuse = (reason) => unavailable(`Its clone at ${target} ${reason} Prism never changes or deletes that folder; ${advice}`, "clone_folder_taken");
  let base;
  try { base = await realpath(target); } catch { throw refuse("cannot be resolved."); }
  const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) throw unavailable("Git is not available, so the remote store cannot be used.");
  if (!top.ok || await realpath(top.text).catch(() => null) !== base) throw refuse("is not a Git clone.");
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || await storeIdentity(origin.text, { root: base }) !== await storeIdentity(configured)) throw refuse(`has ${origin.ok ? `the origin ${remoteLabel(origin.text) ?? "of another remote"}` : "no origin"}, not ${label}.`);
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

// Move a clone that an earlier Prism made at source to target, so its unpushed commits stay.
// Only the top of a Git clone whose origin has the configured store's identity moves, and a folder already at the new path leaves the old one untouched.
// The move holds the old folder's sync lock, so no sync there loses its folder midway, and when that lock is held or the move fails the access refuses and makes no clone,
// so the old folder keeps its commits and a later access moves it.
async function moveEarlierClone(source, target, configured, unavailable, move) {
  const identity = await storeIdentity(configured);
  const qualifies = async () => {
    if (!(await exists(source)) || await exists(target)) return false;
    let base;
    try { base = await realpath(source); } catch { return false; }
    const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || await realpath(top.text).catch(() => null) !== base) return false;
    return originIs(base, identity);
  };
  if (!(await qualifies())) return;
  const kept = `Its clone from an earlier Prism version at ${source} keeps its files and commits`;
  try {
    await moveUnderSyncLock(source, target, qualifies, move);
  } catch (error) {
    if (error.code === "lock_timeout") throw unavailable(`${kept}, and a sync of that clone is still running; try again when it finishes.`);
    throw unavailable(`${kept}, and Prism could not move it to ${target}${error.code ? ` (${error.code})` : ""}; close any program that uses that folder and try again.`);
  }
}

// Prism 0.20 named a clone after its configured spelling; the first access with no clone at the identity's folder renames that folder.
async function renameSpellingClone(directory, target, configured, unavailable, renameFolder) {
  const old = legacyStoreId(configured);
  if (!old) return;
  const source = path.join(directory, old);
  if (source === target) return;
  await moveEarlierClone(source, target, configured, unavailable, renameFolder);
}

// Prism 0.16 kept clones under each host's plugin data directory, named as 0.20 named them; the first access here moves that clone the same way.
// A copy replaces the move when the two folders sit on different file systems, and a copy that fails leaves nothing at the new path.
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

// The origin URL that git clone records for a remote: a local path made absolute from the folder the clone ran in, as clone's absolute_pathdup does, or the URL as it is.
async function clonedUrl(directory, configured) {
  let local = null;
  try { local = gitTransportPath(configured); } catch { local = null; }
  const absolute = process.platform === "win32" ? /^(?:[\\/]|[^\0]:)/u.test(configured) : configured.startsWith("/");
  if (!local?.plain || absolute) return configured;
  const cwd = await realpath(directory);
  return `${process.platform === "win32" ? cwd.replaceAll("\\", "/") : cwd}/${configured}`;
}

// One process at a time clones a remote, into a temporary sibling that is renamed into place, so the clone path never holds a partial clone.
// unavailable(reason, code) builds each refusal, code clone_folder_taken, clone_failed, or store_empty where the reason is one of those.
// With refuseEmpty, a remote that holds no commit refuses and leaves no folder; report.cloned says whether this call made the clone.
async function cloneOnce(directory, id, target, configured, unavailable, renameFolder, { refuseEmpty = false, report = {}, advice } = {}) {
  const found = await adopt(target, configured, unavailable, advice);
  if (found) return found;
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
      // Long paths keep deep record paths usable on Windows, where Git otherwise stops at 260 characters.
      // Git checks every object the remote sends, so a tree that a teammate built with a name such as ".." or ".git" fails the clone,
      // and the clone writes no file until the remote's whole tree holds no entry that a store may not hold, as every sync checks an upstream's tree.
      // The files are written from their blobs' bytes, never checked out, so no line-ending setting or attributes file makes a file differ from what every sync expects.
      // The remote is named origin, as every sync of a managed clone expects, whatever the person's clone.defaultRemoteName.
      // A local remote's upload-pack runs on this machine, so it reads no hook or command that the remote's own files name, as in every sync,
      // and the clone names the repository that Git enters for the remote's URL by its path, with --no-local so Git still checks every object, then records the remote as Git records it.
      // A remote whose URL Git reaches as a local path where it finds no repository is not cloned, so no helper starts anywhere for it.
      const url = await runGit(directory, ["ls-remote", "--get-url", configured]);
      let reached = configured;
      try { if (url.ok && url.text) reached = gitUrlText(url); } catch (error) { throw unavailable(error.message); }
      const local = await localRemoteRepository(reached, directory).catch((error) => { throw unavailable(error.message); });
      if (local?.stops) throw unavailable(`Git could not clone it: no Git repository is found at the local remote ${withoutCredentials(reached)}.`);
      const helper = local ? await helperForRepository("--upload-pack", local.path, directory).catch((error) => { throw unavailable(error.message); }) : [];
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
        await writeCommitFiles(temporary, head.text).catch((error) => { throw unavailable(`Git could not write its files: ${withoutCredentials(error.message)}`); });
      }
      await rename(temporary, target);
      report.cloned = true;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return realpath(target);
  }, lockError, { timeoutMs: gitTimeoutMs() + LOCK_STALE_MS, renew: true, staleMs: LOCK_STALE_MS }));
}

/**
 * The folder of a remote store's managed clone, cloned on first use and reused by every later access in this process.
 * makeUnavailable(message, remote) builds the store_unavailable error, so every refusal names the remote without its user information.
 * renameFolder moves a clone that an earlier Prism made, and tests pass one that fails.
 */
export async function managedRecordStore(projectRoot, configured, makeUnavailable, { renameFolder = rename } = {}) {
  const label = remoteLabel(configured);
  const unavailable = (reason) => makeUnavailable(`The record store ${label ? `${label} ` : ""}named under Workspace in .prism/workflow.md is a Git remote. ${reason}`, label);
  const directory = managedStoresOf(projectRoot);
  const id = await managedStoreId(configured);
  if (!id) throw unavailable("It is not a usable remote address.");
  // A Git older than the store sync needs would fail some of the clone's or a sync's commands midway, so the store is refused before either runs.
  const tooOld = await gitTooOld();
  if (tooOld) throw unavailable(tooOld);
  const target = path.join(directory, id);
  const cached = clones.get(target);
  // A clone that disappeared since it was cached is looked for again, so the access reports what is there now.
  if (cached && (!cached.done || await exists(target))) return cached.pending;
  const entry = { done: false };
  entry.pending = cloneOnce(directory, id, target, configured, unavailable, renameFolder).then((base) => {
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


/**
 * The managed clone of the network store that url names, for a workspace that a person adds without a checkout: { base, cloned },
 * cloned false when a clone of that store identity already sat in its folder and was used as it is.
 * The clone runs with the machine's Git configuration and credential helpers and never asks on a terminal, and a failed or refused clone leaves no folder.
 * Each refusal is an error with code clone_failed, clone_folder_taken, or store_empty and a message without credentials; refuseEmpty refuses a remote with no commit.
 */
export async function cloneAddedStore(url, { directory = managedStoresDirectory(), refuseEmpty = true, renameFolder = rename } = {}) {
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
