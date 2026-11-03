import { escapeHtml } from "./util.js";

// Above this many compared line pairs the diff gives up, so a huge record cannot freeze the page.
const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

const lines = (text) => text === null || text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n");

/**
 * The line operations that turn before into after: [{ op: "same" | "del" | "add", text }], or null when the texts are too large to compare.
 * Common leading and trailing lines are matched first, and the middle uses a longest common subsequence.
 */
export function diffLines(before, after) {
  const a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = a.slice(0, start).map((text) => ({ op: "same", text }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { ops.push({ op: "same", text: a[start + i] }); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) { ops.push({ op: "del", text: a[start + i] }); i++; }
    else { ops.push({ op: "add", text: b[start + j] }); j++; }
  }
  for (let k = endA; k < a.length; k++) ops.push({ op: "same", text: a[k] });
  return ops;
}

/** A unified diff table: changed lines with a few lines of context, and a fold for each longer unchanged run. */
export function diffHtml(before, after, { beforeLabel = "before", afterLabel = "after" } = {}) {
  const ops = diffLines(before, after);
  if (ops === null) return '<p class="muted">The two versions are too large to compare here. Open them side by side instead.</p>';
  if (!ops.some((entry) => entry.op !== "same")) return '<p class="muted">The two versions are identical.</p>';
  let oldLine = 0, newLine = 0;
  const numbered = ops.map((entry) => ({ ...entry, old: entry.op === "add" ? null : ++oldLine, new: entry.op === "del" ? null : ++newLine }));
  const keep = numbered.map(() => false);
  numbered.forEach((entry, index) => {
    if (entry.op === "same") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(numbered.length - 1, index + CONTEXT); k++) keep[k] = true;
  });
  const rows = [];
  let folded = 0;
  const fold = () => {
    if (folded) rows.push(`<tr class="diff-fold"><td colspan="3">${folded} unchanged ${folded === 1 ? "line" : "lines"}</td></tr>`);
    folded = 0;
  };
  numbered.forEach((entry, index) => {
    if (!keep[index]) { folded++; return; }
    fold();
    const mark = entry.op === "add" ? "+" : entry.op === "del" ? "−" : " ";
    rows.push(`<tr class="diff-${entry.op}"><td class="diff-num">${entry.old ?? ""}</td><td class="diff-num">${entry.new ?? ""}</td><td class="diff-text"><span class="diff-mark" aria-hidden="true">${mark}</span>${escapeHtml(entry.text)}</td></tr>`);
  });
  fold();
  return `<p class="diff-legend"><span class="diff-legend-del">− ${escapeHtml(beforeLabel)}</span><span class="diff-legend-add">+ ${escapeHtml(afterLabel)}</span></p>
    <div class="diff-scroll"><table class="line-diff"><tbody>${rows.join("")}</tbody></table></div>`;
}
