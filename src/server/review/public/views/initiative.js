import { activeDetails } from "./coordination-state.js";
import { applyWidths } from "./entities.js";
import { stateBadge } from "./roadmap.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, badge, bindLinks, card, emptyNote, escapeHtml, keyValues, pageSub, plural, requirementGroups, setPageHead, setPageSub, shortDate, status } from "./util.js";
import { runTotalsHtml, runTotalsSummary, runTotalsTableHtml } from "./run-totals.js";
import { codeChip } from "./code-location.js";
import { claimChip, claimOf } from "./claims.js";
import { componentChip } from "./components.js";
import { createActionList } from "./actions.js";
import { shippedHistoryHtml } from "./shipped-history.js";
import { preference, setPreference } from "../kit/preferences.js";

const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];
// These columns always show; another status, such as deferred, gets a column only while a slice has it.
const STATUS_COLUMNS = [["not-started", "Not started"], ["design-review", "Design review"], ["in-progress", "In progress"], ["blocked", "Blocked"], ["deferred", "Deferred"], ["done", "Done"]];
const FIXED_COLUMNS = new Set(["not-started", "in-progress", "blocked", "done"]);

/** A slice's status as a kit prism-status. */
export function statusBadge(value) {
  return status(value);
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
    return `<section class="slice-column" aria-label="${escapeHtml(label)}"><h3 class="slice-column-head">${statusBadge(status)}<prism-badge>${members.length}</prism-badge></h3><ul class="slice-column-list">${members.map((slug) => boardCard(data, slug, ctx)).join("") || '<li class="column-none muted">—</li>'}</ul></section>`;
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

// Below the title, a superseded initiative's page says when it was superseded and by which initiative, linked, and the decision's reason.
function supersededLines(data) {
  const decision = data.roadmapItem?.decision;
  if (decision?.kind !== "superseded") return "";
  const date = shortDate(decision.at, { year: true });
  const by = data.supersededBy;
  const ref = by ? `initiative:${by.id}` : null;
  const link = by ? ` by <a href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(by.title)}</a>` : "";
  const line = pageSub(`Superseded${date ? ` ${escapeHtml(date)}` : ""}${link}`, { glyph: status("superseded", { glyphOnly: true }) });
  return `${line}${decision.reason ? pageSub(escapeHtml(decision.reason), { detail: true }) : ""}`;
}

// The page's lines under its title: the initiative's state with its intent, and for a superseded initiative what superseded it.
function headLines(data) {
  const item = data.roadmapItem;
  const intent = item ? escapeHtml(item.intent) : data.exists ? "This initiative has a record but no roadmap entry." : "";
  return `<div class="prism-page-subs">${pageSub(`${stateBadge(item?.state ?? "unlisted")}${intent ? ` <span>${intent}</span>` : ""}`)}${supersededLines(data)}</div>`;
}

// One segment per leaf slice in its status's color, labeled with the done count and the other statuses that hold slices.
function sliceProgress(data) {
  const leaves = data.derived?.leaves ?? [];
  if (!leaves.length) return "";
  const statuses = leaves.map((slug) => statusOf(data, slug));
  const count = (value) => statuses.filter((entry) => entry === value).length;
  const parts = [`${count("done")} of ${leaves.length} done`, ...["design-review", "in-progress", "blocked", "deferred"].filter((value) => count(value)).map((value) => `${count(value)} ${value.replace(/-/g, " ")}`)];
  return `<prism-slice-bar class="initiative-progress" statuses="${escapeHtml(statuses.join(","))}" label="${escapeHtml(parts.join(" · "))}"></prism-slice-bar>`;
}

// Another initiative as a chip with the icon of how it relates to this one, named by its title.
function relatedChips(ids, data, ctx, icon) {
  return ids.map((id) => {
    const ref = `initiative:${id}`;
    const title = escapeHtml(data.relatedTitles?.[id] ?? id);
    return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(ref)}"><prism-icon slot="start" name="${icon}" size="xs"></prism-icon>${title}</prism-chip>`;
  }).join("");
}

function facts(data, ctx) {
  const item = data.roadmapItem;
  const rows = keyValues([
    ["Rationale", item?.rationale ? escapeHtml(item.rationale) : null],
    ["Needs", item?.requires.length ? `<span class="chip-row">${relatedChips(item.requires, data, ctx, "needs")}</span>` : null],
    ["Unblocks", item?.requiredBy.length ? `<span class="chip-row">${relatedChips(item.requiredBy, data, ctx, "unblocks")}</span>` : null],
    ["Requirements", item?.requirements.length ? `<span class="chip-row">${requirementGroups(item.requirements, ctx)}</span>` : null],
    ["Records", `<span class="chip-row">${[artifactChip(data.recordPath, ctx, "Initiative record"), ctx.hasArtifact(data.statePath) ? artifactChip(data.statePath, ctx, "Coordination state") : ""].join("")}</span>`]
  ]);
  const open = ctx.state.factsOpen ?? true;
  return `<prism-disclosure class="initiative-facts" summary="Rationale, dependencies, requirements, and records"${open ? " open" : ""}>${rows}</prism-disclosure>`;
}

