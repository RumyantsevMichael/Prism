import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// A person's own settings live in Prism's application folder, beside the machine's checkout list, so every host and a standalone app read the same values,
// and they never reach a project folder, a repository's configuration, or a record store.
const SETTINGS_FILE = "personal-settings.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;

/** The personal settings in their fixed order: each name, the line label a project's ## Interaction section records it under, its values, and its default. */
export const PERSONAL_SETTINGS = Object.freeze([
  Object.freeze({ name: "interactionStyle", label: "Interaction style", values: Object.freeze(["structured", "plain-text"]), default: "structured", aliases: Object.freeze({}) }),
  Object.freeze({ name: "reviewBrowser", label: "Review browser", values: Object.freeze(["auto", "internal", "external"]), default: "auto", aliases: Object.freeze({}) }),
  Object.freeze({ name: "reviewBrowserOnStart", label: "Review browser on start", values: Object.freeze(["on", "off"]), default: "on", aliases: Object.freeze({ open: "on" }) }),
  Object.freeze({ name: "sessionOffer", label: "Session offer", values: Object.freeze(["ask", "off"]), default: "ask", aliases: Object.freeze({}) })
]);

const BY_NAME = new Map(PERSONAL_SETTINGS.map((setting) => [setting.name, setting]));

export class PersonalSettingsError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "PersonalSettingsError";
    this.code = code;
    Object.assign(this, fields);
  }
}

/** The person's settings file: personal-settings.json in Prism's application folder. */
export function personalSettingsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), SETTINGS_FILE);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const UNREADABLE = "Prism cannot read personal-settings.json in its application folder, so it uses the repository's values and its defaults and saves no change until the file is fixed or removed.";
const unsupported = (version) => `personal-settings.json in Prism's application folder has schemaVersion ${version}, which this Prism does not know, so it uses the repository's values and its defaults and saves no change to it.`;

// The file's document, null for a missing file, and the problem that makes Prism leave the file alone, or null.
async function readDocument(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return { document: null, problem: null };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return { document: null, problem: { code: "settings_unreadable", message: UNREADABLE } };
  let parsed;
  try { parsed = parseStoreJson(await readFile(file, "utf8")); }
  catch { return { document: null, problem: { code: "settings_unreadable", message: UNREADABLE } }; }
  if (!isObject(parsed) || !Object.hasOwn(parsed, "schemaVersion")) return { document: null, problem: { code: "settings_unreadable", message: UNREADABLE } };
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return { document: null, problem: typeof parsed.schemaVersion === "number" ? { code: "settings_unsupported", message: unsupported(parsed.schemaVersion) } : { code: "settings_unreadable", message: UNREADABLE } };
  }
  return { document: { ...parsed, settings: isObject(parsed.settings) ? parsed.settings : {} }, problem: null };
}

// The personal entry of a setting when it holds one of the setting's values, else null.
function personalEntry(document, setting) {
  const entry = document?.settings?.[setting.name];
  return isObject(entry) && setting.values.includes(entry.value) ? entry : null;
}

// A recorded line's value as one of the setting's values, or null when it records none.
function recordedValue(setting, text) {
  if (typeof text !== "string") return null;
  const value = text.trim().toLowerCase();
  const resolved = Object.hasOwn(setting.aliases, value) ? setting.aliases[value] : value;
  return setting.values.includes(resolved) ? resolved : null;
}

// The values a project records under ## Interaction in its .prism/workflow.md, by setting name; an unreadable configuration records none.
async function recordedValues(projectRoot) {
  const config = await readWorkflowConfig(projectRoot).catch(() => null);
  const lines = Object.entries(config?.sections?.Interaction ?? {}).map(([label, value]) => [label.trim().toLowerCase(), value]);
  const recorded = {};
  for (const setting of PERSONAL_SETTINGS) {
    const line = lines.find(([label]) => label === setting.label.toLowerCase());
    const value = line ? recordedValue(setting, line[1]) : null;
    if (value !== null) recorded[setting.name] = value;
  }
  return recorded;
}

