import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import type { Diagnostic, Progress } from "./repository-unit-types.mjs";

export interface GitFingerprint { head: string | null; worktree: string }
export interface ProgressRecord { schemaVersion: 1; pid: number; preparationId: string; state: "preparing" | "failed"; startedAt: string; updatedAt: string; finishedAt?: string; progress: Progress | null; diagnostics: Diagnostic[] }
export interface FreshnessRecord { snapshot: string; git: GitFingerprint | null; checkedAt: string }

const PROGRESS_FILE = /^progress-(\d+)\.json$/;
const WRITE_INTERVAL_MS = 500;
export const HEARTBEAT_MS = 5000;
// Status entries beyond this bound still change the porcelain digest, but their files are not checked for further edits.
const STAT_LIMIT = 2000;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const progressFile = (directory: string, pid = process.pid) => path.join(directory, `progress-${pid}.json`);
export const freshnessFile = (directory: string) => path.join(directory, "freshness.json");

export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Each process writes only its own file, so concurrent sessions never overwrite each other's progress. Writes are best effort and never
// fail a build. A heartbeat keeps the file fresh through steps that report nothing, so a reader can tell a stopped process from a slow step.
// The recorders of this process share one progress file per storage directory, and a load can run beside a build of the same directory.
// So every operation on a file runs in one order, and a recorder whose file another recorder has since started is displaced and changes it no more:
// a replaced build never writes or removes the record of a newer one.
const shared = new Map<string, { owner?: ProgressRecorder; queue: Promise<void> }>();
// The recorders of this process that started and have not finished, by storage directory, including one that another recorder displaced.
const live = new Map<string, Set<ProgressRecorder>>();
const sharedFile = (file: string) => { let state = shared.get(file); if (!state) shared.set(file, state = { queue: Promise.resolve() }); return state; };

export class ProgressRecorder {
  record: ProgressRecord;
  file: string;
  written = 0;
  queue: Promise<void> = Promise.resolve();
  trailing?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  displaced = false;
  constructor(public directory: string, preparationId: string, public now = () => new Date()) {
    const at = now().toISOString();
    this.file = progressFile(directory);
    this.record = { schemaVersion: 1, pid: process.pid, preparationId, state: "preparing", startedAt: at, updatedAt: at, progress: null, diagnostics: [] };
  }
  async start() {
    if (!live.has(this.directory)) live.set(this.directory, new Set());
    live.get(this.directory)!.add(this);
    const state = sharedFile(this.file);
    if (state.owner && state.owner !== this) { state.owner.displaced = true; state.owner.stop(); }
    state.owner = this;
    await removeAbandonedProgress(this.directory);
    if (this.displaced) return;
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.write();
  }
  // A recorder changes the file while it owns it, or, when it never started, as a failure recorded before any build, while no other recorder does.
  owns() { const owner = shared.get(this.file)?.owner; return !this.displaced && (owner === this || owner === undefined); }
  enqueue(operation: () => Promise<unknown>) {
    const state = sharedFile(this.file);
    this.queue = state.queue = state.queue.then(async () => { if (this.owns()) await operation(); }).catch(() => {});
    return this.queue;
  }
  update(progress: Progress) {
    const phaseChanged = progress.phase !== this.record.progress?.phase;
    this.record.progress = progress;
    if (phaseChanged || Date.now() - this.written >= WRITE_INTERVAL_MS) { void this.write(); return; }
    if (!this.trailing) { this.trailing = setTimeout(() => { this.trailing = undefined; void this.write(); }, WRITE_INTERVAL_MS); this.trailing.unref(); }
  }
  write() {
    this.written = Date.now();
    this.record.updatedAt = this.now().toISOString();
    const contents = JSON.stringify(this.record);
    return this.enqueue(() => writeAtomically(this.file, contents, { mode: 0o600 }));
  }
  stop() { clearInterval(this.heartbeat); clearTimeout(this.trailing); this.trailing = undefined; }
  // Gives the file up once this recorder's last operation has run, so the next build of the directory owns it.
  release() {
    live.get(this.directory)?.delete(this);
    if (!live.get(this.directory)?.size) live.delete(this.directory);
    const state = shared.get(this.file);
    if (state?.owner === this) state.owner = undefined;
    if (state && !state.owner && state.queue === this.queue) shared.delete(this.file);
  }
  async succeed() {
    this.stop();
    await this.enqueue(() => rm(this.file, { force: true }));
    this.release();
  }
  async fail(diagnostics: Diagnostic[]) {
    this.stop();
    Object.assign(this.record, { state: "failed", diagnostics, finishedAt: this.now().toISOString() });
    await this.write();
    this.release();
  }
}