// The unstarted leaves that can be designed next, as one line beside the view switch.
function frontier(data, ctx) {
  const candidates = data.derived.designCandidates;
  if (!candidates.length) return "";
  const ready = candidates.filter((slug) => data.derived.dependenciesComplete.includes(slug));
  const waiting = candidates.filter((slug) => !ready.includes(slug));
  const links = (slugs) => slugs.map((slug) => {
    const ref = `slice:${data.id}/${slug}`;
    return `<a href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(data.record.slices[slug].title)}</a>`;
  }).join(", ");
  const lines = [
    ready.length ? `${plural(ready.length, "slice")} can be designed next: ${links(ready)}` : "",
    waiting.length ? `${plural(waiting.length, "slice")} can start once ${waiting.length === 1 ? "its" : "their"} prerequisites finish: ${links(waiting)}` : ""
  ].filter(Boolean);
  return `<p class="initiative-frontier"><span class="initiative-frontier-glyph">${status("not-started", { glyphOnly: true, attributes: ' aria-hidden="true"' })}</span><span>${lines.join(" · ")}</span></p>`;
}

let headSequence = 0;

// The page head's controls: the run totals that open their table, the launch of an orchestration, and the initiative's settings.
function headControls(data, ctx, ids) {
  const summary = runTotalsSummary(data.runTotals?.initiative ?? null);
  const totals = summary ? `<prism-button id="${ids.totals}" size="sm" variant="ghost" class="initiative-totals" tip="Run totals of this initiative"><prism-icon name="clock" size="xs"></prism-icon><span>${summary}</span><prism-icon name="chevron-down" size="xs"></prism-icon></prism-button>` : "";
  if (!ctx.actionApi) return totals;
  return `${totals}<prism-button id="${ids.launch}" size="sm" class="initiative-launch"><prism-icon name="play" size="xs"></prism-icon><span>Launch</span><prism-icon name="chevron-down" size="xs"></prism-icon></prism-button><prism-button size="sm" class="initiative-settings" data-initiative-settings-open><prism-icon name="settings" size="xs"></prism-icon><span>Settings</span></prism-button>`;
}

// The overlays the head's controls open: the run totals, the launch actions, and the settings dialog, which applies its changes together.
// Without a head the page shows its run totals in place and keeps only the dialog, which the jump palette opens.
function overlays(data, ctx, ids, head) {
  const totals = head && data.runTotals?.initiative ? `<prism-popover class="initiative-totals-popover" for="${ids.totals}" heading="Run totals">${runTotalsTableHtml([{ totals: data.runTotals.initiative, scope: "initiative" }])}</prism-popover>` : "";
  if (!ctx.actionApi) return totals;
  const title = data.roadmapItem?.title ?? data.id;
  return `${totals}
    ${head ? `<prism-popover class="initiative-launch-popover" for="${ids.launch}" heading="Launch an orchestration"><div data-launch-actions></div></prism-popover>` : ""}
    <prism-dialog class="initiative-settings-dialog" heading="Settings of ${escapeHtml(title)}" size="lg" data-initiative-settings-dialog>
      <p class="initiative-settings-lead">How agents run this initiative's slices. Changes apply when you press Apply.</p>
      <div data-initiative-settings></div>
      <prism-button slot="footer" data-settings-cancel>Cancel</prism-button>
      <prism-button slot="footer" variant="primary" data-settings-apply disabled>Apply</prism-button>
    </prism-dialog>`;
}

