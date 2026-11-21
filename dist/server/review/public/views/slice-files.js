// Generated from src/server/review/public/views/slice-files.ts by scripts/native-build/compile.mjs.
import { badge, card, chip, emptyState, escapeHtml, keyValues, plural } from "./util.js";
const TONES = { "same as verified": "success", "changed after verification": "warning", "not available": "neutral" };
const SOURCES = { verified: "Verified commit", ship: "Commit recorded at ship" };
function presenceChips(presence) {
  if (!Array.isArray(presence) || !presence.length) return "";
  return `<span class="chip-row" data-slice-presence>${presence.map((item) => chip(escapeHtml(item.text), { tone: item.source === "run" ? "warning" : "", tip: item.text })).join("")}</span>`;
}
function fileRow(file) {
  const removed = file.blob === null ? '<span class="muted">removed</span>' : "";
  return `<li data-slice-file><code class="slice-file-path">${escapeHtml(file.path)}</code>${removed}${badge(file.state, TONES[file.state] ?? "neutral")}</li>`;
}
function branchesHeld(held) {
  if (!held) return null;
  const name = (branch) => chip(escapeHtml(branch), { tip: branch });
  if (held.onDefault) return `<span class="chip-row" data-slice-branches>${name(held.defaultBranch)}${badge("default branch", "success")}</span>`;
  const more = held.branchCount > held.branches.length ? `<span class="muted">and ${held.branchCount - held.branches.length} more</span>` : "";
  const landed = !held.defaultBranch ? "" : held.shippedOnDefault ? badge("ship commit on the default branch", "success") : badge("not on the default branch yet", "warning");
  return `<span class="chip-row" data-slice-branches>${held.branches.map(name).join("")}${more}${landed}</span>`;
}
function sliceFilesCard(answer) {
  if (!answer.files.length) return card("Verified files", emptyState("No verified files", answer.message ?? ""), { eyebrow: "After verification" });
  const counts = Object.keys(TONES).map((state) => [state, answer.files.filter((file) => file.state === state).length]).filter(([, count]) => count);
  const commit = (value) => value ? `<code>${escapeHtml(value.slice(0, 12))}</code>` : null;
  return card("Verified files", `
    ${keyValues([
    ["Shown at", answer.shown ? `${escapeHtml(SOURCES[answer.shown.source] ?? answer.shown.source)} ${commit(answer.shown.commit)}` : null],
    ["Repository", answer.repository ? escapeHtml(answer.repository) : null],
    ["On branches", branchesHeld(answer.held)],
    ["Verified", commit(answer.verified)],
    ["Recorded at ship", commit(answer.shipped)]
  ])}
    ${answer.message ? `<p class="muted">${escapeHtml(answer.message)}</p>` : ""}
    <p class="chip-row">${counts.map(([state, count]) => badge(`${count} ${state}`, TONES[state])).join("")}</p>
    ${answer.filesTruncated ? '<p class="muted">The run recorded its first 2000 files only.</p>' : ""}
    <ul class="row-list slice-files">${answer.files.map(fileRow).join("")}</ul>`, { eyebrow: `After verification \xB7 ${plural(answer.files.length, "file")}` });
}
async function mountSliceFiles(target, data) {
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
export {
  mountSliceFiles,
  presenceChips,
  sliceFilesCard
};
