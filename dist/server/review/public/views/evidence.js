import { jsonTreeHtml } from "./json-tree.js";
import { badge, bindLinks, chip, emptyState, escapeHtml, evidenceChip, keyValues, plural, recordChip, shortId, stat } from "./util.js";

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

// A whole percent of `value` out of `scale`, for a kit meter.
const percent = (value, scale) => Math.max(0, Math.min(100, Math.round((value / scale) * 100)));

function measurementChart(measurements, growth) {
  if (!measurements?.length) {
    return emptyState("No measurements recorded");
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
    const tip = `${item.dimension}: ${item.before} → ${item.after}${item.reason ? ` (${item.reason})` : ""}`;
    return `<li class="measure${limit ? " is-over" : ""}">
      <div class="measure-label"><code>${escapeHtml(item.dimension)}</code><span class="muted">${escapeHtml(item.provenance ?? "")}</span></div>
      <div class="measure-bars">
        <prism-meter label="Before" value="${percent(item.before, scale)}" tip="${escapeHtml(tip)}"></prism-meter>
        <prism-meter label="After" value="${percent(item.after, scale)}" tone="${limit ? "warning" : "info"}" tip="${escapeHtml(tip)}"></prism-meter>
      </div>
      <div class="measure-values"><span>${number(item.before)} → ${number(item.after)}</span><strong class="${increase > 0 ? "delta-up" : increase < 0 ? "delta-down" : ""}">${increase > 0 ? "+" : ""}${number(increase)}</strong>${thresholdValue === null ? "" : `<span class="muted">threshold +${number(limit.threshold)}</span>`}</div>
    </li>`;
  }).join("");
  return `<p class="muted measure-legend">Each pair of bars is before (the baseline) and after (the result), as a share of the largest of the two and the growth threshold.</p><ul class="measure-chart">${rows}</ul>
    ${zero.length ? `<p class="muted">Zero before and after: ${zero.map((item) => `<code>${escapeHtml(item.dimension)}</code>`).join(" ")}</p>` : ""}
    ${unsupported.length ? `<p class="muted">Not measured for this source: ${unsupported.map((item) => `<code>${escapeHtml(item.dimension)}</code>`).join(" ")}</p>` : ""}`;
}

const OBSERVATION_TONES = { failure: "danger", review_required: "warning" };

function observationList(observations) {
  if (!observations?.length) {
    return emptyState("No observations");
  }
  const order = ["failure", "review_required"];
  const sorted = [...observations].sort((left, right) => order.indexOf(left.severity) - order.indexOf(right.severity));
  return `<ul class="row-list observation-list">${sorted.map((item) => `<li>
    <div class="chip-row">${badge(item.severity.replace("_", " "), OBSERVATION_TONES[item.severity] ?? "neutral")}<code>${escapeHtml(item.code)}</code>${item.conceptId ? chip(escapeHtml(item.conceptId)) : ""}</div>
    <p>${escapeHtml(item.message)}</p>
    ${item.file ? `<p class="muted"><code data-code-subject>${escapeHtml(item.file)}</code>${item.side ? ` · ${escapeHtml(item.side)}` : ""}${item.unit ? ` · ${escapeHtml(typeof item.unit === "string" ? item.unit : item.unit.name ?? "")}` : ""}</p>` : ""}
  </li>`).join("")}</ul>`;
}

const codes = (items) => items.map((item) => `<code data-code-subject>${escapeHtml(item)}</code>`).join(" ");

function comparison(record, ctx) {
  const failures = (record.observations ?? []).filter((item) => item.severity === "failure").length;
  return `${keyValues([
      ["Change map", record.deltaPath ? recordChip(record.deltaPath, ctx) : null],
      ["Delta revision", record.deltaRevision ? chip(`<code>${escapeHtml(shortId(record.deltaRevision))}</code>`, { tip: record.deltaRevision }) : null],
      ["Baseline", evidenceChip(record.baselineId, "Baseline snapshot")],
      ["Result", evidenceChip(record.resultSnapshotId, "Result snapshot")],
      ["Analyses", [evidenceChip(record.analysisIds?.before, "Before analysis"), evidenceChip(record.analysisIds?.after, "After analysis")].join(" ").trim() || null],
      ["Scope", record.scope?.length ? codes(record.scope) : null]
    ])}
    <div class="stat-grid">
      ${stat("failures", String(failures), { tone: failures ? "danger" : "success" })}
      ${stat("need review", String((record.observations ?? []).length - failures))}
      ${stat("growth over threshold", String((record.growth ?? []).length), { tone: (record.growth ?? []).length ? "warning" : "" })}
    </div>
    <h3 class="label-caps">Measurements</h3>${measurementChart(record.measurements, record.growth)}
    <h3 class="label-caps">Observations</h3>${observationList(record.observations)}`;
}

