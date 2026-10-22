import { activeDetails } from "./coordination-state.js";
import { applyWidths, progressBar, stateBadge } from "./entities.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, keyValues, plural, requirementLinks } from "./util.js";

const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];
// These columns always show; another status, such as deferred, gets a column only while a slice has it.
const STATUS_COLUMNS = [["not-started", "Not started"], ["in-progress", "In progress"], ["blocked", "Blocked"], ["deferred", "Deferred"], ["done", "Done"]];
const FIXED_COLUMNS = new Set(["not-started", "in-progress", "blocked", "done"]);

function statusBadge(status) {
  return `<span class="slice-status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}


function sliceSignals(artifacts) {
  const parts = [];
  if (artifacts?.changeMap) parts.push('<span class="artifact-tag">delta</span>');
  if (artifacts?.review && !artifacts.review.invalid) {
    const review = artifacts.review;
    parts.push(review.blocking ? `<span class="artifact-tag is-bad">${review.blocking} blocking</span>` : review.unresolved ? `<span class="artifact-tag is-warn">${review.unresolved} open</span>` : '<span class="artifact-tag is-good">review clean</span>');
  }
  return parts.join("");
}

function tree(data, slug, depth, ctx) {
  const slice = data.record.slices[slug];
  const children = data.derived.children[slug] ?? [];
  return `<li class="slice-row depth-${Math.min(depth, 4)}">
    <div class="slice-row-main">
      ${statusBadge(slice.status)}
      <button type="button" class="text-button slice-title" data-artifact="slice:${escapeHtml(data.id)}/${escapeHtml(slug)}">${escapeHtml(slice.title)}</button>
      <code class="slice-slug">${escapeHtml(slug)}</code>
      <span class="slice-tags">${sliceSignals(data.slices[slug])}</span>
    </div>
    ${slice.outcome ? `<p class="slice-outcome">${escapeHtml(slice.outcome)}</p>` : ""}
    ${children.length ? `<ul class="slice-tree">${children.map((child) => tree(data, child, depth + 1, ctx)).join("")}</ul>` : ""}
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
  return `<li class="slice-card slice-board-card status-${escapeHtml(slice.status)}">
    ${path ? `<p class="slice-path">${escapeHtml(path)}</p>` : ""}
    <h3><button type="button" class="text-button" data-artifact="slice:${escapeHtml(data.id)}/${escapeHtml(slug)}">${escapeHtml(slice.title)}</button></h3>
    ${slice.outcome ? `<p class="initiative-intent">${escapeHtml(slice.outcome)}</p>` : ""}
    ${sliceSignals(data.slices[slug]) ? `<p class="slice-tags">${sliceSignals(data.slices[slug])}</p>` : ""}
    ${active.map((entry) => activeDetails(entry, ctx)).join("")}
  </li>`;
}

// Leaf slices by status; a parent slice that is active also gets a card, so no active work is hidden.
function board(data, ctx) {
  const slugs = [...data.derived.leaves, ...data.active.map((entry) => entry.slice).filter((slug) => data.record.slices[slug] && !data.derived.leaves.includes(slug))];
  const unique = [...new Set(slugs)];
  const known = new Set(STATUS_COLUMNS.map(([status]) => status));
  const extra = [...new Set(unique.map((slug) => data.record.slices[slug].status).filter((status) => !known.has(status)))].map((status) => [status, status]);
  const columns = [...STATUS_COLUMNS, ...extra].filter(([status]) => FIXED_COLUMNS.has(status) || unique.some((slug) => data.record.slices[slug].status === status));
  return `<div class="slice-board">${columns.map(([status, label]) => {
    const members = unique.filter((slug) => data.record.slices[slug].status === status);
    return `<div class="board-column"><h3><span class="slice-status status-${escapeHtml(status)}">${escapeHtml(label)}</span><span class="column-count">${members.length}</span></h3><ul>${members.map((slug) => boardCard(data, slug, ctx)).join("") || '<li class="column-empty">—</li>'}</ul></div>`;
  }).join("")}</div>`;
}

