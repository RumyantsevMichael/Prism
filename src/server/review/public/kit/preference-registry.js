// The user's preferences in the review app: every choice that says how this person likes the app to look and behave, declared once.
// The review page and the review app both read this list, so the page offers and the app stores exactly these keys and values.
// A preference holds for every project, port, and window of this user on this machine; what belongs to one page, such as its folds,
// its filters, or a draft, is that page's view state instead and stays with its open tab.
// Each entry names its key, its kind, and its default: an enum lists its values, a boolean is true or false, an integer has a minimum and a maximum,
// and a set lists its allowed items, or has none to take any short names, such as roadmap band names that each workspace defines.

const SHORT_NAME = 120;
const SET_LIMIT = 64;

export const PREFERENCES = Object.freeze({
  theme: Object.freeze({ kind: "enum", values: Object.freeze(["system", "light", "dark"]), default: "system" }),
  density: Object.freeze({ kind: "enum", values: Object.freeze(["compact", "comfortable"]), default: "compact" }),
  "sidebar.collapsed": Object.freeze({ kind: "boolean", default: false }),
  "sidePanel.width": Object.freeze({ kind: "integer", min: 320, max: 4096, default: null }),
  "roadmap.view": Object.freeze({ kind: "enum", values: Object.freeze(["board", "list", "graph"]), default: "board" }),
  "roadmap.showArchived": Object.freeze({ kind: "boolean", default: false }),
  "roadmap.collapsedLanes": Object.freeze({ kind: "set", default: Object.freeze([]) }),
  "initiative.view": Object.freeze({ kind: "enum", values: Object.freeze(["board", "list", "graph"]), default: "board" }),
  "changeMap.view": Object.freeze({ kind: "enum", values: Object.freeze(["list", "graph"]), default: "list" }),
  "changeMap.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["action", "file"]), default: "action" })
});

export const DEFAULT_PREFERENCES = Object.freeze(Object.fromEntries(Object.entries(PREFERENCES).map(([key, entry]) => [key, entry.default])));

/** Why a value does not fit its preference, or "" when it does. A default of null, such as a width the person never set, is always allowed. */
export function preferenceProblem(key, value) {
  const entry = Object.hasOwn(PREFERENCES, key) ? PREFERENCES[key] : null;
  if (!entry) return `${key} is not a preference.`;
  if (value === null && entry.default === null) return "";
  switch (entry.kind) {
    case "enum":
      return entry.values.includes(value) ? "" : `${key} must be one of ${entry.values.join(", ")}.`;
    case "boolean":
      return typeof value === "boolean" ? "" : `${key} must be true or false.`;
    case "integer":
      return Number.isInteger(value) && value >= entry.min && value <= entry.max ? "" : `${key} must be a whole number from ${entry.min} to ${entry.max}.`;
    case "set":
      if (!Array.isArray(value) || value.length > SET_LIMIT || new Set(value).size !== value.length) return `${key} must be a list of at most ${SET_LIMIT} different names.`;
      if (value.some((item) => typeof item !== "string" || !item || item.length > SHORT_NAME || (entry.values && !entry.values.includes(item)))) return `${key} must list ${entry.values ? `only ${entry.values.join(", ")}` : `names of at most ${SHORT_NAME} characters`}.`;
      return "";
    default:
      return `${key} has an unknown kind.`;
  }
}

/** Every preference, with the default for each value that is missing or does not fit. */
export function normalizePreferences(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(PREFERENCES).map(([key, entry]) => [key, Object.hasOwn(source, key) && !preferenceProblem(key, source[key]) ? source[key] : entry.default]));
}

/** The keys and values of a change, or an error that names the first key or value that does not fit; a change gives at least one preference. */
export function checkPreferenceChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) return { error: "The preferences must be a JSON object that gives one or more preferences." };
  const keys = Object.keys(change);
  if (!keys.length) return { error: "Give one or more preferences." };
  for (const key of keys) {
    const problem = preferenceProblem(key, change[key]);
    if (problem) return { error: problem };
  }
  return { change: Object.fromEntries(keys.map((key) => [key, change[key]])) };
}
