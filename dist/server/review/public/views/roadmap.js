import { applyWidths, progressBar, stateBadge } from "./entities.js";
import { isExpired } from "./claim-index.js";
import { claimAttributes } from "./claims.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { badge, bindLinks, card, emptyNote, escapeHtml, plural } from "./util.js";
import { currentPhase } from "./slice.js";
import { preference, setPreference } from "../kit/preferences.js";

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

const STATE_NAMES = { envisioned: "Envisioned", planned: "Planned", "in-progress": "In progress", shipped: "Shipped", superseded: "Superseded" };
const BAND_HINTS = { Now: "being built", Next: "designed next", Later: "envisioned", Parked: "not planned", Shipped: "done" };
const PHASE_NAMES = ["requirements", "design", "frozen", "build", "review", "shipped"];

// One segment per leaf slice in the color of its phase; a slice that has not started and has no design draws the empty line.
function phaseBar(item) {
  const slices = item.slices ?? [];
  if (!slices.length || item.state === "envisioned") return "";
  const phases = slices.map((slice) => {
    if (slice.status === "not-started" && !slice.designed) return "";
    const index = currentPhase({ status: slice.status, design: slice.designed ? { review: slice.review } : null });
    return PHASE_NAMES[Math.min(index, PHASE_NAMES.length - 1)];
  });
  const shipped = slices.filter((slice) => slice.status === "done").length;
  const started = phases.filter(Boolean).length;
  const label = started || shipped ? `${shipped} of ${slices.length} shipped` : `0 of ${slices.length} started`;
  return `<prism-phase-bar phases="${phases.join(",")}" label="${label}"></prism-phase-bar>`;
}

// The card's footer: who holds its slices, or that nobody does yet once it has slices to hold.
function cardFoot(item) {
  if (item.claims?.length) return `<footer class="roadmap-item-foot">${claimStack(item.claims)}</footer>`;
  if (item.slices?.length && (item.state === "planned" || item.state === "in-progress")) return '<footer class="roadmap-item-foot"><span>Nobody holds a slice yet</span></footer>';
  return "";
}

function boardCard(item, titles, rank) {
  return `<article class="initiative-item roadmap-item state-${escapeHtml(item.state)}" aria-labelledby="roadmap-item-${escapeHtml(item.id)}">
    <header class="roadmap-item-top"><span class="item-rank"><span aria-hidden="true">#${rank}</span><span class="sr-only">Priority ${rank} in ${escapeHtml(item.band)}</span></span>${item.pillar ? `<span class="roadmap-item-area">${escapeHtml(item.pillar)}</span>` : ""}<prism-state state="${escapeHtml(item.state)}">${escapeHtml(STATE_NAMES[item.state] ?? item.state)}</prism-state></header>
    <h3 class="item-title" id="roadmap-item-${escapeHtml(item.id)}">${initiativeLink(item.id, item.title)}</h3>
    <p class="item-intent">${escapeHtml(item.intent)}</p>
    ${phaseBar(item)}
    ${signals(item)}
    ${relationChips(item, titles)}
    ${cardFoot(item)}
  </article>`;
}

