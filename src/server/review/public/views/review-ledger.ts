// The review ledger of a slice: one summary line, a filter toolbar, the findings grouped by status beside the chosen finding, and the waves, assessments, history, and record details below.
// The slice page's Review tab and the review record's own page both show it.
import { jsonTreeHtml } from "./json-tree.js";
import { bindLinks, emptyState, escapeHtml, evidenceChip, formatSelector, formatTime, keyValues, pathText, plural, recordChip, shortId, status } from "./util.js";
import { hasRuns, runTotalsHtml, runTotalsSummary, runTotalsTableHtml, waveRunTotals } from "./run-totals.js";

// The statuses in the order work moves through them; each one with findings is a group of the list.
const STATUSES = ["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED", "DEFERRED"];
const SEVERITIES = ["blocker", "high", "medium", "low"];
const SEVERITY_WORDS: Record<string, any> = { blocker: "Blocker", high: "High", medium: "Medium", low: "Low" };
const UNRESOLVED = ["OPEN", "IN PROGRESS", "REOPENED"];

let sequence = 0;

const statusWord = (value: any) => value.charAt(0) + value.slice(1).toLowerCase();
const severity = (level: any, glyphOnly = false) => `<prism-severity level="${escapeHtml(level)}"${glyphOnly ? " glyph-only" : ""}></prism-severity>`;

function raisedIn(finding: any) {
  return finding.history?.[0]?.wave ?? "";
}

// Review history logs each start_wave in order, so the nth entry dates the nth wave when nothing is missing.
function waveStarts(record: any) {
  const starts = (record.history ?? []).filter((entry: any) => entry.operation === "start_wave").map((entry: any) => entry.at);
  return starts.length === (record.waves ?? []).length ? starts : [];
}

function waveCounts(wave: any, findings: any) {
  const reached = (value: any) => findings.filter((finding: any) => finding.history?.some((entry: any) => entry.wave === wave.id && entry.status === value)).length;
  return [
    ["raised", findings.filter((finding: any) => raisedIn(finding) === wave.id).length],
    ["fixed", reached("FIXED")],
    ["verified", reached("VERIFIED")],
    ["reopened", reached("REOPENED")]
  ];
}

// A wave in one or two lines: its state, mode, and start, its reviewers, what it compared, its findings, and its run totals.
function waveItem(wave: any, index: number, findings: any, current: any, startedAt: any) {
  const counts = waveCounts(wave, findings).filter(([, count]) => count);
  const raised = findings.some((finding: any) => raisedIn(finding) === wave.id);
  const lanes = wave.lanes.map((lane: any) => `<span class="ledger-lane">${escapeHtml(lane.id)}${lane.reviewer === lane.id ? "" : ` <span class="muted">(${escapeHtml(lane.reviewer)})</span>`} ${status(lane.result?.status ?? "pending", { glyphOnly: true })}</span>`).join('<span class="muted">·</span>');
  const compared = wave.comparisonId
    ? `${evidenceChip(wave.snapshotId, "Snapshot")}${evidenceChip(wave.comparisonId, "Comparison")}${wave.baselineId && wave.baselineId !== wave.snapshotId ? evidenceChip(wave.baselineId, "Baseline") : ""}<prism-chip tip="${escapeHtml(wave.deltaRevision ?? "")}">Delta<span slot="meta">${escapeHtml(shortId(wave.deltaRevision ?? ""))}</span></prism-chip>`
    : `<prism-chip tip="${escapeHtml(wave.tree ?? "")}">Verified tree<span slot="meta">${escapeHtml(shortId(wave.tree ?? ""))}</span></prism-chip>${wave.base ? `<prism-chip tip="${escapeHtml(wave.base)}">Base<span slot="meta">${escapeHtml(shortId(wave.base))}</span></prism-chip>` : ""}`;
  const state = wave.accepted ? "accepted" : "open";
  return `<li class="ledger-wave${current ? " is-current" : ""}" data-wave="${escapeHtml(wave.id)}">
    <p class="ledger-wave-head">${status(state, { variant: "pill", label: `Wave ${index + 1} ${state}` })}<strong>${escapeHtml(wave.id)}</strong><span class="muted">${[wave.mode === wave.id ? "" : wave.mode, startedAt ? `started ${formatTime(startedAt)}` : "", wave.accepted ? `accepted by ${wave.accepted.actor} ${formatTime(wave.accepted.at)}` : "not accepted"].filter(Boolean).map(escapeHtml).join(" · ")}</span></p>
    <p class="ledger-wave-line"><span class="muted">Reviewers</span><span class="ledger-lanes">${lanes}</span></p>
    <p class="ledger-wave-line"><span class="muted">Compared</span><span class="chip-row">${compared}</span></p>
    <p class="ledger-wave-line"><span class="muted">Findings</span><span>${counts.map(([label, count]) => `${count} ${label}`).join(" · ") || "No finding changed in this wave"}</span>${raised ? `<prism-button variant="ghost" size="sm" data-wave-filter="${escapeHtml(wave.id)}">Show the findings it raised</prism-button>` : ""}</p>
    ${runTotalsHtml(wave.runTotals, "wave")}
  </li>`;
}