function snapshot(record) {
  const files = record.files ?? [];
  const kinds = files.reduce((counts, file) => ({ ...counts, [file.kind]: (counts[file.kind] ?? 0) + 1 }), {});
  return `${keyValues([
      ["Commit", record.commit ? `<code>${escapeHtml(shortId(record.commit))}</code>` : '<span class="muted">none</span>'],
      ["Fingerprint", chip(`<code>${escapeHtml(shortId(record.fingerprint))}</code>`, { tip: record.fingerprint })],
      ["Complete", record.complete ? badge("complete", "success") : badge("incomplete", "warning")],
      ["Capture policy", record.capturePolicy ? `<code>${escapeHtml(typeof record.capturePolicy === "string" ? record.capturePolicy : JSON.stringify(record.capturePolicy))}</code>` : null],
      ["Files", `<span class="chip-row">${Object.entries(kinds).map(([kind, count]) => chip(`${escapeHtml(kind)}: ${count}`)).join("")}</span>`]
    ])}
    ${record.omissions?.length ? `<h3 class="label-caps">Omissions</h3><ul class="row-list">${record.omissions.map((item) => `<li><code data-code-subject>${escapeHtml(item.file)}</code> — ${escapeHtml(item.reason)}</li>`).join("")}</ul>` : ""}
    <h3 class="label-caps">Files</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>File</th><th>Kind</th><th>Bytes</th></tr></thead><tbody>${files.map((file) => `<tr><td><code data-code-subject>${escapeHtml(file.file)}</code></td><td>${escapeHtml(file.kind)}</td><td>${number(file.bytes)}</td></tr>`).join("")}</tbody></table></div>`;
}

function search(record) {
  const candidates = record.candidates ?? [];
  const flags = Object.entries(record.capabilities ?? {}).map(([key, value]) => chip(`${escapeHtml(key)}${value ? "" : " ✕"}`, { tone: value ? "" : "neutral", attributes: value ? "" : ' class="is-off"' })).join("");
  return `${keyValues([
      ["Query", `<q>${escapeHtml(record.query)}</q>`],
      ["Status", badge(record.status, record.status === "ready" ? "success" : "warning")],
      ["Capabilities", flags ? `<span class="chip-row">${flags}</span>` : null],
      ["Snapshot", evidenceChip(record.snapshotId, "Snapshot")]
    ])}
    <h3 class="label-caps">${plural(candidates.length, "candidate")}</h3>
    ${candidates.length ? `<ol class="row-list candidate-ranking">${candidates.map((item) => `<li>
      <div class="chip-row"><strong>${escapeHtml(item.name ?? item.selector ?? item.id)}</strong>${item.kind ? chip(escapeHtml(item.kind)) : ""}</div>
      <p class="muted"><code data-code-subject>${escapeHtml(item.file)}${item.range ? `:${item.range.startLine}-${item.range.endLine}` : ""}</code></p>
      <p class="muted">${typeof item.cosineSimilarity === "number" ? `cosine ${item.cosineSimilarity.toFixed(3)}` : ""} ${typeof item.lexicalScore === "number" ? `· lexical ${item.lexicalScore.toFixed(3)}` : ""} ${item.fusedRank ? `· fused rank ${item.fusedRank}` : ""}</p>
      ${item.excerpt ? `<prism-code><pre><code>${escapeHtml(item.excerpt)}</code></pre></prism-code>` : ""}
    </li>`).join("")}</ol>` : emptyState("The search returned no candidates")}`;
}

function body(evidence, ctx) {
  const record = evidence.record;
  const truncated = Object.entries(evidence.truncated ?? {});
  const specific = record.kind === "comparison" ? comparison(record, ctx) : record.kind === "snapshot" ? snapshot(record) : record.kind === "search" ? search(record) : "";
  return `<p class="label-caps">${escapeHtml(KIND_LABELS[record.kind] ?? record.kind)}</p>
    <h3 class="item-title evidence-title"><code>${escapeHtml(shortId(evidence.id))}</code></h3>
    ${truncated.length ? `<p class="notice">Long lists show their first ${evidence.arrayLimit} entries: ${truncated.map(([location, count]) => `<code>${escapeHtml(location)}</code> (${count})`).join(", ")}.</p>` : ""}
    ${specific}
    <prism-disclosure class="raw-record" summary="Raw record"${specific ? "" : " open"}>${jsonTreeHtml(record, { openDepth: specific ? 1 : 2, ctx, label: "Raw record" })}</prism-disclosure>`;
}

async function renderTop() {
  const { root, trail, body: target } = drawer();
  const top = stack.at(-1);
  trail.innerHTML = stack.map((entry, index) => `<prism-button variant="ghost" size="sm" data-depth="${index}"${index === stack.length - 1 ? ' aria-current="true" pressed="true"' : ""}>${escapeHtml(entry.label)}</prism-button>`).join('<prism-icon name="chevron-right" size="xs"></prism-icon>');
  target.innerHTML = '<prism-spinner label="Loading evidence"></prism-spinner>';
  if (!root.isOpen) root.show();
  try {
    const evidence = top.evidence ?? (top.evidence = await activeContext.fetchEvidence(top.id));
    if (stack.at(-1) !== top) return;
    target.innerHTML = body(evidence, activeContext);
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

// The drawer is a kit dialog: it opens with the first evidence and keeps a trail of the evidence opened from there until it closes.
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
      // The drawer stands beside the page, so a record opened from it opens behind it and the trail stays.
      openArtifact: (path, options) => activeContext.openArtifact(path, options)
    });
    root.addEventListener("prism-close", () => {
      stack = [];
    });
  }
  activeContext = ctx;
  if (!root.isOpen) {
    stack = [];
  }
  const existing = stack.findIndex((entry) => entry.id === id);
  stack = existing >= 0 ? stack.slice(0, existing + 1) : [...stack, { id, label }];
  void renderTop();
}

export function closeEvidence() {
  const { root } = drawer();
  root.close?.();
  stack = [];
}
