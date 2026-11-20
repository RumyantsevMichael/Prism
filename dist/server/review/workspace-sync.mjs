// Generated from src/server/review/workspace-sync.mts by scripts/native-build/compile.mjs.
import { readSyncStatus, syncRecordStore } from "../workflow/record-store-sync.mjs";
import { withoutCredentials } from "../workflow/remote-url.mjs";
const WORKSPACE_FETCH_MS = 60 * 1e3;
const WORKSPACE_FETCH_MAX_MS = 15 * 60 * 1e3;
const FAILED = /* @__PURE__ */ new Set(["fetch_failed", "git_failed", "not_a_repository"]);
const FETCHED = /* @__PURE__ */ new Set(["ok", "conflicts", "push_rejected", "merge_failed"]);
function gitReason(message) {
  const lines = withoutCredentials(String(message ?? "")).split("\n").map((line2) => line2.trim()).filter(Boolean);
  const line = lines.findLast((item) => /^(fatal|error):/i.test(item)) ?? lines.at(-1) ?? "";
  return line.replace(/^(fatal|error):\s*/i, "") || "Git gave no reason";
}
const iso = (time) => time === null ? null : new Date(time).toISOString();
function watchWorkspace({ base, label, intervalMs = WORKSPACE_FETCH_MS, maxMs = WORKSPACE_FETCH_MAX_MS, sync = syncRecordStore, fetchCode = async () => {
}, now = Date.now } = {}) {
  let connected = 0;
  let timer = null;
  let running = null;
  let stopped = false;
  let wait = intervalMs;
  let dueAt = null;
  let lastAttemptAt = null;
  let lastSyncedAt = null;
  let failure = null;
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
    timer = setTimeout(() => {
      timer = null;
      void fetchNow();
    }, delay);
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
      await Promise.resolve().then(fetchCode).catch(() => {
      });
      if (FAILED.has(outcome?.state)) {
        wait = Math.min(wait * 2, maxMs);
        failure = `Prism could not fetch ${label()}, so this page shows the copy it last synced: ${gitReason(outcome.message)}`;
      } else {
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
export {
  WORKSPACE_FETCH_MAX_MS,
  WORKSPACE_FETCH_MS,
  gitReason,
  watchWorkspace
};
