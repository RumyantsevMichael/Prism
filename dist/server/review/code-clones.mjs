import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComponentError, readComponents } from "../workflow/components.mjs";
import { runGit } from "../workflow/record-store-sync.mjs";
import { storeIdentity } from "../workflow/remote-url.mjs";
import { REPOSITORIES, portableRepositoryName } from "../workflow/repository-names.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { parseWorkflowConfig } from "../workflow/workflow-config.mjs";
import { binaryPath, secretPath, SOURCE_SIZE_LIMIT } from "./review-server.mjs";
import { gitReason } from "./workspace-sync.mjs";

// Code content: a bare blobless clone of a code repository's remote that Prism keeps in the app folder's code/ while a person has it on,
// holding every branch of the remote as its own branch, so the app shows the files and component declarations of every pushed branch.
// A clone holds commits and trees only, and fetches a file's contents when someone opens the file; turning code content off deletes the clone.

const CODE = "code";
const SAVED = "code-content.json";
const REGISTRATION_MAX_BYTES = 64 * 1024;
const BRANCHES = "refs/heads/";

const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const exists = (target) => stat(target).then(() => true, () => false);

// Git's reason without any URL in it, so no answer of a code route names a Git host.
const withoutUrls = (text) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "the repository's remote").replace(/\b[^\s@'"/]+@[A-Za-z0-9.-]+:[^\s'"]+/g, "the repository's remote");
const reasonOf = (result) => withoutUrls(gitReason(result.stderr || `git exited with code ${result.code}`));

// A folder below the repository's root as a code route names it, or null when it climbs out or is no plain relative path; "" is the root.
export function codeFolder(value) {
  const trimmed = String(value ?? "").replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  if (/[\\\0]/.test(trimmed)) return null;
  return trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? null : trimmed;
}

/** The registered remotes of each repository of a store folder, by name: the remotes its registration lists, in order, or none when it lists none or cannot be read. */
export async function registeredRemotes(folder) {
  const remotes = new Map();
  if (!folder) return remotes;
  const names = await readdir(path.join(folder, REPOSITORIES)).catch(() => []);
  for (const file of names.filter((name) => name.endsWith(".json")).sort()) {
    const name = file.slice(0, -".json".length);
    if (!portableRepositoryName(name)) continue;
    let listed = [];
    try {
      const target = path.join(folder, REPOSITORIES, file);
      if ((await stat(target)).size <= REGISTRATION_MAX_BYTES) {
        const parsed = parseStoreJson(await readFile(target, "utf8"));
        if (Array.isArray(parsed?.remotes)) listed = parsed.remotes.filter((remote) => typeof remote === "string" && remote);
      }
    } catch { /* An unreadable registration lists no remote. */ }
    remotes.set(name, listed);
  }
  return remotes;
}

// A code clone's remote comes from the store's registration, which any teammate can change, and it is fetched in the background,
// so no Git command of a code clone ever asks for a password: an empty GIT_ASKPASS ends Git's search for a prompt program before core.askPass and SSH_ASKPASS,
// with terminal prompts already off, SSH never asks, and Git Credential Manager runs without its dialogs; a credential helper that answers without asking still works.
// Git passes the -c settings and the environment on to the fetch that a blobless clone starts when a file is opened.
const NO_PROMPT_ENV = { GIT_ASKPASS: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never" };
const NO_PROMPT_CONFIG = ["-c", "core.askPass=", "-c", "credential.interactive=false"];

// One Git command in a clone, with the sanitized store environment and timeout, and never a password prompt.
const git = (folder, args) => runGit(folder, [...NO_PROMPT_CONFIG, ...args], { env: NO_PROMPT_ENV });

// The branches of a clone, { name, commit } sorted by name.
async function branchesOf(folder) {
  const listed = await git(folder, ["for-each-ref", "--format=%(refname)%00%(objectname)", BRANCHES]);
  if (!listed.ok) return [];
  return listed.text.split("\n").filter(Boolean).map((line) => {
    const [ref, commit] = line.split("\0");
    return { name: ref.slice(BRANCHES.length), commit };
  }).sort((left, right) => byText(left.name, right.name));
}

// The entries of a tree-ish below a folder, read from trees alone: { path, type, blob } for each blob or tree directly in it.
async function treeEntries(folder, commit, below, { recursive = false } = {}) {
  const listed = await git(folder, ["ls-tree", "-z", ...(recursive ? ["-r"] : []), commit, ...(below ? ["--", `${below}/`] : [])]);
  if (!listed.ok) return [];
  return listed.stdout.toString("utf8").split("\0").filter(Boolean).flatMap((line) => {
    const tab = line.indexOf("\t");
    const [, type, object] = line.slice(0, tab).split(" ");
    if (type !== "blob" && type !== "tree") return [];
    return [{ path: line.slice(tab + 1), type: type === "tree" ? "folder" : "file", blob: type === "blob" ? object : null }];
  });
}

// The blob of a path at a commit, read from trees alone, or null when the commit holds no file there.
async function blobAt(folder, commit, file) {
  const listed = await git(folder, ["ls-tree", "-z", commit, "--", file]);
  if (!listed.ok) return null;
  const line = listed.stdout.toString("utf8").split("\0").find((item) => item.slice(item.indexOf("\t") + 1) === file);
  if (!line) return null;
  const [, type, object] = line.slice(0, line.indexOf("\t")).split(" ");
  return type === "blob" ? object : null;
}

// A blob's bytes, which a blobless clone fetches from its remote now, or null when it is over the size limit or cannot be read.
async function blobBytes(folder, blob) {
  const size = await git(folder, ["cat-file", "-s", blob]);
  if (!size.ok || Number(size.text) > SOURCE_SIZE_LIMIT) return null;
  const read = await git(folder, ["cat-file", "blob", blob]);
  return read.ok ? read.stdout : null;
}

/**
 * The code content of one app folder: which repositories of which workspace have it on, each one's clone, and what the clones answer.
 * Every change and fetch of one clone runs one at a time, and the set of repositories with code content on is saved in the app folder after each change.
 */
export async function createCodeClones({ directory }) {
  const codeDirectory = path.join(directory, CODE);
  const savedFile = path.join(directory, SAVED);
  // Each entry is { workspace, repository, remote, clone, state, message, fetchedAt }, with clone the folder name below code/ and state on or unreachable.
  let entries = [];
  try {
    const parsed = parseStoreJson(await readFile(savedFile, "utf8"));
    if (Array.isArray(parsed?.repositories)) {
      entries = parsed.repositories.filter((entry) => entry && typeof entry.workspace === "string" && typeof entry.repository === "string" && typeof entry.remote === "string" && /^[0-9a-f]{16}\.git$/.test(entry.clone ?? ""))
        .map(({ workspace, repository, remote, clone, state, message, fetchedAt }) => ({ workspace, repository, remote, clone, state: state === "unreachable" ? "unreachable" : "on", message: typeof message === "string" ? message : null, fetchedAt: typeof fetchedAt === "string" ? fetchedAt : null }));
    }
  } catch { /* No saved code content yet. */ }

  const queues = new Map();
  const serial = (key, action) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(action);
    queues.set(key, run.catch(() => {}));
    return run;
  };
  const save = async () => {
    await mkdir(directory, { recursive: true });
    const temporary = `${savedFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, repositories: entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, savedFile);
  };
  const entryOf = (workspace, repository) => entries.find((entry) => entry.workspace === workspace && entry.repository === repository) ?? null;
  const folderOf = (entry) => path.join(codeDirectory, entry.clone);
  // Reads of the default branch's files, by clone folder and commit, so a link check lists a commit's tree once.
  const defaultFiles = new Map();

  // Clone the remote into a temporary sibling that is renamed into place, so code/ never holds a partial clone, and a failed clone leaves no folder.
  async function cloneInto(entry) {
    await mkdir(codeDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(codeDirectory, `.${entry.clone}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const cloned = await git(codeDirectory, ["-c", "transfer.fsckObjects=true", "-c", "clone.defaultRemoteName=origin", "clone", "--bare", "--quiet", "--filter=blob:none", "--no-local", "--no-tags", "--", entry.remote, temporary]);
      if (!cloned.ok) return { ok: false, message: reasonOf(cloned) };
      for (const setting of [["remote.origin.fetch", `+${BRANCHES}*:${BRANCHES}*`], ["remote.origin.tagOpt", "--no-tags"], ["gc.auto", "0"]]) {
        const set = await git(temporary, ["config", ...setting]);
        if (!set.ok) return { ok: false, message: reasonOf(set) };
      }
      await rename(temporary, folderOf(entry));
      return { ok: true };
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // Fetch every branch of the remote, removing branches that left it, and point HEAD at the branch that the remote's HEAD names now.
  async function fetchInto(entry) {
    const folder = folderOf(entry);
    const fetched = await git(folder, ["-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--prune", "--no-tags", "origin"]);
    if (!fetched.ok) return { ok: false, message: reasonOf(fetched) };
    const head = await git(folder, ["ls-remote", "--symref", "origin", "HEAD"]);
    const named = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head.ok ? head.text : "")?.[1];
    if (named) await git(folder, ["symbolic-ref", "HEAD", named]);
    return { ok: true };
  }

  // Bring one repository's clone up to date, cloning it when it is not there yet, and record whether its remote could be reached.
  function refresh(entry) {
    return serial(entry.clone, async () => {
      const cloned = await exists(folderOf(entry));
      const outcome = cloned ? await fetchInto(entry) : await cloneInto(entry);
      if (!entries.includes(entry)) return;
      if (outcome.ok) Object.assign(entry, { state: "on", message: null, fetchedAt: new Date().toISOString() });
      else Object.assign(entry, { state: "unreachable", message: cloned
        ? `Prism could not fetch the code of ${entry.repository}, so it shows what it fetched last: ${outcome.message}`
        : `Prism could not clone the code of ${entry.repository} and tries again at the next fetch: ${outcome.message}` });
      await save();
    });
  }

  // Drop a repository's entry, and its clone once no other entry uses the same remote.
  async function forget(entry) {
    entries = entries.filter((item) => item !== entry);
    await save();
    if (entries.some((item) => item.clone === entry.clone)) return;
    await serial(entry.clone, () => rm(folderOf(entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    for (const key of defaultFiles.keys()) if (key.startsWith(`${folderOf(entry)}\0`)) defaultFiles.delete(key);
  }

  // A repository's code state: off, on with its branches, or unreachable with Git's reason.
  async function stateOf(entry) {
    if (!entry) return { state: "off" };
    if (entry.state === "unreachable") return { state: "unreachable", message: entry.message, fetchedAt: entry.fetchedAt };
    return { state: "on", branches: await exists(folderOf(entry)) ? await branchesOf(folderOf(entry)) : [], fetchedAt: entry.fetchedAt };
  }

  // The folder of a repository's clone while its code content is on and the clone exists, else null.
  async function cloneOf(workspace, repository) {
    const entry = entryOf(workspace, repository);
    return entry && await exists(folderOf(entry)) ? folderOf(entry) : null;
  }

  return {
    /** Turn a repository's code content on with the remote its registration lists first, clone or fetch it, and answer its code state. */
    async enable(workspace, repository, remote) {
      const identity = await storeIdentity(remote);
      if (!identity || identity.startsWith("file:")) throw Object.assign(new Error(`The repository ${repository} registers no network remote, so Prism cannot keep a clone of its code.`), { status: 409, code: "no_remote" });
      const clone = `${sha16(identity)}.git`;
      // The list of repositories changes one request at a time, so two requests never add one repository twice.
      const entry = await serial(SAVED, async () => {
        const found = entryOf(workspace, repository);
        if (found?.clone === clone) return found;
        if (found) await forget(found);
        const added = { workspace, repository, remote, clone, state: "on", message: null, fetchedAt: null };
        entries.push(added);
        await save();
        return added;
      });
      await refresh(entry);
      return stateOf(entry);
    },

    /** Turn a repository's code content off and delete its clone, unless another workspace's repository still has the same remote's code on. */
    async disable(workspace, repository) {
      await serial(SAVED, async () => {
        const entry = entryOf(workspace, repository);
        if (entry) await forget(entry);
      });
      return { state: "off" };
    },

    /** Turn code content off for every repository of a workspace, as disable does for each. */
    async disableWorkspace(workspace) {
      await serial(SAVED, async () => {
        for (const entry of entries.filter((item) => item.workspace === workspace)) await forget(entry);
      });
    },

    /** The code state of a repository of a workspace. */
    state: (workspace, repository) => stateOf(entryOf(workspace, repository)),

    /** Fetch every repository of a workspace whose code content is on. */
    async fetchAll(workspace) {
      await Promise.all(entries.filter((entry) => entry.workspace === workspace).map((entry) => refresh(entry)));
    },

    /** The entries of a folder on every branch: { path, type, branches } sorted by path, branches { branch, blob } sorted by branch; null without a clone. */
    async tree(workspace, repository, folder) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      const byPath = new Map();
      for (const branch of await branchesOf(base)) {
        for (const entry of await treeEntries(base, branch.commit, folder)) {
          const key = `${entry.type}\0${entry.path}`;
          if (!byPath.has(key)) byPath.set(key, { path: entry.path, type: entry.type, branches: [] });
          byPath.get(key).branches.push({ branch: branch.name, blob: entry.blob });
        }
      }
      return [...byPath.values()].sort((left, right) => byText(left.path, right.path) || byText(left.type, right.type));
    },

    /**
     * A file read from the clone at a branch or a commit that a branch holds: { repository, branch, commit, path, blob, bytes, content }, fetching its contents only now;
     * null for no clone, an unknown branch or commit, a path the commit does not hold as a file, a secret, a binary file, or a file over 512 KiB.
     */
    async file(workspace, repository, { branch = null, commit = null, path: file }) {
      const base = await cloneOf(workspace, repository);
      if (!base || typeof file !== "string" || codeFolder(file) === null || codeFolder(file) === "" || secretPath(file) || binaryPath(file)) return null;
      const branches = await branchesOf(base);
      let at = null;
      if (branch !== null) at = branches.find((item) => item.name === branch)?.commit ?? null;
      else if (typeof commit === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) {
        // Only a commit on a branch of the clone is read, so no read asks the remote for a commit that no branch holds.
        const held = await git(base, ["rev-list", "--branches"]);
        if (held.ok && held.text.split("\n").includes(commit)) at = commit;
      }
      if (at === null) return null;
      const blob = await blobAt(base, at, codeFolder(file));
      if (!blob) return null;
      const bytes = await blobBytes(base, blob);
      if (bytes === null || bytes.includes(0)) return null;
      return { repository, branch: branch ?? null, commit: at, path: codeFolder(file), blob, bytes: bytes.length, content: bytes.toString("utf8") };
    },

    /** A file read from the clone at the remote's default branch, as file reads one, or null where file answers null. */
    async defaultFile(workspace, repository, file) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      const head = await git(base, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!head.ok || !head.text.startsWith(BRANCHES)) return null;
      return this.file(workspace, repository, { branch: head.text.slice(BRANCHES.length), path: file });
    },

    /** The files of the remote's default branch that a link may open, as a Set of paths without secrets, or null without a clone or a default branch. */
    async defaultFiles(workspace, repository) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      const head = await git(base, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!head.ok || !head.text.startsWith(BRANCHES)) return null;
      const commit = (await branchesOf(base)).find((item) => item.name === head.text.slice(BRANCHES.length))?.commit;
      if (!commit) return null;
      const key = `${base}\0${commit}`;
      if (!defaultFiles.has(key)) {
        for (const known of defaultFiles.keys()) if (known.startsWith(`${base}\0`)) defaultFiles.delete(known);
        defaultFiles.set(key, treeEntries(base, commit, "", { recursive: true }).then((listed) => new Set(listed.filter((entry) => entry.type === "file" && !secretPath(entry.path)).map((entry) => entry.path))));
      }
      return defaultFiles.get(key);
    },

    /** The components each branch's .prism/workflow.md declares: { components, problems }, or null without a clone. */
    async components(workspace, repository) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      const found = new Map();
      const problems = [];
      for (const branch of await branchesOf(base)) {
        const blob = await blobAt(base, branch.commit, ".prism/workflow.md");
        if (!blob) continue;
        const bytes = await blobBytes(base, blob);
        if (bytes === null) {
          problems.push({ branch: branch.name, message: "The branch's .prism/workflow.md cannot be read or is over 512 KiB." });
          continue;
        }
        let declaration;
        try { declaration = readComponents(parseWorkflowConfig(bytes.toString("utf8"))); }
        catch (error) {
          if (!(error instanceof ComponentError)) throw error;
          problems.push({ branch: branch.name, message: error.message });
          continue;
        }
        for (const component of declaration.declared) {
          const identity = `${repository}/${component.name}`;
          const key = `${identity}\0${component.folder}`;
          if (!found.has(key)) found.set(key, { identity, folder: component.folder, branches: [] });
          found.get(key).branches.push(branch.name);
        }
      }
      return { components: [...found.values()].sort((left, right) => byText(left.identity, right.identity) || byText(left.folder, right.folder)), problems };
    }
  };
}
