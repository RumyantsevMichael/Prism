import { jsonTreeHtml } from "./json-tree.js";
import { artifactChip, bindLinks, emptyNote, escapeHtml, evidenceChip, formatReference, keyValues, plural, shortId } from "./util.js";

const KIND_LABELS = {
  comparison: "Comparison",
  snapshot: "Repository snapshot",
  search: "Search receipt",
  "repository-analysis": "Analysis receipt",
  analysis: "Analysis",
  migration: "Delta migration"
};
let stack = [];
let activeContext = null;

function drawer() {
  return {
    root: document.getElementById("evidence-drawer"),
    trail: document.getElementById("evidence-trail"),
    body: document.getElementById("evidence-body")
  };
}

function number(value) {
  return typeof value === "number" ? value.toLocaleString() : escapeHtml(value ?? "—");
}

function measurementChart(measurements, growth) {
  if (!measurements?.length) {
    return emptyNote("No measurements recorded.");
  }
  const thresholds = new Map((growth ?? []).map((item) => [item.dimension, item]));
  const numeric = measurements.filter((item) => typeof item.before === "number" && typeof item.after === "number");
  const measured = numeric.filter((item) => item.before !== 0 || item.after !== 0);
  const zero = numeric.filter((item) => !measured.includes(item));
  const unsupported = measurements.filter((item) => !numeric.includes(item));
  const rows = measured.map((item) => {
    const limit = thresholds.get(item.dimension);
    const thresholdValue = limit && typeof limit.threshold === "number" ? item.before + limit.threshold : null;
    const scale = Math.max(item.before, item.after, thresholdValue ?? 0, 1);
    const increase = item.after - item.before;
    const before = `<span class="bar bar-before" data-width="${(item.before / scale) * 100}"></span>`;
    const after = `<span class="bar bar-after" data-width="${(item.after / scale) * 100}"></span>`;
    const marker = thresholdValue === null ? "" : `<span class="threshold" data-left="${(thresholdValue / scale) * 100}" title="Threshold: +${limit.threshold}"></span>`;
    return `<li class="measure ${limit ? "is-over" : ""}" title="${escapeHtml(item.dimension)}: ${item.before} → ${item.after}${item.reason ? ` (${escapeHtml(item.reason)})` : ""}">
      <div class="measure-label"><code>${escapeHtml(item.dimension)}</code><span class="muted">${escapeHtml(item.provenance ?? "")}</span></div>
      <div class="measure-bars"><div class="bar-track">${before}</div><div class="bar-track">${after}${marker}</div></div>
      <div class="measure-values"><span>${number(item.before)} → ${number(item.after)}</span><strong class="${increase > 0 ? "delta-up" : increase < 0 ? "delta-down" : ""}">${increase > 0 ? "+" : ""}${number(increase)}</strong></div>
    </li>`;
  }).join("");
  return `<div class="chart-legend"><span><i class="bar-swatch bar-before"></i>Before (baseline)</span><span><i class="bar-swatch bar-after"></i>After (result)</span><span><i class="threshold-swatch"></i>Growth threshold</span></div><ul class="measure-chart">${rows}</ul>
    ${zero.length ? `<p class="muted unsupported-dimensions">Zero before and after: ${zero.map((item) => `<code>${escapeHtml(item.dimension)}</code>`).join(" ")}</p>` : ""}
    ${unsupported.length ? `<p class="muted unsupported-dimensions">Not measured for this source: ${unsupported.map((item) => `<code>${escapeHtml(item.dimension)}</code>`).join(" ")}</p>` : ""}`;
}

function observationList(observations) {
  if (!observations?.length) {
    return emptyNote("No observations.");
  }
  const order = ["failure", "review_required"];
  const sorted = [...observations].sort((left, right) => order.indexOf(left.severity) - order.indexOf(right.severity));
  return `<ul class="observation-list">${sorted.map((item) => `<li class="severity-${escapeHtml(item.severity)}">
    <div class="observation-head"><span class="observation-severity">${escapeHtml(item.severity.replace("_", " "))}</span><code>${escapeHtml(item.code)}</code>${item.conceptId ? `<span class="meta-pill">${escapeHtml(item.conceptId)}</span>` : ""}</div>
    <p>${escapeHtml(item.message)}</p>
    ${item.file ? `<p class="muted"><code>${escapeHtml(item.file)}</code>${item.side ? ` · ${escapeHtml(item.side)}` : ""}${item.unit ? ` · ${escapeHtml(typeof item.unit === "string" ? item.unit : item.unit.name ?? "")}` : ""}</p>` : ""}
  </li>`).join("")}</ul>`;
}

