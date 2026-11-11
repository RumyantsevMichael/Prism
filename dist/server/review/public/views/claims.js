import { escapeHtml } from "./util.js";

const ACTIVITIES = { design: "design", implementation: "implementation" };

// How long until a claim expires, in words, or null once it has.
export function untilText(value, now = Date.now()) {
  const left = Date.parse(value) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.ceil(left / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** The claim that holds a slice in a record's slices: its own, or a design claim on an ancestor scope: { claim, scope } or null. */
export function claimOf(slices, slug, now = Date.now()) {
  const own = slices?.[slug]?.claim ?? slices?.[slug]?.expiredClaim;
  if (own) return { claim: own, scope: null };
  for (let owner = slices?.[slug]?.parent ?? null; owner !== null && slices[owner]; owner = slices[owner].parent ?? null) {
    if (slices[owner].claim?.activity === "design" && untilText(slices[owner].claim.expiresAt, now)) return { claim: slices[owner].claim, scope: { slug: owner, title: slices[owner].title } };
  }
  return null;
}

/** The attributes of a prism-claim for a claim, which the element turns into the holder, the activity, and the time left. */
export function claimAttributes(claim) {
  return Object.entries({ label: claim.label, host: claim.host, activity: ACTIVITIES[claim.activity] ?? "implementation", "claimed-at": claim.claimedAt, "renewed-at": claim.renewedAt, "expires-at": claim.expiresAt })
    .filter(([, value]) => typeof value === "string" && value)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join("");
}

/**
 * A read-only prism-claim for a slice's claim in a variant: avatar, inline, or strip, with the scope whose design claim covers the slice.
 * A claim past its expiry shows as expired: the review model keeps a lapsed claim as expiredClaim, and the element follows the clock while the page is open.
 */
export function claimChip(held, variant = "inline") {
  const claim = held?.claim;
  if (!claim || typeof claim.label !== "string") return "";
  const scope = held.scope ? `<span class="claim-scope">via ${escapeHtml(held.scope.title)}</span>` : "";
  return `<span class="claim-held"><prism-claim variant="${escapeHtml(variant)}"${claimAttributes(claim)}></prism-claim>${scope}</span>`;
}
