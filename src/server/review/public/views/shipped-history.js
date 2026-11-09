import { escapeHtml } from "./util.js";

// A shipped initiative's pages record finished work, so each one carries the shipped history label above its content,
// and a slice document edited after ship says so.

/** The shipped history label of a page, or "" when the page is not shipped history. */
export function shippedHistoryHtml(shippedHistory) {
  if (shippedHistory === null || shippedHistory === undefined) return "";
  const changed = shippedHistory.changedAfterShip === true ? '<p class="shipped-history-changed">This document changed after the initiative shipped.</p>' : "";
  return `<aside class="shipped-history" role="note"><p class="shipped-history-label">${escapeHtml(shippedHistory.label ?? "")}</p>${changed}</aside>`;
}
