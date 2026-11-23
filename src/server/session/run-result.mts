// The result check of a launched run on any host: whether the run left something for the person or the work, read only from Prism's
// own records, and the text of the no-result gate that Prism records when a run ends normally without one.

/** The first paragraph of every no-result gate's context. */
export const NO_RESULT_LEAD = "Prism launched this run headless, and it ended without a gate, a pause, or a ship, so nobody saw what it needs.";
export const NO_MESSAGE = "The run left no message.";
/** A run's last message keeps at most this many characters, and a longer one ends with `…`. */
export const LAST_MESSAGE_MAX = 6000;
const QUESTION_PATTERN = /^The launched .+ run of .+ ended without a result\. What should it do next\?$/s;

/** The question of a no-result gate. */
export function noResultQuestion(label: string, initiative: string) {
  return `The launched ${label} run of ${initiative} ended without a result. What should it do next?`;
}

/** The context of a no-result gate: the lead, then the run's last message, or that it left none. */
export function noResultContext(message: string | null) {
  return typeof message === "string" && message ? `${NO_RESULT_LEAD}\n\nIts last message:\n\n${message}` : `${NO_RESULT_LEAD}\n\n${NO_MESSAGE}`;
}

/** Whether a gate of the coordination state is a no-result gate of any launch, on this machine or another. */
export function isNoResultGate(gate: any) {
  return gate?.kind === "assistance" && typeof gate.question === "string" && QUESTION_PATTERN.test(gate.question)
    && typeof gate.context === "string" && gate.context.startsWith(`${NO_RESULT_LEAD}\n\n`);
}

/**
 * A host's reply text as a run's last message: null for blank text, and otherwise the text, whose session ids `redact` replaced,
 * cut after LAST_MESSAGE_MAX characters with `…` added. The id is replaced before the text is cut, so no cut leaves part of it.
 */
export function lastMessageOf(value: unknown, redact: (text: string) => string = (text) => text) {
  if (typeof value !== "string" || !value.trim()) return null;
  const redacted = redact(value);
  return redacted.length > LAST_MESSAGE_MAX ? `${redacted.slice(0, LAST_MESSAGE_MAX)}…` : redacted;
}

const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/**
 * Whether a launched run has a result now: the roadmap records its initiative as shipped, the initiative's coordination state holds a
 * pending gate without an answer that is no no-result gate, an approval gate that names the initiative has no answer, or a pause that
 * the launch marked is at or after `since`, the time the run started. A record that cannot be read counts as giving no result.
 * With `until`, the time the run ended, a gate answered after it still counts as without an answer, so an answer that arrives while
 * Prism checks an ended run does not take away the result that the run left.
 */
export async function runHasResult({ checkout, initiative, since, until = null, pauses = [] }: { checkout: string; initiative: string; since: string; until?: string | null; pauses?: { at: string }[] }) {
  const start = time(since);
  if (pauses.some((pause) => Number.isFinite(time(pause.at)) && (!Number.isFinite(start) || time(pause.at) >= start))) return true;
  const { shippedDecision } = await import("../workflow/shipped-history.mjs");
  if (await shippedDecision(checkout, initiative).catch(() => null)) return true;
  const { readCoordinationState } = await import("../workflow/state.mjs");
  const read: any = await readCoordinationState({ projectRoot: checkout, initiative }).catch(() => null);
  const pending = read?.valid && Array.isArray(read.state?.pending) ? read.state.pending : [];
  const end = time(until);
  const openAtEnd = (gate: any) => !gate.answer || (Number.isFinite(end) && !(time(gate.answer.answeredAt) <= end));
  if (pending.some((gate: any) => gate && typeof gate === "object" && openAtEnd(gate) && !isNoResultGate(gate))) return true;
  const { pendingApprovalGates } = await import("../workflow/store-artifacts.mjs");
  const approvals: any[] = await pendingApprovalGates(checkout).catch(() => []);
  return (Array.isArray(approvals) ? approvals : []).some((gate) => gate?.initiative === initiative || gate?.shipped?.initiative === initiative);
}
