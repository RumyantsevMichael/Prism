import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { reviewAppDirectory } from "./review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";

// The theme and density a user chose in the review browser, kept in the review app folder so that every project, port,
// and private session server of that user reads the same choice; browser storage is separate for every port.
export const PREFERENCES_FILE = "review-preferences.json";
export const PREFERENCE_VALUES = Object.freeze({ theme: Object.freeze(["system", "light", "dark"]), density: Object.freeze(["compact", "comfortable"]) });
export const DEFAULT_PREFERENCES = Object.freeze({ theme: "system", density: "compact" });

export function preferencesPath(env = process.env) {
  return path.join(reviewAppDirectory(env), PREFERENCES_FILE);
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_preference" });
}

function normalize(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(PREFERENCE_VALUES).map(([key, allowed]) => [key, allowed.includes(source[key]) ? source[key] : DEFAULT_PREFERENCES[key]]));
}

/** The stored preferences, with the default for each value that is missing, unreadable, or invalid. */
export async function readPreferences(env = process.env) {
  try {
    return normalize(parseStoreJson(await readFile(preferencesPath(env), "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Throws invalid_preference unless the change is an object that gives a valid theme, density, or both, and nothing else. */
export function validatePreferenceChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) throw invalid("The preferences must be a JSON object with theme, density, or both.");
  const keys = Object.keys(change);
  if (!keys.length) throw invalid("Give theme, density, or both.");
  for (const key of keys) {
    const allowed = Object.hasOwn(PREFERENCE_VALUES, key) ? PREFERENCE_VALUES[key] : null;
    if (!allowed) throw invalid(`${key} is not a preference; give theme, density, or both.`);
    if (!allowed.includes(change[key])) throw invalid(`${key} must be one of ${allowed.join(", ")}.`);
  }
  return Object.fromEntries(keys.map((key) => [key, change[key]]));
}

// Writes of one process run one after another, so two quick choices never lose either value.
let queue = Promise.resolve();

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
