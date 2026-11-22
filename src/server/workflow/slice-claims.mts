import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { runGit } from "./record-store-sync.mjs";
import { hostLabel } from "../review/workspace-identity.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { validUntil } from "./view-validity.mjs";
import { isAgentModel } from "../session/agent-models.mjs";
import { environmentSessionLink, isSessionLink, type SessionLink } from "../session/session-links.mjs";

// A claim names the host session, or without one the Prism server process, that works on a slice, so no two agents in any checkout or machine that shares the records start one slice.
// Each claim is a record of its own beside the initiative record, covers the slice's descendants, and lapses unless its holder renews it.
// Lease checks use this machine's clock.
export const CLAIM_ACTIVITIES: readonly string[] = Object.freeze(["design", "implementation"]);

export type Claim = { schemaVersion: 1; slug: string; holder: string; label: string; host?: string; model?: string; session?: SessionLink; activity: string; claimedAt: string; renewedAt: string; expiresAt: string; nonce: string };
type HeldClaim = { root: string; initiative: string; slug: string; holder: string; nonce: string; main: boolean; pending?: string };
type Settings = { leaseMs?: number; renewMs?: number; holder?: string; label?: string | null; host?: string | null; session?: SessionLink | null };
// host is optional: the name of the harness the holder runs in, such as Claude Code or Codex, shown to people and never used to decide anything.
// model is optional too: the model of the session's main agent, recorded only for a claim that a call positively attributed to that agent took.
// Prism reads it before any release writes it, because releases up to 0.20 refuse a claim with a field they do not know; later releases leave such a field out instead.
// session is optional as well: the host session a person can open from a link, such as a Claude Code on the web session, recorded only for a claim the server's own host session holds.
const CLAIM_FIELDS = ["schemaVersion", "slug", "holder", "label", "host", "model", "session", "activity", "claimedAt", "renewedAt", "expiresAt", "nonce"];
const HOST_LIMIT = 64;
// PRISM_CLAIM_RENEW_MS, a whole number of milliseconds from 10 to 600000, sets the renewal interval for tests.
const renewFromEnv = (value: string | undefined) => /^\d+$/.test(String(value ?? "").trim()) && Number(value) >= 10 && Number(value) <= 600000 ? Number(value) : null;
const SETTINGS: { leaseMs: number; renewMs: number } = { leaseMs: 30 * 60 * 1000, renewMs: renewFromEnv(process.env.PRISM_CLAIM_RENEW_MS) ?? 10 * 60 * 1000 };
/**
 * The holder for a host session identifier, or null without one.
 * Claude Code gives its MCP servers the session identifier, so a server it restarts in the same session holds the same claims; the record keeps only a digest of it.
 */
export function sessionHolder(env = process.env) {
  return digestHolder(env.CLAUDE_CODE_SESSION_ID);
}
const digestHolder = (value: unknown) => {
  const id = typeof value === "string" ? value.trim() : "";
  return id ? `session-${createHash("sha256").update(id).digest("hex").slice(0, 16)}` : null;
};
const identity: { holder: string; label: string | null; host: string | null; session: SessionLink | null } = { holder: sessionHolder() ?? randomBytes(8).toString("hex"), label: null, host: null, session: environmentSessionLink() };

/** The holder for one host session identifier, such as Codex's root session id, or null without one. */
export const holderOf = (sessionId: string) => digestHolder(sessionId);

/**
 * The harness an MCP client names in its initialize clientInfo: its title when non-blank, else its name, with whitespace runs made one space, trimmed, and cut to 64 characters; null without either.
 */
export function harnessName(clientInfo: any) {
  for (const value of [clientInfo?.title, clientInfo?.name]) {
    const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, HOST_LIMIT).trim() : "";
    if (name) return name;
  }
  return null;
}

// Whether the current tool call is positively the session's main agent's, so a claim it takes records the main agent's model.
const agentCall = new AsyncLocalStorage<{ main: boolean }>();
/** Run one tool call knowing whether it is positively the session's main agent's. */
export const withClaimAgent = <T,>(main: unknown, run: () => T) => agentCall.run({ main: main === true }, run);
export const callIsMainAgent = () => agentCall.getStore()?.main === true;
/** The harness this server's client named, or null. */
export const claimHost = () => identity.host;
// Codex names its root session, which its sub-agents share, in each tool call's metadata rather than in the server's environment.
const callSession = new AsyncLocalStorage<string>();

