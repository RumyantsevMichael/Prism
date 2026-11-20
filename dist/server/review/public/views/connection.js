// Generated from src/server/review/public/views/connection.ts by scripts/native-build/compile.mjs.
const RETRY_AFTER_FAILURES = 2;
const STOPPED_AFTER_MS = 15 * 1e3;
const STOPPED_MESSAGE = "The review app stopped. See the banner at the top of the page.";
function connectionState({ failures, failingSince, now, streamOpen = false }) {
  if (failures < RETRY_AFTER_FAILURES) return "live";
  if (streamOpen || failingSince === null || now - failingSince < STOPPED_AFTER_MS) return "retrying";
  return "stopped";
}
function recordProbe(tracker, ok, now) {
  if (ok) return { failures: 0, failingSince: null };
  return { failures: tracker.failures + 1, failingSince: tracker.failingSince ?? now };
}
export {
  RETRY_AFTER_FAILURES,
  STOPPED_AFTER_MS,
  STOPPED_MESSAGE,
  connectionState,
  recordProbe
};
