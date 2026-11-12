import { realpath } from "node:fs/promises";
import path from "node:path";
import { ConservationStore } from "../conservation/conservation-store.mjs";
import { managedStoresDirectory } from "../workflow/remote-url.mjs";
import { createReviewAppClient } from "./review-app-client.mjs";
import { pluginVersion } from "../plugin-root.mjs";
import { recordFallback, reviewAppDirectory, reviewAppDisabled } from "./review-app-discovery.mjs";
import { normalizeTabs, openBrowser, startReviewServer } from "./review-server.mjs";
import { withWriteGrant } from "./write-sessions.mjs";

const REVIEW_SERVER_IDLE_MS = 30 * 60 * 1000;
const RETRY_APP_MS = 60 * 1000;

function tabUrl(baseUrl, tabs) {
  const [activeTab] = normalizeTabs(tabs);
  return activeTab ? `${baseUrl}review?artifact=${encodeURIComponent(activeTab)}` : baseUrl;
}

// A project served by the shared review app until the app cannot be reached, then by its own session server until the app answers again.
// The fallback is recorded with its reason, and both its page and the agent's review links say that this session alone serves it.
// While it falls back, a use of the review at most once a minute tries the app in the background; once the app answers, new links lead to the app,
// and the session server keeps serving the tabs it has open until the project's review closes.
async function appBackedReview(client, projectRoot, { startSession, openBrowser: browserOpener, onFallback = recordFallback, retryMs = RETRY_APP_MS }) {
  let session = null;
  let privateServer = null;
  let fellBackAt = 0;
  let retrying = null;
  const former = [];
  const tryApp = () => {
    if (retrying || Date.now() - fellBackAt < retryMs) return;
    retrying = client.register(projectRoot).then(() => {
      if (session) former.push(session);
      session = null;
      privateServer = null;
    }, () => { fellBackAt = Date.now(); }).finally(() => { retrying = null; });
  };
  const fallBack = async (error) => {
    if (!session) {
      client.release(projectRoot);
      fellBackAt = Date.now();
      privateServer = { reason: error?.message || "The review app could not be reached." };
      void onFallback(client.directory, { projectRoot, reason: privateServer.reason, pluginVersion: pluginVersion() });
      session = startSession({ projectRoot, openBrowser: browserOpener, privateServer });
    }
    return session;
  };
  async function viaApp(action, fallback) {
    if (session) {
      const serving = session;
      tryApp();
      return fallback(await serving);
    }
    try {
      return await action();
    } catch (error) {
      if (error.reachable) throw error;
      return fallback(await fallBack(error));
    }
  }
  try {
    await client.register(projectRoot);
  } catch (error) {
    if (error.reachable) throw error;
    await fallBack(error);
  }
  return {
    projectRoot,
    // The app answers with its current address, so a link stays valid after the app is replaced on another port or credential.
    reviewUrl: (tabs) => viaApp(async () => tabUrl((await client.present(projectRoot, { open: false })).url, tabs), (review) => review.reviewUrl(tabs)),
    getSession: () => viaApp(async () => (await client.present(projectRoot, { open: false })).session, (review) => review.getSession()),
    setOpenTabs: (tabs) => viaApp(async () => (await client.present(projectRoot, { tabs, open: false })).session.openTabs, (review) => review.setOpenTabs(tabs)),
    open: (tabs, { group } = {}) => viaApp(async () => {
      const answer = await client.present(projectRoot, { tabs: normalizeTabs(tabs), ...(group === undefined ? {} : { group }), open: true });
      // The app never opens a browser; this session opens it in its own environment, with the app's grant in the fragment of only the URL it opens.
      const opened = answer.open ? Boolean(await browserOpener(withWriteGrant(answer.url, answer.writeGrant))) : false;
      return { url: answer.url, opened, ...answer.session };
    }, (review) => review.open(tabs, group === undefined ? {} : { group })),
    viewerCount: async () => {
      if (!session && !former.length) return 1;
      const counts = await Promise.all([...former, ...(session ? [session] : [])].map((held) => held.then((review) => review.viewerCount())));
      return (session ? 0 : 1) + counts.reduce((sum, count) => sum + count, 0);
    },
    privateServer: () => privateServer,
    heldServer: async () => session && await session,
    close: async () => {
      await retrying;
      await Promise.allSettled([...former, ...(session ? [session] : [])].map(async (held) => (await held).close()));
    }
  };
}

