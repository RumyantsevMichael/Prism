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

const ARCHIVED = new Set(["shipped", "superseded"]);

function visibleItems(data, archive) {
  return archive ? data.items : data.items.filter((item) => !ARCHIVED.has(item.state));
}

const STATE_COLUMNS = [["envisioned", "Envisioned"], ["planned", "Planned"], ["in-progress", "In progress"], ["shipped", "Shipped"]];

function swimlaneCard(item, titles, rank) {
  return `<li class="initiative-card state-${escapeHtml(item.state)}">
    <div class="initiative-card-head"><span class="card-rank" title="Priority ${rank} in ${escapeHtml(item.band)}">#${rank}</span>${item.pillar ? `<span class="pillar">${escapeHtml(item.pillar)}</span>` : ""}</div>
    <h3>${initiativeLink(item.id, item.title)}</h3>
    <p class="initiative-intent">${escapeHtml(item.intent)}</p>
    ${progressBar(item.progress)}
    ${signals(item)}
    ${relationChips(item, titles)}
  </li>`;
}

// Bands are swimlanes and lifecycle states are columns; a card keeps its priority rank within its band.
function board(data, titles, archive, collapsed) {
  const items = visibleItems(data, archive).filter((item) => item.state !== "superseded");
  const superseded = archive ? data.items.filter((item) => item.state === "superseded") : [];
  const bands = archive ? data.bands : data.bands.filter((band) => band !== "Shipped");
  const columns = archive ? STATE_COLUMNS : STATE_COLUMNS.filter(([state]) => state !== "shipped");
  const head = columns.map(([state, label]) => `<div class="swimlane-column state-${state}"><span>${label}</span><span class="column-count">${items.filter((item) => item.state === state).length}</span></div>`).join("");
  const lanes = bands.map((band) => {
    const members = items.filter((item) => item.band === band);
    const rank = new Map(members.map((item, index) => [item.id, index + 1]));
    const open = members.length > 0 && !collapsed.has(band);
    const cells = open ? columns.map(([state]) => {
      const cards = members.filter((item) => item.state === state);
      return `<ul class="swimlane-cell" aria-label="${escapeHtml(band)}, ${escapeHtml(state)}">${cards.map((item) => swimlaneCard(item, titles, rank.get(item.id))).join("")}</ul>`;
    }).join("") : "";
    return `<section class="swimlane band-${band.toLowerCase()}${open ? "" : " is-collapsed"}">
      <h2><button type="button" class="swimlane-toggle" data-lane="${escapeHtml(band)}" aria-expanded="${open}" ${members.length ? "" : "disabled"}>${escapeHtml(band)} <span class="column-count">${members.length}</span></button></h2>
      ${cells}
    </section>`;
  }).join("");
  return `<div class="swimlane-board columns-${columns.length}"><div class="swimlane-head">${head}</div>${lanes}</div>
  ${superseded.length ? `<details class="view-card superseded-card"><summary><span class="eyebrow">Superseded</span> ${plural(superseded.length, "initiative")}</summary><ul class="plain-list">${superseded.map((item) => `<li>${initiativeLink(item.id, item.title)} → ${initiativeLink(item.decision.by, titles.get(item.decision.by) ?? item.decision.by)}: ${escapeHtml(item.decision.reason ?? "")}</li>`).join("")}</ul></details>` : ""}`;
}

function list(data, titles, archive) {
  return card(archive ? "All initiatives" : "Open initiatives", `<div class="table-wrap"><table class="data-table"><thead><tr><th>Initiative</th><th>Band</th><th>State</th><th>Progress</th><th>Needs</th><th>Signals</th></tr></thead><tbody>${visibleItems(data, archive).map((item) => `<tr>
    <td>${initiativeLink(item.id, item.title)}<br><span class="muted">${escapeHtml(item.intent)}</span></td>
    <td>${escapeHtml(item.band)}</td>
    <td>${stateBadge(item.state)}</td>
    <td>${progressBar(item.progress) || '<span class="muted">no slices</span>'}</td>
    <td>${item.requires.map((id) => initiativeLink(id, titles.get(id) ?? id)).join("<br>") || "—"}</td>
    <td>${signals(item) || "—"}</td>
  </tr>`).join("")}</tbody></table></div>`, { eyebrow: "Ordered by band, then priority" });
}

