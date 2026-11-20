// Generated from src/server/workflow/gate-wait.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { forgetAskedGates } from "./approval-deliveries.mjs";
import { readCoordinationState } from "./state.mjs";
import { endGateWait, gateWaitStep, personChangesText } from "./change-notices.mjs";
const DEFAULT_WAIT_MINUTES = 720;
const MAX_WAIT_MINUTES = 1440;
const MAX_WAIT_GATES = 10;
const HOOK_WAIT_MINUTES = 55;
const POLL_MS = 1e3;
const SETTLE_MS = 15e3;
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
function answerText(gate) {
  const { choice, note } = gate.answer;
  const label = choice === null ? "a free answer" : gate.options?.find((option) => option.id === choice)?.label ?? choice;
  const recorded = gate.kind === "approval" ? choice === "approve" ? ` Prism recorded ${gate.status} for ${gate.artifact ?? "the artifact"} and rewrote its status lines in the store.` : ` The recorded status of ${gate.artifact ?? "the artifact"} stays as it was.` : "";
  return `The user answered user gate ${gate.id} in the review browser. Question: ${gate.question} Answer: ${label}.${note ? ` Note: ${note}` : ""}${recorded}`;
}
function gateSource({ projectRoot, initiative, artifact, scope }) {
  if (typeof artifact === "string" && artifact) {
    let since = false;
    return async () => {
      const { artifactApprovalGates } = await import("./store-artifacts.mjs");
      let gates;
      try {
        gates = await artifactApprovalGates(projectRoot, artifact, scope, void 0, { since });
      } catch (error) {
        if (since && ["scope_invalid", "component_unknown"].includes(error?.code)) return [];
        throw error;
      }
      since = true;
      return gates.map((gate) => ({ ...gate, artifact }));
    };
  }
  if (typeof initiative !== "string" || !initiative) throw new Error("Pass the initiative whose coordination state holds the gates, or the artifact whose approval gates to wait on.");
  return async () => (await readCoordinationState({ projectRoot, initiative })).state?.pending ?? [];
}
function changedText(value) {
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
  const answers = new Set(gateIds.map((id) => `gate:${initiative}/${id}`));
  const changes = history.filter((entry) => !known.has(entry.id) && !shown.has(entry.id) && !(entry.action === "gate.answer" && (answers.has(entry.target) || held.has(entry.target) || held.has(entry.id))));
  return changes.length ? { result: { status: "changed", waiting, changes }, changes } : { result: null };
}
const HOLD_LEASE_MS = 15e3;
async function waitForUserGates(input) {
  const result = await waitOnGates(input);
  if (result.status === "answered" && typeof input.artifact === "string" && input.artifact) {
    await forgetAskedGates(input.projectRoot, result.answered.map((gate) => gate.id), input.deliveredDirectory ? { directory: input.deliveredDirectory } : {}).catch(() => {
    });
  }
  return result;
}
async function waitOnGates({ projectRoot, initiative, artifact, scope, gateIds, maxWaitMinutes = DEFAULT_WAIT_MINUTES, signal, onProgress, heartbeatMs = 6e4, pollMs = POLL_MS, settleMs = SETTLE_MS, knownEntries, notices = null, watchChanges = false, leaseMs = Math.max(HOLD_LEASE_MS, 10 * pollMs) }) {
  if (!Array.isArray(gateIds) || !gateIds.length || gateIds.length > MAX_WAIT_GATES || gateIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`Pass one to ${MAX_WAIT_GATES} gate ids.`);
  }
  if (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0) || maxWaitMinutes > MAX_WAIT_MINUTES) {
    throw new Error(`The maxWaitMinutes argument must be greater than 0 and at most ${MAX_WAIT_MINUTES}.`);
  }
  const readArtifactGates = typeof artifact === "string" && artifact ? gateSource({ projectRoot, artifact, scope }) : null;
  if (readArtifactGates) notices = null;
  else gateSource({ projectRoot, initiative });
  const ids = [...new Set(gateIds)];
  const started = Date.now();
  const deadline = started + maxWaitMinutes * 6e4;
  const heartbeat = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1e3)), heartbeatMs) : null;
  const watch = watchChanges === true && notices !== null;
  const { hold = null, ...session } = notices ?? {};
  const waitId = session.waitId ?? randomBytes(16).toString("hex");
  let settleUntil = null;
  let last = null;
  let known = Array.isArray(knownEntries) ? new Set(knownEntries) : null;
  let first = true;
  const decide = (state, history, shown, held) => {
    if (signal?.aborted) return { result: { status: "cancelled" } };
    if (!state) return { result: void 0 };
    known ??= new Set(shown);
    const decision = outcome(initiative, ids, state, history, shown, held ?? /* @__PURE__ */ new Set(), known, first, watch);
    first = false;
    return decision;
  };
  const poll = readArtifactGates ? async () => decide({ pending: await readArtifactGates() }, [], /* @__PURE__ */ new Set()).result : notices ? () => gateWaitStep({ projectRoot, initiative, ...session, waitId, gateIds: ids, until: Date.now() + leaseMs }, decide) : async () => {
    const read = await readCoordinationState({ projectRoot, initiative });
    if (!read.valid) return decide(null).result;
    const state = read.state ?? {};
    const history = (Array.isArray(state.history) ? state.history : []).filter((entry) => isRecord(entry) && typeof entry.id === "string");
    return decide(state, history, new Set(history.map((entry) => entry.id))).result;
  };
  let value;
  try {
    let firstRead = true;
    while (true) {
      let result;
      try {
        result = await poll();
      } catch (error) {
        if (firstRead) throw error;
      }
      firstRead = false;
      if (result?.status === "resolved" && last) return value = { ...last, gateIds: ids };
      if (result && result.status !== "answered") return value = { ...result, gateIds: ids };
      if (result) {
        last = result;
        settleUntil ??= Math.min(Date.now() + settleMs, deadline);
        if (!result.waiting.length || Date.now() >= settleUntil) return value = { ...result, gateIds: ids };
      }
      if (signal?.aborted) {
        return value = { status: "cancelled", gateIds: ids };
      }
      if (Date.now() >= deadline) {
        return value = last ? { ...last, gateIds: ids } : { status: "timeout", gateIds: ids };
      }
      await sleep(Math.min(pollMs, Math.max(0, (settleUntil ?? deadline) - Date.now())), signal);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (notices) {
      await endGateWait({ projectRoot, initiative, ...session, waitId, cancelled: !value || value.status === "cancelled", hold: value?.status === "timeout" ? hold : null }).catch(() => {
      });
    }
  }
}
export {
  DEFAULT_WAIT_MINUTES,
  HOOK_WAIT_MINUTES,
  MAX_WAIT_GATES,
  MAX_WAIT_MINUTES,
  answerText,
  changedText,
  gateSource,
  waitForUserGates
};
