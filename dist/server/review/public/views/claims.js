// Generated from src/server/review/public/views/claims.ts by scripts/native-build/compile.mjs.
import { escapeHtml } from "./util.js";
const ACTIVITIES = { design: "design", implementation: "implementation" };
function untilText(value, now = Date.now()) {
  const left = Date.parse(value) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.ceil(left / 6e4);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
function claimOf(slices, slug, now = Date.now()) {
  const own = slices?.[slug]?.claim ?? slices?.[slug]?.expiredClaim;
  if (own) return { claim: own, scope: null };
  for (let owner = slices?.[slug]?.parent ?? null; owner !== null && slices[owner]; owner = slices[owner].parent ?? null) {
    if (slices[owner].claim?.activity === "design" && untilText(slices[owner].claim.expiresAt, now)) return { claim: slices[owner].claim, scope: { slug: owner, title: slices[owner].title } };
  }
  return null;
}
function claimAttributes(claim) {
  return Object.entries({ label: claim.label, host: claim.host, model: claim.model, activity: ACTIVITIES[claim.activity] ?? "implementation", "claimed-at": claim.claimedAt, "renewed-at": claim.renewedAt, "expires-at": claim.expiresAt }).filter(([, value]) => typeof value === "string" && value).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join("");
}
function claimChip(held, variant = "inline") {
  const claim = held?.claim;
  if (!claim || typeof claim.label !== "string") return "";
  const scope = held.scope ? `<span class="claim-scope">via ${escapeHtml(held.scope.title)}</span>` : "";
  return `<span class="claim-held"><prism-claim variant="${escapeHtml(variant)}"${claimAttributes(claim)}></prism-claim>${scope}</span>`;
}
export {
  claimAttributes,
  claimChip,
  claimOf,
  untilText
};
