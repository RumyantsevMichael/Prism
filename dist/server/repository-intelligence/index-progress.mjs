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
const shared = /* @__PURE__ */ new Map();
const live = /* @__PURE__ */ new Map();
const sharedFile = (file) => {
  let state = shared.get(file);
  if (!state) shared.set(file, state = { queue: Promise.resolve() });
  return state;
};
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
  displaced = false;
  async start() {
    if (!live.has(this.directory)) live.set(this.directory, /* @__PURE__ */ new Set());
    live.get(this.directory).add(this);
    const state = sharedFile(this.file);
    if (state.owner && state.owner !== this) {
      state.owner.displaced = true;
      state.owner.stop();
    }
    state.owner = this;
    await removeAbandonedProgress(this.directory);
    if (this.displaced) return;
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.write();
  }
  // A recorder changes the file while it owns it, or, when it never started, as a failure recorded before any build, while no other recorder does.
  owns() {
    const owner = shared.get(this.file)?.owner;
    return !this.displaced && (owner === this || owner === void 0);
  }
  enqueue(operation) {
    const state = sharedFile(this.file);
    this.queue = state.queue = state.queue.then(async () => {
      if (this.owns()) await operation();
    }).catch(() => {
    });
    return this.queue;
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
    return this.enqueue(() => writeAtomically(this.file, contents, { mode: 384 }));
  }
  stop() {
    clearInterval(this.heartbeat);
    clearTimeout(this.trailing);
    this.trailing = void 0;
  }
  // Gives the file up once this recorder's last operation has run, so the next build of the directory owns it.
  release() {
    live.get(this.directory)?.delete(this);
    if (!live.get(this.directory)?.size) live.delete(this.directory);
    const state = shared.get(this.file);
    if (state?.owner === this) state.owner = void 0;
    if (state && !state.owner && state.queue === this.queue) shared.delete(this.file);
  }
  async succeed() {
    this.stop();
    await this.enqueue(() => rm(this.file, { force: true }));
    this.release();
  }
  async fail(diagnostics) {
    this.stop();
    Object.assign(this.record, { state: "failed", diagnostics, finishedAt: this.now().toISOString() });
    await this.write();
    this.release();
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
async function lockHolder(directory, self) {
  for (const record of await readProgressRecords(directory)) if (record.pid !== process.pid && record.state === "preparing" && processAlive(record.pid)) return record.preparationId;
  for (const recorder of live.get(directory) ?? []) if (recorder !== self) return recorder.record.preparationId;
  return null;
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
const componentStorageKey = (root, name) => sha(`${root}\0${name}`);
export {
  HEARTBEAT_MS,
  ProgressRecorder,
  componentStorageKey,
  freshnessFile,
  gitFingerprint,
  lockHolder,
  processAlive,
  progressFile,
  projectStorageKey,
  readProgressRecords,
  sameFingerprint,
  writeFreshness
};
