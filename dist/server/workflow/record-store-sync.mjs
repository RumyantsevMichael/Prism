// Generated from src/server/workflow/record-store-sync.mts by scripts/native-build/compile.mjs.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS, ARTIFACT_STATUS, ARTIFACTS, IDENTITY_FILE_MAX, identityContent, identityOf, letterCaseKey, locationIdentity, STATUS_RECORD_NAME, uniqueIdentities, portableName, STORE_NAME_BYTES_MAX, STORE_PATH_BYTES_MAX, storePathFits, wellFormedName } from "./artifact-paths.mjs";
import { markArtifactIndexStale } from "./artifact-index.mjs";
import { renameWhenFree, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { commitProblem, gitFileName, isLinkMode, LINK_TARGET_BYTES_MAX, linkTargetProblem, TREE_DEPTH_MAX, TREE_DEPTH_TEXT, tooDeepTree, treeEntries, treeProblems } from "./git-objects.mjs";
import { canonicalJson, hasRecordMerge, nestedDeeperThan, recordMergeFor } from "./record-merge.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { localRepository, localTransport, UnresolvableLocalRemote } from "./git-local-repository.mjs";
import { withoutCredentials } from "./remote-url.mjs";
import { parseStoreJson } from "./store-json.mjs";
const SYNC_DIRECTORY = ".prism-sync";
const SETTINGS = { debounceMs: 5e3, pullIntervalMs: 3e4, waitMs: 1e4, applyLockMs: 2e3, gitTimeoutMs: 12e4, treeFilesMax: null, historyBytesMax: null };
let pullOnRead = true;
const PUSH_ATTEMPTS = 3;
const COMMIT_LIST = 20;
const scheduled = /* @__PURE__ */ new Map();
const running = /* @__PURE__ */ new Map();
const rerun = /* @__PURE__ */ new Set();
const lastFetch = /* @__PURE__ */ new Map();
const PROCESS_START = Date.now();
const watched = /* @__PURE__ */ new Set();
const reported = /* @__PURE__ */ new Set();
const managed = /* @__PURE__ */ new Set();
const INHERITED_OUT = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|QUARANTINE_PATH|REPLACE_REF_BASE|GRAFT_FILE|SHALLOW_FILE|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|ATTR_SOURCE|REDIRECT_STDIN|REDIRECT_STDOUT|REDIRECT_STDERR)$/;
let log = null;
function configureRecordSync(settings = {}) {
  for (const key of Object.keys(SETTINGS)) if (Number.isFinite(settings[key])) SETTINGS[key] = settings[key];
  if (typeof settings.pullOnRead === "boolean") pullOnRead = settings.pullOnRead;
  if (typeof settings.watchPending === "boolean") watchPending = settings.watchPending;
  if (settings.log !== void 0) log = settings.log;
}
function cancelRecordSyncs() {
  for (const timer of scheduled.values()) clearTimeout(timer);
  scheduled.clear();
  lastFetch.clear();
  rerun.clear();
  written.clear();
}
const HANDOFF_SCRIPT = new URL("./record-store-handoff.mjs", import.meta.url);
let watchPending = false;
let watcher = null;
let watcherList = "";
const written = /* @__PURE__ */ new Set();
const writing = /* @__PURE__ */ new Set();
const handOffOff = () => process.env.PRISM_STORE_HANDOFF === "off";
const pendingStores = () => [.../* @__PURE__ */ new Set([...written, ...writing, ...rerun])].map((base) => ({ base, managed: managed.has(base) }));
function startWatcher() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(HANDOFF_SCRIPT)], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {
    });
    child.stdin.on("error", () => {
    });
    child.once("exit", () => {
      if (watcher === child) {
        watcher = null;
        watcherList = "";
      }
    });
    child.unref();
    child.stdin.unref?.();
    return child;
  } catch {
    return null;
  }
}
function updateWatcher() {
  if (!watchPending || handOffOff()) return;
  const stores = pendingStores();
  if (!stores.length && !watcher) return;
  const list = JSON.stringify(stores);
  if (list === watcherList) return;
  watcher ??= startWatcher();
  if (!watcher) return;
  watcherList = list;
  if (stores.length) {
    watcher.stdin.write(`${list}
`);
    return;
  }
  watcher.stdin.end(`${list}
`);
  watcher = null;
  watcherList = "";
}
function handOffRecordSyncs() {
  const stores = pendingStores();
  cancelRecordSyncs();
  if (handOffOff()) return [];
  const child = watcher ?? (stores.length ? startWatcher() : null);
  watcher = null;
  watcherList = "";
  child?.stdin.end(`${JSON.stringify(stores)}
`);
  return stores.map((store) => store.base);
}
const GENERATED_VIEW = Buffer.from("This file is a generated view of ");
const isRegistrationFile = (relative) => /^repositories\/[^/]+\.json$/.test(relative);
const isRecordFile = (relative) => relative === "roadmap.json" || relative.startsWith("initiatives/") || relative.startsWith("format-migrations/") || relative.startsWith("format-findings/") || isRegistrationFile(relative);
const isClaimFile = (relative) => /^initiatives\/[^/]+\/claims\/[^/]+\.json$/.test(relative);
const isQuietConflict = (relative) => isClaimFile(relative) || isRegistrationFile(relative);
const isArtifactFile = (relative) => relative.startsWith(`${ARTIFACTS}/`);
const STATUS_FOLDERS = [ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS];
const isStatusFile = (relative) => STATUS_FOLDERS.some((folder) => relative.startsWith(`${folder}/`));
const isGuardedFile = (relative) => isArtifactFile(relative) || isStatusFile(relative);
const guardedFolder = (relative) => [ARTIFACTS, ...STATUS_FOLDERS].find((folder) => relative.startsWith(`${folder}/`)) ?? null;
const isSavedFile = (relative) => isRecordFile(relative) || isGuardedFile(relative);
const syncPath = (base, ...parts) => path.join(base, SYNC_DIRECTORY, ...parts);
const NOTICES = "notices";
const NO_PROMPT_OPTION = { ssh: "-o BatchMode=yes", plink: "-batch", putty: "-batch" };
function sshVariant(named, program) {
  if (named) return ["auto", "plink", "putty", "tortoiseplink", "simple"].includes(named) ? named : "ssh";
  const name = program.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  return ["ssh", "plink", "tortoiseplink"].includes(name) ? name : "auto";
}
function firstWord(command) {
  let word = "";
  let quote = null;
  for (let at = command.trimStart(), index = 0; index < at.length; index += 1) {
    const char = at[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < at.length) word += at[++index];
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) break;
    else if (char === "\\" && index + 1 < at.length) word += at[++index];
    else word += char;
  }
  return word;
}
function sshEnvironment(env, settings = {}) {
  const command = env.GIT_SSH_COMMAND || settings.sshCommand;
  const line = command || (env.GIT_SSH ? `'${env.GIT_SSH.replaceAll("'", "'\\''")}'` : "");
  if (!line) return { GIT_SSH_COMMAND: `ssh ${NO_PROMPT_OPTION.ssh}` };
  const option = NO_PROMPT_OPTION[sshVariant(env.GIT_SSH_VARIANT || settings.variant, command ? firstWord(command) : env.GIT_SSH)];
  return option ? { GIT_SSH_COMMAND: `${line} ${option}` } : {};
}
function gitEnvironment(extra = {}, settings = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_OUT.test(name)));
  const ssh = sshEnvironment(env, settings);
  return { ...env, ...ssh, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", LC_ALL: "C", ...extra };
}
const REMOTE_COMMANDS = /* @__PURE__ */ new Set(["clone", "fetch", "pull", "push", "ls-remote", "archive"]);
function commandOf(args) {
  const settings = [];
  let index = 0;
  for (; args[index]?.startsWith("-"); index += 1) if (args[index] === "-c" || args[index] === "-C") {
    if (args[index] === "-c") settings.push("-c", args[index + 1]);
    index += 1;
  }
  return { settings, command: args[index] };
}
async function commandEnvironment(base, args, extra, connects) {
  const { settings, command } = commandOf(args);
  if (!(connects || REMOTE_COMMANDS.has(command)) || process.env.GIT_SSH_COMMAND && process.env.GIT_SSH_VARIANT) return gitEnvironment(extra);
  const listed = await git(base, [...settings, "config", "-z", "--get-regexp", "^(core\\.sshcommand|ssh\\.variant)$"], { env: extra });
  const found = {};
  for (const entry of listed.ok ? listed.stdout.toString("utf8").split("\0").filter(Boolean) : []) {
    const at = entry.indexOf("\n");
    if (at > 0) found[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return gitEnvironment(extra, { sshCommand: found["core.sshcommand"], variant: found["ssh.variant"] });
}
const FIXED_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.attributesFile=",
  "-c",
  "core.excludesFile=",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.useReplaceRefs=false",
  "-c",
  "core.commitGraph=false",
  "-c",
  "pack.useBitmaps=false",
  "-c",
  `core.maxTreeDepth=${TREE_DEPTH_MAX}`,
  "-c",
  "advice.graftFileDeprecated=false"
];
const gitTimeoutMs = () => SETTINGS.gitTimeoutMs;
function markManagedStore(base) {
  managed.add(base);
}
function runGit(base, args, options) {
  return git(base, args, options);
}
async function runGitLines(base, args, { env = {}, take, maxRecord = 4096, input }) {
  const listed = await gitRecords(base, args, { separator: 10, maxRecord, digestLong: true, env, input, take: (bytes) => take(bytes.toString("utf8")) });
  return { ok: listed.ok && !listed.long, streamed: true, text: "", stdout: Buffer.alloc(0), stderr: listed.stderr };
}
const GIT_OUTPUT_MAX = 64 * 1024 * 1024;
const GIT_ERRORS_MAX = 64 * 1024;
async function git(base, args, { env = {}, input, connects = false } = {}) {
  const environment = await commandEnvironment(base, args, env, connects);
  return new Promise((resolve) => {
    const child = execFile("git", [...FIXED_CONFIG, "-C", base, ...args], { env: environment, timeout: SETTINGS.gitTimeoutMs, maxBuffer: GIT_OUTPUT_MAX, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      try {
        const over = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const errors = over ? `git ${args[0]} printed more than ${GIT_OUTPUT_MAX} bytes, more than a sync takes from one command.` : stderr.subarray(0, GIT_ERRORS_MAX).toString("utf8").trim();
        resolve({ ok: !error, code: error ? typeof error.code === "number" ? error.code : -1 : 0, missing: error?.code === "ENOENT", stdout, text: over ? "" : stdout.toString("utf8").trim(), stderr: errors });
      } catch (failure) {
        resolve({ ok: false, code: -1, missing: false, stdout: Buffer.alloc(0), text: "", stderr: `git ${args[0]} failed: ${failure.message}` });
      }
    });
    child.stdin?.on("error", () => {
    });
    if (input !== void 0) child.stdin.end(input);
  });
}
async function gitRecords(base, args, { separator, limit = Infinity, maxBytes = Infinity, maxRecord = Infinity, digestLong = false, take, input, env = {} }) {
  const environment = await commandEnvironment(base, args, env, false);
  return new Promise((resolve) => {
    const child = spawn("git", [...FIXED_CONFIG, "-C", base, ...args], { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let count = 0, bytes = 0, over = null, long = null, stopped = false, failure = null, done = false;
    const errors = [];
    let errorBytes = 0;
    const stop = () => {
      done = true;
      child.kill();
    };
    const digested = (hash) => Buffer.from(`\0${hash.digest("hex")}`);
    const record = async (whole) => {
      let bytesOf = whole;
      if (bytesOf.length > maxRecord) {
        if (!digestLong) {
          long = Buffer.from(bytesOf.subarray(0, 512));
          return false;
        }
        bytesOf = digested(createHash("sha256").update(bytesOf));
      }
      if (++count > limit) {
        over = "count";
        return false;
      }
      if ((bytes += bytesOf.length + 1) > maxBytes) {
        over = "bytes";
        return false;
      }
      try {
        const kept = await take(bytesOf);
        if (kept === false) {
          stopped = true;
          return false;
        }
      } catch (error) {
        failure = error.message;
        return false;
      }
      return true;
    };
    const timer = setTimeout(() => {
      failure ??= `git ${args[0]} took longer than ${SETTINGS.gitTimeoutMs} ms.`;
      done = true;
      child.kill("SIGKILL");
    }, SETTINGS.gitTimeoutMs);
    child.stderr.on("data", (chunk) => {
      if (errorBytes < GIT_ERRORS_MAX) {
        errors.push(chunk);
        errorBytes += chunk.length;
      }
    });
    child.stdin.on("error", () => {
    });
    child.on("error", (error) => {
      failure ??= error.code === "ENOENT" ? "Git is not available." : error.message;
    });
    let hashing = null;
    const reading = (async () => {
      let pending = Buffer.alloc(0);
      try {
        for await (const chunk of child.stdout) {
          if (done) continue;
          if (separator === null) {
            if ((bytes += chunk.length) > maxBytes) {
              over = "bytes";
              stop();
              continue;
            }
            try {
              if (await take(chunk) === false) {
                stopped = true;
                stop();
              }
            } catch (error) {
              failure = error.message;
              stop();
            }
            continue;
          }
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let at = 0;
          if (hashing) {
            const end = pending.indexOf(separator);
            if (end < 0) {
              hashing.update(pending);
              pending = Buffer.alloc(0);
              continue;
            }
            hashing.update(pending.subarray(0, end));
            const ended = hashing;
            hashing = null;
            at = end + 1;
            if (!await record(digested(ended))) {
              stop();
              pending = Buffer.alloc(0);
              continue;
            }
          }
          for (let end; !done && (end = pending.indexOf(separator, at)) >= 0; at = end + 1) if (!await record(pending.subarray(at, end))) stop();
          if (done) {
            pending = Buffer.alloc(0);
            continue;
          }
          pending = Buffer.from(pending.subarray(at));
          if (pending.length > maxRecord) {
            if (digestLong) hashing = createHash("sha256").update(pending);
            else {
              long = Buffer.from(pending.subarray(0, 512));
              stop();
            }
            pending = Buffer.alloc(0);
          }
        }
      } catch (error) {
        if (!done) failure ??= error.message;
      }
      return pending;
    })();
    child.on("close", async (code) => {
      const pending = await reading;
      clearTimeout(timer);
      if (!done && !failure && hashing && separator !== null) await record(digested(hashing));
      else if (!done && !failure && pending.length && separator !== null) await record(pending);
      const stderr = failure ?? Buffer.concat(errors).toString("utf8").trim();
      resolve({ ok: Boolean(over || long || stopped) || !failure && code === 0, over, long, stopped, stderr });
    });
    child.stdin.end(input ?? "");
  });
}
const outputRefusal = (text, fix = "", outcome = "the sync went no further") => Object.assign(new Error(`${text}, so ${outcome}.${fix ? ` ${fix}` : ""}`), { unsafePath: true, outputBound: true });
const HISTORY_BYTES_MAX = 256 * 1024 * 1024;
const historyBytesMax = () => SETTINGS.historyBytesMax ?? HISTORY_BYTES_MAX;
const historyRecordsMax = () => Math.floor(historyBytesMax() / 32);
const HISTORY_FIX = "Take the commits made by hand that the remote lacks off the store's branch, such as by running git reset --soft with the tip of the remote's branch in the store, which keeps every file on disk, and the next sync commits the store's files again.";
const historyRefusal = (what, commit = null, first = false) => outputRefusal(
  `Git's listing of ${what} holds more than ${historyBytesMax()} bytes or ${historyRecordsMax()} entries, more than a sync reads${commit ? " for one commit" : ""}`,
  !commit ? HISTORY_FIX : first ? "Take that commit made by hand off the store's branch, such as by running git update-ref -d HEAD in the store, which keeps every file on disk and takes every commit off the branch, since that commit is its first, and the next sync commits the store's files again." : `Take that commit made by hand off the store's branch, such as by running git reset --soft ${commit}^ in the store, which keeps every file on disk and takes off every later commit too, and the next sync commits the store's files again.`,
  "the store's branch was not pushed"
);
async function commitRefusal(base, what, commit) {
  const parent = await git(base, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
  return historyRefusal(what, commit, !(parent.ok && parent.text));
}
const REMOTE_REFS_MAX = 4096;
async function historyCommits(base, args, input, env = {}) {
  const commits = [];
  const listed = await gitRecords(base, args, { separator: 10, limit: historyRecordsMax(), maxBytes: historyBytesMax(), maxRecord: 128, input, env, take: (line) => {
    if (line.length) commits.push(line.toString("latin1"));
  } });
  if (listed.over || listed.long) throw historyRefusal("the commits that the remote lacks");
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || `git ${args[0]} failed.`), { git: listed });
  return commits;
}
async function gitLines(base, args, options) {
  const listed = await gitLinesResult(base, args, options);
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || `git ${args[0]} failed.`), { git: listed });
  return listed.lines;
}
async function gitLinesResult(base, args, { input, env, limit, maxRecord = 512, what = `the output of git ${args[0]}` }) {
  const lines = [];
  const listed = await gitRecords(base, args, { separator: 10, limit, maxBytes: limit * (maxRecord + 1), maxRecord, input, env, take: (line) => {
    lines.push(line.toString("utf8"));
  } });
  if (listed.over || listed.long) throw outputRefusal(`Git's listing of ${what} holds more than ${listed.long ? `${maxRecord} bytes in one line` : `${limit} lines`}, more than a sync reads`);
  return { ok: listed.ok, lines, stderr: listed.stderr };
}
const GIT_MINIMUM = "2.25";
const versionChecks = /* @__PURE__ */ new Map();
function gitTooOld() {
  const key = process.env.PATH ?? "";
  if (!versionChecks.has(key)) {
    versionChecks.set(key, new Promise((resolve) => {
      execFile("git", ["--version"], { env: gitEnvironment(), timeout: SETTINGS.gitTimeoutMs, windowsHide: true }, (error, stdout) => {
        const found = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(error ? "" : String(stdout).trim());
        if (!found) return resolve(null);
        const [major, minor] = GIT_MINIMUM.split(".").map(Number);
        const older = Number(found[1]) < major || Number(found[1]) === major && Number(found[2]) < minor;
        resolve(older ? `This machine has Git ${found.slice(1).filter(Boolean).join(".")}, and syncing a record store needs Git ${GIT_MINIMUM} or later, so Prism does not sync it; update Git.` : null);
      });
    }));
  }
  return versionChecks.get(key);
}
async function required(base, args, options) {
  const result = await git(base, args, options);
  if (!result.ok) throw Object.assign(new Error(result.stderr || `git ${args[0]} failed.`), { git: result });
  return result;
}
async function holderAlive(marker) {
  try {
    const owner = parseStoreJson(await readFile(marker, "utf8"));
    if (Date.now() - Date.parse(owner.at) > SETTINGS.waitMs * 6) return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
async function waitForStableStore(base) {
  const marker = syncPath(base, "working-tree");
  const deadline = Date.now() + SETTINGS.waitMs;
  while (Date.now() < deadline && await holderAlive(marker)) await new Promise((resolve) => setTimeout(resolve, 25));
}
function scheduleRecordSync(base, carriesWrite = true) {
  watched.add(base);
  if (carriesWrite) written.add(base);
  clearTimeout(scheduled.get(base));
  const timer = setTimeout(() => {
    scheduled.delete(base);
    if (running.has(base)) rerun.add(base);
    else syncRecordStore(base).catch(() => {
    });
    updateWatcher();
  }, SETTINGS.debounceMs);
  timer.unref();
  scheduled.set(base, timer);
  updateWatcher();
}
function pullRecordStoreIfStale(base) {
  watched.add(base);
  if (!pullOnRead || running.has(base) || Date.now() - (lastFetch.get(base) ?? 0) < SETTINGS.pullIntervalMs) return;
  lastFetch.set(base, Date.now());
  syncRecordStore(base).catch(() => {
  });
}
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const stampTime = (stamp) => Date.parse(stamp.replace(STAMP, "$1:$2:$3.$4Z"));
function settled(conflicts) {
  const shown = conflicts.filter((conflict) => !isQuietConflict(conflict.path));
  return { state: shown.length ? "conflicts" : "ok", conflicts: shown, message: shown.length ? conflictsMessage(shown) : "" };
}
function conflictsMessage(shown) {
  const isComment = (file) => file.startsWith(`${ARTIFACT_COMMENTS}/`);
  const nouns = [[isRecordFile, "records"], [isGuardedFile, "artifacts"], [isComment, "comments"], [(file) => !isSavedFile(file) && !isComment(file), "other store files"]].filter(([kind]) => shown.some((conflict) => kind(conflict.path))).map(([, noun]) => noun);
  const named = nouns.length === 1 ? nouns[0].replace(/^other /, "") : nouns.length === 2 ? nouns.join(" and ") : `${nouns.slice(0, -1).join(", ")}, and ${nouns.at(-1)}`;
  const count = (test) => shown.filter(test).length;
  const mine = count((conflict) => conflict.savedAs && !conflict.theirs && !conflict.tooLongAt);
  const theirs = count((conflict) => conflict.savedAs && conflict.theirs && !conflict.tooLongAt);
  const removed = count((conflict) => !conflict.savedAs);
  const tooLong = (other) => {
    const copies = shown.filter((conflict) => conflict.savedAs && conflict.tooLongAt && Boolean(conflict.theirs) === other);
    if (!copies.length) return [];
    const locations = [...new Set(copies.map((conflict) => shownPath(`${ARTIFACTS}/${conflict.tooLongAt}`)))];
    const whose = other ? "the other machine's" : "this machine's";
    const what = copies.length === 1 ? `${whose} change to a file of a moved artifact is saved, because its path` : `${whose} ${copies.length} changes to files of moved artifacts are saved, because their paths`;
    return [`${what} would hold a name of more than ${STORE_NAME_BYTES_MAX} bytes or more than ${STORE_PATH_BYTES_MAX} bytes in all, too long for a store to share, at the artifact's new location ${locations.length === 1 ? locations[0] : locations.length <= 3 ? `${locations.slice(0, -1).join(", ")} or ${locations.at(-1)}` : `${locations.slice(0, 3).join(", ")}, or one of ${locations.length - 3} more`}, where the store keeps the artifact without ${copies.length === 1 ? "that file" : "those files"}`];
  };
  const outcomes = [
    ...mine ? ["the store keeps the upstream's side, and this machine's versions are saved"] : [],
    ...theirs ? [`the other machine's ${theirs === 1 ? "change to a file that this machine removed is" : `${theirs} changes to files that this machine removed are`} saved, because this machine's removal stands`] : [],
    ...tooLong(false),
    ...tooLong(true),
    ...removed ? [`this machine's removal of ${removed === 1 ? "a file" : `${removed} files`} gave way to the upstream's change, so the store holds the upstream's version there again`] : []
  ];
  return `Concurrent changes to ${named} were resolved; ${outcomes.join("; ")}.`;
}
async function savedFiles(directory, kept = isRecordFile) {
  const files = [];
  const visit = async (relative) => {
    let entries = [];
    try {
      entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && kept(child) && !isQuietConflict(child)) files.push(child);
    }
  };
  await visit("");
  return files;
}
async function listSavedConflicts(base) {
  let stamps = [];
  try {
    stamps = (await readdir(syncPath(base, "conflicts"))).filter((stamp) => STAMP.test(stamp)).sort().reverse();
  } catch {
    return [];
  }
  const found = [];
  for (const stamp of stamps) {
    const at = new Date(stampTime(stamp)).toISOString();
    for (const file of await savedFiles(syncPath(base, "conflicts", stamp))) found.push({ path: file, savedAs: `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}`, at });
  }
  return found;
}
async function readSavedConflict(base, savedAs) {
  const parts = typeof savedAs === "string" ? savedAs.split("/") : [];
  const file = parts.slice(3).join("/");
  if (parts[0] !== SYNC_DIRECTORY || parts[1] !== "conflicts" || !STAMP.test(parts[2] ?? "") || !isRecordFile(file) || parts.slice(3).some((part) => !part || part === "." || part === "..")) return null;
  const { bound } = await storeLayout();
  const [saved, current] = [await boundedBytes(path.join(base, ...parts), bound(file)), await boundedBytes(path.join(base, ...file.split("/")), bound(file))];
  if (saved === null) return null;
  const text = (bytes) => Buffer.isBuffer(bytes) ? bytes.toString("utf8") : null;
  const over = [["saved", saved], ["current", current]].filter(([, bytes]) => overBytes(bytes)).map(([name, bytes]) => [name, bytes.size]);
  return { path: file, saved: text(saved), current: text(current), ...over.length ? { tooLarge: Object.fromEntries(over), bound: bound(file) } : {} };
}
async function takeSavedConflicts() {
  const { shareable } = await storeLayout();
  const found = [];
  for (const base of watched) {
    const directory = syncPath(base, "conflicts");
    let stamps = [];
    try {
      stamps = (await readdir(directory)).sort();
    } catch {
      continue;
    }
    const pending = new Set(await readdir(syncPath(base, NOTICES)).catch(() => []));
    for (const stamp of stamps) {
      const at = stampTime(stamp);
      const key = `${base}\0${stamp}`;
      if (reported.has(key) || !(at >= PROCESS_START || pending.has(stamp))) continue;
      reported.add(key);
      const notice = pending.has(stamp) ? syncPath(base, NOTICES, stamp) : null;
      const about = await readAbout(base, stamp);
      const when = new Date(at).toISOString();
      const items = (await savedFiles(path.join(directory, stamp), (file) => isSavedFile(file) || shareable(file))).map((file) => {
        const savedAs = path.join(directory, stamp, ...file.split("/"));
        const whose = { ...about.theirs.has(file) ? { theirs: true } : about.surplus.has(file) ? { surplus: true } : about.bothChanged.has(file) ? { bothChanged: true } : about.overBound.has(file) ? { overBound: true } : {}, ...about.tooLong.has(file) ? { tooLongAt: about.tooLong.get(file) } : {} };
        if (isArtifactFile(file)) return { store: base, location: file.slice(ARTIFACTS.length + 1), savedAs, at: when, ...whose };
        if (isRecordFile(file)) return { record: `.prism/${file}`, savedAs, at: when, ...whose.overBound ? { overBound: true } : {} };
        const location = derivedLocation(file);
        if (location !== null) return file.startsWith(`${ARTIFACT_STATUS}/`) ? { store: base, statusOf: location, savedAs, at: when, ...whose } : { store: base, commentOn: location, savedAs, at: when, ...whose };
        return { store: base, file, savedAs, at: when, ...whose };
      });
      items.unshift(...about.undone.map((change) => ({ store: base, ..."removal" in change ? { undoneRemoval: change.removal } : "file" in change ? { undoneFile: change.file } : "record" in change ? { undoneRecord: `.prism/${change.record}` } : { undoneMove: change.move, movedTo: change.movedTo }, folder: directory, at: when })));
      if (notice && !items.length) await rm(notice, { force: true });
      for (const item of items) {
        if (notice) notices.set(item, notice);
        reportKeys.set(item, key);
        found.push(item);
      }
    }
  }
  return found;
}
const noteLocation = (location) => typeof location === "string" && location.length > 0 && location.split("/").every((part) => part && part !== "." && part !== "..");
const undoneForm = (change) => change !== null && typeof change === "object" && (noteLocation(change.removal) || noteLocation(change.file) || noteLocation(change.record) && isRecordFile(change.record) || noteLocation(change.move) && noteLocation(change.movedTo));
async function readAbout(base, stamp) {
  const value = await readFile(aboutPath(base, stamp), "utf8").then(parseStoreJson).catch(() => null);
  const paths = (list) => new Set(Array.isArray(list) ? list.filter((file) => typeof file === "string") : []);
  const undone = Array.isArray(value?.undone) ? value.undone.filter(undoneForm).map((change) => noteLocation(change.removal) ? { removal: change.removal } : noteLocation(change.file) ? { file: change.file } : noteLocation(change.record) && isRecordFile(change.record) ? { record: change.record } : { move: change.move, movedTo: change.movedTo }) : [];
  const tooLong = new Map(Array.isArray(value?.tooLong) ? value.tooLong.filter((entry) => typeof entry?.path === "string" && noteLocation(entry.location)).map((entry) => [entry.path, entry.location]) : []);
  return { theirs: paths(value?.theirs), tooLong, surplus: paths(value?.surplus), bothChanged: paths(value?.bothChanged), overBound: paths(value?.overBound), undone };
}
const notices = /* @__PURE__ */ new WeakMap();
const reportKeys = /* @__PURE__ */ new WeakMap();
async function confirmSavedConflicts(taken) {
  for (const notice of new Set((taken ?? []).map((item) => notices.get(item)).filter(Boolean))) await rm(notice, { force: true }).catch(() => {
  });
}
function releaseSavedConflicts(taken) {
  for (const item of taken ?? []) if (reportKeys.has(item)) reported.delete(reportKeys.get(item));
}
async function syncRecordStoreNow(base, options = {}) {
  watched.add(base);
  clearTimeout(scheduled.get(base));
  scheduled.delete(base);
  const deadline = Date.now() + SETTINGS.gitTimeoutMs;
  while (true) {
    while (running.has(base)) await running.get(base).catch(() => {
    });
    const status = await syncRecordStore(base, options);
    if (status.state !== "skipped" || Date.now() > deadline) return status;
    clearTimeout(scheduled.get(base));
    scheduled.delete(base);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function commitStoreFiles(base, { message, files }) {
  await mkdir(syncPath(base), { recursive: true });
  return withFileLock(syncPath(base, "sync"), async () => {
    const top = await git(base, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || path.resolve(top.text) !== path.resolve(base) || await gitTooOld()) return false;
    const run = { own: { message, files: new Set(files) }, lockTried: true };
    return commitLocal(base, await identity(base), run);
  }, void 0, { ...syncLockOptions(), timeoutMs: SETTINGS.gitTimeoutMs });
}
async function readSyncStatus(base) {
  try {
    return parseStoreJson(await readFile(syncPath(base, "status.json"), "utf8"));
  } catch {
    return null;
  }
}
async function writeStatus(base, status) {
  const value = { at: (/* @__PURE__ */ new Date()).toISOString(), state: "ok", ahead: 0, behind: 0, conflicts: [], message: "", ...status };
  value.conflicts = value.conflicts.filter((conflict) => !isQuietConflict(conflict.path));
  value.message = withoutCredentials(value.message);
  await mkdir(syncPath(base), { recursive: true });
  await writeAtomically(syncPath(base, "status.json"), `${JSON.stringify(value, null, 2)}
`);
  return value;
}
function syncRecordStore(base, options = {}) {
  if (running.has(base)) return running.get(base);
  const pending = (async () => {
    await mkdir(syncPath(base), { recursive: true });
    try {
      return await withFileLock(syncPath(base, "sync"), async () => {
        const before = log ? await Promise.all([readSyncStatus(base), headOf(base)]).catch(() => null) : null;
        const status = await sync(base, options);
        if (before) await logSync(base, before[0], before[1], status).catch(() => {
        });
        await options.whileLocked?.(status);
        return status;
      }, void 0, { ...syncLockOptions(), timeoutMs: 1 });
    } catch (error) {
      if (error.code === "lock_timeout") {
        scheduleRecordSync(base, writing.has(base));
        return { state: "skipped" };
      }
      if (error.unsafePath) return writeStatus(base, { state: "merge_failed", message: error.message, ...await counts(base).catch(() => ({})) }).catch(() => ({ state: "merge_failed", message: withoutCredentials(error.message) }));
      return writeStatus(base, { state: "git_failed", message: error.message }).catch(() => ({ state: "git_failed", message: withoutCredentials(error.message) }));
    }
  })().finally(() => {
    running.delete(base);
    writing.delete(base);
    if (rerun.delete(base)) scheduleRecordSync(base);
    updateWatcher();
  });
  running.set(base, pending);
  if (written.delete(base)) writing.add(base);
  updateWatcher();
  return pending;
}
const headOf = async (base) => {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.ok ? head.text : null;
};
async function logSync(base, previous, head, status) {
  if (!log || !status || status.state === "skipped") return;
  const failed = (value) => value && value.state !== "ok";
  if (failed(status)) {
    if (previous?.state !== status.state || previous?.message !== status.message) log.warn("store_sync_failed", { store: base, state: status.state, message: status.message, ahead: status.ahead, behind: status.behind });
    return;
  }
  const now = await headOf(base);
  const conflicts = status.conflicts?.length ?? 0;
  if (now !== head || conflicts || previous?.ahead > 0 && !status.ahead) log.info("store_synced", { store: base, from: head, to: now, ahead: status.ahead, behind: status.behind, ...conflicts ? { savedConflicts: conflicts } : {} });
  else if (failed(previous)) log.info("store_synced", { store: base, recovered: previous.state, ahead: status.ahead, behind: status.behind });
}
async function identity(base) {
  const args = [];
  if (!(await git(base, ["config", "user.name"])).text) args.push("-c", "user.name=Prism");
  if (!(await git(base, ["config", "user.email"])).text) args.push("-c", "user.email=prism@localhost");
  return args;
}
const FILE_MODES = /* @__PURE__ */ new Set(["100644", "100755"]);
const IGNORED_CODE_POINTS = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
const PROTECTED_NAMES = /* @__PURE__ */ new Set([".git", SYNC_DIRECTORY]);
function unsafeName(name) {
  if (name.includes("\\") || name.includes(":")) return true;
  const plain = name.replace(IGNORED_CODE_POINTS, "").replace(/[. ]+$/, "").toLowerCase();
  return plain === "" || PROTECTED_NAMES.has(plain) || /^[^.]{1,6}~[0-9]+$/.test(plain);
}
let layout;
const storeLayout = () => layout ??= import("./record-store.mjs").then(({ boundText, COMMENTS_PER_ARTIFACT_MAX, INERT_FILES, isRootStoreFile, isStoreFile, isStoreFolder, STORE_FILE_BOUNDS, STORE_TREE_FILES_MAX, storeFileBound }) => {
  const shareable = (file) => isStoreFile(file) || INERT_FILES.has(file);
  const kind = (file, { mode, notUtf8 }) => {
    if (!FILE_MODES.has(mode) || notUtf8 || file.split("/").some((name) => unsafeName(name) || !portableName(name) || file !== ".gitattributes" && gitFileName(bytesOfPath(name)))) return "unsafe";
    if (shareable(file)) return storePathFits(file) ? "shared" : "unsafe";
    if (file.startsWith(`${ARTIFACT_IDENTITY}/`)) return "unsafe";
    if (isStoreFolder(file) || folders(file).some((folder) => !isArtifactFile(folder) && shareable(folder))) return "unsafe";
    return "carried";
  };
  const isCommentFile = (file) => file.startsWith(`${ARTIFACT_COMMENTS}/`) && isStoreFile(file);
  const largest = Math.max(...Object.values(STORE_FILE_BOUNDS));
  const blobMax = (file) => storeFileBound(file) ?? largest;
  const treeFilesMax = () => SETTINGS.treeFilesMax ?? STORE_TREE_FILES_MAX;
  return { shareable, isStoreFolder, kind, bound: storeFileBound, blobMax, boundText, commentsMax: COMMENTS_PER_ARTIFACT_MAX, isCommentFile, rootFile: isRootStoreFile, treeFilesMax };
});
const OVER_BOUND = "that a store file of its kind may hold";
const overBound = (size, bound, boundText, root = false) => `it holds ${size} bytes, above the ${boundText(bound)} ${OVER_BOUND}, so ${root ? "every other machine's sync would refuse it" : "no reader on another machine would read it"}`;
const OVER_COMMENTS = "its comment folder holds more than";
const overComments = (max) => `${OVER_COMMENTS} ${max} comment files, the most that an artifact's comments may hold, and the sync commits every comment that the store already shares and then this machine's others by file name, up to ${max}`;
async function oversizedStoreEntry(base, commit) {
  const { kind, bound, isCommentFile, commentsMax } = await storeLayout();
  const counts2 = /* @__PURE__ */ new Map();
  let found = null;
  try {
    await listTree(base, commit, true, (meta, name) => {
      if (found) return;
      const [mode, , object, size] = meta.split(/ +/);
      const file = pathOfBytes(name);
      if (!FILE_MODES.has(mode) || kind(file, { mode, object }) !== "shared") return;
      const limit = bound(file);
      if (limit !== null && Number(size) > limit) {
        found = { path: file, size: Number(size), bound: limit };
        return;
      }
      if (isCommentFile(file)) {
        const folder = path.posix.dirname(file);
        counts2.set(folder, (counts2.get(folder) ?? 0) + 1);
      }
    });
  } catch (error) {
    if (!error.treeTooLarge) throw error;
    return { files: error.treeTooLarge, bytes: error.listingBytes };
  }
  if (found) return found;
  for (const [folder, count] of counts2) if (count > commentsMax) return { folder, count };
  return null;
}
async function oversizedHistory(base, known, tip = "HEAD") {
  const { shareable, bound } = await storeLayout();
  const commits = await historyCommits(base, ["rev-list", "--stdin"], `${tip}
${known.map((commit2) => `^${commit2}
`).join("")}`);
  if (!commits.length) return null;
  const batch = /* @__PURE__ */ new Map();
  let found = null, meta = null, commit = null, records = 0, bytes = 0, tooLong = null;
  const check = async () => {
    const sizes = await objectInfo(base, [...batch.keys()]);
    for (const [object, { file, limit }] of batch) {
      const size = sizes.get(object)?.size;
      if (found === null && size !== void 0 && size > limit) found = { path: file, size, bound: limit };
    }
    batch.clear();
    return found === null;
  };
  const listed = await gitRecords(base, ["diff-tree", "--stdin", "-r", "-z", "-c", "--root", "--no-renames"], {
    separator: 0,
    maxRecord: LISTED_META_MAX * 8 + LISTED_PATH_BYTES_MAX,
    input: `${commits.join("\n")}
`,
    take: async (record) => {
      if (meta === null && record[0] !== 58) {
        commit = record.toString("latin1");
        records = 0;
        bytes = 0;
        return true;
      }
      if (++records > historyRecordsMax() || (bytes += record.length + 1) > historyBytesMax()) {
        tooLong = commit;
        return false;
      }
      if (meta === null) {
        meta = record.toString("latin1");
        return true;
      }
      const parents = /^:+/.exec(meta)[0].length;
      const fields = meta.slice(parents).split(" ");
      meta = null;
      const [mode, object] = [fields[parents], fields[2 * parents + 1]];
      const file = pathOfBytes(record);
      const limit = FILE_MODES.has(mode) && shareable(file) ? bound(file) : null;
      if (limit === null || (batch.get(object)?.limit ?? Infinity) <= limit) return true;
      batch.set(object, { file, limit });
      return batch.size < 4096 || await check();
    }
  });
  if (tooLong !== null || listed.long) throw tooLong ?? commit ? await commitRefusal(base, `the changes of commit ${tooLong ?? commit}`, tooLong ?? commit) : historyRefusal("the changes that the remote lacks");
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git diff-tree failed."), { git: listed });
  if (found === null && batch.size) await check();
  return found;
}
async function describeOversizedEntry(over) {
  const { boundText, commentsMax, rootFile } = await storeLayout();
  if (over.files) return `${wideTree(over)}, which no store takes`;
  if (over.folder) return `${over.count} comment files in ${shownPath(over.folder)}, above the ${commentsMax} that an artifact's comments may hold, which no reader takes`;
  return `${shownPath(over.path)}, which holds ${over.size} bytes, above the ${boundText(over.bound)} that a store file of its kind may hold, which ${rootFile(over.path) ? "no store takes" : "no reader takes"}`;
}
async function partition(files) {
  const { kind } = await storeLayout();
  const shared = /* @__PURE__ */ new Map();
  const other = /* @__PURE__ */ new Map();
  for (const [file, entry] of files) (kind(file, entry) === "shared" ? shared : other).set(file, entry);
  return { shared, other };
}
function besides(shared, other) {
  const result = new Map(shared);
  const places = new Set([...shared.keys()].flatMap(folders));
  for (const [file, entry] of other) {
    if (!shared.has(file) && !places.has(file) && !folders(file).some((folder) => shared.has(folder))) result.set(file, entry);
  }
  return result;
}
const sameFiles = (left, right) => left.size === right.size && [...left].every(([file, entry]) => sameEntry(right.get(file), entry));
async function writeTree(base, entries) {
  const index = syncPath(base, "tree-index");
  const env = { GIT_INDEX_FILE: index };
  await rm(index, { force: true });
  try {
    await required(base, ["read-tree", "--empty"], { env });
    const input = Buffer.concat([...entries].flatMap(([file, entry]) => [Buffer.from(`${entry.mode} ${entry.object}	`), bytesOfPath(file), Buffer.from([0])]));
    if (input.length) await required(base, ["update-index", "-z", "--index-info"], { env, input });
    return (await required(base, ["write-tree"], { env })).text;
  } finally {
    await rm(index, { force: true });
  }
}
async function moveBranch(base, commit, previous, message) {
  await required(base, ["read-tree", commit]);
  await required(base, ["update-ref", "-m", message, "HEAD", commit, previous ?? ""]).catch(async (error) => {
    await git(base, previous ? ["read-tree", previous] : ["read-tree", "--empty"]);
    throw error;
  });
  await recordDiskCommit(base, commit);
}
const RAW_FILES = "raw-files.json";
const migrated = /* @__PURE__ */ new Set();
const syncLockOptions = () => ({ renew: true, abandonWhenUnrenewed: true, staleMs: SETTINGS.gitTimeoutMs * 2 });
async function moveUnderSyncLock(source, target, qualifies, renameFolder = rename) {
  await mkdir(syncPath(source), { recursive: true });
  const lock = `${syncPath(source, "sync")}.lock`;
  return withFileLock(syncPath(source, "sync"), async () => {
    if (!await qualifies()) return false;
    const token = (await readFile(lock, "utf8").then(parseStoreJson).catch(() => null))?.token;
    await renameFolder(source, target);
    const moved = path.join(target, path.relative(source, lock));
    const owner = await readFile(moved, "utf8").then(parseStoreJson).catch(() => null);
    if (token && owner?.token === token) await rm(moved, { force: true });
    return true;
  }, void 0, { ...syncLockOptions(), timeoutMs: 1, closeHandle: true });
}
async function prepareStoreFiles(base) {
  if (migrated.has(base) || await rawFilesRecorded(base)) return;
  await mkdir(syncPath(base), { recursive: true });
  await withFileLock(syncPath(base, "sync"), () => migrateLineEndings(base), void 0, { ...syncLockOptions(), timeoutMs: SETTINGS.gitTimeoutMs });
}
async function rawFilesRecorded(base) {
  if (await fileBytes(syncPath(base, RAW_FILES)) === null) return false;
  migrated.add(base);
  return true;
}
const lineEndingEcho = (bytes, blobBytes) => !blobBytes.includes(13) && bytes.includes(13) && bytes.toString("latin1").replaceAll("\r\n", "\n") === blobBytes.toString("latin1");
async function migrateLineEndings(base) {
  if (migrated.has(base) || await rawFilesRecorded(base)) return;
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return;
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  let listed;
  try {
    listed = await treeFiles(base, head.ok ? head.text : null);
  } catch (error) {
    if (error.treeTooLarge) return;
    throw error;
  }
  const { shared } = await partition(listed);
  const found = [];
  for (const [file, entry] of shared) if ((await lstat(path.join(base, ...file.split("/"))).catch(() => null))?.isFile()) found.push([file, entry]);
  const objects = found.length ? await gitLines(base, ["hash-object", "--no-filters", "--stdin-paths"], { input: `${found.map(([file]) => file).join("\n")}
`, limit: found.length, maxRecord: 128 }) : [];
  const echoes = [];
  const { bound } = await storeLayout();
  const differing = found.filter(([, entry], index) => objects[index] !== entry.object);
  const blobSizes = differing.length ? await objectInfo(base, [...new Set(differing.map(([, entry]) => entry.object))]) : /* @__PURE__ */ new Map();
  for (const [file, entry] of differing) {
    const target = path.join(base, ...file.split("/"));
    const blobSize = blobSizes.get(entry.object)?.size;
    const size = (await lstat(target).catch(() => null))?.size;
    if (blobSize === void 0 || size === void 0 || size <= blobSize || size > 2 * blobSize || bound(file) !== null && blobSize > bound(file)) continue;
    const [bytes, blobBytes] = await Promise.all([boundedBytes(target, 2 * blobSize), readBlob(base, file, entry)]);
    if (Buffer.isBuffer(bytes) && Buffer.isBuffer(blobBytes) && lineEndingEcho(bytes, blobBytes)) echoes.push({ file, target, blobBytes });
  }
  const rewrite = async ({ target, blobBytes }) => {
    const bytes = await boundedBytes(target, 2 * blobBytes.length);
    if (Buffer.isBuffer(bytes) && lineEndingEcho(bytes, blobBytes)) await writeAtomically(target, blobBytes);
  };
  const artifacts = echoes.filter(({ file }) => isGuardedFile(file));
  if (artifacts.length) await holdLocks([path.join(base, ARTIFACTS)], async () => {
    for (const echo of artifacts) await rewrite(echo);
  });
  for (const echo of echoes.filter(({ file }) => !isGuardedFile(file))) await holdLocks([echo.target], () => rewrite(echo));
  await writeAtomically(syncPath(base, RAW_FILES), `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
  migrated.add(base);
}
async function localFiles(base, held, withheld, oversized = /* @__PURE__ */ new Map()) {
  const { shareable, isStoreFolder, bound, boundText, isCommentFile, commentsMax, rootFile } = await storeLayout();
  for (let attempt = 1; ; attempt++) {
    const found = [];
    const visit = async (relative) => {
      let entries = [];
      try {
        entries = await readdir(relative ? path.join(base, ...relative.split("/")) : base, { withFileTypes: true });
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
        throw error;
      }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          if (shareable(child)) storePathFits(child) ? found.push(child) : withheld.set(child, TOO_LONG);
        } else if (entry.isDirectory() && isStoreFolder(child)) await visit(child);
      }
    };
    await visit("");
    found.sort();
    const over = /* @__PURE__ */ new Map();
    const comments2 = /* @__PURE__ */ new Map();
    for (let start = 0; start < found.length; start += 64) {
      await Promise.all(found.slice(start, start + 64).map(async (file) => {
        const limit = bound(file);
        if (limit === null) return;
        const info = await lstat(path.join(base, ...file.split("/"))).catch(() => null);
        if (info?.isFile() && info.size > limit) {
          over.set(file, info.size);
          withheld.set(file, overBound(info.size, limit, boundText, rootFile(file)));
        }
      }));
    }
    for (const file of found) if (!over.has(file) && isCommentFile(file)) comments2.set(path.posix.dirname(file), [...comments2.get(path.posix.dirname(file)) ?? [], file]);
    for (const names of comments2.values()) {
      if (names.length <= commentsMax) continue;
      const ordered = [...names.filter((file) => held.has(file)), ...names.filter((file) => !held.has(file))];
      for (const file of ordered.slice(commentsMax)) {
        over.set(file, null);
        withheld.set(file, overComments(commentsMax));
      }
    }
    if (over.size) {
      for (const [file, size] of over) if (size !== null || !isCommentFile(file) || held.has(file)) oversized.set(file, size);
      found.splice(0, found.length, ...found.filter((file) => !over.has(file)));
    }
    const hashed = found.length ? await gitLinesResult(base, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: `${found.join("\n")}
`, limit: found.length, maxRecord: 128 }) : { ok: true, lines: [] };
    const objects = hashed.lines;
    if (!hashed.ok || objects.length !== found.length) {
      if (attempt < 3) continue;
      throw Object.assign(new Error(hashed.stderr || "git hash-object failed."), { git: hashed });
    }
    const sizes = found.length ? await objectInfo(base, [...new Set(objects)]) : /* @__PURE__ */ new Map();
    const files = /* @__PURE__ */ new Map();
    for (const [index, file] of found.entries()) {
      const limit = bound(file);
      const size = sizes.get(objects[index])?.size;
      if (limit !== null && size !== void 0 && size > limit) {
        withheld.set(file, overBound(size, limit, boundText, rootFile(file)));
        oversized.set(file, size);
        continue;
      }
      files.set(file, { mode: held.get(file)?.mode ?? "100644", object: objects[index] });
    }
    return files;
  }
}
const diskIdentity = (stats) => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtime: stats.mtimeNs, ctime: stats.ctimeNs });
async function sameDiskFile(target, disk) {
  const stats = await lstat(target, { bigint: true }).catch(() => null);
  const now = stats?.isFile() ? diskIdentity(stats) : null;
  return Boolean(now) && Object.keys(disk).every((key) => now[key] === disk[key]);
}
const DISK_RECORD = "disk.json";
let layoutHash = null;
async function layoutId() {
  if (layoutHash) return layoutHash;
  const { isStoreFile, isStoreFolder, isRootStoreFile } = await import("./record-store.mjs");
  layoutHash = createHash("sha256").update([isStoreFile, isStoreFolder, isRootStoreFile].map(String).join("\n")).digest("hex");
  return layoutHash;
}
async function recordDiskCommit(base, commit) {
  if (await readDiskCommit(base) === commit) return;
  await mkdir(syncPath(base), { recursive: true });
  await writeAtomically(syncPath(base, DISK_RECORD), `${JSON.stringify({ commit, layout: await layoutId() })}
`);
}
async function readDiskCommit(base) {
  const recorded = await readFile(syncPath(base, DISK_RECORD), "utf8").then(parseStoreJson).catch(() => null);
  return recorded && typeof recorded.commit === "string" && recorded.layout === await layoutId() ? recorded.commit : null;
}
async function keepUnreceivedFiles(base, previous, branch, files, withheld, oversized, run) {
  if (!previous) return;
  const { rootFile } = await storeLayout();
  const missing = [...branch.keys()].filter((file) => !files.has(file) && !withheld.has(file) && !oversized.has(file) && !rootFile(file));
  if (!missing.length) return;
  const recorded = await readDiskCommit(base);
  if (recorded === previous) return;
  let written2 = null;
  if (recorded) {
    try {
      written2 = (await partition(await treeFiles(base, recorded))).shared;
    } catch {
      written2 = null;
    }
  }
  const top = (file) => file.includes("/") ? file.slice(0, file.indexOf("/")) : null;
  const absent = /* @__PURE__ */ new Set();
  for (const folder of new Set(missing.map(top))) if (folder !== null && !await lstat(path.join(base, folder)).catch(() => null)) absent.add(folder);
  const unreceived = written2 ? missing.filter((file) => !sameEntry(written2.get(file), branch.get(file))) : missing.filter((file) => absent.has(top(file)));
  if (!unreceived.length) return;
  for (const file of unreceived) files.set(file, branch.get(file));
  const contents = await readBlobs(base, unreceived.map((file) => ({ file, entry: branch.get(file) })));
  for (const [index, file] of unreceived.entries()) {
    const bytes = contents[index];
    if (!Buffer.isBuffer(bytes) || await outsideStore(base, file)) continue;
    const target = path.join(base, ...file.split("/"));
    const temporary = syncPath(base, `restore-${randomBytes(6).toString("hex")}`);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, bytes);
      await link(temporary, target);
    } catch (error) {
      if (!["EEXIST", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  run.restored = [.../* @__PURE__ */ new Set([...run.restored ?? [], ...unreceived])].sort();
}
function restoredIn(status, restored) {
  if (!restored?.length) return status;
  const listed = restored.slice(0, 5).map(shownPath).join(", ") + (restored.length > 5 ? `, and ${restored.length - 5} more` : "");
  const note = `The sync wrote back ${restored.length === 1 ? "1 file" : `${restored.length} files`} that the branch holds and the disk never received, as when an older Prism moved the branch, so the store keeps them: ${listed}.`;
  return { ...status, restored, message: [status.message, note].filter(Boolean).join(" ") };
}
const OBJECT_CHECK = "Git's object check, which every other machine's fetch applies, refuses it";
const TOO_LONG = `its name holds more than ${STORE_NAME_BYTES_MAX} bytes or its path more than ${STORE_PATH_BYTES_MAX}, so some machine could not write it`;
async function commitLocal(base, author, run) {
  run.pending = null;
  run.lockBusy = false;
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const previous = head.ok ? head.text : null;
  let branch;
  try {
    branch = await treeFiles(base, previous);
  } catch (error) {
    if (error.treeTooLarge) run.wideBranch = { files: error.treeTooLarge, bytes: error.listingBytes };
    else if (error.longPath) run.wideBranch = { path: error.longPath, long: true, kind: "an entry" };
    else throw error;
    return false;
  }
  run.wideBranch = null;
  const { shared, other } = await partition(branch);
  const withheld = /* @__PURE__ */ new Map();
  run.withheld = withheld;
  run.heldBack = /* @__PURE__ */ new Map();
  const oversized = /* @__PURE__ */ new Map();
  const files = await withFileLock(path.join(base, ARTIFACTS), async () => {
    const found = await localFiles(base, shared, withheld, oversized);
    await keepUnreceivedFiles(base, previous, shared, found, withheld, oversized, run);
    return found;
  }, void 0, { timeoutMs: run.lockTried ? SETTINGS.applyLockMs : 1 }).catch((error) => {
    if (error.code !== "lock_timeout") throw error;
    return null;
  });
  run.lockTried = true;
  run.lockBusy = files === null;
  if (run.lockBusy) {
    scheduleRecordSync(base);
    return false;
  }
  const { bound, boundText, rootFile } = await storeLayout();
  for (const [file, found] of oversized) {
    const target = path.join(base, ...file.split("/"));
    const mode = shared.get(file)?.mode ?? "100644";
    let size = found;
    if (size === null) {
      const hashed = await git(base, ["hash-object", "-w", "--no-filters", "--", target]);
      const object = hashed.ok && hashed.text ? hashed.text : null;
      const grown = object ? (await objectInfo(base, [object])).get(object)?.size : void 0;
      if (grown !== void 0 && grown > bound(file)) {
        size = grown;
        withheld.set(file, overBound(grown, bound(file), boundText, rootFile(file)));
      } else if (object) run.heldBack.set(file, { mode, object });
    }
    if (size !== null) {
      const disk = await lstat(target, { bigint: true }).catch(() => null);
      if (disk?.isFile()) run.heldBack.set(file, { mode, object: null, disk: diskIdentity(disk) });
    }
    if (shared.has(file)) files.set(file, shared.get(file));
    else files.delete(file);
  }
  const own = run.own ?? null;
  if (own) {
    for (const file of /* @__PURE__ */ new Set([...files.keys(), ...shared.keys()])) {
      if (own.files.has(file)) continue;
      if (shared.has(file)) files.set(file, shared.get(file));
      else files.delete(file);
    }
  }
  const message = own?.message ?? "prism: update records";
  const { treeFilesMax } = await storeLayout();
  for (; ; ) {
    const entries = besides(files, other);
    if (sameFiles(entries, branch)) {
      if (previous) await recordDiskCommit(base, previous);
      return false;
    }
    const changed = [.../* @__PURE__ */ new Set([...branch.keys(), ...entries.keys()])].filter((file) => !sameEntry(branch.get(file), entries.get(file))).sort();
    const listed = changed.slice(0, COMMIT_LIST).join("\n") + (changed.length > COMMIT_LIST ? `
\u2026 and ${changed.length - COMMIT_LIST} more` : "");
    const tree = await writeTree(base, entries);
    const commit = (await required(base, [...author, "commit-tree", tree, ...previous ? ["-p", previous] : [], "-m", message, "-m", listed])).text;
    const refused = await refusedObjects(base, commit, previous ? [previous] : [], { pushing: false });
    if (refused) {
      const culprits = changed.filter((file) => files.has(file) && refused.objects.includes(files.get(file).object) && (refused.places.get(files.get(file).object)?.includes(file) ?? true));
      const held = new Set([...branch.values()].map((entry) => entry.object));
      const inherited = !culprits.length && refused.objects.length > 0 && refused.objects.every((object) => held.has(object));
      if (!culprits.length && !inherited) throw new Error(`Git's object check, which every other machine's fetch applies, refuses the store's new commit, so it was not made: ${refused.message}`);
      if (culprits.length) {
        for (const file of culprits) {
          withheld.set(file, `${OBJECT_CHECK} (${refused.message})`);
          run.heldBack.set(file, files.get(file));
          if (shared.has(file)) files.set(file, shared.get(file));
          else files.delete(file);
        }
        continue;
      }
    }
    if (entries.size > treeFilesMax()) {
      run.pending = { commit, from: previous, files: entries.size, entries };
      return false;
    }
    await moveBranch(base, commit, previous, message);
    run.made = previous && run.made?.to === previous ? { from: run.made.from, to: commit } : { from: previous, to: commit };
    return true;
  }
}
async function refusedObjects(base, tip, known, { pushing = true } = {}) {
  const folder = syncPath(base, "object-check");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    const revisions = `${tip}
${known.map((commit) => `^${commit}
`).join("")}`;
    const history = await refusedHistoryInBatches(base, tip, known, pushing);
    if (history.reasons.length) return refusal(history.reasons, history.places);
    const handle = await open(path.join(folder, "objects.pack"), "w");
    let packed;
    try {
      packed = await gitRecords(base, ["pack-objects", "--revs", "--stdout", "--quiet", "--filter=blob:none"], { separator: null, maxBytes: PACK_BYTES_MAX, input: revisions, take: async (chunk) => {
        await handle.write(chunk);
      } });
    } finally {
      await handle.close();
    }
    if (packed.over) throw outputRefusal(`The commits and trees that the remote lacks pack to more than ${PACK_BYTES_MAX} bytes, more than a sync checks`, HISTORY_FIX, "the store's branch was not pushed");
    if (!packed.ok) throw Object.assign(new Error(packed.stderr || "git pack-objects failed."), { git: packed });
    const checked = await git(base, ["index-pack", "--strict", "-o", path.join(folder, "objects.idx"), path.join(folder, "objects.pack")]);
    if (checked.ok) return null;
    const reasons = checked.stderr.split("\n").filter((line) => line.startsWith("error: ")).map((line) => line.slice("error: ".length));
    return refusal(reasons.length ? reasons : [checked.stderr]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
async function refusedHistoryInBatches(base, tip, known, pushing) {
  const commits = (await historyCommits(base, ["rev-list", "--topo-order", "--reverse", "--parents", "--stdin"], `${tip}
${known.map((commit) => `^${commit}
`).join("")}`)).map((line) => line.split(" "));
  let size = Math.min(commits.length, 1024), ceiling = Infinity;
  for (let at = 0; at < commits.length; ) {
    const batch = commits.slice(at, at + size);
    const inBatch = new Set(batch.map(([commit]) => commit));
    const below = new Set(batch.flatMap(([, ...parents]) => parents).filter((parent) => !inBatch.has(parent)));
    const revisions = `${[...inBatch].join("\n")}
${[...below, ...known].map((commit) => `^${commit}
`).join("")}`;
    let history;
    try {
      history = await refusedHistory(base, revisions, pushing);
    } catch (error) {
      if (!error.outputBound) throw error;
      if (batch.length === 1) throw await commitRefusal(base, `the objects of commit ${batch[0][0]}`, batch[0][0]);
      ceiling = batch.length;
      size = Math.ceil(batch.length / 2);
      continue;
    }
    if (history.reasons.length) return history;
    at += batch.length;
    size = Math.max(1, Math.min(size * 2, ceiling - 1));
  }
  return { reasons: [], places: /* @__PURE__ */ new Map() };
}
const CHECKED_REF = "refs/prism-checked/branch";
async function checkedTip(base) {
  const checked = await git(base, ["rev-parse", "--verify", "--quiet", `${CHECKED_REF}^{commit}`]);
  return checked.ok && checked.text ? checked.text : null;
}
async function advanceChecked(base, remote) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok || !head.text) return;
  const checked = await checkedTip(base);
  if (checked === head.text) return;
  const walked = [...await knownCommits(base, remote), ...checked ? [checked] : []];
  try {
    if (await refusedObjects(base, head.text, walked)) return;
    if (await oversizedHistory(base, walked, head.text)) return;
  } catch (error) {
    if (error.outputBound) return;
    throw error;
  }
  await required(base, ["update-ref", CHECKED_REF, head.text]);
}
const PACK_BYTES_MAX = 1024 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const refusal = (reasons, places = /* @__PURE__ */ new Map()) => {
  const message = reasons.join("; ");
  return { message, objects: [...message.matchAll(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g)].map((match) => match[0]), places };
};
const ATTRIBUTES_LINE_MAX = 2048;
const ATTRIBUTES_BYTES_MAX = 100 * 1024 * 1024;
async function refusedHistory(base, revisions, pushing) {
  const where = /* @__PURE__ */ new Map();
  const listed = await gitRecords(base, ["rev-list", "--objects", "--stdin"], { separator: 10, limit: historyRecordsMax(), maxBytes: historyBytesMax(), maxRecord: LISTED_META_MAX + LISTED_PATH_BYTES_MAX, input: revisions, take: (line) => {
    const space = line.indexOf(32);
    const object = (space < 0 ? line : line.subarray(0, space)).toString("latin1");
    if (OBJECT_ID.test(object)) where.set(object, space < 0 ? "" : pathOfBytes(line.subarray(space + 1)));
  } });
  if (!listed.ok && listed.stderr.includes(TREE_DEPTH_TEXT)) return { reasons: [deepTreeReason()], places: /* @__PURE__ */ new Map() };
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git rev-list failed."), { git: listed });
  if (listed.over) throw historyRefusal("the objects that the remote lacks");
  if (listed.long) {
    const space = listed.long.indexOf(32);
    const shown = `${pathOfBytes(listed.long.subarray(space + 1, space + 1 + 64))}\u2026`;
    return { reasons: [`largePath: ${longEntry(shown)}`], places: /* @__PURE__ */ new Map([[listed.long.subarray(0, space).toString("latin1"), [shown]]]) };
  }
  const none = { reasons: [], places: /* @__PURE__ */ new Map() };
  if (!where.size) return none;
  const types = await objectInfo(base, [...where.keys()]);
  const trees = [...where.keys()].filter((object) => types.get(object)?.type === "tree");
  const roots = /* @__PURE__ */ new Set();
  const reasons = [];
  const places = /* @__PURE__ */ new Map();
  const place = (tree, name) => where.get(tree) ? `${where.get(tree)}/${name}` : name;
  const refuse = (object, reason, at = []) => {
    reasons.push(`object ${object}: ${reason}`);
    if (at.length) places.set(object, [...places.get(object) ?? [], ...at]);
  };
  const historyContents = (objects) => objectContents(base, objects, historyBytesMax(), "the commits and trees that the remote lacks").catch((error) => {
    throw error.outputBound ? historyRefusal("the commits and trees that the remote lacks") : error;
  });
  for (const [commit, contents] of await historyContents([...where.keys()].filter((object) => types.get(object)?.type === "commit"))) {
    const problem = commitProblem(contents, commit.length);
    if (problem) refuse(commit, `${problem.id}: ${problem.text}`);
    const tree = /^tree ([0-9a-f]+)\n/.exec(contents.toString("latin1"))?.[1];
    if (tree) roots.add(tree);
  }
  const found = /* @__PURE__ */ new Map();
  const misnamed = /* @__PURE__ */ new Map();
  const links = /* @__PURE__ */ new Map();
  const treeContents = await historyContents(trees);
  const deep = tooDeepTree(roots, treeContents);
  if (deep) {
    const shown = deep.names.slice(0, 3).map(pathOfBytes).join("/");
    refuse(deep.root, deepTreeReason(), [`${shown}/\u2026`]);
  }
  for (const [tree, contents] of treeContents) {
    const size = tree.length / 2;
    for (const problem of treeProblems(contents, size)) {
      const shown = problem.names.map((name) => name.length > STORE_NAME_BYTES_MAX ? `${pathOfBytes(name.subarray(0, 64))}\u2026` : pathOfBytes(name));
      refuse(tree, `${problem.id}: ${problem.text}`, shown.length ? [...new Set(shown)].map((name) => place(tree, name)) : [where.get(tree) || "/"]);
    }
    for (const entry of treeEntries(contents, size)) {
      const name = pathOfBytes(entry.name);
      if (pushing && isLinkMode(entry.mode)) links.set(entry.object, [...links.get(entry.object) ?? [], place(tree, name)]);
      if (gitFileName(entry.name)) {
        if (roots.has(tree) && name === ".gitattributes" && FILE_MODES.has(entry.modeText)) found.set(entry.object, [...found.get(entry.object) ?? [], ".gitattributes"]);
        else if (pushing) misnamed.set(tree, [...misnamed.get(tree) ?? [], place(tree, name)]);
      }
    }
  }
  for (const [tree, at] of misnamed) refuse(tree, `${at.map(shownPath).join(", ")}: a name that Git reads as .gitattributes or .gitmodules, which a store holds only as the file .gitattributes at its root`, at);
  const blobs = found.size || links.size ? await objectInfo(base, [...found.keys(), ...links.keys()]) : /* @__PURE__ */ new Map();
  const readable = [];
  for (const object of found.keys()) {
    const info = blobs.get(object);
    if (!info) refuse(object, "gitattributesMissing: unable to read .gitattributes blob", found.get(object));
    else if (info.type !== "blob") refuse(object, "gitattributesBlob: non-blob found at .gitattributes", found.get(object));
    else if (info.size > ATTRIBUTES_BYTES_MAX) refuse(object, "gitattributesLarge: .gitattributes too large to parse", found.get(object));
    else readable.push(object);
  }
  const attributes = await readBlobs(base, readable.map((object) => ({ file: ".gitattributes", entry: { mode: "100644", object } })));
  for (const [index, contents] of attributes.entries()) {
    const object = readable[index];
    if (!Buffer.isBuffer(contents)) continue;
    const text = contents.includes(0) ? contents.subarray(0, contents.indexOf(0)) : contents;
    for (let at = 0; at < text.length; ) {
      const end = text.indexOf(10, at) < 0 ? text.length : text.indexOf(10, at);
      if (end - at >= ATTRIBUTES_LINE_MAX) {
        refuse(object, "gitattributesLineLength: .gitattributes has too long lines to parse", found.get(object));
        break;
      }
      at = end + 1;
    }
  }
  const targets = [];
  for (const [object, at] of links) {
    const info = blobs.get(object);
    if (!info) refuse(object, "symlinkTargetMissing: unable to read <symlink-target> blob", at);
    else if (info.type !== "blob") refuse(object, "symlinkTargetBlob: non-blob found at <symlink-target>", at);
    else if (info.size > LINK_TARGET_BYTES_MAX) refuse(object, "symlinkTargetLength: symlink target too long", at);
    else targets.push(object);
  }
  const read = await readBlobs(base, targets.map((object) => ({ file: "<symlink-target>", entry: { mode: "100644", object }, max: LINK_TARGET_BYTES_MAX })));
  for (const [index, contents] of read.entries()) {
    const object = targets[index];
    const problem = linkTargetProblem(contents);
    if (problem) refuse(object, `${problem.id}: ${problem.text}`, links.get(object));
  }
  return { reasons, places };
}
const deepTreeReason = () => `maxTreeDepth: ${TREE_DEPTH_TEXT}, since a folder is nested more than ${TREE_DEPTH_MAX} folders deep`;
async function objectInfo(base, objects) {
  const info = /* @__PURE__ */ new Map();
  if (!objects.length) return info;
  for (const line of await gitLines(base, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: `${objects.join("\n")}
`, limit: objects.length, maxRecord: 128, what: "the store's object sizes" })) {
    const [object, type, size] = line.split(" ");
    if (size !== void 0 && type !== "missing") info.set(object, { type, size: Number(size) });
  }
  return info;
}
async function objectContents(base, objects, maxBytes, what = "the store's objects") {
  const contents = /* @__PURE__ */ new Map();
  if (!objects.length) return contents;
  let header = Buffer.alloc(0), current = null, parts = [], have = 0;
  const listed = await gitRecords(base, ["cat-file", "--batch"], { separator: null, maxBytes, input: `${objects.join("\n")}
`, take: (chunk) => {
    for (let at = 0; at < chunk.length; ) {
      if (!current) {
        const end = chunk.indexOf(10, at);
        if (end < 0) {
          header = Buffer.concat([header, chunk.subarray(at)]);
          return;
        }
        const [object, type, size] = Buffer.concat([header, chunk.subarray(at, end)]).toString("latin1").split(" ");
        header = Buffer.alloc(0);
        at = end + 1;
        if (type === "missing" || size === void 0) continue;
        current = { object, need: Number(size) + 1 };
        parts = [];
        have = 0;
      }
      const piece = chunk.subarray(at, Math.min(chunk.length, at + current.need - have));
      parts.push(piece);
      have += piece.length;
      at += piece.length;
      if (have === current.need) {
        const body = Buffer.concat(parts);
        contents.set(current.object, body.subarray(0, body.length - 1));
        current = null;
        parts = [];
      }
    }
  } });
  if (listed.over) throw outputRefusal(`Git's output of ${what} holds more than ${maxBytes} bytes, more than a sync reads`);
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git cat-file failed."), { git: listed });
  return contents;
}
async function alignWithUpstream(base, author, head, theirs) {
  const [mine, upstream] = await Promise.all([treeFiles(base, head), treeFiles(base, theirs)]);
  const entries = besides((await partition(mine)).shared, (await partition(upstream)).other);
  if (sameFiles(entries, mine)) return;
  const commit = (await required(base, [...author, "commit-tree", await writeTree(base, entries), "-p", head, "-m", "prism: keep the remote's files that Prism does not write"])).text;
  await moveBranch(base, commit, head, "prism: sync records");
}
async function upstreamOf(base) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch) return null;
  const remote = (await git(base, ["config", `branch.${branch}.remote`])).text;
  const merge2 = (await git(base, ["config", `branch.${branch}.merge`])).text;
  return remote && merge2 ? { branch, remote, merge: merge2 } : null;
}
async function counts(base) {
  const result = await git(base, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const [ahead, behind] = result.ok ? result.text.split(/\s+/).map(Number) : [0, 0];
  return { ahead: ahead || 0, behind: behind || 0 };
}
async function unpublished(base) {
  return !(await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"])).ok && (await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}
const NO_HOOKS = "no-hooks";
const HOOK_EVENTS = [
  "applypatch-msg",
  "commit-msg",
  "fsmonitor-watchman",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-receive",
  "post-rewrite",
  "post-update",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "pre-receive",
  "prepare-commit-msg",
  "proc-receive",
  "push-to-checkout",
  "receive-report",
  "reference-transaction",
  "sendemail-validate",
  "update"
];
const REMOTE_HELPER_CONFIG = [
  "core.alternateRefsCommand=exit 0;",
  "core.alternateRefsPrefixes=",
  "receive.denyCurrentBranch=refuse",
  "core.fsmonitor=",
  "receive.autogc=false",
  "gc.auto=0",
  "gc.autoPackLimit=0",
  "maintenance.auto=false",
  ...HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`)
];
const shellQuoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const PINNED_HELPER = "prism_pinned_helper";
const UTF8_EXACT = new TextDecoder("utf-8", { fatal: true });
async function noHooksFolder() {
  const folder = path.join(reviewAppDirectory(), NO_HOOKS);
  try {
    await mkdir(folder, { recursive: true, mode: 448 });
  } catch (error) {
    throw new Error(`Prism could not create the empty hooks folder ${folder} that a sync with a local remote needs: ${error.message}`);
  }
  return process.platform === "win32" ? folder.replaceAll("\\", "/") : folder;
}
async function configuredHooks(repository) {
  const listed = await git(repository, [`--git-dir=${repository}`, "config", "--null", "--get-regexp", "^hook\\."]);
  const names = /* @__PURE__ */ new Set();
  for (const entry of listed.ok ? listed.stdout.toString("latin1").split("\0") : []) {
    const key = Buffer.from(entry.split("\n", 1)[0], "latin1");
    let text;
    try {
      text = UTF8_EXACT.decode(key);
    } catch {
      throw new Error("The remote store's Git configuration sets up a hook whose name is not UTF-8, which Prism cannot turn off, so it does not sync with that remote. Remove that hook's settings from the remote repository's configuration.");
    }
    const match = /^hook\.(.+)\.(command|event|parallel)$/i.exec(text);
    if (match) names.add(match[1]);
  }
  return [...names];
}
async function refuseRewrite(option, repository, base) {
  const listed = await git(base, ["config", "--null", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
  if (!listed.ok) return;
  const bytes = Buffer.from(repository);
  for (const entry of listed.stdout.toString("latin1").split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const kind = entry.slice(0, split).endsWith(".pushinsteadof") ? "pushInsteadOf" : "insteadOf";
    if (kind === "pushInsteadOf" && option !== "--receive-pack") continue;
    const prefix = Buffer.from(entry.slice(split + 1), "latin1");
    if (bytes.subarray(0, prefix.length).equals(prefix)) {
      throw new Error(`A url.<base>.${kind} rule in Git's configuration matches ${repository}, the repository that the store's local remote reaches, so Git would reach another place for that path than the repository Prism checked, and Prism does not sync with that remote. Change the rule so that it no longer matches that path.`);
    }
  }
}
async function helperForRepository(option, repository, base) {
  const program = option === "--receive-pack" ? "receive-pack" : "upload-pack";
  await refuseRewrite(option, repository, base);
  const named = await configuredHooks(repository);
  const unnamed = named.find((name) => name.includes("="));
  if (unnamed !== void 0) throw new Error(`The remote store's Git configuration sets up a hook named "${unnamed}", which Prism cannot turn off, so it does not sync with that remote. Remove the hook.${unnamed}.* settings from the remote repository's configuration.`);
  const settings = [`core.hooksPath=${await noHooksFolder()}`, ...REMOTE_HELPER_CONFIG, ...named.map((name) => `hook.${name}.enabled=false`)].map((setting) => `-c ${shellQuoted(setting)}`);
  const command = `git ${settings.join(" ")} ${program} ${shellQuoted(repository)}`;
  return [`${option}=${PINNED_HELPER}() { exec ${command}; }; ${PINNED_HELPER}`, ...program === "receive-pack" ? ["--no-signed"] : []];
}
async function localRemoteRepository(url, base) {
  try {
    return await localRepository(url, base);
  } catch (error) {
    if (!(error instanceof UnresolvableLocalRemote)) throw error;
    throw new Error(`Prism cannot tell which repository Git opens for the local remote ${withoutCredentials(url)}, because ${error.message}, so it does not use that remote. ${error.hint ?? "Name the remote repository by its absolute path or by a file:// URL of that path."}`);
  }
}
const noLocalRepository = (url) => `No Git repository is found at the local remote ${withoutCredentials(url)}, so Prism neither fetched from it nor pushed to it.`;
function gitUrlText(result) {
  const bytes = result.stdout.subarray(0, result.stdout.length - (result.stdout.at(-1) === 10 ? 1 : 0));
  try {
    return UTF8_EXACT.decode(bytes);
  } catch {
    if (!bytes.toString("latin1").split("\n").some((url) => localTransport(url))) return result.text;
    throw new Error("The store's remote URL is a local path that is not UTF-8, so Prism cannot tell which repository Git opens for it and does not use that remote. Rename the folders on the way to the remote repository so that every name is UTF-8.");
  }
}
async function remoteHelperOption(option, urls, base = process.cwd()) {
  const found = await Promise.all(urls.map((url) => localRemoteRepository(url, base)));
  if (found.every((entry) => entry === null)) return [];
  const missing = urls.find((url, at) => found[at]?.stops);
  if (missing !== void 0) throw new Error(noLocalRepository(missing));
  const paths = [...new Set(found.filter((entry) => entry?.path).map((entry) => entry.path))];
  if (paths.length > 1) throw new Error(`The URLs ${urls.map(withoutCredentials).join(", ")} reach more than one local repository, and a helper enters only one.`);
  return helperForRepository(option, paths[0], base);
}
async function remoteTargets(base, remote, option) {
  const asIs = { targets: [{ target: remote, helper: [] }] };
  const key = option === "--receive-pack" ? "receivepack" : "uploadpack";
  for (const setting of [key, "vcs"]) if ((await git(base, ["config", "--get", `remote.${remote}.${setting}`])).ok) return asIs;
  const urls = option === "--receive-pack" ? await pushUrls(base, remote) : [await fetchUrl(base, remote)];
  const found = await Promise.all(urls.map((url) => localRemoteRepository(url, base)));
  if (found.every((entry) => entry === null)) return asIs;
  const missing = urls.find((url, at) => found[at]?.stops);
  if (missing !== void 0) return { missing: noLocalRepository(missing) };
  const other = urls.find((url, at) => !found[at]?.path);
  if (other !== void 0) throw new Error(`A push to the remote ${remote} reaches ${withoutCredentials(other)} as well as a local repository, and Prism names a local repository by its own path, so it does not push to that remote. Give each repository a remote of its own.`);
  const paths = [...new Set(found.map((entry) => entry.path))];
  const helpers = await Promise.all(paths.map((target) => helperForRepository(option, target, base)));
  return { targets: paths.map((target, at) => ({ target, helper: helpers[at] })) };
}
async function fetchUrl(base, remote) {
  const url = await git(base, ["ls-remote", "--get-url", remote]);
  return url.ok && url.text ? gitUrlText(url) : remote;
}
async function pushUrls(base, remote) {
  const named = await git(base, ["remote", "get-url", "--push", "--all", remote]);
  return named.ok && named.text ? gitUrlText(named).split("\n") : [await fetchUrl(base, remote)];
}
async function fetchRemote(base, remote) {
  const named = (await git(base, ["remote", "get-url", remote])).ok;
  const { targets, missing } = await remoteTargets(base, remote, "--upload-pack");
  if (missing) return { ok: false, stderr: missing };
  const [{ target, helper }] = targets;
  if (named) await recordShared(base, remote);
  const fetched = await git(base, [
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "--quiet",
    "--prune",
    "--no-prune-tags",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-commit-graph",
    ...helper,
    target,
    ...named ? [`+refs/heads/*:refs/remotes/${remote}/*`] : []
  ]);
  if (fetched.ok && named) await recordShared(base, remote);
  return fetched;
}
const SHARED_REFS = "refs/prism-store/shared";
const refObjects = async (base, prefix) => (await gitLines(base, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", prefix], { limit: REMOTE_REFS_MAX, maxRecord: 2 * LISTED_PATH_BYTES_MAX + LISTED_META_MAX, what: `the refs below ${prefix}` })).filter(Boolean).map((line) => line.split(" ")).filter(([, , symref]) => !symref).map(([ref, object]) => [ref, object]);
async function recordShared(base, remote, pushed = []) {
  if (!REMOTE_NAME.test(remote)) return;
  const prefix = `${SHARED_REFS}/${remote}/`;
  const held = await refObjects(base, prefix);
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const shared = /* @__PURE__ */ new Set();
  if (head.ok && head.text) {
    const holds = async (object) => (await git(base, ["merge-base", "--is-ancestor", object, head.text])).ok;
    for (const object of new Set(held.map(([, object2]) => object2))) if (await holds(object)) shared.add(object);
    for (const object of /* @__PURE__ */ new Set([...(await refObjects(base, `refs/remotes/${remote}/`)).map(([, object2]) => object2), ...pushed])) {
      if (await holds(object)) {
        shared.add(object);
        continue;
      }
      const common = await gitLinesResult(base, ["merge-base", "--all", head.text, object], { limit: REMOTE_REFS_MAX, maxRecord: 128, what: "the merge bases of the store's branch and a remote branch" });
      if (common.ok) for (const commit of common.lines.filter(Boolean)) shared.add(commit);
    }
  }
  const tips = [...shared];
  const kept = new Set(tips.length > 1 ? (await gitLines(base, ["merge-base", "--independent", ...tips], { limit: tips.length, maxRecord: 128 })).filter(Boolean) : tips);
  const updates = [
    ...held.filter(([ref, object]) => !kept.has(object) || ref !== `${prefix}${object}`).map(([ref]) => `delete ${ref}
`),
    ...[...kept].filter((object) => !held.some(([ref]) => ref === `${prefix}${object}`)).map((object) => `update ${prefix}${object} ${object}
`)
  ];
  if (updates.length) await required(base, ["update-ref", "--stdin"], { input: updates.join("") });
}
async function knownCommits(base, remote) {
  const refs = [...await refObjects(base, `refs/remotes/${remote}/`), ...REMOTE_NAME.test(remote) ? await refObjects(base, `${SHARED_REFS}/${remote}/`) : []];
  return [...new Set(refs.map(([, object]) => object))];
}
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
async function pushBranch(base, remote, destination, { setUpstream } = {}) {
  const { targets, missing } = await remoteTargets(base, remote, "--receive-pack");
  if (missing) return { ok: false, stderr: missing };
  const byName = targets.length === 1 && targets[0].target === remote;
  const named = (await git(base, ["remote", "get-url", remote])).ok;
  const pushed = (await required(base, ["rev-parse", "--verify", "HEAD"])).text;
  let result;
  for (const { target, helper } of targets) {
    result = await git(base, [
      "-c",
      "push.followTags=false",
      ...REMOTE_NAME.test(remote) ? ["-c", `remote.${remote}.mirror=false`] : [],
      "push",
      "--quiet",
      "--no-follow-tags",
      "--no-recurse-submodules",
      ...helper,
      ...setUpstream && byName ? ["--set-upstream"] : [],
      target,
      `HEAD:${destination}`
    ]);
    if (!result.ok) return result;
    if (!byName && named && destination.startsWith("refs/heads/")) await required(base, ["update-ref", `refs/remotes/${remote}/${destination.slice("refs/heads/".length)}`, pushed]);
  }
  if (named) await recordShared(base, remote, [pushed]);
  if (setUpstream && !byName) {
    await required(base, ["config", `branch.${setUpstream}.remote`, remote]);
    await required(base, ["config", `branch.${setUpstream}.merge`, destination]);
  }
  return result;
}
async function sync(base, options) {
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return writeStatus(base, { state: "not_a_repository", message: "Git is not available, so the record store is not synced." });
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return writeStatus(base, { state: "not_a_repository", message: "The record store is not the top of a Git checkout, so it is not synced." });
  const tooOld = await gitTooOld();
  if (tooOld) return writeStatus(base, { state: "git_failed", message: tooOld });
  const author = await identity(base);
  await migrateLineEndings(base);
  const conflicts = await recoverSaved(base);
  const run = {};
  const report = (status) => writeStatus(base, restoredIn(withheldIn({ ...status, conflicts: [...conflicts, ...status.conflicts ?? []] }, run.withheld), run.restored));
  const checked = await checkedTip(base);
  const started = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const stopped = async (pastTree) => {
    if (run.made) await takeOffCommit(base, run.made);
    if (await checkedTip(base) !== checked) await git(base, checked ? ["update-ref", CHECKED_REF, checked] : ["update-ref", "-d", CHECKED_REF]);
    const now = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const kept = now.ok && now.text !== (started.ok ? started.text : null);
    return writeStatus(base, restoredIn(withheldIn({ state: "merge_failed", message: await pastTreeRefusal(pastTree, kept), conflicts, ...await counts(base) }, null), run.restored));
  };
  const locked = () => ({ state: "skipped" });
  if (options.commit) {
    run.own = { message: options.commit.message, files: new Set(options.commit.files) };
    try {
      await commitLocal(base, author, run);
    } finally {
      run.own = null;
    }
    if (run.lockBusy) return locked();
  }
  await commitLocal(base, author, run);
  if (run.lockBusy) return locked();
  let upstream = await upstreamOf(base);
  if (run.wideBranch) return report({ state: "merge_failed", message: await wideBranchRefusal(base, upstream?.remote ?? "origin", { upstream: false, sent: "merged or pushed", unsafe: run.wideBranch }), ...await counts(base) });
  if (run.pending && !upstream) return stopped({ files: run.pending.files });
  if (!upstream && managed.has(base)) {
    const published = await publishBranch(base, author, options, run, conflicts);
    if (published.status) return report(published.status);
    upstream = published.upstream;
  }
  if (!upstream) return report({ state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  await advanceChecked(base, upstream.remote);
  let busy = false;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    if (attempt > 1) await commitLocal(base, author, run);
    if (run.lockBusy) return locked();
    if (run.wideBranch) return report({ state: "merge_failed", message: await wideBranchRefusal(base, upstream.remote, { upstream: false, sent: "merged or pushed", unsafe: run.wideBranch }), ...await counts(base) });
    const fetched = await fetchRemote(base, upstream.remote);
    if (!fetched.ok) return report({ state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options, run, upstream.remote);
    if (merged.pastTree) return stopped(merged.pastTree);
    if (merged.failed) return report({ state: "merge_failed", message: merged.failed, ...await counts(base) });
    conflicts.push(...merged.conflicts);
    busy = !merged.applied;
    if (busy) continue;
    const { ahead } = await counts(base);
    if (!ahead && !await unpublished(base)) return report(settled([]));
    const refused = await unpushable(base, upstream.remote);
    if (refused) return report({ state: "merge_failed", message: refused, ...await counts(base) });
    await options.beforePush?.();
    const pushed = await pushBranch(base, upstream.remote, upstream.merge);
    if (pushed.ok) return report({ ...settled([]), ...await counts(base) });
    if (!/\[rejected\]|fetch first|non-fast-forward|cannot lock ref|incorrect old value/i.test(pushed.stderr)) return report({ state: "push_rejected", message: pushed.stderr, ...await counts(base) });
  }
  if (busy) {
    scheduleRecordSync(base);
    return report({ state: "merge_failed", message: "Record files changed or stayed locked while the upstream was merged, so the store kept its branch and the next sync merges again.", ...await counts(base) });
  }
  return report({ state: "push_rejected", message: `The push was rejected ${PUSH_ATTEMPTS} times because others pushed first.`, ...await counts(base) });
}
function withheldIn(status, withheld) {
  const value = status.state === "ok" && settled(status.conflicts).state === "conflicts" ? { ...status, ...settled(status.conflicts) } : status;
  if (!withheld?.size) return value;
  const listed = [...withheld].slice(0, 5).map(([file, reason]) => `${shownPath(file)}, because ${reason}`).join("; ");
  const more = withheld.size > 5 ? `; and ${withheld.size - 5} more` : "";
  const reasons = [...withheld.values()];
  const fixes = [
    [(reason) => reason === TOO_LONG, "Give each file whose name or path is too long a shorter name in the store, and the next sync commits it."],
    [(reason) => reason.includes(OVER_BOUND), "Make each file above its kind's bound smaller than that bound in the store, and the next sync commits it."],
    [(reason) => reason.startsWith(OBJECT_CHECK), "Fix each file that Git's object check refuses in the store, as its reason says, and the next sync commits it."],
    [(reason) => reason.startsWith(OVER_COMMENTS), "Move each comment file that the sync did not commit out of its comment folder, keeping what it says if that matters, since no reader shows a comment of a folder that holds more comment files than an artifact's comments may hold, and no sync commits more of them; the folder's other comments then show again."]
  ].filter(([fits]) => reasons.some(fits)).map(([, fix]) => fix);
  const others = ["ok", "conflicts"].includes(value.state) ? "Every other change synced as usual." : "Every other change is committed on this machine only, and reaches the remote once a sync can push again.";
  const note = `The sync did not commit ${listed}${more}. ${fixes.join(" ")} ${others}`;
  return { ...value, withheld: [...withheld].map(([file, reason]) => ({ path: file, reason })), message: [value.message, note].filter(Boolean).join(" ") };
}
async function publishBranch(base, author, options, run, conflicts) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch || !(await git(base, ["config", "--local", "--get", "remote.origin.url"])).ok) return { upstream: null };
  const fetched = await fetchRemote(base, "origin");
  if (!fetched.ok) return { status: { state: "fetch_failed", message: fetched.stderr } };
  lastFetch.set(base, Date.now());
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const theirs = await git(base, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (theirs.ok) {
    if (!head.ok) await refuseUnsafeTree(base, theirs.text);
    if (!head.ok) {
      const copies = run.heldBack?.size ? heldCopies(run, /* @__PURE__ */ new Map(), await treeFiles(base, theirs.text)) : [];
      const adopted = await replaceFiles(base, run, { from: null, to: theirs.text, copies }, options);
      conflicts.push(...adopted.conflicts);
      if (!adopted.applied) return { status: { state: "merge_failed", message: "Record files changed or stayed locked while the upstream was applied, so the next sync applies it again." } };
    }
    await required(base, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    return { upstream: await upstreamOf(base) };
  }
  if (!head.ok) return { status: { state: "ok", message: "The store and its remote are still empty, so there is nothing to sync yet." } };
  await alignWithUpstream(base, author, head.text, null);
  const refused = await unpushable(base, "origin", { upstream: false });
  if (refused) return { status: { state: "merge_failed", message: refused } };
  await options.beforePush?.();
  const pushed = await pushBranch(base, "origin", `refs/heads/${branch}`, { setUpstream: branch });
  if (!pushed.ok) return { status: { state: "push_rejected", message: pushed.stderr } };
  return { upstream: await upstreamOf(base) };
}
async function merge(base, author, options, run, remote) {
  const upstream = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const pending = run.pending && head.ok && run.pending.from === head.text ? run.pending.entries : null;
  if (run.pending && !pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
  if (!upstream.ok && pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
  if (!upstream.ok) {
    if (head.ok) await alignWithUpstream(base, author, head.text, null);
    return { applied: true, conflicts: [] };
  }
  const theirs = upstream.text;
  if (head.ok && (await git(base, ["merge-base", "--is-ancestor", theirs, head.text])).ok) {
    if (pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
    await refuseUnsafeTree(base, theirs);
    await alignWithUpstream(base, author, head.text, theirs);
    return { applied: true, conflicts: [] };
  }
  await refuseUnsafeTree(base, theirs);
  if (!head.ok || !pending && (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok) {
    const from = head.ok ? head.text : null;
    const kept = run.heldBack?.size ? heldCopies(run, await treeFiles(base, from), await treeFiles(base, theirs)) : [];
    return replaceFiles(base, run, { from, to: theirs, copies: kept }, options);
  }
  const mergeBase = await git(base, ["merge-base", head.text, theirs]);
  if (!mergeBase.ok || !mergeBase.text) return { failed: "The store's branch and its upstream share no commit, so the store was left as it was.", conflicts: [] };
  const [original, local, upstreamFiles] = await Promise.all([mergeBase.text, pending ?? head.text, theirs].map(async (commit2) => await partition(typeof commit2 === "string" ? await treeFiles(base, commit2) : commit2)));
  const over = await oversizedChange(base, original.shared, local.shared);
  if (over) {
    const fix = await takeOffAdvice(base, {
      upstream: false,
      known: await knownCommits(base, remote),
      paths: [over.path],
      holds: (_file, { size }) => size > over.bound,
      until: "each file while it stays above its bound",
      instead: oversizedFix(over.path)
    });
    return { failed: `The store's branch holds ${await describeOversizedEntry(over)}, so the upstream was not merged and the branch was not pushed, since every other machine's sync would then refuse the remote's branch. ${fix}`, conflicts: [] };
  }
  const placed = await placeByIdentity(base, original.shared, local.shared, upstreamFiles.shared);
  const { result, conflicts: fileConflicts } = await mergeFiles(base, placed.original, placed.local, placed.upstream);
  const merges = await structuralMerges(base, placed.original, placed.local, placed.upstream);
  const views = new Set(merges.views);
  const takeUpstream = (file) => {
    if (placed.upstream.has(file)) result.set(file, placed.upstream.get(file));
    else result.delete(file);
  };
  const fallback = [.../* @__PURE__ */ new Set([...fileConflicts, ...merges.fallback])].filter((file) => !merges.merged.has(file) && !views.has(file));
  for (const file of [...fallback, ...views]) takeUpstream(file);
  for (const [file, contents] of merges.merged) result.set(file, { mode: "100644", object: (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: contents })).text });
  const clashes = [...settleFolders(result, placed.upstream), ...settleLetterCase(result, placed.local, placed.upstream)];
  const inClash = (file) => clashes.some((place) => file === place || file.startsWith(`${place}/`));
  const conflicted = [...clashes, ...fallback.filter((file) => !inClash(file))];
  const { rootFile } = await storeLayout();
  const other = conflicted.filter((file) => !isSavedFile(file) && !rootFile(file));
  if (other.length) return { failed: `The upstream conflicts with local changes to ${other.slice(0, 5).join(", ")}, so the store was left as it was.`, conflicts: [] };
  const stranded = strandedFiles(result);
  for (const [file] of stranded) result.delete(file);
  const surplus = await surplusComments(result, placed.upstream);
  for (const [file] of surplus) result.delete(file);
  await placedIdentities(base, result, placed.identities);
  const { treeFilesMax } = await storeLayout();
  const merged = besides(result, upstreamFiles.other);
  if (merged.size > treeFilesMax()) return { pastTree: { files: merged.size }, conflicts: [] };
  const clash = letterCaseClash(merged.keys());
  if (clash) return { failed: `The merge would hold ${describeUnsafeEntry({ path: clash[1], clash: clash[0] })}, so the store was left as it was. Remove or rename one of them.`, conflicts: [] };
  const tree = await writeTree(base, merged);
  const commit = (await required(base, [...author, "commit-tree", tree, "-p", head.text, "-p", theirs, "-m", `prism: merge records from ${(await git(base, ["rev-parse", "--abbrev-ref", "@{upstream}"])).text || "upstream"}`])).text;
  const copies = conflictCopies(placed.local, placed.upstream, conflicted);
  const bothChanged = new Map(copies.filter(([file, entry]) => entry && rootFile(file)));
  const undoneFiles = copies.filter(([file, entry]) => !entry && rootFile(file) && !placed.local.has(file)).map(([file]) => ({ file }));
  const undoneRecords = copies.filter(([file, entry]) => !entry && isRecordFile(file) && !isQuietConflict(file) && !placed.local.has(file)).map(([file]) => ({ record: file }));
  for (const [file, entry] of [...stranded, ...surplus]) if (!copies.some(([candidate]) => candidate === file)) copies.push([file, entry]);
  for (const [file, entry] of placed.saved) {
    const at = copies.findIndex(([candidate]) => candidate === file);
    if (at < 0) copies.push([file, entry]);
    else copies[at] = [file, entry];
  }
  for (const [file, entry] of heldCopies(run, local.shared, merged)) {
    const at = copies.findIndex(([candidate]) => candidate === file);
    if (at < 0) copies.push([file, entry]);
    else copies[at] = [file, entry];
  }
  const theirsSaved = new Set(copies.filter(([file, entry]) => placed.theirs.has(file) && placed.saved.get(file) === entry).map(([file]) => file));
  const tooLongSaved = new Map(copies.filter(([file, entry]) => placed.tooLong.has(file) && placed.saved.get(file) === entry).map(([file]) => [file, placed.tooLong.get(file)]));
  const surplusSaved = new Set(copies.filter(([file, entry]) => surplus.some(([candidate, left]) => candidate === file && left === entry)).map(([file]) => file));
  const bothSaved = new Set(copies.filter(([file, entry]) => entry && bothChanged.get(file) === entry).map(([file]) => file));
  return replaceFiles(base, run, { from: head.text, diskTree: pending ?? head.text, to: commit, copies, theirs: theirsSaved, tooLong: tooLongSaved, surplus: surplusSaved, bothChanged: bothSaved, undone: [...placed.undone, ...undoneFiles, ...undoneRecords] }, options);
}
async function replaceFiles(base, run, { from, diskTree = from, to, copies, theirs = /* @__PURE__ */ new Set(), tooLong = /* @__PURE__ */ new Map(), surplus = /* @__PURE__ */ new Set(), bothChanged = /* @__PURE__ */ new Set(), undone = [] }, options) {
  const held = run.heldBack ?? /* @__PURE__ */ new Map();
  let stage = copies.length || undone.length ? await stageLocal(base, copies, { from, to, theirs, tooLong, surplus, bothChanged, undone }) : null;
  const progress = {
    replacing: async (file) => {
      if (stage) {
        await markReplaced(stage, file);
        await moveAside(base, stage, file);
      }
    },
    leaving: async (file, bytes) => {
      stage ??= await stageLocal(base, [], { from, to });
      return bytes === null ? stageSurplusMove(base, stage, file) : stageSurplus(stage, file, bytes);
    }
  };
  const applied = await apply(base, from, to, options, progress, held, diskTree);
  await markArtifactIndexStale(base);
  if (applied) {
    for (const [file, entry] of copies) if (entry && held.get(file) === entry) {
      held.delete(file);
      run.withheld?.delete(file);
    }
  }
  return { applied, conflicts: stage ? await settleStage(base, stage, applied) : [] };
}
function heldCopies(run, before, after) {
  return [...run.heldBack ?? []].filter(([file]) => !sameEntry(before.get(file), after.get(file)));
}
const identityPath = (location) => `${ARTIFACT_IDENTITY}/${location}`;
const statusPath = (location) => `${ARTIFACT_STATUS}/${location}/${STATUS_RECORD_NAME}`;
const isIdentityFile = (relative) => relative.startsWith(`${ARTIFACT_IDENTITY}/`);
function derivedLocation(file) {
  if (file.startsWith(`${ARTIFACT_STATUS}/`) && file.endsWith(`/${STATUS_RECORD_NAME}`)) return file.slice(ARTIFACT_STATUS.length + 1, -(STATUS_RECORD_NAME.length + 1)) || null;
  if (!file.startsWith(`${ARTIFACT_COMMENTS}/`)) return null;
  const location = file.slice(ARTIFACT_COMMENTS.length + 1, file.lastIndexOf("/"));
  return file.lastIndexOf("/") > ARTIFACT_COMMENTS.length ? location : null;
}
function roleOf(file, location) {
  if (file === `${ARTIFACTS}/${location}`) return "artifact";
  if (file === statusPath(location)) return "status";
  return `comment/${file.slice(ARTIFACT_COMMENTS.length + location.length + 2)}`;
}
function rolePath(role, location) {
  if (role === "artifact") return `${ARTIFACTS}/${location}`;
  if (role === "status") return statusPath(location);
  return `${ARTIFACT_COMMENTS}/${location}/${role.slice("comment/".length)}`;
}
function locationGroups(files) {
  const groups = /* @__PURE__ */ new Map();
  for (const [file, entry] of files) {
    const location = file.startsWith(`${ARTIFACTS}/`) ? file.slice(ARTIFACTS.length + 1) : derivedLocation(file);
    if (location === null) continue;
    if (!groups.has(location)) groups.set(location, /* @__PURE__ */ new Map());
    groups.get(location).set(roleOf(file, location), [file, entry]);
  }
  return groups;
}
async function treeIdentities(base, files, groups) {
  const wanted = [];
  for (const [location, group] of groups) {
    const entry = group.has("artifact") ? files.get(identityPath(location)) : void 0;
    if (entry && FILE_MODES.has(entry.mode)) wanted.push([location, entry.object]);
  }
  const contents = await readBlobs(base, wanted.map(([location, object]) => ({ file: identityPath(location), entry: { mode: "100644", object }, max: IDENTITY_FILE_MAX })));
  const written2 = /* @__PURE__ */ new Map();
  for (const [index, [location]] of wanted.entries()) {
    const id = Buffer.isBuffer(contents[index]) ? identityOf(contents[index]) : null;
    if (id !== null) written2.set(location, id);
  }
  const ids = uniqueIdentities([...groups].filter(([, group]) => group.has("artifact")).map(([location]) => location), written2);
  return { ids, where: new Map([...ids].map(([location, id]) => [id, location])), written: written2 };
}
const COMMENT_BYTES_MAX = 64 * 1024;
let comments;
const commentModule = () => comments ??= import("./artifact-comments.mjs");
const commentForm = () => commentModule().then(({ storedComment }) => storedComment);
const commentFileReader = () => commentModule().then(({ readCommentFile }) => readCommentFile);
async function placedEntry(base, role, entry, from, to) {
  if (!role.startsWith("comment/") || !FILE_MODES.has(entry.mode)) return entry;
  const bytes = await readBlob(base, rolePath(role, from), entry, COMMENT_BYTES_MAX);
  if (!Buffer.isBuffer(bytes)) return entry;
  const value = (await commentForm())(role.slice("comment/".length), bytes, from);
  if (value === null) return entry;
  const object = (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: Buffer.from(`${JSON.stringify({ ...value, location: to })}
`, "utf8") })).text;
  return { ...entry, object };
}
async function placeByIdentity(base, original, local, upstream) {
  const trees = { original, local, upstream };
  const groups = {}, identities = {};
  for (const [name, files] of Object.entries(trees)) {
    groups[name] = locationGroups(files);
    identities[name] = await treeIdentities(base, files, groups[name]);
  }
  const at = (name, id) => identities[name].where.get(id) ?? null;
  const unchanged = (name, id) => {
    const location = at(name, id);
    const [mine, was] = [groups[name].get(location), location === at("original", id) ? groups.original.get(location) : void 0];
    return Boolean(mine && was) && mine.size === was.size && [...mine].every(([role, [, entry]]) => sameEntry(was.get(role)?.[1], entry));
  };
  const editedBytes = (name, id) => groups[name].get(at(name, id))?.get("artifact")?.[1]?.object !== groups.original.get(at("original", id))?.get("artifact")?.[1]?.object;
  const final = /* @__PURE__ */ new Map();
  const standing = /* @__PURE__ */ new Set();
  const gaveWay = /* @__PURE__ */ new Set();
  for (const id of /* @__PURE__ */ new Set([...identities.local.where.keys(), ...identities.upstream.where.keys()])) {
    const [was, ours, theirs2] = ["original", "local", "upstream"].map((name) => at(name, id));
    if (ours !== null && theirs2 !== null) final.set(id, ours === theirs2 || ours === was ? theirs2 : theirs2 === was ? ours : theirs2);
    else if (ours !== null) {
      if (!unchanged("local", id)) final.set(id, ours);
    } else if (was === null) final.set(id, theirs2);
    else if (editedBytes("upstream", id)) {
      final.set(id, theirs2);
      gaveWay.add(id);
    } else standing.add(id);
  }
  const dropped = /* @__PURE__ */ new Set();
  const contested = /* @__PURE__ */ new Map();
  for (let again = true; again; ) {
    again = false;
    const taking = /* @__PURE__ */ new Map();
    for (const [id, location] of final) if (!dropped.has(id)) taking.set(location, [...taking.get(location) ?? [], id]);
    for (const [location, held] of taking) {
      if (held.length < 2) continue;
      const kept2 = held.find((id) => identities.upstream.ids.get(location) === id) ?? held[0];
      contested.set(location, kept2);
      for (const id of held.filter((candidate) => candidate !== kept2)) {
        const theirs2 = at("upstream", id);
        if (theirs2 !== null && theirs2 !== location) {
          final.set(id, theirs2);
          again = true;
        } else dropped.add(id);
      }
    }
  }
  const placed = { original: /* @__PURE__ */ new Map(), local: /* @__PURE__ */ new Map(), upstream: /* @__PURE__ */ new Map() };
  for (const [name, files] of Object.entries(trees)) {
    for (const [file, entry] of files) if (!isIdentityFile(file) && !file.startsWith(`${ARTIFACTS}/`) && derivedLocation(file) === null) placed[name].set(file, entry);
  }
  const baseFile = async (id, role, location) => {
    const from = at("original", id);
    const found = from === null ? void 0 : groups.original.get(from)?.get(role)?.[1];
    return found && from !== location ? placedEntry(base, role, found, from, location) : found;
  };
  const saved = /* @__PURE__ */ new Map();
  const theirs = /* @__PURE__ */ new Set();
  const tooLong = /* @__PURE__ */ new Map();
  const savedAt = /* @__PURE__ */ new Set();
  const save = (file, entry, name, location, longAt = null) => {
    if (saved.has(file)) return;
    saved.set(file, entry);
    if (longAt !== null) tooLong.set(file, longAt);
    if (name === "upstream") theirs.add(file);
    else savedAt.add(location);
  };
  const later = [];
  for (const name of ["original", "local", "upstream"]) {
    for (const [location, group] of groups[name]) {
      const id = identities[name].ids.get(location);
      if (id === void 0) {
        for (const [file, entry] of group.values()) if (!placed[name].has(file)) placed[name].set(file, entry);
        continue;
      }
      if (standing.has(id)) {
        if (name === "upstream") {
          for (const [role, [file, entry]] of group) if (!sameEntry(await baseFile(id, role, location), entry)) save(file, entry, name, location);
        }
        continue;
      }
      if (!final.has(id) && !dropped.has(id)) continue;
      const to = dropped.has(id) ? null : final.get(id);
      for (const [role, [file, entry]] of group) {
        const target = to === null ? null : to === location ? file : rolePath(role, to);
        if (target !== null && storePathFits(target)) {
          later.push([name, target, to === location ? entry : await placedEntry(base, role, entry, location, to)]);
          continue;
        }
        if (name === "original" || sameEntry(await baseFile(id, role, location), entry)) continue;
        if (to === null && name === "local") {
          const keeps = upstream.get(file);
          const views = role === "artifact" && keeps && (await readBlobs(base, [{ file, entry }, { file, entry: keeps }])).every((bytes) => Buffer.isBuffer(bytes) && bytes.includes(GENERATED_VIEW));
          if (sameEntry(keeps, entry) || views) continue;
        }
        if (name === "local" || to !== null) save(file, entry, name, location, to);
      }
    }
  }
  for (const [name, target, entry] of later) placed[name].set(target, entry);
  const undone = [];
  const clashes = (target) => folders(target).some((folder) => placed.local.has(folder)) || [...placed.local.keys()].some((file) => file.startsWith(`${target}/`));
  for (const id of gaveWay) {
    const location = final.get(id);
    for (const [role] of groups.original.get(at("original", id))) {
      const target = rolePath(role, location);
      const entry = await baseFile(id, role, location);
      if (entry && storePathFits(target) && !placed.local.has(target) && !clashes(target)) placed.local.set(target, entry);
    }
    if (!savedAt.has(location)) undone.push({ removal: location });
  }
  for (const id of identities.local.where.keys()) {
    const [was, ours] = [at("original", id), at("local", id)];
    if (was !== null && ours !== was && final.has(id) && !dropped.has(id) && final.get(id) !== ours) undone.push({ move: final.get(id), movedTo: ours });
  }
  const kept = /* @__PURE__ */ new Map();
  for (const [id, location] of final) if (!dropped.has(id)) kept.set(location, id);
  return { ...placed, saved, theirs, tooLong, undone, identities: { trees: { local, upstream }, of: identities, kept } };
}
async function placedIdentities(base, result, { trees, of, kept }) {
  for (const file of [...result.keys()]) {
    if (!file.startsWith(`${ARTIFACTS}/`)) continue;
    const location = file.slice(ARTIFACTS.length + 1);
    const id = kept.get(location);
    const side = ["upstream", "local"].find((name) => trees[name].has(identityPath(location)) && (id === void 0 || of[name].written.get(location) === id));
    if (side) result.set(identityPath(location), trees[side].get(identityPath(location)));
    else if (id !== void 0 && id !== locationIdentity(location)) {
      result.set(identityPath(location), { mode: "100644", object: (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: Buffer.from(identityContent(id), "utf8") })).text });
    }
  }
}
async function surplusComments(result, upstream) {
  const { isCommentFile, commentsMax } = await storeLayout();
  const byFolder = /* @__PURE__ */ new Map();
  for (const file of result.keys()) if (isCommentFile(file)) byFolder.set(path.posix.dirname(file), [...byFolder.get(path.posix.dirname(file)) ?? [], file]);
  const surplus = [];
  for (const files of byFolder.values()) {
    if (files.length <= commentsMax) continue;
    const theirs = files.filter((file) => sameEntry(upstream.get(file), result.get(file)));
    const ours = files.filter((file) => !sameEntry(upstream.get(file), result.get(file))).sort();
    for (const file of ours.slice(Math.max(0, commentsMax - theirs.length))) surplus.push([file, result.get(file)]);
  }
  return surplus;
}
function strandedFiles(result) {
  const stranded = [];
  for (const [file, entry] of result) {
    const location = derivedLocation(file);
    if (location !== null && !result.has(`${ARTIFACTS}/${location}`)) stranded.push([file, entry]);
  }
  return stranded;
}
async function oversizedChange(base, original, local) {
  const { bound } = await storeLayout();
  const changed = [...local].filter(([file, entry]) => FILE_MODES.has(entry.mode) && bound(file) !== null && !sameEntry(original.get(file), entry));
  if (!changed.length) return null;
  const sizes = await objectInfo(base, [...new Set(changed.map(([, { object }]) => object))]);
  for (const [file, { object }] of changed) {
    const size = sizes.get(object)?.size;
    if (size !== void 0 && size > bound(file)) return { path: file, size, bound: bound(file) };
  }
  return null;
}
async function mergeFiles(base, original, local, upstream) {
  const { bound } = await storeLayout();
  const result = /* @__PURE__ */ new Map();
  const conflicts = [];
  for (const file of /* @__PURE__ */ new Set([...original.keys(), ...local.keys(), ...upstream.keys()])) {
    const [was, ours, theirs] = [original.get(file), local.get(file), upstream.get(file)];
    let taken = theirs;
    if (sameEntry(ours, theirs) || sameEntry(was, theirs)) taken = ours;
    else if (!sameEntry(was, ours)) {
      const object = await lineMerge(base, file, was, ours, theirs, bound(file));
      if (object) taken = { mode: ours.mode, object };
      else conflicts.push(file);
    }
    if (taken) result.set(file, taken);
  }
  return { result, conflicts };
}
const folders = (file) => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
function settleFolders(result, upstream) {
  const clashes = [];
  for (; ; ) {
    const places = /* @__PURE__ */ new Set();
    for (const file of result.keys()) for (const folder of folders(file)) if (result.has(folder)) places.add(folder);
    const outermost = [...places].filter((place) => !folders(place).some((folder) => places.has(folder)));
    if (!outermost.length) return clashes;
    for (const place of outermost) {
      const within = (file) => file === place || file.startsWith(`${place}/`);
      for (const file of [...result.keys()]) if (within(file)) result.delete(file);
      for (const [file, entry] of upstream) if (within(file)) result.set(file, entry);
      clashes.push(place);
    }
  }
}
const isText = (bytes) => !bytes.subarray(0, 8e3).includes(0);
async function lineMerge(base, file, original, local, upstream, limit = null) {
  if (!local || !upstream || local.mode !== upstream.mode || !FILE_MODES.has(local.mode) || original && !FILE_MODES.has(original.mode)) return null;
  const read = await readBlobs(base, [local, original, upstream].map((entry) => ({ file, entry })));
  const contents = read.map((bytes, index) => index === 1 && bytes === null ? Buffer.alloc(0) : bytes);
  if (!contents.every((bytes) => Buffer.isBuffer(bytes) && isText(bytes))) return null;
  const folder = syncPath(base, "merge-files");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    const targets = ["local", "original", "upstream"].map((name) => path.join(folder, name));
    for (const [index, target] of targets.entries()) await writeAtomically(target, contents[index]);
    const merged = await git(base, ["merge-file", "-p", "--quiet", ...targets]);
    if (!merged.ok || limit !== null && merged.stdout.length > limit) return null;
    return (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: merged.stdout })).text;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
function conflictCopies(local, upstream, conflicted) {
  const copies = [];
  const done = /* @__PURE__ */ new Set();
  for (const file of conflicted) {
    const within = (candidate) => candidate === file || candidate.startsWith(`${file}/`);
    const changed = [...local].filter(([candidate, entry]) => within(candidate) && upstream.get(candidate)?.object !== entry.object && !done.has(candidate)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (!changed.length && !done.has(file)) copies.push([file, null]);
    for (const [candidate, entry] of changed) {
      done.add(candidate);
      copies.push([candidate, entry]);
    }
  }
  return copies;
}
async function stageLocal(base, copies, { from, to, theirs = /* @__PURE__ */ new Set(), tooLong = /* @__PURE__ */ new Map(), surplus = /* @__PURE__ */ new Set(), bothChanged = /* @__PURE__ */ new Set(), undone = [] }) {
  const folder = syncPath(base, "saving", `${Date.now()}-${process.pid}`);
  await rm(folder, { recursive: true, force: true });
  const conflicts = [];
  for (const [file, entry] of copies) {
    if (!entry) {
      conflicts.push({ path: file });
      continue;
    }
    const whose = theirs.has(file) ? { theirs: true } : surplus.has(file) ? { surplus: true } : bothChanged.has(file) ? { bothChanged: true } : {};
    const cause = tooLong.has(file) ? { tooLong: tooLong.get(file) } : {};
    if (entry.disk) {
      conflicts.push({ path: file, saved: true, moved: true, overBound: true, ...whose, ...cause });
      continue;
    }
    const target = path.join(folder, "files", ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomically(target, await boundedBlob(base, file, entry));
    conflicts.push({ path: file, saved: true, ...whose, ...cause });
  }
  await mkdir(folder, { recursive: true });
  await writeAtomically(path.join(folder, REPLACED_RECORD), "[]\n");
  await writeAtomically(path.join(folder, STAGE_RECORD), `${JSON.stringify({ from, to, conflicts, undone })}
`);
  return { folder, from, to, conflicts, undone, replaced: [] };
}
const STAGE_RECORD = "stage.json";
const REPLACED_RECORD = "replaced.json";
async function moveAside(base, stage, file) {
  if (!stage.conflicts.some((conflict) => conflict.path === file && conflict.moved)) return;
  const source = path.join(base, ...file.split("/"));
  const target = path.join(stage.folder, "files", ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await renameWhenFree(source, target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EXDEV") throw error;
    const partial = path.join(stage.folder, "copying");
    await copyFile(source, partial);
    await renameWhenFree(partial, target);
    await rm(source, { force: true });
  }
}
async function stageSurplus(stage, file, bytes) {
  const target = path.join(stage.folder, "files", ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, bytes);
  stage.conflicts.push({ path: file, saved: true, surplus: true });
  await writeAtomically(path.join(stage.folder, STAGE_RECORD), `${JSON.stringify({ from: stage.from, to: stage.to, conflicts: stage.conflicts, undone: stage.undone })}
`);
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}
`);
}
async function stageSurplusMove(base, stage, file) {
  stage.conflicts.push({ path: file, saved: true, surplus: true, moved: true });
  await writeAtomically(path.join(stage.folder, STAGE_RECORD), `${JSON.stringify({ from: stage.from, to: stage.to, conflicts: stage.conflicts, undone: stage.undone })}
`);
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}
`);
  await moveAside(base, stage, file);
}
const touches = (file, conflict) => file === conflict || file.startsWith(`${conflict}/`) || conflict.startsWith(`${file}/`);
async function markReplaced(stage, file) {
  if (!stage.conflicts.some((conflict) => touches(file, conflict.path)) || stage.replaced.includes(file)) return;
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}
`);
}
async function settleStage(base, stage, moved) {
  const copyOf = (file) => path.join(stage.folder, "files", ...file.split("/"));
  const kept = [];
  const movedAside = (conflict) => lstat(copyOf(conflict.path)).then((stats) => stats.isFile(), () => false);
  for (const conflict of stage.conflicts) {
    if (conflict.moved) {
      if ((moved || stage.replaced.some((file) => touches(file, conflict.path))) && await movedAside(conflict)) kept.push(conflict);
      continue;
    }
    if (moved) {
      kept.push(conflict);
      continue;
    }
    if (!stage.replaced.some((file) => touches(file, conflict.path))) continue;
    if (!conflict.saved) {
      kept.push(conflict);
      continue;
    }
    const copy = await fileBytes(copyOf(conflict.path));
    const now = await boundedBytes(path.join(base, ...conflict.path.split("/")), copy?.length ?? 0);
    if (copy !== null && !sameBytes(now, copy)) kept.push(conflict);
  }
  const undone = moved ? stage.undone ?? [] : [];
  if (!kept.length && !undone.length) return dropSaved(stage);
  for (const conflict of stage.conflicts) if (conflict.saved && !kept.includes(conflict)) await rm(copyOf(conflict.path), { force: true });
  return publishSaved(base, { folder: stage.folder, conflicts: kept, undone });
}
async function publishCopies(base, source, about = null) {
  await mkdir(syncPath(base, "conflicts"), { recursive: true });
  await mkdir(syncPath(base, NOTICES), { recursive: true });
  await mkdir(source, { recursive: true });
  const taken = (name) => Promise.all([syncPath(base, "conflicts", name), syncPath(base, NOTICES, name), aboutPath(base, name)].map((target) => lstat(target).then(() => true, () => false))).then((found) => found.some(Boolean));
  for (let attempt = 0; ; attempt++) {
    const candidate = new Date(Date.now() + attempt).toISOString().replace(/[:.]/g, "-");
    if (await taken(candidate)) continue;
    if (about) {
      await mkdir(syncPath(base, ABOUT), { recursive: true });
      await writeAtomically(aboutPath(base, candidate), `${JSON.stringify(about)}
`);
    }
    await writeAtomically(syncPath(base, NOTICES, candidate), `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
    try {
      await rename(source, syncPath(base, "conflicts", candidate));
      return candidate;
    } catch (error) {
      await rm(syncPath(base, NOTICES, candidate), { force: true });
      await rm(aboutPath(base, candidate), { force: true });
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt >= 100) throw error;
    }
  }
}
const ABOUT = "conflict-notes";
const aboutPath = (base, stamp) => syncPath(base, ABOUT, `${stamp}.json`);
async function publishSaved(base, { folder, conflicts, undone = [] }) {
  const theirs = conflicts.filter((conflict) => conflict.saved && conflict.theirs).map((conflict) => conflict.path);
  const surplus = conflicts.filter((conflict) => conflict.saved && conflict.surplus && !conflict.theirs).map((conflict) => conflict.path);
  const bothChanged = conflicts.filter((conflict) => conflict.saved && conflict.bothChanged && !conflict.theirs && !conflict.surplus).map((conflict) => conflict.path);
  const tooLong = conflicts.filter((conflict) => conflict.saved && noteLocation(conflict.tooLong)).map((conflict) => ({ path: conflict.path, location: conflict.tooLong }));
  const overBound2 = conflicts.filter((conflict) => conflict.saved && conflict.overBound && !conflict.theirs && !conflict.surplus && !conflict.bothChanged).map((conflict) => conflict.path);
  const about = theirs.length || tooLong.length || surplus.length || bothChanged.length || overBound2.length || undone.length ? { theirs, tooLong, surplus, bothChanged, overBound: overBound2, undone } : null;
  const stamp = conflicts.some((conflict) => conflict.saved) || undone.length ? await publishCopies(base, path.join(folder, "files"), about) : null;
  await rm(folder, { recursive: true, force: true });
  return conflicts.map(({ path: file, saved, theirs: other, tooLong: at }) => ({ path: file, savedAs: saved ? `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}` : null, ...saved && other ? { theirs: true } : {}, ...saved && noteLocation(at) ? { tooLongAt: at } : {} }));
}
async function dropSaved({ folder }) {
  await rm(folder, { recursive: true, force: true });
  return [];
}
async function recoverSaved(base) {
  const { shareable } = await storeLayout();
  for (const name of await readdir(syncPath(base, NOTICES)).catch(() => [])) {
    if (!await lstat(syncPath(base, "conflicts", name)).then(() => true, () => false)) await rm(syncPath(base, NOTICES, name), { force: true });
  }
  for (const name of await readdir(syncPath(base, ABOUT)).catch(() => [])) {
    if (!name.endsWith(".json") || !await lstat(syncPath(base, "conflicts", name.slice(0, -".json".length))).then(() => true, () => false)) await rm(syncPath(base, ABOUT, name), { force: true });
  }
  let names = [];
  try {
    names = (await readdir(syncPath(base, "saving"))).sort();
  } catch {
    return [];
  }
  const conflicts = [];
  for (const name of names) {
    const folder = syncPath(base, "saving", name);
    const stage = await readFile(path.join(folder, STAGE_RECORD), "utf8").then(parseStoreJson).catch(() => null);
    const copies = await lstat(path.join(folder, "files")).then((stats) => stats.isDirectory(), () => false);
    if (!stage && !copies && STAMP.test(name)) {
      await publishCopies(base, folder).catch(() => rm(folder, { recursive: true, force: true }));
      continue;
    }
    const valid = Array.isArray(stage?.conflicts) && stage.conflicts.every((conflict) => typeof conflict?.path === "string" && (isSavedFile(conflict.path) || shareable(conflict.path)) && conflict.path.split("/").every((part) => part && part !== "." && part !== "..")) && (stage.undone === void 0 || Array.isArray(stage.undone) && stage.undone.every(undoneForm));
    const saved = valid ? stage.conflicts.filter((conflict) => conflict.saved) : [];
    if (!valid || saved.length && !copies) {
      await rm(folder, { recursive: true, force: true });
      continue;
    }
    const moved = typeof stage.to === "string" && (await git(base, ["merge-base", "--is-ancestor", stage.to, "HEAD"])).ok;
    let replaced = await readFile(path.join(folder, REPLACED_RECORD), "utf8").then(parseStoreJson).catch(() => null);
    if (!Array.isArray(replaced)) {
      replaced = [];
      for (const conflict of saved) {
        const copy = await fileBytes(path.join(folder, "files", ...conflict.path.split("/")));
        if (!sameBytes(await boundedBytes(path.join(base, ...conflict.path.split("/")), copy?.length ?? 0), copy)) replaced.push(conflict.path);
      }
    }
    conflicts.push(...await settleStage(base, { folder, conflicts: stage.conflicts, undone: stage.undone ?? [], replaced: replaced.filter((file) => typeof file === "string") }, moved));
  }
  await rmdir(syncPath(base, "saving")).catch(() => {
  });
  return conflicts;
}
async function structuralMerges(base, original, local, upstream) {
  const { bound } = await storeLayout();
  const merged = /* @__PURE__ */ new Map();
  const fallback = [];
  const views = [];
  const differs = (side, file) => !sameEntry(original.get(file), side.get(file));
  const changed = [.../* @__PURE__ */ new Set([...original.keys(), ...local.keys(), ...upstream.keys()])].filter((file) => differs(local, file) && differs(upstream, file));
  const bytesOf = (side, file) => readBlob(base, file, side.get(file));
  for (const file of changed.filter((item) => item.startsWith(`${ARTIFACTS}/`))) {
    const [mine, theirs] = await Promise.all([local, upstream].map((side) => bytesOf(side, file)));
    if ([mine, theirs].every(Buffer.isBuffer) && !mine.equals(theirs) && [mine, theirs].every((bytes) => bytes.includes(GENERATED_VIEW))) views.push(file);
  }
  const both = changed.filter((file) => hasRecordMerge(file) || isRegistrationFile(file));
  for (const file of both) {
    const [was, mine, theirs] = await Promise.all([original, local, upstream].map((side) => bytesOf(side, file)));
    if ([was, mine, theirs].some(overBytes)) {
      if (mine !== null && theirs !== null) fallback.push(file);
      continue;
    }
    if (mine === null || theirs === null || mine.equals(theirs)) continue;
    if (isRegistrationFile(file)) {
      if (sameRegistration(mine, theirs)) merged.set(file, theirs);
      else fallback.push(file);
      continue;
    }
    const mergeRecord = await recordMergeFor(file);
    let outcome;
    try {
      outcome = await mergeRecord({ path: file, base: was?.toString("utf8") ?? null, local: mine.toString("utf8"), upstream: theirs.toString("utf8") });
    } catch (error) {
      outcome = { conflict: error.message };
    }
    const contents = typeof outcome?.contents === "string" ? Buffer.from(outcome.contents, "utf8") : null;
    const limit = bound(file);
    if (contents !== null && (limit === null || contents.length <= limit)) merged.set(file, contents);
    else fallback.push(file);
  }
  return { merged, fallback, views };
}
function sameRegistration(left, right) {
  try {
    const parsed = [left, right].map((bytes) => {
      let value;
      try {
        value = parseStoreJson(bytes.toString("utf8"));
      } catch {
        return null;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value) || nestedDeeperThan(value)) return null;
      const { registeredAt, ...rest } = value;
      return canonicalJson(rest);
    });
    return parsed[0] !== null && parsed[0] === parsed[1];
  } catch {
    return false;
  }
}
async function readBlobs(base, wanted) {
  const { blobMax } = await storeLayout();
  const answers = wanted.map(() => null);
  const items = wanted.map((item, index) => ({ ...item, index })).filter(({ entry }) => entry && FILE_MODES.has(entry.mode));
  if (!items.length) return answers;
  const info = await objectInfo(base, [...new Set(items.map(({ entry }) => entry.object))]);
  const readable = /* @__PURE__ */ new Map();
  for (const item of items) {
    const found = info.get(item.entry.object);
    if (found?.type !== "blob") throw new Error(`Git holds no blob ${item.entry.object} for ${shownPath(item.file)}.`);
    if (found.size > (item.max ?? blobMax(item.file))) answers[item.index] = { size: found.size };
    else readable.set(item.entry.object, found.size);
  }
  const total = [...readable.values()].reduce((sum, size) => sum + size + 128, 0);
  const contents = await objectContents(base, [...readable.keys()], total + 1024 * 1024);
  for (const item of items) if (answers[item.index] === null) answers[item.index] = contents.get(item.entry.object);
  return answers;
}
const readBlob = async (base, file, entry, max) => (await readBlobs(base, [{ file, entry, max }]))[0];
async function boundedBlobReader(base, files, entriesOf, batchBytes = 32 * 1024 * 1024) {
  const { blobMax } = await storeLayout();
  const wanted = files.map((file) => entriesOf(file).filter((entry) => entry && FILE_MODES.has(entry.mode)));
  const info = await objectInfo(base, [...new Set(wanted.flat().map((entry) => entry.object))]);
  const indexOf = new Map(files.map((file, index) => [file, index]));
  const cache = /* @__PURE__ */ new Map();
  let next = 0;
  return async (file, entry) => {
    const index = indexOf.get(file);
    if (entry && FILE_MODES.has(entry.mode) && !cache.has(entry.object) && index !== void 0 && index >= next) {
      cache.clear();
      const batch = [];
      let total = 0;
      let end = index;
      while (end < files.length) {
        const readable = wanted[end].filter((item) => {
          const found = info.get(item.object);
          return found?.type === "blob" && found.size <= blobMax(files[end]);
        });
        const bytes = readable.reduce((sum, item) => sum + info.get(item.object).size + 128, 0);
        if (end > index && total + bytes > batchBytes) break;
        for (const item of readable) batch.push({ file: files[end], entry: item });
        total += bytes;
        end += 1;
      }
      next = end;
      const contents = await readBlobs(base, batch);
      batch.forEach((item, at) => {
        if (Buffer.isBuffer(contents[at])) cache.set(item.entry.object, contents[at]);
      });
    }
    return entry && cache.has(entry.object) ? cache.get(entry.object) : boundedBlob(base, file, entry);
  };
}
async function boundedBlob(base, file, entry) {
  const bytes = await readBlob(base, file, entry);
  if (overBytes(bytes)) {
    const { bound, boundText } = await storeLayout();
    throw new Error(`The store's Git holds ${shownPath(file)} at ${bytes.size} bytes, above the ${boundText(bound(file) ?? bytes.size)} that a store file of its kind may hold, which no sync reads, so the store was left as it was.`);
  }
  return bytes;
}
const fileBytes = (target) => readFile(target).catch((error) => {
  if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
  throw error;
});
async function boundedBytes(target, max) {
  if (!constants.O_NOFOLLOW && (await lstat(target).catch(() => null))?.isSymbolicLink()) return { size: null };
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    if (["ELOOP", "EMLINK", "ENXIO"].includes(error.code)) return { size: null };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return null;
    if (!info.isFile() || max !== null && info.size > max) return { size: info.isFile() ? info.size : null };
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    for (let read; filled < buffer.length && (read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead) > 0; ) filled += read;
    return filled > info.size ? { size: filled } : buffer.subarray(0, filled);
  } finally {
    await handle.close().catch(() => {
    });
  }
}
const overBytes = (bytes) => bytes !== null && !Buffer.isBuffer(bytes);
const sameBytes = (left, right) => overBytes(left) || overBytes(right) ? false : left === null || right === null ? left === right : left.equals(right);
async function holdLocks(targets, action) {
  if (!targets.length) return action();
  return withFileLock(targets[0], () => holdLocks(targets.slice(1), action), void 0, { timeoutMs: SETTINGS.applyLockMs });
}
async function treeFiles(base, commit) {
  const files = /* @__PURE__ */ new Map();
  if (!commit) return files;
  await listTree(base, commit, false, (meta, name) => {
    const [mode, , object] = meta.split(" ");
    files.set(pathOfBytes(name), utf8(name) ? { mode, object } : { mode, object, notUtf8: true });
  });
  return files;
}
async function listTree(base, commit, sizes, take) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  const listed = await gitRecords(base, ["ls-tree", "-r", "-z", ...sizes ? ["-l"] : [], "--full-tree", commit], { separator: 0, limit: max, maxBytes: listingBytesMax(max), maxRecord: LISTED_META_MAX + LISTED_PATH_BYTES_MAX, take: (record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error(`git ls-tree printed an entry without a path for ${commit}.`);
    take(record.subarray(0, tab).toString("latin1"), record.subarray(tab + 1));
  } });
  if (listed.long) {
    const tab = listed.long.indexOf(9);
    const shown = `${pathOfBytes(listed.long.subarray(tab + 1, tab + 1 + 64))}\u2026`;
    throw Object.assign(new Error(`The store's Git holds ${longEntry(shown)} at ${commit}, so the store was left as it was.`), { unsafePath: true, longPath: shown });
  }
  if (listed.over) throw Object.assign(new Error(`The store's Git holds ${wideTree({ files: max, bytes: listed.over === "bytes" ? listingBytesMax(max) : null })} at ${commit}, so the store was left as it was.`), { unsafePath: true, treeTooLarge: max, listingBytes: listed.over === "bytes" ? listingBytesMax(max) : null });
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git ls-tree failed."), { git: listed });
}
const LISTED_META_MAX = 128;
const LISTED_PATH_BYTES_MAX = 32767;
const listingBytesMax = (files) => files * (LISTED_META_MAX + STORE_PATH_BYTES_MAX);
const longEntry = (shown) => `an entry whose path holds more than ${LISTED_PATH_BYTES_MAX} bytes, the most that any supported machine holds, ${JSON.stringify(shown)}`;
const wideTree = ({ files, bytes }) => bytes ? `a tree whose listing holds more than ${bytes} bytes, more than a tree of ${files} files, ${TREE_BOUND}, at ${STORE_PATH_BYTES_MAX} bytes for each path` : `a tree of more than ${files} files, ${TREE_BOUND}`;
const TREE_BOUND = "the most files that a store's tree may hold";
const STRAY_BYTE = /[\udc80-\udcff]/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = (bytes) => {
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};
const UTF8_LENGTH = (lead) => lead < 128 ? 1 : lead >= 194 && lead <= 223 ? 2 : lead >= 224 && lead <= 239 ? 3 : lead >= 240 && lead <= 244 ? 4 : 0;
function pathOfBytes(bytes) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text).equals(bytes)) return text;
  let read = "";
  for (let at = 0; at < bytes.length; ) {
    const size = UTF8_LENGTH(bytes[at]);
    const piece = bytes.subarray(at, at + size);
    if (size && piece.length === size && Buffer.from(piece.toString("utf8")).equals(piece)) {
      read += piece.toString("utf8");
      at += size;
    } else read += String.fromCharCode(56320 + bytes[at++]);
  }
  return read;
}
function bytesOfPath(file) {
  if (!STRAY_BYTE.test(file)) return Buffer.from(file);
  const parts = [];
  let run = "";
  for (const character of file) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 56448 && code <= 56575) {
      parts.push(Buffer.from(run), Buffer.from([code - 56320]));
      run = "";
    } else run += character;
  }
  parts.push(Buffer.from(run));
  return Buffer.concat(parts);
}
const shownPath = (file) => JSON.stringify(file).replace(/\\udc([89a-f][0-9a-f])/g, "\\x$1");
const sameEntry = (left, right) => left === right || left !== void 0 && right !== void 0 && left.mode === right.mode && left.object === right.object;
const entryKind = (mode) => mode === "120000" ? "a symbolic link" : mode === "160000" ? "a submodule link" : FILE_MODES.has(mode) ? "a file" : "an entry";
function letterCaseClash(files) {
  const seen = /* @__PURE__ */ new Map();
  for (const file of files) {
    for (const place of [...folders(file), file]) {
      const key = letterCaseKey(place);
      const known = seen.get(key);
      if (known === void 0) seen.set(key, place);
      else if (known !== place) return [known, place];
    }
  }
  return null;
}
function settleLetterCase(result, local, upstream) {
  const within = (candidate, folder) => candidate === folder || candidate.startsWith(`${folder}/`);
  const upstreamHolds = (place) => [...upstream.keys()].some((file) => within(file, place));
  const clashes = [];
  for (; ; ) {
    const pair = letterCaseClash(result.keys());
    if (!pair) return clashes;
    const theirs = pair.find(upstreamHolds);
    const place = pair.find((candidate) => candidate !== theirs);
    if (!theirs || upstreamHolds(place)) return clashes;
    for (const candidate of [...result.keys()]) if (within(candidate, place) || within(candidate, theirs)) result.delete(candidate);
    for (const [candidate, entry] of upstream) if (within(candidate, theirs)) result.set(candidate, entry);
    clashes.push(place);
    if ([...local].some(([candidate, entry]) => within(candidate, theirs) && !sameEntry(upstream.get(candidate), entry))) clashes.push(theirs);
  }
}
async function unsafeStoreEntry(base, commit) {
  const { kind } = await storeLayout();
  let files;
  try {
    files = await treeFiles(base, commit);
  } catch (error) {
    if (error.treeTooLarge) return { files: error.treeTooLarge, bytes: error.listingBytes };
    if (error.longPath) return { path: error.longPath, long: true, kind: "an entry" };
    throw error;
  }
  for (const [file, entry] of files) if (kind(file, entry) === "unsafe") return { path: file, kind: entryKind(entry.mode) };
  const clash = letterCaseClash(files.keys());
  return clash ? { path: clash[1], kind: "an entry", clash: clash[0] } : null;
}
const unsafeEntryFix = (unsafe) => unsafe.files ? `Remove files${unsafe.bytes ? ", or shorten their paths," : ""} from the remote's branch until it holds at most ${unsafe.files}${unsafe.bytes ? ` whose paths hold at most ${STORE_PATH_BYTES_MAX} bytes each` : ""}.` : "Remove that path from the remote's branch.";
function describeUnsafeEntry(unsafe) {
  if (unsafe.files) return `${wideTree(unsafe)}, which no store may hold, since every machine would have to list and hold them`;
  if (unsafe.long) return `${longEntry(unsafe.path)}, which no store may hold, since no machine could hold it`;
  const what = unsafe.clash ? `${shownPath(unsafe.clash)} and ${shownPath(unsafe.path)}, whose paths differ only in letter case,` : `${unsafe.kind} at ${shownPath(unsafe.path)},`;
  return `${what} which no store may hold, since a link, a path that some file system reads as Git's folder, the sync folder, or a place outside the store, a name that Windows refuses, a path that is not UTF-8, a file Prism shares whose name holds more than ${STORE_NAME_BYTES_MAX} bytes or whose path holds more than ${STORE_PATH_BYTES_MAX}, two paths that macOS and Windows read as one, a name that Git reads as .gitattributes or .gitmodules other than the store's own .gitattributes at its root, or an entry where Prism keeps its own files would make some machine's store unsafe or stuck`;
}
async function refuseUnsafeTree(base, commit) {
  const unsafe = await unsafeStoreEntry(base, commit);
  if (unsafe) throw Object.assign(new Error(`The upstream holds ${describeUnsafeEntry(unsafe)}, so the store was left as it was. ${unsafeEntryFix(unsafe)}`), { unsafePath: true });
  const over = await oversizedStoreEntry(base, commit);
  if (over) throw Object.assign(new Error(`The upstream holds ${await describeOversizedEntry(over)}, so the store was left as it was. Shrink or remove ${over.folder ? "comment files of that folder" : "that file"} on the remote's branch.`), { unsafePath: true });
}
async function unpushable(base, remote, { upstream = true } = {}) {
  const unsafe = await unsafeStoreEntry(base, "HEAD");
  if (unsafe?.files || unsafe?.long) return wideBranchRefusal(base, remote, { upstream, sent: "pushed", unsafe });
  if (unsafe) return `The store's branch holds ${describeUnsafeEntry(unsafe)}, so it was not pushed. Remove that path from the remote's branch or from this store.`;
  const known = await knownCommits(base, remote);
  const head = (await required(base, ["rev-parse", "--verify", "HEAD"])).text;
  const checked = await checkedTip(base);
  const walked = [...known, ...checked ? [checked] : []];
  const refused = await refusedObjects(base, head, walked);
  if (refused) {
    const places = [...new Set([...refused.places.values()].flat())];
    const named = places.length ? places : [...await treeFiles(base, "HEAD")].filter(([, entry]) => refused.objects.includes(entry.object)).map(([file]) => file);
    const fix2 = await takeOffAdvice(base, {
      upstream,
      known,
      paths: named,
      holds: (_file, { object }) => refused.objects.includes(object),
      until: "each such file until it is fixed",
      instead: `fix each such file in the store as Git's reason says, and take it out of every commit of the store's branch that no other machine holds yet while keeping every commit that other machines share, such as by making those commits again without it; the next sync then pushes the branch`
    });
    return `The store's branch holds ${named.length ? named.map(shownPath).join(" and ") : "an object"} that Git's object check refuses (${refused.message}), so it was not pushed, since every other machine's fetch and first clone would then refuse the remote for good. ${fix2}`;
  }
  const over = await oversizedStoreEntry(base, "HEAD");
  const before = over ? null : await oversizedHistory(base, walked, head);
  const found = over ?? before;
  if (!found) {
    await required(base, ["update-ref", CHECKED_REF, head]);
    return null;
  }
  const { commentsMax } = await storeLayout();
  const fix = await takeOffAdvice(base, {
    upstream,
    known,
    paths: found.path ? [found.path] : [],
    holds: (_file, { size }) => size > found.bound,
    until: "each file while it stays above its bound",
    instead: found.folder ? `move the comment files of ${shownPath(found.folder)} past the first ${commentsMax} by file name out of that folder in the store, keeping what they say if that matters, and the next sync commits their removal and pushes the branch` : oversizedFix(found.path)
  });
  if (over) return `The store's branch holds ${await describeOversizedEntry(over)}, so it was not pushed, since every other machine's sync would then refuse the remote's branch. ${fix}`;
  return `A commit of the store's branch that the remote does not hold yet holds ${await describeOversizedEntry(before)}, so the branch was not pushed, since the remote would keep that file in its history for every clone to fetch. ${fix}`;
}
async function wideBranchRefusal(base, remote, { upstream, sent, unsafe }) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  const until = unsafe.long ? "no such entry, which no sync commits" : null;
  const then = unsafe.long ? null : `then remove files that the store no longer needs from it${unsafe.bytes ? ", or shorten their paths," : ""} until it holds at most ${max}, and the next sync shares every change`;
  const instead = unsafe.long ? "remove that entry from the store's branch with a commit made by hand; the next sync then pushes the branch" : `remove files${unsafe.bytes ? ", or shorten their paths," : ""} from the store's branch with a commit made by hand until it holds at most ${max}; the next sync then pushes the branch`;
  const fix = await takeOffAdvice(base, { upstream, known: await knownCommits(base, remote), paths: [], holds: () => false, until, then, instead });
  const what = unsafe.files && !unsafe.bytes ? `more than ${max} files, ${TREE_BOUND}` : unsafe.long ? longEntry(unsafe.path) : wideTree(unsafe);
  return `The store's branch holds ${what}, so it was not ${sent}, since every other machine's sync would then refuse the remote's branch. ${fix}`;
}
async function pastTreeRefusal({ files }, kept = false) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  return `The tree that the sync would push, this machine's changes merged with the upstream's as fetched, would hold ${files} files, more than ${max}, ${TREE_BOUND}, ` + (kept ? "so the sync pushed nothing: it keeps the merge of the upstream that it made before another machine pushed first, and this machine's later changes stay on disk as they are, in no commit. " : "so the sync committed, merged, and pushed nothing, and every file stays on disk as it is. ") + `Remove files that the store no longer needs, on this machine or another, until it holds at most ${max}, and the next sync shares every change.`;
}
async function takeOffCommit(base, { from, to }) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok || head.text !== to) return;
  await required(base, from ? ["read-tree", from] : ["read-tree", "--empty"]);
  await required(base, from ? ["update-ref", "-m", "prism: keep the store's tree within its bound", "HEAD", from, to] : ["update-ref", "-d", "HEAD", to]);
  if (from) await recordDiskCommit(base, from);
}
const oversizedFix = (file) => `make ${shownPath(file)} smaller than its bound in the store, and take it out of every commit of the store's branch that no other machine holds yet while keeping every commit that other machines share, such as by making those commits again without it; the next sync then pushes the branch`;
async function takeOffAdvice(base, { upstream, known, paths, holds, until, then = null, instead }) {
  const command = await resetAdvice(base, { upstream, known, paths, holds });
  if (command) return `Take the commit you made by hand that holds it off the store's branch: ${command}; ${then ?? `the next sync then commits the store's other changes again and withholds ${until}`}.`;
  return `No command can take the commit you made by hand that holds it off the store's branch without also taking off commits that other machines already share, so ${instead}.`;
}
async function resetAdvice(base, { upstream, known, paths, holds }) {
  if (upstream) {
    const tip = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"]);
    if (tip.ok && tip.text) return `run git reset --soft ${tip.text} in the store, which keeps every file on disk and moves the branch back to the tip of the remote's branch`;
  }
  const revisions = `HEAD
${known.map((commit) => `^${commit}
`).join("")}`;
  let first = null;
  if (paths.length) {
    const changing = await historyCommits(base, ["rev-list", "--topo-order", "--reverse", "--full-history", "--stdin", "--", ...paths], revisions, { GIT_LITERAL_PATHSPECS: "1" });
    const names = changing.flatMap((commit) => paths.map((file) => ({ commit, file })));
    const listed = names.length ? await gitLines(base, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: `${names.map(({ commit, file }) => `${commit}:${file}`).join("\n")}
`, limit: names.length, maxRecord: 128 + STORE_PATH_BYTES_MAX * 2, what: "the sizes of a file in the commits that the remote lacks" }) : [];
    const at = names.findIndex(({ file }, index) => {
      const [object, size] = (listed[index] ?? "").split(" ");
      return /^[0-9a-f]{40,64}$/.test(object) && holds(file, { object, size: Number(size) });
    });
    first = at < 0 ? null : names[at].commit;
  }
  const holding = first !== null;
  if (first === null) {
    const listed = await gitRecords(base, ["rev-list", "--topo-order", "--reverse", "--stdin"], { separator: 10, maxRecord: 128, input: revisions, take: (line) => {
      first = line.toString("latin1");
      return false;
    } });
    if (listed.long) throw historyRefusal("the commits that the remote lacks");
    if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git rev-list failed."), { git: listed });
    first ||= null;
  }
  const parent = first ? await git(base, ["rev-parse", "--verify", "--quiet", `${first}^1`]) : { ok: false };
  const target = parent.ok && parent.text ? parent.text : null;
  if (await keepsShared(base, target, known)) {
    if (target) return `run git reset --soft ${target} in the store, which keeps every file on disk and moves the branch back to the commit before the first commit of it that the remote lacks${holding ? " and that holds the file" : ""}`;
    return `run git update-ref -d HEAD in the store, which keeps every file on disk and takes every commit off the branch, since ${holding ? "its first commit holds the file" : "the remote lacks each of them"}`;
  }
  const shared = [];
  for (const commit of known) {
    const common = await git(base, ["merge-base", "HEAD", commit]);
    if (common.ok && common.text) shared.push(common.text);
  }
  const latest = shared.length ? (await gitLines(base, ["merge-base", "--independent", ...new Set(shared)], { limit: new Set(shared).size, maxRecord: 128 })).filter(Boolean) : [];
  if (latest.length === 1 && await keepsShared(base, latest[0], known)) return `run git reset --soft ${latest[0]} in the store, which keeps every file on disk and moves the branch back to the last commit of it that other machines already share`;
  return null;
}
async function keepsShared(base, target, known) {
  if (!known.length) return true;
  const count = async (others) => (await required(base, ["rev-list", "--count", "--stdin"], { input: `HEAD
${target ? `^${target}
` : ""}${others}` })).text;
  return await count("") === await count(known.map((commit) => `^${commit}
`).join(""));
}
async function writeCommitFiles(base, commit) {
  const { shared } = await partition(await treeFiles(base, commit));
  const files = [...shared];
  const info = files.length ? await objectInfo(base, [...new Set(files.map(([, entry]) => entry.object))]) : /* @__PURE__ */ new Map();
  const sizes = files.map(([, entry]) => info.get(entry.object)?.size ?? 0);
  const LIMIT = 32 * 1024 * 1024;
  for (let start = 0; start < files.length; ) {
    let end = start;
    let total = 0;
    while (end < files.length && (end === start || total + sizes[end] <= LIMIT)) total += sizes[end++] + 128;
    const batch = files.slice(start, end);
    const contents = await readBlobs(base, batch.map(([file, entry]) => ({ file, entry })));
    for (const [index, [file]] of batch.entries()) {
      const bytes = contents[index];
      if (!Buffer.isBuffer(bytes)) throw new Error(`Git holds ${shownPath(file)} above the bound that a store file of its kind may hold, so its files were not written.`);
      const target = path.join(base, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    start = end;
  }
  await required(base, ["read-tree", commit]);
}
async function outsideStore(base, file) {
  const parts = file.split("/");
  const root = path.resolve(base);
  if (!path.resolve(root, ...parts).startsWith(`${root}${path.sep}`)) return true;
  for (let at = 1; at <= parts.length; at++) {
    const stats = await lstat(path.join(root, ...parts.slice(0, at))).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    });
    if (!stats) return false;
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}
async function refuseOutsidePaths(base, files) {
  for (const file of files) {
    if (await outsideStore(base, file)) throw Object.assign(new Error(`The upstream changes the path ${JSON.stringify(file)}, which leads outside the store's files through a symbolic link in the store, so the store was left as it was.`), { unsafePath: true });
  }
}
async function clearFolder(target) {
  const stats = await lstat(target).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  });
  if (stats?.isDirectory()) await rmdir(target).catch((error) => {
    if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error;
  });
  return stats;
}
async function apply(base, from, to, options, progress = {}, held = /* @__PURE__ */ new Map(), diskTree = from) {
  const marker = syncPath(base, "working-tree");
  await writeAtomically(marker, JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
  let files = [];
  try {
    await options.beforeApply?.();
    const { shareable, bound } = await storeLayout();
    const [before, after] = await Promise.all([diskTree instanceof Map ? diskTree : treeFiles(base, diskTree), treeFiles(base, to)]);
    const onDisk = (file) => [before.get(file), after.get(file)].some((entry) => FILE_MODES.has(entry?.mode)) || before.get(file)?.mode === "160000";
    files = [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])].filter((file) => shareable(file) && !sameEntry(before.get(file), after.get(file)) && onDisk(file)).sort();
    await refuseOutsidePaths(base, files);
    const targets = files.map((file) => path.join(base, ...file.split("/")));
    const artifacts = path.join(base, ARTIFACTS);
    const artifactLock = files.some(isGuardedFile) ? [artifacts] : [];
    const keys = /* @__PURE__ */ new Set();
    const locked = targets.filter((target, index) => !isGuardedFile(files[index]) && !keys.has(letterCaseKey(files[index])) && keys.add(letterCaseKey(files[index])));
    return await holdLocks(artifactLock, async () => {
      try {
        for (const target of locked) await mkdir(path.dirname(target), { recursive: true });
        return await holdLocks(locked, async () => {
          const next = [];
          const listings = /* @__PURE__ */ new Map();
          const ownBytes = async (index, cache) => await storedInSpelling(base, files[index], cache) ? boundedBytes(targets[index], bound(files[index])) : null;
          const blobOf = await boundedBlobReader(base, files, (file) => held.get(file)?.disk ? [after.get(file)] : [before.get(file), after.get(file), held.get(file)]);
          for (const [index, file] of files.entries()) {
            if (held.get(file)?.disk) {
              if (!await sameDiskFile(targets[index], held.get(file).disk)) return false;
              next.push(await blobOf(file, after.get(file)));
              continue;
            }
            const [bytes, expected] = await Promise.all([ownBytes(index, listings), blobOf(file, before.get(file))]);
            if (!sameBytes(bytes, expected) && !(held.has(file) && sameBytes(bytes, await blobOf(file, held.get(file))))) return false;
            next.push(await blobOf(file, after.get(file)));
          }
          if (progress.leaving) {
            const readComment = await commentFileReader();
            for (const file of await uncountedComments(base, before, after, files)) {
              const target = path.join(base, ...file.split("/"));
              if (!await lstat(target).catch(() => null)) continue;
              await progress.leaving(file, await readComment(target));
              await rm(target, { force: true });
            }
          }
          for (const [index, bytes] of next.entries()) {
            if (bytes !== null) continue;
            await progress.replacing?.(files[index]);
            if (!(await clearFolder(targets[index]))?.isDirectory()) await rm(targets[index], { force: true });
            if (guardedFolder(files[index])) await pruneArtifactFolders(path.join(base, guardedFolder(files[index])), targets[index]);
          }
          for (const [index, bytes] of next.entries()) {
            if (bytes === null) continue;
            await progress.replacing?.(files[index]);
            await respellFolders(base, files[index]);
            await mkdir(path.dirname(targets[index]), { recursive: true });
            await clearFolder(targets[index]);
            await writeAtomically(targets[index], bytes);
          }
          const written2 = /* @__PURE__ */ new Map();
          for (const [index, bytes] of next.entries()) if (!sameBytes(await ownBytes(index, written2), bytes)) return false;
          await required(base, ["read-tree", to]);
          await required(base, ["update-ref", "-m", "prism: sync records", "HEAD", to, ...from ? [from] : []]).catch(async (error) => {
            await git(base, from ? ["read-tree", from] : ["read-tree", "--empty"]);
            throw error;
          });
          await recordDiskCommit(base, to);
          return true;
        });
      } finally {
        for (const file of files) for (let folder = path.dirname(path.join(base, file)); folder !== base; folder = path.dirname(folder)) if (!await rmdir(folder).then(() => true, () => false)) break;
      }
    }).catch((error) => {
      if (error.code === "lock_timeout") return false;
      throw error;
    });
  } finally {
    await rm(marker, { force: true });
  }
}
async function uncountedComments(base, before, after, files) {
  const { isCommentFile, commentsMax } = await storeLayout();
  const growing = new Set(files.filter((file) => isCommentFile(file) && !before.has(file) && after.has(file)).map((file) => path.posix.dirname(file)));
  if (!growing.size) return [];
  const counts2 = new Map([...growing].map((folder) => [folder, 0]));
  for (const file of after.keys()) if (isCommentFile(file) && counts2.has(path.posix.dirname(file))) counts2.set(path.posix.dirname(file), counts2.get(path.posix.dirname(file)) + 1);
  const left = [];
  for (const [folder, count] of counts2) {
    const entries = await readdir(path.join(base, ...folder.split("/")), { withFileTypes: true }).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
      throw error;
    });
    const uncounted = entries.filter((entry) => entry.isFile()).map((entry) => `${folder}/${entry.name}`).filter((file) => isCommentFile(file) && !before.has(file) && !after.has(file)).sort();
    left.push(...uncounted.slice(Math.max(0, commentsMax - count)));
  }
  return left;
}
async function storedInSpelling(base, file, cache) {
  let folder = base;
  for (const name of file.split("/")) {
    let names = cache?.get(folder);
    if (!names) {
      names = await readdir(folder).catch((error) => {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
        throw error;
      });
      cache?.set(folder, names);
    }
    if (!names.includes(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}
async function respell(from, to) {
  if (process.platform !== "win32") return rename(from, to);
  const between = `${from}.respell-${process.pid}-${randomBytes(4).toString("hex")}`;
  await renameWhenFree(from, between);
  try {
    await renameWhenFree(between, to);
  } catch (error) {
    await renameWhenFree(between, from).catch(() => {
    });
    throw error;
  }
}
async function respellFolders(base, file) {
  let folder = base;
  for (const name of file.split("/").slice(0, -1)) {
    const names = await readdir(folder).catch(() => null);
    if (!names) return;
    const stored = names.includes(name) ? name : names.find((candidate) => letterCaseKey(candidate) === letterCaseKey(name));
    if (stored === void 0) return;
    if (stored !== name) {
      if (!await lstat(path.join(folder, name)).then((stats) => stats.isDirectory(), () => false)) return;
      await respell(path.join(folder, stored), path.join(folder, name));
    }
    folder = path.join(folder, name);
  }
}
const FILE_MANAGER_FILES = /* @__PURE__ */ new Set([".DS_Store"]);
const prunable = (entry) => entry.isFile() && FILE_MANAGER_FILES.has(entry.name) && !wellFormedName(entry.name);
async function pruneArtifactFolders(base, target) {
  for (let folder = path.dirname(target); folder !== base && folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      if (!entries.every(prunable)) return;
      for (const entry of entries) await rm(path.join(folder, entry.name));
      await rmdir(folder);
    } catch {
      return;
    }
  }
}
async function localStoreChanges(base) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const ahead = await git(base, ["rev-list", "--count", "--branches", "--not", "--remotes"]);
  const commits = !ahead.ok || Number(ahead.text) > 0 || await unpublished(base);
  const committed = head.ok ? (await partition(await treeFiles(base, head.text))).shared : /* @__PURE__ */ new Map();
  const withheld = /* @__PURE__ */ new Map();
  const onDisk = await localFiles(base, committed, withheld);
  let files = withheld.size > 0 || onDisk.size !== committed.size;
  for (const [file, entry] of onDisk) if (!files && committed.get(file)?.object !== entry.object) files = true;
  return { commits, files, conflicts: (await listSavedConflicts(base)).length > 0 };
}
export {
  GIT_MINIMUM,
  SYNC_DIRECTORY,
  cancelRecordSyncs,
  commitStoreFiles,
  configureRecordSync,
  confirmSavedConflicts,
  describeOversizedEntry,
  describeUnsafeEntry,
  gitTimeoutMs,
  gitTooOld,
  gitUrlText,
  handOffRecordSyncs,
  helperForRepository,
  listSavedConflicts,
  localRemoteRepository,
  localStoreChanges,
  localTransport,
  markManagedStore,
  moveUnderSyncLock,
  noLocalRepository,
  oversizedStoreEntry,
  prepareStoreFiles,
  pruneArtifactFolders,
  pullRecordStoreIfStale,
  readSavedConflict,
  readSyncStatus,
  releaseSavedConflicts,
  remoteHelperOption,
  runGit,
  runGitLines,
  scheduleRecordSync,
  syncRecordStore,
  syncRecordStoreNow,
  takeSavedConflicts,
  unsafeEntryFix,
  unsafeStoreEntry,
  waitForStableStore,
  writeCommitFiles
};
