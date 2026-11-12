import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { actionEffect } from "./actions.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { MAIN_AGENT } from "./call-agent.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";

// What each session was shown of the person's changes, and which of its agents coordinates the initiative, kept per session and initiative in Prism's private app directory.
// Every server process of the session reads and writes one record under one lock, so an entry is shown in at most one result or gate wait of the session.
// A record holds { shown, coordinator, waits, asked }; shown is null before the session's starting point exists, and asked lists the pending gates the session asked.
export const NOTICE_FOLDER = "person-change-notices";
const ENTRY_ID = /^[0-9a-f]{32}$/;

export const NOTICE_HEADING = "The person changed this initiative in the review app since this session last read it:";

export function noticeDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), NOTICE_FOLDER);
}

function noticeFile(directory, session, projectRoot, initiative) {
  return path.join(directory, `${createHash("sha256").update(`${session}\0${path.resolve(projectRoot)}\0${initiative}`, "utf8").digest("hex").slice(0, 32)}.json`);
}

// A wait the session runs holds its pending gates in the record until it ends, so another result of the session leaves the answers to them for the wait,
// and keeps the ids of the answer entries it found, which count as shown when it ends; each poll renews its until time, a short lease, so a wait whose process stopped soon lets go.
function readWaits(value, now) {
  return (Array.isArray(value) ? value : []).filter((wait) => typeof wait?.id === "string" && Array.isArray(wait.gates) && Number.isFinite(wait.until) && wait.until > now)
    .map((wait) => ({ id: wait.id, gates: wait.gates.filter((id) => typeof id === "string"), until: wait.until, answers: Array.isArray(wait.answers) ? wait.answers.filter((id) => typeof id === "string") : [] }));
}

async function readNotice(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      shown: Array.isArray(value?.shown) ? value.shown.filter((id) => typeof id === "string") : null,
      coordinator: typeof value?.coordinator === "string" && value.coordinator ? value.coordinator : MAIN_AGENT,
      waits: readWaits(value?.waits, Date.now()),
      asked: Array.isArray(value?.asked) ? value.asked.filter((id) => typeof id === "string") : []
    };
  } catch {
    return { shown: null, coordinator: MAIN_AGENT, waits: [], asked: [] };
  }
}

const wellFormed = (state) => (Array.isArray(state?.history) ? state.history : []).filter((entry) => typeof entry?.id === "string" && ENTRY_ID.test(entry.id));

const recordText = ({ shown, coordinator, waits, asked }) => `${JSON.stringify({ shown, coordinator, ...(waits.length ? { waits } : {}), ...(asked.length ? { asked } : {}) })}\n`;

// One step for the session: read its record and the coordination state, decide, and write the record, under a lock that every process of the session honors.
// The step gets the state and its well-formed history entries in history order; while the state reads invalid it gets no state and no history, so it shows nothing from the history,
// and the first call's starting point stays unset.
// The lock of a process that stopped while it held it, such as a killed wait, is taken over at once, so it never outlasts the wait's hold.
async function withNotice({ projectRoot, initiative, session, directory }, step) {
  await prepareDirectory(directory);
  const file = noticeFile(directory, session, projectRoot, initiative);
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const record = await readNotice(file);
    const read = await readCoordinationState({ projectRoot, initiative });
    const state = read.valid ? read.state ?? {} : null;
    const history = state ? wellFormed(state) : [];
    const { result, shown = record.shown, coordinator = record.coordinator, waits = record.waits, asked = record.asked } = await step(record, history, state);
    // A first valid read counts every existing entry as shown; the kept ids are then only those still in the history.
    let kept = shown;
    if (state) {
      const ids = history.map((entry) => entry.id);
      kept = shown === null ? ids : ids.filter((id) => shown.includes(id));
    }
    // A gate that is no longer pending needs no delivery, so the session keeps only the pending gates it asked.
    const pending = state && new Set((Array.isArray(state.pending) ? state.pending : []).map((gate) => gate?.id));
    const next = recordText({ shown: kept, coordinator, waits, asked: pending ? asked.filter((id) => pending.has(id)) : asked });
    if (next !== recordText(record)) await writeAtomically(file, next, { mode: 0o600 });
    return result;
  }, undefined, { renew: true, abandonWhenUnrenewed: true }));
}

