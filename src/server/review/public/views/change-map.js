import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, evidenceChip, formatReference, formatSelector, keyValues, plural, shortId } from "./util.js";

const ACTIONS = ["ADD", "MODIFY", "REPLACE", "DELETE", "KEEP"];

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
      nodes.set(id, { id, cluster, title: selector || "(whole file)", subtitle: typeof reference.selector === "object" && reference.selector ? reference.selector.type : "", tooltip: formatReference(reference), className: `ref-node ref-${side === "b" ? "before" : "after"}`, monospace: true, reference, side });
    }
    edges.push(side === "b" ? { from: id, to: `c|${change.id}`, className: `action-${change.action.toLowerCase()}` } : { from: `c|${change.id}`, to: id, className: `action-${change.action.toLowerCase()}` });
  };
  for (const change of changes) {
    nodes.set(`c|${change.id}`, { id: `c|${change.id}`, title: change.label, subtitle: `${change.kind} · ${change.action}`, tooltip: change.reason, className: `change-node action-${change.action.toLowerCase()}`, change });
    for (const reference of change.before ?? []) addReference("b", reference, change);
    for (const reference of change.after ?? []) addReference("a", reference, change);
  }
  return {
    graph: { label: "Planned changes", nodes: [...nodes.values()], edges, sameRank: [changes.map((change) => `c|${change.id}`)] },
    clusterLabels,
    nodes
  };
}

function referenceList(references) {
  if (!references?.length) {
    return emptyNote("None");
  }
  return `<ul class="reference-list">${references.map((reference) => `<li><code>${escapeHtml(reference.path)}</code>${formatSelector(reference.selector) ? `<span>${escapeHtml(formatSelector(reference.selector))}</span>` : ""}</li>`).join("")}</ul>`;
}

function reuseEvidence(evidence) {
  if (!evidence) {
    return "";
  }
  const candidates = evidence.candidates ?? [];
  return `<div class="detail-block">
    <h3>Reuse evidence</h3>
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
  </div>`;
}

function changeDetail(change, diagnostics) {
  const own = diagnostics.filter((item) => item.id === change.id);
  return `<p class="eyebrow">Change · ${escapeHtml(change.kind)}</p>
    <h2>${escapeHtml(change.label)}</h2>
    <p class="detail-meta">${actionBadge(change.action)} <code>${escapeHtml(change.id)}</code></p>
    ${own.length ? `<ul class="diagnostic-list">${own.map(diagnosticItem).join("")}</ul>` : ""}
    <div class="detail-block"><h3>Reason</h3><p>${escapeHtml(change.reason)}</p></div>
    <div class="detail-block"><h3>Before</h3>${referenceList(change.before)}</div>
    <div class="detail-block"><h3>After</h3>${referenceList(change.after)}</div>
    ${change.requirements?.length ? `<div class="detail-block"><h3>Requirements</h3>${referenceList(change.requirements)}</div>` : ""}
    ${reuseEvidence(change.reuseEvidence)}`;
}

function referenceDetail(node, changes) {
  const users = changes.filter((change) => (node.side === "b" ? change.before : change.after)?.some((reference) => referenceKey(node.side, reference) === node.id));
  return `<p class="eyebrow">${node.side === "b" ? "Before" : "After"} reference</p>
    <h2>${escapeHtml(formatSelector(node.reference.selector) || "(whole file)")}</h2>
    <p class="detail-meta"><code>${escapeHtml(node.reference.path)}</code></p>
    <div class="detail-block"><h3>Changes</h3><ul class="plain-list">${users.map((change) => `<li><button type="button" class="text-button" data-select="c|${escapeHtml(change.id)}">${escapeHtml(change.label)}</button> ${actionBadge(change.action)}</li>`).join("")}</ul></div>`;
}

function diagnosticItem(item) {
  return `<li class="${item.blocking ? "is-blocking" : ""}"><code>${escapeHtml(item.code)}</code> ${escapeHtml(item.message)}${item.id ? ` <button type="button" class="text-button" data-select="c|${escapeHtml(item.id)}">${escapeHtml(item.id)}</button>` : ""}</li>`;
}

