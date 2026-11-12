import { escapeHtml } from "./util.js";

// A component identity is <repository>/<component>, each part a repository-style name.
const NAME = "[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?";
const IDENTITY = new RegExp(`^${NAME}/${NAME}$`);

/** The label of the component a slice records, by its <repository>/<component> identity, or "" for a slice without one. */
export function componentChip(component) {
  if (typeof component !== "string" || !IDENTITY.test(component)) return "";
  return `<prism-chip data-component="${escapeHtml(component)}">${escapeHtml(component)}</prism-chip>`;
}