// The history targets of the answers that the session's running waits hold for themselves, and the ids of the answer entries they found.
const heldTargets = (initiative, waits, except = null) => new Set(waits.filter((wait) => wait.id !== except).flatMap((wait) => [...wait.gates.map((id) => `gate:${initiative}/${id}`), ...wait.answers]));
const isHeld = (entry, held) => entry.action === "gate.answer" && (held.has(entry.target) || held.has(entry.id));

/**
 * The entries of an initiative's history that this session has not been shown, for its coordinator, which now count as shown.
 * coordinates makes the agent the coordinator first, as a successful claim or start of a slice does; another agent is shown nothing and counts nothing as shown.
 * A session's first call shows nothing and counts every existing entry as shown.
 * An answer to a gate that a running wait of the session holds is left for that wait.
 */
export async function takePersonChanges({ projectRoot, initiative, agent = MAIN_AGENT, coordinates = false, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history) => {
    const coordinator = coordinates ? agent : record.coordinator;
    if (record.shown === null || coordinator !== agent) return { result: [], coordinator };
    const held = heldTargets(initiative, record.waits);
    const changes = history.filter((entry) => !record.shown.includes(entry.id) && !isHeld(entry, held));
    return { result: changes, shown: [...record.shown, ...changes.map((entry) => entry.id)], coordinator };
  });
}

/** Remember that the session asked these gates, so the prompt hooks deliver their answers to this session and to no other. */
export async function rememberAskedGates({ projectRoot, initiative, gateIds, session = claimHolder(), directory = noticeDirectory() }) {
  if (!gateIds.length) return;
  await withNotice({ projectRoot, initiative, session, directory }, (record) => ({ result: null, asked: [...new Set([...record.asked, ...gateIds])] }));
}

/** The ids of the gates the session asked on an initiative that were still pending when its record last changed. */
export async function askedGates({ projectRoot, initiative, session, directory = noticeDirectory() }) {
  return (await readNotice(noticeFile(directory, session, projectRoot, initiative))).asked;
}

/**
 * The start of a gate wait: whether the agent coordinates the initiative in its session now, and the entry ids the wait holds at its start.
 * They are the history's ids, or while the state reads invalid the ids the session was shown, or null before the session's starting point exists; a session's first call counts every existing entry as shown.
 */
export async function startGateWait({ projectRoot, initiative, agent = MAIN_AGENT, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history, state) => ({
    result: { coordinates: record.coordinator === agent, known: state ? history.map((entry) => entry.id) : record.shown }
  }));
}

/**
 * One poll of a gate wait as one step of its session, which holds those of the wait's gates that are pending until until.
 * decide gets the state, its history, the ids the session was shown, and the answer targets other waits hold, or no state while it reads invalid,
 * and returns { result, answers, changes }: the ids of the answered gates it found, whose answer entries the wait keeps until it ends, and the changes it ends on, which count as shown in this step.
 */
