// Generated from src/server/review/public/views/places.ts by scripts/native-build/compile.mjs.
const PLACES = Object.freeze([
  { name: "attention", label: "Attention", icon: "bell", subtitle: "What waits on you" },
  { name: "work", label: "Work", icon: "tree", subtitle: "Designed and not shipped" },
  { name: "roadmap", label: "Roadmap", icon: "roadmap", subtitle: "Priorities by lane" },
  { name: "knowledge", label: "Knowledge", icon: "book", subtitle: "Requirements, decisions, glossary" },
  { name: "history", label: "History", icon: "clock", subtitle: "Shipped and superseded" }
].map((place) => Object.freeze(place)));
const DEFAULT_PLACE = "attention";
function placeNamed(name) {
  return PLACES.find((place) => place.name === name) ?? null;
}
const SETTLED = /* @__PURE__ */ new Set(["shipped", "superseded"]);
function placeOf(ref, { context = null, initiatives = [] } = {}) {
  if (context && Object.hasOwn(context, "place")) return context.place;
  if (typeof ref !== "string" || !ref) return null;
  if (ref === "attention" || ref.startsWith("attention:")) return "attention";
  if (ref === "roadmap") return "roadmap";
  if (["requirements", "decisions", "glossary"].includes(ref) || ref.startsWith("knowledge:")) return "knowledge";
  const match = /^(?:initiative|slice):([A-Za-z0-9_-]+)/.exec(ref);
  if (!match) return null;
  const initiative = initiatives.find((item) => item.id === match[1]);
  if (initiative?.place) return initiative.place;
  if (initiative && SETTLED.has(initiative.state)) return "history";
  return initiative?.tree ? "work" : "roadmap";
}
export {
  DEFAULT_PLACE,
  PLACES,
  placeNamed,
  placeOf
};
