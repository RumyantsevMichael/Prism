// One failed poll can be a restart in progress, so the page reports trouble only after a second one.
export const RETRY_AFTER_FAILURES = 2;
// A handed-off successor binds the same port within seconds, so the page calls the app stopped only after this long without an answer.
export const STOPPED_AFTER_MS = 15 * 1000;

export const STOPPED_MESSAGE = "The review app stopped. See the banner at the top of the page.";

// The tab is live, retrying while the app may still come back, or stopped once it has failed for the whole grace period.
// An open event stream proves the app still runs, so it never reads as stopped.
export function connectionState({ failures, failingSince, now, streamOpen = false }) {
  if (failures < RETRY_AFTER_FAILURES) return "live";
  if (streamOpen || failingSince === null || now - failingSince < STOPPED_AFTER_MS) return "retrying";
  return "stopped";
}

// Counts consecutive failed probes and remembers when the run of failures began; a success clears both.
export function recordProbe(tracker, ok, now) {
  if (ok) return { failures: 0, failingSince: null };
  return { failures: tracker.failures + 1, failingSince: tracker.failingSince ?? now };
}
