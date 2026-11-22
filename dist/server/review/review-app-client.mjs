// Generated from src/server/review/review-app-client.mts by scripts/native-build/compile.mjs.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { pluginPath, pluginVersion as installedVersion } from "../plugin-root.mjs";
import { REVIEW_APP_PROTOCOL, appAlive, lockPath, olderVersion, readDiscovery, reviewAppDirectory, signRequest, tightenDirectory, trustedDirectory, verifyResponse } from "./review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
const REQUEST_TIMEOUT_MS = 2e3;
const BUSY_TIMEOUT_MS = 30 * 1e3;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 5e3;
const POLL_MS = 50;
const LEASE_RENEW_MS = 60 * 1e3;
const RECONNECT_GRACE_MS = 5e3;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function failure(message, reachable, fields = {}) {
  return Object.assign(new Error(message), { reachable, ...fields });
}
function controlRequest(discovery, method, route, body, timeoutMs = REQUEST_TIMEOUT_MS, { alive = null, busyMs = BUSY_TIMEOUT_MS } = {}) {
  return new Promise((settle, fail) => {
    let deadline = null, done = false;
    const resolve = (value) => {
      done = true;
      clearTimeout(deadline);
      settle(value);
    };
    const reject = (error) => {
      done = true;
      clearTimeout(deadline);
      fail(error);
    };
    const text = body === void 0 ? "" : JSON.stringify(body);
    const signed = signRequest(discovery.controlToken, method, route, text);
    const request = http.request({
      host: "127.0.0.1",
      port: discovery.port,
      method,
      path: route,
      headers: { "X-Prism-Control": signed.header, ...text ? { "Content-Type": "application/json" } : {} }
    }, (response) => {
      response.once("error", (error) => reject(Object.assign(error, { reachable: false })));
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) abandon("The review app answer is too large.");
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const answer = Buffer.concat(chunks).toString("utf8");
        if (!verifyResponse(discovery.controlToken, signed.nonce, answer, response.headers["x-prism-proof"])) {
          reject(failure("The listener did not prove it is the review app.", false));
          return;
        }
        let value;
        try {
          value = answer ? parseStoreJson(answer) : {};
        } catch {
          reject(failure("The review app returned an invalid response.", true));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(value);
        else reject(Object.assign(failure(value.message ?? `The review app answered ${response.statusCode}.`, true), { status: response.statusCode }));
      });
    });
    function abandon(message, fields = {}) {
      reject(Object.assign(failure(message, false), fields));
      request.destroy();
    }
    const late = () => {
      if (!alive) {
        abandon("The review app did not answer.");
        return;
      }
      Promise.resolve(alive()).catch(() => false).then((running) => {
        if (done) return;
        if (!running) abandon("The review app did not answer, and it is no longer running.");
        else deadline = setTimeout(() => abandon(`The review app is running but did not answer within ${Math.round((timeoutMs + busyMs) / 1e3)} seconds.`, { busy: true }), Math.max(0, busyMs));
      });
    };
    deadline = setTimeout(late, Math.max(0, timeoutMs));
    request.once("error", (error) => reject(Object.assign(error, { reachable: false })));
    request.end(text || void 0);
  });
}
function launchReviewApp({ directory }) {
  try {
    const child = spawn(process.execPath, [pluginPath("dist", "server", "review-app.mjs")], {
      cwd: homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PRISM_REVIEW_APP_DIR: directory }
    });
    child.on("error", () => {
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}
async function lockCleared(directory, deadline) {
  while (Date.now() < deadline) {
    try {
      await access(lockPath(directory));
    } catch {
      return true;
    }
    await sleep(POLL_MS);
  }
  return false;
}
function createReviewAppClient({ directory = reviewAppDirectory(), launch = launchReviewApp, startTimeoutMs = START_TIMEOUT_MS, busyTimeoutMs = BUSY_TIMEOUT_MS, reconnectGraceMs = RECONNECT_GRACE_MS, pluginVersion = installedVersion(), evidenceDirectory, intelligenceDirectory, recordStoreDirectory } = {}) {
  const storage = Object.fromEntries(Object.entries({ evidenceDirectory, intelligenceDirectory, recordStoreDirectory }).filter(([, value]) => value !== void 0));
  let current = null;
  let connecting = null;
  let replaced = false;
  const leases = /* @__PURE__ */ new Map();
  const remaining = (deadline) => Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
  const alive = (discovery) => () => appAlive(directory, discovery);
  async function proven(candidate, deadline, { patient = false } = {}) {
    if (!candidate || remaining(deadline) <= 0) return null;
    try {
      const health = await controlRequest(candidate, "GET", "/control/health", void 0, remaining(deadline), patient ? { alive: alive(candidate), busyMs: busyTimeoutMs } : {});
      if (!Number.isSafeInteger(health.protocol)) return null;
      return { ...candidate, protocol: health.protocol, pluginVersion: typeof health.pluginVersion === "string" ? health.pluginVersion : null };
    } catch {
      return null;
    }
  }
  async function connect() {
    await tightenDirectory(directory);
    if (!await trustedDirectory(directory)) throw failure("The review app state directory is not private to this user.", false);
    const deadline = Date.now() + startTimeoutMs;
    const discovery = await readDiscovery(directory);
    const found = await proven(discovery, deadline, { patient: true });
    if (found && found.protocol >= REVIEW_APP_PROTOCOL && !olderVersion(found.pluginVersion, pluginVersion)) return found;
    if (!found && await appAlive(directory, discovery)) throw failure("The review app is running but too busy to answer.", false, { busy: true });
    if (found) {
      replaced = true;
      await controlRequest(found, "POST", "/control/shutdown", { handoff: true }, remaining(deadline)).catch(() => {
      });
      await lockCleared(directory, deadline);
    }
    const child = launch({ directory });
    let exited = null;
    child?.once?.("exit", (code, signal) => {
      exited = signal ? `on ${signal}` : `with code ${code}`;
    });
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const started = await proven(await readDiscovery(directory), deadline);
      if (started && started.controlToken !== found?.controlToken && started.protocol >= REVIEW_APP_PROTOCOL) return started;
    }
    throw failure(`The review app did not start within ${startTimeoutMs / 1e3} seconds${child ? exited ? `, and its process exited ${exited}` : "" : ", because its process could not be launched"}.`, false);
  }
  async function app() {
    if (current) return current;
    connecting ??= connect().finally(() => {
      connecting = null;
    });
    current = await connecting;
    return current;
  }
  async function call(method, route, body) {
    const target = await app();
    try {
      return await controlRequest(target, method, route, body, REQUEST_TIMEOUT_MS, { alive: alive(target), busyMs: busyTimeoutMs });
    } catch (error) {
      if (error.busy || error.reachable && error.status !== 403) throw error;
      current = null;
      return controlRequest(await app(), method, route, body);
    }
  }
  async function renew(projectRoot) {
    return call("PUT", `/control/projects/${leases.get(projectRoot).id}`, { projectRoot, ...storage });
  }
  async function register(projectRoot) {
    if (leases.has(projectRoot)) return renew(projectRoot);
    const lease = { id: randomUUID(), timer: null };
    leases.set(projectRoot, lease);
    try {
      const answer = await renew(projectRoot);
      if (leases.get(projectRoot) === lease) {
        lease.timer = setInterval(() => void renew(projectRoot).catch(() => {
        }), LEASE_RENEW_MS);
        lease.timer.unref();
      }
      return answer;
    } catch (error) {
      if (leases.get(projectRoot) === lease) leases.delete(projectRoot);
      throw error;
    }
  }
  function release(projectRoot) {
    const lease = leases.get(projectRoot);
    if (!lease) return;
    leases.delete(projectRoot);
    clearInterval(lease.timer);
    if (current) void controlRequest(current, "DELETE", `/control/projects/${lease.id}`).catch(() => {
    });
  }
  function present(projectRoot, { tabs, group, by, open }) {
    return call("POST", "/control/present", { projectRoot, ...tabs === void 0 ? {} : { tabs }, ...group === void 0 ? {} : { group }, ...by ? { by } : {}, open, acceptsGrant: true, ...storage });
  }
  async function openAtStart(projectRoot) {
    await register(projectRoot);
    if (replaced) await sleep(reconnectGraceMs);
    return call("POST", "/control/present", { projectRoot, open: true, start: true, acceptsGrant: true, ...storage });
  }
  function presentRoot() {
    return call("POST", "/control/present", { open: true, acceptsGrant: true });
  }
  async function start() {
    await app();
  }
  async function close() {
    const released = [...leases.values()];
    leases.clear();
    for (const lease of released) clearInterval(lease.timer);
    if (!current) return;
    await Promise.allSettled(released.map((lease) => controlRequest(current, "DELETE", `/control/projects/${lease.id}`)));
  }
  return { directory, register, release, present, presentRoot, openAtStart, start, close };
}
export {
  createReviewAppClient,
  launchReviewApp
};
