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
export const NOTICE_FOLDER = "person-change-notices";
const ENTRY_ID = /^[0-9a-f]{32}$/;

export const NOTICE_HEADING = "The person changed this initiative in the review app since this session last read it:";

export function noticeDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), NOTICE_FOLDER);
}

function noticeFile(directory, session, projectRoot, initiative) {
  return path.join(directory, `${createHash("sha256").update(`${session}\0${path.resolve(projectRoot)}\0${initiative}`, "utf8").digest("hex").slice(0, 32)}.json`);
}

async function readNotice(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      shown: Array.isArray(value?.shown) ? value.shown.filter((id) => typeof id === "string") : null,
      coordinator: typeof value?.coordinator === "string" && value.coordinator ? value.coordinator : MAIN_AGENT
    };
  } catch {
    return { shown: null, coordinator: MAIN_AGENT };
  }
}

/** The well-formed entries of an initiative's history, in history order, or null while its coordination state reads invalid. */
export async function readPersonHistory(projectRoot, initiative) {
  const read = await readCoordinationState({ projectRoot, initiative });
  if (!read.valid) return null;
  const history = Array.isArray(read.state?.history) ? read.state.history : [];
  return history.filter((entry) => typeof entry?.id === "string" && ENTRY_ID.test(entry.id));
}

// One step for the session: read its record and the history, decide, and write the record, under a lock that every process of the session honors.
// While the coordination state reads invalid the step sees no history, so it shows nothing, and the shown ids and the first call's starting point stay as they were.
async function withNotice({ projectRoot, initiative, session, directory }, step) {
  await prepareDirectory(directory);
  const file = noticeFile(directory, session, projectRoot, initiative);
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const record = await readNotice(file);
    const history = await readPersonHistory(projectRoot, initiative);
    if (history === null) {
      const { result, coordinator = record.coordinator } = await step(record, []);
      if (coordinator !== record.coordinator) await writeAtomically(file, `${JSON.stringify({ shown: record.shown, coordinator })}\n`, { mode: 0o600 });
      return result;
    }
    const { result, shown = record.shown, coordinator = record.coordinator } = await step(record, history);
    // A first call counts every existing entry as shown; the kept ids are only those still in the history.
    const ids = history.map((entry) => entry.id);
    const kept = shown === null ? ids : ids.filter((id) => shown.includes(id));
    if (record.shown === null || coordinator !== record.coordinator || kept.length !== record.shown.length || kept.some((id, index) => id !== record.shown[index])) {
      await writeAtomically(file, `${JSON.stringify({ shown: kept, coordinator })}\n`, { mode: 0o600 });
    }
    return result;
  }));
}

/**
 * The entries of an initiative's history that this session has not been shown, for its coordinator, which now count as shown.
 * coordinates makes the agent the coordinator first, as a successful claim or start of a slice does; another agent is shown nothing and counts nothing as shown.
 * A session's first call shows nothing and counts every existing entry as shown.
 */
export async function takePersonChanges({ projectRoot, initiative, agent = MAIN_AGENT, coordinates = false, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history) => {
    const coordinator = coordinates ? agent : record.coordinator;
    if (record.shown === null || coordinator !== agent) return { result: [], coordinator };
    const changes = history.filter((entry) => !record.shown.includes(entry.id));
    return { result: changes, shown: [...record.shown, ...changes.map((entry) => entry.id)], coordinator };
  });
}

/** Whether the agent coordinates the initiative in its session now; a session's first call counts every existing entry as shown. */
export async function coordinatesInitiative({ projectRoot, initiative, agent = MAIN_AGENT, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record) => ({ result: record.coordinator === agent }));
}

/** Of the entries a coordinator's gate wait found, the ones no other result of the session showed, which now count as shown. */
export async function takeWaitChanges({ projectRoot, initiative, entries, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history) => {
    const present = new Set(history.map((entry) => entry.id));
    const shown = record.shown ?? [];
    const changes = entries.filter((entry) => present.has(entry.id) && !shown.includes(entry.id));
    return { result: changes, shown: [...shown, ...changes.map((entry) => entry.id)] };
  });
}

/** A wait's result showed the answers to its answered gates, whichever agent waited, so their history entries count as shown. */
export async function markAnswersShown({ projectRoot, initiative, gateIds, session = claimHolder(), directory = noticeDirectory() }) {
  const targets = new Set(gateIds.map((id) => `gate:${initiative}/${id}`));
  return withNotice({ projectRoot, initiative, session, directory }, (record, history) => {
    if (record.shown === null) return { result: [] };
    const answers = history.filter((entry) => entry.action === "gate.answer" && targets.has(entry.target) && !record.shown.includes(entry.id));
    return { result: answers, shown: [...record.shown, ...answers.map((entry) => entry.id)] };
  });
}

// A string has each backslash and each control or line separator character escaped, so a value from a synced entry cannot start a line.
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const noticeString = (value) => value.replace(UNSAFE, (character) => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A value as a notice line writes it: a string escaped, any other value as its JSON text with line separators escaped. */
export function noticeValue(value) {
  if (typeof value === "string") return noticeString(value);
  return (JSON.stringify(value) ?? "null").replace(/[\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16)}`);
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
