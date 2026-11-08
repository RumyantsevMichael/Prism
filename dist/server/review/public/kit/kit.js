// The review app's kit: one prism-* custom element per kind of control, defined from KIT_ELEMENTS.
// The module imports without a DOM, so tests and the catalog can read KIT_ELEMENTS; in a page it defines every element and keeps the appearance in step with the system.
// appearance.js then applies the review app's stored choice.
import { startPreferences } from "./preferences.js";

/**
 * Every kit element class; each carries a static `tag` and a static `catalog` of
 * `{ purpose, options: [{ name, values, default, description }], states: [<state name>], keyboard: [<sentence>] }`.
 */
export const KIT_ELEMENTS = [];

/** Defines each kit element once; a second call, or an element that is already defined, changes nothing. */
export function defineKit(registry = globalThis.customElements) {
  if (!registry) return;
  for (const element of KIT_ELEMENTS) {
    if (!registry.get(element.tag)) registry.define(element.tag, element);
  }
}

if (globalThis.document) {
  defineKit();
  startPreferences();
}
