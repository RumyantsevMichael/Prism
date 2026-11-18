// A person at the design gate follows a view only up to a point, and what they follow differs by kind: the participants and messages of a sequence,
// the actions and decisions of an activity, the states and transitions of a state machine, the elements and relations of a structure,
// the widgets of a wireframe, and the operations of an API.
const STRUCTURE = Object.freeze({ elements: { counted: "elements", limit: 30 }, relations: { counted: "relations", limit: 50 } });
const NONE = Object.freeze({ counted: "none", limit: null });

/** The readability limits of each view kind: what its elements and relations count, and how many a person follows. */
export const VIEW_LIMITS = Object.freeze({
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

/** The counts of a view beyond its kind's limits, as { counted, count, limit } each. */
function exceeded(kind, counts, share) {
  const limits = VIEW_LIMITS[kind];
  if (!limits) return [];
  return ["elements", "relations"].flatMap((name) => {
    const { counted, limit } = limits[name];
    const count = counts[name] ?? 0;
    return limit !== null && count > limit * share ? [{ counted, count, limit }] : [];
  });
}

/** The problems of a view beyond a readability limit of its kind, one per count. */
export function limitProblems(file, kind, counts) {
  return exceeded(kind, counts, 1).map(({ counted, count, limit }) => `${file} shows ${count} ${counted}, more than ${limit} for ${article(kind)} ${kind} view. Split it into views a person can read.`);
}

/** Whether a view's count exceeds two thirds of a limit of its kind, which suggests the slice it explains is too large to stay whole. */
export const isDense = (kind, counts) => exceeded(kind, counts, 2 / 3).length > 0;

/** The counts that make a view dense, as `<count> <counted>, more than two thirds of <limit>`. */
export const denseCounts = (kind, counts) => exceeded(kind, counts, 2 / 3).map(({ counted, count, limit }) => `${count} ${counted}, more than two thirds of the limit of ${limit} for ${article(kind)} ${kind} view`);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * The operations of an API specification: each HTTP method under each OpenAPI 3.0 or 3.1 path, each entry of an AsyncAPI 3 document's operations,
 * and each publish or subscribe of an AsyncAPI 2 channel; null when the document is no OpenAPI 3 or AsyncAPI 2 or 3 document with info and paths or channels.
 */
export function countApi(document) {
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

// A grid opens with `{` and a marker such as `+`, `#`, `!`, `-`, `/`, `*`, `T`, or `^"title"`, and its cells are separated by `|`.
const GRID_OPEN = /\{(?:\^"[^"]*"|[+#!\-/*T]|S[ih]?)?/g;
const SEPARATOR = /^(?:-{2,}|={2,}|\.{2,}|~{2,})$/;

/** The widgets of a Salt wireframe: the non-empty cells of its grids, without the `.` that leaves a cell empty or a separator line. */
export function countWireframe(source) {
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
