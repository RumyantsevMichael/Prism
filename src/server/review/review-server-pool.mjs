import { startReviewServer } from "./review-server.mjs";

const REVIEW_SERVER_IDLE_MS = 30 * 60 * 1000;

export function createReviewServerPool({ start = startReviewServer } = {}) {
  const reviewServers = new Map();
  const taskRoots = new Map();

  function refreshIdleTimeout(projectRoot, binding) {
    clearTimeout(binding.idleTimeout);
    const idleTimeout = setTimeout(async () => {
      if (binding.idleTimeout !== idleTimeout || reviewServers.get(projectRoot) !== binding) {
        return;
      }
      try {
        const review = await binding.review;
        if (review.viewerCount() > 0) {
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
    const review = start({ projectRoot });
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
  }

  return { get, close };
}
