import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { runGit } from "./record-store-sync.mjs";

// A claim names the host session, or without one the Prism server process, that works on a slice, so no two agents in any checkout or machine that shares the records start one slice.
// Each claim is a record of its own beside the initiative record, covers the slice's descendants, and lapses unless its holder renews it.
// Lease checks use this machine's clock.
export const CLAIM_ACTIVITIES = Object.freeze(["design", "implementation"]);
const CLAIM_FIELDS = ["schemaVersion", "slug", "holder", "label", "activity", "claimedAt", "renewedAt", "expiresAt", "nonce"];
const SETTINGS = { leaseMs: 30 * 60 * 1000, renewMs: 10 * 60 * 1000 };
/**
 * The holder for a host session identifier, or null without one.
 * Claude Code gives its MCP servers the session identifier, so a server it restarts in the same session holds the same claims; the record keeps only a digest of it.
 */
export function sessionHolder(env = process.env) {
  const id = typeof env.CLAUDE_CODE_SESSION_ID === "string" ? env.CLAUDE_CODE_SESSION_ID.trim() : "";
  return id ? `session-${createHash("sha256").update(id).digest("hex").slice(0, 16)}` : null;
}
const identity = { holder: sessionHolder() ?? randomBytes(8).toString("hex"), label: null };
const labels = new Map();
// The claims this process took and still renews, by project root, initiative, and slice, and the ones it lost since a tool last reported them.
const held = new Map();
const lost = new Map();
let timer = null;
let renewing = null;

/** Change the lease, the renewal interval, or this process's holder and label; tests use it to act as several servers. */
export function configureClaims(settings = {}) {
  for (const key of ["leaseMs", "renewMs"]) if (Number.isFinite(settings[key])) SETTINGS[key] = settings[key];
  if (typeof settings.holder === "string") identity.holder = settings.holder;
  if (settings.label !== undefined) identity.label = settings.label;
  if (timer) { clearInterval(timer); timer = null; startTimer(); }
}

/** This server's claim holder identifier: its host session's, or its own process's. */
export const claimHolder = () => identity.holder;

/** Who and where, for people: the Git user name of the folder that holds the records, when set, and the host name without its domain. */
export async function claimLabel(folder) {
  if (identity.label) return identity.label;
  if (!labels.has(folder)) {
    const name = (await runGit(folder, ["config", "user.name"])).text.replace(/\s+/g, " ").trim();
    const host = os.hostname().split(".")[0] || "an unnamed host";
    labels.set(folder, (name ? `${name} on ${host}` : host).slice(0, 200));
  }
  return labels.get(folder);
}

/** Whether a claim is still live at a time in milliseconds of this machine's clock. */
export const isLive = (claim, now = Date.now()) => Boolean(claim) && Date.parse(claim.expiresAt) > now;

/** What a result shows of a claim. */
export const claimView = (claim) => ({ slug: claim.slug, holder: claim.holder, label: claim.label, activity: claim.activity, expiresAt: claim.expiresAt });

/** A claim's stored bytes, with its fields in a fixed order. */
export function serializeClaim(claim) {
  return `${JSON.stringify(Object.fromEntries(CLAIM_FIELDS.map((key) => [key, key === "schemaVersion" ? 1 : claim[key]])), null, 2)}\n`;
}

/** Parse a claim record of a slice: { claim } when it is well formed, otherwise { problem }. */
export function parseClaim(slug, bytes) {
  let claim;
  try { claim = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); }
  catch { return { problem: `${slug}: the claim record must contain valid JSON.` }; }
  const problems = [];
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return { problem: `${slug}: the claim record must be a JSON object.` };
  const extra = Object.keys(claim).filter((key) => !CLAIM_FIELDS.includes(key));
  if (extra.length) problems.push(`unknown fields ${extra.join(", ")}`);
  if (claim.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (claim.slug !== slug) problems.push(`slug must be ${slug}`);
  for (const key of ["holder", "label", "nonce"]) if (typeof claim[key] !== "string" || !claim[key].trim() || claim[key].length > 200) problems.push(`${key} must be a non-empty string of at most 200 characters`);
  for (const key of ["claimedAt", "renewedAt", "expiresAt"]) if (typeof claim[key] !== "string" || !Number.isFinite(Date.parse(claim[key]))) problems.push(`${key} must be a date-time`);
  if (!CLAIM_ACTIVITIES.includes(claim.activity)) problems.push(`activity must be ${CLAIM_ACTIVITIES.join(" or ")}`);
  return problems.length ? { problem: `${slug}: the claim record is invalid: ${problems.join("; ")}.` } : { claim };
}

/** A claim taken now with a fresh nonce; a holder that takes its own live claim again for the same activity keeps when it was first claimed. */
export function newClaim(previous, { slug, holder, label, activity, now }) {
  const at = new Date(now).toISOString();
  const kept = previous?.holder === holder && previous.activity === activity && isLive(previous, now);
  return { schemaVersion: 1, slug, holder, label, activity, claimedAt: kept ? previous.claimedAt : at, renewedAt: at, expiresAt: new Date(now + SETTINGS.leaseMs).toISOString(), nonce: randomBytes(12).toString("hex") };
}

/** A live claim with its lease extended from now. */
export const renewedClaim = (claim, now) => ({ ...claim, renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + SETTINGS.leaseMs).toISOString() });

const ancestors = (slices, slug) => {
  const found = [];
  for (let current = slices[slug]?.parent, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) found.push(current);
  return found;
};

/**
 * Another holder's live claim on the slice, an ancestor, or a descendant, or null.
 * A claim on a slice covers its descendants, so one holder's claim on a scope blocks another's on any slice inside it, and the reverse.
 */
