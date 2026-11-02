import { card, escapeHtml } from "./util.js";

// Tiles in display order; durations format as hours, minutes, and seconds, and counts in compact notation.
const MEASURES = [
  ["runs", "Runs", "count"],
  ["wallTimeMs", "Wall time", "duration"],
  ["elapsedActiveTimeMs", "Elapsed active", "duration"],
  ["summedActiveTimeMs", "Summed active", "duration"],
  ["inputTokens", "Input tokens", "count"],
  ["cacheWriteTokens", "Cache write", "count"],
  ["cacheReadTokens", "Cache read", "count"],
  ["outputTokens", "Output tokens", "count"],
  ["toolCalls", "Tool calls", "count"]
];
const SCOPE_LABELS = { wave: "Run totals", slice: "This slice", descendants: "With descendants", initiative: "Run totals" };
const UNAVAILABLE = { value: null, coverage: "unavailable" };
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function formatDuration(ms) {
  if (ms > 0 && ms < 1000) return "&lt; 1 s";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}

// An unavailable measure shows a dash, never 0; every other mark shows its value, including a real 0.
function tile([key, label, format], measure = UNAVAILABLE) {
  const unavailable = measure.coverage === "unavailable" || typeof measure.value !== "number";
  const value = unavailable ? "—" : format === "duration" ? formatDuration(measure.value) : compact.format(measure.value);
  const title = !unavailable && format === "count" ? ` title="${measure.value}"` : "";
  return `<div class="stat run-total${unavailable ? " is-unavailable" : ""}" data-measure="${key}" data-coverage="${escapeHtml(measure.coverage)}">
        <span class="stat-value"${title}>${value}</span>
        <span class="stat-label">${label}</span>
        <span class="run-coverage">${escapeHtml(measure.coverage)}</span>
      </div>`;
}

/** Renders one totals object for a scope (wave, slice, descendants, or initiative), or "" without totals. */
export function runTotalsHtml(totals, scope) {
  if (!totals) return "";
  if (totals.runs?.value === 0 && totals.runs.coverage === "exact") {
    return `<p class="run-totals-empty" data-run-totals="${scope}">No run recorded yet.</p>`;
  }
  return `<div class="run-totals" data-run-totals="${scope}">
    <p class="eyebrow">${SCOPE_LABELS[scope]}</p>
    <div class="stat-row compact">
      ${MEASURES.map((entry) => tile(entry, totals[entry[0]])).join("")}
    </div>
    <p class="run-totals-note">Active time excludes idle gaps over ${formatDuration(totals.idleThresholdMs)}.</p>
  </div>`;
}

/**
 * Selects one wave's totals: its entry, the no-run state when the slice's run count is exact, otherwise every measure
 * unavailable, because an unreadable record may hold the wave's runs; `null` without slice totals.
 */
export function waveRunTotals(runTotals, waveId) {
  if (!runTotals) return null;
  const entry = runTotals.waves.find((item) => item.wave === waveId);
  if (entry) return entry.totals;
  const none = runTotals.slice.runs.coverage === "exact";
  return {
    ...Object.fromEntries(MEASURES.map(([key]) => [key, UNAVAILABLE])),
    ...(none ? { runs: { value: 0, coverage: "exact" } } : {}),
    idleThresholdMs: runTotals.slice.idleThresholdMs
  };
}

/** Renders the slice page's run-totals card, adding the descendants scope for a slice with children, or "" without totals. */
export function sliceRunTotalsHtml(runTotals, hasChildren) {
  if (!runTotals) return "";
  return card("Run totals", `${runTotalsHtml(runTotals.slice, "slice")}${hasChildren ? runTotalsHtml(runTotals.withDescendants, "descendants") : ""}`);
}
