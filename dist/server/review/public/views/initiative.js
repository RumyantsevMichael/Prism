// Generated from src/server/review/public/views/initiative.ts by scripts/native-build/compile.mjs.
import { activeDetails } from "./coordination-state.js";
import { applyWidths } from "./entities.js";
import { stateBadge, unmetText } from "./roadmap.js";
import { enablePanZoom, graphCard, renderGraph } from "./graph.js";
import { artifactChip, badge, bindLinks, card, emptyNote, escapeHtml, keyValues, pageSub, plural, requirementGroups, setPageHead, setPageSub, shortDate, status } from "./util.js";
import { runTotalsHtml, runTotalsSummary, runTotalsTableHtml } from "./run-totals.js";
import { codeChip } from "./code-location.js";
import { claimChip, claimOf } from "./claims.js";
import { componentChip } from "./components.js";
import { createActionList } from "./actions.js";
import { REFRESH_MS, stateOf } from "./agents.js";
import { shippedHistoryHtml } from "./shipped-history.js";
import { preference, setPreference } from "../kit/preferences.js";
const MODES = [["board", "Board"], ["list", "List"], ["graph", "Graph"]];
const STATUS_COLUMNS = [["not-started", "Not started"], ["design-review", "Design review"], ["in-progress", "In progress"], ["blocked", "Blocked"], ["deferred", "Deferred"], ["done", "Done"]];
const FIXED_COLUMNS = /* @__PURE__ */ new Set(["not-started", "in-progress", "blocked", "done"]);
function statusBadge(value) {
  return status(value);
}
function sliceLink(data, slug) {
  const ref = `slice:${data.id}/${slug}`;
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(data.record.slices[slug].title)}</a>`;
}
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
  return names.join(" \u203A ");
}
function boardCard(data, slug, ctx) {
  const slice = data.record.slices[slug];
  const path = clusterPath(data, slug).split(" \u203A ").slice(1).join(" \u203A ");
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
function board(data, ctx) {
  const slugs = [...data.derived.leaves, ...data.active.map((entry) => entry.slice).filter((slug) => data.record.slices[slug] && !data.derived.leaves.includes(slug))];
  const unique = [...new Set(slugs)];
  const known = new Set(STATUS_COLUMNS.map(([status2]) => status2));
  const extra = [...new Set(unique.map((slug) => statusOf(data, slug)).filter((status2) => !known.has(status2)))].map((status2) => [status2, status2]);
  const columns = [...STATUS_COLUMNS, ...extra].filter(([status2]) => FIXED_COLUMNS.has(status2) || unique.some((slug) => statusOf(data, slug) === status2));
  return `<div class="slice-columns">${columns.map(([status2, label]) => {
    const members = unique.filter((slug) => statusOf(data, slug) === status2);
    return `<section class="slice-column" aria-label="${escapeHtml(label)}"><h3 class="slice-column-head">${statusBadge(status2)}<prism-badge>${members.length}</prism-badge></h3><ul class="slice-column-list">${members.map((slug) => boardCard(data, slug, ctx)).join("") || '<li class="column-none muted">\u2014</li>'}</ul></section>`;
  }).join("")}</div>`;
}
async function graph(container, data, ctx) {
  const section = graphCard({ title: plural(data.derived.leaves.length, "leaf slice"), eyebrow: "Execution order: prerequisite \u2192 dependent", legend: '<span><i class="legend-status status-done"></i>done</span><span><i class="legend-status status-in-progress"></i>in progress</span><span><i class="legend-status status-blocked"></i>blocked</span><span><i class="legend-status status-not-started"></i>not started</span><span class="legend-hint">Click a slice to open it</span>' });
  container.appendChild(section);
  const nodes = data.derived.leaves.map((slug) => {
    const slice = data.record.slices[slug];
    return { id: slug, title: slice.title, subtitle: `${statusOf(data, slug) === "design-review" ? "design review" : slice.status}${data.slices[slug]?.review?.blocking ? ` \xB7 ${data.slices[slug].review.blocking} blocking` : ""}`, tooltip: slice.outcome ?? slice.title, cluster: clusterPath(data, slug) || void 0, className: `slice-node status-${statusOf(data, slug)}` };
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
function closedLines(data) {
  const decision = data.roadmapItem?.decision;
  if (!["killed", "merged", "split"].includes(decision?.kind)) return "";
  const date = shortDate(decision.at, { year: true });
  const links = (data.closedInto ?? []).map((other) => itemLink(other.id, other.title)).join(", ");
  const words = { killed: "Killed", merged: "Merged", split: "Split" }[decision.kind];
  const line = pageSub(`${words}${date ? ` ${escapeHtml(date)}` : ""}${links ? ` into ${links}` : ""}`, { glyph: status(decision.kind, { glyphOnly: true }) });
  return `${line}${decision.kind === "killed" && decision.reason ? pageSub(escapeHtml(decision.reason), { detail: true }) : ""}`;
}
function itemLink(id, title) {
  const ref = `initiative:${id}`;
  return `<a href="./review?artifact=${encodeURIComponent(ref)}" data-artifact="${escapeHtml(ref)}">${escapeHtml(title)}</a>`;
}
function headLines(data) {
  const item = data.roadmapItem;
  const intent = item ? escapeHtml(item.intent) : data.exists ? "This initiative has a record but no roadmap entry." : "";
  return `<div class="prism-page-subs">${pageSub(`${stateBadge(item?.state ?? "unlisted")}${intent ? ` <span>${intent}</span>` : ""}`)}${supersededLines(data)}${closedLines(data)}</div>`;
}
function sourceLink(link, ctx) {
  if (/^https?:\/\//i.test(link)) return `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a>`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link) && ctx.hasArtifact?.(link)) return `<a href="./review?artifact=${encodeURIComponent(link)}" data-artifact="${escapeHtml(link)}" data-code-subject>${escapeHtml(link)}</a>`;
  return `<span data-code-subject>${escapeHtml(link)}</span>`;
}
const rows = (label, html) => html ? `<div class="prism-rows" role="list" aria-label="${escapeHtml(label)}">${html}</div>` : "";
function readinessCard(item, stage) {
  const unmet = item.unmet ?? [];
  const ready = item.record?.ready;
  const body = unmet.length ? rows("Unmet readiness conditions", unmet.map((condition) => `<prism-row wrap icon="warning" tone="warning">${escapeHtml(unmetText(condition))}</prism-row>`).join("")) : ready ? `<p>A person confirmed it ready${ready.at ? ` on ${escapeHtml(shortDate(ready.at, { year: true }))}` : ""}.</p>` : stage === "emerging" ? `<p>Every readiness condition is met; it becomes ready once a person confirms it.</p>` : `<p>Every readiness condition is met.</p>`;
  return card("Readiness", body, { eyebrow: unmet.length ? `${plural(unmet.length, "condition")} unmet` : stage === "emerging" ? "Emerging" : "Ready", className: "work-item-readiness" });
}
function citedCard(data, item, ctx) {
  const titles = item.titles ?? {};
  const html = (item.cited ?? []).map((entry) => {
    const also = entry.citedBy?.length ? `Also cited by ${entry.citedBy.map((id) => escapeHtml(titles[id] ?? id)).join(", ")}` : "";
    const scope = entry.scope?.label ? ` \xB7 ${escapeHtml(entry.scope.label)}` : "";
    const name = ctx.hasArtifact?.(entry.path) ? `<a href="./review?artifact=${encodeURIComponent(entry.path)}" data-artifact="${escapeHtml(entry.path)}" data-code-subject>${escapeHtml(entry.path)}</a>` : `<span data-code-subject>${escapeHtml(entry.path)}</span>`;
    const kind = entry.status ? status(entry.status, { attributes: ' slot="kind"' }) : `<span slot="kind" class="muted">Missing</span>`;
    return `<prism-row wrap stack icon="${entry.kind === "adrs" ? "scale" : "document"}" tone="accent">${name}<span slot="description">${entry.kind === "adrs" ? "Decision" : "Requirements"}${scope}</span>${also ? `<span slot="detail">${also}</span>` : ""}${kind}</prism-row>`;
  }).join("");
  return card("Cited requirements and decisions", html ? rows("Cited requirements and decisions", html) : emptyNote("It cites no requirement file or ADR yet."), { eyebrow: plural(item.cited?.length ?? 0, "artifact"), className: "work-item-cited" });
}
function questionsCard(record) {
  const questions = record.questions ?? [];
  if (!questions.length) return "";
  const html = questions.map((asked) => {
    const mark = asked.answer ? badge("Answered", "success") : asked.withdrawn ? badge("Withdrawn") : badge("Unanswered", "warning");
    const detail = asked.answer ? `<span slot="detail">${escapeHtml(asked.answer.text ?? "")}</span>` : "";
    return `<prism-row wrap stack icon="question" tone="${asked.answer ? "success" : asked.withdrawn ? "neutral" : "warning"}">${escapeHtml(asked.question)}<span slot="description">Round ${escapeHtml(asked.round)} \xB7 ${asked.blocking ? "Needed for readiness" : "Not needed for readiness"}</span>${detail}${mark.replace("<prism-badge", '<prism-badge slot="kind"')}</prism-row>`;
  }).join("");
  const rounds = Math.max(...questions.map((asked) => Number(asked.round) || 0));
  return card("Questions", rows("Questions", html), { eyebrow: plural(rounds, "round"), className: "work-item-questions" });
}
function sourcesCards(record, ctx) {
  const inputs = (record.inputs ?? []).map((input) => `<prism-row wrap icon="link" tone="accent">${escapeHtml(input.note)}<span slot="description">${sourceLink(input.link, ctx)}</span></prism-row>`).join("");
  const findings = (record.findings ?? []).map((finding) => `<prism-row wrap icon="search" tone="info">${escapeHtml(finding.text)}<span slot="description">${sourceLink(finding.source, ctx)}</span></prism-row>`).join("");
  const gaps = (record.gaps ?? []).map((gap) => `<prism-row wrap icon="info" tone="neutral">${escapeHtml(gap.note)}</prism-row>`).join("");
  return [
    inputs ? card("Inputs", rows("Inputs", inputs), { eyebrow: plural(record.inputs.length, "input"), className: "work-item-inputs" }) : "",
    findings ? card("Findings", rows("Findings", findings), { eyebrow: plural(record.findings.length, "finding"), className: "work-item-findings" }) : "",
    gaps ? card("Research gaps", rows("Research gaps", gaps), { eyebrow: plural(record.gaps.length, "gap"), className: "work-item-gaps" }) : ""
  ].join("");
}
function workItemSection(data, ctx) {
  const item = data.workItem;
  if (!item) return "";
  if (item.problem) return card("Unreadable shaping record", `<p class="error">${escapeHtml(item.problem.message)}</p>`, { eyebrow: "Shaping" });
  const stage = item.stage;
  if (stage !== "emerging" && !item.record) return "";
  const decided = !["emerging", "ready"].includes(stage);
  const record = item.record ?? {};
  return `<div class="work-item">${decided ? "" : readinessCard(item, stage)}${citedCard(data, item, ctx)}${questionsCard(record)}${sourcesCards(record, ctx)}${item.record ? "" : emptyNote("Nobody has started shaping it yet.")}</div>`;
}
function sliceProgress(data) {
  const leaves = data.derived?.leaves ?? [];
  if (!leaves.length) return "";
  const statuses = leaves.map((slug) => statusOf(data, slug));
  const count = (value) => statuses.filter((entry) => entry === value).length;
  const parts = [`${count("done")} of ${leaves.length} done`, ...["design-review", "in-progress", "blocked", "deferred"].filter((value) => count(value)).map((value) => `${count(value)} ${value.replace(/-/g, " ")}`)];
  return `<prism-slice-bar class="initiative-progress" statuses="${escapeHtml(statuses.join(","))}" label="${escapeHtml(parts.join(" \xB7 "))}"></prism-slice-bar>`;
}
function relatedChips(ids, data, ctx, icon) {
  return ids.map((id) => {
    const ref = `initiative:${id}`;
    const title = escapeHtml(data.relatedTitles?.[id] ?? id);
    return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(ref)}"><prism-icon slot="start" name="${icon}" size="xs"></prism-icon>${title}</prism-chip>`;
  }).join("");
}
function facts(data, ctx) {
  const item = data.roadmapItem;
  const rows2 = keyValues([
    ["Rationale", item?.rationale ? escapeHtml(item.rationale) : null],
    ["Needs", item?.requires.length ? `<span class="chip-row">${relatedChips(item.requires, data, ctx, "needs")}</span>` : null],
    ["Unblocks", item?.requiredBy.length ? `<span class="chip-row">${relatedChips(item.requiredBy, data, ctx, "unblocks")}</span>` : null],
    ["Requirements", item?.requirements.length ? `<span class="chip-row">${requirementGroups(item.requirements, ctx)}</span>` : null],
    ["Records", `<span class="chip-row">${[artifactChip(data.recordPath, ctx, "Initiative record"), ctx.hasArtifact(data.statePath) ? artifactChip(data.statePath, ctx, "Coordination state") : ""].join("")}</span>`]
  ]);
  const open = ctx.state.factsOpen ?? true;
  return `<prism-disclosure class="initiative-facts" summary="Rationale, dependencies, requirements, and records"${open ? " open" : ""}>${rows2}</prism-disclosure>`;
}
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
  return `<p class="initiative-frontier"><span class="initiative-frontier-glyph">${status("not-started", { glyphOnly: true, attributes: ' aria-hidden="true"' })}</span><span>${lines.join(" \xB7 ")}</span></p>`;
}
let headSequence = 0;
function headControls(data, ctx, ids) {
  const summary = runTotalsSummary(data.runTotals?.initiative ?? null);
  const totals = summary ? `<prism-button id="${ids.totals}" size="sm" variant="ghost" class="initiative-totals" tip="Run totals of this initiative"><prism-icon name="clock" size="xs"></prism-icon><span>${summary}</span><prism-icon name="chevron-down" size="xs"></prism-icon></prism-button>` : "";
  const lastRun = '<span class="initiative-last-run-slot" data-last-run-slot></span>';
  if (!ctx.actionApi) return `${lastRun}${totals}`;
  return `${lastRun}${totals}<prism-button id="${ids.launch}" size="sm" class="initiative-launch" data-launch-open data-focus-key="initiative-launch"><prism-icon name="play" size="xs"></prism-icon><span>Launch</span></prism-button><prism-button size="sm" class="initiative-settings" data-initiative-settings-open data-focus-key="initiative-settings"><prism-icon name="settings" size="xs"></prism-icon><span>Settings</span></prism-button>`;
}
function overlays(data, ctx, ids, head) {
  const totals = head && data.runTotals?.initiative ? `<prism-popover class="initiative-totals-popover" for="${ids.totals}" heading="Run totals">${runTotalsTableHtml([{ totals: data.runTotals.initiative, scope: "initiative" }])}</prism-popover>` : "";
  if (!ctx.actionApi) return totals;
  const title = data.roadmapItem?.title ?? data.id;
  return `${totals}
    ${head ? `<prism-dialog class="initiative-launch-dialog" heading="Launch ${escapeHtml(title)}" size="lg" data-launch-dialog>
      <div class="initiative-latest-run" data-launch-latest hidden></div>
      <p class="initiative-settings-lead">These are this initiative's settings; change any of them before the run starts.</p>
      <prism-banner class="initiative-launch-note" tone="warning" data-launch-hold hidden><div data-launch-lines></div></prism-banner>
      <prism-banner class="initiative-launch-note" tone="danger" data-launch-error hidden><div data-launch-lines></div></prism-banner>
      <div data-launch-settings></div>
      <span slot="footer-note">Launching saves these choices as this initiative's settings.</span>
      <prism-button slot="footer" data-launch-cancel>Cancel</prism-button>
      <prism-button slot="footer" variant="primary" data-launch-confirm disabled><prism-icon name="play" size="xs"></prism-icon><span data-launch-label>Launch</span></prism-button>
    </prism-dialog>` : ""}
    <prism-dialog class="initiative-settings-dialog" heading="Settings of ${escapeHtml(title)}" size="lg" data-initiative-settings-dialog>
      <p class="initiative-settings-lead">How agents run this initiative's slices. Changes apply when you press Apply.</p>
      <div data-initiative-settings></div>
      <prism-button slot="footer" data-settings-cancel>Cancel</prism-button>
      <prism-button slot="footer" variant="primary" data-settings-apply disabled>Apply</prism-button>
    </prism-dialog>`;
}
const HEAD_RUN_TEXT = Object.freeze({ failed: "Last run failed", blocked: "Last run blocked", waiting: "Waiting for you", running: "Running" });
function latestLaunch(launches, initiative) {
  return (Array.isArray(launches) ? launches : []).filter((item) => item?.initiative === initiative).sort((left, right) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? ""))[0] ?? null;
}
const AGENTS_LINK = '<a href="./review?artifact=agents" data-artifact="agents">Open in Agents</a>';
function mountLastRun(container, data, ctx, endRoot) {
  const slot = endRoot?.querySelector("[data-last-run-slot]");
  if (!slot || typeof fetch !== "function") return null;
  const dialog = container.querySelector("[data-launch-dialog]");
  const latest = dialog?.querySelector("[data-launch-latest]");
  let shown = "";
  const show = (launch) => {
    const key = launch ? JSON.stringify([launch.id, launch.state, launch.reason, launch.runs]) : "";
    if (key === shown) return;
    shown = key;
    const head = launch ? HEAD_RUN_TEXT[launch.state] : null;
    const [words, tone] = launch ? stateOf(launch) : ["", "neutral"];
    const readOnly = typeof ctx.canWrite === "function" && !ctx.canWrite();
    slot.innerHTML = !head ? "" : readOnly ? `<span class="initiative-last-run" data-initiative-last-run-state>${badge(head, tone)}</span>${AGENTS_LINK}` : `<prism-button size="sm" variant="ghost" class="initiative-last-run" data-initiative-last-run tip="${dialog ? "Show the latest run" : "Open Agents"}">${badge(head, tone)}</prism-button>`;
    bindLinks(slot, ctx);
    if (!latest) return;
    latest.hidden = !launch;
    latest.innerHTML = launch ? `<div class="initiative-latest-run-head"><span class="initiative-latest-run-title">Latest run \xB7 ${escapeHtml(launch.hostLabel ?? launch.host ?? "")}</span>${badge(words, tone)}</div>
        ${launch.reason ? `<p class="initiative-latest-run-reason">${escapeHtml(launch.reason)}</p>` : ""}
        ${AGENTS_LINK}` : "";
    bindLinks(latest, ctx);
  };
  slot.addEventListener("click", (event) => {
    if (!event.target.closest?.("[data-initiative-last-run]")) return;
    if (dialog) dialog.show?.();
    else ctx.openArtifact?.("agents");
  });
  const read = async () => {
    try {
      const response = await fetch("./api/launches", { cache: "no-store" });
      if (response.ok) show(latestLaunch((await response.json().catch(() => ({}))).launches, data.id));
    } catch {
    }
  };
  let reading = null;
  let queued = null;
  const refresh = () => {
    if (!reading) {
      reading = read().finally(() => {
        reading = null;
      });
      return reading;
    }
    queued ??= reading.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  };
  const poll = setInterval(() => {
    if (!slot.isConnected) return clearInterval(poll);
    if (!reading) void refresh();
  }, REFRESH_MS);
  void refresh();
  return refresh;
}
const LAUNCH_SECTIONS = Object.freeze([
  { heading: "How the run works", actions: ["initiative.autonomy", "initiative.commit", "initiative.push", "initiative.continuation", "initiative.review"] },
  { heading: "Models", actions: ["initiative.models"] }
]);
function mountLaunch(container, data, ctx, endRoot, refreshLatest) {
  const dialog = container.querySelector("[data-launch-dialog]");
  const confirm = dialog?.querySelector("[data-launch-confirm]");
  const confirmLabel = confirm?.querySelector("[data-launch-label]");
  if (!dialog || !confirm || !confirmLabel) return;
  const hold = dialog.querySelector("[data-launch-hold]");
  const failure = dialog.querySelector("[data-launch-error]");
  const linesOf = new Map([hold, failure].map((banner) => [banner, banner.querySelector("[data-launch-lines]")]));
  let list = null;
  let sending = false;
  let refused = null;
  const lines = (banner, texts) => {
    const html = texts.map((text) => `<div>${escapeHtml(text)}</div>`).join("");
    const box = linesOf.get(banner);
    if (box.dataset.shown !== html) {
      box.dataset.shown = html;
      box.innerHTML = html;
    }
    banner.hidden = !texts.length;
  };
  const sync = () => {
    if (!list) return;
    const hostAction = list.action("initiative.host");
    const launch = list.action("launch.run");
    const options = hostAction?.fields?.[0]?.options ?? [];
    const shown = list.input("initiative.host")?.value ?? null;
    const option = options.find((item) => item.value === shown) ?? null;
    const text = option ? `Launch with ${option.label ?? option.value}` : "Launch";
    if (confirmLabel.textContent !== text) confirmLabel.textContent = text;
    const hostReason = (host) => options.find((item) => item.value === host)?.reason ?? list.reportReason(host);
    const shownReason = option ? hostReason(shown) : null;
    let blocked = Boolean(shownReason);
    const reasons = [];
    if (launch && !launch.available) {
      const storedReason = hostAction ? hostReason(hostAction.value) : null;
      const cleared = storedReason !== null && launch.reason === storedReason && option && !shownReason && shown !== hostAction.value;
      if (!cleared) {
        blocked = true;
        if (launch.reason !== shownReason) reasons.push(launch.reason ?? "");
      }
    }
    const held = list.held();
    reasons.push(...held.reasons.map((item) => `${item.label}: ${item.reason}`));
    const holding = reasons.filter(Boolean);
    lines(hold, holding);
    lines(failure, refused && refused !== shownReason && !holding.includes(refused) ? [refused] : []);
    confirm.toggleAttribute("disabled", sending || !launch || !list.writable() || blocked || reasons.length > 0 || held.reading);
  };
  list = createActionList({ root: dialog.querySelector("[data-launch-settings]"), targets: [`initiative:${data.id}`], api: ctx.actionApi, drafts: ctx.state.launchDrafts ??= {}, renderMarkdown: ctx.renderMarkdown ?? null, batch: true, groups: ["Initiative settings"], sections: LAUNCH_SECTIONS, emptyText: "This initiative has no settings to change.", onRender: () => sync() });
  sync();
  endRoot?.querySelector("[data-launch-open]")?.addEventListener("click", () => dialog.show?.());
  const observer = new MutationObserver(() => {
    if (!dialog.hasAttribute("open")) return;
    void refreshLatest?.();
    void list.refresh();
  });
  observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  dialog.querySelector("[data-launch-cancel]").addEventListener("click", () => dialog.close?.());
  dialog.addEventListener("prism-close", (event) => {
    if (event.target !== dialog) return;
    refused = null;
    list.discard();
    sync();
  });
  confirm.addEventListener("click", async () => {
    if (confirm.hasAttribute("disabled") || sending) return;
    sending = true;
    refused = null;
    sync();
    let launched = false;
    try {
      if (await list.applyAll()) {
        const result = await list.follow("launch.run");
        launched = result.ok;
        refused = result.ok ? null : result.message;
      }
    } finally {
      sending = false;
    }
    if (launched) {
      await refreshLatest?.();
      dialog.close?.();
    }
    sync();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target.closest?.("prism-chip[data-artifact], a[data-artifact]")) dialog.close?.();
  });
}
function mountOverlays(container, data, ctx, endRoot) {
  if (!ctx.actionApi || typeof document === "undefined") return;
  const target = `initiative:${data.id}`;
  const drafts = ctx.state.actionDrafts ??= {};
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
  const focusAction = list.focusAction.bind(list);
  list.focusAction = (id, chosen) => {
    if (!dialog.hasAttribute("open")) dialog.show?.();
    return focusAction(id, chosen);
  };
  endRoot?.querySelector("[data-initiative-settings-open]")?.addEventListener("click", () => dialog.show?.());
  dialog.querySelector("[data-settings-cancel]").addEventListener("click", () => dialog.close?.());
  dialog.addEventListener("prism-close", (event) => {
    if (event.target !== dialog) return;
    list.discard();
    showCount();
  });
  apply.addEventListener("click", async () => {
    apply.toggleAttribute("disabled", true);
    if (await list.applyAll()) dialog.close?.();
    showCount();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target.closest?.("prism-chip[data-artifact], a[data-artifact]")) dialog.close?.();
  });
}
async function render(container, entity, ctx) {
  const data = entity.data;
  const item = data.roadmapItem;
  const mode = preference("initiative.view");
  const ids = { totals: `initiative-totals-${++headSequence}`, launch: `initiative-launch-${headSequence}` };
  const eyebrow = ["Initiative", item?.band ?? null, data.bandRank ? `#${data.bandRank}` : null].filter(Boolean).join(" \xB7 ");
  const endRoot = setPageHead(container, { eyebrow, end: headControls(data, ctx, ids) }, ctx);
  const lines = headLines(data);
  const lead = setPageSub(container, lines, ctx) ? "" : lines;
  const totalsInPage = !endRoot && data.runTotals ? runTotalsHtml(data.runTotals.initiative, "initiative") : "";
  const top = `${lead}${shippedHistoryHtml(data.shippedHistory)}${item?.readyToShip && item.state !== "shipped" ? `<p class="chip-row">${badge("ready to ship", "success")}</p>` : ""}`;
  const finish = () => {
    container.querySelector(".initiative-facts")?.addEventListener("toggle", (event) => {
      ctx.state.factsOpen = Boolean(event.detail?.open);
    });
    mountOverlays(container, data, ctx, endRoot);
    const refreshLatest = mountLastRun(container, data, ctx, endRoot);
    if (ctx.actionApi && typeof document !== "undefined") mountLaunch(container, data, ctx, endRoot, refreshLatest);
    applyWidths(container);
    bindLinks(container, ctx);
  };
  const shaping = workItemSection(data, ctx);
  if (!data.exists) {
    const state = item?.state ?? "envisioned";
    const noSlices = ["killed", "merged", "split"].includes(state) ? "" : card("No slices yet", state === "emerging" ? `<p>No initiative record exists yet.</p><p class="muted">Design starts once a person confirms that it is ready.</p>` : `<p>No initiative record exists yet.</p><p class="muted">Orchestration creates it when the initiative starts.</p>`, { eyebrow: state === "emerging" ? "Emerging" : "Envisioned" });
    container.innerHTML = `${top}${shaping}${facts(data, ctx)}${totalsInPage}${noSlices}${overlays(data, ctx, ids, Boolean(endRoot))}`;
    finish();
    return;
  }
  if (!data.valid) {
    container.innerHTML = `${top}${shaping}${facts(data, ctx)}${totalsInPage}${card("Invalid initiative record", `<ul class="diagnostic-list">${data.errors.map((error) => `<li class="is-blocking">${escapeHtml(error)}</li>`).join("")}</ul>`, { eyebrow: "Initiative record" })}${item ? overlays(data, ctx, ids, Boolean(endRoot)) : ""}`;
    finish();
    return;
  }
  const counts = data.derived.counts;
  const summary = `${plural(data.derived.leaves.length, "leaf slice")} \xB7 ${counts.done} done \xB7 ${counts["in-progress"]} in progress \xB7 ${counts.blocked} blocked`;
  const toolbar = `<div class="initiative-toolbar"><prism-segmented label="View" value="${escapeHtml(mode)}" data-initiative-mode>${MODES.map(([value, label]) => `<span value="${value}">${label}</span>`).join("")}</prism-segmented>${frontier(data, ctx)}</div>`;
  container.innerHTML = `${top}${shaping}${sliceProgress(data)}${facts(data, ctx)}${totalsInPage}${toolbar}<div data-initiative-body></div>${overlays(data, ctx, ids, Boolean(endRoot))}`;
  const body = container.querySelector("[data-initiative-body]");
  if (mode === "graph") await graph(body, data, ctx);
  else if (mode === "list") body.innerHTML = card("Slice tree", `<ul class="slice-outline root">${tree(data, data.derived.root, 0, ctx)}</ul>`, { eyebrow: summary });
  else body.innerHTML = board(data, ctx);
  container.querySelector("[data-initiative-mode]")?.addEventListener("change", (event) => {
    if (!MODES.some(([value]) => value === event.detail?.value)) return;
    void setPreference("initiative.view", event.detail.value).catch(() => {
    });
    ctx.rerender();
  });
  finish();
}
export {
  latestLaunch,
  render,
  statusBadge
};
