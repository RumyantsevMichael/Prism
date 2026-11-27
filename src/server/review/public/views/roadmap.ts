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
export function laneHeading(root: any, lane: any) {
  return LANES.some(([name]) => name === lane) ? root.querySelector(`#roadmap-band-${lane}`) : null;
}

export { stateBadge };

// An initiative's title is a link to its page, which a click opens in place and a modified click keeps open.
export function initiativeLink(id: string, title: string) {
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(`initiative:${id}`)}" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(title)}</a>`;
}

const names = (ids: any, titles: any) => ids.map((id: string) => titles.get(id) ?? id).join(", ");

// Needs and Unblocks as two icons with their counts; hovering or focusing one marks the initiatives it names on the board, and pressing it keeps them marked.
function dependencyIcons(item: any, titles: any) {
  const icon = (kind: any, ids: any, word: any) => ids.length
    ? `<prism-chip interactive class="roadmap-dep" data-related="${escapeHtml(ids.join(" "))}" label="${word} ${escapeHtml(names(ids, titles))}" tip="${word} ${escapeHtml(names(ids, titles))}"><prism-icon slot="start" name="${kind}" size="xs"></prism-icon>${ids.length}</prism-chip>`
    : "";
  const icons = icon("needs", item.requires, "Needs") + icon("unblocks", item.requiredBy, "Unblocks");
  return icons ? `<span class="roadmap-deps">${icons}</span>` : "";
}

// In the list, Needs and Unblocks sit under the title as links, where they wrap instead of squeezing into a column.
function dependencyLinks(item: any, titles: any) {
  const line = (kind: any, ids: any, word: any) => ids.length
    ? `<span class="roadmap-rel"><prism-icon name="${kind}" size="xs"></prism-icon><span class="roadmap-rel-word">${word}</span> ${ids.map((id: string) => `<a href="./review?artifact=${encodeURIComponent(`initiative:${id}`)}" data-artifact="initiative:${escapeHtml(id)}">${escapeHtml(titles.get(id) ?? id)}</a>`).join(", ")}</span>`
    : "";
  const lines = line("needs", item.requires, "needs") + line("unblocks", item.requiredBy, "unblocks");
  return lines ? `<span class="roadmap-rels">${lines}</span>` : "";
}

// The readiness conditions an emerging item has yet to meet, as one chip whose tooltip names each of them.
function unmetChip(item: any) {
  const unmet = item.state === "emerging" ? item.workItem?.unmet ?? [] : [];
  if (!unmet.length) return "";
  return `<prism-chip tone="warning" tip="${escapeHtml(unmet.map(unmetText).join(" "))}">${escapeHtml(`${plural(unmet.length, "readiness condition")} unmet`)}</prism-chip>`;
}

/** One unmet readiness condition of a work item in words. */
export function unmetText(condition: any) {
  if (condition.code === "no_approved_requirement") return "It cites no Approved requirement file.";
  if (condition.code === "requirement_not_approved") return `${condition.path} is ${condition.status ?? "missing"}, not Approved.`;
  if (condition.code === "draft_adr_nonconforming") return `${condition.path} is a Draft ADR that breaks the ADR format.`;
  if (condition.code === "question_unanswered") return `A question it cannot be ready without has no answer: ${condition.text}`;
  if (condition.code === "not_confirmed") return "Nobody has confirmed that it is ready.";
  return String(condition.code ?? "");
}