export function blockingClaim(slices, claims, slug, holder, now = Date.now()) {
  const related = [slug, ...ancestors(slices, slug), ...Object.keys(slices).filter((key) => key !== slug && ancestors(slices, key).includes(slug)).sort()];
  for (const key of related) {
    const claim = claims.get(key);
    if (claim && claim.holder !== holder && isLive(claim, now)) return claim;
  }
  return null;
}

/** The refusal message for a slice that another holder's live claim covers. */
export function claimedMessage(slug, claim) {
  const through = claim.slug === slug ? "" : ` through its claim on ${claim.slug}`;
  return `The slice ${slug} is claimed by ${claim.label} for ${claim.activity}${through} until ${claim.expiresAt}, so this update was not applied. Work on another slice; the claim ends when its holder finishes or stops renewing it, or when a person releases it with release_claim.`;
}

function startTimer() {
  if (timer || !held.size) return;
  timer = setInterval(() => { void renewHeldClaims(); }, SETTINGS.renewMs);
  // Renewal never keeps a server process alive on its own.
  timer.unref();
}

const heldKey = (root, initiative, slug) => `${root}\0${initiative}\0${slug}`;

/** Renew a claim this process took, identified by its nonce, for as long as the process runs. */
export function holdClaim(root, initiative, claim) {
  held.set(heldKey(root, initiative, claim.slug), { root, initiative, slug: claim.slug, holder: claim.holder, nonce: claim.nonce });
  startTimer();
}

/**
 * Renew the live claims of this server's holder that it does not renew yet, which an earlier server of the same host session took before the host restarted it.
 * Only a server that reports claims to an agent calls this, so a process that merely reads records, such as the review app, never renews a session's claims.
 */
export function adoptClaims(root, initiative, claims, now = Date.now()) {
  for (const claim of claims.values()) {
    if (claim.holder === identity.holder && isLive(claim, now) && !held.has(heldKey(root, initiative, claim.slug))) holdClaim(root, initiative, claim);
  }
}

/**
 * Accept an attempt's new nonce for a claim this process already holds while the attempt is confirmed, so neither a renewal nor a read takes the attempt for a lost claim.
 * The held nonce stays until the attempt is confirmed, so an undone attempt leaves the earlier claim renewed as before.
 */
export function pendClaim(root, initiative, slug, nonce) {
  const entry = held.get(heldKey(root, initiative, slug));
  if (entry) entry.pending = nonce;
}

/** Forget an attempt's pending nonce after the attempt was undone. */
export function settleClaim(root, initiative, slug, nonce) {
  const entry = held.get(heldKey(root, initiative, slug));
  if (entry?.pending === nonce) delete entry.pending;
}

/** Stop renewing a claim that ended. */
export function dropClaim(root, initiative, slug) {
  held.delete(heldKey(root, initiative, slug));
  if (!held.size && timer) { clearInterval(timer); timer = null; }
}

/** The claims this process renews, for tests and diagnostics. */
export const heldClaims = () => [...held.values()].map((entry) => ({ ...entry }));

/** Why a held claim is no longer this process's, or null while it still is. */
function lossOf(entry, claim, now) {
  if (!claim) return "released";
  if (claim.holder !== entry.holder || (claim.nonce !== entry.nonce && claim.nonce !== entry.pending)) return `replaced by ${claim.label}`;
  if (!isLive(claim, now)) return "expired";
  return null;
}

/**
 * Compare the claims this process holds on an initiative with its claim records, and stop holding each one that was released, replaced, or expired.
 * Returns the lost claims, with those the renewal found earlier, so the next tool result for the initiative reports each once.
 */
export function takeLostClaims(root, initiative, claims, now = Date.now()) {
  for (const entry of [...held.values()].filter((item) => item.root === root && item.initiative === initiative)) {
    const reason = lossOf(entry, claims.get(entry.slug), now);
    if (reason) markLost(entry, reason);
  }
  const key = `${root}\0${initiative}`;
  const found = lost.get(key) ?? [];
  lost.delete(key);
  return found;
}

function markLost(entry, reason) {
  dropClaim(entry.root, entry.initiative, entry.slug);
  const key = `${entry.root}\0${entry.initiative}`;
  if (!lost.has(key)) lost.set(key, []);
  lost.get(key).push({ slug: entry.slug, reason });
}

/**
 * Renew every claim this process holds by rewriting only its claim record, while the claim is live and still carries this process's nonce.
 * An expired, released, or replaced claim is never revived; it is reported as lost on the next tool result for its initiative.
 */
export function renewHeldClaims() {
  if (renewing) return renewing;
  renewing = (async () => {
    const { renewClaim } = await import("./initiative.mjs");
    for (const entry of [...held.values()]) {
      let outcome;
      try { outcome = await renewClaim(entry); }
      catch { continue; }
      if (outcome.lost && held.get(heldKey(entry.root, entry.initiative, entry.slug))?.nonce === entry.nonce) markLost(entry, outcome.lost);
    }
  })().finally(() => { renewing = null; });
  return renewing;
}

/** Decide a renewal: the renewed claim, or why the held claim is lost. */
export function renewal(entry, claim, now = Date.now()) {
  const reason = lossOf(entry, claim, now);
  return reason ? { lost: reason } : { claim: renewedClaim(claim, now) };
}

/** Stop renewing every claim, so a process or a test can finish; the claims lapse when their lease runs out. */
export function stopClaimRenewals() {
  if (timer) clearInterval(timer);
  timer = null;
  held.clear();
  lost.clear();
}
