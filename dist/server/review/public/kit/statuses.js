// Generated from src/server/review/public/kit/statuses.ts by scripts/native-build/compile.mjs.
const STATUS_CLASSES = Object.freeze({
  idle: Object.freeze({ label: "Not started", meaning: "Nothing has started yet." }),
  ready: Object.freeze({ label: "Planned", meaning: "Decided and queued; nobody works on it yet." }),
  active: Object.freeze({ label: "In progress", meaning: "Someone, a person or an agent, works on it now." }),
  waiting: Object.freeze({ label: "Waits on a person", meaning: "It cannot move until a person decides, reviews, or checks it." }),
  problem: Object.freeze({ label: "Problem", meaning: "It is blocked, failed, or regressed." }),
  done: Object.freeze({ label: "Done", meaning: "Finished and accepted." }),
  retired: Object.freeze({ label: "Retired", meaning: "No longer pursued: replaced, deferred, or parked." })
});
const STATUSES = Object.freeze({
  // Initiatives and work items on the roadmap: an emerging item is still being shaped, and killed, merged, and split items left the bands.
  emerging: ["idle", "Emerging"],
  envisioned: ["idle", "Envisioned"],
  unlisted: ["idle", "Not on the roadmap"],
  planned: ["ready", "Planned"],
  "in-progress": ["active", "In progress"],
  shipped: ["done", "Shipped"],
  superseded: ["retired", "Superseded"],
  killed: ["retired", "Killed"],
  merged: ["retired", "Merged"],
  // Slices.
  "not-started": ["idle", "Not started"],
  "design-review": ["waiting", "Design review"],
  blocked: ["problem", "Blocked"],
  deferred: ["retired", "Deferred"],
  split: ["retired", "Split"],
  done: ["done", "Done"],
  // Requirements, decisions, and the glossary.
  draft: ["waiting", "Draft"],
  proposed: ["waiting", "Proposed"],
  approved: ["done", "Approved"],
  accepted: ["done", "Accepted"],
  defined: ["done", "Defined"],
  rejected: ["problem", "Rejected"],
  deprecated: ["retired", "Deprecated"],
  withdrawn: ["retired", "Withdrawn"],
  declined: ["retired", "Declined"],
  // Review findings and reviewers.
  open: ["idle", "Open"],
  reopened: ["problem", "Reopened"],
  fixed: ["waiting", "Fixed"],
  verified: ["done", "Verified"],
  pending: ["idle", "Pending"],
  clean: ["done", "Clean"],
  passed: ["done", "Passed"],
  pass: ["done", "Passed"],
  findings: ["waiting", "Findings"],
  failed: ["problem", "Failed"],
  fail: ["problem", "Failed"]
});
function statusKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}
function statusOf(value) {
  const key = statusKey(value);
  const known = Object.hasOwn(STATUSES, key) ? STATUSES[key] : null;
  const text = String(value ?? "").trim();
  return known ? { key, cls: known[0], label: known[1], known: true } : { key, cls: "idle", label: text ? text.charAt(0).toUpperCase() + text.slice(1) : "No status", known: false };
}
export {
  STATUSES,
  STATUS_CLASSES,
  statusKey,
  statusOf
};
