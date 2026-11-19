import { escapeHtml, messageHtml } from "./util.js";

// The marks of an artifact that breaks its format: a badge on each row that names it, and a banner above its document, built from the kit's badge, banner, and chip.
// A mark is { rules, findings } as the server lists it on the artifact's record, or null while the artifact conforms.

// A finding that an agent reported is its own plain text, shown as written and never read for code subjects or markup.
const findingMessage = (finding) => String(finding.rule ?? "").endsWith(".reported") ? escapeHtml(finding.message) : messageHtml(finding.message);

/** Each finding as one line: its rule id as a chip, its message, and its line when it has one. */
export function findingsList(findings) {
  const lines = (findings ?? []).map((finding) => `<li class="format-finding"><prism-chip tone="warning" data-code-subject>${escapeHtml(finding.rule)}</prism-chip><span class="format-finding-message">${findingMessage(finding)}${Number.isInteger(finding.line) ? ` <span class="muted">· line ${finding.line}</span>` : ""}</span></li>`).join("");
  return `<ul class="format-findings">${lines}</ul>`;
}

/** The row mark of an artifact that breaks its format, naming its broken rules in its note, which the badge carries as its title, or nothing while it conforms. */
export function formatBadge(format) {
  if (!format) return "";
  return `<prism-badge data-format-mark tone="warning" note="${escapeHtml((format.rules ?? []).join(", "))}">Breaks its format</prism-badge>`;
}

/** The row mark as an element, for lists that the page builds from elements. */
export function formatBadgeElement(format) {
  if (!format) return null;
  const badge = document.createElement("prism-badge");
  badge.dataset.formatMark = "";
  badge.setAttribute("tone", "warning");
  badge.setAttribute("note", (format.rules ?? []).join(", "));
  badge.textContent = "Breaks its format";
  return badge;
}

/** The banner above the document of an artifact that breaks its format, one line per finding, or nothing while it conforms. */
export function formatBanner(format) {
  if (!format) return "";
  return `<div class="document-notice"><prism-banner data-format-mark tone="warning" heading="This file breaks its format">${findingsList(format.findings)}</prism-banner></div>`;
}