function signals(item: any) {
  const parts = [unmetChip(item)];
  if (item.readyToShip && item.state !== "shipped") parts.push(badge("ready to ship", "success"));
  if (item.findings?.blocking) parts.push(badge(plural(item.findings.blocking, "blocking finding"), "danger"));
  else if (item.findings?.unresolved) parts.push(badge(plural(item.findings.unresolved, "open finding"), "warning"));
  if (item.active?.length) parts.push(badge(plural(item.active.length, "active slice"), "info"));
  if (item.diagnostics?.length) parts.push(`<prism-chip tone="danger" tip="${escapeHtml(item.diagnostics.map((entry: any) => entry.message).join(" "))}">record problem</prism-chip>`);
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
// A killed, merged, or split item left every band, so the roadmap never shows it and History lists it.
const CLOSED = new Set(["killed", "merged", "split"]);

function visibleItems(data: any, archive: any) {
  const open = data.items.filter((item: any) => !CLOSED.has(item.state));
  return archive ? open : open.filter((item: any) => !ARCHIVED.has(item.state));
}

const BAND_HINTS: Record<string, any> = { Now: "being built", Next: "designed next", Later: "envisioned", Parked: "not planned", Shipped: "done" };
// The roadmap's states by name, for the graph's node lines.
const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({ "in-progress": "In progress", planned: "Planned", envisioned: "Envisioned", emerging: "Emerging", shipped: "Shipped", superseded: "Superseded" });
// The status groups in the order work moves through them; shipped and superseded only show with the archive.
// An emerging item has not been shaped into an envisioned one yet, so it sits in the Envisioned group, where its card names its state.
const STATUS_GROUPS = [["in-progress", "In progress"], ["planned", "Planned"], ["envisioned", "Envisioned"], ["shipped", "Shipped"], ["superseded", "Superseded"]];
const GROUPED_STATES: Readonly<Record<string, string[]>> = Object.freeze({ envisioned: ["envisioned", "emerging"] });

// One segment per leaf slice in its status's color, the same palette as every status, with the count of done slices beside it.
export function sliceBar(item: any) {
  const slices = item.slices ?? [];
  if (!slices.length || item.state === "envisioned" || item.state === "emerging") return "";
  const done = slices.filter((slice: any) => slice.status === "done").length;
  const started = slices.filter((slice: any) => slice.status !== "not-started").length;
  const label = done || started ? `${done} of ${slices.length} done` : `0 of ${slices.length} started`;
  const counts = new Map();
  for (const slice of slices) counts.set(slice.status, (counts.get(slice.status) ?? 0) + 1);
  const tip = [...counts].map(([value, count]) => `${count} ${value.replace(/-/g, " ")}`).join(" · ");
  return `<prism-slice-bar statuses="${escapeHtml(slices.map((slice: any) => slice.status).join(","))}" label="${label}" tip="${escapeHtml(tip)}"></prism-slice-bar>`;
}

// The card's footer: its signals and who holds its slices, or that nobody does yet once it has slices to hold, with the dependency icons at its end.
function cardFoot(item: any, titles: any) {
  const holders = item.claims?.length
    ? claimStack(item.claims)
    : item.slices?.length && (item.state === "planned" || item.state === "in-progress") ? "<span>Nobody holds a slice yet</span>" : "";
  const start = signals(item) + holders;
  const end = dependencyIcons(item, titles);
  return start || end ? `<footer class="roadmap-item-foot"><span class="roadmap-item-foot-start">${start}</span>${end}</footer>` : "";
}

// A card leads with its rank in its band, or with its band when the board groups by status.
function boardCard(item: any, titles: any, rank: any, grouping: any) {
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
function groups(data: any, archive: any, grouping: any) {
  const items = visibleItems(data, archive);
  if (grouping === "status") {
    return STATUS_GROUPS.filter(([value]) => archive || !ARCHIVED.has(value)).map(([value, name]) => ({
      key: value, name, hint: "by band, then priority", glyph: status(value, { glyphOnly: true, attributes: ' aria-hidden="true"' }), members: items.filter((item: any) => (GROUPED_STATES[value] ?? [value]).includes(item.state))
    }));
  }
  const bands = archive ? data.bands : data.bands.filter((band: any) => band !== "Shipped");
  return bands.map((band: any) => ({ key: band.toLowerCase(), name: band, hint: BAND_HINTS[band] ?? "", glyph: "", members: items.filter((item: any) => item.band === band && item.state !== "superseded"), parked: band === "Parked" }));
}

// Lanes are full-width and stacked in order, each with its count and what it holds above its cards.
// An empty lane takes one line, so the lanes that hold work stay close together.
function board(data: any, titles: any, archive: any, collapsed: any, grouping: any) {
  const superseded = archive && grouping === "band" ? data.items.filter((item: any) => item.state === "superseded") : [];
  const lanes = groups(data, archive, grouping).map((group: any) => {
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
      <div class="roadmap-band-items"${open ? "" : " hidden"}>${group.members.map((item: any, index: number) => boardCard(item, titles, index + 1, grouping)).join("")}</div>
    </section>`;
  }).join("");
  return `<div class="roadmap-board">${lanes}</div>
  ${superseded.length ? card("Superseded", `<prism-disclosure summary="${escapeHtml(plural(superseded.length, "initiative"))}"><ul class="row-list">${superseded.map((item: any) => `<li>${initiativeLink(item.id, item.title)} → ${initiativeLink(item.decision.by, titles.get(item.decision.by) ?? item.decision.by)}: ${escapeHtml(item.decision.reason ?? "")}</li>`).join("")}</ul></prism-disclosure>`) : ""}`;
}

// The list keeps one row per initiative under the heads of its groups, so neither the band nor the status needs a column of its own.
function list(data: any, titles: any, archive: any, grouping: any) {
  const head = `<div class="prism-lib-row is-head" aria-hidden="true"><span>Initiative</span><span>${grouping === "status" ? "Band" : "Status"}</span><span>Progress</span><span>Signals</span></div>`;
  const rows = groups(data, archive, grouping).filter((group: any) => group.members.length).map((group: any) => `<div class="prism-lib-group"><h3 class="prism-lib-group-name">${escapeHtml(group.name)} <prism-badge tone="neutral">${group.members.length}</prism-badge></h3>${group.hint ? `<span class="prism-lib-group-source">${escapeHtml(group.hint)}</span>` : ""}</div>${group.members.map((item: any, index: number) => `<div class="prism-lib-row" data-initiative="${escapeHtml(item.id)}">
    <span class="prism-lib-title roadmap-list-title">${grouping === "band" ? `<span class="item-rank muted">#${index + 1}</span>` : ""}<span class="roadmap-list-text">${initiativeLink(item.id, item.title)}<span class="prism-lib-cell is-detail">${escapeHtml(item.intent)}</span>${dependencyLinks(item, titles)}</span></span>
    <span class="prism-lib-cell">${grouping === "status" ? escapeHtml(item.band) : stateBadge(item.state)}</span>
    <span class="prism-lib-cell">${sliceBar(item) || '<span class="muted">no slices</span>'}</span>
    <span class="prism-lib-cell roadmap-list-signals">${signals(item)}${claimStack(item.claims)}</span>
  </div>`).join("")}`).join("");
  return `<prism-lib-table class="roadmap-list">${head}${rows || '<p class="prism-lib-nothing">The roadmap has no open initiatives.</p>'}</prism-lib-table>`;
}

async function graph(container: any, data: any, ctx: any, titles: any, archive: any) {
  const items = visibleItems(data, archive);
  const shown = new Set(items.map((item: any) => item.id));
  const section = graphCard({ title: plural(items.length, "initiative"), eyebrow: "Prerequisite → dependent", legend: '<span class="legend-hint">Click an initiative to open it · Drag to pan</span>' });
  container.appendChild(section);
  const viewport = section.querySelector(".graph-viewport");
  if (!items.length) {
    viewport!.innerHTML = emptyNote("The roadmap has no open initiatives.");
    return;
  }
  const nodes = items.map((item: any) => ({
    id: item.id,
    title: item.title,
    subtitle: `${item.band} · ${STATE_NAMES[item.state] ?? item.state}${item.progress ? ` · ${item.progress.done}/${item.progress.leaves}` : ""}`,
    tooltip: item.intent,
    cluster: item.state === "superseded" ? "Superseded" : item.band,
    className: `initiative-node state-${item.state}`
  }));
  const edges = items.flatMap((item: any) => item.requires.filter((target: any) => shown.has(target)).map((target: any) => ({ from: target, to: item.id, className: "requires-edge" })));
  await renderGraph(viewport, { label: "Initiative dependencies", nodes, edges }, { onSelect: (id: string, options: any) => ctx.openArtifact(`initiative:${id}`, options), clusterLabels: new Map([...data.bands, "Superseded"].map((band) => [band, band])) });
  enablePanZoom(section, ctx.state.graph ??= {});
}

// Hovering, focusing, or pressing a dependency icon marks the cards it names and dims the others; a pressed icon keeps them marked until it is pressed again.
function bindDependencies(root: any) {
  const boardRoot = root.querySelector(".roadmap-board");
  if (!boardRoot) return;
  let pinned: any = null;
  const mark = (chip: any) => {
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
function toolbar(view: any, archived: any) {
  const segmented = (label: string, value: any, options: any) => `<prism-segmented label="${label}" value="${value}" data-roadmap-${label === "View" ? "view" : "group"}>${options.map(([name, text]: any) => `<span value="${name}">${text}</span>`).join("")}</prism-segmented>`;
  const grouping = view.mode === "graph" ? "" : `<span class="roadmap-toolbar-group"><span class="roadmap-toolbar-label" aria-hidden="true">Group by</span>${segmented("Group by", view.grouping, ROADMAP_GROUPINGS)}</span>`;
  return `<div class="roadmap-toolbar" role="toolbar" aria-label="Roadmap view">
    ${segmented("View", view.mode, ROADMAP_VIEWS)}
    ${grouping}
    <prism-button size="sm" variant="ghost" class="roadmap-toolbar-archive" data-roadmap-archive pressed="${view.archive}"${archived ? "" : " disabled"}>${view.archive ? "Hide" : "Show"} shipped and superseded <prism-badge tone="neutral">${archived}</prism-badge></prism-button>
  </div>`;
}

// The header's count of open roadmap questions leads to Attention, where they are answered, so the page lists none of its own.
function questionsChip(count: number) {
  if (!count) return '<prism-chip class="roadmap-questions-count" tip="The roadmap has no open questions"><prism-icon slot="start" name="question" size="xs"></prism-icon>No open questions</prism-chip>';
  return `<prism-chip interactive tone="accent" class="roadmap-questions-count" data-artifact="attention:roadmap-questions" tip="Open the roadmap questions in Attention"><prism-icon slot="start" name="question" size="xs"></prism-icon>${plural(count, "open question")} in Attention</prism-chip>`;
}

// A lane link always shows the board grouped by band, with that lane open so its heading can scroll into view.
export async function render(container: any, entity: any, ctx: any) {
  const data = entity.data;
  // The view, the grouping, the archive toggle, and the collapsed lanes are the person's preferences, so every roadmap opens the way they last left one.
  const lane = LANES.find(([name]) => name === ctx.lane)?.[1] ?? null;
  const view = {
    mode: lane ? "board" : preference("roadmap.view"),
    grouping: lane ? "band" : preference("roadmap.groupBy"),
    archive: preference("roadmap.showArchived"),
    collapsedLanes: preference("roadmap.collapsedLanes")
  };
  if (lane) view.collapsedLanes = view.collapsedLanes.filter((band: any) => band !== lane);
  const archived = data.items.filter((item: any) => ARCHIVED.has(item.state)).length;
  const open = data.items.filter((item: any) => !CLOSED.has(item.state));
  const titles = new Map(data.items.map((item: any) => [item.id, item.title]));
  const missing = data.error
    ? `<p class="error">${escapeHtml(data.error)}</p>`
    : !data.exists
      ? `<p>No roadmap record exists yet.</p><p class="muted">Run <code>setup</code> to create or migrate it.</p>`
      : !data.valid
        ? `<p class="error">The roadmap record is invalid: ${escapeHtml(data.errors.join(" "))}</p>`
        : "";
  const counts = Object.fromEntries(["in-progress", "planned", "envisioned", "emerging", "shipped"].map((state) => [state, open.filter((item: any) => item.state === state).length]));
  const metric = (count: number, label: string, state = "") => `<span class="roadmap-metric">${state ? status(state, { glyphOnly: true, attributes: ' aria-hidden="true"' }) : ""}<strong>${count}</strong> <span>${label}</span></span>`;
  container.innerHTML = `
    ${missing ? `<prism-panel class="view-section summary-block">${missing}</prism-panel>` : ""}
    <div class="roadmap-meta">
      <div class="roadmap-metrics" aria-label="Initiatives by state">
        ${metric(open.length, open.length === 1 ? "initiative" : "initiatives")}
        ${metric(counts["in-progress"], "in progress", "in-progress")}
        ${metric(counts.planned, "planned", "planned")}
        ${metric(counts.envisioned, "envisioned", "envisioned")}
        ${counts.emerging ? metric(counts.emerging, "emerging", "emerging") : ""}
        ${metric(counts.shipped, "shipped", "shipped")}
      </div>
      ${questionsChip(data.openQuestions?.length ?? 0)}
    </div>
    ${toolbar(view, archived)}
    <div data-roadmap-body></div>
    ${data.unlisted?.length ? card("Initiatives not on the roadmap", `<p class="muted">These plans folders have an initiative record but no roadmap entry.</p><ul class="row-list">${data.unlisted.map((id: string) => `<li>${initiativeLink(id, id)}</li>`).join("")}</ul>`, { eyebrow: "Needs prioritization" }) : ""}`;
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
  const choose = (key: any, value: any) => {
    void setPreference(key, value).catch(() => ctx.showToast?.("The view changed here, but the review app could not store the choice."));
    ctx.rerender();
  };
  container.querySelector("[data-roadmap-view]").addEventListener("change", (event: any) => {
    if (ROADMAP_VIEWS.some(([name]) => name === event.detail?.value)) choose("roadmap.view", event.detail.value);
  });
  container.querySelector("[data-roadmap-group]")?.addEventListener("change", (event: any) => {
    if (ROADMAP_GROUPINGS.some(([name]) => name === event.detail?.value)) choose("roadmap.groupBy", event.detail.value);
  });
  container.querySelector("[data-roadmap-archive]").addEventListener("click", () => choose("roadmap.showArchived", !view.archive));
  bindDependencies(container);
  applyWidths(container);
  bindLinks(container, ctx);
}
