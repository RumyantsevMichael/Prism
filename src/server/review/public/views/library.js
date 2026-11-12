import { artifactChip, artifactLink, badge, bindLinks, card, emptyState, escapeHtml, pageSub, plural, setPageSub, stat, summaryPanel } from "./util.js";

const STATUS_TONES = { approved: "success", accepted: "success", draft: "warning", proposed: "info", superseded: "neutral", deprecated: "neutral", rejected: "danger" };

function statusBadge(status) {
  const value = String(status ?? "").toLowerCase().split(/\s/)[0];
  return badge(status ?? "no status", STATUS_TONES[value] ?? "neutral");
}

// The scope label of a store artifact in a workspace, which tells two scopes' files of one name apart, or nothing for a checkout's own file.
function scopeChip(path, ctx) {
  const label = ctx.scopeLabel?.(path);
  return label ? `<prism-chip data-scope-label>${escapeHtml(label)}</prism-chip>` : "";
}

function requirements(data, ctx) {
  if (!data.entries.length) return card("Requirements", emptyState("No requirements yet", data.directory ? "No requirement file exists yet." : "The workflow settings turn requirements off."));
  const counts = data.entries.reduce((totals, entry) => ({ ...totals, [entry.status ?? "no status"]: (totals[entry.status ?? "no status"] ?? 0) + 1 }), {});
  return `${summaryPanel(`<div class="stat-grid">${Object.entries(counts).map(([status, count]) => stat(status, String(count))).join("")}</div>`)}
  ${card(plural(data.entries.length, "requirement file"), `<div class="table-wrap"><table class="data-table"><thead><tr><th>Requirement</th><th>Status</th><th>Dates</th><th>Assigned to</th></tr></thead><tbody>${data.entries.map((entry) => `<tr>
    <td><span class="chip-row">${artifactLink(entry.path, ctx, entry.title)}${scopeChip(entry.path, ctx)}</span></td>
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
    return card(topic, `<ul class="row-list decision-list">${entries.map((entry) => `<li>${statusBadge(entry.status)}${artifactLink(entry.path, ctx, entry.title)}${scopeChip(entry.path, ctx)}${entry.created ? `<span class="muted">${escapeHtml(entry.created)}</span>` : ""}</li>`).join("")}</ul>`, { eyebrow: plural(entries.length, "decision") });
  }).join("");
}

// The diagrams of the plans and decisions folders by name, each with the slice, initiative, or decision it belongs to, in the server's order.
export function renderDiagrams(data, ctx) {
  const diagrams = data?.diagrams ?? [];
  if (!diagrams.length) return { sub: "", body: emptyState("No diagrams yet", "No PlantUML file exists in the plans or decisions folders.") };
  const rows = diagrams.map((diagram) => `<div class="prism-lib-row"><span><span class="prism-lib-title"><prism-icon class="prism-lib-kind" name="diagram" size="sm" aria-hidden="true"></prism-icon>${artifactLink(diagram.path, ctx, diagram.name)}</span></span><span class="prism-lib-cell">${escapeHtml(diagram.owner.title)}</span></div>`).join("");
  return {
    sub: pageSub(escapeHtml(`${plural(diagrams.length, "diagram")} in the plans and decisions folders, each with what it belongs to.`)),
    body: `<prism-lib-table class="diagram-list"><div class="prism-lib-row is-head" aria-hidden="true"><span>Diagram</span><span>Belongs to</span></div>${rows}</prism-lib-table>`
  };
}

export function render(container, entity, ctx) {
  const data = entity.data;
  if (entity.kind === "diagrams") {
    const { sub, body } = renderDiagrams(data, ctx);
    container.innerHTML = setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
    bindLinks(container, ctx);
    return;
  }
  if (entity.kind === "glossary") {
    container.innerHTML = data.exists
      ? `<section class="view-section document-sheet"><prism-doc class="document-content">${ctx.renderMarkdown(data.content, data.path)}</prism-doc></section>`
      : card("No glossary yet", data.path ? `<p>The configured glossary does not exist yet.</p><p class="muted">Run <code>setup</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow settings turn the glossary off.</p>", { eyebrow: "Glossary" });
    return;
  }
  container.innerHTML = entity.kind === "requirements" ? requirements(data, ctx) : decisions(data, ctx);
  bindLinks(container, ctx);
}