async function graph(container, data, ctx) {
  const section = graphCard({ title: plural(data.derived.leaves.length, "leaf slice"), eyebrow: "Execution order: prerequisite → dependent", source: "initiative.json", legend: '<span><i class="legend-status status-done"></i>done</span><span><i class="legend-status status-in-progress"></i>in progress</span><span><i class="legend-status status-blocked"></i>blocked</span><span><i class="legend-status status-not-started"></i>not started</span><span class="legend-hint">Click a slice to open it</span>' });
  container.appendChild(section);
  const nodes = data.derived.leaves.map((slug) => {
    const slice = data.record.slices[slug];
    return { id: slug, title: slice.title, subtitle: `${slice.status}${data.slices[slug]?.review?.blocking ? ` · ${data.slices[slug].review.blocking} blocking` : ""}`, tooltip: slice.outcome ?? slice.title, cluster: clusterPath(data, slug) || undefined, className: `slice-node status-${slice.status}` };
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
  const modes = data.exists && data.valid ? `<div class="segmented" role="group" aria-label="Initiative view">${MODES.map(([mode, label]) => `<button type="button" data-initiative-mode="${mode}" aria-pressed="${ctx.state.mode === mode}">${label}</button>`).join("")}</div>` : "";
  const head = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status">${item ? stateBadge(item.state) : stateBadge("unlisted")}${item ? `<span class="meta-pill">${escapeHtml(item.band)}</span>` : ""}${item?.readyToShip && item.state !== "shipped" ? '<span class="status-pill is-good">ready to ship</span>' : ""}</div>
        <div class="summary-links">${artifactChip("roadmap", ctx, "Roadmap")}${modes}</div>
      </div>
      ${item ? `<p class="initiative-intent large">${escapeHtml(item.intent)}</p>` : '<p class="muted">This initiative has a record but no roadmap entry.</p>'}
      ${item?.progress ? progressBar(item.progress) : ""}
      ${keyValues([
        ["Rationale", item?.rationale ? escapeHtml(item.rationale) : null],
        ["Needs", item?.requires.length ? item.requires.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join(" ") : null],
        ["Unblocks", item?.requiredBy.length ? item.requiredBy.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join(" ") : null],
        ["Requirements", item?.requirements.length ? requirementLinks(item.requirements, ctx) : null],
        ["Records", [artifactChip(data.recordPath, ctx, "initiative.json"), ctx.hasArtifact(data.statePath) ? artifactChip(data.statePath, ctx, "state.json") : ""].join(" ")]
      ])}
    </section>`;
  if (!data.exists) {
    container.innerHTML = `${head}${card("No slices yet", `<p>No initiative record exists at <code>${escapeHtml(data.recordPath)}</code>.</p><p class="muted">Orchestration creates it when the initiative starts.</p>`, { eyebrow: "Envisioned" })}`;
    bindLinks(container, ctx);
    return;
  }
  if (!data.valid) {
    container.innerHTML = `${head}${card("Invalid initiative record", `<ul class="diagnostic-list">${data.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>`, { source: "initiative.json" })}`;
    bindLinks(container, ctx);
    return;
  }
  const counts = data.derived.counts;
  const summary = `${plural(data.derived.leaves.length, "leaf slice")} · ${counts.done} done · ${counts["in-progress"]} in progress · ${counts.blocked} blocked`;
  container.innerHTML = `${head}
    <div data-initiative-body></div>
    ${data.derived.designCandidates.length ? card("Design frontier", `<ul class="plain-list">${data.derived.designCandidates.map((slug) => `<li>${artifactChip(`slice:${data.id}/${slug}`, ctx, data.record.slices[slug].title)}${data.derived.dependenciesComplete.includes(slug) ? "" : ' <span class="muted">dependencies incomplete</span>'}</li>`).join("")}</ul>`, { eyebrow: "Unstarted leaves", source: "initiative.json" }) : ""}`;
  const body = container.querySelector("[data-initiative-body]");
  if (ctx.state.mode === "graph") await graph(body, data, ctx);
  else if (ctx.state.mode === "list") body.innerHTML = card("Slice tree", `<ul class="slice-tree root">${tree(data, data.derived.root, 0, ctx)}</ul>`, { eyebrow: summary, source: "initiative.json" });
  else body.innerHTML = card("Slice board", board(data, ctx), { eyebrow: `${summary}${data.active.length ? ` · ${plural(data.active.length, "active slice")}` : ""}`, source: data.active.length ? "initiative.json · state.json" : "initiative.json" });
  for (const button of container.querySelectorAll("[data-initiative-mode]")) {
    button.addEventListener("click", () => {
      ctx.state.mode = button.dataset.initiativeMode;
      ctx.rerender();
    });
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
