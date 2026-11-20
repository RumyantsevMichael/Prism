// Generated from src/server/workflow/view-limits.mts by scripts/native-build/compile.mjs.
const STRUCTURE = Object.freeze({ elements: { counted: "elements", limit: 30 }, relations: { counted: "relations", limit: 50 } });
const NONE = Object.freeze({ counted: "none", limit: null });
const VIEW_LIMITS = Object.freeze({
  sequence: { elements: { counted: "participants", limit: 10 }, relations: { counted: "messages", limit: 30 } },
  activity: { elements: { counted: "actions and decisions", limit: 30 }, relations: NONE },
  state: { elements: { counted: "states", limit: 20 }, relations: { counted: "transitions", limit: 40 } },
  component: STRUCTURE,
  deployment: STRUCTURE,
  code: STRUCTURE,
  "data-model": STRUCTURE,
  wireframe: { elements: { counted: "widgets", limit: 60 }, relations: NONE },
  api: { elements: { counted: "operations", limit: 30 }, relations: NONE }
});
const article = (kind) => /^[aeiou]/.test(kind) ? "an" : "a";
function exceeded(kind, counts, share) {
  const limits = VIEW_LIMITS[kind];
  if (!limits) return [];
  return ["elements", "relations"].flatMap((name) => {
    const { counted, limit } = limits[name];
    const count = counts[name] ?? 0;
    return limit !== null && count > limit * share ? [{ counted, count, limit }] : [];
  });
}
function limitProblems(file, kind, counts) {
  return exceeded(kind, counts, 1).map(({ counted, count, limit }) => `${file} shows ${count} ${counted}, more than ${limit} for ${article(kind)} ${kind} view. Split it into views a person can read.`);
}
const isDense = (kind, counts) => exceeded(kind, counts, 2 / 3).length > 0;
const denseCounts = (kind, counts) => exceeded(kind, counts, 2 / 3).map(({ counted, count, limit }) => `${count} ${counted}, more than two thirds of the limit of ${limit} for ${article(kind)} ${kind} view`);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const HTTP_METHODS = /* @__PURE__ */ new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
function countApi(document) {
  if (!isObject(document) || !isObject(document.info)) return null;
  if (typeof document.openapi === "string" && /^3\.[01]\.\d+/.test(document.openapi) && isObject(document.paths)) {
    return Object.values(document.paths).reduce((total, item) => total + (isObject(item) ? Object.keys(item).filter((key) => HTTP_METHODS.has(key)).length : 0), 0);
  }
  if (typeof document.asyncapi === "string" && /^[23]\.\d+\.\d+/.test(document.asyncapi) && isObject(document.channels)) {
    if (document.asyncapi.startsWith("3.")) return isObject(document.operations) ? Object.keys(document.operations).length : 0;
    return Object.values(document.channels).reduce((total, channel) => total + (isObject(channel) ? ["publish", "subscribe"].filter((key) => isObject(channel[key])).length : 0), 0);
  }
  return null;
}
const GRID_OPEN = /\{(?:\^"[^"]*"|[+#!\-/*T]|S[ih]?)?/g;
const SEPARATOR = /^(?:-{2,}|={2,}|\.{2,}|~{2,})$/;
function countWireframe(source) {
  let widgets = 0;
  for (const line of String(source ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /^@(?:start|end)salt\b/i.test(text) || text.startsWith("'")) continue;
    for (const cell of text.replace(GRID_OPEN, "|").replace(/\}/g, "|").split("|")) {
      const value = cell.trim();
      if (value && value !== "." && !SEPARATOR.test(value)) widgets += 1;
    }
  }
  return widgets;
}
export {
  VIEW_LIMITS,
  countApi,
  countWireframe,
  denseCounts,
  isDense,
  limitProblems
};
