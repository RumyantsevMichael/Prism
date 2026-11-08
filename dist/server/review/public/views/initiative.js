import { activeDetails } from "./coordination-state.js";
import { applyWidths, progressBar } from "./entities.js";
import { stateBadge } from "./roadmap.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, badge, bindLinks, card, emptyNote, escapeHtml, keyValues, plural, requirementLinks, summaryPanel } from "./util.js";
import { runTotalsHtml } from "./run-totals.js";
import { codeChip } from "./code-location.js";
import { claimChip, claimOf } from "./claims.js";
import { componentChip } from "./components.js";
import { mountInitiativeSettings } from "./actions.js";

const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];
// These columns always show; another status, such as deferred, gets a column only while a slice has it.
const STATUS_COLUMNS = [["not-started", "Not started"], ["design-review", "Design review"], ["in-progress", "In progress"], ["blocked", "Blocked"], ["deferred", "Deferred"], ["done", "Done"]];
const FIXED_COLUMNS = new Set(["not-started", "in-progress", "blocked", "done"]);

const STATUS_TONES = { "not-started": "neutral", "design-review": "accent", "in-progress": "info", blocked: "danger", deferred: "warning", done: "success", split: "neutral" };

export function statusBadge(status) {
  return badge(status === "design-review" ? "design review" : status, STATUS_TONES[status] ?? "neutral");
}

