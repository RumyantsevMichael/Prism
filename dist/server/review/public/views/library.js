import { artifactChip, bindLinks, card, emptyNote, escapeHtml, plural } from "./util.js";

function statusClass(status) {
  const value = String(status ?? "unknown").toLowerCase().split(/\s/)[0];
  return `doc-status doc-${value.replace(/[^a-z-]/g, "")}`;
}

function statusBadge(status) {
  return `<span class="${statusClass(status)}">${escapeHtml(status ?? "no status")}</span>`;
}

function requirements(data, ctx) {
  if (!data.entries.length) return card("Requirements", emptyNote(data.directory ? `No requirement files exist under ${data.directory}.` : "The workflow config disables requirements."));
  const counts = data.entries.reduce((totals, entry) => ({ ...totals, [entry.status ?? "no status"]: (totals[entry.status ?? "no status"] ?? 0) + 1 }), {});
  return `<section class="view-card summary-card"><div class="stat-row">${Object.entries(counts).map(([status, count]) => `<div class="stat"><span class="stat-value">${count}</span><span class="stat-label">${escapeHtml(status)}</span></div>`).join("")}</div></section>
  ${card(plural(data.entries.length, "requirement file"), `<div class="table-wrap"><table class="data-table"><thead><tr><th>Requirement</th><th>Status</th><th>Dates</th><th>Assigned to</th></tr></thead><tbody>${data.entries.map((entry) => `<tr>
    <td>${artifactChip(entry.path, ctx, entry.title)}</td>
    <td>${statusBadge(entry.status)}</td>
    <td class="muted dates">${[entry.created && `created ${escapeHtml(entry.created)}`, entry.approved && `approved ${escapeHtml(entry.approved)}`].filter(Boolean).join("<br>") || "—"}</td>
    <td>${entry.assignedTo.length ? entry.assignedTo.map((use) => artifactChip(`slice:${use.initiative}/${use.slug}`, ctx, `${use.title}${use.anchor ? ` #${use.anchor}` : ""}`)).join(" ") : '<span class="muted">unassigned</span>'}</td>
  </tr>`).join("")}</tbody></table></div>`, { eyebrow: data.directory })}`;
}

function decisions(data, ctx) {
  if (!data.entries.length) return card("Decisions", emptyNote(data.directory ? `No ADRs exist under ${data.directory}.` : "The workflow config disables ADRs."));
  const topics = [...new Set(data.entries.map((entry) => entry.topic ?? "General"))];
  return topics.map((topic) => {
    const entries = data.entries.filter((entry) => (entry.topic ?? "General") === topic);
    return card(topic, `<ul class="decision-list">${entries.map((entry) => `<li>${statusBadge(entry.status)} ${artifactChip(entry.path, ctx, entry.title)}${entry.created ? ` <span class="muted">${escapeHtml(entry.created)}</span>` : ""}</li>`).join("")}</ul>`, { eyebrow: plural(entries.length, "decision") });
  }).join("");
}

export function render(container, entity, ctx) {
  const data = entity.data;
  if (entity.kind === "glossary") {
    container.innerHTML = data.exists
      ? `<section class="document-card"><div class="document-content">${ctx.renderMarkdown(data.content, data.path)}</div></section>`
      : card("No glossary yet", data.path ? `<p>The configured glossary <code>${escapeHtml(data.path)}</code> does not exist.</p><p class="muted">Run <code>workflow-init</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow config disables the glossary.</p>", { eyebrow: "Glossary" });
    return;
  }
  container.innerHTML = entity.kind === "requirements" ? requirements(data, ctx) : decisions(data, ctx);
  bindLinks(container, ctx);
}
