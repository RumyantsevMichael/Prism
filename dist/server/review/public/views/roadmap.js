import { applyWidths, progressBar, stateBadge } from "./entities.js";
import { isExpired } from "./claim-index.js";
import { claimAttributes } from "./claims.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { badge, bindLinks, card, emptyNote, escapeHtml, plural, stat, summaryPanel } from "./util.js";

const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];

export { stateBadge };

// An initiative's title is a link to its page, which a click opens in place and a modified click keeps open.
export function initiativeLink(id, title) {
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(`initiative:${id}`)}" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(title)}</a>`;
}

function relationChips(item, titles) {
  const chips = [];
  for (const id of item.requires) chips.push(`<prism-chip interactive data-artifact="initiative:${escapeHtml(id)}" tip="Requires ${escapeHtml(titles.get(id) ?? id)}">needs ${escapeHtml(titles.get(id) ?? id)}</prism-chip>`);
  for (const id of item.requiredBy) chips.push(`<prism-chip interactive tone="info" data-artifact="initiative:${escapeHtml(id)}" tip="Unblocks ${escapeHtml(titles.get(id) ?? id)}">unblocks ${escapeHtml(titles.get(id) ?? id)}</prism-chip>`);
  return chips.length ? `<div class="chip-row relations">${chips.join("")}</div>` : "";
}

function signals(item) {
  const parts = [];
  if (item.readyToShip && item.state !== "shipped") parts.push(badge("ready to ship", "success"));
  if (item.findings?.blocking) parts.push(badge(plural(item.findings.blocking, "blocking finding"), "danger"));
  else if (item.findings?.unresolved) parts.push(badge(plural(item.findings.unresolved, "open finding"), "warning"));
  if (item.active?.length) parts.push(badge(plural(item.active.length, "active slice"), "info"));
  if (item.diagnostics?.length) parts.push(`<prism-chip tone="danger" tip="${escapeHtml(item.diagnostics.map((entry) => entry.message).join(" "))}">record problem</prism-chip>`);
  return parts.length ? `<div class="chip-row signals">${parts.join("")}</div>` : "";
}

// Who works on an initiative's slices: a stack of the holders' avatars, the live count, and the expired count; read-only.
export function claimStack(claims = []) {
  if (!claims.length) return "";
  const now = Date.now();
  const live = claims.filter((claim) => !isExpired(claim, now));
  const expired = claims.length - live.length;
  const counts = [live.length ? `${live.length} working` : "", expired ? `${expired} ${expired === 1 ? "claim" : "claims"} expired` : ""].filter(Boolean);
  return `<div class="claim-stack"><span class="avatar-stack">${[...live, ...claims.filter((claim) => isExpired(claim, now))].map((claim) => `<prism-claim variant="avatar"${claimAttributes(claim)}></prism-claim>`).join("")}</span><span class="claim-counts">${counts.map((text, index) => `<span class="${index && expired ? "is-expired" : ""}">${text}</span>`).join('<span aria-hidden="true"> · </span>')}</span></div>`;
}

const ARCHIVED = new Set(["shipped", "superseded"]);

function visibleItems(data, archive) {
  return archive ? data.items : data.items.filter((item) => !ARCHIVED.has(item.state));
}

const STATE_COLUMNS = [["envisioned", "Envisioned"], ["planned", "Planned"], ["in-progress", "In progress"], ["shipped", "Shipped"]];