function comparison(record, ctx) {
  const failures = (record.observations ?? []).filter((item) => item.severity === "failure").length;
  return `${keyValues([
      ["Change map", record.deltaPath ? artifactChip(record.deltaPath, ctx) : null],
      ["Delta revision", record.deltaRevision ? `<code title="${escapeHtml(record.deltaRevision)}">${escapeHtml(shortId(record.deltaRevision))}</code>` : null],
      ["Baseline", evidenceChip(record.baselineId, "Baseline snapshot")],
      ["Result", evidenceChip(record.resultSnapshotId, "Result snapshot")],
      ["Analyses", [evidenceChip(record.analysisIds?.before, "Before analysis"), evidenceChip(record.analysisIds?.after, "After analysis")].join(" ").trim() || null],
      ["Scope", record.scope?.length ? record.scope.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ") : null]
    ])}
    <div class="stat-row compact">
      <div class="stat ${failures ? "is-bad" : "is-good"}"><span class="stat-value">${failures}</span><span class="stat-label">failures</span></div>
      <div class="stat"><span class="stat-value">${(record.observations ?? []).length - failures}</span><span class="stat-label">need review</span></div>
      <div class="stat ${(record.growth ?? []).length ? "is-warn" : ""}"><span class="stat-value">${(record.growth ?? []).length}</span><span class="stat-label">growth over threshold</span></div>
    </div>
    <h3>Measurements</h3>${measurementChart(record.measurements, record.growth)}
    <h3>Observations</h3>${observationList(record.observations)}`;
}

function snapshot(record) {
  const files = record.files ?? [];
  const kinds = files.reduce((counts, file) => ({ ...counts, [file.kind]: (counts[file.kind] ?? 0) + 1 }), {});
  return `${keyValues([
      ["Commit", record.commit ? `<code>${escapeHtml(shortId(record.commit))}</code>` : '<span class="muted">none</span>'],
      ["Fingerprint", `<code title="${escapeHtml(record.fingerprint)}">${escapeHtml(shortId(record.fingerprint))}</code>`],
      ["Complete", record.complete ? '<span class="status-pill is-good">complete</span>' : '<span class="status-pill is-warn">incomplete</span>'],
      ["Capture policy", record.capturePolicy ? `<code>${escapeHtml(typeof record.capturePolicy === "string" ? record.capturePolicy : JSON.stringify(record.capturePolicy))}</code>` : null],
      ["Files", Object.entries(kinds).map(([kind, count]) => `<span class="meta-pill">${escapeHtml(kind)}: ${count}</span>`).join(" ")]
    ])}
    ${record.omissions?.length ? `<h3>Omissions</h3><ul class="plain-list">${record.omissions.map((item) => `<li><code>${escapeHtml(item.file)}</code> — ${escapeHtml(item.reason)}</li>`).join("")}</ul>` : ""}
    <h3>Files</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>File</th><th>Kind</th><th>Bytes</th></tr></thead><tbody>${files.map((file) => `<tr><td><code>${escapeHtml(file.file)}</code></td><td>${escapeHtml(file.kind)}</td><td>${number(file.bytes)}</td></tr>`).join("")}</tbody></table></div>`;
}

