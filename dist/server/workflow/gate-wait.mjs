import { readCoordinationState } from "./state.mjs";
import { personChangesText } from "./change-notices.mjs";

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

const historyOf = (state) => (Array.isArray(state?.history) ? state.history : []).filter((entry) => isRecord(entry) && typeof entry.id === "string");

/** The ids of an initiative's history entries now, which a wait compares with to learn of the person's changes. */
export async function historyIds({ projectRoot, initiative }) {
  return historyOf((await readCoordinationState({ projectRoot, initiative })).state).map((entry) => entry.id);
}

function outcome(initiative, gateIds, state, known, first, watchChanges) {
  const pending = state?.pending ?? [];
  const present = gateIds.map((id) => pending.find((item) => isRecord(item) && item.id === id)).filter(Boolean);
  if (!present.length) return { status: first ? "unknown_gate" : "resolved" };
  const answered = present.filter((gate) => gate.answer);
  const waiting = present.filter((gate) => !gate.answer).map((gate) => gate.id);
  if (answered.length) return { status: "answered", answered, waiting };
  if (!watchChanges) return null;
  // An entry absent when the wait started ends it, by id rather than time, so one a store sync brings counts too; an answer to a waited gate answers instead.
  const answers = new Set(gateIds.map((id) => `gate:${initiative}/${id}`));
  const changes = historyOf(state).filter((entry) => !known.has(entry.id) && !(entry.action === "gate.answer" && answers.has(entry.target)));
  return changes.length ? { status: "changed", waiting, changes } : null;
}

// The wait reads the coordination state record rather than server memory, so an answer recorded by any review server process ends it.
// After the first answer it keeps polling briefly, because a user often answers several gates in one visit.
// knownEntries are the history entry ids present when the wait started, read at its start when not given.
// Only a wait given takeChanges, the coordinator's, ends on the person's changes: it takes the new entries no other result of the session showed, and goes on while it takes none.
export async function waitForUserGates({ projectRoot, initiative, gateIds, maxWaitMinutes = DEFAULT_WAIT_MINUTES, signal, onProgress, heartbeatMs = 60000, pollMs = POLL_MS, settleMs = SETTLE_MS, knownEntries, takeChanges = null }) {
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
  let settleUntil = null;
  let last = null;
  let known = Array.isArray(knownEntries) ? new Set(knownEntries) : null;
  try {
    let first = true;
    while (true) {
      let state;
      try {
        state = (await readCoordinationState({ projectRoot, initiative })).state ?? {};
      } catch (error) {
        if (first) throw error;
      }
      if (state) {
        known ??= new Set(historyOf(state).map((entry) => entry.id));
        let result = outcome(initiative, ids, state, known, first, typeof takeChanges === "function");
        if (result?.status === "changed") {
          const taken = await takeChanges(result.changes);
          for (const entry of result.changes) known.add(entry.id);
          result = taken.length ? { ...result, changes: taken } : null;
        }
        if (result && result.status !== "answered") return { ...result, gateIds: ids };
        if (result) {
          last = result;
          settleUntil ??= Math.min(Date.now() + settleMs, deadline);
          if (!result.waiting.length || Date.now() >= settleUntil) return { ...result, gateIds: ids };
        }
      }
      first = false;
      if (signal?.aborted) {
        return { status: "cancelled", gateIds: ids };
      }
      if (Date.now() >= deadline) {
        return last ? { ...last, gateIds: ids } : { status: "timeout", gateIds: ids };
      }
      await sleep(Math.min(pollMs, Math.max(0, (settleUntil ?? deadline) - Date.now())), signal);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
