import { badge, card, chip, emptyState, escapeHtml, keyValues, plural } from "./util.js";

// A slice's files after verification: each file its latest passing run recorded, read at the verified commit or at the commit recorded at ship,
// and whether it is the same as verified; and the work on the slice that exists only on the machine that holds it, as presence lines.

const TONES = { "same as verified": "success", "changed after verification": "warning", "not available": "neutral" };
const SOURCES = { verified: "Verified commit", ship: "Commit recorded at ship" };

/** The presence lines of a slice, such as "in progress in feature-x on vm, not pushed", as kit chips, or "". */
export function presenceChips(presence) {
  if (!Array.isArray(presence) || !presence.length) return "";
  return `<span class="chip-row" data-slice-presence>${presence.map((item) => chip(escapeHtml(item.text), { tone: item.source === "run" ? "warning" : "", tip: item.text })).join("")}</span>`;
}

function fileRow(file) {
  const removed = file.blob === null ? '<span class="muted">removed</span>' : "";
  return `<li data-slice-file><code class="slice-file-path">${escapeHtml(file.path)}</code>${removed}${badge(file.state, TONES[file.state] ?? "neutral")}</li>`;
}

/** The slice's verified files as a card, from the answer of /api/slice-files. */
export function sliceFilesCard(answer) {
  if (!answer.files.length) return card("Verified files", emptyState("No verified files", answer.message ?? ""), { eyebrow: "After verification" });
  const counts = Object.keys(TONES).map((state) => [state, answer.files.filter((file) => file.state === state).length]).filter(([, count]) => count);
  const commit = (value) => (value ? `<code>${escapeHtml(value.slice(0, 12))}</code>` : null);
  return card("Verified files", `
    ${keyValues([
      ["Shown at", answer.shown ? `${escapeHtml(SOURCES[answer.shown.source] ?? answer.shown.source)} ${commit(answer.shown.commit)}` : null],
      ["Repository", answer.repository ? escapeHtml(answer.repository) : null],
      ["Verified", commit(answer.verified)],
      ["Recorded at ship", commit(answer.shipped)]
    ])}
    ${answer.message ? `<p class="muted">${escapeHtml(answer.message)}</p>` : ""}
    <p class="chip-row">${counts.map(([state, count]) => badge(`${count} ${state}`, TONES[state])).join("")}</p>
    ${answer.filesTruncated ? '<p class="muted">The run recorded its first 2000 files only.</p>' : ""}
    <ul class="row-list slice-files">${answer.files.map(fileRow).join("")}</ul>`, { eyebrow: `After verification · ${plural(answer.files.length, "file")}` });
}

/** Read the slice's verified files into target, a holder on the slice page. */
export async function mountSliceFiles(target, data) {
  if (!target) return;
  try {
    const response = await fetch(`./api/slice-files?${new URLSearchParams({ initiative: data.id, slice: data.slug })}`, { cache: "no-store" });
    const answer = await response.json().catch(() => null);
    if (!response.ok || !answer) throw new Error(answer?.message ?? "The review app could not read the slice's verified files.");
    if (target.isConnected) target.innerHTML = sliceFilesCard(answer);
  } catch (error) {
    if (target.isConnected) target.innerHTML = card("Verified files", emptyState("Verified files not shown", error.message), { eyebrow: "After verification" });
  }
}