function search(record) {
  const candidates = record.candidates ?? [];
  const flags = Object.entries(record.capabilities ?? {}).map(([key, value]) => `<span class="meta-pill ${value ? "" : "is-off"}">${escapeHtml(key)}${value ? "" : " ✕"}</span>`).join(" ");
  return `${keyValues([
      ["Query", `<q>${escapeHtml(record.query)}</q>`],
      ["Status", `<span class="status-pill ${record.status === "ready" ? "is-good" : "is-warn"}">${escapeHtml(record.status)}</span>`],
      ["Capabilities", flags || null],
      ["Snapshot", evidenceChip(record.snapshotId, "Snapshot")]
    ])}
    <h3>${plural(candidates.length, "candidate")}</h3>
    ${candidates.length ? `<ol class="candidate-ranking">${candidates.map((item) => `<li>
      <div class="candidate-head"><strong>${escapeHtml(item.name ?? item.selector ?? item.id)}</strong><span class="meta-pill">${escapeHtml(item.kind ?? "")}</span></div>
      <p class="muted"><code>${escapeHtml(item.file)}${item.range ? `:${item.range.startLine}-${item.range.endLine}` : ""}</code></p>
      <p class="scores">${typeof item.cosineSimilarity === "number" ? `cosine ${item.cosineSimilarity.toFixed(3)}` : ""} ${typeof item.lexicalScore === "number" ? `· lexical ${item.lexicalScore.toFixed(3)}` : ""} ${item.fusedRank ? `· fused rank ${item.fusedRank}` : ""}</p>
      ${item.excerpt ? `<pre><code>${escapeHtml(item.excerpt)}</code></pre>` : ""}
    </li>`).join("")}</ol>` : emptyNote("The search returned no candidates.")}`;
}

function body(evidence, ctx) {
  const record = evidence.record;
  const truncated = Object.entries(evidence.truncated ?? {});
  const specific = record.kind === "comparison" ? comparison(record, ctx) : record.kind === "snapshot" ? snapshot(record) : record.kind === "search" ? search(record) : "";
  return `<p class="eyebrow">${escapeHtml(KIND_LABELS[record.kind] ?? record.kind)}</p>
    <h2 class="evidence-title"><code>${escapeHtml(shortId(evidence.id))}</code></h2>
    ${truncated.length ? `<p class="notice">Long lists show their first ${evidence.arrayLimit} entries: ${truncated.map(([location, count]) => `<code>${escapeHtml(location)}</code> (${count})`).join(", ")}.</p>` : ""}
    ${specific}
    <details class="raw-record"${specific ? "" : " open"}><summary>Raw record</summary>${jsonTreeHtml(record, { openDepth: specific ? 1 : 2, ctx })}</details>`;
}

async function renderTop() {
  const { root, trail, body: target } = drawer();
  const top = stack.at(-1);
  root.hidden = false;
  trail.innerHTML = stack.map((entry, index) => `<button type="button" class="trail-item" data-depth="${index}" ${index === stack.length - 1 ? 'aria-current="true"' : ""}>${escapeHtml(entry.label)}</button>`).join('<span aria-hidden="true">›</span>');
  target.innerHTML = '<p class="rendering">Loading evidence</p>';
  try {
    const evidence = top.evidence ?? (top.evidence = await activeContext.fetchEvidence(top.id));
    target.innerHTML = body(evidence, activeContext);
    for (const bar of target.querySelectorAll("[data-width]")) {
      bar.style.width = `${Math.max(0.5, Number(bar.dataset.width))}%`;
    }
    for (const marker of target.querySelectorAll("[data-left]")) {
      marker.style.left = `${Math.min(100, Number(marker.dataset.left))}%`;
    }
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

export function openEvidence(id, label, ctx) {
  const { root, trail, body: target } = drawer();
  if (!root.dataset.bound) {
    root.dataset.bound = "true";
    trail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-depth]");
      if (button) {
        stack = stack.slice(0, Number(button.dataset.depth) + 1);
        void renderTop();
      }
    });
    bindLinks(target, {
      openEvidence: (nextId, nextLabel) => openEvidence(nextId, nextLabel, activeContext),
      openArtifact: (path) => {
        activeContext.openArtifact(path);
      }
    });
  }
  activeContext = ctx;
  if (root.hidden) {
    stack = [];
  }
  const existing = stack.findIndex((entry) => entry.id === id);
  stack = existing >= 0 ? stack.slice(0, existing + 1) : [...stack, { id, label }];
  void renderTop();
}

export function closeEvidence() {
  const { root } = drawer();
  root.hidden = true;
  stack = [];
}
