// Generated from src/server/review/public/views/review-ledger.ts by scripts/native-build/compile.mjs.
import { jsonTreeHtml } from "./json-tree.js";
import { bindLinks, emptyState, escapeHtml, evidenceChip, formatSelector, formatTime, keyValues, pathText, plural, recordChip, shortId, status } from "./util.js";
import { hasRuns, runTotalsHtml, runTotalsSummary, runTotalsTableHtml, waveRunTotals } from "./run-totals.js";
const STATUSES = ["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED", "DEFERRED"];
const SEVERITIES = ["blocker", "high", "medium", "low"];
const SEVERITY_WORDS = { blocker: "Blocker", high: "High", medium: "Medium", low: "Low" };
const UNRESOLVED = ["OPEN", "IN PROGRESS", "REOPENED"];
let sequence = 0;
const statusWord = (value) => value.charAt(0) + value.slice(1).toLowerCase();
const severity = (level, glyphOnly = false) => `<prism-severity level="${escapeHtml(level)}"${glyphOnly ? " glyph-only" : ""}></prism-severity>`;
function raisedIn(finding) {
  return finding.history?.[0]?.wave ?? "";
}
function waveStarts(record) {
  const starts = (record.history ?? []).filter((entry) => entry.operation === "start_wave").map((entry) => entry.at);
  return starts.length === (record.waves ?? []).length ? starts : [];
}
function waveCounts(wave, findings) {
  const reached = (value) => findings.filter((finding) => finding.history?.some((entry) => entry.wave === wave.id && entry.status === value)).length;
  return [
    ["raised", findings.filter((finding) => raisedIn(finding) === wave.id).length],
    ["fixed", reached("FIXED")],
    ["verified", reached("VERIFIED")],
    ["reopened", reached("REOPENED")]
  ];
}
function waveItem(wave, index, findings, current, startedAt) {
  const counts = waveCounts(wave, findings).filter(([, count]) => count);
  const raised = findings.some((finding) => raisedIn(finding) === wave.id);
  const lanes = wave.lanes.map((lane) => `<span class="ledger-lane">${escapeHtml(lane.id)}${lane.reviewer === lane.id ? "" : ` <span class="muted">(${escapeHtml(lane.reviewer)})</span>`} ${status(lane.result?.status ?? "pending", { glyphOnly: true })}</span>`).join('<span class="muted">\xB7</span>');
  const compared = wave.comparisonId ? `${evidenceChip(wave.snapshotId, "Snapshot")}${evidenceChip(wave.comparisonId, "Comparison")}${wave.baselineId && wave.baselineId !== wave.snapshotId ? evidenceChip(wave.baselineId, "Baseline") : ""}<prism-chip tip="${escapeHtml(wave.deltaRevision ?? "")}">Delta<span slot="meta">${escapeHtml(shortId(wave.deltaRevision ?? ""))}</span></prism-chip>` : `<prism-chip tip="${escapeHtml(wave.tree ?? "")}">Verified tree<span slot="meta">${escapeHtml(shortId(wave.tree ?? ""))}</span></prism-chip>${wave.base ? `<prism-chip tip="${escapeHtml(wave.base)}">Base<span slot="meta">${escapeHtml(shortId(wave.base))}</span></prism-chip>` : ""}`;
  const state = wave.accepted ? "accepted" : "open";
  return `<li class="ledger-wave${current ? " is-current" : ""}" data-wave="${escapeHtml(wave.id)}">
    <p class="ledger-wave-head">${status(state, { variant: "pill", label: `Wave ${index + 1} ${state}` })}<strong>${escapeHtml(wave.id)}</strong><span class="muted">${[wave.mode === wave.id ? "" : wave.mode, startedAt ? `started ${formatTime(startedAt)}` : "", wave.accepted ? `accepted by ${wave.accepted.actor} ${formatTime(wave.accepted.at)}` : "not accepted"].filter(Boolean).map(escapeHtml).join(" \xB7 ")}</span></p>
    <p class="ledger-wave-line"><span class="muted">Reviewers</span><span class="ledger-lanes">${lanes}</span></p>
    <p class="ledger-wave-line"><span class="muted">Compared</span><span class="chip-row">${compared}</span></p>
    <p class="ledger-wave-line"><span class="muted">Findings</span><span>${counts.map(([label, count]) => `${count} ${label}`).join(" \xB7 ") || "No finding changed in this wave"}</span>${raised ? `<prism-button variant="ghost" size="sm" data-wave-filter="${escapeHtml(wave.id)}">Show the findings it raised</prism-button>` : ""}</p>
    ${runTotalsHtml(wave.runTotals, "wave")}
  </li>`;
}
function findingRow(finding, selected, ctx) {
  const where = finding.status === "DEFERRED" ? [finding.deferral?.gate ? `gate ${escapeHtml(finding.deferral.gate)}` : "no gate recorded", `follow-up ${finding.deferral?.followUp ? escapeHtml(finding.deferral.followUp) : "none recorded"}`] : [escapeHtml(finding.lane), escapeHtml(raisedIn(finding) || finding.mode), finding.affectedPath ? pathText(finding.affectedPath, ctx) : ""];
  return `<prism-list-item value="${escapeHtml(finding.id)}"${selected ? " selected" : ""} data-finding="${escapeHtml(finding.id)}"><span slot="icon">${severity(finding.severity, true)}</span><span class="ledger-finding-id">${escapeHtml(finding.localId)}</span> ${escapeHtml(finding.title)}<span slot="detail">${where.filter(Boolean).join(" \xB7 ")}</span></prism-list-item>`;
}
function grouped(findings) {
  return STATUSES.map((value) => [value, findings.filter((finding) => finding.status === value).sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity))]);
}
const ordered = (findings) => grouped(findings).flatMap(([, rows]) => rows);
function findingList(findings, selected, ctx) {
  const groups = grouped(findings);
  const shown = groups.filter(([, rows]) => rows.length);
  if (!shown.length) return `<div class="ledger-findings">${emptyState("No findings", "No finding matches the filters.")}</div>`;
  const empty = groups.filter(([, rows]) => !rows.length).map(([value]) => statusWord(value).toLowerCase());
  return `<div class="ledger-findings">${shown.map(([value, rows]) => `<h3 class="prism-group-heading ledger-group-head">${status(value)}<span class="prism-group-count">${rows.length}</span></h3>
    <prism-listbox label="${escapeHtml(statusWord(value))} findings" data-findings>${rows.map((finding) => findingRow(finding, finding.id === selected, ctx)).join("")}</prism-listbox>`).join("")}
    ${empty.length ? `<p class="ledger-empty-groups muted">No ${empty.length === 1 ? empty[0] : `${empty.slice(0, -1).join(", ")} or ${empty.at(-1)}`} findings.</p>` : ""}</div>`;
}
function findingDetail(finding, ctx) {
  if (!finding) return emptyState("Choose a finding", "Choose a finding in the list to read its evidence, what closes it, and its history.");
  const repeats = (entry) => entry.status === "DEFERRED" && entry.evidence === finding.deferral?.followUp || entry.evidence === finding.evidence;
  const revisionHtml = (revised) => [
    revised.clause ? `<p class="muted">Contract clause ${revised.clause.from ? `<code>${escapeHtml(revised.clause.from)}</code>` : "none"} \u2192 ${revised.clause.to ? `<code>${escapeHtml(revised.clause.to)}</code>` : "removed"}</p>` : "",
    revised.conditionToClose ? `<p class="muted">Condition to close was: ${escapeHtml(revised.conditionToClose.from)}</p>` : ""
  ].join("");
  const history = finding.history ?? [];
  const steps = history.map((entry, index) => `<prism-step state="${index === history.length - 1 ? "current" : "done"}">${index === 0 && entry.status === "OPEN" ? "Raised" : escapeHtml(statusWord(entry.status))} by ${escapeHtml(entry.actor)}<span slot="detail">Wave ${escapeHtml(entry.wave)} \xB7 ${escapeHtml(formatTime(entry.at))}${entry.revised ? revisionHtml(entry.revised) : ""}${entry.evidence && !repeats(entry) ? `<span class="ledger-step-evidence">${escapeHtml(entry.evidence)}</span>` : ""}</span></prism-step>`).join("");
  const raised = raisedIn(finding);
  return `<article class="ledger-finding" aria-label="Finding ${escapeHtml(finding.localId)}">
    <p class="ledger-finding-meta">${severity(finding.severity)}${status(finding.status, { variant: "pill" })}<span class="ledger-finding-id">${escapeHtml(finding.localId)}</span><span class="muted">${escapeHtml(finding.mode)}</span></p>
    <h3 class="ledger-finding-title">${escapeHtml(finding.title)}</h3>
    ${keyValues([
    ["Raised by", `${escapeHtml(finding.lane)}${raised ? `, wave ${escapeHtml(raised)}` : ""}`],
    ["Where", finding.affectedPath ? pathText(finding.affectedPath, ctx) : null],
    ["Contract clause", finding.clause ? `<code>${escapeHtml(finding.clause)}</code>` : null],
    ["Decision gate", finding.deferral?.gate ? `<code>${escapeHtml(finding.deferral.gate)}</code>` : null],
    ["Follow-up", finding.deferral?.followUp ? escapeHtml(finding.deferral.followUp) : null],
    ["Deferred in", finding.deferral?.wave ? `wave <code>${escapeHtml(finding.deferral.wave)}</code>` : null],
    ["Escalation", finding.escalationTarget && finding.escalationTarget !== "NONE" ? escapeHtml(finding.escalationTarget) : null],
    ["Probe", finding.probe ? `<code>${escapeHtml(finding.probe)}</code>` : null],
    ["Aliases", finding.aliases?.length ? finding.aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(" ") : null],
    ["Record id", `<code>${escapeHtml(finding.id)}</code>`]
  ])}
    <h4 class="ledger-sub">Evidence</h4><p>${escapeHtml(finding.evidence)}</p>
    <h4 class="ledger-sub">Closes when</h4><p>${escapeHtml(finding.conditionToClose)}</p>
    ${finding.implementerEvidence ? `<h4 class="ledger-sub">Implementer evidence</h4><p>${escapeHtml(finding.implementerEvidence)}</p>` : ""}
    ${steps ? `<h4 class="ledger-sub">History</h4><prism-stepper orientation="vertical" label="Status history">${steps}</prism-stepper>` : ""}
  </article>`;
}
function assessmentsTable(assessments, ctx) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Kind</th><th>Wave / lane</th><th>Reason</th><th>Evidence</th><th>Author</th></tr></thead><tbody>${assessments.map((item) => `<tr>
    <td><span class="chip-row"><prism-chip>${escapeHtml(item.kind)}</prism-chip>${item.decision ? `<prism-chip>${escapeHtml(item.decision)}</prism-chip>` : ""}</span></td>
    <td><code>${escapeHtml(item.wave)}</code> / <code>${escapeHtml(item.lane)}</code></td>
    <td>${escapeHtml(item.reason)}</td>
    <td>${(item.evidence ?? []).map((reference) => pathText(reference.path, ctx, formatSelector(reference.selector))).join("<br>")}</td>
    <td>${escapeHtml(item.author)}${item.acceptedBy ? `<br><span class="muted">accepted by ${escapeHtml(item.acceptedBy)}</span>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}
const OPERATIONS_SHOWN = 20;
function operationsList(history) {
  const latest = [...history].reverse();
  const rows = latest.slice(0, OPERATIONS_SHOWN).map((entry) => `<li><time datetime="${escapeHtml(entry.at ?? "")}">${escapeHtml(formatTime(entry.at))}</time><code>${escapeHtml(entry.operation)}</code> <span>by ${escapeHtml(entry.actor)}</span></li>`).join("");
  const rest = latest.length - OPERATIONS_SHOWN;
  return `<ol class="ledger-operations">${rows}${rest > 0 ? `<li class="muted">${plural(rest, "earlier operation")}</li>` : ""}</ol>`;
}
const SEGMENTED_LANES = 3;
function menuFilter(id, label, marker, value, all, values) {
  return `<prism-button id="${id}" size="sm" variant="ghost" class="ledger-menu-filter"><span class="sr-only">${escapeHtml(label)}: </span><span>${escapeHtml(value || all)}</span><prism-icon name="chevron-down" size="xs" aria-hidden="true"></prism-icon></prism-button>
      <prism-menu for="${id}" heading="${escapeHtml(label)}" ${marker}><prism-menu-item type="radio" value=""${value ? "" : " checked"}>${escapeHtml(all)}</prism-menu-item>${values.map((item) => `<prism-menu-item type="radio" value="${escapeHtml(item)}"${value === item ? " checked" : ""}>${escapeHtml(item)}</prism-menu-item>`).join("")}</prism-menu>`;
}
function ledgerHtml(record, artifact, state, ids, ctx) {
  const findings = record.findings ?? [];
  const waves = (record.waves ?? []).map((wave) => ({ ...wave, runTotals: waveRunTotals(artifact.runTotals, wave.id) }));
  const current = waves.at(-1);
  const starts = waveStarts(record);
  const lanes = [...new Set(findings.map((finding) => finding.lane))].sort();
  const raisingWaves = waves.map((wave) => wave.id).filter((id) => findings.some((finding) => raisedIn(finding) === id));
  const shownSeverities = state.severities ?? SEVERITIES;
  const filtered = findings.filter((finding) => (!state.lane || finding.lane === state.lane) && (shownSeverities.includes(finding.severity) || !SEVERITIES.includes(finding.severity)) && (!state.wave || raisedIn(finding) === state.wave));
  const unresolved = findings.filter((finding) => UNRESOLVED.includes(finding.status)).length;
  const blocking = findings.filter((finding) => !["VERIFIED", "DEFERRED"].includes(finding.status) && ["blocker", "high"].includes(finding.severity)).length;
  const deferred = findings.filter((finding) => finding.status === "DEFERRED").length;
  const conflicts = (record.conflicts ?? []).filter((conflict) => !conflict.resolved).length;
  const currentIndex = waves.length - 1;
  const currentState = current?.accepted ? "accepted" : "open";
  const totals = current?.runTotals ?? null;
  const summary = `<div class="ledger-summary" data-ledger-summary>
    ${current ? `<span class="ledger-state">${status(currentState, { variant: "pill", label: `Wave ${currentIndex + 1} ${currentState}` })}<span><strong>${escapeHtml(current.id)}</strong>${starts[currentIndex] ? ` <span class="muted">\xB7 started ${escapeHtml(formatTime(starts[currentIndex]))}</span>` : ""}</span></span>` : '<span class="muted">No review wave has started</span>'}
    <p class="ledger-counts" data-ledger-counts><strong data-count="unresolved">${plural(unresolved, "unresolved finding")}</strong>${blocking ? `<span class="muted">\xB7</span><span class="ledger-count">${severity("blocker", true)}<span data-count="blocking">${blocking} block${blocking === 1 ? "s" : ""} shipping until verified</span></span>` : ""}${deferred ? `<span class="muted">\xB7</span><span data-count="deferred">${deferred} deferred with a follow-up</span>` : ""}${conflicts ? `<span class="muted">\xB7</span><span class="ledger-conflicts" data-count="conflicts">${plural(conflicts, "open conflict")}</span>` : ""}</p>
    ${current?.lanes?.length ? `<span class="ledger-reviewers"><span class="muted">Reviewers</span>${current.lanes.map((lane) => `<prism-chip tip="${escapeHtml(`${lane.reviewer} reviewer, ${lane.result?.status ?? "pending"}`)}"><span slot="start">${status(lane.result?.status ?? "pending", { glyphOnly: true })}</span>${escapeHtml(lane.id)}${lane.reviewer === lane.id ? "" : `<span slot="meta">${escapeHtml(lane.reviewer)}</span>`}</prism-chip>`).join("")}</span>` : ""}
    ${totals && !hasRuns(totals) ? '<span class="ledger-totals muted">No runs yet</span>' : ""}
    ${hasRuns(totals) ? `<prism-button id="${ids.totals}" size="sm" variant="ghost" class="ledger-totals" tip="Run totals of the current wave"><prism-icon name="clock" size="xs" aria-hidden="true"></prism-icon><span>${escapeHtml(runTotalsSummary(totals))}</span><prism-icon name="chevron-down" size="xs" aria-hidden="true"></prism-icon></prism-button>
      <prism-popover class="ledger-totals-popover" for="${ids.totals}" heading="Run totals of ${escapeHtml(current.id)}">${runTotalsTableHtml([{ totals, scope: "wave" }])}</prism-popover>` : ""}
  </div>`;
  const toolbar = findings.length ? `<div class="ledger-toolbar" role="toolbar" aria-label="Filter findings">
    ${lanes.length > 1 ? `<span class="ledger-toolbar-label" aria-hidden="true">Reviewer</span>${lanes.length <= SEGMENTED_LANES ? `<prism-segmented label="Reviewer" value="${escapeHtml(state.lane || "all")}" data-ledger-lane><span value="all">All</span>${lanes.map((lane) => `<span value="${escapeHtml(lane)}">${escapeHtml(lane)}</span>`).join("")}</prism-segmented>` : menuFilter(ids.lanes, "Reviewer", "data-ledger-lanes", state.lane, "All reviewers", lanes)}` : ""}
    <span class="ledger-toolbar-label" aria-hidden="true">Severity</span><span class="chip-row" role="group" aria-label="Severity">${SEVERITIES.map((level) => `<prism-chip interactive pressed="${shownSeverities.includes(level)}" data-ledger-severity="${level}">${SEVERITY_WORDS[level]}</prism-chip>`).join("")}</span>
    ${raisingWaves.length > 1 || state.wave ? `<span class="ledger-toolbar-label" aria-hidden="true">Raised in</span>${menuFilter(ids.waves, "Raised in", "data-ledger-waves", state.wave, "All waves", raisingWaves)}` : ""}
    <span class="ledger-shown muted" aria-live="polite">${filtered.length === findings.length ? plural(findings.length, "finding") : `${filtered.length} of ${plural(findings.length, "finding")}`}</span>
  </div>` : "";
  const shown = ordered(filtered);
  const selected = filtered.some((finding) => finding.id === state.selected) ? state.selected : shown.find((finding) => UNRESOLVED.includes(finding.status))?.id ?? shown[0]?.id ?? null;
  state.selected = selected;
  const split = findings.length ? `<div class="ledger-split">${findingList(filtered, selected, ctx)}<div class="ledger-detail" aria-live="polite" data-detail>${findingDetail(findings.find((finding) => finding.id === selected), ctx)}</div></div>` : emptyState("No findings", "No reviewer has raised a finding.");
  const folds = [
    `<prism-disclosure summary="Waves \xB7 ${waves.length}"${state.wavesOpen ? " open" : ""} data-fold="wavesOpen">${waves.length ? `<ol class="ledger-waves">${waves.map((wave, index) => waveItem(wave, index, findings, wave === current, starts[index])).join("")}</ol>` : '<p class="muted">No review wave has started.</p>'}</prism-disclosure>`,
    `<prism-disclosure summary="Assessments \xB7 ${record.assessments?.length ? record.assessments.length : "none recorded"}" data-fold="assessmentsOpen"${state.assessmentsOpen ? " open" : ""}>${record.assessments?.length ? assessmentsTable(record.assessments, ctx) : '<p class="muted">Reviewers record an assessment when they accept or reject a wave.</p>'}</prism-disclosure>`,
    record.conflicts?.length ? `<prism-disclosure summary="Conflicts \xB7 ${plural(record.conflicts.length, "conflict")}" data-fold="conflictsOpen"${state.conflictsOpen || conflicts ? " open" : ""}><ul class="ledger-conflict-list">${record.conflicts.map((conflict) => `<li><strong>${escapeHtml(conflict.id)}</strong> <span class="muted">${escapeHtml(conflict.lanes.join(" and "))}, wave <code>${escapeHtml(conflict.wave)}</code></span> ${escapeHtml(conflict.reason)} ${status(conflict.resolved ? "done" : "open", { label: conflict.resolved ? `Resolved by ${conflict.resolved.actor}` : "Open" })}</li>`).join("")}</ul></prism-disclosure>` : "",
    record.history?.length ? `<prism-disclosure summary="Operation history \xB7 ${plural(record.history.length, "operation")}" data-fold="historyOpen"${state.historyOpen ? " open" : ""}>${operationsList(record.history)}</prism-disclosure>` : "",
    record.legacy?.length ? `<prism-disclosure summary="Imported legacy findings \xB7 ${plural(record.legacy.length, "file")}" data-fold="legacyOpen"${state.legacyOpen ? " open" : ""}>${jsonTreeHtml(record.legacy, { openDepth: 1, ctx, label: "Imported legacy findings" })}</prism-disclosure>` : "",
    `<prism-disclosure summary="Record details" data-fold="recordOpen"${state.recordOpen ? " open" : ""}>${keyValues([
      ["Change map", record.deltaPath ? recordChip(record.deltaPath, ctx) : null],
      ["Coordinator", escapeHtml(record.coordinator ?? "")],
      ["Delivery", escapeHtml([record.delivery, ...(record.deliveryWorkers ?? []).filter((worker) => worker !== record.delivery)].filter(Boolean).join(", "))],
      ["Exchange workers", record.exchangeWorkers?.length ? escapeHtml(record.exchangeWorkers.join(", ")) : null],
      ["Baseline", record.baselineId ? evidenceChip(record.baselineId, "Snapshot") : null],
      ["Raw record", artifact.path ? recordChip(artifact.path, ctx) : null]
    ])}</prism-disclosure>`
  ].filter(Boolean).join("");
  return `<div class="review-ledger">${summary}${toolbar}${split}<div class="ledger-more">${folds}</div></div>`;
}
function mountLedger(container, artifact, ctx, state = {}) {
  const record = artifact.data ?? {};
  const findings = record.findings ?? [];
  sequence += 1;
  const ids = { totals: `ledger-totals-${sequence}`, waves: `ledger-waves-${sequence}`, lanes: `ledger-lanes-${sequence}` };
  const draw = (focus = null) => {
    container.innerHTML = ledgerHtml(record, artifact, state, ids, ctx);
    if (typeof container.querySelectorAll !== "function") return;
    bindLinks(container, ctx);
    if (focus) container.querySelector(focus)?.focus?.();
  };
  const choose = (id) => {
    state.selected = id;
    for (const item of container.querySelectorAll("[data-finding]")) item.toggleAttribute("selected", item.dataset.finding === id);
    const detail = container.querySelector("[data-detail]");
    if (detail) {
      detail.innerHTML = findingDetail(findings.find((finding) => finding.id === id), ctx);
      bindLinks(detail, ctx);
    }
  };
  draw();
  if (typeof container.addEventListener !== "function" || container.dataset.ledgerBound) return;
  container.dataset.ledgerBound = "true";
  container.addEventListener("prism-select", (event) => {
    const listbox = event.target.closest?.("[data-findings]");
    if (listbox && event.detail?.value) {
      choose(event.detail.value);
      return;
    }
    if (event.target.closest?.("[data-ledger-waves]")) {
      state.wave = event.detail?.value ?? "";
      draw(`#${ids.waves}`);
    }
    if (event.target.closest?.("[data-ledger-lanes]")) {
      state.lane = event.detail?.value ?? "";
      draw(`#${ids.lanes}`);
    }
  });
  container.addEventListener("change", (event) => {
    if (!event.target.closest?.("[data-ledger-lane]")) return;
    const value = event.detail?.value ?? event.target.value;
    state.lane = value === "all" ? "" : value;
    draw("[data-ledger-lane]");
  });
  container.addEventListener("click", (event) => {
    const chip = event.target.closest?.("[data-ledger-severity]");
    if (chip) {
      const level = chip.dataset.ledgerSeverity;
      const shown = state.severities ?? SEVERITIES;
      const next = shown.includes(level) ? shown.filter((item) => item !== level) : SEVERITIES.filter((item) => shown.includes(item) || item === level);
      state.severities = next.length === SEVERITIES.length ? null : next;
      draw(`[data-ledger-severity="${level}"]`);
      return;
    }
    const waveFilter = event.target.closest?.("[data-wave-filter]");
    if (waveFilter) {
      state.wave = waveFilter.dataset.waveFilter;
      draw(`#${ids.waves}`);
    }
  });
  container.addEventListener("toggle", (event) => {
    const fold = event.target.closest?.("[data-fold]");
    if (fold) state[fold.dataset.fold] = fold.hasAttribute("open");
  }, true);
}
function render(container, artifact, ctx) {
  mountLedger(container, artifact, ctx, ctx.state);
}
export {
  mountLedger,
  render
};