// One row of the list: the severity's bars, the finding's id and title, and where it came from, or a deferred finding's gate and follow-up.
function findingRow(finding: any, selected: any, ctx: any) {
  const where = finding.status === "DEFERRED"
    ? [finding.deferral?.gate ? `gate ${escapeHtml(finding.deferral.gate)}` : "no gate recorded", `follow-up ${finding.deferral?.followUp ? escapeHtml(finding.deferral.followUp) : "none recorded"}`]
    : [escapeHtml(finding.lane), escapeHtml(raisedIn(finding) || finding.mode), finding.affectedPath ? pathText(finding.affectedPath, ctx) : ""];
  return `<prism-list-item value="${escapeHtml(finding.id)}"${selected ? " selected" : ""} data-finding="${escapeHtml(finding.id)}"><span slot="icon">${severity(finding.severity, true)}</span><span class="ledger-finding-id">${escapeHtml(finding.localId)}</span> ${escapeHtml(finding.title)}<span slot="detail">${where.filter(Boolean).join(" · ")}</span></prism-list-item>`;
}

// The findings of each status, most severe first, in the order work moves through the statuses.
function grouped(findings: any) {
  return STATUSES.map((value) => [value, findings.filter((finding: any) => finding.status === value).sort((left: any, right: any) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity))]);
}

const ordered = (findings: any) => grouped(findings).flatMap(([, rows]) => rows);

function findingList(findings: any, selected: any, ctx: any) {
  const groups = grouped(findings);
  const shown = groups.filter(([, rows]) => rows.length);
  if (!shown.length) return `<div class="ledger-findings">${emptyState("No findings", "No finding matches the filters.")}</div>`;
  const empty = groups.filter(([, rows]) => !rows.length).map(([value]) => statusWord(value).toLowerCase());
  return `<div class="ledger-findings">${shown.map(([value, rows]) => `<h3 class="prism-group-heading ledger-group-head">${status(value)}<span class="prism-group-count">${rows.length}</span></h3>
    <prism-listbox label="${escapeHtml(statusWord(value))} findings" data-findings>${rows.map((finding: any) => findingRow(finding, finding.id === selected, ctx)).join("")}</prism-listbox>`).join("")}
    ${empty.length ? `<p class="ledger-empty-groups muted">No ${empty.length === 1 ? empty[0] : `${empty.slice(0, -1).join(", ")} or ${empty.at(-1)}`} findings.</p>` : ""}</div>`;
}

