import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../workflow/artifact-store.mjs";
import {
  REVIEW_APP_PROTOCOL,
  lockBase,
  newCredential,
  prepareDirectory,
  projectId,
  proveResponse,
  readDiscovery,
  readProjectRoots,
  removeDiscovery,
  verifyRequest,
  writeDiscovery,
  writeProjectRoots
} from "./review-app-discovery.mjs";
import { createProjectReview, isTrustedHost, normalizeTabs, readBody, send } from "./review-server.mjs";

const LEASE_MS = 3 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 30 * 1000;
const NONCE_MS = 2 * 60 * 1000;
const LOCK_RENEW_MS = 5 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 1000;

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw statusError(400, "The request body must be JSON.");
  }
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// Takes the app lock and keeps it until `stopped` settles; `held` rejects when another app holds it, and `released` settles once the lock file is gone.
function holdLock(directory, stopped, onRenew) {
  let released;
  const held = new Promise((resolve, reject) => {
    released = withFileLock(lockBase(directory), () => {
      resolve();
      return stopped;
    }, undefined, { renew: true, abandonWhenUnrenewed: true, heartbeatMs: LOCK_RENEW_MS, staleMs: LOCK_STALE_MS, timeoutMs: LOCK_TIMEOUT_MS, onRenew });
    released.catch(reject);
  });
  return { held, released: () => released.catch(() => {}) };
}

