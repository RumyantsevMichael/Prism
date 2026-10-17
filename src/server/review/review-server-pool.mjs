import { createReviewAppClient } from "./review-app-client.mjs";
import { normalizeTabs, openBrowser, startReviewServer } from "./review-server.mjs";

const REVIEW_SERVER_IDLE_MS = 30 * 60 * 1000;

function tabUrl(baseUrl, tabs) {
  const [activeTab] = normalizeTabs(tabs);
  return activeTab ? `${baseUrl}review?artifact=${encodeURIComponent(activeTab)}` : baseUrl;
}

// A project served by the shared review app until the app cannot be reached, then by its own session server for the rest of the session.
async function appBackedReview(client, projectRoot, { startSession, openBrowser: browserOpener }) {
  let session = null;
  const fallBack = async () => {
    if (!session) client.release(projectRoot);
    session ??= startSession({ projectRoot, openBrowser: browserOpener });
    return session;
  };
  async function viaApp(action, fallback) {
    if (session) return fallback(await session);
    try {
      return await action();
    } catch (error) {
      if (error.reachable) throw error;
      return fallback(await fallBack());
    }
  }
  try {
    await client.register(projectRoot);
  } catch (error) {
    if (error.reachable) throw error;
    return fallBack();
  }
  return {
    projectRoot,
    // The app answers with its current address, so a link stays valid after the app is replaced on another port or credential.
    reviewUrl: (tabs) => viaApp(async () => tabUrl((await client.present(projectRoot, { open: false })).url, tabs), (review) => review.reviewUrl(tabs)),
    getSession: () => viaApp(async () => (await client.present(projectRoot, { open: false })).session, (review) => review.getSession()),
    setOpenTabs: (tabs) => viaApp(async () => (await client.present(projectRoot, { tabs, open: false })).session.openTabs, (review) => review.setOpenTabs(tabs)),
    open: (tabs) => viaApp(async () => {
      const answer = await client.present(projectRoot, { tabs: normalizeTabs(tabs), open: true });
      // The app never opens a browser; this session opens it in its own environment.
      const opened = answer.open ? Boolean(await browserOpener(answer.url)) : false;
      return { url: answer.url, opened, ...answer.session };
    }, (review) => review.open(tabs)),
    viewerCount: () => session ? session.then((review) => review.viewerCount()) : 1,
    close: async () => session && (await session).close()
  };
}

export function createReviewServerPool({ start = startReviewServer, app } = {}) {
  const reviewServers = new Map();
  const taskRoots = new Map();
  const client = app ? createReviewAppClient(app) : null;
  const startReview = client ? (options) => appBackedReview(client, options.projectRoot, { startSession: start, openBrowser: app.openBrowser ?? openBrowser }) : start;

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
  const registered = new Set();
  function register(projectRoot) {
    if (!client || registered.has(projectRoot)) return;
    registered.add(projectRoot);
    void client.register(projectRoot).catch(() => {});
  }

  return { get, close, register };
}
