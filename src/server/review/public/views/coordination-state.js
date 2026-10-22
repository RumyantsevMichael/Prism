import { jsonTreeHtml } from "./json-tree.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, keyValues, plural } from "./util.js";

const KNOWN_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence"]);

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

// One active entry's activity, workers, review lanes, and workspace; the initiative board shows it on the slice's card.
export function activeDetails(entry, ctx) {
  return `<div class="active-details activity-${escapeHtml(String(entry.activity ?? "").toLowerCase())}">
    <p class="active-head"><span class="activity-badge">${escapeHtml(entry.activity)}</span>${entry.label ? ` <span class="slice-label">${escapeHtml(entry.label)}</span>` : ""}</p>
    ${keyValues([
      ["Workers", entry.workers?.length ? entry.workers.map((worker) => `<span class="meta-pill">${escapeHtml(worker)}</span>`).join(" ") : null],
      ["Review lanes", entry.reviewLanes?.length ? entry.reviewLanes.map((lane) => `<span class="meta-pill">${escapeHtml(lane.id)} · ${escapeHtml(lane.reviewer)}</span>`).join(" ") : null],
      ["Review", entry.reviewPath ? artifactChip(entry.reviewPath, ctx, entry.reviewPath.split("/").pop()) : null],
      ["Findings", entry.findingsPath ? artifactChip(entry.findingsPath, ctx, entry.findingsPath.split("/").pop()) : null],
      ["Workspace", entry.workspace ? `<code title="${escapeHtml(entry.workspace)}">${escapeHtml(entry.workspace.split("/").filter(Boolean).pop() ?? entry.workspace)}</code>` : null]
    ])}
  </div>`;
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
    ${card("Active work", `<p>${active.length ? `${plural(active.length, "active slice")}: ${active.map((entry) => `<code>${escapeHtml(entry.slice)}</code>`).join(" ")}.` : "No slice is active."} The initiative page's board shows each active slice's activity.</p><p>${artifactChip(initiative, ctx, "Open the initiative")}</p>`, { eyebrow: plural(active.length, "slice") })}
    <section class="view-card"><div class="queues">${queue("Pending", state.pending ?? [], ctx)}${queue("Next", state.next ?? [], ctx)}${queue("Evidence", state.evidence ?? [], ctx)}</div></section>
    ${Object.keys(unknown).length ? card("Unrecognized fields", jsonTreeHtml(unknown, { ctx }), { eyebrow: "Preserved by the validator with warnings" }) : ""}`;
  bindLinks(container, ctx);
}
