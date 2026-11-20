// Generated from src/server/review/review-preferences.mts by scripts/native-build/compile.mjs.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { reviewAppDirectory } from "./review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { checkPreferenceChange, DEFAULT_PREFERENCES, normalizePreferences, PREFERENCES } from "./public/kit/preference-registry.js";
const PREFERENCES_FILE = "review-preferences.json";
function preferencesPath(env = process.env) {
  return path.join(reviewAppDirectory(env), PREFERENCES_FILE);
}
function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_preference" });
}
async function readPreferences(env = process.env) {
  try {
    return normalizePreferences(parseStoreJson(await readFile(preferencesPath(env), "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}
function validatePreferenceChange(change) {
  const checked = checkPreferenceChange(change);
  if (checked.error) throw invalid(checked.error);
  return checked.change;
}
let queue = Promise.resolve();
function readStoredPreferences(env = process.env) {
  return queue.then(() => readPreferences(env));
}
function writePreferences(change, env = process.env) {
  const valid = validatePreferenceChange(change);
  const write = queue.then(async () => {
    const next = { ...await readPreferences(env), ...valid };
    const file = preferencesPath(env);
    await mkdir(path.dirname(file), { recursive: true, mode: 448 });
    await writeAtomically(file, `${JSON.stringify(next, null, 2)}
`, { mode: 384 });
    return next;
  });
  queue = write.catch(() => {
  });
  return write;
}
export {
  DEFAULT_PREFERENCES,
  PREFERENCES,
  PREFERENCES_FILE,
  preferencesPath,
  readPreferences,
  readStoredPreferences,
  validatePreferenceChange,
  writePreferences
};
