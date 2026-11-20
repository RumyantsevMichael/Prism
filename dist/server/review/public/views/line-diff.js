// Generated from src/server/review/public/views/line-diff.ts by scripts/native-build/compile.mjs.
import { escapeHtml } from "./util.js";
const MAX_CELLS = 4e6;
const CONTEXT = 3;
const lines = (text) => text === null || text === void 0 || text === "" ? [] : text.replace(/\n$/, "").split("\n");
function diffItems(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      table[i2 * width + j2] = a[start + i2] === b[start + j2] ? table[(i2 + 1) * width + j2 + 1] + 1 : Math.max(table[(i2 + 1) * width + j2], table[i2 * width + j2 + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ op: "same", before: k, after: k });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ op: "same", before: start + i, after: start + j });
      i++;
      j++;
    } else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      ops.push({ op: "del", before: start + i });
      i++;
    } else {
      ops.push({ op: "add", after: start + j });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ op: "same", before: endA + k, after: endB + k });
  return ops;
}
function diffLines(before, after) {
  const a = lines(before), b = lines(after);
  const ops = diffItems(a, b);
  return ops && ops.map((entry) => ({ op: entry.op, text: entry.op === "add" ? b[entry.after] : a[entry.before] }));
}
function diffHtml(before, after, { beforeLabel = "before", afterLabel = "after" } = {}) {
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
    if (!keep[index]) {
      folded++;
      return;
    }
    fold();
    const mark = entry.op === "add" ? "+" : entry.op === "del" ? "\u2212" : " ";
    rows.push(`<tr class="diff-${entry.op}"><td class="diff-num">${entry.old ?? ""}</td><td class="diff-num">${entry.new ?? ""}</td><td class="diff-text"><span class="diff-mark" aria-hidden="true">${mark}</span>${escapeHtml(entry.text)}</td></tr>`);
  });
  fold();
  return `<p class="diff-legend"><span class="diff-legend-del">\u2212 ${escapeHtml(beforeLabel)}</span><span class="diff-legend-add">+ ${escapeHtml(afterLabel)}</span></p>
    <div class="diff-scroll"><table class="line-diff"><tbody>${rows.join("")}</tbody></table></div>`;
}
export {
  diffHtml,
  diffItems,
  diffLines
};