// Bands are full-width lanes stacked in priority order, each with its count and what it holds above its cards; a card keeps its priority rank within its band, and its state shows on the card.
// An empty band takes one line, so the bands that hold work stay close together.
function board(data, titles, archive, collapsed) {
  const items = visibleItems(data, archive).filter((item) => item.state !== "superseded");
  const superseded = archive ? data.items.filter((item) => item.state === "superseded") : [];
  const bands = archive ? data.bands : data.bands.filter((band) => band !== "Shipped");
  const lanes = bands.map((band) => {
    const members = items.filter((item) => item.band === band);
    const open = !collapsed.has(band);
    const id = `roadmap-band-${band.toLowerCase()}`;
    const hint = BAND_HINTS[band] ? `<span class="roadmap-band-hint">${BAND_HINTS[band]}</span>` : "";
    const toggle = `<prism-button class="roadmap-band-toggle" variant="ghost" size="sm" data-lane="${escapeHtml(band)}" label="${open ? "Collapse" : "Expand"} ${escapeHtml(band)}" aria-expanded="${open}"><prism-icon name="${open ? "chevron-down" : "chevron-right"}" size="xs"></prism-icon></prism-button>`;
    const classes = `roadmap-band band-${band.toLowerCase()}${band === "Parked" ? " is-parked" : ""}${members.length ? "" : " has-none"}`;
    if (!members.length) {
      return `<section class="${classes}" aria-labelledby="${id}">
      <header class="roadmap-band-head"><h2 class="roadmap-band-name" id="${id}">${escapeHtml(band)}</h2><prism-badge tone="neutral">0</prism-badge>${hint}<span class="roadmap-band-none muted">No initiatives</span></header>
    </section>`;
    }
    return `<section class="${classes}" aria-labelledby="${id}">
      <header class="roadmap-band-head"><h2 class="roadmap-band-name" id="${id}">${escapeHtml(band)}</h2><prism-badge tone="neutral">${members.length}</prism-badge>${hint}${toggle}</header>
      <div class="roadmap-band-items"${open ? "" : " hidden"}>${members.map((item, index) => boardCard(item, titles, index + 1)).join("")}</div>
    </section>`;
  }).join("");
  return `<div class="roadmap-board">${lanes}</div>
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
  // The view, the archive toggle, and the collapsed lanes are the person's preferences, so every roadmap opens the way they last left one.
  const view = { mode: preference("roadmap.view"), archive: preference("roadmap.showArchived"), collapsedLanes: preference("roadmap.collapsedLanes") };
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
  const metric = (count, label, state = "") => `<span class="roadmap-metric">${state ? `<prism-state state="${state}" aria-hidden="true"></prism-state>` : ""}<strong>${count}</strong> <span>${label}</span></span>`;
  container.innerHTML = `
    ${missing ? `<prism-panel class="view-section summary-block">${missing}</prism-panel>` : ""}
    <div class="roadmap-metrics" aria-label="Initiatives by state">
      ${metric(data.items.length, data.items.length === 1 ? "initiative" : "initiatives")}
      ${metric(counts["in-progress"], "in progress", "in-progress")}
      ${metric(counts.planned, "planned", "planned")}
      ${metric(counts.envisioned, "envisioned", "envisioned")}
      ${metric(counts.shipped, "shipped", "shipped")}
    </div>
    <div data-roadmap-body></div>
    ${data.openQuestions?.length ? `<section class="roadmap-questions" aria-labelledby="roadmap-questions"><h2 id="roadmap-questions"><prism-icon name="question" size="sm"></prism-icon><span>Open questions</span><prism-badge tone="neutral">${data.openQuestions.length}</prism-badge></h2><ul>${data.openQuestions.map((question) => `<li><prism-icon name="chevron-right" size="xs"></prism-icon><span>${escapeHtml(question)}</span></li>`).join("")}</ul></section>` : ""}
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="row-list">${data.unlisted.map((id) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
  // The page head carries the view's controls beside the title: the archive toggle and the board, list, and graph modes.
  const head = container.parentElement?.querySelector(".artifact-header");
  const controls = `<div class="view-controls roadmap-controls">
      <prism-button size="sm" variant="ghost" data-roadmap-archive pressed="${view.archive}"${archived ? "" : " disabled"}>${view.archive ? "Hide" : "Show"} shipped and superseded <prism-badge tone="neutral">${archived}</prism-badge></prism-button>
      <div class="segmented" role="group" aria-label="Roadmap view">${MODES.map(([mode, label]) => `<prism-button size="sm" variant="ghost" data-roadmap-mode="${mode}" pressed="${view.mode === mode}">${label}</prism-button>`).join("")}</div>
    </div>`;
  head?.querySelector(".roadmap-controls")?.remove();
  if (head) head.insertAdjacentHTML("beforeend", controls);
  else container.insertAdjacentHTML("afterbegin", controls);
  const controlRoot = head ?? container;
  const body = container.querySelector("[data-roadmap-body]");
  if (view.mode === "graph") {
    await graph(body, data, ctx, titles, view.archive);
  } else {
    body.innerHTML = view.mode === "list" ? list(data, titles, view.archive) : board(data, titles, view.archive, new Set(view.collapsedLanes));
  }
  for (const toggle of container.querySelectorAll("[data-lane]")) {
    toggle.addEventListener("click", () => {
      const lanes = new Set(view.collapsedLanes);
      const band = toggle.dataset.lane;
      const open = lanes.has(band);
      if (open) lanes.delete(band);
      else lanes.add(band);
      view.collapsedLanes = [...lanes];
      void setPreference("roadmap.collapsedLanes", view.collapsedLanes).catch(() => {});
      toggle.closest(".roadmap-band").querySelector(".roadmap-band-items").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("label", `${open ? "Collapse" : "Expand"} ${band}`);
      toggle.querySelector("prism-icon").setAttribute("name", open ? "chevron-down" : "chevron-right");
    });
  }
  controlRoot.querySelector("[data-roadmap-archive]").addEventListener("click", () => {
    void setPreference("roadmap.showArchived", !view.archive).catch(() => {});
    ctx.rerender();
  });
  for (const button of controlRoot.querySelectorAll("[data-roadmap-mode]")) {
    button.addEventListener("click", () => {
      void setPreference("roadmap.view", button.dataset.roadmapMode).catch(() => {});
      ctx.rerender();
    });
  }
  applyWidths(container);
  bindLinks(container, ctx);
}
