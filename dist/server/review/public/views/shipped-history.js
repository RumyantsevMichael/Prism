// Generated from src/server/review/public/views/shipped-history.ts by scripts/native-build/compile.mjs.
import { escapeHtml } from "./util.js";
function shippedHistoryHtml(shippedHistory) {
  if (shippedHistory === null || shippedHistory === void 0) return "";
  const changed = shippedHistory.changedAfterShip === true ? '<p class="shipped-history-changed">This document changed after the initiative shipped.</p>' : "";
  return `<prism-banner class="shipped-history" tone="warning"><p class="shipped-history-label">${escapeHtml(shippedHistory.label ?? "")}</p>${changed}</prism-banner>`;
}
export {
  shippedHistoryHtml
};