/**
 * The host session a tool call's metadata names, or null: Codex sends it as sessionId, and releases before that field name it only in x-codex-turn-metadata as session_id.
 * Both give a sub-agent its root session, while threadId names the sub-agent's own thread, so it is never used.
 */
export function callSessionId(metadata: any) {
  for (const value of [metadata?.sessionId, metadata?.["x-codex-turn-metadata"]?.session_id]) if (typeof value === "string" && value.trim()) return value;
  return null;
}

/** Run one tool call as the host session its metadata names, so the claims it takes and renews belong to that session; without one, the server's own holder stays. */
export function withCallSession<T>(metadata: any, run: () => T) {
  const holder = digestHolder(callSessionId(metadata));
  return holder ? callSession.run(holder, run) : run();
}
const labels = new Map<string, string>();
// The claims this process took and still renews, by project root, initiative, and slice, and the ones it lost since a tool last reported them.
const held = new Map<string, HeldClaim>();
const lost = new Map<string, { slug: string; reason: string }[]>();
let timer: NodeJS.Timeout | null = null;
let renewing: Promise<void> | null = null;

/** Change the lease, the renewal interval, or this process's holder and label; tests use it to act as several servers. */
export function configureClaims(settings: Settings = {}) {
  for (const key of ["leaseMs", "renewMs"] as const) if (Number.isFinite(settings[key])) SETTINGS[key] = settings[key]!;
  if (typeof settings.holder === "string") identity.holder = settings.holder;
  if (settings.label !== undefined) identity.label = settings.label;
  if (settings.host !== undefined) identity.host = settings.host;
  if (settings.session !== undefined) identity.session = settings.session;
  if (timer) { clearInterval(timer); timer = null; startTimer(); }
}

/** The claim holder of the current tool call: the session its metadata names, else the server's host session, else the server process. */
export const claimHolder = () => callSession.getStore() ?? identity.holder;

/**
 * The openable session of the current tool call's holder, or null.
 * The server's environment describes only its own host session, so a call whose metadata names another session, as a Codex call does, gets none.
 */
export const claimSession = () => (callSession.getStore() === undefined ? identity.session : null);

/** Who and where, for people: the Git user name of the folder that holds the records, when set, and the host name without its domain. */
export async function claimLabel(folder: string) {
  if (identity.label) return identity.label;
  if (!labels.has(folder)) {
    const name = (await runGit(folder, ["config", "user.name"])).text.replace(/\s+/g, " ").trim();
    const host = hostLabel();
    labels.set(folder, (name ? `${name} on ${host}` : host).slice(0, 200));
  }
  return labels.get(folder)!;
}

/** Whether a claim is still live at a time in milliseconds of this machine's clock; a view that finds it live holds only until it expires. */
export const isLive = <C extends Pick<Claim, "expiresAt">>(claim: C | null | undefined, now = Date.now()): claim is C => {
  if (!claim) return false;
  const expires = Date.parse(claim.expiresAt);
  if (!(expires > now)) return false;
  validUntil(expires);
  return true;
};

/** What a result shows of a claim. */
export const claimView = (claim: Claim) => ({ slug: claim.slug, holder: claim.holder, label: claim.label, ...(claim.host ? { host: claim.host } : {}), ...(claim.model ? { model: claim.model } : {}), activity: claim.activity, expiresAt: claim.expiresAt });

/** A claim's stored bytes, with its fields in a fixed order. */
export function serializeClaim(claim: Record<string, unknown>) {
  return `${JSON.stringify(Object.fromEntries(CLAIM_FIELDS.map((key) => [key, key === "schemaVersion" ? 1 : claim[key]])), null, 2)}\n`;
}

