import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { actionEffect } from "./actions.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";

// What each session was shown of the person's changes, kept per session and initiative in the host's private plugin data folder,
// so a server the host restarts in the same session does not show them again; without that folder this process keeps it.
const FOLDER = "person-change-notices";
const ENTRY_ID = /^[0-9a-f]{32}$/;
const inMemory = new Map();

export const NOTICE_HEADING = "The person changed this initiative in the review app since this session last read it:";

const pluginDataDirectory = (env = process.env) => env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || null;

function shownKey(session, projectRoot, initiative) {
  return createHash("sha256").update(`${session}\0${path.resolve(projectRoot)}\0${initiative}`, "utf8").digest("hex").slice(0, 32);
}

async function readShown(key, dataDirectory) {
  if (!dataDirectory) return inMemory.get(key) ?? null;
  try {
    const value = JSON.parse(await readFile(path.join(dataDirectory, FOLDER, `${key}.json`), "utf8"));
    return Array.isArray(value?.shown) ? value.shown.filter((id) => typeof id === "string") : null;
  } catch {
    return null;
  }
}

async function writeShown(key, dataDirectory, ids) {
  if (!dataDirectory) {
    inMemory.set(key, ids);
    return;
  }
  const folder = path.join(dataDirectory, FOLDER);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${key}.json`);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ shown: ids })}\n`);
  await rename(temporary, file);
}

/** The well-formed entries of an initiative's history, in history order. */
export async function readPersonHistory(projectRoot, initiative) {
  const read = await readCoordinationState({ projectRoot, initiative });
  const history = read.valid && Array.isArray(read.state?.history) ? read.state.history : [];
  return history.filter((entry) => typeof entry?.id === "string" && ENTRY_ID.test(entry.id));
}

/**
 * The entries of an initiative's history that this session has not been shown, which now count as shown.
 * A session's first call shows nothing and counts every existing entry as shown; the kept ids are those still in the history.
 */
export async function takePersonChanges({ projectRoot, initiative, session = claimHolder(), dataDirectory = pluginDataDirectory() }) {
  const history = await readPersonHistory(projectRoot, initiative);
  const key = shownKey(session, projectRoot, initiative);
  const shown = await readShown(key, dataDirectory);
  const changes = shown === null ? [] : history.filter((entry) => !shown.includes(entry.id));
  const ids = history.map((entry) => entry.id);
  if (shown === null || changes.length || shown.length !== ids.length) await writeShown(key, dataDirectory, ids);
  return changes;
}

/** Count entries as shown to this session, as a gate wait that returned them does. */
export async function markPersonChangesShown({ projectRoot, initiative, entries, session = claimHolder(), dataDirectory = pluginDataDirectory() }) {
  const key = shownKey(session, projectRoot, initiative);
  const shown = await readShown(key, dataDirectory);
  const history = (await readPersonHistory(projectRoot, initiative)).map((entry) => entry.id);
  const seen = new Set([...(shown ?? history), ...entries.map((entry) => entry.id)]);
  await writeShown(key, dataDirectory, history.filter((id) => seen.has(id)));
}

const valueText = (value) => value === null || value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value);

/** The author as `<name> <<email>>`, without whichever part is unset, or `an unknown person`, followed by its checkout. */
export function authorText(by) {
  const name = typeof by?.name === "string" && by.name ? by.name : null;
  const email = typeof by?.email === "string" && by.email ? `<${by.email}>` : null;
  const who = [name, email].filter(Boolean).join(" ") || "an unknown person";
  return `${who}${by?.checkout ? ` (${by.checkout})` : ""}`;
}

/** The notice text for entries, one line per entry with its action, target, values, effect, and author. */
export function personChangesText(entries) {
  return [NOTICE_HEADING, ...entries.map((entry) => {
    const effect = actionEffect(entry.action);
    return `- ${entry.action} on ${entry.target}: ${valueText(entry.before)} -> ${valueText(entry.after)}.${effect ? ` ${effect}` : ""} Changed by ${authorText(entry.by)}.`;
  })].join("\n");
}
