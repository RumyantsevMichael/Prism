import { readRecord, listClaimRecords } from "./record-store.mjs";
import { isLive, parseClaim } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";

// A shipped initiative's state is history: these helpers read its shipped decision and the work that keeps an initiative from shipping,
// and name the refusal of a change to a shipped initiative.

/** The refusal of a change to a shipped initiative, with the initiative and its ship time. */
export class ShippedHistoryError extends Error {
  constructor(initiative, shippedAt) {
    super(`Initiative ${initiative} shipped at ${shippedAt}, so its state is history and this change was not applied; start new work as a new initiative that references it.`);
    this.name = "ShippedHistoryError";
    this.code = "initiative_shipped";
    this.initiative = initiative;
    this.shippedAt = shippedAt;
  }
}

/** The ship date of a shipped decision: the first ten characters of its time. */
export const shipDate = (decision) => String(decision.at).slice(0, 10);

/** The shipped decision of a roadmap entry, or null when the entry has none. */
export const entryShippedDecision = (entry) => entry?.decision?.kind === "shipped" && typeof entry.decision.at === "string" ? entry.decision : null;

/**
 * The shipped decision of an initiative read from the roadmap record, or null when the initiative has not shipped,
 * the roadmap has no entry for it, or the record cannot be read.
 * It reads the record directly, so modules that the roadmap module imports can use it.
 */
export async function shippedDecision(projectRoot, initiative) {
  let record;
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
    if (!bytes) return null;
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const entries = Array.isArray(record?.initiatives) ? record.initiatives : [];
  return entryShippedDecision(entries.find((entry) => entry?.id === initiative));
}

async function pendingProposals(projectRoot, initiative, record) {
  if (record === undefined) {
    const { bytes } = await readRecord(projectRoot, { kind: "initiative", initiative });
    record = bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }
  const proposals = record?.proposals;
  return proposals && typeof proposals === "object" && !Array.isArray(proposals) ? Object.keys(proposals).sort() : [];
}

/**
 * The work that keeps an initiative from shipping: { gates, claims, proposals }, where gates lists every pending user gate, answered or not,
 * as { id, slice, question, answered } in state order, claims lists each live claim as { slice, label, activity, expiresAt } in slug order,
 * and proposals lists the scopes with a pending design proposal in slug order.
 * Pass record (the initiative record, or null) or state (a coordination state read) when the caller has already read them.
 */
export async function openWork(projectRoot, initiative, { record, state, now = Date.now() } = {}) {
  const coordination = state === undefined ? await readCoordinationState({ projectRoot, initiative }) : state;
  const pending = Array.isArray(coordination?.state?.pending) ? coordination.state.pending : [];
  const gates = pending
    .filter((gate) => gate && typeof gate === "object" && typeof gate.id === "string")
    .map((gate) => ({ id: gate.id, slice: gate.slice ?? null, question: gate.question ?? null, answered: Boolean(gate.answer) }));
  const claims = [];
  for (const { slice, bytes } of await listClaimRecords(projectRoot, initiative)) {
    const { claim } = parseClaim(slice, bytes);
    if (isLive(claim, now)) claims.push({ slice, label: claim.label, activity: claim.activity, expiresAt: claim.expiresAt });
  }
  claims.sort((left, right) => left.slice < right.slice ? -1 : left.slice > right.slice ? 1 : 0);
  return { gates, claims, proposals: await pendingProposals(projectRoot, initiative, record) };
}

/** Whether open work lists anything. */
export const hasOpenWork = (work) => work.gates.length > 0 || work.claims.length > 0 || work.proposals.length > 0;

/** The refusal message of shipping an initiative with open work, naming each gate id, claimed slice, and proposal scope. */
export function openWorkMessage(initiative, work) {
  const parts = [];
  if (work.gates.length) parts.push(`pending user gates ${work.gates.map((gate) => `${gate.id} (${[gate.slice ? `slice ${gate.slice}` : null, gate.answered ? "answered" : "unanswered"].filter(Boolean).join(", ")})`).join(", ")}`);
  if (work.claims.length) parts.push(`live claims on ${work.claims.map((claim) => `${claim.slice} (${claim.activity} by ${claim.label} until ${claim.expiresAt})`).join(", ")}`);
  if (work.proposals.length) parts.push(`pending design proposals for ${work.proposals.join(", ")}`);
  return `Initiative ${initiative} cannot ship while work is open: ${parts.join("; ")}. Resolve each gate, finish or release each claim, and accept or replace each proposal first, because no agent can finish this work once the initiative is history.`;
}
