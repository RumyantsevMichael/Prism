import { escapeHtml, messageHtml } from "./util.js";

// The marks of an artifact that breaks its format: a badge on each row that names it, and a banner above its document, built from the kit's badge, banner, and chip.
// A mark is { rules, findings } as the server lists it on the artifact's record, or null while the artifact conforms.

// A finding that an agent reported is its own plain text, shown as written and never read for code subjects or markup.
const findingMessage = (finding: any) => String(finding.rule ?? "").endsWith(".reported") ? escapeHtml(finding.message) : messageHtml(finding.message);

/** Each finding as one line: its rule id as a chip, its message, and its line when it has one. */
export function findingsList(findings: any) {
  const lines = (findings ?? []).map((finding: any) => `<li class="format-finding"><prism-chip tone="warning" data-code-subject>${escapeHtml(finding.rule)}</prism-chip><span class="format-finding-message">${findingMessage(finding)}${Number.isInteger(finding.line) ? ` <span class="muted">· line ${finding.line}</span>` : ""}</span></li>`).join("");
  return `<ul class="format-findings">${lines}</ul>`;
}

// The most findings that a mark's note spells out; the rest it counts.
const NOTE_FINDINGS = 3;
// A finding's message as plain text, with the backticks of its code subjects left out.
const plainMessage = (finding: any) => String(finding.message ?? "").replace(/`/g, "").trim();

/**
 * What a mark's note says: each finding's message with its line and rule, the first NOTE_FINDINGS of them, and how many more there are,
 * or the broken rules for a mark that lists no findings.
 */
export function formatNote(format: any) {
  const findings = (format?.findings ?? []).filter((finding: any) => finding && typeof finding.message === "string" && finding.message);
  if (!findings.length) return (format?.rules ?? []).join(", ");
  const lines = findings.slice(0, NOTE_FINDINGS).map((finding: any) => `${Number.isInteger(finding.line) ? `Line ${finding.line}: ` : ""}${plainMessage(finding)}${finding.rule ? ` (${finding.rule})` : ""}`);
  const more = findings.length - NOTE_FINDINGS;
  return [...lines, ...(more > 0 ? [`and ${more} more`] : [])].join("\n");
}

/** The row mark of an artifact that breaks its format, saying what breaks in its note, which the badge carries as its title, or nothing while it conforms. */
export function formatBadge(format: any) {
  if (!format) return "";
  return `<prism-badge data-format-mark tone="warning" note="${escapeHtml(formatNote(format))}">Breaks its format</prism-badge>`;
}

/** The row mark as an element, for lists that the page builds from elements. */
export function formatBadgeElement(format: any) {
  if (!format) return null;
  const badge = document.createElement("prism-badge");
  badge.dataset.formatMark = "";
  badge.setAttribute("tone", "warning");
  badge.setAttribute("note", formatNote(format));
  badge.textContent = "Breaks its format";
  return badge;
}

/** The banner above the document of an artifact that breaks its format, one line per finding, or nothing while it conforms; heading names the file where a page shows several. */
export function formatBanner(format: any, heading = "This file breaks its format") {
  if (!format) return "";
  return `<div class="document-notice"><prism-banner data-format-mark tone="warning" heading="${escapeHtml(heading)}">${findingsList(format.findings)}</prism-banner></div>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayText(value: any) {
  const day = new Date(value ?? "");
  return value && !Number.isNaN(day.getTime()) ? `${day.getDate()} ${MONTHS[day.getMonth()]} ${day.getFullYear()}` : "";
}

/**
 * The note above the document of a store artifact whose accepted version a format migration run recorded: that Prism migrated it, when, and a link to the run's page,
 * or nothing for any other file. review is the read's artifact review, which names the run as acceptedFrom { migration, at }.
 */
export function migratedNote(review: any) {
  const from = review?.acceptedFrom;
  if (!from || typeof from.migration !== "string") return "";
  const ref = `migration-run:${from.migration}`;
  const day = dayText(from.at);
  const kept = review.changed ? "The file changed since, so its accepted version is still the migrated file." : "Its accepted version is the migrated file, so its status stays as a person decided it.";
  return `<div class="document-notice"><prism-banner tone="info" heading="Prism migrated this file into its format"><p>${day ? `On ${escapeHtml(day)}. ` : ""}${kept} <a href="./review?artifact=${encodeURIComponent(ref)}" data-doc-link="${escapeHtml(ref)}">See what changed and why</a></p></prism-banner></div>`;
}