function findingDetail(finding: any, ctx: any) {
  if (!finding) return emptyState("Choose a finding", "Choose a finding in the list to read its evidence, what closes it, and its history.");
  // A deferral's history entry carries the follow-up as its evidence, which the details above already show.
  // An opening's evidence is the finding's own, which the details above already show too.
  const repeats = (entry: any) => (entry.status === "DEFERRED" && entry.evidence === finding.deferral?.followUp) || entry.evidence === finding.evidence;
  // A revision names each changed field with its old and new value, and its entry's evidence is the reason.
  const revisionHtml = (revised: any) => [
    revised.clause ? `<p class="muted">Contract clause ${revised.clause.from ? `<code>${escapeHtml(revised.clause.from)}</code>` : "none"} → ${revised.clause.to ? `<code>${escapeHtml(revised.clause.to)}</code>` : "removed"}</p>` : "",
    revised.conditionToClose ? `<p class="muted">Condition to close was: ${escapeHtml(revised.conditionToClose.from)}</p>` : ""
  ].join("");
  const history = finding.history ?? [];
  const steps = history.map((entry: any, index: number) => `<prism-step state="${index === history.length - 1 ? "current" : "done"}">${index === 0 && entry.status === "OPEN" ? "Raised" : escapeHtml(statusWord(entry.status))} by ${escapeHtml(entry.actor)}<span slot="detail">Wave ${escapeHtml(entry.wave)} · ${escapeHtml(formatTime(entry.at))}${entry.revised ? revisionHtml(entry.revised) : ""}${entry.evidence && !repeats(entry) ? `<span class="ledger-step-evidence">${escapeHtml(entry.evidence)}</span>` : ""}</span></prism-step>`).join("");
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
      ["Aliases", finding.aliases?.length ? finding.aliases.map((alias: string) => `<code>${escapeHtml(alias)}</code>`).join(" ") : null],
      ["Record id", `<code>${escapeHtml(finding.id)}</code>`]
    ])}
    <h4 class="ledger-sub">Evidence</h4><p>${escapeHtml(finding.evidence)}</p>
    <h4 class="ledger-sub">Closes when</h4><p>${escapeHtml(finding.conditionToClose)}</p>
    ${finding.implementerEvidence ? `<h4 class="ledger-sub">Implementer evidence</h4><p>${escapeHtml(finding.implementerEvidence)}</p>` : ""}
    ${steps ? `<h4 class="ledger-sub">History</h4><prism-stepper orientation="vertical" label="Status history">${steps}</prism-stepper>` : ""}
  </article>`;
}

function assessmentsTable(assessments: any, ctx: any) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Kind</th><th>Wave / lane</th><th>Reason</th><th>Evidence</th><th>Author</th></tr></thead><tbody>${assessments.map((item: any) => `<tr>
    <td><span class="chip-row"><prism-chip>${escapeHtml(item.kind)}</prism-chip>${item.decision ? `<prism-chip>${escapeHtml(item.decision)}</prism-chip>` : ""}</span></td>
    <td><code>${escapeHtml(item.wave)}</code> / <code>${escapeHtml(item.lane)}</code></td>
    <td>${escapeHtml(item.reason)}</td>
    <td>${(item.evidence ?? []).map((reference: any) => pathText(reference.path, ctx, formatSelector(reference.selector))).join("<br>")}</td>
    <td>${escapeHtml(item.author)}${item.acceptedBy ? `<br><span class="muted">accepted by ${escapeHtml(item.acceptedBy)}</span>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

const OPERATIONS_SHOWN = 20;

function operationsList(history: any) {
  const latest = [...history].reverse();
  const rows = latest.slice(0, OPERATIONS_SHOWN).map((entry) => `<li><time datetime="${escapeHtml(entry.at ?? "")}">${escapeHtml(formatTime(entry.at))}</time><code>${escapeHtml(entry.operation)}</code> <span>by ${escapeHtml(entry.actor)}</span></li>`).join("");
  const rest = latest.length - OPERATIONS_SHOWN;
  return `<ol class="ledger-operations">${rows}${rest > 0 ? `<li class="muted">${plural(rest, "earlier operation")}</li>` : ""}</ol>`;
}

// Up to three reviewers fit one segmented control at a phone's width; more go in a menu.
const SEGMENTED_LANES = 3;

// A filter whose choices go in a menu: a button that names the choice, and the menu with All first.
function menuFilter(id: string, label: string, marker: any, value: any, all: any, values: any) {
  return `<prism-button id="${id}" size="sm" variant="ghost" class="ledger-menu-filter"><span class="sr-only">${escapeHtml(label)}: </span><span>${escapeHtml(value || all)}</span><prism-icon name="chevron-down" size="xs" aria-hidden="true"></prism-icon></prism-button>
      <prism-menu for="${id}" heading="${escapeHtml(label)}" ${marker}><prism-menu-item type="radio" value=""${value ? "" : " checked"}>${escapeHtml(all)}</prism-menu-item>${values.map((item: any) => `<prism-menu-item type="radio" value="${escapeHtml(item)}"${value === item ? " checked" : ""}>${escapeHtml(item)}</prism-menu-item>`).join("")}</prism-menu>`;
}

// The ledger as it stands: the summary of the current wave, the toolbar, the list beside the chosen finding, and the folds below.
function ledgerHtml(record: any, artifact: any, state: any, ids: any, ctx: any) {
  const findings = record.findings ?? [];
  const waves = (record.waves ?? []).map((wave: any) => ({ ...wave, runTotals: waveRunTotals(artifact.runTotals, wave.id) }));
  const current = waves.at(-1);
  const starts = waveStarts(record);
  const lanes = [...new Set(findings.map((finding: any) => finding.lane))].sort();
  const raisingWaves = waves.map((wave: any) => wave.id).filter((id: string) => findings.some((finding: any) => raisedIn(finding) === id));
  const shownSeverities = state.severities ?? SEVERITIES;
  const filtered = findings.filter((finding: any) => (!state.lane || finding.lane === state.lane) && (shownSeverities.includes(finding.severity) || !SEVERITIES.includes(finding.severity)) && (!state.wave || raisedIn(finding) === state.wave));
  const unresolved = findings.filter((finding: any) => UNRESOLVED.includes(finding.status)).length;
  const blocking = findings.filter((finding: any) => !["VERIFIED", "DEFERRED"].includes(finding.status) && ["blocker", "high"].includes(finding.severity)).length;
  const deferred = findings.filter((finding: any) => finding.status === "DEFERRED").length;
  const conflicts = (record.conflicts ?? []).filter((conflict: any) => !conflict.resolved).length;
  const currentIndex = waves.length - 1;
  const currentState = current?.accepted ? "accepted" : "open";
  const totals = current?.runTotals ?? null;
  const summary = `<div class="ledger-summary" data-ledger-summary>
    ${current ? `<span class="ledger-state">${status(currentState, { variant: "pill", label: `Wave ${currentIndex + 1} ${currentState}` })}<span><strong>${escapeHtml(current.id)}</strong>${starts[currentIndex] ? ` <span class="muted">· started ${escapeHtml(formatTime(starts[currentIndex]))}</span>` : ""}</span></span>` : '<span class="muted">No review wave has started</span>'}
    <p class="ledger-counts" data-ledger-counts><strong data-count="unresolved">${plural(unresolved, "unresolved finding")}</strong>${blocking ? `<span class="muted">·</span><span class="ledger-count">${severity("blocker", true)}<span data-count="blocking">${blocking} block${blocking === 1 ? "s" : ""} shipping until verified</span></span>` : ""}${deferred ? `<span class="muted">·</span><span data-count="deferred">${deferred} deferred with a follow-up</span>` : ""}${conflicts ? `<span class="muted">·</span><span class="ledger-conflicts" data-count="conflicts">${plural(conflicts, "open conflict")}</span>` : ""}</p>
    ${current?.lanes?.length ? `<span class="ledger-reviewers"><span class="muted">Reviewers</span>${current.lanes.map((lane: any) => `<prism-chip tip="${escapeHtml(`${lane.reviewer} reviewer, ${lane.result?.status ?? "pending"}`)}"><span slot="start">${status(lane.result?.status ?? "pending", { glyphOnly: true })}</span>${escapeHtml(lane.id)}${lane.reviewer === lane.id ? "" : `<span slot="meta">${escapeHtml(lane.reviewer)}</span>`}</prism-chip>`).join("")}</span>` : ""}
    ${totals && !hasRuns(totals) ? '<span class="ledger-totals muted">No runs yet</span>' : ""}
    ${hasRuns(totals) ? `<prism-button id="${ids.totals}" size="sm" variant="ghost" class="ledger-totals" tip="Run totals of the current wave"><prism-icon name="clock" size="xs" aria-hidden="true"></prism-icon><span>${escapeHtml(runTotalsSummary(totals))}</span><prism-icon name="chevron-down" size="xs" aria-hidden="true"></prism-icon></prism-button>
      <prism-popover class="ledger-totals-popover" for="${ids.totals}" heading="Run totals of ${escapeHtml(current.id)}">${runTotalsTableHtml([{ totals, scope: "wave" }])}</prism-popover>` : ""}
  </div>`;
  const toolbar = findings.length ? `<div class="ledger-toolbar" role="toolbar" aria-label="Filter findings">
    ${lanes.length > 1 ? `<span class="ledger-toolbar-label" aria-hidden="true">Reviewer</span>${lanes.length <= SEGMENTED_LANES
      ? `<prism-segmented label="Reviewer" value="${escapeHtml(state.lane || "all")}" data-ledger-lane><span value="all">All</span>${lanes.map((lane) => `<span value="${escapeHtml(lane)}">${escapeHtml(lane)}</span>`).join("")}</prism-segmented>`
      : menuFilter(ids.lanes, "Reviewer", "data-ledger-lanes", state.lane, "All reviewers", lanes)}` : ""}
    <span class="ledger-toolbar-label" aria-hidden="true">Severity</span><span class="chip-row" role="group" aria-label="Severity">${SEVERITIES.map((level) => `<prism-chip interactive pressed="${shownSeverities.includes(level)}" data-ledger-severity="${level}">${SEVERITY_WORDS[level]}</prism-chip>`).join("")}</span>
    ${raisingWaves.length > 1 || state.wave ? `<span class="ledger-toolbar-label" aria-hidden="true">Raised in</span>${menuFilter(ids.waves, "Raised in", "data-ledger-waves", state.wave, "All waves", raisingWaves)}` : ""}
    <span class="ledger-shown muted" aria-live="polite">${filtered.length === findings.length ? plural(findings.length, "finding") : `${filtered.length} of ${plural(findings.length, "finding")}`}</span>
  </div>` : "";
  // Without a choice, the ledger opens on the first unresolved finding as the list shows it, which is the most severe open one.
  const shown = ordered(filtered);
  const selected = filtered.some((finding: any) => finding.id === state.selected) ? state.selected : shown.find((finding) => UNRESOLVED.includes(finding.status))?.id ?? shown[0]?.id ?? null;
  state.selected = selected;
  const split = findings.length
    ? `<div class="ledger-split">${findingList(filtered, selected, ctx)}<div class="ledger-detail" aria-live="polite" data-detail>${findingDetail(findings.find((finding: any) => finding.id === selected), ctx)}</div></div>`
    : emptyState("No findings", "No reviewer has raised a finding.");
  const folds = [
    `<prism-disclosure summary="Waves · ${waves.length}"${state.wavesOpen ? " open" : ""} data-fold="wavesOpen">${waves.length ? `<ol class="ledger-waves">${waves.map((wave: any, index: number) => waveItem(wave, index, findings, wave === current, starts[index])).join("")}</ol>` : '<p class="muted">No review wave has started.</p>'}</prism-disclosure>`,
    `<prism-disclosure summary="Assessments · ${record.assessments?.length ? record.assessments.length : "none recorded"}" data-fold="assessmentsOpen"${state.assessmentsOpen ? " open" : ""}>${record.assessments?.length ? assessmentsTable(record.assessments, ctx) : '<p class="muted">Reviewers record an assessment when they accept or reject a wave.</p>'}</prism-disclosure>`,
    record.conflicts?.length ? `<prism-disclosure summary="Conflicts · ${plural(record.conflicts.length, "conflict")}" data-fold="conflictsOpen"${state.conflictsOpen || conflicts ? " open" : ""}><ul class="ledger-conflict-list">${record.conflicts.map((conflict: any) => `<li><strong>${escapeHtml(conflict.id)}</strong> <span class="muted">${escapeHtml(conflict.lanes.join(" and "))}, wave <code>${escapeHtml(conflict.wave)}</code></span> ${escapeHtml(conflict.reason)} ${status(conflict.resolved ? "done" : "open", { label: conflict.resolved ? `Resolved by ${conflict.resolved.actor}` : "Open" })}</li>`).join("")}</ul></prism-disclosure>` : "",
    record.history?.length ? `<prism-disclosure summary="Operation history · ${plural(record.history.length, "operation")}" data-fold="historyOpen"${state.historyOpen ? " open" : ""}>${operationsList(record.history)}</prism-disclosure>` : "",
    record.legacy?.length ? `<prism-disclosure summary="Imported legacy findings · ${plural(record.legacy.length, "file")}" data-fold="legacyOpen"${state.legacyOpen ? " open" : ""}>${jsonTreeHtml(record.legacy, { openDepth: 1, ctx, label: "Imported legacy findings" })}</prism-disclosure>` : "",
    `<prism-disclosure summary="Record details" data-fold="recordOpen"${state.recordOpen ? " open" : ""}>${keyValues([
      ["Change map", record.deltaPath ? recordChip(record.deltaPath, ctx) : null],
      ["Coordinator", escapeHtml(record.coordinator ?? "")],
      ["Delivery", escapeHtml([record.delivery, ...(record.deliveryWorkers ?? []).filter((worker: any) => worker !== record.delivery)].filter(Boolean).join(", "))],
      ["Exchange workers", record.exchangeWorkers?.length ? escapeHtml(record.exchangeWorkers.join(", ")) : null],
      ["Baseline", record.baselineId ? evidenceChip(record.baselineId, "Snapshot") : null],
      ["Raw record", artifact.path ? recordChip(artifact.path, ctx) : null]
    ])}</prism-disclosure>`
  ].filter(Boolean).join("");
  return `<div class="review-ledger">${summary}${toolbar}${split}<div class="ledger-more">${folds}</div></div>`;
}

/**
 * Draws the review ledger of `artifact`, a review record read as { data, runTotals, path }, into `container`, and keeps its filters, folds, and chosen finding in `state`.
 * The ledger draws itself again when a filter changes, so the page around it stays as it is.
 */
export function mountLedger(container: any, artifact: any, ctx: any, state: any = {}) {
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
  const choose = (id: string) => {
    state.selected = id;
    for (const item of container.querySelectorAll("[data-finding]")) item.toggleAttribute("selected", item.dataset.finding === id);
    const detail = container.querySelector("[data-detail]");
    if (detail) {
      detail.innerHTML = findingDetail(findings.find((finding: any) => finding.id === id), ctx);
      bindLinks(detail, ctx);
    }
  };
  draw();
  if (typeof container.addEventListener !== "function" || container.dataset.ledgerBound) return;
  // The listeners sit on the container, so they outlive each redraw and are added once.
  container.dataset.ledgerBound = "true";
  container.addEventListener("prism-select", (event: any) => {
    const listbox = event.target.closest?.("[data-findings]");
    if (listbox && event.detail?.value) {
      choose(event.detail.value);
      return;
    }
    if (event.target.closest?.("[data-ledger-waves]")) {
      state.wave = event.detail?.value ?? "";
      draw((`#${ids.waves}` as any));
    }
    if (event.target.closest?.("[data-ledger-lanes]")) {
      state.lane = event.detail?.value ?? "";
      draw((`#${ids.lanes}` as any));
    }
  });
  container.addEventListener("change", (event: any) => {
    if (!event.target.closest?.("[data-ledger-lane]")) return;
    const value = event.detail?.value ?? event.target.value;
    state.lane = value === "all" ? "" : value;
    draw(("[data-ledger-lane]" as any));
  });
  container.addEventListener("click", (event: any) => {
    const chip = event.target.closest?.("[data-ledger-severity]");
    if (chip) {
      const level = chip.dataset.ledgerSeverity;
      const shown = state.severities ?? SEVERITIES;
      const next = shown.includes(level) ? shown.filter((item: any) => item !== level) : SEVERITIES.filter((item) => shown.includes(item) || item === level);
      state.severities = next.length === SEVERITIES.length ? null : next;
      draw((`[data-ledger-severity="${level}"]` as any));
      return;
    }
    const waveFilter = event.target.closest?.("[data-wave-filter]");
    if (waveFilter) {
      state.wave = waveFilter.dataset.waveFilter;
      draw((`#${ids.waves}` as any));
    }
  });
  // A disclosure's toggle does not bubble, so the container listens while it travels down.
  container.addEventListener("toggle", (event: any) => {
    const fold = event.target.closest?.("[data-fold]");
    if (fold) state[fold.dataset.fold] = fold.hasAttribute("open");
  }, true);
}

/** The review record's own page. */
export function render(container: any, artifact: any, ctx: any) {
  mountLedger(container, artifact, ctx, ctx.state);
}