// A slice's title is a link to its page.
function sliceLink(data, slug) {
  const ref = `slice:${data.id}/${slug}`;
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(data.record.slices[slug].title)}</a>`;
}

// A not-started slice whose design waits at its gate shows as in design review; the record keeps not-started until acceptance.
function statusOf(data, slug) {
  return data.designReview?.[slug] ? "design-review" : data.record.slices[slug].status;
}


function sliceSignals(artifacts) {
  const parts = [];
  if (artifacts?.changeMap) parts.push(badge("change map"));
  if (artifacts?.review && !artifacts.review.invalid) {
    const review = artifacts.review;
    parts.push(review.blocking ? badge(`${review.blocking} blocking`, "danger") : review.unresolved ? badge(`${review.unresolved} open`, "warning") : badge("review clean", "success"));
  }
  return parts.join("");
}

function tree(data, slug, depth, ctx) {
  const slice = data.record.slices[slug];
  const children = data.derived.children[slug] ?? [];
  return `<li class="slice-row depth-${Math.min(depth, 4)}">
    <div class="slice-row-main">
      ${statusBadge(statusOf(data, slug))}
      <span class="item-title">${sliceLink(data, slug)}</span>
      <code class="slice-slug">${escapeHtml(slug)}</code>
      <span class="chip-row slice-tags">${componentChip(slice.component)}${claimChip(claimOf(data.record.slices, slug))}${sliceSignals(data.slices[slug])}${codeChip(data.code?.[slug])}</span>
    </div>
    ${slice.outcome ? `<p class="slice-outcome">${escapeHtml(slice.outcome)}</p>` : ""}
    ${children.length ? `<ul class="slice-outline">${children.map((child) => tree(data, child, depth + 1, ctx)).join("")}</ul>` : ""}
  </li>`;
}

function clusterPath(data, slug) {
  const names = [];
  for (let owner = data.record.slices[slug].parent; owner !== null; owner = data.record.slices[owner].parent) names.unshift(data.record.slices[owner].title);
  return names.join(" › ");
}

function boardCard(data, slug, ctx) {
  const slice = data.record.slices[slug];
  // The root slice is the initiative itself, so the card names only the slices between it and this one.
  const path = clusterPath(data, slug).split(" › ").slice(1).join(" › ");
  const active = data.active.filter((entry) => entry.slice === slug);
  const tags = `${componentChip(slice.component)}${sliceSignals(data.slices[slug])}${codeChip(data.code?.[slug])}`;
  return `<li class="slice-item status-${escapeHtml(statusOf(data, slug))}">
    ${path ? `<p class="slice-path">${escapeHtml(path)}</p>` : ""}
    <h3 class="item-title">${sliceLink(data, slug)}</h3>
    ${slice.outcome ? `<p class="item-intent">${escapeHtml(slice.outcome)}</p>` : ""}
    ${claimOf(data.record.slices, slug) ? `<p class="slice-claim">${claimChip(claimOf(data.record.slices, slug))}</p>` : ""}
    ${tags ? `<p class="chip-row slice-tags">${tags}</p>` : ""}
    ${active.map((entry) => activeDetails(entry, ctx)).join("")}
  </li>`;
}

// Leaf slices by status; a parent slice that is active also gets a card, so no active work is hidden.
function board(data, ctx) {
  const slugs = [...data.derived.leaves, ...data.active.map((entry) => entry.slice).filter((slug) => data.record.slices[slug] && !data.derived.leaves.includes(slug))];
  const unique = [...new Set(slugs)];
  const known = new Set(STATUS_COLUMNS.map(([status]) => status));
  const extra = [...new Set(unique.map((slug) => statusOf(data, slug)).filter((status) => !known.has(status)))].map((status) => [status, status]);
  const columns = [...STATUS_COLUMNS, ...extra].filter(([status]) => FIXED_COLUMNS.has(status) || unique.some((slug) => statusOf(data, slug) === status));
  return `<div class="slice-columns">${columns.map(([status, label]) => {
    const members = unique.filter((slug) => statusOf(data, slug) === status);
    return `<section class="slice-column" aria-label="${escapeHtml(label)}"><h3 class="slice-column-head">${badge(label, STATUS_TONES[status] ?? "neutral")}<prism-badge>${members.length}</prism-badge></h3><ul class="slice-column-list">${members.map((slug) => boardCard(data, slug, ctx)).join("") || '<li class="column-none muted">—</li>'}</ul></section>`;
  }).join("")}</div>`;
}

async function graph(container, data, ctx) {
  const section = graphCard({ title: plural(data.derived.leaves.length, "leaf slice"), eyebrow: "Execution order: prerequisite → dependent", legend: '<span><i class="legend-status status-done"></i>done</span><span><i class="legend-status status-in-progress"></i>in progress</span><span><i class="legend-status status-blocked"></i>blocked</span><span><i class="legend-status status-not-started"></i>not started</span><span class="legend-hint">Click a slice to open it</span>' });
  container.appendChild(section);
  const nodes = data.derived.leaves.map((slug) => {
    const slice = data.record.slices[slug];
    return { id: slug, title: slice.title, subtitle: `${statusOf(data, slug) === "design-review" ? "design review" : slice.status}${data.slices[slug]?.review?.blocking ? ` · ${data.slices[slug].review.blocking} blocking` : ""}`, tooltip: slice.outcome ?? slice.title, cluster: clusterPath(data, slug) || undefined, className: `slice-node status-${statusOf(data, slug)}` };
  });
  const edges = Object.entries(data.derived.effectiveDependencies).flatMap(([slug, targets]) => targets.map((target) => ({ from: target, to: slug, className: "requires-edge" })));
  const viewport = section.querySelector(".graph-viewport");
  if (nodes.length) {
    await renderGraph(viewport, { label: "Slice dependencies", nodes, edges }, { onSelect: (slug, options) => ctx.openArtifact(`slice:${data.id}/${slug}`, options) });
    enablePanZoom(section, ctx.state.graph ??= {});
  } else {
    viewport.innerHTML = emptyNote("The initiative has no leaf slices.");
  }
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  const item = data.roadmapItem;
  ctx.state.mode ??= "board";
  const modes = data.exists && data.valid ? `<div class="segmented" role="group" aria-label="Initiative view">${MODES.map(([mode, label]) => `<prism-button size="sm" variant="ghost" data-initiative-mode="${mode}" pressed="${ctx.state.mode === mode}">${label}</prism-button>`).join("")}</div>` : "";
  const head = summaryPanel(`
      <div class="summary-row">
        <div class="chip-row">${item ? stateBadge(item.state) : stateBadge("unlisted")}${item ? badge(item.band) : ""}${item?.readyToShip && item.state !== "shipped" ? badge("ready to ship", "success") : ""}</div>
        <div class="view-controls">${artifactChip("roadmap", ctx, "Roadmap")}${modes}</div>
      </div>
      ${item ? `<p class="item-intent is-large">${escapeHtml(item.intent)}</p>` : '<p class="muted">This initiative has a record but no roadmap entry.</p>'}
      ${item?.progress ? progressBar(item.progress) : ""}
      ${keyValues([
        ["Rationale", item?.rationale ? escapeHtml(item.rationale) : null],
        ["Needs", item?.requires.length ? `<span class="chip-row">${item.requires.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join("")}</span>` : null],
        ["Unblocks", item?.requiredBy.length ? `<span class="chip-row">${item.requiredBy.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join("")}</span>` : null],
        ["Requirements", item?.requirements.length ? `<span class="chip-row">${requirementLinks(item.requirements, ctx)}</span>` : null],
        ["Records", `<span class="chip-row">${[artifactChip(data.recordPath, ctx, "Initiative record"), ctx.hasArtifact(data.statePath) ? artifactChip(data.statePath, ctx, "Coordination state") : ""].join("")}</span>`]
      ])}
      ${data.runTotals ? runTotalsHtml(data.runTotals.initiative, "initiative") : ""}`);
  // The settings belong to the initiative whatever state its record is in, so every branch shows them.
  const settings = '<div data-initiative-settings></div>';
  const mountSettings = () => mountInitiativeSettings(container.querySelector("[data-initiative-settings]"), { target: `initiative:${data.id}`, eyebrow: "Orchestration of every slice", ctx });
  if (!data.exists) {
    container.innerHTML = `${head}${card("No slices yet", `<p>No initiative record exists yet.</p><p class="muted">Orchestration creates it when the initiative starts.</p>`, { eyebrow: "Envisioned" })}${settings}`;
    mountSettings();
    bindLinks(container, ctx);
    return;
  }
  if (!data.valid) {
    container.innerHTML = `${head}${card("Invalid initiative record", `<ul class="diagnostic-list">${data.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>`, { eyebrow: "Initiative record" })}${settings}`;
    mountSettings();
    bindLinks(container, ctx);
    return;
  }
  const counts = data.derived.counts;
  const summary = `${plural(data.derived.leaves.length, "leaf slice")} · ${counts.done} done · ${counts["in-progress"]} in progress · ${counts.blocked} blocked`;
  container.innerHTML = `${head}
    <div data-initiative-body></div>
    ${data.derived.designCandidates.length ? card("Design frontier", `<ul class="row-list">${data.derived.designCandidates.map((slug) => `<li>${artifactChip(`slice:${data.id}/${slug}`, ctx, data.record.slices[slug].title)}${data.derived.dependenciesComplete.includes(slug) ? "" : ' <span class="muted">dependencies incomplete</span>'}</li>`).join("")}</ul>`, { eyebrow: "Unstarted leaves" }) : ""}
    ${settings}`;
  mountSettings();
  const body = container.querySelector("[data-initiative-body]");
  if (ctx.state.mode === "graph") await graph(body, data, ctx);
  else if (ctx.state.mode === "list") body.innerHTML = card("Slice tree", `<ul class="slice-outline root">${tree(data, data.derived.root, 0, ctx)}</ul>`, { eyebrow: summary });
  else body.innerHTML = card("Slice board", board(data, ctx), { eyebrow: `${summary}${data.active.length ? ` · ${plural(data.active.length, "active slice")}` : ""}` });
  for (const button of container.querySelectorAll("[data-initiative-mode]")) {
    button.addEventListener("click", () => {
      ctx.state.mode = button.dataset.initiativeMode;
      ctx.rerender();
    });
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