function diagnosticsSummary(diagnostics, total) {
  const groups = new Map();
  for (const item of diagnostics) {
    const group = groups.get(item.code) ?? { code: item.code, message: item.message, blocking: false, ids: new Set() };
    group.blocking ||= Boolean(item.blocking);
    if (item.id) group.ids.add(item.id);
    groups.set(item.code, group);
  }
  const blocking = diagnostics.filter((item) => item.blocking).length;
  const sorted = [...groups.values()].sort((left, right) => Number(right.blocking) - Number(left.blocking));
  return `<details class="diagnostics"><summary>${plural(total ?? diagnostics.length, "diagnostic")} in ${plural(groups.size, "group")}${blocking ? ` · <span class="status-pill is-bad">${blocking} blocking</span>` : ""}</summary>
    <ul class="diagnostic-list">${sorted.map((group) => `<li class="${group.blocking ? "is-blocking" : ""}"><code>${escapeHtml(group.code)}</code> ${escapeHtml(group.message)}${group.ids.size ? ` ${[...group.ids].map((id) => `<button type="button" class="text-button" data-select="c|${escapeHtml(id)}">${escapeHtml(id)}</button>`).join(", ")}` : ""}</li>`).join("")}</ul>
  </details>`;
}

function status(summary, error) {
  if (error) {
    return `<span class="status-pill is-unknown" title="${escapeHtml(error)}">Status unavailable</span>`;
  }
  if (!summary) {
    return "";
  }
  return `<span class="status-pill ${summary.valid ? "is-good" : "is-bad"}">${summary.valid ? "Valid" : "Invalid"}</span>
    <span class="status-pill ${summary.ready ? "is-good" : "is-warn"}">${summary.ready ? "Ready" : "Not ready"}</span>`;
}

function metadata(document, ctx) {
  const blocks = [];
  if (document.requirements?.length) blocks.push(`<div class="detail-block"><h3>Requirements</h3>${referenceList(document.requirements)}</div>`);
  if (document.expectedGrowth?.length) blocks.push(`<div class="detail-block"><h3>Expected growth</h3><ul class="plain-list">${document.expectedGrowth.map((item) => `<li><code>${escapeHtml(item.dimension)}</code> +${escapeHtml(item.increase)} — ${escapeHtml(item.reason)}</li>`).join("")}</ul></div>`);
  if (document.growthThresholds?.length) blocks.push(`<div class="detail-block"><h3>Growth thresholds</h3><ul class="plain-list">${document.growthThresholds.map((item) => `<li><code>${escapeHtml(item.dimension)}</code> ≤ +${escapeHtml(item.maximumIncrease)}</li>`).join("")}</ul></div>`);
  if (document.growthJustifications?.length) blocks.push(`<div class="detail-block"><h3>Growth justifications</h3><ul class="plain-list">${document.growthJustifications.map((item) => `<li>${item.dimensions.map((dimension) => `<code>${escapeHtml(dimension)}</code>`).join(" ")} — ${escapeHtml(item.reason)}</li>`).join("")}</ul></div>`);
  if (document.consolidations?.length) blocks.push(`<div class="detail-block"><h3>Consolidations</h3><ul class="plain-list">${document.consolidations.map((item) => `<li>${artifactChip(item.deltaPath, ctx)} ${escapeHtml(item.reason)}</li>`).join("")}</ul></div>`);
  return blocks.length ? card("Plan metadata", blocks.join(""), { eyebrow: "Design intent" }) : "";
}