function swimlaneCard(item, titles, rank) {
  return `<li class="initiative-item state-${escapeHtml(item.state)}">
    <div class="initiative-item-head"><span class="item-rank"><span aria-hidden="true">#${rank}</span><span class="sr-only">Priority ${rank} in ${escapeHtml(item.band)}</span></span>${item.pillar ? badge(item.pillar) : ""}</div>
    <h3 class="item-title">${initiativeLink(item.id, item.title)}</h3>
    <p class="item-intent">${escapeHtml(item.intent)}</p>
    ${progressBar(item.progress)}
    ${claimStack(item.claims)}
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
  const head = columns.map(([state, label]) => `<div class="lane-column state-${state}"><span>${label}</span><prism-badge>${items.filter((item) => item.state === state).length}</prism-badge></div>`).join("");
  const lanes = bands.map((band) => {
    const members = items.filter((item) => item.band === band);
    const rank = new Map(members.map((item, index) => [item.id, index + 1]));
    const open = members.length > 0 && !collapsed.has(band);
    const cells = members.length ? columns.map(([state, label]) => {
      const cards = members.filter((item) => item.state === state);
      return `<ul class="lane-cell" aria-label="${escapeHtml(band)}, ${escapeHtml(label)}"><li class="lane-cell-label" aria-hidden="true">${escapeHtml(label)}</li>${cards.map((item) => swimlaneCard(item, titles, rank.get(item.id))).join("")}</ul>`;
    }).join("") : "";
    const lane = `<div class="lane-cells">${cells}</div>`;
    return members.length
      ? `<section class="lane band-${band.toLowerCase()}" aria-label="${escapeHtml(band)}"><prism-disclosure data-lane="${escapeHtml(band)}" summary="${escapeHtml(`${band} · ${members.length}`)}"${open ? " open" : ""}>${lane}</prism-disclosure></section>`
      : `<section class="lane band-${band.toLowerCase()} is-empty" aria-label="${escapeHtml(band)}"><h2 class="lane-heading">${escapeHtml(band)} <span class="muted">· 0</span></h2></section>`;
  }).join("");
  return `<div class="lane-board columns-${columns.length}"><div class="lane-head" aria-hidden="true">${head}</div>${lanes}</div>
  ${superseded.length ? card("Superseded", `<prism-disclosure summary="${escapeHtml(plural(superseded.length, "initiative"))}"><ul class="row-list">${superseded.map((item) => `<li>${initiativeLink(item.id, item.title)} → ${initiativeLink(item.decision.by, titles.get(item.decision.by) ?? item.decision.by)}: ${escapeHtml(item.decision.reason ?? "")}</li>`).join("")}</ul></prism-disclosure>`) : ""}`;
}

function list(data, titles, archive) {
  return card(archive ? "All initiatives" : "Open initiatives", `<div class="table-wrap"><table class="data-table"><thead><tr><th>Initiative</th><th>Band</th><th>State</th><th>Progress</th><th>Needs</th><th>Signals</th></tr></thead><tbody>${visibleItems(data, archive).map((item) => `<tr>
    <td>${initiativeLink(item.id, item.title)}<br><span class="muted">${escapeHtml(item.intent)}</span>${claimStack(item.claims)}</td>
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
      ? `<p>No roadmap record exists yet.</p><p class="muted">Run <code>setup</code> to create or migrate it.</p>`
      : !data.valid
        ? `<p class="error">The roadmap record is invalid: ${escapeHtml(data.errors.join(" "))}</p>`
        : "";
  const counts = Object.fromEntries(["in-progress", "planned", "envisioned", "shipped"].map((state) => [state, data.items.filter((item) => item.state === state).length]));
  container.innerHTML = `
    ${summaryPanel(`<div class="summary-row">
        <div class="stat-grid">
          ${stat("initiatives", String(data.items.length))}
          ${stat("in progress", String(counts["in-progress"]), { tone: "info" })}
          ${stat("planned", String(counts.planned))}
          ${stat("envisioned", String(counts.envisioned))}
          ${stat("shipped", String(counts.shipped), { tone: "success" })}
        </div>
        <div class="view-controls">
          <prism-button size="sm" data-roadmap-archive pressed="${ctx.state.archive}"${archived ? "" : " disabled"}>${ctx.state.archive ? "Hide" : "Show"} shipped and superseded (${archived})</prism-button>
          <div class="segmented" role="group" aria-label="Roadmap view">${MODES.map(([mode, label]) => `<prism-button size="sm" variant="ghost" data-roadmap-mode="${mode}" pressed="${ctx.state.mode === mode}">${label}</prism-button>`).join("")}</div>
        </div>
      </div>
      ${missing}`)}
    <div data-roadmap-body></div>
    ${data.openQuestions?.length ? card("Open questions", `<ul class="row-list">${data.openQuestions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>`, { eyebrow: "Unresolved" }) : ""}
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="row-list">${data.unlisted.map((id) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
  const body = container.querySelector("[data-roadmap-body]");
  if (ctx.state.mode === "graph") {
    await graph(body, data, ctx, titles, ctx.state.archive);
  } else {
    ctx.state.collapsedLanes ??= [];
    body.innerHTML = ctx.state.mode === "list" ? list(data, titles, ctx.state.archive) : board(data, titles, ctx.state.archive, new Set(ctx.state.collapsedLanes));
  }
  for (const lane of container.querySelectorAll("[data-lane]")) {
    lane.addEventListener("toggle", () => {
      const lanes = new Set(ctx.state.collapsedLanes);
      if (lane.open) lanes.delete(lane.dataset.lane);
      else lanes.add(lane.dataset.lane);
      ctx.state.collapsedLanes = [...lanes];
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
