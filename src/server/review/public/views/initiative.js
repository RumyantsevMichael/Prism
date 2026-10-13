import { applyWidths, progressBar, stateBadge } from "./entities.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, keyValues, plural } from "./util.js";

function statusBadge(status) {
  return `<span class="slice-status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function requirementLinks(references, ctx) {
  return references.map((reference) => {
    const [file, anchor] = reference.split("#");
    const label = `${file.split("/").pop()}${anchor ? `#${anchor}` : ""}`;
    return ctx.hasArtifact(file) ? `<button type="button" class="link-chip artifact-chip" data-artifact="${escapeHtml(file)}"><code>${escapeHtml(label)}</code></button>` : `<code>${escapeHtml(reference)}</code>`;
  }).join(" ");
}

function sliceSignals(artifacts) {
  const parts = [];
  if (artifacts?.conceptDelta) parts.push('<span class="artifact-tag">delta</span>');
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

export async function render(container, entity, ctx) {
  const data = entity.data;
  const item = data.roadmapItem;
  const head = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status">${item ? stateBadge(item.state) : stateBadge("unlisted")}${item ? `<span class="meta-pill">${escapeHtml(item.band)}</span>` : ""}${item?.readyToShip && item.state !== "shipped" ? '<span class="status-pill is-good">ready to ship</span>' : ""}</div>
        <div class="summary-links">${artifactChip("roadmap", ctx, "Roadmap")}</div>
      </div>
      ${item ? `<p class="initiative-intent large">${escapeHtml(item.intent)}</p>` : '<p class="muted">This initiative has a record but no roadmap entry.</p>'}
      ${item?.progress ? progressBar(item.progress) : ""}
      ${keyValues([
        ["Rationale", item?.rationale ? escapeHtml(item.rationale) : null],
        ["Needs", item?.requires.length ? item.requires.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join(" ") : null],
        ["Unblocks", item?.requiredBy.length ? item.requiredBy.map((id) => artifactChip(`initiative:${id}`, ctx, id)).join(" ") : null],
        ["Requirements", item?.requirements.length ? requirementLinks(item.requirements, ctx) : null],
        ["Active work", data.active.length ? data.active.map((entry) => `<span class="meta-pill">${escapeHtml(entry.slice)} · ${escapeHtml(entry.activity)} · ${escapeHtml((entry.workers ?? []).join(", "))}</span>`).join(" ") : null],
        ["Records", [artifactChip(data.recordPath, ctx, "initiative.json"), ctx.hasArtifact(data.statePath) ? artifactChip(data.statePath, ctx, "state.json") : ""].join(" ")]
      ])}
    </section>`;
  if (!data.exists) {
    container.innerHTML = `${head}${card("No slices yet", `<p>No initiative record exists at <code>${escapeHtml(data.recordPath)}</code>.</p><p class="muted">Orchestration creates it when the initiative starts.</p>`, { eyebrow: "Envisioned" })}`;
    bindLinks(container, ctx);
    return;
  }
  if (!data.valid) {
    container.innerHTML = `${head}${card("Invalid initiative record", `<ul class="diagnostic-list">${data.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>`)}`;
    bindLinks(container, ctx);
    return;
  }
  const counts = data.derived.counts;
  container.innerHTML = `${head}
    <div data-graph-slot></div>
    ${card("Slice tree", `<ul class="slice-tree root">${tree(data, data.derived.root, 0, ctx)}</ul>`, { eyebrow: `${plural(data.derived.leaves.length, "leaf slice")} · ${counts.done} done · ${counts["in-progress"]} in progress · ${counts.blocked} blocked` })}
    ${data.derived.designCandidates.length ? card("Design frontier", `<ul class="plain-list">${data.derived.designCandidates.map((slug) => `<li>${artifactChip(`slice:${data.id}/${slug}`, ctx, data.record.slices[slug].title)}${data.derived.dependenciesComplete.includes(slug) ? "" : ' <span class="muted">dependencies incomplete</span>'}</li>`).join("")}</ul>`, { eyebrow: "Unstarted leaves" }) : ""}`;
  const section = graphCard({ title: plural(data.derived.leaves.length, "leaf slice"), eyebrow: "Execution order: prerequisite → dependent", legend: '<span><i class="legend-status status-done"></i>done</span><span><i class="legend-status status-in-progress"></i>in progress</span><span><i class="legend-status status-blocked"></i>blocked</span><span><i class="legend-status status-not-started"></i>not started</span><span class="legend-hint">Click a slice to open it</span>' });
  container.querySelector("[data-graph-slot]").appendChild(section);
  const nodes = data.derived.leaves.map((slug) => {
    const slice = data.record.slices[slug];
    return { id: slug, title: slice.title, subtitle: `${slice.status}${data.slices[slug]?.review?.blocking ? ` · ${data.slices[slug].review.blocking} blocking` : ""}`, tooltip: slice.outcome ?? slice.title, cluster: clusterPath(data, slug) || undefined, className: `slice-node status-${slice.status}` };
  });
  const edges = Object.entries(data.derived.effectiveDependencies).flatMap(([slug, targets]) => targets.map((target) => ({ from: target, to: slug, className: "requires-edge" })));
  const viewport = section.querySelector(".graph-viewport");
  if (nodes.length) {
    await renderGraph(viewport, { label: "Slice dependencies", nodes, edges }, { onSelect: (slug) => ctx.openArtifact(`slice:${data.id}/${slug}`) });
    enablePanZoom(section, ctx.state.graph ??= {});
  } else {
    viewport.innerHTML = emptyNote("The initiative has no leaf slices.");
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