// The review app serves every registered project of one user from one port, behind a lock that keeps it unique.
export async function startReviewApp({ directory, pluginVersion = null, idleMs = IDLE_MS } = {}) {
  await prepareDirectory(directory);
  let releaseLock;
  const stopped = new Promise((resolve) => { releaseLock = resolve; });
  let close = () => Promise.resolve();
  let ownsLock = true;
  const lock = holdLock(directory, stopped, (held) => {
    if (!held) {
      ownsLock = false;
      void close({ handoff: false });
    } else {
      void republish();
    }
  });
  await lock.held;

  const previous = await readDiscovery(directory);
  const controlToken = newCredential();
  const instance = randomBytes(8).toString("hex");
  const projects = new Map();
  const nonces = new Map();
  let viewerToken = newCredential();
  let port = null;
  let published = null;
  let idleSince = Date.now();
  let closing = null;

  const viewerPrefix = () => `/session/${viewerToken}`;

  function viewerCount() {
    let count = 0;
    for (const project of projects.values()) count += project.review.viewerCount();
    return count;
  }

  function live(project, now = Date.now()) {
    for (const [lease, expiresAt] of project.leases) {
      if (expiresAt <= now) project.leases.delete(lease);
    }
    return project.leases.size > 0;
  }

  async function projectFor(projectRoot, { persist = true } = {}) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      throw statusError(400, "The projectRoot must be an absolute path.");
    }
    const root = await realpath(projectRoot).catch(() => { throw statusError(400, "The projectRoot does not exist."); });
    if (!(await stat(root)).isDirectory()) {
      throw statusError(400, "The projectRoot must be a directory.");
    }
    const id = projectId(root);
    let project = projects.get(id);
    if (!project) {
      const baseUrl = `http://127.0.0.1:${port}${viewerPrefix()}/p/${id}`;
      project = { id, root, leases: new Map(), lastSeen: 0, review: createProjectReview({ projectRoot: root, baseUrl, instance }) };
      projects.set(id, project);
      if (persist) await writeProjectRoots(directory, [...projects.values()].map(({ root: known }) => known)).catch(() => {});
    }
    return project;
  }

  function mostRecentLiveProject() {
    return [...projects.values()].filter((project) => live(project)).sort((left, right) => right.lastSeen - left.lastSeen)[0] ?? null;
  }

  function freshNonce(nonce) {
    const now = Date.now();
    for (const [seen, at] of nonces) {
      if (now - at > NONCE_MS) nonces.delete(seen);
    }
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, now);
    return true;
  }

  async function controlAnswer(request, route, text) {
    const lease = /^\/control\/projects\/([A-Za-z0-9_-]{1,64})$/.exec(route)?.[1];
    if (route === "/control/health" && request.method === "GET") {
      return { protocol: REVIEW_APP_PROTOCOL, pluginVersion, pid: process.pid };
    }
    if (route === "/control/projects" && request.method === "GET") {
      return { projects: [...projects.values()].map((project) => ({ id: project.id, projectRoot: project.root, live: live(project) })) };
    }
    if (lease && request.method === "PUT") {
      const project = await projectFor(parseBody(text).projectRoot);
      project.leases.set(lease, Date.now() + LEASE_MS);
      project.lastSeen = Date.now();
      return { projectId: project.id, url: project.review.reviewUrl([]) };
    }
    if (lease && request.method === "DELETE") {
      for (const project of projects.values()) project.leases.delete(lease);
      return {};
    }
    if (route === "/control/present" && request.method === "POST") {
      const body = parseBody(text);
      const project = await projectFor(body.projectRoot);
      const review = project.review;
      if (body.open === true) {
        const tabs = normalizeTabs(body.tabs);
        await review.presentTabs(tabs);
        project.lastSeen = Date.now();
        const url = review.reviewUrl(tabs);
        return { url, open: review.claimBrowserOpen(), session: review.getSession() };
      }
      if (body.tabs !== undefined) {
        await review.setOpenTabs(body.tabs);
        project.lastSeen = Date.now();
      }
      return { url: review.reviewUrl([]), open: false, session: review.getSession() };
    }
    if (route === "/control/shutdown" && request.method === "POST") {
      const handoff = parseBody(text).handoff === true;
      setImmediate(() => void close({ handoff }));
      return {};
    }
    throw statusError(404, "Not found");
  }

  // Control requests must be signed with the control credential and never come from a page, and every answer proves the app knows it.
  async function handleControl(request, response, route) {
    const text = await readBody(request);
    const nonce = request.headers.origin === undefined ? verifyRequest(controlToken, request.headers["x-prism-control"], request.method, request.url, text) : null;
    if (!nonce || !freshNonce(nonce)) {
      send(response, 403, "Forbidden");
      return;
    }
    let status = 200;
    let body;
    try {
      body = JSON.stringify(await controlAnswer(request, route, text));
    } catch (error) {
      status = error.status ?? 400;
      body = JSON.stringify({ message: error.message });
    }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Prism-Proof": proveResponse(controlToken, nonce, body)
    });
    response.end(body);
  }

  const server = createServer(async (request, response) => {
    try {
      if (!isTrustedHost(request.headers.host)) {
        send(response, 403, "Unknown host");
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/control/")) {
        await handleControl(request, response, url.pathname);
        return;
      }
      const prefix = viewerPrefix();
      if (url.pathname === prefix || url.pathname === `${prefix}/`) {
        const project = mostRecentLiveProject();
        if (!project) {
          send(response, 404, "No project is using Prism right now.");
          return;
        }
        response.writeHead(302, { Location: `${prefix}/p/${project.id}/`, "Cache-Control": "no-store" });
        response.end();
        return;
      }
      const match = url.pathname.startsWith(`${prefix}/p/`) ? /^\/p\/([0-9a-f]{16})(\/.*)?$/.exec(url.pathname.slice(prefix.length)) : null;
      const project = match ? projects.get(match[1]) : null;
      if (!project) {
        send(response, 404, "Not found");
        return;
      }
      await project.review.handle(request, response, match[2] || "/", url);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, error.status ?? 400, error.message);
      }
    }
  });

  // A successor keeps the port and viewer credential only from a recent handed-off file and only on that same port, so a tab reconnects
  // after a replacement but a credential that a tab may have sent to another listener after a crash or long ago is never served again.
  let bound = false;
  const handedOffAt = Date.parse(previous?.handedOffAt);
  if (previous?.handoff === true && Date.now() - handedOffAt <= LOCK_STALE_MS) {
    try {
      await listen(server, previous.port);
      viewerToken = previous.viewerToken;
      bound = true;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  if (!bound) await listen(server, 0);
  port = server.address().port;

  for (const root of await readProjectRoots(directory)) {
    await projectFor(root, { persist: false }).catch(() => {});
  }

  published = { protocol: REVIEW_APP_PROTOCOL, port, controlToken, viewerToken, pid: process.pid, pluginVersion, startedAt: new Date().toISOString() };
  await writeDiscovery(directory, published);

  // A losing starter may have overwritten or removed the file, so the owner restores it at each lock renewal.
  async function republish() {
    if (closing || !published) return;
    const current = await readDiscovery(directory);
    if (current?.controlToken !== controlToken) await writeDiscovery(directory, published).catch(() => {});
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    const busy = viewerCount() > 0 || [...projects.values()].some((project) => live(project, now));
    if (busy) idleSince = now;
    else if (now - idleSince >= idleMs) void close({ handoff: false });
  }, SWEEP_MS);
  sweep.unref();

  close = ({ handoff = false } = {}) => {
    closing ??= (async () => {
      clearInterval(sweep);
      for (const project of projects.values()) project.review.closeViewers();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      // Only the lock holder touches the discovery file, so an app that lost its lock never removes the winner's.
      if (ownsLock) {
        if (handoff) await writeDiscovery(directory, { ...published, handoff: true, handedOffAt: new Date().toISOString() }).catch(() => {});
        else await removeDiscovery(directory, controlToken).catch(() => {});
      }
      releaseLock();
      await lock.released();
    })();
    return closing;
  };

  return { port, instance, viewerUrl: `http://127.0.0.1:${port}${viewerPrefix()}/`, closed: stopped.then(() => closing), close };
}
