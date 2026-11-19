import { artifactLink, badge, bindLinks, card, emptyState, escapeHtml, pageSub, plural, setPageSub } from "./util.js";
import { formatBadge, formatBanner } from "./format-marks.js";
import { cell, groupHead, head, plain, statusChip, table, titleCell } from "./knowledge.js";

const STATUS_TONES = { approved: "success", accepted: "success", draft: "warning", proposed: "info", superseded: "neutral", deprecated: "neutral", rejected: "danger" };

function statusBadge(status) {
  const value = String(status ?? "").toLowerCase().split(/\s/)[0];
  return badge(status ?? "no status", STATUS_TONES[value] ?? "neutral");
}

// The requirement files' groups: one per scope that holds them, in the order the library lists them, or one for the checkout without a store.
function scopeGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const label = entry.scope?.label ?? null;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }
  return [...groups].map(([label, members]) => ({ label: label === null ? "This checkout" : `Scope ${label}`, source: label === null ? "from this checkout's files" : "from the record store", entries: members }));
}

// One requirement file: its title with its format mark, its status, the date it was created, and the slices that cite it.
function requirementRow(entry, ctx) {
  const used = escapeHtml([...new Set(entry.assignedTo.map((use) => use.title))].join(", "));
  return `<div class="prism-lib-row">${plain(titleCell({ kind: "requirement", ref: entry.path, title: entry.title, format: entry.format ?? null }, ctx))}${plain(statusChip(entry.status))}${cell(escapeHtml(entry.created ?? ""))}${cell(used, true)}</div>`;
}

/** The Requirements library as { sub, body }: every requirement file in one kit library table, under a group head per scope. */
export function renderRequirements(data, ctx) {
  if (!data.entries.length) return { sub: "", body: emptyState("No requirements yet", data.directory ? "No requirement file exists yet." : "The workflow settings turn requirements off.") };
  const stored = data.entries.some((entry) => entry.scope);
  const broken = data.entries.filter((entry) => entry.format).length;
  const where = stored ? "Requirement files of every scope this checkout sees" : "Requirement files of this checkout";
  const sub = pageSub(`${escapeHtml(where)}${broken ? ` · <b>${broken} of ${data.entries.length}</b> ${broken === 1 ? "breaks its" : "break their"} format` : ""}`);
  const groups = scopeGroups(data.entries).map((group) => `${groupHead(group.label, group.entries.length, group.source)}${group.entries.map((entry) => requirementRow(entry, ctx)).join("")}`).join("");
  return { sub, body: table("knowledge-table is-library", `${head(["Title", "Status", "Created", "Used by"])}${groups}`) };
}

function decisions(data, ctx) {
  if (!data.entries.length) return card("Decisions", emptyState("No decisions yet", data.directory ? "No decision record exists yet." : "The workflow settings turn decision records off."));
  const topics = [...new Set(data.entries.map((entry) => entry.topic ?? "General"))];
  return topics.map((topic) => {
    const entries = data.entries.filter((entry) => (entry.topic ?? "General") === topic);
    return card(topic, `<ul class="row-list decision-list">${entries.map((entry) => `<li>${statusBadge(entry.status)}${artifactLink(entry.path, ctx, entry.title)}${formatBadge(entry.format)}${entry.created ? `<span class="muted">${escapeHtml(entry.created)}</span>` : ""}</li>`).join("")}</ul>`, { eyebrow: plural(entries.length, "decision") });
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
      ? `${formatBanner(data.format)}<section class="view-section document-sheet"><prism-doc class="document-content">${ctx.renderMarkdown(data.content, data.path)}</prism-doc></section>`
      : card("No glossary yet", data.path ? `<p>The configured glossary does not exist yet.</p><p class="muted">Run <code>setup</code> or <code>ideate</code> to create it.</p>` : "<p>The workflow settings turn the glossary off.</p>", { eyebrow: "Glossary" });
    return;
  }
  if (entity.kind === "requirements") {
    const { sub, body } = renderRequirements(data, ctx);
    container.innerHTML = sub && setPageSub(container, sub, ctx) ? body : `${sub}${body}`;
    bindLinks(container, ctx);
    return;
  }
  container.innerHTML = decisions(data, ctx);
  bindLinks(container, ctx);
}
