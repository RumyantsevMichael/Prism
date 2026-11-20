// Generated from src/server/review/added-workspaces.mts by scripts/native-build/compile.mjs.
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { cloneAddedStore } from "../workflow/record-store-remote.mjs";
import { localStoreChanges, moveUnderSyncLock, runGit } from "../workflow/record-store-sync.mjs";
import { addressWithoutCredentials, credentialsIn, isRemoteStore, managedStoresDirectory, remoteLabel, storeIdentity, withoutCredentials } from "../workflow/remote-url.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { storeWorkspaceId } from "./workspaces.mjs";
const FILE = "workspaces.json";
const SCHEMA_VERSION = 1;
const URL_MAX = 2048;
const CREDENTIALS = "Prism refused the address because it carries credentials. Give the store's address without a user name, password, or token: credentials come from the machine's Git configuration, such as its credential helper or SSH keys.";
class WorkspaceError extends Error {
  constructor(status, code, message) {
    super(withoutCredentials(message));
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => new WorkspaceError(status, code, message);
const exists = (target) => lstat(target).then(() => true, () => false);
const plaintext = (identity) => /^(?:http|git):\/\//.test(identity);
const storeFolderName = (identity) => createHash("sha256").update(identity).digest("hex").slice(0, 16);
async function readAddedWorkspaces(directory) {
  let parsed;
  try {
    parsed = parseStoreJson(await readFile(path.join(directory, FILE), "utf8"));
  } catch {
    return [];
  }
  const listed = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
  return listed.filter((entry) => typeof entry?.identity === "string" && Array.isArray(entry.urls) && entry.urls.every((url) => typeof url === "string")).map(({ identity, urls, addedAt }) => ({ identity, urls: storeAddresses(urls), addedAt: typeof addedAt === "string" ? addedAt : null }));
}
function storeAddresses(urls) {
  const kept = [];
  for (const url of urls) {
    const address = addressWithoutCredentials(url);
    if (address !== null && !kept.includes(address)) kept.push(address);
  }
  return kept;
}
async function writeAddedWorkspaces(directory, entries) {
  const workspaces = entries.map(({ identity, urls, addedAt }) => ({ identity, urls, addedAt }));
  await writeAtomically(path.join(directory, FILE), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, workspaces }, null, 2)}
`, { mode: 384 });
}
async function rootCommits(base) {
  const roots = await runGit(base, ["rev-list", "--max-parents=0", "HEAD"]);
  return roots.ok ? new Set(roots.text.split("\n").filter(Boolean)) : /* @__PURE__ */ new Set();
}
async function holdsNoCommit(base) {
  return !(await runGit(base, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}
async function folderStore(url) {
  const identity = await storeIdentity(url);
  if (!identity?.startsWith("file:")) return null;
  const folder = identity.slice("file:".length);
  if (!await stat(folder).then((info) => info.isDirectory(), () => false)) throw fail(400, "url_invalid", `No folder is at ${folder}, so it cannot be added as a store.`);
  return identity;
}
async function createAddedWorkspaces({ directory, storesDirectory = () => managedStoresDirectory() }) {
  const entries = await readAddedWorkspaces(directory);
  let queue = Promise.resolve();
  const serial = (action) => {
    const run = queue.then(action);
    queue = run.catch(() => {
    });
    return run;
  };
  const save = () => writeAddedWorkspaces(directory, entries);
  const byIdentity = (identity) => entries.find((entry) => entry.identity === identity) ?? null;
  const cloneFolder = (identity) => path.join(storesDirectory(), storeFolderName(identity));
  async function remember(identity, url, seenUrls) {
    let entry = byIdentity(identity);
    if (!entry) entries.push(entry = { identity, urls: [], addedAt: (/* @__PURE__ */ new Date()).toISOString() });
    entry.urls = storeAddresses([...entry.urls, ...seenUrls(identity), url]);
    await save();
    return entry;
  }
  async function add(url, { confirmEmpty = false, keptStores = async () => [], seenUrls = () => [] } = {}) {
    if (typeof url !== "string" || !url.trim() || url.length > URL_MAX || /[\u0000-\u001f\u007f]/.test(url.trim())) throw fail(400, "url_invalid", "Give the store's address: an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
    url = url.trim();
    if (credentialsIn(url)) throw fail(400, "url_has_credentials", CREDENTIALS);
    const remote = isRemoteStore(url);
    if (!remote && !path.isAbsolute(url)) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
    return serial(async () => {
      if (!remote || /^file:\/\//i.test(url)) {
        const identity2 = await folderStore(url);
        if (!identity2) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
        await remember(identity2, url, seenUrls);
        return { identity: identity2, merged: false };
      }
      const identity = await storeIdentity(url);
      if (!identity) throw fail(400, "url_invalid", "That is no store address: give an HTTPS or SSH URL, a host:path address, or the absolute path of a folder.");
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
      if (!cloned.cloned && !confirmEmpty && await holdsNoCommit(cloned.base)) {
        throw fail(409, "store_empty", `Prism could not add ${remoteLabel(url) ?? "the store"}. Its repository holds no commit yet.`);
      }
      if (cloned.cloned) {
        const roots = await rootCommits(cloned.base);
        if (roots.size) {
          for (const kept of plaintext(identity) ? [] : await keptStores()) {
            if (kept.identity === identity || plaintext(kept.identity) || kept.identity.startsWith("file:") || !await exists(kept.folder)) continue;
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
  function remove(id, { checkoutsNaming = async () => [] } = {}) {
    return serial(async () => {
      const index = entries.findIndex((entry2) => storeWorkspaceId(entry2.identity) === id);
      if (index < 0) return null;
      const [entry] = entries.splice(index, 1);
      await save();
      return { identity: entry.identity, ...await settleClone(entry, await checkoutsNaming(entry.identity)) };
    });
  }
  async function settleClone(entry, checkouts) {
    const label = remoteLabel(entry.urls[0]) ?? entry.identity;
    if (entry.identity.startsWith("file:")) return { clone: "kept", message: `The store is the folder ${entry.identity.slice("file:".length)}, which Prism never deletes.` };
    if (checkouts.length) return { clone: "kept", message: `The store's clone stays because the checkout ${checkouts[0].path} names ${checkouts[0].url ? remoteLabel(checkouts[0].url) ?? checkouts[0].url : "this store"}.` };
    const folder = cloneFolder(entry.identity);
    if (!await exists(folder)) return { clone: "deleted", message: `The workspace of ${label} is removed, and this machine kept no clone of it.` };
    let reason = await keptReason(folder, entry.identity);
    if (reason) return { clone: "kept", message: `The store's clone at ${folder} stays because ${reason}.` };
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
    await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {
    });
    return { clone: "deleted", message: `The workspace of ${label} is removed, and its clone is deleted.` };
  }
  return {
    list: () => entries.map((entry) => ({ ...entry, id: storeWorkspaceId(entry.identity), urls: [...entry.urls] })),
    has: (id) => entries.some((entry) => storeWorkspaceId(entry.identity) === id),
    add,
    remove
  };
}
async function keptReason(folder, identity) {
  let base;
  try {
    base = await realpath(folder);
  } catch {
    return "it cannot be resolved";
  }
  const top = await runGit(base, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || await realpath(top.text).catch(() => null) !== base) return "it is not a Git clone, so Prism leaves it as it is";
  const origin = await runGit(base, ["config", "--local", "--get", "remote.origin.url"]);
  if (!origin.ok || await storeIdentity(origin.text, { root: base }) !== identity) return "its origin is another remote, so Prism leaves it as it is";
  const changes = await localStoreChanges(base).catch(() => ({ commits: true, files: true, conflicts: true }));
  if (changes.commits) return "it holds commits that are not pushed";
  if (changes.files || changes.conflicts) return "it holds changes that are not pushed";
  return null;
}
export {
  WorkspaceError,
  createAddedWorkspaces,
  readAddedWorkspaces,
  storeAddresses
};
