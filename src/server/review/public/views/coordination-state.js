import { jsonTreeHtml } from "./json-tree.js";
import { artifactChip, bindLinks, card, chip, escapeHtml, keyValues, plural, recordChip, stat, summaryPanel } from "./util.js";

const KNOWN_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence"]);

function settingValue(value) {
  if (value === null || value === undefined) {
    return '<span class="muted">unset</span>';
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => chip(`${escapeHtml(key)}: ${escapeHtml(item)}`)).join("");
  }
  return chip(escapeHtml(value));
}

// A path names one of Prism's records by title and kind, or a repository file by its path; any other value is shown as it is.
function pathChip(value, ctx) {
  return typeof value === "string" && value.includes("/") ? recordChip(value, ctx) : `<code>${escapeHtml(value)}</code>`;
}

// One active entry's activity, workers, review lanes, and workspace; the initiative board shows it on the slice's card.
export function activeDetails(entry, ctx) {
  return `<div class="active-details activity-${escapeHtml(String(entry.activity ?? "").toLowerCase())}">
    <p class="active-head">${chip(escapeHtml(entry.activity), { tone: "accent" })}${entry.label ? ` <span class="slice-label">${escapeHtml(entry.label)}</span>` : ""}</p>
    ${keyValues([
      ["Workers", entry.workers?.length ? `<span class="chip-row">${entry.workers.map((worker) => chip(escapeHtml(worker))).join("")}</span>` : null],
      ["Review lanes", entry.reviewLanes?.length ? `<span class="chip-row">${entry.reviewLanes.map((lane) => chip(`${escapeHtml(lane.id)} · ${escapeHtml(lane.reviewer)}`)).join("")}</span>` : null],
      ["Review", entry.reviewPath ? recordChip(entry.reviewPath, ctx) : null],
      ["Findings", entry.findingsPath ? recordChip(entry.findingsPath, ctx) : null],
      ["Workspace", entry.workspace ? chip(escapeHtml(entry.workspace.split("/").filter(Boolean).pop() ?? entry.workspace), { tip: entry.workspace, attributes: " data-code-subject" }) : null]
    ])}
  </div>`;
}

function queueItem(item, ctx) {
  if (item && typeof item === "object") {
    return `${chip(escapeHtml(item.kind))}${item.slice ? ` <code>${escapeHtml(item.slice)}</code>` : ""} ${escapeHtml(item.question)}${item.artifacts?.length ? `<span class="chip-row">${item.artifacts.map((artifact) => pathChip(artifact, ctx)).join("")}</span>` : ""}`;
  }
  return pathChip(item, ctx);
}

function queue(title, items, ctx) {
  return `<div class="queue"><h3 class="queue-head">${escapeHtml(title)} <prism-badge variant="count">${items.length}</prism-badge></h3>${items.length ? `<ol class="row-list queue-list">${items.map((item) => `<li>${queueItem(item, ctx)}</li>`).join("")}</ol>` : '<p class="empty-note">Empty</p>'}</div>`;
}

export function render(container, data, ctx) {
  const state = data.data;
  const active = state.active ?? [];
  const initiative = `initiative:${ctx.path.split("/").slice(-2, -1)[0]}`;
  const unknown = Object.fromEntries(Object.entries(state).filter(([key]) => !KNOWN_KEYS.has(key)));
  container.innerHTML = `
    ${summaryPanel(`
      <div class="stat-grid">
        ${stat(`active ${active.length === 1 ? "slice" : "slices"}`, String(active.length))}
        ${stat("pending", String((state.pending ?? []).length))}
        ${stat("next", String((state.next ?? []).length))}
        ${stat("evidence paths", String((state.evidence ?? []).length))}
      </div>
      ${state.settings ? `<div class="settings-strip">${Object.entries(state.settings).map(([key, value]) => `<span class="setting"><span class="label-caps">${escapeHtml(key)}</span><span class="chip-row">${settingValue(value)}</span></span>`).join("")}</div>` : ""}`)}
    ${card("Active work", `<p>${active.length ? `${plural(active.length, "active slice")}: ${active.map((entry) => `<code>${escapeHtml(entry.slice)}</code>`).join(" ")}.` : "No slice is active."} The initiative page's board shows each active slice's activity.</p><p>${artifactChip(initiative, ctx, "Open the initiative")}</p>`, { eyebrow: plural(active.length, "slice") })}
    <prism-panel class="view-section" heading="Queues"><div class="queues">${queue("Pending", state.pending ?? [], ctx)}${queue("Next", state.next ?? [], ctx)}${queue("Evidence", state.evidence ?? [], ctx)}</div></prism-panel>
    ${Object.keys(unknown).length ? card("Unrecognized fields", jsonTreeHtml(unknown, { ctx, label: "Unrecognized fields" }), { eyebrow: "Preserved by the validator with warnings" }) : ""}`;
  bindLinks(container, ctx);
}
