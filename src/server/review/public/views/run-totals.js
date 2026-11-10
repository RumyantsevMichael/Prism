import { card, escapeHtml } from "./util.js";

// Columns in display order; durations format as hours, minutes, and seconds, and counts in compact notation.
// Active time and tokens each head a group of columns, so the header names a group once and each column by its part.
const MEASURES = [
  ["runs", "Runs", "count", ""],
  ["wallTimeMs", "Wall time", "duration", ""],
  ["elapsedActiveTimeMs", "Elapsed", "duration", "Active time"],
  ["summedActiveTimeMs", "Summed", "duration", "Active time"],
  ["inputTokens", "Input", "count", "Tokens"],
  ["cacheWriteTokens", "Cache write", "count", "Tokens"],
  ["cacheReadTokens", "Cache read", "count", "Tokens"],
  ["outputTokens", "Output", "count", "Tokens"],
  ["toolCalls", "Tool calls", "count", ""]
];
const SCOPE_LABELS = { wave: "This wave", slice: "This slice", descendants: "With descendants", initiative: "This initiative" };
const UNAVAILABLE = { value: null, coverage: "unavailable" };
// An exact value carries no visible mark; every other coverage marks its value, and the legend under the table names the marks.
const MARKS = { approximate: "≈", partial: "≥" };
const COVERAGE_NAMES = { exact: "exact", approximate: "approximate", partial: "partial, some records could not be read", unavailable: "unavailable" };
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

// An unavailable measure shows a dash, never 0; every other cell shows its value, including a real 0, and its tip gives the full count and its coverage.
function cell([key, label, format, group], measure = UNAVAILABLE) {
  const unavailable = measure.coverage === "unavailable" || typeof measure.value !== "number";
  const coverage = unavailable ? "unavailable" : measure.coverage;
  const value = unavailable ? "—" : format === "duration" ? formatDuration(measure.value) : compact.format(measure.value);
  const full = !unavailable && format === "count" && String(measure.value) !== value ? String(measure.value) : value;
  const mark = MARKS[coverage] ? `<span class="prism-table-mark" aria-hidden="true">${MARKS[coverage]}</span>` : "";
  const name = group ? `${group}, ${label.toLowerCase()}` : label;
  const tip = `${name}: ${full}, ${COVERAGE_NAMES[coverage] ?? coverage}`;
  const shown = unavailable ? `<span class="run-total-value">${value}</span>` : `<data class="run-total-value" value="${measure.value}" tip="${tip}">${value}</data>`;
  return `<td class="run-total${unavailable ? " is-unavailable" : ""}" data-measure="${key}" data-coverage="${escapeHtml(coverage)}" data-value="${value}" data-label="${name}">${mark}${shown}<span class="sr-only">, ${escapeHtml(COVERAGE_NAMES[coverage] ?? coverage)}</span></td>`;
}

function headHtml() {
  const groups = [];
  for (const [, label, , group] of MEASURES) {
    const last = groups.at(-1);
    if (group && last?.group === group) last.span += 1;
    else groups.push({ group, label, span: 1 });
  }
  const top = groups.map(({ group, label, span }) => group ? `<th scope="colgroup" colspan="${span}">${group}</th>` : `<th scope="col" rowspan="2">${label}</th>`).join("");
  const parts = MEASURES.filter(([, , , group]) => group).map(([, label]) => `<th scope="col">${label}</th>`).join("");
  return `<thead><tr><td rowspan="2"></td>${top}</tr><tr>${parts}</tr></thead>`;
}

// A scope with no recorded run says so across the row instead of showing zero cost.
function rowHtml({ totals, scope }) {
  const label = `<th scope="row">${SCOPE_LABELS[scope]}</th>`;
  if (noRuns(totals)) return `<tr class="run-totals-empty" data-run-totals="${scope}">${label}<td class="prism-table-note" colspan="${MEASURES.length}">No run recorded yet.</td></tr>`;
  return `<tr class="run-totals" data-run-totals="${scope}">${label}${MEASURES.map((entry) => cell(entry, totals[entry[0]])).join("")}</tr>`;
}

function noRuns(totals) {
  return totals.runs?.value === 0 && totals.runs.coverage === "exact";
}

/**
 * Renders the run totals of one or more scopes (wave, slice, descendants, or initiative) as one compact table, a row per scope,
 * or one line when no scope has a recorded run; "" without totals.
 */
export function runTotalsTableHtml(scopes, { caption = false } = {}) {
  const shown = scopes.filter(({ totals }) => totals);
  if (!shown.length) return "";
  if (shown.every(({ totals }) => noRuns(totals))) return `<p class="run-totals-empty" data-run-totals="${shown[0].scope}">No run recorded yet.</p>`;
  const idle = shown.find(({ totals }) => !noRuns(totals)).totals.idleThresholdMs;
  return `<div class="run-totals-block${caption ? " is-captioned" : ""}">${caption ? '<p class="label-caps">Run totals</p>' : ""}
    <prism-table><table aria-label="Run totals">${headHtml()}<tbody>${shown.map(rowHtml).join("")}</tbody></table></prism-table>
    <p class="run-totals-note">≈ approximate · ≥ partial, some records could not be read · — unavailable; unmarked values are exact. Active time excludes idle gaps over ${formatDuration(idle)}.</p>
  </div>`;
}

/** Renders one totals object for a scope (wave, slice, descendants, or initiative) under its caption, or "" without totals. */
export function runTotalsHtml(totals, scope) {
  return runTotalsTableHtml([{ totals, scope }], { caption: true });
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
  return card("Run totals", runTotalsTableHtml([{ totals: runTotals.slice, scope: "slice" }, ...(hasChildren ? [{ totals: runTotals.withDescendants, scope: "descendants" }] : [])]));
}
