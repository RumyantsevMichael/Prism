import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { cloneAddedStore } from "../workflow/record-store-remote.mjs";
import { localStoreChanges, moveUnderSyncLock, runGit } from "../workflow/record-store-sync.mjs";
import { addressWithoutCredentials, credentialsIn, isRemoteStore, managedStoresDirectory, remoteLabel, storeIdentity, withoutCredentials } from "../workflow/remote-url.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { storeWorkspaceId } from "./workspaces.mjs";

// The workspaces a person added from a store URL, kept in the app folder until the person removes them, whatever else the app forgets.
// Adding one clones only its store, and removing one deletes that clone only when nothing on this machine uses it and nothing in it is unpushed.

const FILE = "workspaces.json";
const SCHEMA_VERSION = 1;
const URL_MAX = 2048;
const CREDENTIALS = "Prism refused the address because it carries credentials. Give the store's address without a user name, password, or token: credentials come from the machine's Git configuration, such as its credential helper or SSH keys.";

/** A refusal of an add or a remove, with the HTTP status and code the review app answers. */
export class WorkspaceError extends Error {
  constructor(status, code, message) {
    super(withoutCredentials(message));
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => new WorkspaceError(status, code, message);
const exists = (target) => lstat(target).then(() => true, () => false);
const plaintext = (identity) => /^(?:http|git):\/\//.test(identity);
// The managed clone folder of a network store identity: the first 16 hexadecimal characters of the SHA-256 of the identity.
const storeFolderName = (identity) => createHash("sha256").update(identity).digest("hex").slice(0, 16);

/** The added workspaces of an app folder, [{ identity, urls, addedAt }], or none while the file is missing or unreadable. */
export async function readAddedWorkspaces(directory) {
  let parsed;
  try { parsed = parseStoreJson(await readFile(path.join(directory, FILE), "utf8")); } catch { return []; }
  const listed = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
  return listed.filter((entry) => typeof entry?.identity === "string" && Array.isArray(entry.urls) && entry.urls.every((url) => typeof url === "string"))
    .map(({ identity, urls, addedAt }) => ({ identity, urls: storeAddresses(urls), addedAt: typeof addedAt === "string" ? addedAt : null }));
}

/**
 * Store addresses fit to save or show, in their order: each credential is taken out, and an address that is then already listed, or still carries one, is dropped.
 * A checkout's Store value can carry a token, and the saved list and the workspace list must never repeat it.
 */
export function storeAddresses(urls) {
  const kept = [];
  for (const url of urls) {
    const address = addressWithoutCredentials(url);
    if (address !== null && !kept.includes(address)) kept.push(address);
  }
  return kept;
}

async function writeAddedWorkspaces(directory, entries) {
  const workspaces = entries.map(({ identity, urls, addedAt }) => ({ identity, urls, addedAt }));
  await writeAtomically(path.join(directory, FILE), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, workspaces }, null, 2)}\n`, { mode: 0o600 });
}

// The root commits of a clone's branch, which every clone of one repository shares; none for a clone without a commit.
async function rootCommits(base) {
  const roots = await runGit(base, ["rev-list", "--max-parents=0", "HEAD"]);
  return roots.ok ? new Set(roots.text.split("\n").filter(Boolean)) : new Set();
}

// A clone holds no commit while its HEAD names no commit.
async function holdsNoCommit(base) {
  return !(await runGit(base, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}

// A folder store is the person's own folder, named by its absolute path or a file:// URL.
async function folderStore(url) {
  const identity = await storeIdentity(url);
  if (!identity?.startsWith("file:")) return null;
  const folder = identity.slice("file:".length);
  if (!(await stat(folder).then((info) => info.isDirectory(), () => false))) throw fail(400, "url_invalid", `No folder is at ${folder}, so it cannot be added as a store.`);
  return identity;
}

/**
 * The added workspaces of one app folder, read once and written after every change, with adds and removes one at a time.
 * add and remove answer { identity, merged } and { clone, message }; each refusal is a WorkspaceError.
 */
export async function createAddedWorkspaces({ directory, storesDirectory = () => managedStoresDirectory() }) {
  const entries = await readAddedWorkspaces(directory);
  let queue = Promise.resolve();
  const serial = (action) => {
    const run = queue.then(action);
    queue = run.catch(() => {});
    return run;
  };
  const save = () => writeAddedWorkspaces(directory, entries);
  const byIdentity = (identity) => entries.find((entry) => entry.identity === identity) ?? null;
  const cloneFolder = (identity) => path.join(storesDirectory(), storeFolderName(identity));

  // The URLs the app already saw for the workspace, such as a registered checkout's, come before the added one, so the saved list keeps the order first seen across restarts.
  async function remember(identity, url, seenUrls) {
    let entry = byIdentity(identity);
    if (!entry) entries.push(entry = { identity, urls: [], addedAt: new Date().toISOString() });
    entry.urls = storeAddresses([...entry.urls, ...seenUrls(identity), url]);
    await save();
    return entry;
  }

  /**
   * Add the workspace of the store that url names. keptStores() lists the network store identities this machine already keeps, each as { identity, folder },
   * so a newly cloned store whose root commit one of them shares joins that workspace instead.
   * seenUrls(identity) lists the URLs the app already saw for that store's workspace, in the order first seen.
   */
  async function add(url, { confirmEmpty = false, keptStores = async () => [], seenUrls = () => [] } = {}) {
    // The address is checked before any Git command runs or any folder is made, so a credential in it reaches neither Git nor the disk.
    // A control character, such as a line break, belongs in no address and would only reach Git's arguments and the saved list.
    if (typeof url !== "string" || !url.trim() || url.length > URL_MAX || /[\u0000-\u001f\u007f]/.test(url.trim())) throw fail(400, "url_invalid", "Give the store's address: an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
    url = url.trim();
    if (credentialsIn(url)) throw fail(400, "url_has_credentials", CREDENTIALS);
    const remote = isRemoteStore(url);
    if (!remote && !path.isAbsolute(url)) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
    return serial(async () => {
      if (!remote || /^file:\/\//i.test(url)) {
        const identity = await folderStore(url);
        if (!identity) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
        await remember(identity, url, seenUrls);
        return { identity, merged: false };
      }
      const identity = await storeIdentity(url);
      if (!identity) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
      // A spelling that an earlier add merged into another workspace answers that workspace again without cloning.
      for (const entry of entries) {
        if (entry.identity === identity || plaintext(entry.identity) !== plaintext(identity)) continue;
        for (const known of entry.urls) {
          if (await storeIdentity(known) === identity) {
            await remember(entry.identity, url, seenUrls);
            return { identity: entry.identity, merged: true };
          }
        }
      }
      let cloned;
      try {
        cloned = await cloneAddedStore(url, { directory: storesDirectory(), refuseEmpty: !confirmEmpty });
      } catch (error) {
        if (error.code === "clone_folder_taken" || error.code === "store_empty") throw fail(409, error.code, error.message);
        throw fail(502, "clone_failed", error.message);
      }
      // A clone that was already here is used as it is, but an empty one is still the person's to confirm.
      if (!cloned.cloned && !confirmEmpty && await holdsNoCommit(cloned.base)) {
        throw fail(409, "store_empty", `Prism could not add ${remoteLabel(url) ?? "the store"}. Its repository holds no commit yet.`);
      }
      if (cloned.cloned) {
        const roots = await rootCommits(cloned.base);
        if (roots.size) {
          // A plaintext store never joins another workspace, and a plaintext identity never takes in another spelling,
          // since a plaintext clone's origin is reached without encryption and so never shares a workspace with an encrypted one.
          for (const kept of plaintext(identity) ? [] : await keptStores()) {
            if (kept.identity === identity || plaintext(kept.identity) || kept.identity.startsWith("file:") || !(await exists(kept.folder))) continue;
            const theirs = await rootCommits(kept.folder);
            if (![...roots].some((root) => theirs.has(root))) continue;
            await rm(cloned.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            await remember(kept.identity, url, seenUrls);
            return { identity: kept.identity, merged: true };
          }
        }
      }
      await remember(identity, url, seenUrls);
      return { identity, merged: false };
    });
  }

  /**
   * Remove an added workspace by id. checkoutsNaming(identity) lists the checkouts on this machine that name its store, each as { path, url } with the URL it names the store by.
   * The clone is deleted only when none does, and it holds no commit its upstream lacks, no store file that differs from its commit, and no saved conflict copy.
   */
  function remove(id, { checkoutsNaming = async () => [] } = {}) {
    return serial(async () => {
      const index = entries.findIndex((entry) => storeWorkspaceId(entry.identity) === id);
      if (index < 0) return null;
      const [entry] = entries.splice(index, 1);
      await save();
      return { identity: entry.identity, ...await settleClone(entry, await checkoutsNaming(entry.identity)) };
    });
  }

  async function settleClone(entry, checkouts) {
    const label = remoteLabel(entry.urls[0]) ?? entry.identity;
    if (entry.identity.startsWith("file:")) return { clone: "kept", message: `The store is the folder ${entry.identity.slice("file:".length)}, which Prism never deletes.` };
    // The checkout is quoted with its own spelling of the store, which after a merge is not the spelling the workspace was added by.
    if (checkouts.length) return { clone: "kept", message: `The store's clone stays because the checkout ${checkouts[0].path} names ${checkouts[0].url ? remoteLabel(checkouts[0].url) ?? checkouts[0].url : "this store"}.` };
    const folder = cloneFolder(entry.identity);
    if (!(await exists(folder))) return { clone: "deleted", message: `The workspace of ${label} is removed, and this machine kept no clone of it.` };
    // A folder that is no clone of this store, or one with work its upstream lacks, is left without even taking its lock.
    let reason = await keptReason(folder, entry.identity);
    if (reason) return { clone: "kept", message: `The store's clone at ${folder} stays because ${reason}.` };
    // The check and the move hold the clone's sync lock, so no sync commits or merges between them, and the folder leaves its place in one rename.
    const qualifies = async () => {
      reason = await keptReason(folder, entry.identity);
      return reason === null;
    };
    const trash = path.join(storesDirectory(), `.${path.basename(folder)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    let moved = false;
    try {
      moved = await moveUnderSyncLock(folder, trash, qualifies);
    } catch (error) {
      return { clone: "kept", message: `The store's clone at ${folder} stays because ${error.code === "lock_timeout" ? "a sync of it is still running" : `Prism could not move it (${error.code ?? error.message})`}.` };
    }
    if (!moved) return { clone: "kept", message: `The store's clone at ${folder} stays because ${reason}.` };
    // A removal cut short leaves the temporary name, which the next clone of the store sweeps once this process is gone.
    await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    return { clone: "deleted", message: `The workspace of ${label} is removed, and its clone is deleted.` };
  }

  return {
    list: () => entries.map((entry) => ({ ...entry, id: storeWorkspaceId(entry.identity), urls: [...entry.urls] })),
    has: (id) => entries.some((entry) => storeWorkspaceId(entry.identity) === id),
    add,
    remove
  };
}

// Why a clone must stay, or null when deleting it loses nothing: it must be the top of a Git clone whose origin is this store, with nothing that its upstream lacks.
async function keptReason(folder, identity) {
  let base;
  try { base = await realpath(folder); } catch { return "it cannot be resolved"; }
  const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || await realpath(top.text).catch(() => null) !== base) return "it is not a Git clone, so Prism leaves it as it is";
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || await storeIdentity(origin.text, { root: base }) !== identity) return "its origin is another remote, so Prism leaves it as it is";
  const changes = await localStoreChanges(base).catch(() => ({ commits: true, files: true, conflicts: true }));
  if (changes.commits) return "it holds commits that are not pushed";
  if (changes.files || changes.conflicts) return "it holds changes that are not pushed";
  return null;
}
