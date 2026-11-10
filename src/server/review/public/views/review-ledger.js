import { jsonTreeHtml } from "./json-tree.js";
import { badge, bindLinks, card, chip, emptyState, escapeHtml, evidenceChip, formatSelector, formatTime, keyValues, pathText, plural, recordChip, shortId, stat, summaryPanel } from "./util.js";
import { runTotalsHtml, waveRunTotals } from "./run-totals.js";

const STATUSES = ["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED"];
const SEVERITIES = ["blocker", "high", "medium", "low"];

function token(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

const STATUS_TONES = { OPEN: "danger", "IN PROGRESS": "info", REOPENED: "warning", FIXED: "accent", VERIFIED: "success" };
const SEVERITY_TONES = { blocker: "danger", high: "warning", medium: "info", low: "neutral" };
const RESULT_TONES = { clean: "success", passed: "success", pass: "success", findings: "warning", failed: "danger", fail: "danger", pending: "neutral" };

function statusBadge(status) {
  return badge(status, STATUS_TONES[status] ?? "neutral");
}

function severityBadge(severity) {
  return badge(severity, SEVERITY_TONES[severity] ?? "neutral");
}

function raisedIn(finding) {
  return finding.history?.[0]?.wave ?? "";
}

// Review history logs each start_wave in order, so the nth entry dates the nth wave when nothing is missing.
function waveStarts(record) {
  const starts = (record.history ?? []).filter((entry) => entry.operation === "start_wave").map((entry) => entry.at);
  return starts.length === (record.waves ?? []).length ? starts : [];
}

function waveCounts(wave, findings) {
  const reached = (status) => findings.filter((finding) => finding.history?.some((entry) => entry.wave === wave.id && entry.status === status)).length;
  return [
    ["raised", findings.filter((finding) => raisedIn(finding) === wave.id).length],
    ["fixed", reached("FIXED")],
    ["verified", reached("VERIFIED")],
    ["reopened", reached("REOPENED")]
  ];
}

function waveCard(wave, index, findings, current, startedAt) {
  const counts = waveCounts(wave, findings);
  const raised = counts[0][1];
  const lanes = wave.lanes.map((lane) => `<li>
    <span class="lane-name">${escapeHtml(lane.id)}</span>
    <span class="muted">${escapeHtml(lane.reviewer)}</span>
    ${lane.result ? badge(lane.result.status, RESULT_TONES[token(lane.result.status)] ?? "neutral") : badge("pending")}
  </li>`).join("");
  return `<li class="wave${wave.accepted ? " is-accepted" : ""}${current ? " is-current" : ""}">
    <span class="wave-marker" aria-hidden="true">${index + 1}</span>
    <div class="wave-body">
      <div class="wave-head"><strong>${escapeHtml(wave.id)}</strong><span class="muted">${escapeHtml(wave.mode)}</span>${current ? badge("current", "info") : ""}</div>
      ${startedAt ? `<p class="muted">Started ${escapeHtml(formatTime(startedAt))}</p>` : ""}
      <p class="muted">${wave.accepted ? `Accepted by <strong>${escapeHtml(wave.accepted.actor)}</strong> · ${escapeHtml(formatTime(wave.accepted.at))}` : "Not accepted"}</p>
      <ul class="lane-list">${lanes}</ul>
      ${runTotalsHtml(wave.runTotals, "wave")}
      <div class="chip-row">
        ${wave.comparisonId ? `${evidenceChip(wave.snapshotId, "Snapshot")}
        ${evidenceChip(wave.comparisonId, "Comparison")}
        ${wave.baselineId && wave.baselineId !== wave.snapshotId ? evidenceChip(wave.baselineId, "Baseline") : ""}
        ${chip(`delta ${escapeHtml(shortId(wave.deltaRevision))}`, { tip: wave.deltaRevision })}` : `${chip(`verified tree ${escapeHtml(shortId(wave.tree ?? ""))}`, { tip: wave.tree ?? "" })}${wave.base ? chip(`base ${escapeHtml(shortId(wave.base))}`, { tip: wave.base }) : ""}`}
      </div>
      <p class="wave-findings">${counts.filter(([, count]) => count).map(([label, count]) => `<span class="wave-count"><strong>${count}</strong> ${label}</span>`).join("") || "No finding changed in this wave"}
        ${raised ? `<prism-button variant="ghost" size="sm" data-wave-filter="${escapeHtml(wave.id)}">Show raised findings</prism-button>` : ""}</p>
    </div>
  </li>`;
}

function findingCard(finding, selected, ctx) {
  return `<li class="finding-item${selected ? " is-selected" : ""}" data-finding-item="${escapeHtml(finding.id)}">
    <span class="finding-head">${severityBadge(finding.severity)}<code>${escapeHtml(finding.localId)}</code></span>
    <a class="title-link finding-link" href="#finding-${escapeHtml(finding.localId)}" data-finding="${escapeHtml(finding.id)}"${selected ? ' aria-current="true"' : ""}>${escapeHtml(finding.title)}</a>
    <span class="finding-meta muted">${escapeHtml(finding.lane)} · ${escapeHtml(raisedIn(finding) || finding.mode)}</span>
    ${finding.affectedPath ? `<span class="finding-path">${pathText(finding.affectedPath, ctx)}</span>` : ""}
  </li>`;
}

function findingDetail(finding, ctx) {
  if (!finding) {
    return emptyState("Select a finding", "Choose a finding on the board to read its evidence, close condition, and status history.");
  }
  const history = [...(finding.history ?? [])].reverse();
  // A revision names each changed field with its old and new value, and its entry's evidence is the reason.
  const revisionHtml = (revised) => [
    revised.clause ? `<p class="muted">Contract clause ${revised.clause.from ? `<code>${escapeHtml(revised.clause.from)}</code>` : "none"} → ${revised.clause.to ? `<code>${escapeHtml(revised.clause.to)}</code>` : "removed"}</p>` : "",
    revised.conditionToClose ? `<p class="muted">Condition to close was: ${escapeHtml(revised.conditionToClose.from)}</p>` : ""
  ].join("");
  return `<p class="label-caps">Finding · ${escapeHtml(finding.mode)}</p>
    <h3 class="item-title">${escapeHtml(finding.title)}</h3>
    <p class="chip-row">${severityBadge(finding.severity)}${statusBadge(finding.status)}<code>${escapeHtml(finding.id)}</code></p>
    ${keyValues([
      ["Raised in", raisedIn(finding) ? `wave <code>${escapeHtml(raisedIn(finding))}</code>` : null],
      ["Affected path", finding.affectedPath ? pathText(finding.affectedPath, ctx) : null],
      ["Escalation", finding.escalationTarget ? escapeHtml(finding.escalationTarget) : null],
      ["Contract clause", finding.clause ? `<code>${escapeHtml(finding.clause)}</code>` : null],
      ["Probe", finding.probe ? `<code>${escapeHtml(finding.probe)}</code>` : null],
      ["Aliases", finding.aliases?.length ? finding.aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(" ") : null]
    ])}
    <div class="detail-block"><p class="label-caps">Evidence</p><p>${escapeHtml(finding.evidence)}</p></div>
    <div class="detail-block"><p class="label-caps">Condition to close</p><p>${escapeHtml(finding.conditionToClose)}</p></div>
    ${finding.implementerEvidence ? `<div class="detail-block"><p class="label-caps">Implementer evidence</p><p>${escapeHtml(finding.implementerEvidence)}</p></div>` : ""}
    <div class="detail-block"><p class="label-caps">History</p><ol class="timeline">${history.map((entry) => `<li>
      <div class="timeline-head">${statusBadge(entry.status)}<span>${escapeHtml(entry.actor)}</span><span class="muted">${escapeHtml(formatTime(entry.at))}</span></div>
      <p class="muted">wave <code>${escapeHtml(entry.wave)}</code></p>
      ${entry.revised ? revisionHtml(entry.revised) : ""}
      ${entry.evidence ? `<p>${escapeHtml(entry.evidence)}</p>` : ""}
    </li>`).join("")}</ol></div>`;
}

function assessmentsTable(assessments, ctx) {
  if (!assessments.length) {
    return emptyState("No assessments recorded");
  }
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Kind</th><th>Wave / lane</th><th>Reason</th><th>Evidence</th><th>Author</th></tr></thead><tbody>${assessments.map((item) => `<tr>
    <td><span class="chip-row">${chip(escapeHtml(item.kind))}${item.decision ? chip(escapeHtml(item.decision)) : ""}</span></td>
    <td><code>${escapeHtml(item.wave)}</code> / <code>${escapeHtml(item.lane)}</code></td>
    <td>${escapeHtml(item.reason)}</td>
    <td>${(item.evidence ?? []).map((reference) => pathText(reference.path, ctx, formatSelector(reference.selector))).join("<br>")}</td>
    <td>${escapeHtml(item.author)}${item.acceptedBy ? `<br><span class="muted">accepted by ${escapeHtml(item.acceptedBy)}</span>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

export function render(container, data, ctx) {
  const record = data.data;
  const state = ctx.state;
  const findings = record.findings ?? [];
  const waves = (record.waves ?? []).map((wave) => ({ ...wave, runTotals: waveRunTotals(data.runTotals, wave.id) }));
  const currentWave = waves.at(-1);
  state.lane ??= "";
  state.severity ??= "";
  state.wave ??= "";
  const starts = waveStarts(record);
  const raisingWaves = waves.map((wave) => wave.id).filter((id) => findings.some((finding) => raisedIn(finding) === id));
  const lanes = [...new Set(findings.map((finding) => finding.lane))].sort();
  const filtered = findings.filter((finding) => (!state.lane || finding.lane === state.lane) && (!state.severity || finding.severity === state.severity) && (!state.wave || raisedIn(finding) === state.wave));
  const openCount = findings.filter((finding) => ["OPEN", "IN PROGRESS", "REOPENED"].includes(finding.status)).length;
  const blocking = findings.filter((finding) => finding.status !== "VERIFIED" && ["blocker", "high"].includes(finding.severity)).length;
  const unresolvedConflicts = (record.conflicts ?? []).filter((conflict) => !conflict.resolved).length;

  const select = (name, label, options, value) => `<prism-field type="select" class="ledger-filter" label="${escapeHtml(label)}" data-filter="${name}">${options.map(([option, text]) => `<prism-option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(text)}</prism-option>`).join("")}</prism-field>`;
  container.innerHTML = `
    ${summaryPanel(`
      <div class="stat-grid">
        ${stat(waves.length === 1 ? "wave" : "waves", String(waves.length))}
        ${stat("unresolved findings", String(openCount))}
        ${stat("blocker / high not verified", String(blocking), { tone: blocking ? "danger" : "" })}
        ${stat(currentWave ? `current wave ${currentWave.id}` : "current wave", currentWave ? (currentWave.accepted ? "Accepted" : "Open") : "—", { tone: currentWave?.accepted ? "success" : "warning" })}
        ${unresolvedConflicts ? stat("open conflicts", String(unresolvedConflicts), { tone: "danger" }) : ""}
      </div>
      ${keyValues([
        ["Change map", record.deltaPath ? recordChip(record.deltaPath, ctx) : null],
        ["Coordinator", escapeHtml(record.coordinator)],
        ["Delivery", escapeHtml([record.delivery, ...(record.deliveryWorkers ?? []).filter((worker) => worker !== record.delivery)].join(", "))],
        ["Exchange workers", record.exchangeWorkers?.length ? escapeHtml(record.exchangeWorkers.join(", ")) : null],
        ["Baseline", evidenceChip(record.baselineId, "Snapshot")]
      ])}`)}
    ${card("Waves", waves.length ? `<ol class="wave-timeline">${waves.map((wave, index) => waveCard(wave, index, findings, wave === currentWave, starts[index])).join("")}</ol>` : emptyState("No review wave has started"), { eyebrow: "Timeline" })}
    <div class="split-layout">
      <prism-panel class="view-section ledger-board" heading="${escapeHtml(plural(filtered.length, "finding"))}" eyebrow="Findings board">
        <div class="view-controls ledger-filters">
          ${select("lane", "Lane", [["", "All"], ...lanes.map((lane) => [lane, lane])], state.lane)}
          ${select("wave", "Raised in", [["", "All waves"], ...raisingWaves.map((id) => [id, id])], state.wave)}
          ${select("severity", "Severity", [["", "All"], ...SEVERITIES.map((severity) => [severity, severity])], state.severity)}
        </div>
        <div class="board">${STATUSES.map((status) => {
          const column = filtered.filter((finding) => finding.status === status).sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity));
          return `<div class="board-column"><h4 class="board-column-head">${statusBadge(status)}<prism-badge variant="count">${column.length}</prism-badge></h4><ul class="finding-list">${column.map((finding) => findingCard(finding, finding.id === state.selected, ctx)).join("") || '<li class="column-none muted">—</li>'}</ul></div>`;
        }).join("")}</div>
      </prism-panel>
      <prism-panel class="view-section ledger-detail" heading="Details"><div class="ledger-detail-body" aria-live="polite" data-detail></div></prism-panel>
    </div>
    ${card("Assessments", assessmentsTable(record.assessments ?? [], ctx), { eyebrow: "Reviewer judgements" })}
    ${record.conflicts?.length ? card("Conflicts", `<ul class="row-list">${record.conflicts.map((conflict) => `<li><strong>${escapeHtml(conflict.id)}</strong> (${escapeHtml(conflict.lanes.join(" vs "))}, wave <code>${escapeHtml(conflict.wave)}</code>) — ${escapeHtml(conflict.reason)} ${conflict.resolved ? badge(`resolved by ${conflict.resolved.actor}`, "success") : badge("open", "danger")}</li>`).join("")}</ul>`, { eyebrow: "Lane disagreements" }) : ""}
    ${record.history?.length ? `<prism-panel class="view-section"><prism-disclosure summary="Operation history · ${plural(record.history.length, "operation")}"><ol class="timeline">${[...record.history].reverse().map((entry) => `<li><div class="timeline-head"><code>${escapeHtml(entry.operation)}</code><span>${escapeHtml(entry.actor)}</span><span class="muted">${escapeHtml(formatTime(entry.at))}</span></div></li>`).join("")}</ol></prism-disclosure></prism-panel>` : ""}
    ${record.legacy?.length ? `<prism-panel class="view-section"><prism-disclosure summary="Imported legacy findings · ${plural(record.legacy.length, "file")}">${jsonTreeHtml(record.legacy, { openDepth: 1, ctx, label: "Imported legacy findings" })}</prism-disclosure></prism-panel>` : ""}`;

  const detail = container.querySelector("[data-detail]");
  const choose = (id) => {
    state.selected = id;
    for (const item of container.querySelectorAll("[data-finding-item]")) {
      const selected = item.dataset.findingItem === id;
      item.classList.toggle("is-selected", selected);
      const link = item.querySelector("[data-finding]");
      if (selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    detail.innerHTML = findingDetail(findings.find((finding) => finding.id === id), ctx);
  };
  choose(state.selected);
  container.addEventListener("click", (event) => {
    const waveFilter = event.target.closest("[data-wave-filter]");
    if (waveFilter) {
      state.wave = waveFilter.dataset.waveFilter;
      ctx.rerender();
      return;
    }
    const link = event.target.closest("[data-finding]");
    if (link) {
      event.preventDefault();
      choose(link.dataset.finding);
    }
  });
  for (const filter of container.querySelectorAll("[data-filter]")) {
    filter.addEventListener("change", () => {
      state[filter.dataset.filter] = filter.value;
      ctx.rerender();
    });
  }
  bindLinks(container, ctx);
}
