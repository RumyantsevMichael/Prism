import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { isMainThread, threadId } from "node:worker_threads";

// Every Prism process of the user appends one JSON object per line to one log file in the Prism app folder, so the review app, each agent
// session's MCP server, and their threads leave one ordered record. A record names its process, process id, and thread, and the log keeps
// one older file once it grows past its limit. Writing never throws: a log that cannot be written leaves the process working without it.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const LEVELS: Record<Level | "off", number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };
export const LOG_FILE = "prism.log";
export const LOG_BYTES = 5 * 1024 * 1024;
// The event loop of a server that answers pages and agents must not stop for longer than this; a longer stop is logged with what was running.
export const STALL_MS = 1000;

/** The Prism app folder, as the review app resolves it; PRISM_LOG_DIR moves only the log. */
export function logDirectory(env: NodeJS.ProcessEnv = process.env) {
  if (env.PRISM_LOG_DIR) return path.resolve(env.PRISM_LOG_DIR);
  const app = env.PRISM_REVIEW_APP_DIR ? path.resolve(env.PRISM_REVIEW_APP_DIR)
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Prism")
      : process.platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Prism")
        : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "prism");
  return path.join(app, "logs");
}

function threshold(env: NodeJS.ProcessEnv = process.env) {
  const value = (env.PRISM_LOG_LEVEL || "info").toLowerCase();
  return value in LEVELS ? LEVELS[value as Level | "off"] : LEVELS.info;
}

// An error is logged by its code, message, and the first lines of its stack, never as an object whose fields could hold file contents.
export function errorFields(error: unknown): Fields {
  if (!(error instanceof Error)) return { error: String(error) };
  const coded = error as Error & { code?: unknown };
  return { error: error.message, ...(coded.code === undefined ? {} : { code: coded.code }), ...(error.stack ? { stack: error.stack.split("\n").slice(0, 8).join("\n") } : {}) };
}

class Log {
  name = "prism";
  directory: string | null = null;
  level = threshold();
  mirror = false;
  // Writes leave in order, one at a time, so a rotation never splits a record and records of one process stay in the order they were made.
  writing: Promise<void> = Promise.resolve();
  bytes: number | null = null;
  // What the process is doing, by area, so a stall record can say what held the event loop.
  activity = new Map<string, string>();

  configure({ name, directory = logDirectory(), level = threshold(), mirror = false }: { name: string; directory?: string | null; level?: number; mirror?: boolean }) {
    Object.assign(this, { name, directory, level, mirror, bytes: null });
  }
  enabled(level: Level) { return this.directory !== null && LEVELS[level] >= this.level; }
  write(level: Level, event: string, fields: Fields = {}) {
    if (LEVELS[level] < this.level) return;
    const record = { at: new Date().toISOString(), level, process: this.name, pid: process.pid, ...(isMainThread ? {} : { thread: threadId }), event, ...fields };
    let line: string;
    try { line = `${JSON.stringify(record)}\n`; } catch { line = `${JSON.stringify({ ...record, ...Object.fromEntries(Object.keys(fields).map(key => [key, "[unserializable]"])) })}\n`; }
    if (this.mirror && LEVELS[level] >= LEVELS.warn) process.stderr.write(`prism ${level}: ${event}${fields.error ? `: ${fields.error}` : ""}\n`);
    const directory = this.directory;
    if (!directory) return;
    this.writing = this.writing.then(() => this.append(directory, line)).catch(() => {});
  }
  async append(directory: string, line: string) {
    const file = path.join(directory, LOG_FILE);
    if (this.bytes === null) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.bytes = (await stat(file).catch(() => null))?.size ?? 0;
    }
    if (this.bytes + line.length > LOG_BYTES) {
      // Another process may have rotated the file already, so the size on disk decides.
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size + line.length > LOG_BYTES) await rename(file, `${file}.1`).catch(() => {});
      this.bytes = size + line.length > LOG_BYTES ? 0 : size;
    }
    await appendFile(file, line, { mode: 0o600 });
    this.bytes += Buffer.byteLength(line);
  }
  debug(event: string, fields?: Fields) { this.write("debug", event, fields); }
  info(event: string, fields?: Fields) { this.write("info", event, fields); }
  warn(event: string, fields?: Fields) { this.write("warn", event, fields); }
  error(event: string, fields?: Fields) { this.write("error", event, fields); }
  /** Records what an area of the process does until the returned function is called. */
  doing(area: string, what: string) {
    this.activity.set(area, what);
    return () => { if (this.activity.get(area) === what) this.activity.delete(area); };
  }
  /** Resolves once every record made so far is written. */
  flush() { return this.writing; }
}

export const log = new Log();

/**
 * Starts the process log: a start record, a record of each uncaught error, and a record each time the event loop stops for longer
 * than STALL_MS, naming what the process was doing. An uncaught error still ends the process as it would without the log.
 */
export function startProcessLog(name: string, fields: Fields = {}, { mirror = false, stallMs = STALL_MS }: { mirror?: boolean; stallMs?: number } = {}) {
  log.configure({ name, mirror });
  log.info("process_started", { node: process.version, platform: `${process.platform}-${process.arch}`, ...fields });
  process.on("uncaughtExceptionMonitor", (error, origin) => log.error("uncaught_error", { origin, ...errorFields(error) }));
  watchEventLoop(stallMs);
}

let watching: NodeJS.Timeout | null = null;
export function watchEventLoop(stallMs = STALL_MS) {
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
