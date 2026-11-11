import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { reviewAppDirectory } from "./review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { checkPreferenceChange, DEFAULT_PREFERENCES, normalizePreferences, PREFERENCES } from "./public/kit/preference-registry.js";

// The preferences a user chose in the review browser, kept in the review app folder so that every project, port,
// and private session server of that user reads the same choice; browser storage is separate for every port.
// The page and this module read one registry of preferences, so the app stores exactly the keys and values the page offers.
export const PREFERENCES_FILE = "review-preferences.json";
export { DEFAULT_PREFERENCES, PREFERENCES };

export function preferencesPath(env = process.env) {
  return path.join(reviewAppDirectory(env), PREFERENCES_FILE);
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_preference" });
}

/** The stored preferences, with the default for each value that is missing, unreadable, or invalid. */
export async function readPreferences(env = process.env) {
  try {
    return normalizePreferences(parseStoreJson(await readFile(preferencesPath(env), "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Throws invalid_preference unless the change is an object that gives one or more preferences, each with a value that fits it. */
export function validatePreferenceChange(change) {
  const checked = checkPreferenceChange(change);
  if (checked.error) throw invalid(checked.error);
  return checked.change;
}

// Writes of one process run one after another, so two quick choices never lose either value.
let queue = Promise.resolve();

/** The stored preferences once every write this process started has finished, so a page that reloads right after a choice reads it. */
export function readStoredPreferences(env = process.env) {
  return queue.then(() => readPreferences(env));
}

/** Stores the given values, keeps the stored value of a key the change leaves out, and returns the full stored preferences. */
export function writePreferences(change, env = process.env) {
  const valid = validatePreferenceChange(change);
  const write = queue.then(async () => {
    const next = { ...(await readPreferences(env)), ...valid };
    const file = preferencesPath(env);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomically(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  });
  queue = write.catch(() => {});
  return write;
}
