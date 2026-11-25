import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ComponentError, readComponents } from "../workflow/components.mjs";
import { ReadFailed, byteCache } from "./byte-cache.mjs";
import { byCodePoint, createBranchReader, tipsKeyOf } from "./code-branches.mjs";
import { runGit, runGitLines } from "../workflow/record-store-sync.mjs";
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
// How long a branches request waits for a fetch that a request started because none ran within the fetch interval, from the fetch's start.
const FETCH_WAIT_MS = 3000;
// How many branches other than the default one an answer about where a commit is names, so a commit that many branches are built on stays a short answer.
const BRANCHES_SHOWN = 5;

const sha16 = (value: any) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const byText = (left: any, right: any) => (left < right ? -1 : left > right ? 1 : 0);
const exists = (target: string) => stat(target).then(() => true, () => false);

// Git's reason without any URL in it, so no answer of a code route names a Git host.
const withoutUrls = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "the repository's remote").replace(/\b[^\s@'"/]+@[A-Za-z0-9.-]+:[^\s'"]+/g, "the repository's remote");
const reasonOf = (result: any) => withoutUrls(gitReason(result.stderr || `git exited with code ${result.code}`));

// A folder below the repository's root as a code route names it, or null when it climbs out or is no plain relative path; "" is the root.
export function codeFolder(value: any) {
  const trimmed = String(value ?? "").replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  if (/[\\\0]/.test(trimmed)) return null;
  return trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? null : trimmed;
}

/** The registered remotes of each repository of a store folder, by name: the remotes its registration lists, in order, or none when it lists none or cannot be read. */
export async function registeredRemotes(folder: string) {
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
        if (Array.isArray(parsed?.remotes)) listed = parsed.remotes.filter((remote: any) => typeof remote === "string" && remote);
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
// A command that reads a blob may fetch it from the remote, so it says it connects, and its SSH command is the person's own in batch mode as a fetch's is.
const git = (folder: string, args: string[], { connects = false, input }: any = {}) => runGit(folder, [...NO_PROMPT_CONFIG, ...args], { env: NO_PROMPT_ENV, connects, ...(input !== undefined ? { input } : {}) });
// A Git runner for a clone's branch reader, which streams a command's lines to line when the reader asks, so a listing it stops early is read no further,
// and writes input, when given, to Git's standard input.
const branchGit = (folder: string) => (args: string[], { line, maxRecord, input }: { line?: (line: string) => boolean; maxRecord?: number; input?: string } = {}) =>
  line ? runGitLines(folder, [...NO_PROMPT_CONFIG, ...args], { env: NO_PROMPT_ENV, take: line, ...(maxRecord ? { maxRecord } : {}), ...(input !== undefined ? { input } : {}) }) : git(folder, args, { input });

// The branches of a clone, { name, commit } in code-point order of their names, as the branch reader sorts them.
async function branchesOf(folder: string) {
  const listed = await git(folder, ["for-each-ref", "--format=%(refname)%00%(objectname)", BRANCHES]);
  if (!listed.ok) return [];
  return listed.text.split("\n").filter(Boolean).map((line) => {
    const [ref, commit] = line.split("\0");
    return { name: ref.slice(BRANCHES.length), commit };
  }).sort((left, right) => byCodePoint(left.name, right.name));
}

// The entries of a tree-ish below a folder, read from trees alone: { path, type, blob } for each blob or tree directly in it.
async function treeEntries(folder: string, commit: string, below: any, { recursive = false }: any = {}) {
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
async function blobAt(folder: string, commit: string, file: any) {
  const listed = await git(folder, ["ls-tree", "-z", commit, "--", file]);
  if (!listed.ok) return null;
  const line = listed.stdout.toString("utf8").split("\0").find((item) => item.slice(item.indexOf("\t") + 1) === file);
  if (!line) return null;
  const [, type, object] = line.slice(0, line.indexOf("\t")).split(" ");
  return type === "blob" ? object : null;
}

// A blob's bytes, which a blobless clone fetches from its remote now, or null when it is over the size limit or cannot be read.
async function blobBytes(folder: string, blob: any) {
  const size = await git(folder, ["cat-file", "-s", blob], { connects: true });
  if (!size.ok || Number(size.text) > SOURCE_SIZE_LIMIT) return null;
  const read = await git(folder, ["cat-file", "blob", blob], { connects: true });
  return read.ok ? read.stdout : null;
}

// The Git commands of a clone's file reads, whose paths Git takes literally, so no pathspec magic in a requested path widens what a read names.
const literalGit = (folder: string, args: string[], { connects = false }: { connects?: boolean } = {}) =>
  runGit(folder, [...NO_PROMPT_CONFIG, ...args], { env: { ...NO_PROMPT_ENV, GIT_LITERAL_PATHSPECS: "1" }, connects });
const isObject = (value: any) => typeof value === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
// The bytes of tree listings that the file reads of one clone keep, by commit and folder, which never change for a commit:
// a listing is about 220 bytes of memory for each entry, so a folder of 200000 entries, about 44 MB, is read but never kept, and the kept listings never exceed this bound however many commits a file is read at.
const LISTINGS_BYTES = 16 * 1024 * 1024;
// The bytes of components declarations, by blob and by commit, and of small answers, the blob of one path at one commit, whether a blob is shown, and a merge check,
// that the file reads of one clone keep; each small answer is a few hundred bytes at most, so each cache holds a few thousand of them.
const DECLARATIONS_BYTES = 4 * 1024 * 1024;
const SMALL_BYTES = 1024 * 1024;
// The estimated bytes of memory that a kept value holds.
const jsonBytes = (value: any) => 2 * (JSON.stringify(value)?.length ?? 4) + 64;
const listingBytes = (listed: { name: string }[]) => listed.reduce((sum, entry) => sum + 2 * entry.name.length + 220, 64);

/**
 * The file reads of one clone that the Code place's files, versions, and differences need, given commits and blobs that the clone's branch model names
 * and paths that codeFolder accepts: tree listings and blobs at a commit read from trees alone, and a blob's bytes, a difference, or a merge check fetched only for the opened path.
 * What it keeps is bounded by bytes, as LISTINGS_BYTES, DECLARATIONS_BYTES, and SMALL_BYTES state, and no text or difference is kept.
 * A Git read that fails, such as a lazy fetch of a blob while the remote is unreachable, throws ReadFailed rather than answering as if the clone held nothing there,
 * and no cache keeps it, so a later read runs Git again; run is the Git runner, which a test may replace.
 * Nothing is written outside a temporary folder that a merge check of a removed or absent side uses and deletes.
 */
export function cloneContents(folder: string, repository: string, { run = literalGit }: { run?: typeof literalGit } = {}) {
  const failed = (what: string) => new ReadFailed(`Prism could not read ${what} from its clone of ${repository} now, for example because its remote is unreachable for an object that the clone has not fetched yet, so it keeps no answer and reads again at the next request.`);
  const listings = byteCache<{ name: string; type: string; blob: string | null }[]>(LISTINGS_BYTES, listingBytes);
  const declarations = byteCache<any>(DECLARATIONS_BYTES, jsonBytes);
  const atCommits = byteCache<any>(DECLARATIONS_BYTES, jsonBytes);
  const blobs = byteCache<string | null>(SMALL_BYTES, jsonBytes);
  const shown = byteCache<any>(SMALL_BYTES, jsonBytes);
  const merges = byteCache<boolean | null>(SMALL_BYTES, jsonBytes);
  // The files and folders directly in a folder of a commit, "" for the root, as { name, type, blob }.
  async function entries(commit: string, below: string) {
    if (!isObject(commit)) return [];
    return listings.read(`${commit}\0${below}`, async () => {
      const listed = await run(folder, ["ls-tree", "-z", commit, ...(below ? ["--", `${below}/`] : [])]);
      if (!listed.ok) throw failed("a folder's entries");
      const prefix = below ? `${below}/` : "";
      return listed.stdout.toString("utf8").split("\0").filter(Boolean).flatMap((line) => {
        const tab = line.indexOf("\t");
        const [, type, object] = line.slice(0, tab).split(" ");
        const file = line.slice(tab + 1);
        if ((type !== "blob" && type !== "tree") || !file.startsWith(prefix) || file.slice(prefix.length).includes("/")) return [];
        return [{ name: file.slice(prefix.length), type: type === "tree" ? "folder" : "file", blob: type === "blob" ? object : null }];
      });
    });
  }
  // The blob of a file at a commit, or null where the commit holds no file there, read as that one path, so no read lists the folder that holds it.
  async function blobOf(commit: string | null, file: string) {
    if (!commit || !isObject(commit)) return null;
    return blobs.read(`${commit}\0${file}`, async () => {
      const listed = await run(folder, ["ls-tree", "-z", commit, "--", file]);
      if (!listed.ok) throw failed("a file's object");
      const line = listed.stdout.toString("utf8").split("\0").find((item) => item.slice(item.indexOf("\t") + 1) === file);
      if (!line) return null;
      const [, type, object] = line.slice(0, line.indexOf("\t")).split(" ");
      return type === "blob" && isObject(object) ? object : null;
    });
  }
  // A blob's text: { text, lines } for a shown file, { withheld: "binary" | "too_large" } for one the review app does not show, or null for a value that names no object.
  async function read(blob: string) {
    if (!isObject(blob)) return null;
    const size = await run(folder, ["cat-file", "-s", blob], { connects: true });
    if (!size.ok) throw failed("a file's content");
    if (Number(size.text) > SOURCE_SIZE_LIMIT) return { withheld: "too_large" };
    const bytes = await run(folder, ["cat-file", "blob", blob], { connects: true });
    if (!bytes.ok) throw failed("a file's content");
    if (bytes.stdout.length > SOURCE_SIZE_LIMIT) return { withheld: "too_large" };
    if (bytes.stdout.includes(0)) return { withheld: "binary" };
    const text = bytes.stdout.toString("utf8");
    return { text, lines: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  }
  // Whether the review app shows a blob, kept by blob: { lines } for a shown file, { withheld } for one it does not show, or null for a value that names no object.
  async function shownOf(blob: string) {
    return shown.read(blob, () => read(blob).then((text) => (text === null ? null : "withheld" in text ? { withheld: text.withheld } : { lines: text.lines as number })));
  }
  // Git's difference of two blobs that the caller found shown as hunks { before: [from, count], after: [from, count], lines }, or null for a value that names no object:
  // when whole, with lines context lines, enough to cover every unchanged line, and each hunk's lines "+", "-", or " " and its text;
  // otherwise without context and with each hunk's lines empty. Nothing is kept.
  async function diff(before: string, after: string, { whole = false, lines = 0 }: { whole?: boolean; lines?: number } = {}): Promise<any[] | null> {
    if (!isObject(before) || !isObject(after)) return null;
    const listed = await run(folder, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-algorithm=myers", `--unified=${whole ? lines : 0}`, before, after], { connects: true });
    if (!listed.ok) throw failed("a file's difference");
    const hunks: any[] = [];
    for (const line of listed.stdout.toString("utf8").split("\n")) {
      const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (head) hunks.push({ before: [Number(head[1]), head[2] === undefined ? 1 : Number(head[2])], after: [Number(head[3]), head[4] === undefined ? 1 : Number(head[4])], lines: [] });
      else if (whole && hunks.length && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) hunks.at(-1).lines.push(line);
    }
    return hunks;
  }
  // Whether Git's three-way merge of a file conflicts, from the blobs of the merge base and of two sides, a null blob being a file absent there:
  // true or false, or null when a side is not shown. Blobs are merged in Git's object store,
  // and a merge with an absent side, or by a Git without merge-file --object-id, writes the three texts to a temporary folder that it deletes.
  async function conflicts(base: string | null, first: string | null, second: string | null) {
    return merges.read(`${base ?? ""}\0${first ?? ""}\0${second ?? ""}`, async () => {
      if (base && first && second) {
        const merged = await run(folder, ["merge-file", "-p", "-q", "--object-id", first, base, second], { connects: true });
        if (merged.ok) return false;
        if (merged.code > 0 && merged.code < 128) return true;
      }
      const texts = await Promise.all([first, base, second].map(async (blob) => (blob === null ? "" : (await read(blob))?.text ?? null)));
      if (texts.some((text) => typeof text !== "string")) return null;
      const temporary = await mkdtemp(path.join(os.tmpdir(), "prism-merge-"));
      try {
        const files = ["first", "base", "second"].map((name) => path.join(temporary, name));
        await Promise.all(files.map((file, index) => writeFile(file, texts[index] as string, { mode: 0o600 })));
        const merged = await run(temporary, ["merge-file", "-p", "-q", ...files]);
        if (merged.ok) return false;
        if (merged.code > 0 && merged.code < 128) return true;
        throw failed("a merge check");
      } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
  // The components that a commit's .prism/workflow.md declares, as { declared: [{ name, folder }], file } with file false when the commit holds none,
  // or null when it cannot be read or declares them wrongly.
  async function components(commit: string): Promise<{ declared: { name: string; folder: string }[]; file: boolean } | null> {
    return atCommits.read(commit, () => declaredAt(commit));
  }
  async function declaredAt(commit: string) {
    const blob = await blobOf(commit, ".prism/workflow.md");
    if (!blob) return { declared: [], file: false };
    return declarations.read(blob, async () => {
      const text = await read(blob);
      if (!text || !("text" in text)) return null;
      try { return { declared: readComponents(parseWorkflowConfig(text.text as string)).declared.map((component: any) => ({ name: component.name, folder: component.folder })), file: true }; }
      catch (error) {
        if (error instanceof ComponentError) return null;
        throw error;
      }
    });
  }
  return { repository, entries, blobOf, read, shownOf, diff, conflicts, components };
}

/**
 * The code content of one app folder: which repositories of which workspace have it on, each one's clone, and what the clones answer.
 * Every change and fetch of one clone runs one at a time, and the set of repositories with code content on is saved in the app folder after each change.
 * Whenever any fetch or clone, whether a workspace's fetch or one that a Code request started, changes a clone's branch tips or default branch,
 * onTipsMoved is called once for each workspace with code content on from that clone, after the fetch has ended.
 */
export async function createCodeClones({ directory, onTipsMoved = () => {} }: { directory: string; onTipsMoved?: (workspace: any) => void }) {
  const codeDirectory = path.join(directory, CODE);
  const savedFile = path.join(directory, SAVED);
  // Each entry is { workspace, repository, remote, clone, state, message, fetchedAt }, with clone the folder name below code/ and state on or unreachable.
  let entries: any[] = [];
  try {
    const parsed = parseStoreJson(await readFile(savedFile, "utf8"));
    if (Array.isArray(parsed?.repositories)) {
      entries = parsed.repositories.filter((entry: any) => entry && typeof entry.workspace === "string" && typeof entry.repository === "string" && typeof entry.remote === "string" && /^[0-9a-f]{16}\.git$/.test(entry.clone ?? ""))
        .map(({ workspace, repository, remote, clone, state, message, fetchedAt }: { workspace: any; repository: string; remote: any; clone: any; state: any; message: any; fetchedAt: any }) => ({ workspace, repository, remote, clone, state: state === "unreachable" ? "unreachable" : "on", message: typeof message === "string" ? message : null, fetchedAt: typeof fetchedAt === "string" ? fetchedAt : null }));
    }
  } catch { /* No saved code content yet. */ }

  const queues = new Map();
  const serial = (key: any, action: any) => {
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
  // The commits that the branches of a clone hold, by clone folder and branch tips, so a page that asks about many commits lists the history once.
  const heldCommits = new Map();
  async function commitsOf(folder: string) {
    const tips = (await branchesOf(folder)).map((branch) => branch.commit).join(" ");
    const cached = heldCommits.get(folder);
    if (cached?.tips === tips) return cached.commits;
    // rev-list reads only commits the clone holds, so no question about a commit that no branch holds reaches the remote.
    const listed = await git(folder, ["rev-list", "--branches"]);
    const commits = listed.ok ? new Set(listed.text.split("\n").filter(Boolean)) : new Set();
    heldCommits.set(folder, { tips, commits });
    return commits;
  }
  const isCommit = (value: any) => typeof value === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
  const entryOf = (workspace: any, repository: string) => entries.find((entry) => entry.workspace === workspace && entry.repository === repository) ?? null;
  const folderOf = (entry: any) => path.join(codeDirectory, entry.clone);
  // Reads of the default branch's files, by clone folder and commit, so a link check lists a commit's tree once.
  const defaultFiles = new Map();
  // The branch reader of each clone, by clone folder, which reads one set of tips at a time in the background and keeps its answer.
  const branchReaders = new Map<string, ReturnType<typeof createBranchReader>>();
  // The file reads of each clone, by clone folder, with the tree listings and declarations they keep.
  const fileReads = new Map<string, ReturnType<typeof cloneContents>>();
  // When each entry's latest fetch started or ended, and the fetch that a Code request started because none ran within the fetch interval, kept apart from the saved entries.
  const attempts = new WeakMap<any, number>();
  const demanded = new WeakMap<any, { done: Promise<void>; started: number }>();
  // How many fetches or clones of each clone folder are under way, whichever entry or request started them.
  const fetching = new Map<string, number>();

  // Clone the remote into a temporary sibling that is renamed into place, so code/ never holds a partial clone, and a failed clone leaves no folder.
  async function cloneInto(entry: any) {
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
  async function fetchInto(entry: any) {
    const folder = folderOf(entry);
    const fetched = await git(folder, ["-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--prune", "--no-tags", "origin"]);
    if (!fetched.ok) return { ok: false, message: reasonOf(fetched) };
    const head = await git(folder, ["ls-remote", "--symref", "origin", "HEAD"]);
    const named = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head.ok ? head.text : "")?.[1];
    if (named) await git(folder, ["symbolic-ref", "HEAD", named]);
    return { ok: true };
  }

  // The key of a clone's branch tips and default branch, "" while it has no clone.
  async function tipsOf(folder: string) {
    if (!(await exists(folder))) return "";
    const head = await git(folder, ["symbolic-ref", "--quiet", "HEAD"]);
    return tipsKeyOf(head.ok ? head.text.trim() : "", await branchesOf(folder));
  }

  // Bring one repository's clone up to date, cloning it when it is not there yet, and record whether its remote could be reached,
  // answering whether the fetch changed the clone's branch tips or default branch.
  function refresh(entry: any): Promise<boolean> {
    attempts.set(entry, Date.now());
    const clone = entry.clone;
    fetching.set(clone, (fetching.get(clone) ?? 0) + 1);
    let moved = false;
    return serial(entry.clone, async () => {
      const cloned = await exists(folderOf(entry));
      const before = await tipsOf(folderOf(entry));
      const outcome = cloned ? await fetchInto(entry) : await cloneInto(entry);
      // A fetch that fails may still have moved some tips, so the tips are compared whatever its outcome.
      moved = (await tipsOf(folderOf(entry))) !== before;
      if (!entries.includes(entry)) return moved;
      if (outcome.ok) Object.assign(entry, { state: "on", message: null, fetchedAt: new Date().toISOString() });
      else Object.assign(entry, { state: "unreachable", message: cloned
        ? `Prism could not fetch the code of ${entry.repository}, so it shows what it fetched last: ${outcome.message}`
        : `Prism could not clone the code of ${entry.repository} and tries again at the next fetch: ${outcome.message}` });
      await save();
      return moved;
    }).finally(() => {
      attempts.set(entry, Date.now());
      if (fetching.get(clone) === 1) fetching.delete(clone);
      else fetching.set(clone, fetching.get(clone)! - 1);
      // The workspaces hear of moved tips once the fetch has ended, so a page that asks again reads the new tips rather than an answer held while the fetch ran.
      if (!moved) return;
      for (const workspace of new Set(entries.filter((item) => item.clone === clone).map((item) => item.workspace))) {
        try { onTipsMoved(workspace); } catch { /* A listener's failure never fails the fetch. */ }
      }
    });
  }

  // Drop a repository's entry, and its clone once no other entry uses the same remote.
  async function forget(entry: any) {
    entries = entries.filter((item) => item !== entry);
    await save();
    if (entries.some((item) => item.clone === entry.clone)) return;
    await serial(entry.clone, () => rm(folderOf(entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    for (const key of defaultFiles.keys()) if (key.startsWith(`${folderOf(entry)}\0`)) defaultFiles.delete(key);
    heldCommits.delete(folderOf(entry));
    branchReaders.delete(folderOf(entry));
    fileReads.delete(folderOf(entry));
  }

  // A repository's code state: off, on with its branches, or unreachable with Git's reason and the branches of the clone it fetched last, none when it never cloned.
  async function stateOf(entry: any) {
    if (!entry) return { state: "off" };
    const branches = await exists(folderOf(entry)) ? await branchesOf(folderOf(entry)) : [];
    if (entry.state === "unreachable") return { state: "unreachable", message: entry.message, branches, fetchedAt: entry.fetchedAt };
    return { state: "on", branches, fetchedAt: entry.fetchedAt };
  }

  // The folder of a repository's clone while its code content is on and the clone exists, else null.
  async function cloneOf(workspace: any, repository: string) {
    const entry = entryOf(workspace, repository);
    return entry && await exists(folderOf(entry)) ? folderOf(entry) : null;
  }

  return {
    /** Turn a repository's code content on with the remote its registration lists first, clone or fetch it, and answer its code state. */
    async enable(workspace: any, repository: string, remote: any) {
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
    async disable(workspace: any, repository: string) {
      await serial(SAVED, async () => {
        const entry = entryOf(workspace, repository);
        if (entry) await forget(entry);
      });
      return { state: "off" };
    },

    /** Turn code content off for every repository of a workspace, as disable does for each. */
    async disableWorkspace(workspace: any) {
      await serial(SAVED, async () => {
        for (const entry of entries.filter((item) => item.workspace === workspace)) await forget(entry);
      });
    },

    /** The code state of a repository of a workspace. */
    state: (workspace: any, repository: string) => stateOf(entryOf(workspace, repository)),

    /** Fetch every repository of a workspace whose code content is on, answering whether any fetch changed a clone's branch tips or default branch. */
    async fetchAll(workspace: any) {
      const changed = await Promise.all(entries.filter((entry) => entry.workspace === workspace).map((entry) => refresh(entry)));
      return changed.some(Boolean);
    },

    /** The entries of a folder on every branch: { path, type, branches } sorted by path, branches { branch, blob } sorted by branch; null without a clone. */
    async tree(workspace: any, repository: string, folder: string) {
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
     * { repository, branch, commit, path, blob, withheld } with withheld binary or too_large for a file it holds but does not show,
     * and null for no clone, an unknown branch or commit, a path the commit does not hold as a file, or a secret.
     */
    async file(workspace: any, repository: string, { branch = null, commit = null, path: file }: { branch?: string | null; commit?: string | null; path: any }) {
      const base = await cloneOf(workspace, repository);
      if (!base || typeof file !== "string" || codeFolder(file) === null || codeFolder(file) === "" || secretPath(file)) return null;
      const branches = await branchesOf(base);
      let at = null;
      if (branch !== null) at = branches.find((item) => item.name === branch)?.commit ?? null;
      // Only a commit on a branch of the clone is read, so no read asks the remote for a commit that no branch holds.
      else if (isCommit(commit) && (await commitsOf(base)).has(commit)) at = commit;
      if (at === null) return null;
      const blob = await blobAt(base, at, codeFolder(file));
      if (!blob) return null;
      // A binary or large file is held but not shown, which the answer says apart from a file the commit does not hold.
      const held = { repository, branch: branch ?? null, commit: at, path: codeFolder(file), blob };
      if (binaryPath(file)) return { ...held, withheld: "binary" };
      const size = await git(base, ["cat-file", "-s", blob], { connects: true });
      if (!size.ok) return null;
      if (Number(size.text) > SOURCE_SIZE_LIMIT) return { ...held, withheld: "too_large" };
      const bytes = await blobBytes(base, blob);
      if (bytes === null) return null;
      if (bytes.includes(0)) return { ...held, withheld: "binary" };
      return { ...held, bytes: bytes.length, content: bytes.toString("utf8") };
    },

    /**
     * The branch model of the repository's clone, as readBranches answers it for the names of the branches that a slice owns: { defaultBranch, branches },
     * { state: "preparing" } while Prism still clones the repository or reads the branches of the clone's current tips and default branch in the background, or null without a clone.
     * When no fetch of the clone ran within freshMs, as on a workspace that no page has open, it starts one and waits for it up to FETCH_WAIT_MS from its start,
     * so an answer follows a push that the remote holds, a slow remote holds a request no longer than that, and an answer for the tips that the clone holds is never withheld;
     * while any fetch runs on, it answers only an answer already read and starts no read, since the fetch may be moving the tips one branch at a time.
     * With waitMs, a read that this call leaves preparing is awaited up to waitMs from the end of that wait, so a small repository answers at once rather than on a later request.
     */
    async branches(workspace: any, repository: string, owned: Iterable<string> = [], { freshMs = null, waitMs = 0 }: { freshMs?: number | null; waitMs?: number } = {}) {
      const entry = entryOf(workspace, repository);
      if (!entry) return null;
      const folder = folderOf(entry);
      // A fetch waits while a read runs, since new tips would supersede it, and freshness counts from the end of the latest fetch, so a slow fetch is not followed by another at once.
      const fetchIfDue = () => {
        if (freshMs === null || demanded.has(entry) || branchReaders.get(folder)?.reading || Date.now() - (attempts.get(entry) ?? 0) <= freshMs) return;
        const started = Date.now();
        const done = refresh(entry).then(() => {}, () => {}).finally(() => demanded.delete(entry));
        demanded.set(entry, { done, started });
      };
      fetchIfDue();
      const asked = demanded.get(entry);
      if (asked) {
        let timer: NodeJS.Timeout | undefined;
        const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, asked.started + FETCH_WAIT_MS - Date.now())); });
        await Promise.race([asked.done, waited]);
        clearTimeout(timer);
      }
      if (!(await exists(folder))) return null;
      const head = await git(folder, ["symbolic-ref", "--quiet", "HEAD"]);
      const tipsKey = tipsKeyOf(head.ok ? head.text.trim() : "", await branchesOf(folder));
      if (!branchReaders.has(folder)) branchReaders.set(folder, createBranchReader(branchGit(folder)));
      const reader = branchReaders.get(folder)!;
      // A running fetch may be moving the tips one branch at a time, so while it runs only an answer already read goes out, and no read starts for tips it may still move.
      if (fetching.has(entry.clone)) return reader.ready(tipsKey, owned) ?? { state: "preparing" };
      let model = reader.answer(tipsKey, owned);
      if (model === undefined && waitMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
        await Promise.race([reader.idle(), waited]);
        clearTimeout(timer);
        model = reader.ready(tipsKey, owned);
      }
      // A read that ended while this request waited held back a fetch that may be due now, which starts while the ready answer goes out.
      if (model !== undefined) fetchIfDue();
      return model ?? { state: "preparing" };
    },

    /** The file reads of the repository's clone that the Code place's files, versions, and differences need, or null without a clone. */
    async contents(workspace: any, repository: string) {
      const folder = await cloneOf(workspace, repository);
      if (!folder) return null;
      if (!fileReads.has(folder)) fileReads.set(folder, cloneContents(folder, repository));
      return fileReads.get(folder)!;
    },

    /** Whether a branch of the repository's clone holds a commit: true or false, or null without a clone. */
    async reachable(workspace: any, repository: string, commit: string) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      return isCommit(commit) && (await commitsOf(base)).has(commit);
    },

    /**
     * Where a commit is in the clone: { defaultBranch, onDefault, branches, branchCount } with defaultBranch the branch the remote's HEAD names or null,
     * onDefault whether that branch holds the commit, and branches the first BRANCHES_SHOWN other branches by name that hold it, of branchCount in all;
     * or null without a clone or for a commit that no branch holds.
     */
    async branchesHolding(workspace: any, repository: string, commit: string) {
      const base = await cloneOf(workspace, repository);
      if (!base || !isCommit(commit) || !(await commitsOf(base)).has(commit)) return null;
      const head = await git(base, ["symbolic-ref", "--quiet", "HEAD"]);
      const defaultBranch = head.ok && head.text.trim().startsWith(BRANCHES) ? head.text.trim().slice(BRANCHES.length) : null;
      const listed = await git(base, ["for-each-ref", "--format=%(refname)", "--contains", commit, BRANCHES]);
      if (!listed.ok) return null;
      const holding = listed.text.split("\n").filter(Boolean).map((ref) => ref.slice(BRANCHES.length)).sort(byCodePoint);
      const others = holding.filter((name) => name !== defaultBranch);
      return { defaultBranch, onDefault: defaultBranch !== null && holding.includes(defaultBranch), branches: others.slice(0, BRANCHES_SHOWN), branchCount: others.length };
    },

    /**
     * The blob of each path at a commit that a branch of the clone holds, read from trees alone: a Map of path to blob, null where the commit holds no file there,
     * or null without a clone or for a commit that no branch holds.
     */
    async blobs(workspace: any, repository: string, commit: string, paths: string[]) {
      const base = await cloneOf(workspace, repository);
      if (!base || !isCommit(commit) || !(await commitsOf(base)).has(commit)) return null;
      const files = new Map((await treeEntries(base, commit, "", { recursive: true })).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.blob]));
      return new Map(paths.map((file: string) => [file, files.get(file) ?? null]));
    },

    /** A file read from the clone at the remote's default branch, as file reads one, or null where file answers null. */
    async defaultFile(workspace: any, repository: string, file: string) {
      const base = await cloneOf(workspace, repository);
      if (!base) return null;
      const head = await git(base, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!head.ok || !head.text.startsWith(BRANCHES)) return null;
      return this.file(workspace, repository, { branch: head.text.slice(BRANCHES.length), path: file });
    },

    /** The files of the remote's default branch that a link may open, as a Set of paths without secrets, or null without a clone or a default branch. */
    async defaultFiles(workspace: any, repository: string) {
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
    async components(workspace: any, repository: string) {
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
