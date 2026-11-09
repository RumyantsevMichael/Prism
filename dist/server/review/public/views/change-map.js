import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { headingSlug } from "./markdown.js";
import { artifactChip, badge, bindLinks, card, chip, emptyState, escapeHtml, evidenceChip, formatReference, formatSelector, keyValues, pathName, plural, shortId, summaryPanel } from "./util.js";

const ACTIONS = ["ADD", "MODIFY", "REPLACE", "DELETE", "KEEP"];
const MODES = [["list", "List"], ["graph", "Graph"]];
const GROUPS = [["action", "Action"], ["file", "File"]];

const ACTION_TONES = { ADD: "success", MODIFY: "info", REPLACE: "accent", DELETE: "danger", KEEP: "neutral" };

function actionBadge(action) {
  return `<prism-badge variant="status" tone="${ACTION_TONES[action] ?? "neutral"}" class="action-${escapeHtml(String(action).toLowerCase())}">${escapeHtml(action)}</prism-badge>`;
}

function referenceKey(side, reference) {
  return `${side}|${reference.path}|${JSON.stringify(reference.selector ?? "")}`;
}

function buildGraph(changes, derived) {
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
  return { graph: { label: derived ? "Verified changes" : "Planned changes", nodes: [...nodes.values()], edges, sameRank: [changes.map((change) => `c|${change.id}`)] }, clusterLabels };
}

