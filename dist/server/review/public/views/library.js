import { artifactChip, badge, bindLinks, card, emptyState, escapeHtml, plural, stat, summaryPanel } from "./util.js";

const STATUS_TONES = { approved: "success", accepted: "success", draft: "warning", proposed: "info", superseded: "neutral", deprecated: "neutral", rejected: "danger" };

function statusBadge(status) {
  const value = String(status ?? "").toLowerCase().split(/\s/)[0];
  return badge(status ?? "no status", STATUS_TONES[value] ?? "neutral");
}

function requirements(data, ctx) {
  if (!data.entries.length) return card("Requirements", emptyState("No requirements yet", data.directory ? "No requirement file exists yet." : "The workflow settings turn requirements off."));
  const counts = data.entries.reduce((totals, entry) => ({ ...totals, [entry.status ?? "no status"]: (totals[entry.status ?? "no status"] ?? 0) + 1 }), {});
  return `${summaryPanel(`<div class="stat-grid">${Object.entries(counts).map(([status, count]) => stat(status, String(count))).join("")}</div>`)}
  ${card(plural(data.entries.length, "requirement file"), `<div class="table-wrap"><table class="data-table"><thead><tr><th>Requirement</th><th>Status</th><th>Dates</th><th>Assigned to</th></tr></thead><tbody>${data.entries.map((entry) => `<tr>
    <td><span class="chip-row">${artifactChip(entry.path, ctx, entry.title)}</span></td>
    <td>${statusBadge(entry.status)}</td>
    <td class="muted dates">${[entry.created && `created ${escapeHtml(entry.created)}`, entry.approved && `approved ${escapeHtml(entry.approved)}`].filter(Boolean).join("<br>") || "—"}</td>
    <td><span class="chip-row">${entry.assignedTo.length ? entry.assignedTo.map((use) => artifactChip(`slice:${use.initiative}/${use.slug}`, ctx, `${use.title}${use.anchor ? ` · requirement ${use.anchor}` : ""}`)).join("") : '<span class="muted">unassigned</span>'}</span></td>
  </tr>`).join("")}</tbody></table></div>`, { eyebrow: "Requirements" })}`;
}

function decisions(data, ctx) {
  if (!data.entries.length) return card("Decisions", emptyState("No decisions yet", data.directory ? "No decision record exists yet." : "The workflow settings turn decision records off."));
  const topics = [...new Set(data.entries.map((entry) => entry.topic ?? "General"))];
  return topics.map((topic) => {
    const entries = data.entries.filter((entry) => (entry.topic ?? "General") === topic);
    return card(topic, `<ul class="row-list decision-list">${entries.map((entry) => `<li>${statusBadge(entry.status)}${artifactChip(entry.path, ctx, entry.title)}${entry.created ? `<span class="muted">${escapeHtml(entry.created)}</span>` : ""}</li>`).join("")}</ul>`, { eyebrow: plural(entries.length, "decision") });
  }).join("");
}

export function render(container, entity, ctx) {
  const data = entity.data;
  if (entity.kind === "glossary") {
    container.innerHTML = data.exists
      ? `<prism-panel class="view-section"><div class="document-content">${ctx.renderMarkdown(data.content, data.path)}</div></prism-panel>`
      : card("No glossary yet", data.path ? `<p>The configured glossary does not exist yet.</p><p class="muted">Run <code>setup</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow settings turn the glossary off.</p>", { eyebrow: "Glossary" });
    return;
  }
  container.innerHTML = entity.kind === "requirements" ? requirements(data, ctx) : decisions(data, ctx);
  bindLinks(container, ctx);
}
