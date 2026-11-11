// The review app's places: each answers one question the person brings, has an icon on the rail, and heads its own sidebar.
// The rail, the drawer, the trail, and the stored choice all read this list, so a new place is one entry here and its sidebar's builder in review.js.

/** The places in rail order: `name` is the value in the address and in storage, `label` the title and rail name, `icon` a prism-icon name. */
export const PLACES = Object.freeze([
  { name: "attention", label: "Attention", icon: "bell", subtitle: "What waits on you" },
  { name: "work", label: "Work", icon: "tree", subtitle: "Designed and not shipped" },
  { name: "roadmap", label: "Roadmap", icon: "roadmap", subtitle: "Priorities by lane" },
  { name: "knowledge", label: "Knowledge", icon: "book", subtitle: "Requirements, decisions, glossary" },
  { name: "history", label: "History", icon: "clock", subtitle: "Shipped and superseded" }
].map((place) => Object.freeze(place)));

/** The place shown when the browser stored none. */
export const DEFAULT_PLACE = "attention";

/** The place named `name`, or null for a value that is not a place. */
export function placeNamed(name) {
  return PLACES.find((place) => place.name === name) ?? null;
}

/** The decisions that move an initiative from Work to History. */
const SETTLED = new Set(["shipped", "superseded"]);

/**
 * The place a page belongs to, as the review server names it: Attention's pages, the Roadmap, Knowledge's lists and records,
 * an initiative's pages by whether it is worked on, settled, or only planned, and null for any other page.
 * `context` is the page's context from the server when it has one, and `initiatives` the navigation's initiatives with their `place`.
 */
export function placeOf(ref, { context = null, initiatives = [] } = {}) {
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
