import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { headingSlug } from "./markdown.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, evidenceChip, formatReference, formatSelector, keyValues, plural, shortId } from "./util.js";

const ACTIONS = ["ADD", "MODIFY", "REPLACE", "DELETE", "KEEP"];
const MODES = [["list", "List"], ["graph", "Graph"]];
const GROUPS = [["action", "Action"], ["file", "File"]];

function actionBadge(action) {
  return `<span class="action-badge action-${escapeHtml(action.toLowerCase())}">${escapeHtml(action)}</span>`;
}

function referenceKey(side, reference) {
  return `${side}|${reference.path}|${JSON.stringify(reference.selector ?? "")}`;
}

function buildGraph(changes) {
  const nodes = new Map();
  const edges = [];
  const clusterLabels = new Map();
  const addReference = (side, reference, change) => {
    const id = referenceKey(side, reference);
    const cluster = `${side}|${reference.path}`;
    clusterLabels.set(cluster, `${side === "b" ? "before" : "after"} · ${reference.path}`);
    if (!nodes.has(id)) {
      const selector = formatSelector(reference.selector);
      nodes.set(id, { id, cluster, title: selector || "(whole file)", subtitle: typeof reference.selector === "object" && reference.selector ? reference.selector.type : "", tooltip: formatReference(reference), className: `ref-node ref-${side === "b" ? "before" : "after"}`, monospace: true });
    }
    edges.push(side === "b" ? { from: id, to: `c|${change.id}`, className: `action-${change.action.toLowerCase()}` } : { from: `c|${change.id}`, to: id, className: `action-${change.action.toLowerCase()}` });
  };
  for (const change of changes) {
    nodes.set(`c|${change.id}`, { id: `c|${change.id}`, title: change.label, subtitle: `${change.kind} · ${change.action}`, tooltip: change.reason, className: `change-node action-${change.action.toLowerCase()}` });
    for (const reference of change.before ?? []) addReference("b", reference, change);
    for (const reference of change.after ?? []) addReference("a", reference, change);
  }
  return { graph: { label: "Planned changes", nodes: [...nodes.values()], edges, sameRank: [changes.map((change) => `c|${change.id}`)] }, clusterLabels };
}

// A reference opens its file in the review, at the named heading when the selector is one.
function referenceLink(reference, ctx) {
  const selector = formatSelector(reference.selector);
  const label = `<code>${escapeHtml(reference.path)}</code>${selector ? `<span class="reference-selector">${escapeHtml(selector)}</span>` : ""}`;
  if (!ctx.hasArtifact(reference.path)) return `<span class="change-reference" title="${escapeHtml(formatReference(reference))}">${label}</span>`;
  const anchor = reference.selector?.type === "heading" ? headingSlug(reference.selector.value) : "";
  return `<button type="button" class="change-reference is-link" data-artifact="${escapeHtml(reference.path)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""} title="Open ${escapeHtml(formatReference(reference))}">${label}</button>`;
}

function referenceColumn(title, references, ctx) {
  return `<div class="change-side"><p class="eyebrow">${title}</p>${references?.length ? references.map((reference) => referenceLink(reference, ctx)).join("") : '<span class="muted">nothing</span>'}</div>`;
}

function reuseEvidence(evidence) {
  if (!evidence) return "";
  const candidates = evidence.candidates ?? [];
  return `<details class="change-evidence"><summary>Reuse evidence · ${plural(candidates.length, "candidate")}${evidence.receiptIds?.length ? ` · ${plural(evidence.receiptIds.length, "receipt")}` : ""}</summary>
    ${keyValues([
      ["Method", evidence.method ? escapeHtml(evidence.method) : null],
      ["Justification", evidence.justification ? escapeHtml(evidence.justification) : null],
      ["Empty result", evidence.emptyResultReason ? escapeHtml(evidence.emptyResultReason) : null],
      ["Receipts", evidence.receiptIds?.length ? evidence.receiptIds.map((id) => evidenceChip(id, "Search receipt")).join(" ") : null]
    ])}
    ${candidates.length ? `<ul class="candidate-list">${candidates.map((candidate) => `<li>
      <div class="candidate-head"><span class="disposition disposition-${escapeHtml(String(candidate.disposition).toLowerCase())}">${escapeHtml(candidate.disposition)}</span><code>${escapeHtml(formatReference(candidate.reference))}</code></div>
      <p>${escapeHtml(candidate.reason)}</p>
      ${candidate.receiptId ? evidenceChip(candidate.receiptId, "Receipt") : ""}
    </li>`).join("")}</ul>` : ""}
  </details>`;
}

