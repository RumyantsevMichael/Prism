import { escapeHtml, formatTime } from "./util.js";

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

/**
 * A read-only chip for a slice's claim: holder label, activity, and time left.
 * A claim past its expiry shows as expired: the review model keeps a lapsed claim as expiredClaim, and a live one can lapse while the page is open.
 */
export function claimChip(held, now = Date.now()) {
  const claim = held?.claim;
  if (!claim || typeof claim.label !== "string") return "";
  const activity = ACTIVITIES[claim.activity] ?? String(claim.activity ?? "work");
  const left = untilText(claim.expiresAt, now);
  const scope = held.scope ? ` on ${held.scope.title}` : "";
  const title = left
    ? `Claimed by ${claim.label} for ${activity}${scope} since ${formatTime(claim.claimedAt)}; expires ${formatTime(claim.expiresAt)} unless renewed.`
    : `The claim by ${claim.label} for ${activity}${scope} expired ${formatTime(claim.expiresAt)}.`;
  const meta = `${activity}${held.scope ? ` via ${held.scope.title}` : ""} · ${left ? `${left} left` : "expired"}`;
  return `<span class="claim-chip activity-${escapeHtml(activity)}${left ? "" : " is-expired"}" title="${escapeHtml(title)}"><span class="claim-mark" aria-hidden="true"></span><span class="claim-text">${escapeHtml(claim.label)}</span><span class="claim-meta">${escapeHtml(meta)}</span></span>`;
}
