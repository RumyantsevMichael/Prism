import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { pluginPath } from "../plugin-root.mjs";
import { REVIEW_APP_PROTOCOL, lockPath, readDiscovery, reviewAppDirectory, signRequest, trustedDirectory, verifyResponse } from "./review-app-discovery.mjs";

const REQUEST_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const LEASE_RENEW_MS = 60 * 1000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function failure(message, reachable) {
  return Object.assign(new Error(message), { reachable });
}

// A request the app did not prove it answered counts as unreachable, so the client never acts on another listener's reply.
function controlRequest(discovery, method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const signed = signRequest(discovery.controlToken, method, route, text);
    const request = http.request({
      host: "127.0.0.1",
      port: discovery.port,
      method,
      path: route,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "X-Prism-Control": signed.header, ...(text ? { "Content-Type": "application/json" } : {}) }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
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
    request.once("timeout", () => request.destroy(failure("The review app did not answer.", false)));
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

// A client finds the user's review app, starts it when none proves itself, and replaces an app with an older protocol.
export function createReviewAppClient({ directory = reviewAppDirectory(), launch = launchReviewApp, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  let current = null;
  let connecting = null;
  const leases = new Map();

  async function proven(candidate) {
    if (!candidate) return null;
    try {
      const health = await controlRequest(candidate, "GET", "/control/health");
      return Number.isSafeInteger(health.protocol) ? { ...candidate, protocol: health.protocol } : null;
    } catch {
      return null;
    }
  }

  async function connect() {
    if (!(await trustedDirectory(directory))) throw failure("The review app state directory is not private to this user.", false);
    const deadline = Date.now() + startTimeoutMs;
    const found = await proven(await readDiscovery(directory));
    if (found && found.protocol >= REVIEW_APP_PROTOCOL) return found;
    if (found) {
      await controlRequest(found, "POST", "/control/shutdown", { handoff: true }).catch(() => {});
      await lockCleared(directory, deadline);
    }
    launch({ directory });
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const started = await proven(await readDiscovery(directory));
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
    return call("PUT", `/control/projects/${leases.get(projectRoot).id}`, { projectRoot });
  }

  // Each renewal names the project, so a replacement app learns every live project at the next renewal.
  async function register(projectRoot) {
    if (!leases.has(projectRoot)) {
      const timer = setInterval(() => void renew(projectRoot).catch(() => {}), LEASE_RENEW_MS);
      timer.unref();
      leases.set(projectRoot, { id: randomUUID(), timer });
    }
    return renew(projectRoot);
  }

  function present(projectRoot, { tabs, open }) {
    return call("POST", "/control/present", { projectRoot, ...(tabs === undefined ? {} : { tabs }), open });
  }

  async function close() {
    const released = [...leases.values()];
    leases.clear();
    for (const lease of released) clearInterval(lease.timer);
    if (!current) return;
    await Promise.allSettled(released.map((lease) => controlRequest(current, "DELETE", `/control/projects/${lease.id}`)));
  }

  return { register, present, close };
}
