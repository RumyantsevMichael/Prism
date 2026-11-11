// Generated from src/server/log.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { isMainThread, threadId } from "node:worker_threads";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };
const LOG_FILE = "prism.log";
const LOG_BYTES = 5 * 1024 * 1024;
const STALL_MS = 1e3;
function logDirectory(env = process.env) {
  if (env.PRISM_LOG_DIR) return path.resolve(env.PRISM_LOG_DIR);
  const app = env.PRISM_REVIEW_APP_DIR ? path.resolve(env.PRISM_REVIEW_APP_DIR) : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Prism") : process.platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Prism") : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "prism");
  return path.join(app, "logs");
}
function threshold(env = process.env) {
  const value = (env.PRISM_LOG_LEVEL || "info").toLowerCase();
  return value in LEVELS ? LEVELS[value] : LEVELS.info;
}
function errorFields(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  const coded = error;
  return { error: error.message, ...coded.code === void 0 ? {} : { code: coded.code }, ...error.stack ? { stack: error.stack.split("\n").slice(0, 8).join("\n") } : {} };
}
class Log {
  name = "prism";
  directory = null;
  level = threshold();
  mirror = false;
  // Writes leave in order, one at a time, so a rotation never splits a record and records of one process stay in the order they were made.
  writing = Promise.resolve();
  bytes = null;
  // What the process is doing, by area, so a stall record can say what held the event loop.
  activity = /* @__PURE__ */ new Map();
  configure({ name, directory = logDirectory(), level = threshold(), mirror = false }) {
    Object.assign(this, { name, directory, level, mirror, bytes: null });
  }
  enabled(level) {
    return this.directory !== null && LEVELS[level] >= this.level;
  }
  write(level, event, fields = {}) {
    if (LEVELS[level] < this.level) return;
    const record = { at: (/* @__PURE__ */ new Date()).toISOString(), level, process: this.name, pid: process.pid, ...isMainThread ? {} : { thread: threadId }, event, ...fields };
    let line;
    try {
      line = `${JSON.stringify(record)}
`;
    } catch {
      line = `${JSON.stringify({ ...record, ...Object.fromEntries(Object.keys(fields).map((key) => [key, "[unserializable]"])) })}
`;
    }
    if (this.mirror && LEVELS[level] >= LEVELS.warn) process.stderr.write(`prism ${level}: ${event}${fields.error ? `: ${fields.error}` : ""}
`);
    const directory = this.directory;
    if (!directory) return;
    this.writing = this.writing.then(() => this.append(directory, line)).catch(() => {
    });
  }
  async append(directory, line) {
    const file = path.join(directory, LOG_FILE);
    if (this.bytes === null) {
      await mkdir(directory, { recursive: true, mode: 448 });
      this.bytes = (await stat(file).catch(() => null))?.size ?? 0;
    }
    if (this.bytes + line.length > LOG_BYTES) {
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size + line.length > LOG_BYTES) await rename(file, `${file}.1`).catch(() => {
      });
      this.bytes = size + line.length > LOG_BYTES ? 0 : size;
    }
    await appendFile(file, line, { mode: 384 });
    this.bytes += Buffer.byteLength(line);
  }
  debug(event, fields) {
    this.write("debug", event, fields);
  }
  info(event, fields) {
    this.write("info", event, fields);
  }
  warn(event, fields) {
    this.write("warn", event, fields);
  }
  error(event, fields) {
    this.write("error", event, fields);
  }
  /** Records what an area of the process does until the returned function is called. */
  doing(area, what) {
    this.activity.set(area, what);
    return () => {
      if (this.activity.get(area) === what) this.activity.delete(area);
    };
  }
  /** Resolves once every record made so far is written. */
  flush() {
    return this.writing;
  }
}
const log = new Log();
function startProcessLog(name, fields = {}, { mirror = false, stallMs = STALL_MS } = {}) {
  log.configure({ name, mirror });
  log.info("process_started", { node: process.version, platform: `${process.platform}-${process.arch}`, ...fields });
  process.on("uncaughtExceptionMonitor", (error, origin) => log.error("uncaught_error", { origin, ...errorFields(error) }));
  watchEventLoop(stallMs);
}
let watching = null;
function watchEventLoop(stallMs = STALL_MS) {
  if (watching) return;
  const interval = Math.max(50, Math.floor(stallMs / 4));
  let last = performance.now();
  watching = setInterval(() => {
    const now = performance.now(), stopped = now - last - interval;
    last = now;
    if (stopped >= stallMs) log.warn("event_loop_blocked", { blockedMs: Math.round(stopped), activity: Object.fromEntries(log.activity) });
  }, interval);
  watching.unref();
}
export {
  LOG_BYTES,
  LOG_FILE,
  STALL_MS,
  errorFields,
  log,
  logDirectory,
  startProcessLog,
  watchEventLoop
};
