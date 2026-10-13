import { applyWidths, progressBar, stateBadge } from "./entities.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { bindLinks, card, emptyNote, escapeHtml, plural } from "./util.js";

const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];

function initiativeLink(id, title) {
  return `<button type="button" class="text-button" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(title)}</button>`;
}

function relationChips(item, titles) {
  const chips = [];
  for (const id of item.requires) chips.push(`<button type="button" class="relation-chip" data-artifact="initiative:${escapeHtml(id)}" title="Requires ${escapeHtml(titles.get(id) ?? id)}">needs ${escapeHtml(titles.get(id) ?? id)}</button>`);
  for (const id of item.requiredBy) chips.push(`<button type="button" class="relation-chip is-inverse" data-artifact="initiative:${escapeHtml(id)}" title="Unblocks ${escapeHtml(titles.get(id) ?? id)}">unblocks ${escapeHtml(titles.get(id) ?? id)}</button>`);
  return chips.length ? `<div class="relation-chips">${chips.join("")}</div>` : "";
}

function signals(item) {
  const parts = [];
  if (item.readyToShip && item.state !== "shipped") parts.push('<span class="status-pill is-good">ready to ship</span>');
  if (item.findings?.blocking) parts.push(`<span class="status-pill is-bad">${plural(item.findings.blocking, "blocking finding")}</span>`);
  else if (item.findings?.unresolved) parts.push(`<span class="status-pill is-warn">${plural(item.findings.unresolved, "open finding")}</span>`);
  if (item.active?.length) parts.push(`<span class="status-pill is-info">${plural(item.active.length, "active slice")}</span>`);
  if (item.diagnostics?.length) parts.push(`<span class="status-pill is-bad" title="${escapeHtml(item.diagnostics.map((entry) => entry.message).join(" "))}">record problem</span>`);
  return parts.length ? `<div class="card-signals">${parts.join("")}</div>` : "";
}

function initiativeCard(item, titles) {
  return `<li class="initiative-card state-${escapeHtml(item.state)}">
    <div class="initiative-card-head">${stateBadge(item.state)}${item.pillar ? `<span class="pillar">${escapeHtml(item.pillar)}</span>` : ""}</div>
    <h3>${initiativeLink(item.id, item.title)}</h3>
    <p class="initiative-intent">${escapeHtml(item.intent)}</p>
    ${progressBar(item.progress)}
    ${signals(item)}
    ${relationChips(item, titles)}
  </li>`;
}

function board(data, titles) {
  const open = data.items.filter((item) => item.state !== "superseded");
  const superseded = data.items.filter((item) => item.state === "superseded");
  return `<div class="roadmap-board">${data.bands.map((band) => {
    const members = open.filter((item) => item.band === band);
    return `<section class="band-column band-${band.toLowerCase()}"><h2>${escapeHtml(band)} <span class="column-count">${members.length}</span></h2><ul>${members.map((item) => initiativeCard(item, titles)).join("") || '<li class="column-empty">—</li>'}</ul></section>`;
  }).join("")}</div>
  ${superseded.length ? `<details class="view-card superseded-card"><summary><span class="eyebrow">Superseded</span> ${plural(superseded.length, "initiative")}</summary><ul class="plain-list">${superseded.map((item) => `<li>${initiativeLink(item.id, item.title)} → ${initiativeLink(item.decision.by, titles.get(item.decision.by) ?? item.decision.by)}: ${escapeHtml(item.decision.reason ?? "")}</li>`).join("")}</ul></details>` : ""}`;
}

function list(data, titles) {
  return card("All initiatives", `<div class="table-wrap"><table class="data-table"><thead><tr><th>Initiative</th><th>Band</th><th>State</th><th>Progress</th><th>Needs</th><th>Signals</th></tr></thead><tbody>${data.items.map((item) => `<tr>
    <td>${initiativeLink(item.id, item.title)}<br><span class="muted">${escapeHtml(item.intent)}</span></td>
    <td>${escapeHtml(item.band)}</td>
    <td>${stateBadge(item.state)}</td>
    <td>${progressBar(item.progress) || '<span class="muted">no slices</span>'}</td>
    <td>${item.requires.map((id) => initiativeLink(id, titles.get(id) ?? id)).join("<br>") || "—"}</td>
    <td>${signals(item) || "—"}</td>
  </tr>`).join("")}</tbody></table></div>`, { eyebrow: "Ordered by band, then priority" });
}