// A reference opens its file in the review, at the named heading when the selector is one.
// The files a change touches are repository code, so they keep their paths; a requirement names its section and its file's title.
function referenceLink(reference, ctx, { code = true } = {}) {
  const selector = formatSelector(reference.selector);
  const anchor = reference.selector?.type === "heading" ? headingSlug(reference.selector.value) : "";
  if (!code) {
    const { label, code: isCode } = pathName(reference.path, ctx);
    if (!isCode) {
      const heading = reference.selector?.type === "heading" ? reference.selector.value : "";
      const title = ctx.recordTitle?.(reference.path) ?? label;
      const text = heading && heading !== title ? `${heading} · ${title}` : label;
      return ctx.hasArtifact(reference.path)
        ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(reference.path)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${escapeHtml(text)}</prism-chip>`
        : `<prism-chip>${escapeHtml(text)}</prism-chip>`;
    }
  }
  const text = `${escapeHtml(reference.path)}${selector ? `<span slot="meta">${escapeHtml(selector)}</span>` : ""}`;
  if (!ctx.hasArtifact(reference.path)) return `<prism-chip class="change-reference" data-code-subject tip="${escapeHtml(formatReference(reference))}">${text}</prism-chip>`;
  return `<prism-chip interactive tone="accent" class="change-reference" data-code-subject data-artifact="${escapeHtml(reference.path)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""} tip="Open ${escapeHtml(formatReference(reference))}">${text}</prism-chip>`;
}

function referenceColumn(title, references, ctx) {
  return `<div class="change-side"><p class="label-caps">${title}</p><div class="chip-row">${references?.length ? references.map((reference) => referenceLink(reference, ctx)).join("") : '<span class="muted">nothing</span>'}</div></div>`;
}

const DISPOSITION_TONES = { reuse: "success", extend: "info", reject: "neutral", rejected: "neutral" };

function reuseEvidence(evidence) {
  if (!evidence) return "";
  const candidates = evidence.candidates ?? [];
  return `<prism-disclosure class="change-evidence" summary="Reuse evidence · ${plural(candidates.length, "candidate")}${evidence.receiptIds?.length ? ` · ${plural(evidence.receiptIds.length, "receipt")}` : ""}">
    ${keyValues([
      ["Method", evidence.method ? escapeHtml(evidence.method) : null],
      ["Justification", evidence.justification ? escapeHtml(evidence.justification) : null],
      ["Empty result", evidence.emptyResultReason ? escapeHtml(evidence.emptyResultReason) : null],
      ["Receipts", evidence.receiptIds?.length ? `<span class="chip-row">${evidence.receiptIds.map((id) => evidenceChip(id, "Search receipt")).join("")}</span>` : null]
    ])}
    ${candidates.length ? `<ul class="row-list candidate-list">${candidates.map((candidate) => `<li>
      <div class="candidate-head">${badge(String(candidate.disposition), DISPOSITION_TONES[String(candidate.disposition).toLowerCase()] ?? "neutral")}<code data-code-subject>${escapeHtml(formatReference(candidate.reference))}</code></div>
      <p>${escapeHtml(candidate.reason)}</p>
      ${candidate.receiptId ? evidenceChip(candidate.receiptId, "Receipt") : ""}
    </li>`).join("")}</ul>` : ""}
  </prism-disclosure>`;
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
  return `<ul class="diagnostic-list">${[...groups.values()].map((item) => `<li class="${item.blocking === false ? "" : "is-blocking"}">${badge(item.blocking === false ? "warning" : "blocking", item.blocking === false ? "warning" : "danger")}<code>${escapeHtml(item.code)}</code> <span class="diagnostic-message">${escapeHtml(item.message)}</span>${item.count > 1 ? ` <span class="muted">×${item.count}</span>` : ""}</li>`).join("")}</ul>`;
}

function changeCard(change, problems, ctx) {
  const blocked = problems.some((item) => item.blocking !== false);
  return `<prism-panel class="change-record action-${escapeHtml(change.action.toLowerCase())}${blocked ? " is-blocked" : ""}" id="change-${escapeHtml(change.id)}" data-change="${escapeHtml(change.id)}" heading="${escapeHtml(change.label)}" eyebrow="${escapeHtml(change.kind)}" level="3">
    <span slot="tools" class="chip-row">${actionBadge(change.action)}${problems.length ? badge(plural(problems.length, "problem"), blocked ? "danger" : "warning") : ""}</span>
    <p class="change-reason">${escapeHtml(change.reason)}</p>
    <div class="change-sides">${referenceColumn("Before", change.before, ctx)}<prism-icon class="change-arrow" name="chevron-right"></prism-icon>${referenceColumn("After", change.after, ctx)}</div>
    ${problems.length ? diagnosticList(problems) : ""}
    ${change.requirements?.length ? `<div class="change-requirements"><p class="label-caps">Requirements</p><div class="chip-row">${change.requirements.map((reference) => referenceLink(reference, ctx, { code: false })).join("")}</div></div>` : ""}
    ${reuseEvidence(change.reuseEvidence)}
  </prism-panel>`;
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

function readiness(summary, error, problems, derived) {
  if (derived) return `<prism-badge variant="status" tone="success" tip="Verification run ${escapeHtml(derived.runId)}">From the verified result</prism-badge>`;
  if (error) return `<prism-badge variant="status" tone="neutral" tip="${escapeHtml(error)}">Status unavailable</prism-badge>`;
  if (!summary) return "";
  if (!summary.valid) return badge("Invalid", "danger");
  if (summary.ready) return badge("Ready for design audit", "success");
  const blocking = problems.filter((item) => item.blocking !== false);
  const blocked = new Set(blocking.map((item) => item.id).filter(Boolean));
  return `<prism-chip interactive tone="warning" class="readiness-jump" data-jump-blocked>Not ready${blocking.length ? ` · ${plural(blocking.length, "blocking problem")}${blocked.size ? ` in ${plural(blocked.size, "change")}` : ""}` : ""}</prism-chip>`;
}

const codes = (items) => items.map((item) => `<code data-code-subject>${escapeHtml(item)}</code>`).join(" ");

function planLines(document, ctx) {
  return keyValues([
    ["Derived", document.derived ? `Compared the source when the design was accepted with the source that verification run <code>${escapeHtml(document.derived.runId)}</code> tested, ${escapeHtml(new Date(document.derived.derivedAt).toLocaleString())}.` : null],
    ["Scope", (document.scope ?? []).length ? codes(document.scope) : null],
    ["Requirements", document.requirements?.length ? `<span class="chip-row">${document.requirements.map((reference) => referenceLink(reference, ctx, { code: false })).join("")}</span>` : null],
    ["Expected growth", document.expectedGrowth?.length ? document.expectedGrowth.map((item) => `<code>${escapeHtml(item.dimension)}</code> +${escapeHtml(item.increase)} — ${escapeHtml(item.reason)}`).join("<br>") : null],
    ["Growth limits", document.growthThresholds?.length ? document.growthThresholds.map((item) => `<code>${escapeHtml(item.dimension)}</code> ≤ +${escapeHtml(item.maximumIncrease)}`).join(" ") : null],
    ["Growth reasons", document.growthJustifications?.length ? document.growthJustifications.map((item) => `${item.dimensions.map((dimension) => `<code>${escapeHtml(dimension)}</code>`).join(" ")} — ${escapeHtml(item.reason)}`).join("<br>") : null],
    ["Consolidates with", document.consolidations?.length ? document.consolidations.map((item) => `${artifactChip(item.deltaPath ?? `.prism/initiatives/${item.initiative}/slices/${item.slice}/change-map.json`, ctx, `Change map · ${ctx.recordTitle?.(`slice:${item.initiative}/${item.slice}`) ?? item.slice}`)} ${escapeHtml(item.reason)}`).join("<br>") : null]
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

  const toggle = (attributes, label, pressed) => `<prism-button size="sm" variant="ghost" ${attributes} pressed="${pressed}">${label}</prism-button>`;
  container.innerHTML = `
    ${summaryPanel(`
      <div class="summary-row">
        <div class="chip-row">${readiness(summary, data.summaryError, diagnostics, document.derived)}${summary?.revision ? chip(`rev ${escapeHtml(shortId(summary.revision))}`, { tip: summary.revision }) : ""}</div>
        <div class="chip-row">${evidenceChip(document.baselineId, "Baseline snapshot")}</div>
      </div>
      ${planLines(document, ctx)}
      ${general.length ? diagnosticList(general) : ""}
      ${summary?.totalDiagnostics > diagnostics.length ? `<p class="muted">${summary.totalDiagnostics - diagnostics.length} more problems are not shown; read the change map through MCP for all of them.</p>` : ""}
      ${summary?.errors?.length ? `<ul class="diagnostic-list">${summary.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
      <div class="view-controls change-controls">
        <div class="segmented action-filters" role="group" aria-label="Filter by action">
          ${ACTIONS.map((action) => toggle(`class="action-filter" data-filter-action="${action}"`, `<span class="action-swatch action-${action.toLowerCase()}" aria-hidden="true"></span>${action} <span class="action-count">${counts[action]}</span>`, !state.hidden.includes(action))).join("")}
        </div>
        ${state.mode === "list" ? `<div class="segmented" role="group" aria-label="Group changes by">${GROUPS.map(([group, label]) => toggle(`data-group="${group}"`, label, state.groupBy === group)).join("")}</div>` : ""}
        <div class="segmented" role="group" aria-label="Change map view">${MODES.map(([mode, label]) => toggle(`data-mode="${mode}"`, label, state.mode === mode)).join("")}</div>
      </div>`, "change-summary")}
    <div class="change-body" data-change-body></div>`;

  const body = container.querySelector("[data-change-body]");
  if (state.mode === "graph") {
    const { graph, clusterLabels } = buildGraph(visible, document.derived);
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
      viewport.innerHTML = emptyState("No changes match the current filter.");
    }
  } else if (!visible.length) {
    body.innerHTML = card("No changes", emptyState(changes.length ? "No changes match the current filter." : "The change map lists no changes yet."));
  } else {
    body.innerHTML = groupsOf(visible, state.groupBy).map(([group, items]) => `<section class="change-group">
      <h2 class="change-group-title">${state.groupBy === "action" ? actionBadge(group) : `<code data-code-subject>${escapeHtml(group)}</code>`}<prism-badge variant="count">${items.length}</prism-badge></h2>
      ${[...items].sort(blockedFirst).map((change) => changeCard(change, problemsOf(change), ctx)).join("")}
    </section>`).join("");
  }

  for (const button of container.querySelectorAll(".action-filter")) {
    button.addEventListener("click", () => {
      const action = button.dataset.filterAction;
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
    reveal(container.querySelector(".change-record.is-blocked"));
  });
  if (state.focus && state.mode === "list") {
    const target = state.focus === "@blocked" ? container.querySelector(".change-record.is-blocked") : container.querySelector(`[data-change="${CSS.escape(state.focus)}"]`);
    state.focus = null;
    requestAnimationFrame(() => reveal(target));
  }
  bindLinks(container, ctx);
}
