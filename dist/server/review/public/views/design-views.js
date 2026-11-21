// Generated from src/server/review/public/views/design-views.ts by scripts/native-build/compile.mjs.
import { highlight } from "./highlight.js";
import { escapeHtml } from "./util.js";
const KINDS = Object.freeze({ sequence: "Sequence", activity: "Activity", state: "State", component: "Component", "data-model": "Data model", deployment: "Deployment", wireframe: "Wireframe", code: "Code", api: "API" });
function viewKind(view) {
  return `${KINDS[view.kind] ?? view.kind} view`;
}
const clauseList = (links) => links.length < 3 ? links.join(" and ") : `${links.slice(0, -1).join(", ")}, and ${links.at(-1)}`;
function viewNoteHtml(view, className = "view-note") {
  const ref = view.contract?.ref ?? "";
  const links = view.clauses.map((number) => `<a href="#" class="clause-link clause-ref" data-clause="${number}" data-view-clause="${number}" data-view-contract="${escapeHtml(ref)}">\xA7${number}</a>`);
  const contract = view.contract?.ref ? `<prism-chip interactive tone="accent" data-view-contract="${escapeHtml(ref)}">${escapeHtml(view.contract.title ?? "Contract")} \xB7 Design</prism-chip>` : "its governing design";
  return `<p class="${className}">This view explains ${clauseList(links)} of the contract in ${contract}; where the view and the contract differ, the contract decides.</p>`;
}
let pendingClause = null;
function requestClause(ref, number) {
  pendingClause = ref && number ? { ref, number: String(number) } : null;
}
function takeClause(ref) {
  if (!pendingClause || pendingClause.ref !== ref) return null;
  const { number } = pendingClause;
  pendingClause = null;
  return number;
}
function bindViewLinks(root, open) {
  root.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-view-contract]");
    if (!link || !root.contains(link) || !link.dataset.viewContract) return;
    event.preventDefault();
    event.stopPropagation();
    open(link.dataset.viewContract, link.dataset.viewClause ?? null);
  });
}
function viewTools(view) {
  const open = '<prism-button variant="ghost" size="sm" data-action="open" tip="Open this view on its own page">Open</prism-button>';
  if (view.kind === "api") return `<div slot="tools" class="diagram-tools" role="group" aria-label="View controls">${open}<prism-button variant="ghost" size="sm" data-action="copy-view" tip="Copy the API specification">Copy</prism-button></div>`;
  return `<div slot="tools" class="diagram-tools" role="group" aria-label="Diagram controls">
      <prism-button variant="ghost" size="sm" data-action="zoom-out" label="Zoom out" tip="Zoom out">\u2212</prism-button>
      <prism-button variant="ghost" size="sm" data-action="reset" data-scale-label tip="Reset zoom">100%</prism-button>
      <prism-button variant="ghost" size="sm" data-action="zoom-in" label="Zoom in" tip="Zoom in">+</prism-button>
      <prism-button variant="ghost" size="sm" data-action="source" aria-expanded="false">Show source</prism-button>
      ${open}</div>`;
}
function viewBody(view) {
  if (view.source === null) return `<p class="error">${view.missing ? "The view's file is missing." : "The view is too large to show here; open it on its own page."}</p>`;
  if (view.kind === "api") return `<div class="view-source"><prism-code language="json"><pre><code>${highlight(view.source, "json")}</code></pre></prism-code></div>`;
  return `<prism-canvas class="diagram-output" pannable><prism-spinner label="Rendering the view"></prism-spinner></prism-canvas><div class="diagram-source" hidden><prism-code language="plantuml"><pre><code>${highlight(view.source, "plantuml")}</code></pre></prism-code></div>`;
}
const UNASKED_NOTE = '<p class="view-note">This diagram is in the slice\u2019s folder, but the design states no question for it and cites no clause that it explains.</p>';
function viewCardHtml(view, level = 2) {
  const declared = view.declared !== false;
  const heading = declared ? view.question : view.title ?? view.file;
  const eyebrow = declared ? `${viewKind(view)} \xB7 ${view.file}` : `Diagram \xB7 ${view.file}`;
  return `<prism-panel class="diagram-view view-region" variant="card" level="${level}" region heading="${escapeHtml(heading)}" eyebrow="${escapeHtml(eyebrow)}" data-view="${escapeHtml(view.path)}"${declared ? "" : " data-view-unasked"}>${viewTools(view)}${declared ? viewNoteHtml(view) : UNASKED_NOTE}${viewBody(view)}</prism-panel>`;
}
function markViewFiles(root) {
  for (const eyebrow of root.querySelectorAll(".view-region > .prism-panel-head .prism-panel-eyebrow")) eyebrow.setAttribute("data-code-subject", "");
}
export {
  bindViewLinks,
  markViewFiles,
  requestClause,
  takeClause,
  viewCardHtml,
  viewKind,
  viewNoteHtml
};
