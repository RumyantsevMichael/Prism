import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { pluginPath, pluginVersion as installedVersion } from "../plugin-root.mjs";
import { REVIEW_APP_PROTOCOL, lockPath, olderVersion, readDiscovery, reviewAppDirectory, signRequest, trustedDirectory, verifyResponse } from "./review-app-discovery.mjs";

const REQUEST_TIMEOUT_MS = 2000;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const LEASE_RENEW_MS = 60 * 1000;
// Tabs of a replaced app reconnect within a few seconds, so a start that replaced one waits before it decides whether a tab is open.
const RECONNECT_GRACE_MS = 5000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function failure(message, reachable) {
  return Object.assign(new Error(message), { reachable });
}

// A request the app did not prove it answered counts as unreachable, so the client never acts on another listener's reply.
// The whole exchange has one deadline and a size limit, so a listener that trickles or floods bytes cannot hold a tool call.
function controlRequest(discovery, method, route, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((settle, fail) => {
    let deadline = null;
    const resolve = (value) => { clearTimeout(deadline); settle(value); };
    const reject = (error) => { clearTimeout(deadline); fail(error); };
    const text = body === undefined ? "" : JSON.stringify(body);
    const signed = signRequest(discovery.controlToken, method, route, text);
    const request = http.request({
      host: "127.0.0.1",
      port: discovery.port,
      method,
      path: route,
      headers: { "X-Prism-Control": signed.header, ...(text ? { "Content-Type": "application/json" } : {}) }
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
          value = answer ? JSON.parse(answer) : {};
        } catch {
          reject(failure("The review app returned an invalid response.", true));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(value);
        else reject(Object.assign(failure(value.message ?? `The review app answered ${response.statusCode}.`, true), { status: response.statusCode }));
      });
    });
    // Destroying a request whose response already started does not always surface an error, so the promise settles first.
    function abandon(message) {
      reject(failure(message, false));
      request.destroy();
    }
    deadline = setTimeout(() => abandon("The review app did not answer."), Math.max(0, timeoutMs));
    request.once("error", (error) => reject(Object.assign(error, { reachable: false })));
    request.end(text || undefined);
  });
}

// Starts the detached app outside any project, so it holds no project directory open and outlives this session.
export function launchReviewApp({ directory }) {
  try {
    const child = spawn(process.execPath, [pluginPath("dist", "server", "review-app.mjs")], {
      cwd: homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PRISM_REVIEW_APP_DIR: directory }
    });
    child.on("error", () => {});
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

// A client finds the user's review app, starts it when none proves itself, and replaces an app with an older protocol or plugin version.
// It never replaces a newer app, so sessions of two installed versions settle on the newer one instead of replacing each other.
// Every registration and presentation names the evidence store and index storage this process writes, so the app reads each project's
// evidence and indexing state from them.
export function createReviewAppClient({ directory = reviewAppDirectory(), launch = launchReviewApp, startTimeoutMs = START_TIMEOUT_MS, reconnectGraceMs = RECONNECT_GRACE_MS, pluginVersion = installedVersion(), evidenceDirectory, intelligenceDirectory } = {}) {
  const storage = Object.fromEntries(Object.entries({ evidenceDirectory, intelligenceDirectory }).filter(([, value]) => value !== undefined));
  let current = null;
  let connecting = null;
  let replaced = false;
  const leases = new Map();

  const remaining = (deadline) => Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());

  async function proven(candidate, deadline) {
    if (!candidate || remaining(deadline) <= 0) return null;
    try {
      const health = await controlRequest(candidate, "GET", "/control/health", undefined, remaining(deadline));
      if (!Number.isSafeInteger(health.protocol)) return null;
      return { ...candidate, protocol: health.protocol, pluginVersion: typeof health.pluginVersion === "string" ? health.pluginVersion : null };
    } catch {
      return null;
    }
  }

  async function connect() {
    if (!(await trustedDirectory(directory))) throw failure("The review app state directory is not private to this user.", false);
    const deadline = Date.now() + startTimeoutMs;
    const found = await proven(await readDiscovery(directory), deadline);
    if (found && found.protocol >= REVIEW_APP_PROTOCOL && !olderVersion(found.pluginVersion, pluginVersion)) return found;
    if (found) {
      replaced = true;
      await controlRequest(found, "POST", "/control/shutdown", { handoff: true }, remaining(deadline)).catch(() => {});
      await lockCleared(directory, deadline);
    }
    launch({ directory });
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const started = await proven(await readDiscovery(directory), deadline);
      if (started && started.controlToken !== found?.controlToken && started.protocol >= REVIEW_APP_PROTOCOL) return started;
    }
    throw failure("The review app did not start.", false);
  }

  async function app() {
    if (current) return current;
    connecting ??= connect().finally(() => { connecting = null; });
    current = await connecting;
    return current;
  }

  // One retry covers an app that exited or was replaced since this client last reached it; a reachable app's refusal is final.
  async function call(method, route, body) {
    const target = await app();
    try {
      return await controlRequest(target, method, route, body);
    } catch (error) {
      if (error.reachable && error.status !== 403) throw error;
      current = null;
      return controlRequest(await app(), method, route, body);
    }
  }

  async function renew(projectRoot) {
    return call("PUT", `/control/projects/${leases.get(projectRoot).id}`, { projectRoot, ...storage });
  }

  // Each renewal names the project, so a replacement app learns every live project at the next renewal.
  // A lease whose first registration fails is dropped, so a session that fell back never keeps launching apps.
  async function register(projectRoot) {
    if (leases.has(projectRoot)) return renew(projectRoot);
    const lease = { id: randomUUID(), timer: null };
    leases.set(projectRoot, lease);
    try {
      const answer = await renew(projectRoot);
      if (leases.get(projectRoot) === lease) {
        lease.timer = setInterval(() => void renew(projectRoot).catch(() => {}), LEASE_RENEW_MS);
        lease.timer.unref();
      }
      return answer;
    } catch (error) {
      if (leases.get(projectRoot) === lease) leases.delete(projectRoot);
      throw error;
    }
  }

  // A project that falls back to its own server stops renewing, so the app never lists it live and is never relaunched for it.
  function release(projectRoot) {
    const lease = leases.get(projectRoot);
    if (!lease) return;
    leases.delete(projectRoot);
    clearInterval(lease.timer);
    if (current) void controlRequest(current, "DELETE", `/control/projects/${lease.id}`).catch(() => {});
  }

  function present(projectRoot, { tabs, open }) {
    return call("POST", "/control/present", { projectRoot, ...(tabs === undefined ? {} : { tabs }), open, ...storage });
  }

  // Opens a browser at session start only while no tab of any project is connected, so many sessions open at most one window.
  async function openAtStart(projectRoot) {
    await register(projectRoot);
    if (replaced) await sleep(reconnectGraceMs);
    return call("POST", "/control/present", { projectRoot, open: true, start: true, ...storage });
  }

  // Starts the app without a project, for a host that names its project only with its first tool call.
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

  return { register, release, present, openAtStart, start, close };
}