function answer(document, recorded, adopted, problem) {
  const settings = {};
  const sources = {};
  for (const setting of PERSONAL_SETTINGS) {
    const entry = problem ? null : personalEntry(document, setting);
    if (entry) {
      settings[setting.name] = entry.value;
      sources[setting.name] = entry.source === "adopted" ? "adopted" : "chosen";
    } else if (Object.hasOwn(recorded, setting.name)) {
      settings[setting.name] = recorded[setting.name];
      sources[setting.name] = "repository";
    } else {
      settings[setting.name] = setting.default;
      sources[setting.name] = "default";
    }
  }
  return { settings, sources, adopted, problem };
}

// Runs an action under the settings file's lock, which every process of the machine shares.
async function withSettingsLock(file, action) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withArtifactLock(file, () => withFileLock(file, action, (code, message) => new PersonalSettingsError(code, message), { timeoutMs: LOCK_TIMEOUT_MS }));
}

const write = (file, document) => writeAtomically(file, `${JSON.stringify({ ...document, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });

const missing = (document, recorded) => PERSONAL_SETTINGS.filter((setting) => Object.hasOwn(recorded, setting.name) && !personalEntry(document, setting));

/**
 * The effective value and source of every personal setting: the personal value, else the value the named project records, else the default.
 * A read that names a project adopts each value the project records for a setting without a personal value, once, under the file's lock.
 */
export async function readPersonalSettings({ projectRoot = null, env = process.env, now = () => new Date() } = {}) {
  const file = personalSettingsFile(env);
  const root = projectRoot === null || projectRoot === undefined ? null : await realpath(projectRoot);
  const recorded = root === null ? {} : await recordedValues(root);
  const first = await readDocument(file);
  if (first.problem || missing(first.document, recorded).length === 0) return answer(first.document, recorded, [], first.problem);
  return withSettingsLock(file, async () => {
    const { document, problem } = await readDocument(file);
    if (problem) return answer(document, recorded, [], problem);
    const adopting = missing(document, recorded);
    if (adopting.length === 0) return answer(document, recorded, [], null);
    const at = now().toISOString();
    const next = { schemaVersion: SCHEMA_VERSION, ...(document ?? {}), settings: { ...(document?.settings ?? {}) } };
    for (const setting of adopting) next.settings[setting.name] = { value: recorded[setting.name], source: "adopted", at, from: root };
    await write(file, next);
    return answer(next, recorded, adopting.map((setting) => setting.name), null);
  });
}

// The first setting a change cannot apply, as an invalid_setting refusal, or null when every name and value is a setting's.
function refusedChange(change) {
  if (!isObject(change) || Object.keys(change).length === 0) return new PersonalSettingsError("invalid_setting", "settings must name at least one personal setting and its value.", { setting: null });
  for (const [name, value] of Object.entries(change)) {
    const setting = BY_NAME.get(name);
    if (!setting) return new PersonalSettingsError("invalid_setting", `${name} is not a personal setting; the settings are ${PERSONAL_SETTINGS.map((item) => item.name).join(", ")}.`, { setting: name });
    if (!setting.values.includes(value)) return new PersonalSettingsError("invalid_setting", `${name} takes one of ${setting.values.join(", ")}, not ${JSON.stringify(value)}.`, { setting: name });
  }
  return null;
}

/** Write each named setting as the person's chosen value, keeping every other entry, and answer as a read without a project does. */
export async function updatePersonalSettings(change, { env = process.env, now = () => new Date() } = {}) {
  const refused = refusedChange(change);
  if (refused) throw refused;
  const file = personalSettingsFile(env);
  return withSettingsLock(file, async () => {
    const { document, problem } = await readDocument(file);
    if (problem) throw new PersonalSettingsError(problem.code, problem.message);
    const at = now().toISOString();
    const next = { schemaVersion: SCHEMA_VERSION, ...(document ?? {}), settings: { ...(document?.settings ?? {}) } };
    for (const [name, value] of Object.entries(change)) next.settings[name] = { value, source: "chosen", at };
    await write(file, next);
    return answer(next, {}, [], null);
  });
}
