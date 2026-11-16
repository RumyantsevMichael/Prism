import { applyWidths, stateBadge } from "./entities.js";
import { isExpired } from "./claim-index.js";
import { claimAttributes } from "./claims.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { badge, bindLinks, card, emptyNote, escapeHtml, plural, status } from "./util.js";
import { preference, setPreference } from "../kit/preferences.js";

/** The Roadmap page's views, which the toolbar above them switches. */
export const ROADMAP_VIEWS = Object.freeze([["board", "Board"], ["list", "List"], ["graph", "Graph"]]);
/** How the board and the list group the initiatives. */
export const ROADMAP_GROUPINGS = Object.freeze([["band", "Band"], ["status", "Status"]]);
/** The lanes a lane link names in its address, each with its band. */
export const LANES = Object.freeze([["now", "Now"], ["next", "Next"], ["later", "Later"], ["parked", "Parked"]]);

/** The heading of a lane on the drawn board, or null when the board does not show it. */
export function laneHeading(root, lane) {
  return LANES.some(([name]) => name === lane) ? root.querySelector(`#roadmap-band-${lane}`) : null;
}

export { stateBadge };

// An initiative's title is a link to its page, which a click opens in place and a modified click keeps open.
export function initiativeLink(id, title) {
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(`initiative:${id}`)}" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(title)}</a>`;
}

const names = (ids, titles) => ids.map((id) => titles.get(id) ?? id).join(", ");

// Needs and Unblocks as two icons with their counts; hovering or focusing one marks the initiatives it names on the board, and pressing it keeps them marked.
function dependencyIcons(item, titles) {
  const icon = (kind, ids, word) => ids.length
    ? `<prism-chip interactive class="roadmap-dep" data-related="${escapeHtml(ids.join(" "))}" label="${word} ${escapeHtml(names(ids, titles))}" tip="${word} ${escapeHtml(names(ids, titles))}"><prism-icon slot="start" name="${kind}" size="xs"></prism-icon>${ids.length}</prism-chip>`
    : "";
  const icons = icon("needs", item.requires, "Needs") + icon("unblocks", item.requiredBy, "Unblocks");
  return icons ? `<span class="roadmap-deps">${icons}</span>` : "";
}

// In the list, Needs and Unblocks sit under the title as links, where they wrap instead of squeezing into a column.
function dependencyLinks(item, titles) {
  const line = (kind, ids, word) => ids.length
    ? `<span class="roadmap-rel"><prism-icon name="${kind}" size="xs"></prism-icon><span class="roadmap-rel-word">${word}</span> ${ids.map((id) => `<a href="./review?artifact=${encodeURIComponent(`initiative:${id}`)}" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(titles.get(id) ?? id)}</a>`).join(", ")}</span>`
    : "";
  const lines = line("needs", item.requires, "needs") + line("unblocks", item.requiredBy, "unblocks");
  return lines ? `<span class="roadmap-rels">${lines}</span>` : "";
}