async function graph(container, data, ctx, titles, archive) {
  const items = visibleItems(data, archive);
  const shown = new Set(items.map((item) => item.id));
  const section = graphCard({ title: plural(items.length, "initiative"), eyebrow: "Prerequisite → dependent", legend: '<span class="legend-hint">Click an initiative to open it · Drag to pan</span>' });
  container.appendChild(section);
  const viewport = section.querySelector(".graph-viewport");
  if (!items.length) {
    viewport.innerHTML = emptyNote("The roadmap has no open initiatives.");
    return;
  }
  const nodes = items.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: `${item.band} · ${item.state}${item.progress ? ` · ${item.progress.done}/${item.progress.leaves}` : ""}`,
    tooltip: item.intent,
    cluster: item.state === "superseded" ? "Superseded" : item.band,
    className: `initiative-node state-${item.state}`
  }));
  const edges = items.flatMap((item) => item.requires.filter((target) => shown.has(target)).map((target) => ({ from: target, to: item.id, className: "requires-edge" })));
  await renderGraph(viewport, { label: "Initiative dependencies", nodes, edges }, { onSelect: (id, options) => ctx.openArtifact(`initiative:${id}`, options), clusterLabels: new Map([...data.bands, "Superseded"].map((band) => [band, band])) });
  enablePanZoom(section, ctx.state.graph ??= {});
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  ctx.state.mode ??= "board";
  ctx.state.archive ??= false;
  const archived = data.items.filter((item) => ARCHIVED.has(item.state)).length;
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
        <div class="roadmap-controls">
          <button type="button" class="tool-button" data-roadmap-archive aria-pressed="${ctx.state.archive}" ${archived ? "" : "disabled"}>${ctx.state.archive ? "Hide" : "Show"} shipped and superseded (${archived})</button>
          <div class="segmented" role="group" aria-label="Roadmap view">${MODES.map(([mode, label]) => `<button type="button" data-roadmap-mode="${mode}" aria-pressed="${ctx.state.mode === mode}">${label}</button>`).join("")}</div>
        </div>
      </div>
      ${missing}
    </section>
    <div data-roadmap-body></div>
    ${data.openQuestions?.length ? card("Open questions", `<ul class="plain-list">${data.openQuestions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>`, { eyebrow: "Unresolved" }) : ""}
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="plain-list">${data.unlisted.map((id) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
  const body = container.querySelector("[data-roadmap-body]");
  if (ctx.state.mode === "graph") {
    await graph(body, data, ctx, titles, ctx.state.archive);
  } else {
    ctx.state.collapsedLanes ??= [];
    body.innerHTML = ctx.state.mode === "list" ? list(data, titles, ctx.state.archive) : board(data, titles, ctx.state.archive, new Set(ctx.state.collapsedLanes));
  }
  for (const toggle of container.querySelectorAll("[data-lane]")) {
    toggle.addEventListener("click", () => {
      const lanes = new Set(ctx.state.collapsedLanes);
      if (lanes.has(toggle.dataset.lane)) lanes.delete(toggle.dataset.lane);
      else lanes.add(toggle.dataset.lane);
      ctx.state.collapsedLanes = [...lanes];
      ctx.rerender();
    });
  }
  container.querySelector("[data-roadmap-archive]").addEventListener("click", () => {
    ctx.state.archive = !ctx.state.archive;
    ctx.rerender();
  });
  for (const button of container.querySelectorAll("[data-roadmap-mode]")) {
    button.addEventListener("click", () => {
      ctx.state.mode = button.dataset.roadmapMode;
      ctx.rerender();
    });
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
