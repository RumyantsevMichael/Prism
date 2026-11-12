import { createPoller } from "./poller.js";

// Every live and expired claim of the project's initiatives, as the server reads them from the initiative records.
// The sidebar, the command palette, Who's working, and the views read the same index, so a claim shows the same everywhere and never offers an action.

const REFRESH_MS = 10000;

/** Whether a claim's lease has passed at `now`, which a live claim can do while the page stays open. */
export function isExpired(claim, now = Date.now()) {
  const end = Date.parse(claim?.expiresAt);
  return claim?.expired === true || (Number.isFinite(end) && end <= now);
}

/** A read-only prism-claim for a claim in one of its variants. */
export function claimElement(claim, variant = "inline", attributes = {}) {
  const element = document.createElement("prism-claim");
  element.setAttribute("variant", variant);
  element.setAttribute("label", claim.label);
  element.setAttribute("activity", claim.activity);
  for (const [name, value] of Object.entries({ host: claim.host, "claimed-at": claim.claimedAt, "renewed-at": claim.renewedAt, "expires-at": claim.expiresAt, ...attributes })) {
    if (value) element.setAttribute(name, value);
  }
  return element;
}

/**
 * Reads the claims of every initiative from `/api/claims` in one request, now and ten seconds after each answer while the tab is shown,
 * and calls `onChange` when what it holds changes; a failed read keeps the claims it had.
 */
export function createClaimIndex({ fetchJson, onChange = () => {} }) {
  let claims = [];
  let snapshot = "[]";

  async function load() {
    const next = (await fetchJson("./api/claims")).claims ?? [];
    const text = JSON.stringify(next);
    if (text === snapshot) return;
    snapshot = text;
    claims = next;
    onChange();
  }

  const poller = createPoller({ run: () => load().catch(() => {}), interval: REFRESH_MS });
  let started = false;
  function refresh() {
    if (started) return poller.now();
    started = true;
    return poller.start();
  }

  const ordered = (list) => [...list].sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  return {
    refresh,
    /** The claim on a slice, live or expired, or null. */
    claimFor: (ref) => claims.find((claim) => claim.ref === ref) ?? null,
    /** Live claims, the one that lapses first first. */
    live: (now = Date.now()) => ordered(claims.filter((claim) => !isExpired(claim, now))),
    /** Expired claims, the most recently lapsed first. */
    expired: (now = Date.now()) => ordered(claims.filter((claim) => isExpired(claim, now))).reverse()
  };
}
