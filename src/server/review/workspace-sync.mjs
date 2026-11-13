import { readSyncStatus, syncRecordStore } from "../workflow/record-store-sync.mjs";
import { withoutCredentials } from "../workflow/remote-url.mjs";

// An open workspace keeps its store's managed clone in step with the store's upstream while a page of it is connected:
// the first page to connect starts a fetch, each later one comes every interval, a failed fetch doubles the wait up to the maximum, and the last page to leave stops the timer.
// The clone itself is the last synced copy, so every page keeps reading it while the upstream cannot be reached.

export const WORKSPACE_FETCH_MS = 60 * 1000;
export const WORKSPACE_FETCH_MAX_MS = 15 * 60 * 1000;

// The sync outcomes after which the store's upstream was fetched, whatever the merge or the push did next; a failed fetch or Git command is a failed attempt.
const FAILED = new Set(["fetch_failed", "git_failed", "not_a_repository"]);
const FETCHED = new Set(["ok", "conflicts", "push_rejected", "merge_failed"]);

/** Git's reason, from its last line that says something, without credentials and without Git's own fatal: or error: prefix. */
export function gitReason(message) {
  const lines = withoutCredentials(String(message ?? "")).split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.findLast((item) => /^(fatal|error):/i.test(item)) ?? lines.at(-1) ?? "";
  return line.replace(/^(fatal|error):\s*/i, "") || "Git gave no reason";
}

const iso = (time) => time === null ? null : new Date(time).toISOString();

/**
 * The fetch timer of one workspace: { viewers(count), state(), stop() }.
 * base() answers the folder of the store's managed clone, or null while the workspace has no clone to sync, and label() names the store without credentials in messages.
 * viewers(count) passes the number of the workspace's connected pages; state() answers { state, lastSyncedAt, lastAttemptAt, nextFetchAt, message }, with state syncing only while a fetch runs before any fetch succeeded.
 * sync(base) runs one record store sync, which commits the app's own record writes, fetches and merges the upstream, and pushes.
 * fetchCode() fetches the code clones of the workspace's repositories whose code content is on, after the store's sync and whatever its outcome, and never changes the store's sync state.
 */
export function watchWorkspace({ base, label, intervalMs = WORKSPACE_FETCH_MS, maxMs = WORKSPACE_FETCH_MAX_MS, sync = syncRecordStore, fetchCode = async () => {}, now = Date.now } = {}) {
  let connected = 0;
  let timer = null;
  let running = null;
  let stopped = false;
  // wait is the wait after the latest attempt, and dueAt when the next fetch is due, which a page that reconnects during a backoff keeps.
  let wait = intervalMs;
  let dueAt = null;
  let lastAttemptAt = null;
  let lastSyncedAt = null;
  let failure = null;
  // A restarted app takes the time of the last fetch that succeeded from the store's own sync status, once.
  let restored = null;

  function restore() {
    restored ??= (async () => {
      const folder = await base().catch(() => null);
      const status = folder ? await readSyncStatus(folder) : null;
      const at = Date.parse(status?.at);
      if (lastSyncedAt === null && FETCHED.has(status?.state) && Number.isFinite(at)) lastSyncedAt = at;
    })();
    return restored;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (stopped || connected === 0 || running) return;
    const delay = Math.max(0, (dueAt ?? now()) - now());
    timer = setTimeout(() => { timer = null; void fetchNow(); }, delay);
    timer.unref?.();
  }

  async function fetchNow() {
    if (running || stopped) return running;
    running = (async () => {
      const startedAt = now();
      lastAttemptAt = startedAt;
      let outcome = null;
      try {
        const folder = await base();
        outcome = folder ? await sync(folder) : { state: "skipped" };
      } catch (error) {
        outcome = { state: "git_failed", message: error?.message };
      }
      // Each code clone records its own reachability, so a repository that cannot be fetched never makes the store look unreachable.
      await Promise.resolve().then(fetchCode).catch(() => {});
      if (FAILED.has(outcome?.state)) {
        wait = Math.min(wait * 2, maxMs);
        failure = `Prism could not fetch ${label()}, so this page shows the copy it last synced: ${gitReason(outcome.message)}`;
      } else {
        // A sync that another process held the lock for leaves the outcome as it was, and the next fetch comes after the interval.
        if (outcome?.state !== "skipped") {
          lastSyncedAt = now();
          failure = null;
        }
        wait = intervalMs;
      }
      dueAt = startedAt + wait;
    })().finally(() => {
      running = null;
      schedule();
    });
    return running;
  }

  return {
    viewers(count) {
      const before = connected;
      connected = Math.max(0, count);
      if (connected === 0) {
        clearTimeout(timer);
        timer = null;
        return;
      }
      if (before === 0) {
        void restore();
        schedule();
      }
    },
    async state() {
      await restore();
      return {
        // A retry during a backoff keeps the store unreachable until a fetch succeeds, and a fetch after one that succeeded keeps it ok,
        // since a sync that takes longer than the interval starts the next fetch as soon as it ends and would otherwise never show ok.
        state: failure ? "unreachable" : running && lastSyncedAt === null ? "syncing" : "ok",
        lastSyncedAt: iso(lastSyncedAt),
        lastAttemptAt: iso(lastAttemptAt),
        nextFetchAt: connected > 0 && !stopped ? iso(dueAt ?? now()) : null,
        message: failure
      };
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    }
  };
}