export function createReviewServerPool({ start = startReviewServer, app } = {}) {
  const reviewServers = new Map();
  const taskRoots = new Map();
  const client = app ? createReviewAppClient(app) : null;
  const startReview = client ? (options) => appBackedReview(client, options.projectRoot, { startSession: start, openBrowser: app.openBrowser ?? openBrowser, ...(app.onFallback ? { onFallback: app.onFallback } : {}), ...(app.retryMs === undefined ? {} : { retryMs: app.retryMs }) }) : start;

  function refreshIdleTimeout(projectRoot, binding) {
    clearTimeout(binding.idleTimeout);
    const idleTimeout = setTimeout(async () => {
      if (binding.idleTimeout !== idleTimeout || reviewServers.get(projectRoot) !== binding) {
        return;
      }
      try {
        const review = await binding.review;
        if (await review.viewerCount() > 0) {
          refreshIdleTimeout(projectRoot, binding);
          return;
        }
        reviewServers.delete(projectRoot);
        for (const [task, boundRoot] of taskRoots) {
          if (boundRoot === projectRoot) {
            taskRoots.delete(task);
          }
        }
        await review.close();
      } catch {
      }
    }, REVIEW_SERVER_IDLE_MS);
    binding.idleTimeout = idleTimeout;
    idleTimeout.unref();
  }

  async function get(projectRoot, id) {
    const boundRoot = taskRoots.get(id);
    if (boundRoot && boundRoot !== projectRoot) {
      throw new Error(`This task is already bound to project root: ${boundRoot}`);
    }
    taskRoots.set(id, projectRoot);
    const existing = reviewServers.get(projectRoot);
    if (existing) {
      refreshIdleTimeout(projectRoot, existing);
      return existing.review;
    }
    const review = startReview({ projectRoot });
    const binding = { projectRoot, review };
    reviewServers.set(projectRoot, binding);
    refreshIdleTimeout(projectRoot, binding);
    try {
      return await review;
    } catch (error) {
      clearTimeout(binding.idleTimeout);
      if (reviewServers.get(projectRoot) === binding) {
        reviewServers.delete(projectRoot);
      }
      if (taskRoots.get(id) === projectRoot) {
        taskRoots.delete(id);
      }
      throw error;
    }
  }

  async function close() {
    for (const binding of reviewServers.values()) {
      clearTimeout(binding.idleTimeout);
    }
    const reviews = await Promise.allSettled([...reviewServers.values()].map(({ review }) => review));
    await Promise.allSettled(reviews.filter(({ status }) => status === "fulfilled").map(({ value }) => value.close()));
    reviewServers.clear();
    taskRoots.clear();
    await client?.close();
  }

  // Registration lists the project in the review app from session start or the first tool call that names it, once per project;
  // a failure leaves it to the review tools, which fall back to a session server.
  // With open, a session start also opens a browser on the project while no review tab is connected.
  const registered = new Set();
  function register(projectRoot, { open = false } = {}) {
    if (!client || registered.has(projectRoot)) return;
    registered.add(projectRoot);
    const opener = app.openBrowser ?? openBrowser;
    const started = open ? client.openAtStart(projectRoot).then((answer) => answer.open && opener(withWriteGrant(answer.url, answer.writeGrant))) : client.register(projectRoot);
    void started.catch(() => {});
  }

  // Starts the review app before any project is known, so it is ready for a host that names its project only with a tool call.
  function startApp() {
    void client?.start().catch(() => {});
  }

  return { get, close, register, startApp };
}

/** prism review --workspaces opens the review app's root, its workspace list, with a write grant, from any folder; it needs the shared review app. */
export async function startWorkspacesReview({ env = process.env, openBrowser: browserOpener = openBrowser, app = {} } = {}) {
  if (reviewAppDisabled(env)) throw new Error("the workspace list is served by the shared review app, which PRISM_REVIEW_APP turns off here.");
  const client = createReviewAppClient({ directory: reviewAppDirectory(env), ...app });
  try {
    const answer = await client.presentRoot();
    const opened = answer.open ? Boolean(await browserOpener(withWriteGrant(answer.url, answer.writeGrant))) : false;
    return { url: answer.url, opened };
  } finally {
    await client.close();
  }
}

// The prism review command presents through the user's review app and returns; it holds a server only when it serves the review itself.
export async function startStandaloneReview({ projectRoot = process.cwd(), artifactPath, env = process.env, start = startReviewServer, openBrowser: browserOpener = openBrowser, app = {} } = {}) {
  const root = await realpath(path.resolve(projectRoot));
  if (reviewAppDisabled(env)) {
    const server = await start({ projectRoot: root, openBrowser: browserOpener });
    try {
      return { ...(await server.open(artifactPath)), held: server };
    } catch (error) {
      await server.close();
      throw error;
    }
  }
  // Without host data this command knows no project's evidence, so it leaves the app with the evidence a session reported; store clones live in the app folder for every host.
  const hostData = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  const client = createReviewAppClient({ directory: reviewAppDirectory(env), recordStoreDirectory: managedStoresDirectory(env), ...(hostData ? { evidenceDirectory: new ConservationStore(undefined, env).directory } : {}), ...app });
  const review = await appBackedReview(client, root, { startSession: start, openBrowser: browserOpener });
  try {
    const result = await review.open(artifactPath);
    return { ...result, held: await review.heldServer() };
  } catch (error) {
    await review.close();
    throw error;
  } finally {
    await client.close();
  }
}