/** Parse a claim record of a slice: { claim } when it is well formed, otherwise { problem }. */
export function parseClaim(slug: string, bytes: Buffer | string): { claim: Claim; problem?: undefined } | { problem: string; claim?: undefined } {
  let claim: any;
  try { claim = parseStoreJson(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); }
  catch { return { problem: `${slug}: the claim record must contain valid JSON.` }; }
  const problems: string[] = [];
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return { problem: `${slug}: the claim record must be a JSON object.` };
  // A field this release does not know, which a later release may add, is left out rather than refused, so a new field never hides a claim from an older release.
  if (claim.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (claim.slug !== slug) problems.push(`slug must be ${slug}`);
  if (claim.host !== undefined && (typeof claim.host !== "string" || !claim.host.trim() || claim.host.length > HOST_LIMIT)) problems.push(`host must be a non-empty string of at most ${HOST_LIMIT} characters when present`);
  for (const key of ["holder", "label", "nonce"]) if (typeof claim[key] !== "string" || !claim[key].trim() || claim[key].length > 200) problems.push(`${key} must be a non-empty string of at most 200 characters`);
  for (const key of ["claimedAt", "renewedAt", "expiresAt"]) if (typeof claim[key] !== "string" || !Number.isFinite(Date.parse(claim[key]))) problems.push(`${key} must be a date-time`);
  if (!CLAIM_ACTIVITIES.includes(claim.activity)) problems.push(`activity must be ${CLAIM_ACTIVITIES.join(" or ")}`);
  if (problems.length) return { problem: `${slug}: the claim record is invalid: ${problems.join("; ")}.` };
  // A malformed model or session reads as the same claim without one, so it never refuses or hides the claim.
  const kept = (key: string) => Object.hasOwn(claim, key) && (key !== "model" || isAgentModel(claim.model)) && (key !== "session" || isSessionLink(claim.session));
  return { claim: Object.fromEntries(CLAIM_FIELDS.filter(kept).map((key) => [key, key === "session" ? { kind: claim.session.kind, id: claim.session.id } : claim[key]])) as Claim };
}

/** A claim taken now with a fresh nonce; a holder that takes its own live claim again for the same activity keeps when it was first claimed. */
export function newClaim(previous: Claim | null | undefined, { slug, holder, label, host = null, model = null, session = null, activity, now }: { slug: string; holder: string; label: string; host?: string | null; model?: string | null; session?: SessionLink | null; activity: string; now: number }): Claim {
  const at = new Date(now).toISOString();
  const kept = previous?.holder === holder && previous.activity === activity && isLive(previous, now);
  return { schemaVersion: 1, slug, holder, label, ...(host ? { host } : {}), ...(isAgentModel(model) ? { model } : {}), ...(isSessionLink(session) ? { session: { kind: session.kind, id: session.id } } : {}), activity, claimedAt: kept ? previous.claimedAt : at, renewedAt: at, expiresAt: new Date(now + SETTINGS.leaseMs).toISOString(), nonce: randomBytes(12).toString("hex") };
}

/** A live claim with its lease extended from now. */
export const renewedClaim = (claim: Claim, now: number): Claim => ({ ...claim, renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + SETTINGS.leaseMs).toISOString() });

const ancestors = (slices: Record<string, any>, slug: string) => {
  const found: string[] = [];
  for (let current = slices[slug]?.parent, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) found.push(current);
  return found;
};

/**
 * Another holder's live claim on the slice, an ancestor, or a descendant, or null.
 * A claim on a slice covers its descendants, so one holder's claim on a scope blocks another's on any slice inside it, and the reverse.
 */
export function blockingClaim(slices: Record<string, any>, claims: Map<string, Claim>, slug: string, holder: string, now = Date.now()) {
  const related = [slug, ...ancestors(slices, slug), ...Object.keys(slices).filter((key) => key !== slug && ancestors(slices, key).includes(slug)).sort()];
  for (const key of related) {
    const claim = claims.get(key);
    if (claim && claim.holder !== holder && isLive(claim, now)) return claim;
  }
  return null;
}

/** The refusal message for a slice that another holder's live claim covers. */
export function claimedMessage(slug: string, claim: Claim) {
  const through = claim.slug === slug ? "" : ` through its claim on ${claim.slug}`;
  return `The slice ${slug} is claimed by ${claim.label} for ${claim.activity}${through} until ${claim.expiresAt}, so this update was not applied. Work on another slice; the claim ends when its holder finishes or stops renewing it, or when a person releases it with release_claim.`;
}

function startTimer() {
  if (timer || !held.size) return;
  timer = setInterval(() => { void renewHeldClaims(); }, SETTINGS.renewMs);
  // Renewal never keeps a server process alive on its own.
  timer!.unref();
}

const heldKey = (root: string, initiative: string, slug: string) => `${root}\0${initiative}\0${slug}`;

/**
 * Renew a claim this process took, identified by its nonce, for as long as the process runs.
 * main records whether a main agent's call took or adopted it, so only its renewals rewrite the model.
 */