export async function render(container, data, ctx) {
  const document = data.data;
  const changes = document.concepts ?? [];
  const summary = data.summary;
  const diagnostics = summary?.diagnostics ?? [];
  const state = ctx.state;
  state.hidden ??= [];
  state.graph ??= {};
  const counts = Object.fromEntries(ACTIONS.map((action) => [action, changes.filter((change) => change.action === action).length]));
  const visible = changes.filter((change) => !state.hidden.includes(change.action));

  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status">${status(summary, data.summaryError)}<span class="meta-pill">schema v${escapeHtml(document.schemaVersion)}</span>${summary?.revision ? `<span class="meta-pill" title="${escapeHtml(summary.revision)}">rev ${escapeHtml(shortId(summary.revision))}</span>` : ""}</div>
        <div class="summary-links">${evidenceChip(document.baselineId, "Baseline snapshot")}</div>
      </div>
      <div class="action-filters" role="group" aria-label="Filter by action">
        ${ACTIONS.map((action) => `<button type="button" class="action-filter action-${action.toLowerCase()}" data-action="${action}" aria-pressed="${!state.hidden.includes(action)}"><span class="swatch"></span>${action}<strong>${counts[action]}</strong></button>`).join("")}
      </div>
      <p class="scope-line"><span class="eyebrow">Scope</span> ${(document.scope ?? []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ") || emptyNote("No scope")}</p>
      ${diagnostics.length ? diagnosticsSummary(diagnostics, summary.totalDiagnostics) : ""}
      ${summary?.errors?.length ? `<ul class="diagnostic-list">${summary.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
    </section>
    <div class="split-layout">
      <div class="split-main" data-graph-slot></div>
      <aside class="view-card detail-panel" aria-live="polite" data-detail></aside>
    </div>
    ${metadata(document, ctx)}
    ${card("All changes", `<div class="table-wrap"><table class="data-table"><thead><tr><th>Change</th><th>Kind</th><th>Action</th><th>Before</th><th>After</th></tr></thead><tbody>${changes.map((change) => `<tr data-select="c|${escapeHtml(change.id)}" class="${state.selected === `c|${change.id}` ? "is-selected" : ""}"><td><button type="button" class="text-button" data-select="c|${escapeHtml(change.id)}">${escapeHtml(change.label)}</button></td><td>${escapeHtml(change.kind)}</td><td>${actionBadge(change.action)}</td><td>${change.before?.length ?? 0}</td><td>${change.after?.length ?? 0}</td></tr>`).join("")}</tbody></table></div>`, { eyebrow: "Table view" })}`;

  const { graph, clusterLabels, nodes } = buildGraph(visible);
  const detail = container.querySelector("[data-detail]");
  const showDetail = () => {
    const node = nodes.get(state.selected);
    if (!node) {
      detail.innerHTML = `<p class="eyebrow">Details</p><h2>Select a change</h2><p class="empty-note">Click a change or a source reference in the graph to see its reason, references, and reuse evidence.</p>`;
    } else {
      detail.innerHTML = node.change ? changeDetail(node.change, diagnostics) : referenceDetail(node, changes);
    }
  };
  showDetail();

  const graphSection = graphCard({
    title: plural(visible.length, "change"),
    eyebrow: "Before → change → after",
    legend: `<span><i class="legend-ref ref-before"></i>Before reference</span><span><i class="legend-ref ref-after"></i>After reference</span><span class="legend-hint">Drag to pan · Ctrl + wheel to zoom</span>`
  });
  container.querySelector("[data-graph-slot]").appendChild(graphSection);
  const viewport = graphSection.querySelector(".graph-viewport");
  let graphView = null;
  const select = (id, reveal = false) => {
    state.selected = id;
    graphView?.setSelected(id, reveal);
    for (const row of container.querySelectorAll("tr[data-select]")) {
      row.classList.toggle("is-selected", row.dataset.select === id);
    }
    showDetail();
  };
  if (visible.length === 0) {
    viewport.innerHTML = emptyNote("No changes match the current filter.");
  } else {
    graphView = await renderGraph(viewport, graph, { onSelect: (id, options) => options?.double ? undefined : select(state.selected === id ? null : id), selectedId: state.selected, clusterLabels });
    enablePanZoom(graphSection, state.graph);
  }

  for (const button of container.querySelectorAll(".action-filter")) {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      state.hidden = state.hidden.includes(action) ? state.hidden.filter((item) => item !== action) : [...state.hidden, action];
      ctx.rerender();
    });
  }
  container.addEventListener("click", (event) => {
    const target = event.target.closest("[data-select]");
    if (target && !target.closest(".graph-node")) {
      select(target.dataset.select, true);
    }
  });
  bindLinks(container, ctx);
}
