import { jsonTreeHtml } from "./json-tree.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, evidenceChip, formatReference, formatTime, keyValues, plural, shortId } from "./util.js";

const STATUSES = ["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED"];
const SEVERITIES = ["blocker", "high", "medium", "low"];

function token(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function statusBadge(status) {
  return `<span class="finding-status status-${token(status)}">${escapeHtml(status)}</span>`;
}

function severityBadge(severity) {
  return `<span class="severity severity-${token(severity)}">${escapeHtml(severity)}</span>`;
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
    <span class="lane-reviewer">${escapeHtml(lane.reviewer)}</span>
    ${lane.result ? `<span class="lane-result result-${token(lane.result.status)}">${escapeHtml(lane.result.status)}</span>` : '<span class="lane-result result-pending">pending</span>'}
  </li>`).join("");
  return `<li class="wave ${wave.accepted ? "is-accepted" : ""} ${current ? "is-current" : ""}">
    <div class="wave-marker" aria-hidden="true">${index + 1}</div>
    <div class="wave-body">
      <div class="wave-head"><strong>${escapeHtml(wave.id)}</strong><span class="wave-mode">${escapeHtml(wave.mode)}</span>${current ? '<span class="status-pill is-info">current</span>' : ""}</div>
      ${startedAt ? `<p class="wave-started">Started ${escapeHtml(formatTime(startedAt))}</p>` : ""}
      <p class="wave-accepted">${wave.accepted ? `Accepted by <strong>${escapeHtml(wave.accepted.actor)}</strong> · ${escapeHtml(formatTime(wave.accepted.at))}` : "Not accepted"}</p>
      <ul class="lane-list">${lanes}</ul>
      <div class="wave-evidence">
        ${evidenceChip(wave.snapshotId, "Snapshot")}
        ${evidenceChip(wave.comparisonId, "Comparison")}
        ${wave.baselineId && wave.baselineId !== wave.snapshotId ? evidenceChip(wave.baselineId, "Baseline") : ""}
        <span class="meta-pill" title="${escapeHtml(wave.deltaRevision)}">delta ${escapeHtml(shortId(wave.deltaRevision))}</span>
      </div>
      <p class="wave-findings">${counts.filter(([, count]) => count).map(([label, count]) => `<span class="wave-count"><strong>${count}</strong> ${label}</span>`).join("") || "No finding changed in this wave"}
        ${raised ? `<button type="button" class="text-button wave-filter" data-wave-filter="${escapeHtml(wave.id)}">Show raised findings</button>` : ""}</p>
    </div>
  </li>`;
}

function findingCard(finding, selected) {
  return `<li><button type="button" class="finding-card ${selected ? "is-selected" : ""}" data-finding="${escapeHtml(finding.id)}">
    <span class="finding-card-head">${severityBadge(finding.severity)}<code>${escapeHtml(finding.localId)}</code></span>
    <strong>${escapeHtml(finding.title)}</strong>
    <span class="finding-card-meta">${escapeHtml(finding.lane)} · ${escapeHtml(raisedIn(finding) || finding.mode)}</span>
    ${finding.affectedPath ? `<span class="finding-card-path"><code>${escapeHtml(finding.affectedPath)}</code></span>` : ""}
  </button></li>`;
}

function findingDetail(finding) {
  if (!finding) {
    return `<p class="eyebrow">Details</p><h2>Select a finding</h2><p class="empty-note">Click a finding card to read its evidence, close condition, and status history.</p>`;
  }
  const history = [...(finding.history ?? [])].reverse();
  return `<p class="eyebrow">Finding · ${escapeHtml(finding.mode)}</p>
    <h2>${escapeHtml(finding.title)}</h2>
    <p class="detail-meta">${severityBadge(finding.severity)} ${statusBadge(finding.status)} <code>${escapeHtml(finding.id)}</code></p>
    ${keyValues([
      ["Raised in", raisedIn(finding) ? `wave <code>${escapeHtml(raisedIn(finding))}</code>` : null],
      ["Affected path", finding.affectedPath ? `<code>${escapeHtml(finding.affectedPath)}</code>` : null],
      ["Escalation", finding.escalationTarget ? escapeHtml(finding.escalationTarget) : null],
      ["Probe", finding.probe ? `<code>${escapeHtml(finding.probe)}</code>` : null],
      ["Aliases", finding.aliases?.length ? finding.aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(" ") : null]
    ])}
    <div class="detail-block"><h3>Evidence</h3><p>${escapeHtml(finding.evidence)}</p></div>
    <div class="detail-block"><h3>Condition to close</h3><p>${escapeHtml(finding.conditionToClose)}</p></div>
    ${finding.implementerEvidence ? `<div class="detail-block"><h3>Implementer evidence</h3><p>${escapeHtml(finding.implementerEvidence)}</p></div>` : ""}
    <div class="detail-block"><h3>History</h3><ol class="timeline">${history.map((entry) => `<li>
      <div class="timeline-head">${statusBadge(entry.status)}<span>${escapeHtml(entry.actor)}</span><span class="timeline-time">${escapeHtml(formatTime(entry.at))}</span></div>
      <p class="timeline-sub">wave <code>${escapeHtml(entry.wave)}</code></p>
      ${entry.evidence ? `<p>${escapeHtml(entry.evidence)}</p>` : ""}
    </li>`).join("")}</ol></div>`;
}

function assessmentsTable(assessments) {
  if (!assessments.length) {
    return emptyNote("No assessments recorded.");
  }
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Kind</th><th>Wave / lane</th><th>Reason</th><th>Evidence</th><th>Author</th></tr></thead><tbody>${assessments.map((item) => `<tr>
    <td><span class="meta-pill">${escapeHtml(item.kind)}</span>${item.decision ? ` <span class="meta-pill">${escapeHtml(item.decision)}</span>` : ""}</td>
    <td><code>${escapeHtml(item.wave)}</code> / <code>${escapeHtml(item.lane)}</code></td>
    <td>${escapeHtml(item.reason)}</td>
    <td>${(item.evidence ?? []).map((reference) => `<code>${escapeHtml(formatReference(reference))}</code>`).join("<br>")}</td>
    <td>${escapeHtml(item.author)}${item.acceptedBy ? `<br><span class="muted">accepted by ${escapeHtml(item.acceptedBy)}</span>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

export function render(container, data, ctx) {
  const record = data.data;
  const state = ctx.state;
  const findings = record.findings ?? [];
  const waves = record.waves ?? [];
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

  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="stat-row">
        <div class="stat"><span class="stat-value">${waves.length}</span><span class="stat-label">${waves.length === 1 ? "wave" : "waves"}</span></div>
        <div class="stat"><span class="stat-value">${openCount}</span><span class="stat-label">unresolved findings</span></div>
        <div class="stat ${blocking ? "is-bad" : ""}"><span class="stat-value">${blocking}</span><span class="stat-label">blocker / high not verified</span></div>
        <div class="stat ${currentWave?.accepted ? "is-good" : "is-warn"}"><span class="stat-value">${currentWave ? (currentWave.accepted ? "Accepted" : "Open") : "—"}</span><span class="stat-label">current wave${currentWave ? ` <code>${escapeHtml(currentWave.id)}</code>` : ""}</span></div>
        ${unresolvedConflicts ? `<div class="stat is-bad"><span class="stat-value">${unresolvedConflicts}</span><span class="stat-label">open conflicts</span></div>` : ""}
      </div>
      ${keyValues([
        ["Concept delta", artifactChip(record.deltaPath, ctx)],
        ["Coordinator", escapeHtml(record.coordinator)],
        ["Delivery", escapeHtml([record.delivery, ...(record.deliveryWorkers ?? []).filter((worker) => worker !== record.delivery)].join(", "))],
        ["Exchange workers", record.exchangeWorkers?.length ? escapeHtml(record.exchangeWorkers.join(", ")) : null],
        ["Baseline", evidenceChip(record.baselineId, "Snapshot")]
      ])}
    </section>
    ${card("Waves", waves.length ? `<ol class="wave-timeline">${waves.map((wave, index) => waveCard(wave, index, findings, wave === currentWave, starts[index])).join("")}</ol>` : emptyNote("No review wave has started."), { eyebrow: "Timeline" })}
    <div class="split-layout">
      <section class="view-card split-main">
        <header class="view-card-header board-header">
          <div><p class="eyebrow">Findings board</p><h2>${plural(filtered.length, "finding")}</h2></div>
          <div class="board-filters">
            <label>Lane <select data-filter="lane"><option value="">All</option>${lanes.map((lane) => `<option value="${escapeHtml(lane)}"${lane === state.lane ? " selected" : ""}>${escapeHtml(lane)}</option>`).join("")}</select></label>
            <label>Raised in <select data-filter="wave"><option value="">All waves</option>${raisingWaves.map((id) => `<option value="${escapeHtml(id)}"${id === state.wave ? " selected" : ""}>${escapeHtml(id)}</option>`).join("")}</select></label>
            <label>Severity <select data-filter="severity"><option value="">All</option>${SEVERITIES.map((severity) => `<option value="${severity}"${severity === state.severity ? " selected" : ""}>${severity}</option>`).join("")}</select></label>
          </div>
        </header>
        <div class="board">${STATUSES.map((status) => {
          const column = filtered.filter((finding) => finding.status === status).sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity));
          return `<div class="board-column column-${token(status)}"><h3>${statusBadge(status)}<span class="column-count">${column.length}</span></h3><ul>${column.map((finding) => findingCard(finding, finding.id === state.selected)).join("") || '<li class="column-empty">—</li>'}</ul></div>`;
        }).join("")}</div>
      </section>
      <aside class="view-card detail-panel" aria-live="polite" data-detail></aside>
    </div>
    ${card("Assessments", assessmentsTable(record.assessments ?? []), { eyebrow: "Reviewer judgements" })}
    ${record.conflicts?.length ? card("Conflicts", `<ul class="plain-list">${record.conflicts.map((conflict) => `<li><strong>${escapeHtml(conflict.id)}</strong> (${escapeHtml(conflict.lanes.join(" vs "))}, wave <code>${escapeHtml(conflict.wave)}</code>) — ${escapeHtml(conflict.reason)} ${conflict.resolved ? `<span class="status-pill is-good">resolved by ${escapeHtml(conflict.resolved.actor)}</span>` : '<span class="status-pill is-bad">open</span>'}</li>`).join("")}</ul>`, { eyebrow: "Lane disagreements" }) : ""}
    ${record.history?.length ? `<details class="view-card history-card"><summary><span class="eyebrow">Operation history</span> ${plural(record.history.length, "operation")}</summary><ol class="timeline">${[...record.history].reverse().map((entry) => `<li><div class="timeline-head"><code>${escapeHtml(entry.operation)}</code><span>${escapeHtml(entry.actor)}</span><span class="timeline-time">${escapeHtml(formatTime(entry.at))}</span></div></li>`).join("")}</ol></details>` : ""}
    ${record.legacy?.length ? `<details class="view-card history-card"><summary><span class="eyebrow">Imported legacy findings</span> ${plural(record.legacy.length, "file")}</summary>${jsonTreeHtml(record.legacy, { openDepth: 1 })}</details>` : ""}`;

  const detail = container.querySelector("[data-detail]");
  const select = (id) => {
    state.selected = id;
    for (const element of container.querySelectorAll(".finding-card")) {
      element.classList.toggle("is-selected", element.dataset.finding === id);
    }
    detail.innerHTML = findingDetail(findings.find((finding) => finding.id === id));
  };
  select(state.selected);
  container.addEventListener("click", (event) => {
    const waveFilter = event.target.closest("[data-wave-filter]");
    if (waveFilter) {
      state.wave = waveFilter.dataset.waveFilter;
      ctx.rerender();
      return;
    }
    const button = event.target.closest("[data-finding]");
    if (button) {
      select(button.dataset.finding);
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