export async function gateWaitStep({ projectRoot, initiative, session = claimHolder(), directory = noticeDirectory(), waitId, gateIds, until }, decide) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history, state) => {
    const own = record.waits.find((wait) => wait.id === waitId);
    const others = record.waits.filter((wait) => wait.id !== waitId);
    const holding = { id: waitId, gates: own?.gates ?? [], until, answers: own?.answers ?? [] };
    // A gate that is not pending has no answer the wait can return, so the wait holds only pending gates; while the state reads invalid it keeps what it held.
    if (!state) return { result: decide(null, [], null, null).result, waits: [...others, holding] };
    // Before the session's starting point exists every existing entry counts as shown, as for a first call.
    const shown = record.shown ?? history.map((entry) => entry.id);
    const pending = new Set((Array.isArray(state.pending) ? state.pending : []).map((gate) => gate?.id));
    holding.gates = gateIds.filter((id) => pending.has(id));
    const { result, answers = [], changes = [] } = decide(state, history, new Set(shown), heldTargets(initiative, others));
    const targets = new Set(answers.map((id) => `gate:${initiative}/${id}`));
    const found = history.filter((entry) => entry.action === "gate.answer" && targets.has(entry.target) && !shown.includes(entry.id)).map((entry) => entry.id);
    holding.answers = [...new Set([...holding.answers, ...found])];
    if (changes.length) return { result, shown: [...shown, ...changes.map((entry) => entry.id)], waits: others };
    return { result, shown, waits: [...others, holding] };
  });
}

/**
 * The end of a gate wait: it lets go of its gates, and the answer entries it found count as shown, unless it was cancelled, when a later result shows them.
 * hold keeps the gates until that time instead, for a wait that the host's Stop hook goes on with.
 */
export async function endGateWait({ projectRoot, initiative, session = claimHolder(), directory = noticeDirectory(), waitId, cancelled = false, hold = null }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record) => {
    const own = record.waits.find((wait) => wait.id === waitId);
    if (!own) return { result: null };
    const others = record.waits.filter((wait) => wait.id !== waitId);
    if (hold !== null) return { result: null, waits: [...others, { ...own, until: hold }] };
    const shown = record.shown === null || cancelled ? record.shown : [...record.shown, ...own.answers.filter((id) => !record.shown.includes(id))];
    return { result: null, shown, waits: others };
  });
}

// A string has each backslash and each control or line separator character escaped, so a value from a synced entry cannot start a line.
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const noticeString = (value) => value.replace(UNSAFE, (character) => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

// JSON text already escapes backslashes and U+0000 to U+001F, so the rest of the unsafe set is escaped the same way.
const UNSAFE_JSON = /[\u007f-\u009f\u2028\u2029]/g;

/** A value as a notice line writes it: a string escaped, any other value as its JSON text with the remaining control and line separator characters escaped. */
export function noticeValue(value) {
  if (typeof value === "string") return noticeString(value);
  return (JSON.stringify(value) ?? "null").replace(UNSAFE_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The author as `<name> <<email>>`, without whichever part is unset, or `an unknown person`, followed by its checkout. */
export function authorText(by) {
  const name = typeof by?.name === "string" && by.name ? noticeString(by.name) : null;
  const email = typeof by?.email === "string" && by.email ? `<${noticeString(by.email)}>` : null;
  const who = [name, email].filter(Boolean).join(" ") || "an unknown person";
  return `${who}${typeof by?.checkout === "string" && by.checkout ? ` (${noticeString(by.checkout)})` : ""}`;
}

/** The notice text for entries, one line per entry with its action, target, values, effect, and author. */
export function personChangesText(entries) {
  return [NOTICE_HEADING, ...entries.map((entry) => {
    const effect = actionEffect(entry.action);
    return `- ${noticeValue(entry.action)} on ${noticeValue(entry.target)}: ${noticeValue(entry.before)} -> ${noticeValue(entry.after)}.${effect ? ` ${effect}` : ""} Changed by ${authorText(entry.by)}.`;
  })].join("\n");
}

export const KEPT_SETTINGS_HEADING = "The person set these settings in the review app, so Prism kept their values:";

/** The text of the settings an agent's write kept, one line per setting. */
export function keptSettingsText(kept) {
  return [KEPT_SETTINGS_HEADING, ...kept.map((item) => `- ${noticeString(String(item.setting))}: kept ${noticeValue(item.kept)}, requested ${noticeValue(item.requested)}.`)].join("\n");
}
