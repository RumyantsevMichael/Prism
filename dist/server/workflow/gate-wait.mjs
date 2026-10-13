import { readCoordinationState } from "./state.mjs";

export const DEFAULT_WAIT_MINUTES = 720;
export const MAX_WAIT_MINUTES = 1440;
const POLL_MS = 1000;

function isGate(value, id) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.id === id;
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

// The wait reads state.json rather than server memory, so an answer recorded by any review server process ends it.
export async function waitForUserGate({ projectRoot, statePath, gateId, maxWaitMinutes = DEFAULT_WAIT_MINUTES, signal, onProgress, heartbeatMs = 60000, pollMs = POLL_MS }) {
  if (typeof gateId !== "string" || !gateId) {
    throw new Error("The gateId argument is required.");
  }
  if (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0) || maxWaitMinutes > MAX_WAIT_MINUTES) {
    throw new Error(`The maxWaitMinutes argument must be greater than 0 and at most ${MAX_WAIT_MINUTES}.`);
  }
  const started = Date.now();
  const deadline = started + maxWaitMinutes * 60000;
  const heartbeat = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1000)), heartbeatMs) : null;
  try {
    let first = true;
    while (true) {
      let pending;
      try {
        pending = (await readCoordinationState({ projectRoot, statePath })).state?.pending ?? [];
      } catch (error) {
        if (first) throw error;
        pending = null;
      }
      if (pending) {
        const gate = pending.find((item) => isGate(item, gateId));
        if (!gate) {
          return first ? { status: "unknown_gate", gateId } : { status: "resolved", gateId };
        }
        if (gate.answer) {
          return { status: "answered", gateId, gate };
        }
      }
      first = false;
      if (signal?.aborted) {
        return { status: "cancelled", gateId };
      }
      if (Date.now() >= deadline) {
        return { status: "timeout", gateId };
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