function signals(item) {
  const parts = [];
  if (item.readyToShip && item.state !== "shipped") parts.push(badge("ready to ship", "success"));
  if (item.findings?.blocking) parts.push(badge(plural(item.findings.blocking, "blocking finding"), "danger"));
  else if (item.findings?.unresolved) parts.push(badge(plural(item.findings.unresolved, "open finding"), "warning"));
  if (item.active?.length) parts.push(badge(plural(item.active.length, "active slice"), "info"));
  if (item.diagnostics?.length) parts.push(`<prism-chip tone="danger" tip="${escapeHtml(item.diagnostics.map((entry) => entry.message).join(" "))}">record problem</prism-chip>`);
  return parts.join("");
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

const BAND_HINTS = { Now: "being built", Next: "designed next", Later: "envisioned", Parked: "not planned", Shipped: "done" };
// The status groups in the order work moves through them; shipped and superseded only show with the archive.
const STATUS_GROUPS = [["in-progress", "In progress"], ["planned", "Planned"], ["envisioned", "Envisioned"], ["shipped", "Shipped"], ["superseded", "Superseded"]];

// One segment per leaf slice in its status's color, the same palette as every status, with the count of done slices beside it.
export function sliceBar(item) {
  const slices = item.slices ?? [];
  if (!slices.length || item.state === "envisioned") return "";
  const done = slices.filter((slice) => slice.status === "done").length;
  const started = slices.filter((slice) => slice.status !== "not-started").length;
  const label = done || started ? `${done} of ${slices.length} done` : `0 of ${slices.length} started`;
  const counts = new Map();
  for (const slice of slices) counts.set(slice.status, (counts.get(slice.status) ?? 0) + 1);
  const tip = [...counts].map(([value, count]) => `${count} ${value.replace(/-/g, " ")}`).join(" · ");
  return `<prism-slice-bar statuses="${escapeHtml(slices.map((slice) => slice.status).join(","))}" label="${label}" tip="${escapeHtml(tip)}"></prism-slice-bar>`;
}

// The card's footer: its signals and who holds its slices, or that nobody does yet once it has slices to hold, with the dependency icons at its end.
function cardFoot(item, titles) {
  const holders = item.claims?.length
    ? claimStack(item.claims)
    : item.slices?.length && (item.state === "planned" || item.state === "in-progress") ? "<span>Nobody holds a slice yet</span>" : "";
  const start = signals(item) + holders;
  const end = dependencyIcons(item, titles);
  return start || end ? `<footer class="roadmap-item-foot"><span class="roadmap-item-foot-start">${start}</span>${end}</footer>` : "";
}

// A card leads with its rank in its band, or with its band when the board groups by status.
function boardCard(item, titles, rank, grouping) {
  const lead = grouping === "status"
    ? `<prism-chip>${escapeHtml(item.band)}</prism-chip>`
    : `<span class="item-rank"><span aria-hidden="true">#${rank}</span><span class="sr-only">Priority ${rank} in ${escapeHtml(item.band)}</span></span>`;
  return `<article class="initiative-item roadmap-item state-${escapeHtml(item.state)}" data-initiative="${escapeHtml(item.id)}" aria-labelledby="roadmap-item-${escapeHtml(item.id)}">
    <header class="roadmap-item-top">${lead}${item.pillar ? `<span class="roadmap-item-area">${escapeHtml(item.pillar)}</span>` : ""}${stateBadge(item.state)}</header>
    <h3 class="item-title" id="roadmap-item-${escapeHtml(item.id)}">${initiativeLink(item.id, item.title)}</h3>
    <p class="item-intent">${escapeHtml(item.intent)}</p>
    ${sliceBar(item)}
    ${cardFoot(item, titles)}
  </article>`;
}

// The groups the board and the list show, in order: the bands by priority, or the statuses in the order work moves through them.
// Within a band an initiative keeps its priority; grouped by status, initiatives keep the order of their bands and then their priority.
function groups(data, archive, grouping) {
  const items = visibleItems(data, archive);
  if (grouping === "status") {
    return STATUS_GROUPS.filter(([value]) => archive || !ARCHIVED.has(value)).map(([value, name]) => ({
      key: value, name, hint: "by band, then priority", glyph: status(value, { glyphOnly: true, attributes: ' aria-hidden="true"' }), members: items.filter((item) => item.state === value)
    }));
  }
  const bands = archive ? data.bands : data.bands.filter((band) => band !== "Shipped");
  return bands.map((band) => ({ key: band.toLowerCase(), name: band, hint: BAND_HINTS[band] ?? "", glyph: "", members: items.filter((item) => item.band === band && item.state !== "superseded"), parked: band === "Parked" }));
}

// Lanes are full-width and stacked in order, each with its count and what it holds above its cards.
// An empty lane takes one line, so the lanes that hold work stay close together.
function board(data, titles, archive, collapsed, grouping) {
  const superseded = archive && grouping === "band" ? data.items.filter((item) => item.state === "superseded") : [];
  const lanes = groups(data, archive, grouping).map((group) => {
    const open = !collapsed.has(group.name);
    const id = `roadmap-band-${group.key}`;
    const hint = group.hint ? `<span class="roadmap-band-hint">${escapeHtml(group.hint)}</span>` : "";
    const toggle = `<prism-button class="roadmap-band-toggle" variant="ghost" size="sm" data-lane="${escapeHtml(group.name)}" label="${open ? "Collapse" : "Expand"} ${escapeHtml(group.name)}" aria-expanded="${open}"><prism-icon name="${open ? "chevron-down" : "chevron-right"}" size="xs"></prism-icon></prism-button>`;
    const classes = `roadmap-band band-${group.key}${group.parked ? " is-parked" : ""}${group.members.length ? "" : " has-none"}`;
    const head = `${group.glyph}<h2 class="roadmap-band-name" id="${id}">${escapeHtml(group.name)}</h2><prism-badge tone="neutral">${group.members.length}</prism-badge>${hint}`;
    if (!group.members.length) {
      return `<section class="${classes}" aria-labelledby="${id}">
      <header class="roadmap-band-head">${head}<span class="roadmap-band-none muted">No initiatives</span></header>
    </section>`;
    }
    return `<section class="${classes}" aria-labelledby="${id}">
      <header class="roadmap-band-head">${head}${toggle}</header>
      <div class="roadmap-band-items"${open ? "" : " hidden"}>${group.members.map((item, index) => boardCard(item, titles, index + 1, grouping)).join("")}</div>
    </section>`;
  }).join("");
  return `<div class="roadmap-board">${lanes}</div>
  ${superseded.length ? card("Superseded", `<prism-disclosure summary="${escapeHtml(plural(superseded.length, "initiative"))}"><ul class="row-list">${superseded.map((item) => `<li>${initiativeLink(item.id, item.title)} → ${initiativeLink(item.decision.by, titles.get(item.decision.by) ?? item.decision.by)}: ${escapeHtml(item.decision.reason ?? "")}</li>`).join("")}</ul></prism-disclosure>`) : ""}`;
}

// The list keeps one row per initiative under the heads of its groups, so neither the band nor the status needs a column of its own.
function list(data, titles, archive, grouping) {
  const head = `<div class="prism-lib-row is-head" aria-hidden="true"><span>Initiative</span><span>${grouping === "status" ? "Band" : "Status"}</span><span>Progress</span><span>Signals</span></div>`;
  const rows = groups(data, archive, grouping).filter((group) => group.members.length).map((group) => `<div class="prism-lib-group"><h3 class="prism-lib-group-name">${escapeHtml(group.name)} <prism-badge tone="neutral">${group.members.length}</prism-badge></h3>${group.hint ? `<span class="prism-lib-group-source">${escapeHtml(group.hint)}</span>` : ""}</div>${group.members.map((item, index) => `<div class="prism-lib-row" data-initiative="${escapeHtml(item.id)}">
    <span class="prism-lib-title roadmap-list-title">${grouping === "band" ? `<span class="item-rank muted">#${index + 1}</span>` : ""}<span class="roadmap-list-text">${initiativeLink(item.id, item.title)}<span class="prism-lib-cell is-detail">${escapeHtml(item.intent)}</span>${dependencyLinks(item, titles)}</span></span>
    <span class="prism-lib-cell">${grouping === "status" ? escapeHtml(item.band) : stateBadge(item.state)}</span>
    <span class="prism-lib-cell">${sliceBar(item) || '<span class="muted">no slices</span>'}</span>
    <span class="prism-lib-cell roadmap-list-signals">${signals(item)}${claimStack(item.claims)}</span>
  </div>`).join("")}`).join("");
  return `<prism-lib-table class="roadmap-list">${head}${rows || '<p class="prism-lib-nothing">The roadmap has no open initiatives.</p>'}</prism-lib-table>`;
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

// Hovering, focusing, or pressing a dependency icon marks the cards it names and dims the others; a pressed icon keeps them marked until it is pressed again.
function bindDependencies(root) {
  const boardRoot = root.querySelector(".roadmap-board");
  if (!boardRoot) return;
  let pinned = null;
  const mark = (chip) => {
    const related = new Set((chip?.dataset.related ?? "").split(" ").filter(Boolean));
    const from = chip?.closest("[data-initiative]")?.dataset.initiative ?? null;
    boardRoot.classList.toggle("is-tracing", Boolean(chip));
    for (const item of boardRoot.querySelectorAll("[data-initiative]")) {
      const id = item.dataset.initiative;
      item.classList.toggle("is-related", Boolean(chip) && related.has(id));
      item.classList.toggle("is-source", Boolean(chip) && id === from);
    }
  };
  for (const chip of boardRoot.querySelectorAll(".roadmap-dep")) {
    const show = () => mark(chip);
    const hide = () => mark(pinned);
    chip.addEventListener("pointerenter", show);
    chip.addEventListener("focusin", show);
    chip.addEventListener("pointerleave", hide);
    chip.addEventListener("focusout", hide);
    chip.setAttribute("pressed", "false");
    chip.addEventListener("click", () => {
      if (pinned && pinned !== chip) pinned.setAttribute("pressed", "false");
      pinned = pinned === chip ? null : chip;
      chip.setAttribute("pressed", String(pinned === chip));
      mark(pinned ?? chip);
    });
  }
}

// The toolbar above the views: the view, how the board and the list group, and whether shipped and superseded work shows; each is the person's preference.
function toolbar(view, archived) {
  const segmented = (label, value, options) => `<prism-segmented label="${label}" value="${value}" data-roadmap-${label === "View" ? "view" : "group"}>${options.map(([name, text]) => `<span value="${name}">${text}</span>`).join("")}</prism-segmented>`;
  const grouping = view.mode === "graph" ? "" : `<span class="roadmap-toolbar-group"><span class="roadmap-toolbar-label" aria-hidden="true">Group by</span>${segmented("Group by", view.grouping, ROADMAP_GROUPINGS)}</span>`;
  return `<div class="roadmap-toolbar" role="toolbar" aria-label="Roadmap view">
    ${segmented("View", view.mode, ROADMAP_VIEWS)}
    ${grouping}
    <prism-button size="sm" variant="ghost" class="roadmap-toolbar-archive" data-roadmap-archive pressed="${view.archive}"${archived ? "" : " disabled"}>${view.archive ? "Hide" : "Show"} shipped and superseded <prism-badge tone="neutral">${archived}</prism-badge></prism-button>
  </div>`;
}

// The header's count of open roadmap questions leads to Attention, where they are answered, so the page lists none of its own.
function questionsChip(count) {
  if (!count) return '<prism-chip class="roadmap-questions-count" tip="The roadmap has no open questions"><prism-icon slot="start" name="question" size="xs"></prism-icon>No open questions</prism-chip>';
  return `<prism-chip interactive tone="accent" class="roadmap-questions-count" data-artifact="attention:roadmap-questions" tip="Open the roadmap questions in Attention"><prism-icon slot="start" name="question" size="xs"></prism-icon>${plural(count, "open question")} in Attention</prism-chip>`;
}

// A lane link always shows the board grouped by band, with that lane open so its heading can scroll into view.
export async function render(container, entity, ctx) {
  const data = entity.data;
  // The view, the grouping, the archive toggle, and the collapsed lanes are the person's preferences, so every roadmap opens the way they last left one.
  const lane = LANES.find(([name]) => name === ctx.lane)?.[1] ?? null;
  const view = {
    mode: lane ? "board" : preference("roadmap.view"),
    grouping: lane ? "band" : preference("roadmap.groupBy"),
    archive: preference("roadmap.showArchived"),
    collapsedLanes: preference("roadmap.collapsedLanes")
  };
  if (lane) view.collapsedLanes = view.collapsedLanes.filter((band) => band !== lane);
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
  const metric = (count, label, state = "") => `<span class="roadmap-metric">${state ? status(state, { glyphOnly: true, attributes: ' aria-hidden="true"' }) : ""}<strong>${count}</strong> <span>${label}</span></span>`;
  container.innerHTML = `
    ${missing ? `<prism-panel class="view-section summary-block">${missing}</prism-panel>` : ""}
    <div class="roadmap-meta">
      <div class="roadmap-metrics" aria-label="Initiatives by state">
        ${metric(data.items.length, data.items.length === 1 ? "initiative" : "initiatives")}
        ${metric(counts["in-progress"], "in progress", "in-progress")}
        ${metric(counts.planned, "planned", "planned")}
        ${metric(counts.envisioned, "envisioned", "envisioned")}
        ${metric(counts.shipped, "shipped", "shipped")}
      </div>
      ${questionsChip(data.openQuestions?.length ?? 0)}
    </div>
    ${toolbar(view, archived)}
    <div data-roadmap-body></div>
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="row-list">${data.unlisted.map((id) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
  const body = container.querySelector("[data-roadmap-body]");
  if (view.mode === "graph") {
    await graph(body, data, ctx, titles, view.archive);
  } else {
    body.innerHTML = view.mode === "list" ? list(data, titles, view.archive, view.grouping) : board(data, titles, view.archive, new Set(view.collapsedLanes), view.grouping);
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
  const choose = (key, value) => {
    void setPreference(key, value).catch(() => ctx.showToast?.("The view changed here, but the review app could not store the choice."));
    ctx.rerender();
  };
  container.querySelector("[data-roadmap-view]").addEventListener("change", (event) => {
    if (ROADMAP_VIEWS.some(([name]) => name === event.detail?.value)) choose("roadmap.view", event.detail.value);
  });
  container.querySelector("[data-roadmap-group]")?.addEventListener("change", (event) => {
    if (ROADMAP_GROUPINGS.some(([name]) => name === event.detail?.value)) choose("roadmap.groupBy", event.detail.value);
  });
  container.querySelector("[data-roadmap-archive]").addEventListener("click", () => choose("roadmap.showArchived", !view.archive));
  bindDependencies(container);
  applyWidths(container);
  bindLinks(container, ctx);
}
