// Generated from src/server/repository-intelligence/index-progress.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
const PROGRESS_FILE = /^progress-(\d+)\.json$/;
const WRITE_INTERVAL_MS = 500;
const HEARTBEAT_MS = 5e3;
const STAT_LIMIT = 2e3;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const progressFile = (directory, pid = process.pid) => path.join(directory, `progress-${pid}.json`);
const freshnessFile = (directory) => path.join(directory, "freshness.json");
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
class ProgressRecorder {
  constructor(directory, preparationId, now = () => /* @__PURE__ */ new Date()) {
    this.directory = directory;
    this.now = now;
    const at = now().toISOString();
    this.file = progressFile(directory);
    this.record = { schemaVersion: 1, pid: process.pid, preparationId, state: "preparing", startedAt: at, updatedAt: at, progress: null, diagnostics: [] };
  }
  record;
  file;
  written = 0;
  queue = Promise.resolve();
  trailing;
  heartbeat;
  async start() {
    await removeAbandonedProgress(this.directory);
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.write();
  }
  update(progress) {
    const phaseChanged = progress.phase !== this.record.progress?.phase;
    this.record.progress = progress;
    if (phaseChanged || Date.now() - this.written >= WRITE_INTERVAL_MS) {
      void this.write();
      return;
    }
    if (!this.trailing) {
      this.trailing = setTimeout(() => {
        this.trailing = void 0;
        void this.write();
      }, WRITE_INTERVAL_MS);
      this.trailing.unref();
    }
  }
  write() {
    this.written = Date.now();
    this.record.updatedAt = this.now().toISOString();
    const contents = JSON.stringify(this.record);
    this.queue = this.queue.then(() => writeAtomically(this.file, contents, { mode: 384 })).catch(() => {
    });
    return this.queue;
  }
  stop() {
    clearInterval(this.heartbeat);
    clearTimeout(this.trailing);
    this.trailing = void 0;
  }
  async succeed() {
    this.stop();
    await this.queue;
    await rm(this.file, { force: true }).catch(() => {
    });
  }
  async fail(diagnostics) {
    this.stop();
    Object.assign(this.record, { state: "failed", diagnostics, finishedAt: this.now().toISOString() });
    await this.write();
  }
}
async function removeAbandonedProgress(directory) {
  for (const name of await readdir(directory).catch(() => [])) {
    const pid = Number(PROGRESS_FILE.exec(name)?.[1]);
    if (pid && pid !== process.pid && !processAlive(pid)) await rm(path.join(directory, name), { force: true }).catch(() => {
    });
  }
}
async function readProgressRecords(directory) {
  const records = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!PROGRESS_FILE.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (record?.schemaVersion === 1 && Number.isInteger(record.pid) && ["preparing", "failed"].includes(record.state)) records.push(record);
    } catch {
    }
  }
  return records;
}
function git(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", ...args], { cwd: root, timeout: 5e3, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}
async function gitFingerprint(root) {
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return null;
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status === null) return null;
  const head = (await git(root, ["rev-parse", "-q", "--verify", "HEAD"]))?.trim() || null;
  const tokens = status.split("\0").filter(Boolean), digest = createHash("sha256").update(status);
  let checked = 0;
  for (let index = 0; index < tokens.length && checked < STAT_LIMIT; index++) {
    const token = tokens[index], code = token.slice(0, 2);
    if (/[RC]/.test(code)) index++;
    const info = await lstat(path.join(top, token.slice(3))).catch(() => null);
    digest.update(`\0${info ? `${info.size}:${info.mtimeMs}` : "missing"}`);
    checked++;
  }
  return { head, worktree: digest.digest("hex") };
}
const sameFingerprint = (left, right) => Boolean(left && right && left.head === right.head && left.worktree === right.worktree);
async function writeFreshness(directory, snapshot, fingerprint) {
  const record = { snapshot, git: fingerprint, checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await writeAtomically(freshnessFile(directory), JSON.stringify(record), { mode: 384 }).catch(() => {
  });
}
const projectStorageKey = (root) => sha(root);
export {
  HEARTBEAT_MS,
  ProgressRecorder,
  freshnessFile,
  gitFingerprint,
  processAlive,
  progressFile,
  projectStorageKey,
  readProgressRecords,
  sameFingerprint,
  writeFreshness
};
