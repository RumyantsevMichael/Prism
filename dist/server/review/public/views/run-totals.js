// Generated from src/server/review/public/views/run-totals.ts by scripts/native-build/compile.mjs.
import { card, escapeHtml } from "./util.js";
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
const MARKS = { approximate: "\u2248", partial: "\u2265" };
const COVERAGE_NAMES = { exact: "exact", approximate: "approximate", partial: "partial, some records could not be read", unavailable: "unavailable" };
const compact = new Intl.NumberFormat(void 0, { notation: "compact", maximumFractionDigits: 1 });
function formatDuration(ms) {
  if (ms > 0 && ms < 1e3) return "&lt; 1 s";
  const seconds = Math.round(ms / 1e3);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}
function cell([key, label, format, group], measure = UNAVAILABLE) {
  const unavailable = measure.coverage === "unavailable" || typeof measure.value !== "number";
  const coverage = unavailable ? "unavailable" : measure.coverage;
  const value = unavailable ? "\u2014" : format === "duration" ? formatDuration(measure.value) : compact.format(measure.value);
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
function rowHtml({ totals, scope }) {
  const label = `<th scope="row">${SCOPE_LABELS[scope]}</th>`;
  if (noRuns(totals)) return `<tr class="run-totals-empty" data-run-totals="${scope}">${label}<td class="prism-table-note" colspan="${MEASURES.length}">No run recorded yet.</td></tr>`;
  return `<tr class="run-totals" data-run-totals="${scope}">${label}${MEASURES.map((entry) => cell(entry, totals[entry[0]])).join("")}</tr>`;
}
function noRuns(totals) {
  return totals.runs?.value === 0 && totals.runs.coverage === "exact";
}
function hasRuns(totals) {
  return Boolean(totals) && !noRuns(totals);
}
function runTotalsTableHtml(scopes, { caption = false } = {}) {
  const shown = scopes.filter(({ totals }) => totals);
  if (!shown.length) return "";
  if (shown.every(({ totals }) => noRuns(totals))) return `<p class="run-totals-empty" data-run-totals="${shown[0].scope}">No run recorded yet.</p>`;
  const idle = shown.find(({ totals }) => !noRuns(totals)).totals.idleThresholdMs;
  return `<div class="run-totals-block${caption ? " is-captioned" : ""}">${caption ? '<p class="label-caps">Run totals</p>' : ""}
    <prism-table><table aria-label="Run totals">${headHtml()}<tbody>${shown.map(rowHtml).join("")}</tbody></table></prism-table>
    <p class="run-totals-note">\u2248 approximate \xB7 \u2265 partial, some records could not be read \xB7 \u2014 unavailable; unmarked values are exact. Active time excludes idle gaps over ${formatDuration(idle)}.</p>
  </div>`;
}
function runTotalsSummary(totals) {
  if (!totals) return "";
  if (noRuns(totals)) return "No runs yet";
  const marked = (coverage, text) => `${MARKS[coverage] ? `${MARKS[coverage]} ` : ""}${text}`;
  const parts = [];
  const active = totals.elapsedActiveTimeMs;
  if (typeof active?.value === "number" && active.coverage !== "unavailable") parts.push(marked(active.coverage, `${formatDuration(active.value)} active`));
  const tokens = ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"].map((key) => totals[key]).filter((measure) => typeof measure?.value === "number" && measure.coverage !== "unavailable");
  if (tokens.length) {
    const exact = tokens.length === 4 && tokens.every((measure) => measure.coverage === "exact");
    parts.push(marked(exact ? "exact" : tokens.some((measure) => measure.coverage === "approximate") && tokens.length === 4 ? "approximate" : "partial", `${compact.format(tokens.reduce((sum, measure) => sum + measure.value, 0))} tokens`));
  }
  const runs = totals.runs;
  return parts.join(" \xB7 ") || (typeof runs?.value === "number" ? `${runs.value} ${runs.value === 1 ? "run" : "runs"}` : "Run totals");
}
function runTotalsHtml(totals, scope) {
  return runTotalsTableHtml([{ totals, scope }], { caption: true });
}
function waveRunTotals(runTotals, waveId) {
  if (!runTotals) return null;
  const entry = runTotals.waves.find((item) => item.wave === waveId);
  if (entry) return entry.totals;
  const none = runTotals.slice.runs.coverage === "exact";
  return {
    ...Object.fromEntries(MEASURES.map(([key]) => [key, UNAVAILABLE])),
    ...none ? { runs: { value: 0, coverage: "exact" } } : {},
    idleThresholdMs: runTotals.slice.idleThresholdMs
  };
}
function sliceRunTotalsHtml(runTotals, hasChildren) {
  if (!runTotals) return "";
  return card("Run totals", runTotalsTableHtml([{ totals: runTotals.slice, scope: "slice" }, ...hasChildren ? [{ totals: runTotals.withDescendants, scope: "descendants" }] : []]));
}
export {
  hasRuns,
  runTotalsHtml,
  runTotalsSummary,
  runTotalsTableHtml,
  sliceRunTotalsHtml,
  waveRunTotals
};