export function holdClaim(root: string, initiative: string, claim: Claim, { main = callIsMainAgent() } = {}) {
  held.set(heldKey(root, initiative, claim.slug), { root, initiative, slug: claim.slug, holder: claim.holder, nonce: claim.nonce, main });
  startTimer();
}

/**
 * Renew the live claims of the calling session that it does not renew yet, which an earlier server of the same host session took before the host restarted it.
 * Only a server that reports claims to an agent calls this, so a process that merely reads records, such as the review app, never renews a session's claims.
 */
export function adoptClaims(root: string, initiative: string, claims: Map<string, Claim>, now = Date.now()) {
  for (const claim of claims.values()) {
    if (claim.holder === claimHolder() && isLive(claim, now) && !held.has(heldKey(root, initiative, claim.slug))) holdClaim(root, initiative, claim);
  }
}

/**
 * Accept an attempt's new nonce for a claim this process already holds while the attempt is confirmed, so neither a renewal nor a read takes the attempt for a lost claim.
 * The held nonce stays until the attempt is confirmed, so an undone attempt leaves the earlier claim renewed as before.
 */
export function pendClaim(root: string, initiative: string, slug: string, nonce: string) {
  const entry = held.get(heldKey(root, initiative, slug));
  if (entry) entry.pending = nonce;
}

/** Forget an attempt's pending nonce after the attempt was undone. */
export function settleClaim(root: string, initiative: string, slug: string, nonce: string) {
  const entry = held.get(heldKey(root, initiative, slug));
  if (entry?.pending === nonce) delete entry.pending;
}

/** Stop renewing a claim that ended. */
export function dropClaim(root: string, initiative: string, slug: string) {
  held.delete(heldKey(root, initiative, slug));
  if (!held.size && timer) { clearInterval(timer); timer = null; }
}

/** The claims this process renews, for tests and diagnostics. */
export const heldClaims = () => [...held.values()].map((entry) => ({ ...entry }));

/** Why a held claim is no longer this process's, or null while it still is. */
function lossOf(entry: HeldClaim, claim: Claim | null | undefined, now: number) {
  if (!claim) return "released";
  if (claim.holder !== entry.holder || (claim.nonce !== entry.nonce && claim.nonce !== entry.pending)) return `replaced by ${claim.label}`;
  if (!isLive(claim, now)) return "expired";
  return null;
}

/**
 * Compare the claims this process holds on an initiative with its claim records, and stop holding each one that was released, replaced, or expired.
 * Returns the lost claims, with those the renewal found earlier, so the next tool result for the initiative reports each once.
 */
export function takeLostClaims(root: string, initiative: string, claims: Map<string, Claim>, now = Date.now()) {
  for (const entry of [...held.values()].filter((item) => item.root === root && item.initiative === initiative)) {
    const reason = lossOf(entry, claims.get(entry.slug), now);
    if (reason) markLost(entry, reason);
  }
  const key = `${root}\0${initiative}`;
  const found = lost.get(key) ?? [];
  lost.delete(key);
  return found;
}

function markLost(entry: HeldClaim, reason: string) {
  dropClaim(entry.root, entry.initiative, entry.slug);
  const key = `${entry.root}\0${entry.initiative}`;
  if (!lost.has(key)) lost.set(key, []);
  lost.get(key)!.push({ slug: entry.slug, reason });
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
      let outcome: any;
      try { outcome = await renewClaim(entry); }
      catch { continue; }
      if (outcome.lost && held.get(heldKey(entry.root, entry.initiative, entry.slug))?.nonce === entry.nonce) markLost(entry, outcome.lost);
    }
  })().finally(() => { renewing = null; });
  return renewing;
}

/**
 * Decide a renewal: the renewed claim, or why the held claim is lost.
 * A claim a main agent's call took takes the session's model as it is now, and loses it without one; any other claim never carries a model.
 */
export function renewal(entry: HeldClaim, claim: Claim | null | undefined, now = Date.now(), model: string | null = null) {
  const reason = lossOf(entry, claim, now);
  if (reason) return { lost: reason };
  const { model: _previous, ...rest } = renewedClaim(claim!, now);
  return { claim: entry.main && isAgentModel(model) ? { ...rest, model } : rest };
}

/** Stop renewing every claim, so a process or a test can finish; the claims lapse when their lease runs out. */
export function stopClaimRenewals() {
  if (timer) clearInterval(timer);
  timer = null;
  held.clear();
  lost.clear();
}