// Repeated problems, such as one per reuse candidate, show once with their count.
function diagnosticList(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.code}|${item.message}`;
    const group = groups.get(key) ?? { ...item, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return `<ul class="diagnostic-list">${[...groups.values()].map((item) => `<li class="${item.blocking === false ? "" : "is-blocking"}"><code>${escapeHtml(item.code)}</code> ${escapeHtml(item.message)}${item.count > 1 ? ` <span class="muted">×${item.count}</span>` : ""}</li>`).join("")}</ul>`;
}

function changeCard(change, problems, ctx) {
  return `<article class="change-card action-${escapeHtml(change.action.toLowerCase())}${problems.some((item) => item.blocking !== false) ? " is-blocked" : ""}" id="change-${escapeHtml(change.id)}" data-change="${escapeHtml(change.id)}">
    <header class="change-head">${actionBadge(change.action)}<h3>${escapeHtml(change.label)}</h3><span class="muted">${escapeHtml(change.kind)}</span>${problems.length ? `<span class="status-pill ${problems.some((item) => item.blocking !== false) ? "is-bad" : "is-warn"}">${plural(problems.length, "problem")}</span>` : ""}</header>
    <p class="change-reason">${escapeHtml(change.reason)}</p>
    <div class="change-sides">${referenceColumn("Before", change.before, ctx)}<span class="change-arrow" aria-hidden="true">→</span>${referenceColumn("After", change.after, ctx)}</div>
    ${problems.length ? diagnosticList(problems) : ""}
    ${change.requirements?.length ? `<p class="change-requirements"><span class="eyebrow">Requirements</span> ${change.requirements.map((reference) => referenceLink(reference, ctx)).join("")}</p>` : ""}
    ${reuseEvidence(change.reuseEvidence)}
  </article>`;
}

function groupsOf(changes, by) {
  if (by === "action") return ACTIONS.map((action) => [action, changes.filter((change) => change.action === action)]).filter(([, items]) => items.length);
  const files = new Map();
  for (const change of changes) {
    for (const file of new Set([...(change.before ?? []), ...(change.after ?? [])].map((reference) => reference.path))) {
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(change);
    }
  }
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function readiness(summary, error, problems) {
  if (error) return `<span class="status-pill is-unknown" title="${escapeHtml(error)}">Status unavailable</span>`;
  if (!summary) return "";
  if (!summary.valid) return '<span class="status-pill is-bad">Invalid</span>';
  if (summary.ready) return '<span class="status-pill is-good">Ready for design audit</span>';
  const blocking = problems.filter((item) => item.blocking !== false);
  const blocked = new Set(blocking.map((item) => item.id).filter(Boolean));
  return `<button type="button" class="status-pill is-warn readiness-jump" data-jump-blocked>Not ready${blocking.length ? ` · ${plural(blocking.length, "blocking problem")}${blocked.size ? ` in ${plural(blocked.size, "change")}` : ""}` : ""}</button>`;
}

function planLines(document, ctx) {
  return keyValues([
    ["Scope", (document.scope ?? []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ") || null],
    ["Requirements", document.requirements?.length ? document.requirements.map((reference) => referenceLink(reference, ctx)).join("") : null],
    ["Expected growth", document.expectedGrowth?.length ? document.expectedGrowth.map((item) => `<code>${escapeHtml(item.dimension)}</code> +${escapeHtml(item.increase)} — ${escapeHtml(item.reason)}`).join("<br>") : null],
    ["Growth limits", document.growthThresholds?.length ? document.growthThresholds.map((item) => `<code>${escapeHtml(item.dimension)}</code> ≤ +${escapeHtml(item.maximumIncrease)}`).join(" ") : null],
    ["Growth reasons", document.growthJustifications?.length ? document.growthJustifications.map((item) => `${item.dimensions.map((dimension) => `<code>${escapeHtml(dimension)}</code>`).join(" ")} — ${escapeHtml(item.reason)}`).join("<br>") : null],
    ["Consolidates with", document.consolidations?.length ? document.consolidations.map((item) => `${artifactChip(item.deltaPath ?? `.prism/initiatives/${item.initiative}/slices/${item.slice}/change-map.json`, ctx, item.slice)} ${escapeHtml(item.reason)}`).join("<br>") : null]
  ]);
}

export async function render(container, data, ctx) {
  const document = data.data;
  const changes = document.concepts ?? [];
  const summary = data.summary;
  const diagnostics = summary?.diagnostics ?? [];
  const state = ctx.state;
  state.hidden ??= [];
  state.graph ??= {};
  state.mode ??= "list";
  state.groupBy ??= "action";
  const counts = Object.fromEntries(ACTIONS.map((action) => [action, changes.filter((change) => change.action === action).length]));
  const visible = changes.filter((change) => !state.hidden.includes(change.action));
  const problemsOf = (change) => diagnostics.filter((item) => item.id === change.id);
  const general = diagnostics.filter((item) => !item.id || !changes.some((change) => change.id === item.id));
  const blockedFirst = (left, right) => Number(problemsOf(right).some((item) => item.blocking !== false)) - Number(problemsOf(left).some((item) => item.blocking !== false));

  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status">${readiness(summary, data.summaryError, diagnostics)}${summary?.revision ? `<span class="meta-pill" title="${escapeHtml(summary.revision)}">rev ${escapeHtml(shortId(summary.revision))}</span>` : ""}</div>
        <div class="summary-links">${evidenceChip(document.baselineId, "Baseline snapshot")}</div>
      </div>
      ${planLines(document, ctx)}
      ${general.length ? diagnosticList(general) : ""}
      ${summary?.totalDiagnostics > diagnostics.length ? `<p class="muted">${summary.totalDiagnostics - diagnostics.length} more problems are not shown; read the change map through MCP for all of them.</p>` : ""}
      ${summary?.errors?.length ? `<ul class="diagnostic-list">${summary.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
      <div class="change-controls">
        <div class="action-filters" role="group" aria-label="Filter by action">
          ${ACTIONS.map((action) => `<button type="button" class="action-filter action-${action.toLowerCase()}" data-action="${action}" aria-pressed="${!state.hidden.includes(action)}"><span class="swatch"></span>${action}<strong>${counts[action]}</strong></button>`).join("")}
        </div>
        ${state.mode === "list" ? `<div class="segmented" role="group" aria-label="Group changes by">${GROUPS.map(([group, label]) => `<button type="button" data-group="${group}" aria-pressed="${state.groupBy === group}">${label}</button>`).join("")}</div>` : ""}
        <div class="segmented" role="group" aria-label="Change map view">${MODES.map(([mode, label]) => `<button type="button" data-mode="${mode}" aria-pressed="${state.mode === mode}">${label}</button>`).join("")}</div>
      </div>
    </section>
    <div data-change-body></div>`;

  const body = container.querySelector("[data-change-body]");
  if (state.mode === "graph") {
    const { graph, clusterLabels } = buildGraph(visible);
    const section = graphCard({
      title: plural(visible.length, "change"),
      eyebrow: "Before → change → after",
      legend: '<span><i class="legend-ref ref-before"></i>Before reference</span><span><i class="legend-ref ref-after"></i>After reference</span><span class="legend-hint">Click a change to read it in the list</span>'
    });
    body.appendChild(section);
    const viewport = section.querySelector(".graph-viewport");
    if (visible.length) {
      await renderGraph(viewport, graph, {
        clusterLabels,
        onSelect: (id) => {
          if (!id?.startsWith("c|")) return;
          state.mode = "list";
          state.focus = id.slice(2);
          ctx.rerender();
        }
      });
      enablePanZoom(section, state.graph);
    } else {
      viewport.innerHTML = emptyNote("No changes match the current filter.");
    }
  } else if (!visible.length) {
    body.innerHTML = card("No changes", emptyNote(changes.length ? "No changes match the current filter." : "The change map lists no changes yet."));
  } else {
    body.innerHTML = groupsOf(visible, state.groupBy).map(([group, items]) => `<section class="change-group">
      <h2 class="change-group-title">${state.groupBy === "action" ? actionBadge(group) : `<code>${escapeHtml(group)}</code>`}<span class="column-count">${items.length}</span></h2>
      ${[...items].sort(blockedFirst).map((change) => changeCard(change, problemsOf(change), ctx)).join("")}
    </section>`).join("");
  }

  for (const button of container.querySelectorAll(".action-filter")) {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      state.hidden = state.hidden.includes(action) ? state.hidden.filter((item) => item !== action) : [...state.hidden, action];
      ctx.rerender();
    });
  }
  for (const button of container.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      ctx.rerender();
    });
  }
  for (const button of container.querySelectorAll("[data-group]")) {
    button.addEventListener("click", () => {
      state.groupBy = button.dataset.group;
      ctx.rerender();
    });
  }
  const reveal = (element) => {
    if (!element) return;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    element.classList.remove("is-target");
    void element.offsetWidth;
    element.classList.add("is-target");
  };
  container.querySelector("[data-jump-blocked]")?.addEventListener("click", () => {
    if (state.mode !== "list") {
      state.mode = "list";
      state.focus = "@blocked";
      ctx.rerender();
      return;
    }
    reveal(container.querySelector(".change-card.is-blocked"));
  });
  if (state.focus && state.mode === "list") {
    const target = state.focus === "@blocked" ? container.querySelector(".change-card.is-blocked") : container.querySelector(`[data-change="${CSS.escape(state.focus)}"]`);
    state.focus = null;
    requestAnimationFrame(() => reveal(target));
  }
  bindLinks(container, ctx);
}