// Progress files of stopped processes describe builds that can no longer finish, so a new build removes them.
async function removeAbandonedProgress(directory: string) {
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const pid = Number(PROGRESS_FILE.exec(name)?.[1]);
    if (pid && pid !== process.pid && !processAlive(pid)) await rm(path.join(directory, name), { force: true }).catch(() => {});
  }
}

export async function readProgressRecords(directory: string): Promise<ProgressRecord[]> {
  const records: ProgressRecord[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!PROGRESS_FILE.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (record?.schemaVersion === 1 && Number.isInteger(record.pid) && ["preparing", "failed"].includes(record.state)) records.push(record);
    } catch {
    }
  }
  return records;
}

/**
 * The preparation id of the build that another session runs in a storage directory: a live progress record of another process that is still preparing,
 * or a recorder of this process other than `self` that has not finished, as another runtime in the same process has; null when there is none.
 * A session whose progress phase is `waiting` only waits for the same lock, so it is passed over and never named as the holder.
 */
export async function lockHolder(directory: string, self?: ProgressRecorder): Promise<string | null> {
  const holding = (progress: Progress | null | undefined) => progress?.phase !== "waiting";
  for (const recorder of live.get(directory) ?? []) if (recorder !== self && holding(recorder.record.progress)) return recorder.record.preparationId;
  for (const record of await readProgressRecords(directory)) if (record.pid !== process.pid && record.state === "preparing" && holding(record.progress) && processAlive(record.pid)) return record.preparationId;
  return null;
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    // Optional locks stay off, so a status check never competes with the user's own Git commands for the index lock.
    execFile("git", ["--no-optional-locks", ...args], { cwd: root, timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}

// A cheap stand-in for the content fingerprint: the commit, the status of files under the root, and the size and modification time of each
// changed file. It can report a change that left indexed content equal, and it misses edits that keep a file's size and modification time.
export async function gitFingerprint(root: string): Promise<GitFingerprint | null> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return null;
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status === null) return null;
  const head = (await git(root, ["rev-parse", "-q", "--verify", "HEAD"]))?.trim() || null;
  const tokens = status.split("\0").filter(Boolean), digest = createHash("sha256").update(status);
  let checked = 0;
  for (let index = 0; index < tokens.length && checked < STAT_LIMIT; index++) {
    const token = tokens[index], code = token.slice(0, 2);
    // A rename or copy entry is followed by its source path, which has no status code.
    if (/[RC]/.test(code)) index++;
    const info = await lstat(path.join(top, token.slice(3))).catch(() => null);
    digest.update(`\0${info ? `${info.size}:${info.mtimeMs}` : "missing"}`);
    checked++;
  }
  return { head, worktree: digest.digest("hex") };
}

export const sameFingerprint = (left: GitFingerprint | null, right: GitFingerprint | null) => Boolean(left && right && left.head === right.head && left.worktree === right.worktree);

export async function writeFreshness(directory: string, snapshot: string, fingerprint: GitFingerprint | null) {
  const record: FreshnessRecord = { snapshot, git: fingerprint, checkedAt: new Date().toISOString() };
  await writeAtomically(freshnessFile(directory), JSON.stringify(record), { mode: 0o600 }).catch(() => {});
}

export const projectStorageKey = (root: string) => sha(root);
// A component's index has storage of its own beside the project's. The root component is keyed by an empty name, because its name is the
// repository's name, and renaming the repository must not discard its index; a declared component's name is never empty.
export const componentStorageKey = (root: string, name: string) => sha(`${root}\0${name}`);