async function graph(container, data, ctx, titles) {
  const section = graphCard({ title: plural(data.items.length, "initiative"), eyebrow: "Prerequisite → dependent", legend: '<span class="legend-hint">Click an initiative to open it · Drag to pan</span>' });
  container.appendChild(section);
  const viewport = section.querySelector(".graph-viewport");
  if (!data.items.length) {
    viewport.innerHTML = emptyNote("The roadmap has no initiatives.");
    return;
  }
  const nodes = data.items.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: `${item.band} · ${item.state}${item.progress ? ` · ${item.progress.done}/${item.progress.leaves}` : ""}`,
    tooltip: item.intent,
    cluster: item.state === "superseded" ? "Superseded" : item.band,
    className: `initiative-node state-${item.state}`
  }));
  const edges = data.items.flatMap((item) => item.requires.map((target) => ({ from: target, to: item.id, className: "requires-edge" })));
  await renderGraph(viewport, { label: "Initiative dependencies", nodes, edges }, { onSelect: (id) => ctx.openArtifact(`initiative:${id}`), clusterLabels: new Map([...data.bands, "Superseded"].map((band) => [band, band])) });
  enablePanZoom(section, ctx.state.graph ??= {});
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  ctx.state.mode ??= "board";
  const titles = new Map(data.items.map((item) => [item.id, item.title]));
  const missing = data.error
    ? `<p class="error">${escapeHtml(data.error)}</p>`
    : !data.exists
      ? `<p>No roadmap record exists yet at <code>${escapeHtml(data.recordPath)}</code>.</p><p class="muted">Run <code>roadmap</code> to create or migrate it, or <code>workflow-init</code> for a new project.</p>`
      : !data.valid
        ? `<p class="error">The roadmap record is invalid: ${escapeHtml(data.errors.join(" "))}</p>`
        : "";
  const counts = Object.fromEntries(["in-progress", "planned", "envisioned", "shipped"].map((state) => [state, data.items.filter((item) => item.state === state).length]));
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="stat-row">
          <div class="stat"><span class="stat-value">${data.items.length}</span><span class="stat-label">initiatives</span></div>
          <div class="stat is-info"><span class="stat-value">${counts["in-progress"]}</span><span class="stat-label">in progress</span></div>
          <div class="stat"><span class="stat-value">${counts.planned}</span><span class="stat-label">planned</span></div>
          <div class="stat"><span class="stat-value">${counts.envisioned}</span><span class="stat-label">envisioned</span></div>
          <div class="stat is-good"><span class="stat-value">${counts.shipped}</span><span class="stat-label">shipped</span></div>
        </div>
        <div class="segmented" role="group" aria-label="Roadmap view">${MODES.map(([mode, label]) => `<button type="button" data-roadmap-mode="${mode}" aria-pressed="${ctx.state.mode === mode}">${label}</button>`).join("")}</div>
      </div>
      ${missing}
    </section>
    <div data-roadmap-body></div>
    ${data.openQuestions?.length ? card("Open questions", `<ul class="plain-list">${data.openQuestions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>`, { eyebrow: "Unresolved" }) : ""}
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="plain-list">${data.unlisted.map((id) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
  const body = container.querySelector("[data-roadmap-body]");
  if (ctx.state.mode === "graph") {
    await graph(body, data, ctx, titles);
  } else {
    body.innerHTML = ctx.state.mode === "list" ? list(data, titles) : board(data, titles);
  }
  for (const button of container.querySelectorAll("[data-roadmap-mode]")) {
    button.addEventListener("click", () => {
      ctx.state.mode = button.dataset.roadmapMode;
      ctx.rerender();
    });
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
