import { forgetAskedGates } from "./approval-deliveries.mjs";
import { readCoordinationState } from "./state.mjs";

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
  const recorded = gate.kind === "approval" ? choice === "approve" ? ` Prism recorded ${gate.status} for ${gate.artifact ?? "the artifact"} and rewrote its status lines in the store.` : ` The recorded status of ${gate.artifact ?? "the artifact"} stays as it was.` : "";
  return `The user answered user gate ${gate.id} in the review browser. Question: ${gate.question} Answer: ${label}.${note ? ` Note: ${note}` : ""}${recorded}`;
}

/**
 * How a wait reads its gates: an initiative's from its coordination state, or one requirement's or ADR's approval gates from its status record in the store,
 * where an answered approval gate stays listed with its answer and a superseded one is gone.
 */
// After the first read an artifact wait reads leniently, so an artifact removed, moved out of the checkout's view, or out of the given scope has no gates left and the wait ends as resolved.
export function gateSource({ projectRoot, initiative, artifact, scope }) {
  if (typeof artifact === "string" && artifact) {
    let since = false;
    return async () => {
      const { artifactApprovalGates } = await import("./store-artifacts.mjs");
      let gates;
      try { gates = await artifactApprovalGates(projectRoot, artifact, scope, undefined, { since }); }
      catch (error) { if (since && ["scope_invalid", "component_unknown"].includes(error?.code)) return []; throw error; }
      since = true;
      return gates.map((gate) => ({ ...gate, artifact }));
    };
  }
  if (typeof initiative !== "string" || !initiative) throw new Error("Pass the initiative whose coordination state holds the gates, or the artifact whose approval gates to wait on.");
  return async () => (await readCoordinationState({ projectRoot, initiative })).state?.pending ?? [];
}

function outcome(gateIds, pending, first) {
  const present = gateIds.map((id) => pending.find((item) => isRecord(item) && item.id === id)).filter(Boolean);
  if (!present.length) return { status: first ? "unknown_gate" : "resolved" };
  const answered = present.filter((gate) => gate.answer);
  return answered.length ? { status: "answered", answered, waiting: present.filter((gate) => !gate.answer).map((gate) => gate.id) } : null;
}

// The wait reads the coordination state record, or an artifact's status record, rather than server memory, so an answer recorded by any review server process ends it.
// After the first answer it keeps polling briefly, because a user often answers several gates in one visit.
// An artifact wait that returns answers is how the checkout that asked them receives them, so the prompt hook does not hand them to it again.
export async function waitForUserGates(input) {
  const result = await waitOnGates(input);
  if (result.status === "answered" && typeof input.artifact === "string" && input.artifact) {
    await forgetAskedGates(input.projectRoot, result.answered.map((gate) => gate.id), input.deliveredDirectory ? { directory: input.deliveredDirectory } : {}).catch(() => {});
  }
  return result;
}

async function waitOnGates({ projectRoot, initiative, artifact, scope, gateIds, maxWaitMinutes = DEFAULT_WAIT_MINUTES, signal, onProgress, heartbeatMs = 60000, pollMs = POLL_MS, settleMs = SETTLE_MS }) {
  if (!Array.isArray(gateIds) || !gateIds.length || gateIds.length > MAX_WAIT_GATES || gateIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`Pass one to ${MAX_WAIT_GATES} gate ids.`);
  }
  if (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0) || maxWaitMinutes > MAX_WAIT_MINUTES) {
    throw new Error(`The maxWaitMinutes argument must be greater than 0 and at most ${MAX_WAIT_MINUTES}.`);
  }
  const readGates = gateSource({ projectRoot, initiative, artifact, scope });
  const ids = [...new Set(gateIds)];
  const started = Date.now();
  const deadline = started + maxWaitMinutes * 60000;
  const heartbeat = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1000)), heartbeatMs) : null;
  let settleUntil = null;
  let last = null;
  try {
    let first = true;
    while (true) {
      let pending = null;
      try {
        pending = await readGates();
      } catch (error) {
        if (first) throw error;
      }
      if (pending) {
        const result = outcome(ids, pending, first);
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
