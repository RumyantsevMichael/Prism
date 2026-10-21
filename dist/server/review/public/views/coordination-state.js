import { jsonTreeHtml } from "./json-tree.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, keyValues, plural } from "./util.js";

const KNOWN_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence"]);
const ACTIVITIES = ["design", "review", "implementation", "integration"];

function settingValue(value) {
  if (value === null || value === undefined) {
    return '<span class="muted">unset</span>';
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => `<span class="meta-pill">${escapeHtml(key)}: ${escapeHtml(item)}</span>`).join(" ");
  }
  return `<span class="meta-pill">${escapeHtml(value)}</span>`;
}

function pathChip(value, ctx) {
  return typeof value === "string" && value.includes("/") ? artifactChip(value, ctx) : `<code>${escapeHtml(value)}</code>`;
}

function activeCard(entry, ctx, sliceTitle) {
  return `<li class="slice-card activity-${escapeHtml(String(entry.activity ?? "").toLowerCase())}">
    <div class="slice-head"><strong>${sliceTitle(entry.slice)}</strong><span class="activity-badge">${escapeHtml(entry.activity)}</span></div>
    ${entry.label ? `<p class="slice-label">${escapeHtml(entry.label)}</p>` : ""}
    ${keyValues([
      ["Workers", entry.workers?.length ? entry.workers.map((worker) => `<span class="meta-pill">${escapeHtml(worker)}</span>`).join(" ") : null],
      ["Review lanes", entry.reviewLanes?.length ? entry.reviewLanes.map((lane) => `<span class="meta-pill">${escapeHtml(lane.id)} · ${escapeHtml(lane.reviewer)}</span>`).join(" ") : null],
      ["Review", entry.reviewPath ? artifactChip(entry.reviewPath, ctx) : null],
      ["Findings", entry.findingsPath ? artifactChip(entry.findingsPath, ctx) : null],
      ["Workspace", entry.workspace ? `<code title="${escapeHtml(entry.workspace)}">${escapeHtml(entry.workspace.split("/").filter(Boolean).pop() ?? entry.workspace)}</code>` : null]
    ])}
  </li>`;
}

function queueItem(item, ctx) {
  if (item && typeof item === "object") {
    return `<span class="gate-kind">${escapeHtml(item.kind)}</span>${item.slice ? ` <code>${escapeHtml(item.slice)}</code>` : ""} ${escapeHtml(item.question)}${item.artifacts?.length ? `<br>${item.artifacts.map((artifact) => pathChip(artifact, ctx)).join(" ")}` : ""}`;
  }
  return pathChip(item, ctx);
}

function queue(title, items, ctx) {
  return `<div class="queue"><h3>${escapeHtml(title)} <span class="column-count">${items.length}</span></h3>${items.length ? `<ol class="queue-list">${items.map((item) => `<li>${queueItem(item, ctx)}</li>`).join("")}</ol>` : emptyNote("Empty")}</div>`;
}

// The board of active slices by activity; the initiative page shows it, and sliceTitle renders each card's heading.
export function activityBoard(active, ctx, sliceTitle = (slug) => escapeHtml(slug)) {
  const grouped = ACTIVITIES.map((activity) => [activity, active.filter((entry) => entry.activity === activity)]);
  const other = active.filter((entry) => !ACTIVITIES.includes(entry.activity));
  if (other.length) {
    grouped.push(["other", other]);
  }
  return `<div class="activity-board">${grouped.map(([activity, entries]) => `<div class="board-column"><h3><span class="activity-badge">${escapeHtml(activity)}</span><span class="column-count">${entries.length}</span></h3><ul>${entries.map((entry) => activeCard(entry, ctx, sliceTitle)).join("") || '<li class="column-empty">—</li>'}</ul></div>`).join("")}</div>`;
}

export function render(container, data, ctx) {
  const state = data.data;
  const active = state.active ?? [];
  const initiative = `initiative:${ctx.path.split("/").slice(-2, -1)[0]}`;
  const unknown = Object.fromEntries(Object.entries(state).filter(([key]) => !KNOWN_KEYS.has(key)));
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="stat-row">
        <div class="stat"><span class="stat-value">${active.length}</span><span class="stat-label">active ${active.length === 1 ? "slice" : "slices"}</span></div>
        <div class="stat"><span class="stat-value">${(state.pending ?? []).length}</span><span class="stat-label">pending</span></div>
        <div class="stat"><span class="stat-value">${(state.next ?? []).length}</span><span class="stat-label">next</span></div>
        <div class="stat"><span class="stat-value">${(state.evidence ?? []).length}</span><span class="stat-label">evidence paths</span></div>
      </div>
      ${state.settings ? `<div class="settings-strip">${Object.entries(state.settings).map(([key, value]) => `<span class="setting"><span class="setting-key">${escapeHtml(key)}</span>${settingValue(value)}</span>`).join("")}</div>` : ""}
    </section>
    ${card("Active work", `<p>${active.length ? `${plural(active.length, "active slice")}: ${active.map((entry) => `<code>${escapeHtml(entry.slice)}</code>`).join(" ")}.` : "No slice is active."} The board of active slices is on the initiative page.</p><p>${artifactChip(initiative, ctx, "Open the initiative")}</p>`, { eyebrow: plural(active.length, "slice") })}
    <section class="view-card"><div class="queues">${queue("Pending", state.pending ?? [], ctx)}${queue("Next", state.next ?? [], ctx)}${queue("Evidence", state.evidence ?? [], ctx)}</div></section>
    ${Object.keys(unknown).length ? card("Unrecognized fields", jsonTreeHtml(unknown, { ctx }), { eyebrow: "Preserved by the validator with warnings" }) : ""}`;
  bindLinks(container, ctx);
}
