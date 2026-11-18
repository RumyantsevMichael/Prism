// A design view explains contract clauses to the person at the design gate: its kind and question name it, and its note links the clauses it explains
// and says that the contract decides where the view and the contract differ. The slice page, a view's own page, and the side panel show the same header.
import { highlight } from "./highlight.js";
import { escapeHtml } from "./util.js";

const KINDS = Object.freeze({ sequence: "Sequence", activity: "Activity", state: "State", component: "Component", "data-model": "Data model", deployment: "Deployment", wireframe: "Wireframe", code: "Code", api: "API" });

/** The line above a view's question, such as "Sequence view". */
export function viewKind(view) {
  return `${KINDS[view.kind] ?? view.kind} view`;
}

const clauseList = (links) => links.length < 3 ? links.join(" and ") : `${links.slice(0, -1).join(", ")}, and ${links.at(-1)}`;

/**
 * The view's note: each cited clause as a §n link, the governing contract as a chip that opens its design, and that the contract decides.
 * A link carries the clause and the contract's page, which the page that shows it opens at that clause.
 */
export function viewNoteHtml(view, className = "view-note") {
  const ref = view.contract?.ref ?? "";
  const links = view.clauses.map((number) => `<a href="#" class="clause-link clause-ref" data-clause="${number}" data-view-clause="${number}" data-view-contract="${escapeHtml(ref)}">§${number}</a>`);
  const contract = view.contract?.ref
    ? `<prism-chip interactive tone="accent" data-view-contract="${escapeHtml(ref)}">${escapeHtml(view.contract.title ?? "Contract")} · Design</prism-chip>`
    : "its governing design";
  return `<p class="${className}">This view explains ${clauseList(links)} of the contract in ${contract}; where the view and the contract differ, the contract decides.</p>`;
}

// A clause link that leaves its page names the clause to open, which the contract's page takes when it draws.
let pendingClause = null;

/** Remembers the clause that the next drawing of a contract's page opens. */
export function requestClause(ref, number) {
  pendingClause = ref && number ? { ref, number: String(number) } : null;
}

/** The clause that a contract's page opens, once, or null. */
export function takeClause(ref) {
  if (!pendingClause || pendingClause.ref !== ref) return null;
  const { number } = pendingClause;
  pendingClause = null;
  return number;
}

/** Opens a view note's links below root: a clause opens on its contract's page, and the contract chip opens that page. */
export function bindViewLinks(root, open) {
  root.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-view-contract]");
    if (!link || !root.contains(link) || !link.dataset.viewContract) return;
    event.preventDefault();
    event.stopPropagation();
    open(link.dataset.viewContract, link.dataset.viewClause ?? null);
  });
}

/** The tools of a view's card: zoom, source, and Open for a drawing, and Open and Copy for an API specification. */
function viewTools(view) {
  const open = '<prism-button variant="ghost" size="sm" data-action="open" tip="Open this view on its own page">Open</prism-button>';
  if (view.kind === "api") return `<div slot="tools" class="diagram-tools" role="group" aria-label="View controls">${open}<prism-button variant="ghost" size="sm" data-action="copy-view" tip="Copy the API specification">Copy</prism-button></div>`;
  return `<div slot="tools" class="diagram-tools" role="group" aria-label="Diagram controls">
      <prism-button variant="ghost" size="sm" data-action="zoom-out" label="Zoom out" tip="Zoom out">−</prism-button>
      <prism-button variant="ghost" size="sm" data-action="reset" data-scale-label tip="Reset zoom">100%</prism-button>
      <prism-button variant="ghost" size="sm" data-action="zoom-in" label="Zoom in" tip="Zoom in">+</prism-button>
      <prism-button variant="ghost" size="sm" data-action="source" aria-expanded="false">Show source</prism-button>
      ${open}</div>`;
}

function viewBody(view) {
  if (view.source === null) return `<p class="error">${view.missing ? "The view's file is missing." : "The view is too large to show here; open it on its own page."}</p>`;
  if (view.kind === "api") return `<div class="view-source"><prism-code language="json"><pre><code>${highlight(view.source, "json")}</code></pre></prism-code></div>`;
  return `<prism-canvas class="diagram-output"><prism-spinner label="Rendering the view"></prism-spinner></prism-canvas><div class="diagram-source" hidden><prism-code language="plantuml"><pre><code>${highlight(view.source, "plantuml")}</code></pre></prism-code></div>`;
}

/** One view as a card and a region named by its question: its kind and file above the question, the note, then the drawing or the source text. */
export function viewCardHtml(view, level = 2) {
  return `<prism-panel class="diagram-view view-region" variant="card" level="${level}" region heading="${escapeHtml(view.question)}" eyebrow="${escapeHtml(`${viewKind(view)} · ${view.file}`)}" data-view="${escapeHtml(view.path)}">${viewTools(view)}${viewNoteHtml(view)}${viewBody(view)}</prism-panel>`;
}

/** A view card's eyebrow names its file, where the file is the subject, so the line is marked as such once the panel has drawn it. */
export function markViewFiles(root) {
  for (const eyebrow of root.querySelectorAll(".view-region > .prism-panel-head .prism-panel-eyebrow")) eyebrow.setAttribute("data-code-subject", "");
}
