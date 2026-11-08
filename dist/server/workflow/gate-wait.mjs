import { randomBytes } from "node:crypto";
import { readCoordinationState } from "./state.mjs";
import { endGateWait, gateWaitStep, personChangesText } from "./change-notices.mjs";

export const DEFAULT_WAIT_MINUTES = 720;
export const MAX_WAIT_MINUTES = 1440;
export const MAX_WAIT_GATES = 10;
// A Stop hook waits at most this long, within the hour its hook timeout allows.
export const HOOK_WAIT_MINUTES = 55;
const POLL_MS = 1000;
const SETTLE_MS = 15000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function answerText(gate) {
  const { choice, note } = gate.answer;
  const label = choice === null ? "a free answer" : gate.options?.find((option) => option.id === choice)?.label ?? choice;
  return `The user answered user gate ${gate.id} in the review browser. Question: ${gate.question} Answer: ${label}.${note ? ` Note: ${note}` : ""}`;
}

/** The text of a wait that the person's changes ended. */
export function changedText(value) {
  return [personChangesText(value.changes), value.waiting.length ? `Still waiting on: ${value.waiting.join(", ")}.` : ""].filter(Boolean).join("\n");
}

function outcome(initiative, gateIds, state, history, shown, held, known, first, watchChanges) {
  const pending = state?.pending ?? [];
  const present = gateIds.map((id) => pending.find((item) => isRecord(item) && item.id === id)).filter(Boolean);
  if (!present.length) return { result: { status: first ? "unknown_gate" : "resolved" } };
  const answered = present.filter((gate) => gate.answer);
  const waiting = present.filter((gate) => !gate.answer).map((gate) => gate.id);
  if (answered.length) return { result: { status: "answered", answered, waiting }, answers: answered.map((gate) => gate.id) };
  if (!watchChanges) return { result: null };
  // An entry absent when the wait started ends it, by id rather than time, so one a store sync brings counts too;
  // one the session was shown does not, nor an answer to a waited gate, which answers instead, or to a gate another wait of the session holds.
  const answers = new Set(gateIds.map((id) => `gate:${initiative}/${id}`));
  const changes = history.filter((entry) => !known.has(entry.id) && !shown.has(entry.id) && !(entry.action === "gate.answer" && (answers.has(entry.target) || held.has(entry.target) || held.has(entry.id))));
  return changes.length ? { result: { status: "changed", waiting, changes }, changes } : { result: null };
}

// Each poll renews the wait's hold on its gates for this long, at least ten polls, so the hold of a wait whose process stopped lapses soon.
const HOLD_LEASE_MS = 15000;

// The wait reads the coordination state record rather than server memory, so an answer recorded by any review server process ends it.
// After the first answer it keeps polling briefly, because a user often answers several gates in one visit.
// Given notices, { session, directory, waitId, hold }, each poll is one step of the session's notice record of the initiative: it reads the state and what the session was shown once and decides.
// The wait holds its gates in that record while it runs, so another result of the session leaves their answers to it, and the answer entries it finds count as shown when it ends, unless it is cancelled.
// The changes it ends on count as shown in the step that finds them, so no other result of the session shows them and no later read shows them again.
// hold, a time, keeps the gates held after a timeout, for a wait that the host's Stop hook goes on with under the same waitId; the hook's polls renew it.
// Only a wait given watchChanges, the coordinator's, ends on the person's changes: entries absent from knownEntries, the ids held when the wait started, that the session was not shown.
// Without knownEntries the wait holds the ids the session was shown at its first valid read, or every entry then before the session's starting point exists.
export async function waitForUserGates({ projectRoot, initiative, gateIds, maxWaitMinutes = DEFAULT_WAIT_MINUTES, signal, onProgress, heartbeatMs = 60000, pollMs = POLL_MS, settleMs = SETTLE_MS, knownEntries, notices = null, watchChanges = false, leaseMs = Math.max(HOLD_LEASE_MS, 10 * pollMs) }) {
  if (!Array.isArray(gateIds) || !gateIds.length || gateIds.length > MAX_WAIT_GATES || gateIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`Pass one to ${MAX_WAIT_GATES} gate ids.`);
  }
  if (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0) || maxWaitMinutes > MAX_WAIT_MINUTES) {
    throw new Error(`The maxWaitMinutes argument must be greater than 0 and at most ${MAX_WAIT_MINUTES}.`);
  }
  const ids = [...new Set(gateIds)];
  const started = Date.now();
  const deadline = started + maxWaitMinutes * 60000;
  const heartbeat = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1000)), heartbeatMs) : null;
  const watch = watchChanges === true && notices !== null;
  const { hold = null, ...session } = notices ?? {};
  const waitId = session.waitId ?? randomBytes(16).toString("hex");
  let settleUntil = null;
  let last = null;
  let known = Array.isArray(knownEntries) ? new Set(knownEntries) : null;
  // first holds until a valid read, which alone can find the gates unknown.
  let first = true;
  // A read that fails or finds the state invalid brings no new information: the wait neither ends on it nor counts its entries as known or shown, as the notice step sees no history then.
  // An aborted wait ends cancelled in the step itself, so a poll that runs or finishes after the abort marks nothing as shown.
  const decide = (state, history, shown, held) => {
    if (signal?.aborted) return { result: { status: "cancelled" } };
    if (!state) return { result: undefined };
    known ??= new Set(shown);
    const decision = outcome(initiative, ids, state, history, shown, held ?? new Set(), known, first, watch);
    first = false;
    return decision;
  };
  const poll = notices
    ? () => gateWaitStep({ projectRoot, initiative, ...session, waitId, gateIds: ids, until: Date.now() + leaseMs }, decide)
    : async () => {
      const read = await readCoordinationState({ projectRoot, initiative });
      if (!read.valid) return decide(null).result;
      const state = read.state ?? {};
      const history = (Array.isArray(state.history) ? state.history : []).filter((entry) => isRecord(entry) && typeof entry.id === "string");
      return decide(state, history, new Set(history.map((entry) => entry.id))).result;
    };
  let value;
  try {
    // Only the wait's very first read throws.
    let firstRead = true;
    while (true) {
      let result;
      try {
        result = await poll();
      } catch (error) {
        if (firstRead) throw error;
      }
      firstRead = false;
      // Gates resolved after an answer was found still return that answer.
      if (result?.status === "resolved" && last) return (value = { ...last, gateIds: ids });
      if (result && result.status !== "answered") return (value = { ...result, gateIds: ids });
      if (result) {
        last = result;
        settleUntil ??= Math.min(Date.now() + settleMs, deadline);
        if (!result.waiting.length || Date.now() >= settleUntil) return (value = { ...result, gateIds: ids });
      }
      if (signal?.aborted) {
        return (value = { status: "cancelled", gateIds: ids });
      }
      if (Date.now() >= deadline) {
        return (value = last ? { ...last, gateIds: ids } : { status: "timeout", gateIds: ids });
      }
      await sleep(Math.min(pollMs, Math.max(0, (settleUntil ?? deadline) - Date.now())), signal);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (notices) {
      await endGateWait({ projectRoot, initiative, ...session, waitId, cancelled: !value || value.status === "cancelled", hold: value?.status === "timeout" ? hold : null }).catch(() => {});
    }
  }
}
