// Generated from src/server/repository-intelligence/native-helper.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { spawn } from "node:child_process";
import { jsonLine, readJsonLines } from "../json-lines.mjs";
import { log } from "../log.mjs";
import { semanticError } from "./native-files.mjs";
const STDERR_TAIL = 8e3;
class Helper {
  constructor(runtime, options, role = "build") {
    this.runtime = runtime;
    this.options = options;
    this.role = role;
  }
  child = null;
  idle;
  requests = /* @__PURE__ */ new Map();
  counter = 0;
  stderr = "";
  start() {
    if (this.child) return;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(CODEGRAPH_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete environment[key];
    Object.assign(environment, { PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
    const args = ["--liftoff-only", "--permission", `--allow-fs-read=${this.runtime}`, `--allow-fs-read=${this.options.directory}`, `--allow-fs-write=${this.options.directory}`, "--allow-addons", path.join(this.runtime, "worker.mjs")];
    const child = spawn(path.join(this.runtime, process.platform === "win32" ? "node.exe" : "node"), args, { env: environment, cwd: this.runtime, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.stderr = "";
    log.debug("native_helper_started", { role: this.role, helperPid: child.pid });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_TAIL);
    });
    const lines = readJsonLines(child.stdout);
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.stop(semanticError("preparation_failed", "The native helper returned invalid data."));
      }
      const pending = this.requests.get(message.id);
      if (!pending) return;
      if (message.progress) {
        pending.progress?.(message.progress);
        return;
      }
      this.requests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(semanticError(message.error.code, message.error.message));
      else pending.resolve(message.result);
      if (!this.requests.size) {
        this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 3e5);
        this.idle.unref();
      }
    });
    child.once("error", (error) => {
      log.error("native_helper_failed", { role: this.role, error: error.message });
      this.stop(semanticError("unsupported_runtime", "The bundled Node helper could not start."));
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      if (this.requests.size) log.error("native_helper_exited", { role: this.role, helperPid: child.pid, code, signal, pending: [...this.requests.values()].map((request) => request.method), stderr: this.stderr });
      this.stop(semanticError("preparation_failed", "The native helper exited before completing its request."));
    });
  }
  request(method, args, progress) {
    clearTimeout(this.idle);
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timeout = method === "search" ? setTimeout(() => {
        log.warn("native_helper_timed_out", { role: this.role, method, limitMs: this.options.operationMs ?? 30 * 60 * 1e3 });
        this.stop(semanticError("resource_limit", "Native search exceeded its 30 minute operation limit."));
      }, this.options.operationMs ?? 30 * 60 * 1e3) : void 0;
      let line;
      try {
        line = jsonLine({ id, method, args });
      } catch (error) {
        clearTimeout(timeout);
        if (!this.requests.size) {
          this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 3e5);
          this.idle.unref();
        }
        return reject(semanticError("preparation_failed", `The native helper request could not be serialized: ${error.message}`));
      }
      timeout?.unref();
      this.requests.set(id, { resolve: (value) => resolve(value), reject, timeout, progress, method });
      this.child.stdin.write(line, (error) => {
        if (error) this.stop(semanticError("preparation_failed", "The native helper input channel failed."));
      });
    });
  }
  stop(error = semanticError("preparation_failed", "The native helper stopped.")) {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.requests.clear();
  }
  /** Stops the helper and resolves once its process has exited. */
  close() {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("exit", () => resolve()));
  }
}
export {
  Helper
};
