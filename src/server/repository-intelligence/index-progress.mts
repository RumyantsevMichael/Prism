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
export class ProgressRecorder {
  record: ProgressRecord;
  file: string;
  written = 0;
  queue: Promise<void> = Promise.resolve();
  trailing?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  constructor(public directory: string, preparationId: string, public now = () => new Date()) {
    const at = now().toISOString();
    this.file = progressFile(directory);
    this.record = { schemaVersion: 1, pid: process.pid, preparationId, state: "preparing", startedAt: at, updatedAt: at, progress: null, diagnostics: [] };
  }
  async start() {
    await removeAbandonedProgress(this.directory);
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.write();
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
    this.queue = this.queue.then(() => writeAtomically(this.file, contents, { mode: 0o600 })).catch(() => {});
    return this.queue;
  }
  stop() { clearInterval(this.heartbeat); clearTimeout(this.trailing); this.trailing = undefined; }
  async succeed() {
    this.stop();
    await this.queue;
    await rm(this.file, { force: true }).catch(() => {});
  }
  async fail(diagnostics: Diagnostic[]) {
    this.stop();
    Object.assign(this.record, { state: "failed", diagnostics, finishedAt: this.now().toISOString() });
    await this.write();
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
