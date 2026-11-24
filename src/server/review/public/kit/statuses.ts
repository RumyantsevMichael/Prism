// The review app's one status registry: every status word a Prism record uses belongs to one of seven classes,
// and a class owns one color and one glyph, so a status looks the same on every screen that shows it.
// Severity, phase, and system states such as the index or the store's sync are other axes and do not read it.

/** The seven classes, in lifecycle order, each with the word it shows when a value has no label of its own and what it means. */
export const STATUS_CLASSES = Object.freeze({
  idle: Object.freeze({ label: "Not started", meaning: "Nothing has started yet." }),
  ready: Object.freeze({ label: "Planned", meaning: "Decided and queued; nobody works on it yet." }),
  active: Object.freeze({ label: "In progress", meaning: "Someone, a person or an agent, works on it now." }),
  waiting: Object.freeze({ label: "Waits on a person", meaning: "It cannot move until a person decides, reviews, or checks it." }),
  problem: Object.freeze({ label: "Problem", meaning: "It is blocked, failed, or regressed." }),
  done: Object.freeze({ label: "Done", meaning: "Finished and accepted." }),
  retired: Object.freeze({ label: "Retired", meaning: "No longer pursued: replaced, deferred, or parked." })
});

/** Each status word, lowercased with spaces as hyphens, and its class and label. */
export const STATUSES: Readonly<Record<string, any>> = Object.freeze({
  // Initiatives on the roadmap.
  envisioned: ["idle", "Envisioned"],
  unlisted: ["idle", "Not on the roadmap"],
  planned: ["ready", "Planned"],
  "in-progress": ["active", "In progress"],
  shipped: ["done", "Shipped"],
  superseded: ["retired", "Superseded"],
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

/** The registry key of a status word: lowercased, with runs of spaces or underscores as one hyphen. */
export function statusKey(value: any) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** The class and label of a status word; a word the registry does not know is idle and shows as written. */
export function statusOf(value: any) {
  const key = statusKey(value);
  const known = Object.hasOwn(STATUSES, key) ? STATUSES[key] : null;
  const text = String(value ?? "").trim();
  return known ? { key, cls: known[0], label: known[1], known: true } : { key, cls: "idle", label: text ? text.charAt(0).toUpperCase() + text.slice(1) : "No status", known: false };
}