function mountOverlays(container, data, ctx, endRoot) {
  if (!ctx.actionApi || typeof document === "undefined") return;
  const target = `initiative:${data.id}`;
  const drafts = (ctx.state.actionDrafts ??= {});
  const launchRoot = container.querySelector("[data-launch-actions]");
  if (launchRoot) createActionList({ root: launchRoot, targets: [target], api: ctx.actionApi, drafts, groups: ["Launched session"], compact: true, submitLabel: () => "Launch", emptyText: "Nothing can be launched here.", notice: false });
  const dialog = container.querySelector("[data-initiative-settings-dialog]");
  const apply = dialog?.querySelector("[data-settings-apply]");
  if (!dialog || !apply) return;
  let list = null;
  const showCount = () => {
    if (!list) return;
    const changes = list.changes();
    apply.textContent = changes ? `Apply ${plural(changes, "change")}` : "Apply";
    apply.toggleAttribute("disabled", !changes);
  };
  list = createActionList({ root: dialog.querySelector("[data-initiative-settings]"), targets: [target], api: ctx.actionApi, drafts, groups: ["Initiative settings"], renderMarkdown: ctx.renderMarkdown ?? null, palette: true, batch: true, emptyText: "This initiative has no settings to change.", onRender: () => showCount() });
  showCount();
  // A setting chosen from the jump palette opens the dialog at that setting.
  const focusAction = list.focusAction.bind(list);
  list.focusAction = (id, chosen) => {
    if (!dialog.hasAttribute("open")) dialog.show?.();
    return focusAction(id, chosen);
  };
  endRoot?.querySelector("[data-initiative-settings-open]")?.addEventListener("click", () => dialog.show?.());
  // Cancel, Escape, and the close button all leave the settings as they were, so a reopened dialog never holds changes nobody applied.
  dialog.querySelector("[data-settings-cancel]").addEventListener("click", () => dialog.close?.());
  dialog.addEventListener("prism-close", () => {
    list.discard();
    showCount();
  });
  apply.addEventListener("click", async () => {
    apply.toggleAttribute("disabled", true);
    if (await list.applyAll()) dialog.close?.();
    showCount();
  });
  // A link in the dialog opens its page, so the dialog closes first.
  dialog.addEventListener("click", (event) => {
    if (event.target.closest?.("prism-chip[data-artifact], a[data-artifact]")) dialog.close?.();
  });
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  const item = data.roadmapItem;
  // The view is the person's preference, so every initiative opens in the view they last chose.
  const mode = preference("initiative.view");
  const ids = { totals: `initiative-totals-${++headSequence}`, launch: `initiative-launch-${headSequence}` };
  const eyebrow = ["Initiative", item?.band ?? null, data.bandRank ? `#${data.bandRank}` : null].filter(Boolean).join(" · ");
  const endRoot = setPageHead(container, { eyebrow, end: headControls(data, ctx, ids) }, ctx);
  // The state, the intent, and the superseded note stand in the page head below the title, or at the top of the page when the page has no head.
  const lines = headLines(data);
  const lead = setPageSub(container, lines, ctx) ? "" : lines;
  // Without a page head the run totals show in the page itself.
  const totalsInPage = !endRoot && data.runTotals ? runTotalsHtml(data.runTotals.initiative, "initiative") : "";
  const top = `${lead}${shippedHistoryHtml(data.shippedHistory)}${item?.readyToShip && item.state !== "shipped" ? `<p class="chip-row">${badge("ready to ship", "success")}</p>` : ""}`;
  const finish = () => {
    container.querySelector(".initiative-facts")?.addEventListener("toggle", (event) => { ctx.state.factsOpen = Boolean(event.detail?.open); });
    mountOverlays(container, data, ctx, endRoot);
    applyWidths(container);
    bindLinks(container, ctx);
  };
  if (!data.exists) {
    container.innerHTML = `${top}${facts(data, ctx)}${totalsInPage}${card("No slices yet", `<p>No initiative record exists yet.</p><p class="muted">Orchestration creates it when the initiative starts.</p>`, { eyebrow: "Envisioned" })}${overlays(data, ctx, ids, Boolean(endRoot))}`;
    finish();
    return;
  }
  if (!data.valid) {
    // An unreadable record that the roadmap does not list is no action target, so its page has no settings to show.
    container.innerHTML = `${top}${facts(data, ctx)}${totalsInPage}${card("Invalid initiative record", `<ul class="diagnostic-list">${data.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>`, { eyebrow: "Initiative record" })}${item ? overlays(data, ctx, ids, Boolean(endRoot)) : ""}`;
    finish();
    return;
  }
  const counts = data.derived.counts;
  const summary = `${plural(data.derived.leaves.length, "leaf slice")} · ${counts.done} done · ${counts["in-progress"]} in progress · ${counts.blocked} blocked`;
  const toolbar = `<div class="initiative-toolbar"><prism-segmented label="View" value="${escapeHtml(mode)}" data-initiative-mode>${MODES.map(([value, label]) => `<span value="${value}">${label}</span>`).join("")}</prism-segmented>${frontier(data, ctx)}</div>`;
  container.innerHTML = `${top}${sliceProgress(data)}${facts(data, ctx)}${totalsInPage}${toolbar}<div data-initiative-body></div>${overlays(data, ctx, ids, Boolean(endRoot))}`;
  const body = container.querySelector("[data-initiative-body]");
  if (mode === "graph") await graph(body, data, ctx);
  else if (mode === "list") body.innerHTML = card("Slice tree", `<ul class="slice-outline root">${tree(data, data.derived.root, 0, ctx)}</ul>`, { eyebrow: summary });
  else body.innerHTML = board(data, ctx);
  container.querySelector("[data-initiative-mode]")?.addEventListener("change", (event) => {
    if (!MODES.some(([value]) => value === event.detail?.value)) return;
    void setPreference("initiative.view", event.detail.value).catch(() => {});
    ctx.rerender();
  });
  finish();
}
