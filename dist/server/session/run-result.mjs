// Generated from src/server/session/run-result.mts by scripts/native-build/compile.mjs.
const NO_RESULT_LEAD = "Prism launched this run headless, and it ended without a gate, a pause, or a ship, so nobody saw what it needs.";
const NO_MESSAGE = "The run left no message.";
const LAST_MESSAGE_MAX = 6e3;
const QUESTION_PATTERN = /^The launched .+ run of .+ ended without a result\. What should it do next\?$/s;
function noResultQuestion(label, initiative) {
  return `The launched ${label} run of ${initiative} ended without a result. What should it do next?`;
}
function noResultContext(message) {
  return typeof message === "string" && message ? `${NO_RESULT_LEAD}

Its last message:

${message}` : `${NO_RESULT_LEAD}

${NO_MESSAGE}`;
}
function isNoResultGate(gate) {
  return gate?.kind === "assistance" && typeof gate.question === "string" && QUESTION_PATTERN.test(gate.question) && typeof gate.context === "string" && gate.context.startsWith(`${NO_RESULT_LEAD}

`);
}
function lastMessageOf(value, redact = (text) => text) {
  if (typeof value !== "string" || !value.trim()) return null;
  const redacted = redact(value);
  return redacted.length > LAST_MESSAGE_MAX ? `${redacted.slice(0, LAST_MESSAGE_MAX)}\u2026` : redacted;
}
const time = (value) => typeof value === "string" ? Date.parse(value) : Number.NaN;
async function runHasResult({ checkout, initiative, since, pauses = [] }) {
  const start = time(since);
  if (pauses.some((pause) => Number.isFinite(time(pause.at)) && (!Number.isFinite(start) || time(pause.at) >= start))) return true;
  const { shippedDecision } = await import("../workflow/shipped-history.mjs");
  if (await shippedDecision(checkout, initiative).catch(() => null)) return true;
  const { readCoordinationState } = await import("../workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: checkout, initiative }).catch(() => null);
  const pending = read?.valid && Array.isArray(read.state?.pending) ? read.state.pending : [];
  if (pending.some((gate) => gate && typeof gate === "object" && !gate.answer && !isNoResultGate(gate))) return true;
  const { pendingApprovalGates } = await import("../workflow/store-artifacts.mjs");
  const approvals = await pendingApprovalGates(checkout).catch(() => []);
  return (Array.isArray(approvals) ? approvals : []).some((gate) => gate?.initiative === initiative || gate?.shipped?.initiative === initiative);
}
export {
  LAST_MESSAGE_MAX,
  NO_MESSAGE,
  NO_RESULT_LEAD,
  isNoResultGate,
  lastMessageOf,
  noResultContext,
  noResultQuestion,
  runHasResult
};
