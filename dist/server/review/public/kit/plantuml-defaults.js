// The default colors of the vendored PlantUML runtime, which paints them when a diagram sets none.
// Each maps to the diagram role whose --prism-color-diagram-<role> token replaces it, or to null for a color the theming keeps.
// The runtime renders its version as a placeholder, so the version is pinned here beside the table it was read from;
// test/server/review-diagram-theme-browser.test.mjs fails when a new runtime paints other defaults.

/** The vendored runtime's version. */
export const PLANTUML_RUNTIME = "1.2026.8";

/** The color of the runtime's default text, which the theming treats by the ground it sits on. */
export const PLANTUML_TEXT = "#000000";

/** Each default color, as upper-case hex, mapped to its diagram role or kept. */
export const PLANTUML_DEFAULTS = Object.freeze({
  // Transparent fills and strokes, such as a participant's lifeline box.
  "#00000000": null,
  // Default text, a class's member lines, and a group's frame; text keeps it on an author's fill it reads on.
  "#000000": null,
  // Lines, arrows, and borders.
  "#181818": "line",
  // The start and stop dots of an activity.
  "#222222": "line",
  // Participants, actors, and the boxes of an error diagram.
  "#E2E2F0": "surface-2",
  // Group headers and dividers of a sequence.
  "#EEEEEE": "group",
  // Classes, components, activities, and decisions.
  "#F1F1F1": "surface",
  // Notes.
  "#FEFFDD": "note",
  // The marks of a class (C), an interface (I), and a public member, which carry their own meaning.
  "#ADD1B2": null,
  "#B4A7E5": null,
  "#038048": null
});
