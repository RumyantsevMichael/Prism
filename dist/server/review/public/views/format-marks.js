// Generated from src/server/review/public/views/format-marks.ts by scripts/native-build/compile.mjs.
import { escapeHtml, messageHtml } from "./util.js";
const findingMessage = (finding) => String(finding.rule ?? "").endsWith(".reported") ? escapeHtml(finding.message) : messageHtml(finding.message);
function findingsList(findings) {
  const lines = (findings ?? []).map((finding) => `<li class="format-finding"><prism-chip tone="warning" data-code-subject>${escapeHtml(finding.rule)}</prism-chip><span class="format-finding-message">${findingMessage(finding)}${Number.isInteger(finding.line) ? ` <span class="muted">\xB7 line ${finding.line}</span>` : ""}</span></li>`).join("");
  return `<ul class="format-findings">${lines}</ul>`;
}
const NOTE_FINDINGS = 3;
const plainMessage = (finding) => String(finding.message ?? "").replace(/`/g, "").trim();
function formatNote(format) {
  const findings = (format?.findings ?? []).filter((finding) => finding && typeof finding.message === "string" && finding.message);
  if (!findings.length) return (format?.rules ?? []).join(", ");
  const lines = findings.slice(0, NOTE_FINDINGS).map((finding) => `${Number.isInteger(finding.line) ? `Line ${finding.line}: ` : ""}${plainMessage(finding)}${finding.rule ? ` (${finding.rule})` : ""}`);
  const more = findings.length - NOTE_FINDINGS;
  return [...lines, ...more > 0 ? [`and ${more} more`] : []].join("\n");
}
function formatBadge(format) {
  if (!format) return "";
  return `<prism-badge data-format-mark tone="warning" note="${escapeHtml(formatNote(format))}">Breaks its format</prism-badge>`;
}
function formatBadgeElement(format) {
  if (!format) return null;
  const badge = document.createElement("prism-badge");
  badge.dataset.formatMark = "";
  badge.setAttribute("tone", "warning");
  badge.setAttribute("note", formatNote(format));
  badge.textContent = "Breaks its format";
  return badge;
}
function formatBanner(format, heading = "This file breaks its format") {
  if (!format) return "";
  return `<div class="document-notice"><prism-banner data-format-mark tone="warning" heading="${escapeHtml(heading)}">${findingsList(format.findings)}</prism-banner></div>`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayText(value) {
  const day = new Date(value ?? "");
  return value && !Number.isNaN(day.getTime()) ? `${day.getDate()} ${MONTHS[day.getMonth()]} ${day.getFullYear()}` : "";
}
function migratedNote(review) {
  const from = review?.acceptedFrom;
  if (!from || typeof from.migration !== "string") return "";
  const ref = `migration-run:${from.migration}`;
  const day = dayText(from.at);
  const kept = review.changed ? "The file changed since, so its accepted version is still the migrated file." : "Its accepted version is the migrated file, so its status stays as a person decided it.";
  return `<div class="document-notice"><prism-banner tone="info" heading="Prism migrated this file into its format"><p>${day ? `On ${escapeHtml(day)}. ` : ""}${kept} <a href="./review?artifact=${encodeURIComponent(ref)}" data-doc-link="${escapeHtml(ref)}">See what changed and why</a></p></prism-banner></div>`;
}
export {
  findingsList,
  formatBadge,
  formatBadgeElement,
  formatBanner,
  formatNote,
  migratedNote
};
