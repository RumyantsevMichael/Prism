// Generated from src/server/review/public/views/claim-index.ts by scripts/native-build/compile.mjs.
import { createPoller } from "./poller.js";
const REFRESH_MS = 1e4;
function isExpired(claim, now = Date.now()) {
  const end = Date.parse(claim?.expiresAt);
  return claim?.expired === true || Number.isFinite(end) && end <= now;
}
function claimElement(claim, variant = "inline", attributes = {}) {
  const element = document.createElement("prism-claim");
  element.setAttribute("variant", variant);
  element.setAttribute("label", claim.label);
  element.setAttribute("activity", claim.activity);
  for (const [name, value] of Object.entries({ host: claim.host, model: claim.model, "claimed-at": claim.claimedAt, "renewed-at": claim.renewedAt, "expires-at": claim.expiresAt, ...attributes })) {
    if (value) element.setAttribute(name, value);
  }
  return element;
}
function createClaimIndex({ fetchJson, onChange = () => {
} }) {
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
  const poller = createPoller({ run: () => load().catch(() => {
  }), interval: REFRESH_MS });
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
export {
  claimElement,
  createClaimIndex,
  isExpired
};
