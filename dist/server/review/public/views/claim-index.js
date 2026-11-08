// Every live and expired claim of the listed initiatives, read from the initiative records the server already returns.
// The sidebar, the command palette, Who's working, and the views read the same index, so a claim shows the same everywhere and never offers an action.

const REFRESH_MS = 10000;

/** Whether a claim's lease has passed at `now`, which a live claim can do while the page stays open. */
export function isExpired(claim, now = Date.now()) {
  const end = Date.parse(claim?.expiresAt);
  return claim?.expired === true || (Number.isFinite(end) && end <= now);
}

/** The claims of one initiative entity's slices: each slice's own live claim, or the claim that lapsed without a release. */
export function claimsOf(entity) {
  const data = entity?.data ?? entity;
  const slices = data?.record?.slices;
  if (!slices || typeof slices !== "object") return [];
  const title = data.roadmapItem?.title ?? data.id;
  const claims = [];
  for (const [slug, slice] of Object.entries(slices)) {
    const claim = slice?.claim ?? slice?.expiredClaim;
    if (!claim || typeof claim.label !== "string") continue;
    claims.push({
      ref: `slice:${data.id}/${slug}`,
      initiative: data.id,
      initiativeTitle: title,
      slug,
      sliceTitle: slice.title ?? slug,
      label: claim.label,
      activity: claim.activity === "design" ? "design" : "implementation",
      claimedAt: claim.claimedAt ?? null,
      renewedAt: claim.renewedAt ?? null,
      expiresAt: claim.expiresAt ?? null,
      expired: !slice.claim
    });
  }
  return claims;
}

/** A read-only prism-claim for a claim in one of its variants. */
export function claimElement(claim, variant = "inline", attributes = {}) {
  const element = document.createElement("prism-claim");
  element.setAttribute("variant", variant);
  element.setAttribute("label", claim.label);
  element.setAttribute("activity", claim.activity);
  for (const [name, value] of Object.entries({ "claimed-at": claim.claimedAt, "renewed-at": claim.renewedAt, "expires-at": claim.expiresAt, ...attributes })) {
    if (value) element.setAttribute(name, value);
  }
  return element;
}

/**
 * Reads the claims of every initiative `initiatives()` lists from `/api/entity?ref=initiative:<id>`, now and every ten seconds,
 * and calls `onChange` when what it holds changes.
 */
export function createClaimIndex({ fetchJson, initiatives, onChange = () => {} }) {
  let claims = [];
  let snapshot = "[]";
  let timer = 0;
  let running = null;

  async function load() {
    const ids = [...new Set(initiatives().map((item) => item.id).filter(Boolean))];
    const read = await Promise.all(ids.map((id) => fetchJson(`./api/entity?ref=${encodeURIComponent(`initiative:${id}`)}`).then(claimsOf).catch(() => null)));
    // An initiative that could not be read keeps the claims it had.
    const next = ids.flatMap((id, index) => read[index] ?? claims.filter((claim) => claim.initiative === id));
    const text = JSON.stringify(next);
    if (text === snapshot) return;
    snapshot = text;
    claims = next;
    onChange();
  }

  function refresh() {
    clearTimeout(timer);
    running ??= load().catch(() => {}).finally(() => {
      running = null;
      timer = setTimeout(refresh, REFRESH_MS);
    });
    return running;
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
