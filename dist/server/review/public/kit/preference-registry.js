// Generated from src/server/review/public/kit/preference-registry.ts by scripts/native-build/compile.mjs.
const SHORT_NAME = 120;
const SET_LIMIT = 64;
const PREFERENCES = Object.freeze({
  theme: Object.freeze({ kind: "enum", values: Object.freeze(["system", "light", "dark"]), default: "system" }),
  density: Object.freeze({ kind: "enum", values: Object.freeze(["compact", "comfortable"]), default: "compact" }),
  "sidebar.collapsed": Object.freeze({ kind: "boolean", default: false }),
  "sidebar.width": Object.freeze({ kind: "integer", min: 200, max: 480, default: null }),
  "sidePanel.width": Object.freeze({ kind: "integer", min: 320, max: 4096, default: null }),
  "roadmap.view": Object.freeze({ kind: "enum", values: Object.freeze(["board", "list", "graph"]), default: "board" }),
  "roadmap.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["band", "status"]), default: "band" }),
  "roadmap.showArchived": Object.freeze({ kind: "boolean", default: false }),
  "roadmap.collapsedLanes": Object.freeze({ kind: "set", default: Object.freeze([]) }),
  "initiative.view": Object.freeze({ kind: "enum", values: Object.freeze(["board", "list", "graph"]), default: "board" }),
  "changeMap.view": Object.freeze({ kind: "enum", values: Object.freeze(["list", "graph"]), default: "list" }),
  "changeMap.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["action", "file"]), default: "action" }),
  // A library grouped by scope in a workspace whose records lie in one scope groups as its first other choice does.
  "library.requirements.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["scope", "status", "area", "initiative", "none"]), default: "scope" }),
  "library.decisions.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["scope", "area", "status", "initiative", "none"]), default: "scope" }),
  "library.diagrams.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["scope", "owner", "kind", "none"]), default: "scope" }),
  "library.glossary.groupBy": Object.freeze({ kind: "enum", values: Object.freeze(["scope", "none"]), default: "scope" })
});
const DEFAULT_PREFERENCES = Object.freeze(Object.fromEntries(Object.entries(PREFERENCES).map(([key, entry]) => [key, entry.default])));
function preferenceProblem(key, value) {
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
      if (value.some((item) => typeof item !== "string" || !item || item.length > SHORT_NAME || entry.values && !entry.values.includes(item))) return `${key} must list ${entry.values ? `only ${entry.values.join(", ")}` : `names of at most ${SHORT_NAME} characters`}.`;
      return "";
    default:
      return `${key} has an unknown kind.`;
  }
}
function normalizePreferences(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(PREFERENCES).map(([key, entry]) => [key, Object.hasOwn(source, key) && !preferenceProblem(key, source[key]) ? source[key] : entry.default]));
}
function checkPreferenceChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) return { error: "The preferences must be a JSON object that gives one or more preferences." };
  const keys = Object.keys(change);
  if (!keys.length) return { error: "Give one or more preferences." };
  for (const key of keys) {
    const problem = preferenceProblem(key, change[key]);
    if (problem) return { error: problem };
  }
  return { change: Object.fromEntries(keys.map((key) => [key, change[key]])) };
}
export {
  DEFAULT_PREFERENCES,
  PREFERENCES,
  checkPreferenceChange,
  normalizePreferences,
  preferenceProblem
};
