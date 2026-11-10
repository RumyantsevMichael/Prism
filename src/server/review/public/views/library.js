import { artifactChip, artifactLink, badge, bindLinks, card, emptyState, escapeHtml, plural, stat, summaryPanel } from "./util.js";

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
    <td>${artifactLink(entry.path, ctx, entry.title)}</td>
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
    return card(topic, `<ul class="row-list decision-list">${entries.map((entry) => `<li>${statusBadge(entry.status)}${artifactLink(entry.path, ctx, entry.title)}${entry.created ? `<span class="muted">${escapeHtml(entry.created)}</span>` : ""}</li>`).join("")}</ul>`, { eyebrow: plural(entries.length, "decision") });
  }).join("");
}

// The diagrams of the plans and decisions folders by name, each with the slice, initiative, or decision it belongs to, in the server's order.
export function renderDiagrams(data, ctx) {
  const diagrams = data?.diagrams ?? [];
  if (!diagrams.length) return card("Diagrams", emptyState("No diagrams yet", "No PlantUML file exists in the plans or decisions folders."));
  return card(plural(diagrams.length, "diagram"), `<div class="table-wrap"><table class="data-table diagram-table"><thead><tr><th>Diagram</th><th>Belongs to</th></tr></thead><tbody>${diagrams.map((diagram) => `<tr>
    <td>${artifactLink(diagram.path, ctx, diagram.name)}</td>
    <td class="muted">${escapeHtml(diagram.owner.title)}</td>
  </tr>`).join("")}</tbody></table></div>`, { eyebrow: "Diagrams" });
}

// The entry points that a later change of the review app fills; until then each page says what it will list.
const PLANNED_PAGES = {
  touched: ["Touched by my work", "This page will list the records behind the slice you have open."],
  changed: ["Changed this week", "This page will list the records changed in the last 7 days."]
};

export function render(container, entity, ctx) {
  const data = entity.data;
  if (entity.kind === "diagrams") {
    container.innerHTML = renderDiagrams(data, ctx);
    bindLinks(container, ctx);
    return;
  }
  if (Object.hasOwn(PLANNED_PAGES, entity.kind)) {
    const [title, text] = PLANNED_PAGES[entity.kind];
    container.innerHTML = card(title, emptyState("Planned", text));
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
