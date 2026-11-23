import { chipState, currentIndexStatus } from "./indexing.js";
import { artifactChip, badge, bindLinks, card, chip, emptyNote, emptyState, escapeHtml, formatTime, keyValues, plural, requirementLinks } from "./util.js";
import { recordKind } from "./entities.js";
import { statusBadge } from "./initiative.js";
import { sliceRunTotalsHtml } from "./run-totals.js";
import { codeParts } from "./code-location.js";
import { claimChip } from "./claims.js";
import { componentChip } from "./components.js";
import { mountInitiativeSettings } from "./actions.js";
import { mountSliceFiles, presenceChips } from "./slice-files.js";
import { mountLedger } from "./review-ledger.js";
import { shippedHistoryHtml } from "./shipped-history.js";
import { bindViewLinks, markViewFiles, requestClause, takeClause, viewCardHtml } from "./design-views.js";

function sliceChip(data: any, slug: string, ctx: any) {
  return artifactChip(`slice:${data.id}/${slug}`, ctx, data.titles[slug] ?? slug);
}


// The Review tab holds the slice's review ledger, read after the page renders.
function reviewPanel(review: any, ctx: any) {
  if (!review) return emptyState("No review yet", "No review has started for this slice.");
  if (review.invalid) return `<p class="error">The review ledger is not valid JSON.</p>${artifactChip(review.path, ctx, "Open raw")}`;
  return '<div class="slice-review-ledger" data-review-ledger><prism-spinner label="Loading the review ledger"></prism-spinner></div>';
}

async function mountReviewLedger(container: any, review: any, ctx: any) {
  const target = container.querySelector("[data-review-ledger]");
  if (!target) return;
  try {
    const artifact = await ctx.fetchArtifact(review.path);
    if (!target.isConnected && target.isConnected !== undefined) return;
    ctx.state.ledger ??= {};
    mountLedger(target, artifact, ctx, ctx.state.ledger);
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

const REASONS: Record<string, any> = {
  frozen_tests_changed: "the frozen acceptance tests changed, so the command did not run",
  cancelled: "the run was cancelled",
  timed_out: "the command ran past its timeout",
  command_failed: "the test command failed",
  tracked_files_changed: "the command changed project files while it ran"
};

function seconds(durationMs: any) {
  return durationMs >= 60000 ? `${Math.round(durationMs / 60000)} min` : durationMs >= 1000 ? `${Math.round(durationMs / 1000)} s` : "under 1 s";
}

// Inline code in a design line is the only markup the view renders.
function inline(text: string) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const READINGS: Record<string, any> = {
  "as-planned": ["as planned", "success"],
  partly: ["partly as planned", "warning"],
  untouched: ["planned but untouched", "warning"],
  unplanned: ["unplanned", "info"]
};

const ACTIONS: Record<string, any> = { ADD: "added", MODIFY: "changed", DELETE: "removed" };
const actualText = (item: any) => item.unit ? `${ACTIONS[item.action] ?? item.action} <code>${escapeHtml(item.unit)}</code>` : `${ACTIONS[item.action] ?? item.action} the file`;

function readingText(row: any) {
  const [label, tone] = READINGS[row.reading];
  const notes = [
    row.missing?.length ? `${row.missing.map((unit: any) => `<code>${escapeHtml(unit)}</code>`).join(", ")} not touched` : "",
    row.extra?.length ? `${plural(row.extra.length, "extra unit")}` : ""
  ].filter(Boolean).join("; ");
  return `${badge(label, tone)}${notes ? ` <span class="muted">${notes}</span>` : ""}`;
}

// Each Contract clause gets a badge for the tests cited for it, which opens their examples.
function clauseBadge(clause: any, view: any, ctx: any) {
  if (!view.examplesWritten) return "";
  if (!clause.examples.length) return `<span class="clause-tests">${badge("no test", "warning")}</span>`;
  return `<prism-disclosure class="clause-tests" summary="${plural(clause.examples.length, "test")}"><ul class="design-examples">${clause.examples.map((item: any) => `<li><span class="example-text">${inline(item.example)}</span> ${artifactChip(item.file, ctx, item.test)}</li>`).join("")}</ul></prism-disclosure>`;
}

const ACTION_LABELS: Record<string, any> = { add: "add", change: "change", remove: "remove" };
const ACTION_TITLES: Record<string, any> = { add: "A new file", change: "An existing file changes", remove: "An existing file is removed" };

// A unit chip names where the change lands; hovering it previews those lines, and clicking opens the file there.
function placeChips(change: any, ctx: any) {
  if (change.action === "add") return '<span class="change-where-new">new file</span>';
  // Without unit locations each named unit still shows, and its tip says why its lines are missing.
  if (!change.places) return change.units.map((unit: any) => `<prism-chip data-index-wait tip="${escapeHtml(indexReason(currentIndexStatus()))}"><code>${escapeHtml(unit)}</code><span slot="meta">lines –</span></prism-chip>`).join("");
  if (!change.places.length) return change.units.length ? '<span class="muted">not in the code index</span>' : '<span class="muted">the whole file</span>';
  const linked = ctx.hasArtifact(change.path);
  return change.places.map((place: any) => {
    if (place.startLine === null) return `<prism-chip tip="The code index has no ${escapeHtml(place.unit)} in this file, so the change adds it"><code>${escapeHtml(place.unit)}</code><span slot="meta">new</span></prism-chip>`;
    const label = `<code>${escapeHtml(place.unit)}</code><span slot="meta">${place.startLine}–${place.endLine}</span>`;
    return linked
      ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(change.path)}" data-doc-anchor="L${place.startLine}-${place.endLine}" tip="Open ${escapeHtml(change.path)} at line ${place.startLine}">${label}</prism-chip>`
      : `<prism-chip>${label}</prism-chip>`;
  }).join("");
}

function clauseLinks(clauses: any) {
  return clauses.map((number: any) => `<a href="#" class="clause-link clause-ref" data-clause="${number}">§${number}</a>`).join("");
}

// The footer says which Contract clauses a change serves and which tests stand behind them.
function changeFooter(changes: any, ctx: any) {
  const clauses = [...new Set(changes.flatMap((change: any) => change.clauses))].sort((left, right) => (left as any) - (right as any));
  if (!clauses.length) return '<footer class="change-entry-foot"><span class="muted">Supports the whole slice</span></footer>';
  const tests = [...new Map(changes.flatMap((change: any) => change.tests ?? []).map((item: any) => [`${item.file}#${item.test}`, item])).values()];
  return `<footer class="change-entry-foot">
    <span class="change-serves"><span class="change-label">Serves</span>${clauseLinks(clauses)}</span>
    <span class="change-tests">${tests.length ? `<span class="change-label">Tests</span>${tests.map((item) => artifactChip((item as any).file, ctx, (item as any).test)).join("")}` : badge("no test cited", "warning")}</span>
  </footer>`;
}

function verifiedRow(change: any, view: any) {
  return view.comparison?.find((item: any) => item.planned && item.planned.item === change.item && item.path === change.path) ?? null;
}

// One Changes line becomes one card: what happens to which file, where, why, and what checks it.
function changeCard(changes: any, view: any, ctx: any) {
  const action = changes[0].action;
  const rows = changes.map((change: any) => verifiedRow(change, view));
  const verified = rows.some(Boolean);
  const reading = verified ? (rows.every((row: any) => row?.reading === "as-planned") ? "as-planned" : rows.some((row: any) => row?.reading === "untouched") && rows.every((row: any) => !row || row.reading === "untouched") ? "untouched" : "partly") : null;
  const actionChip = chip(ACTION_LABELS[action] ?? escapeHtml(action), { tip: ACTION_TITLES[action] ?? action, attributes: ' class="change-action"' });
  const paths = changes.map((change: any, index: number) => `<div class="change-path-row">
      ${artifactChip(change.path, ctx)}${actionChip}
      <span class="change-where chip-row">${verified ? (rows[index] ? readingText(rows[index]) : "") : placeChips(change, ctx)}</span>
    </div>`).join("");
  // After verification, what the result actually did follows the plan's reason, path by path.
  const actual = rows.map((row: any, index: number) => row?.actual.length ? `<p class="change-actual"><span class="change-label">Actual</span>${changes.length > 1 ? `<code>${escapeHtml(changes[index].path)}</code>: ` : ""}${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</p>` : "").join("");
  return `<article class="change-entry action-${escapeHtml(action)}${reading ? ` reading-${reading}` : ""}">
    <header class="change-paths">${paths}</header>
    ${changes[0].note ? `<p class="change-why">${inline(changes[0].note)}</p>` : ""}
    ${actual}
    ${changeFooter(changes, ctx)}
  </article>`;
}

function listAfterHeading(root: any, title: string) {
  const heading = [...root.querySelectorAll("h2")].find((element) => element.textContent.trim().replace(/\s*#$/, "") === title);
  for (let node = heading?.nextElementSibling; node && node.tagName !== "H2"; node = node.nextElementSibling) {
    if (node.tagName === "OL" || node.tagName === "UL") return node;
  }
  return null;
}

// The rendered slice.md is the page; Prism's checks decorate its Contract items and turn its Changes items into cards.
function decorateDesign(root: string, view: any, ctx: any) {
  const contract = listAfterHeading(root, "Contract");
  if (contract) {
    [...contract.children].filter((item) => item.tagName === "LI").forEach((item, index) => {
      const clause = view.clauses[index];
      if (!clause) return;
      item.classList.add("design-clause");
      item.dataset.clauseNumber = String(clause.number);
      item.insertAdjacentHTML("beforeend", clauseBadge(clause, view, ctx));
    });
  }
  const changes = listAfterHeading(root, "Changes");
  if (changes) {
    const cards = [...changes.children].filter((item) => item.tagName === "LI").map((item, index) => {
      const named = view.changes.filter((change: any) => change.item === index);
      // A line Prism could not read stays as written, inside a card, so the reader still sees it.
      return named.length ? changeCard(named, view, ctx) : `<article class="change-entry is-unread"><p>${item.innerHTML}</p></article>`;
    });
    // The Changes list is where repository code is the subject, so it names files by their paths.
    changes.insertAdjacentHTML("afterend", `${indexNotice(view, currentIndexStatus())}<div class="change-list" data-code-subject>${cards.join("")}</div>`);
    changes.remove();
  }
}

// Without unit locations the cards cannot show the lines a change touches, so the notice above them says why, following the index chip live.
function indexReason(status: any) {
  const chip = chipState(status);
  return !status
    ? "Checking the code index for the lines each change touches."
    : status.state === "unavailable"
    ? "Prism has no code index on this platform, so the cards cannot show the lines each change touches."
    : status.state === "preparing"
      ? `The code index is being built (${escapeHtml([chip!.label, chip!.detail].filter(Boolean).join(", "))}). The lines each change touches appear here when it finishes.`
      : status.state === "failed" || status.state === "interrupted"
        ? "The last code index build did not finish, so the cards cannot show the lines each change touches. Open the index chip at the top for details."
        : status.state === "none"
          ? "The project has no code index yet, so the cards cannot show the lines each change touches. Prism starts building it when its server starts."
          : "The current code index was built before Prism recorded unit locations. They appear after the next index build, which starts when the Prism server restarts.";
}

function indexNotice(view: any, status: any) {
  if (!view || view.indexed || view.comparison || !view.changes.some((change: any) => change.action !== "add")) return "";
  return `<div class="notice index-notice" data-index-notice>${indexReason(status)}</div>`;
}

// A slice of a split scope has no Contract of its own, so the page lists the scope's clauses its Changes serve.
function servedClauses(view: any, ctx: any, titles: any = {}) {
  if (!view?.contract || !view.clauses.length) return "";
  return `<div class="served-clauses"><p class="change-label">Contract clauses this slice serves, from ${artifactChip(view.contract.path, ctx, `${titles[view.contract.slice] ?? "Scope"} · Design`)}</p><ol>${view.clauses.map((clause: any) => `<li value="${clause.number}" class="design-clause" data-clause-number="${clause.number}">${inline(clause.text)}${clauseBadge(clause, view, ctx)}</li>`).join("")}</ol></div>`;
}

function designNotices(view: any) {
  if (!view) return "";
  const notes = [];
  if (view.stale.length) notes.push(`<div class="notice"><p>The test examples describe an earlier version of this design: ${view.stale.map(escapeHtml).join(" ")}</p></div>`);
  if (view.gaps.length) notes.push(`<p>${badge(view.gaps.length === 1 ? "1 clause without a test" : `${view.gaps.length} clauses without a test`, "warning")} ${view.gaps.map((number: any) => `<a href="#" class="clause-link" data-clause="${number}">§${number}</a>`).join(", ")}</p>`);
  if (view.changeProblems.length) notes.push(`<ul class="plain-list error">${view.changeProblems.map((problem: any) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`);
  if (!view.examplesWritten && view.clauses.length) notes.push('<p class="muted">No test examples were written for this design, so the tests behind each clause are not shown.</p>');
  return notes.join("");
}

function unplannedCard(view: any, ctx: any) {
  const rows = view?.comparison?.filter((row: any) => !row.planned) ?? [];
  if (!rows.length) return "";
  return card("Changed without a plan", `<ul class="row-list" data-code-subject>${rows.map((row: any) => `<li>${artifactChip(row.path, ctx)} <span class="muted">${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</span></li>`).join("")}</ul>`, { eyebrow: "The verified result changed these files, and Changes does not name them" });
}

function changeMapLine(path: any, state: any, ctx: any) {
  if (state?.pending) return "<p>Building the change map from the verified result.</p>";
  if (state?.failed) return `<p class="error">The change map could not be derived: ${escapeHtml(state.failed)}</p>`;
  if (state?.empty) return "<p>The verified result changed no source compared with the design.</p>";
  return path ? `<p>${artifactChip(path, ctx, "Open the change map")}</p>` : "";
}

// A slice designed before slice.md carried a contract may still have a hand-written change map.
function legacyChangeMapCard(path: any, ctx: any) {
  if (!path) return "";
  return card("Change map", `<p>The planned changes and their readiness.</p><p>${artifactChip(path, ctx, "Open the change map")}</p>`);
}

// A failing name that exactly one frozen test names opens that test at the line naming it; any other stays text.
function failingList(run: any) {
  const more = (run.failingCount ?? run.failing.length) - run.failing.length;
  const links = new Map((run.failingLinks ?? []).filter((link: any) => link.path).map((link: any) => [link.name, link]));
  const item = (name: string) => {
    const link: any = links.get(name);
    return link
      ? `<prism-chip interactive tone="accent" data-code-subject data-frozen-test="${escapeHtml(link.path)}" data-frozen-line="${link.line}" tip="${escapeHtml(`${link.path}, line ${link.line}`)}">${escapeHtml(name)}</prism-chip>`
      : `<prism-chip data-code-subject tip="No frozen test names this test">${escapeHtml(name)}</prism-chip>`;
  };
  return `<span class="code-list">${run.failing.map(item).join(" ")}${more > 0 ? ` <span class="muted">and ${more} more</span>` : ""}</span>`;
}

// The line names the last passing run, which need not be the latest run shown above it; a malformed shared record shows nothing.
// On a known host the branch, commit, and repository link to the remote's web pages.
export function codeLine(code: any) {
  const parts = codeParts(code);
  if (!parts) return "";
  return `<p class="muted">Last passing run ${parts.branch ? `on ${parts.branch} ` : ""}at ${parts.commit}${parts.remote ? ` · ${parts.remote}` : ""}${code.dirty === true ? " with uncommitted changes" : ""}</p>`;
}

// Verification shows the accepted design's frozen tests, the latest run of the project's test command, and the derived change map;
// a frozen test, a failing test, and the run's log open in the side panel.
function verificationCard(design: any, run: any, code = null) {
  if (!design && !run) return "";
  const result = run ? `<p>${badge(run.passed ? "passed" : "failed", run.passed ? "success" : "danger")} ${escapeHtml(formatTime(run.finishedAt))}${run.reason ? `: ${escapeHtml(REASONS[run.reason] ?? run.reason)}` : ""}</p>` : emptyNote("No verification run yet.");
  return card("Verification", `
    ${result}
    ${codeLine(code)}
    ${keyValues([
      ["Design accepted", design ? escapeHtml(formatTime(design.acceptedAt)) : null],
      ["Review", design ? (design.review === "required" ? "required" : "not required") : null],
      ["Frozen tests", design?.frozenTests.length ? `<span class="code-list">${design.frozenTests.map((item: any) => `<prism-chip interactive tone="accent" data-code-subject data-frozen-test="${escapeHtml(item.path)}" tip="${escapeHtml(item.path)}">${escapeHtml(item.path)}</prism-chip>`).join(" ")}</span>` : null],
      ["Command", run ? `<code>${escapeHtml(run.command)}</code>` : null],
      ["Duration", run?.durationMs ? seconds(run.durationMs) : null],
      ["Exit code", run && run.exitCode !== null ? String(run.exitCode) : null],
      ["Output", run?.outputTail || run?.log ? `<prism-button size="sm" data-verification-log="${escapeHtml(run.id)}"><prism-icon slot="start" name="file" size="sm"></prism-icon>Open the log</prism-button>` : null],
      ["Failing tests", run?.failing?.length ? failingList(run) : null]
    ])}
`, { eyebrow: "Latest run" });
}

const BYTES = (size: number) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

// Where the log came from decides its note: the whole file on this machine, its end when it is large, or the end the shared record keeps.
// The log opens at its end, so the note follows it there, and a log shown from part way through starts with an ellipsis line.
function logNote(log: any) {
  if (log.source === "log") return log.cut ? `<prism-banner class="verification-log-note" tone="info"><p>The log is ${BYTES(log.size)}, so the panel shows its last ${BYTES(log.shown)}, above.</p></prism-banner>` : "";
  if (log.complete) return "";
  const machine = log.host ? `<strong>${escapeHtml(log.host)}</strong>, the machine that ran the command` : "the machine that ran the command";
  const where = log.log ? `, at <code>${escapeHtml(log.log)}</code>` : ", in Prism's plugin data";
  return `<prism-banner class="verification-log-note" tone="info"><p>The shared record keeps only the last 4,000 characters of the output, shown above. The full log is on ${machine}${where}.</p></prism-banner>`;
}

function logHtml(log: any) {
  const partial = log.source === "log" ? log.cut : !log.complete;
  const text = log.content ? `<prism-code class="verification-log"><pre><code>${partial ? "…\n" : ""}${escapeHtml(log.content)}</code></pre></prism-code>` : '<p class="muted">The command printed nothing.</p>';
  return `${text}${logNote(log)}`;
}

// The log opens in the side panel at its end, where a test runner prints its failures and summary.
async function openLog(run: any, data: any, ctx: any) {
  const title = { eyebrow: "Verification log", name: `${run.passed ? "Passed" : "Failed"} run · ${formatTime(run.finishedAt)}`, detail: run.command ?? null };
  ctx.sidePanel.showContent({ ...title, html: '<p class="muted side-panel-loading">Loading…</p>' });
  const shown = ctx.sidePanel.current();
  let html;
  try {
    html = logHtml(await ctx.fetchJson(`./api/verification-log?initiative=${encodeURIComponent(data.id)}&slice=${encodeURIComponent(data.slug)}&id=${encodeURIComponent(run.id)}`));
  } catch (error) {
    html = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
  // Another item opened while the log loaded keeps the panel.
  if (ctx.sidePanel.current() === shown) ctx.sidePanel.showContent({ ...title, html, at: "end" });
}

function openFrozenTest(path: string, line: any, data: any, ctx: any) {
  const url = `./api/frozen-test?initiative=${encodeURIComponent(data.id)}&slice=${encodeURIComponent(data.slug)}&path=${encodeURIComponent(path)}`;
  void ctx.sidePanel.show(path, line ? `L${line}` : null, { url, eyebrow: "Frozen test", tab: ctx.hasArtifact(path) });
}

// The slice folder may hold any number of diagrams, or none; the code view comes first when it exists.
function diagramLabel(file: string) {
  const name = file!.split("/").pop()!.replace(/\.puml$/, "");
  return name === "code" ? "Code view" : words(name);
}

function words(name: string) {
  const text = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return text ? text.replace(/^./, (letter) => letter.toUpperCase()) : name;
}

// A file of the slice folder reads by its kind, and a diagram by its name; another file, such as code, keeps its path.
function fileLabel(file: string, folder: string) {
  const relative = file.slice(folder.length + 1);
  const parts = relative.split("/");
  const where = parts.length > 1 ? `${parts.slice(0, -1).map(words).join(" › ")} · ` : "";
  if (file.toLowerCase().endsWith(".puml")) return { label: `${where}${diagramLabel(file)} · Diagram` };
  const kind = recordKind(file);
  if (!kind) return { label: relative, code: true };
  if (kind === "Document" || kind === "Record") return { label: `${where}${words((parts.at(-1) as any))} · ${kind}` };
  return { label: `${where}${kind}` };
}

// The Views tab: each view of the slice folder as a card named by its question, and on a scope's page each planned slice's views under its title.
function viewCount(views: any) {
  return (views?.own.length ?? 0) + (views?.slices ?? []).reduce((sum: any, group: any) => sum + group.views.length, 0);
}

function viewsPanel(views: any, ctx: any) {
  if (!viewCount(views)) {
    const none = views?.without?.length ? `<p class="slice-views-none">${escapeHtml(views.without.map((entry: any) => entry.title).join(", "))} ${views.without.length === 1 ? "has" : "have"} no views or diagrams.</p>` : "";
    return emptyState("No views", "This design declares no views and its folder holds no diagrams. Its contract and Changes are on the Design tab.") + none;
  }
  const group = (entry: any) => `<prism-panel class="slice-views-group" variant="plain" level="2" region heading="${escapeHtml(entry.title)}" eyebrow="Planned slice"><div slot="tools">${artifactChip(`slice:${ctx.sliceId}/${entry.slug}`, ctx, "Open slice")}</div>${entry.views.map((view: any) => viewCardHtml(view, 3)).join("")}</prism-panel>`;
  const none = views.without.length ? `<p class="slice-views-none">${escapeHtml(views.without.map((entry: any) => entry.title).join(", "))} ${views.without.length === 1 ? "has" : "have"} no views or diagrams.</p>` : "";
  return `<section class="slice-views" data-views aria-label="Views">${views.own.map((view: any) => viewCardHtml(view)).join("")}${views.slices.map(group).join("")}${none}</section>`;
}

// The drawings are made when the tab first shows, one view at a time, as the PlantUML runtime draws them.
async function mountViews(container: any, views: any, ctx: any) {
  const area = container.querySelector("[data-views]");
  if (!area || area.dataset.mounted) return;
  area.dataset.mounted = "true";
  markViewFiles(area);
  const all = [...views.own, ...views.slices.flatMap((group: any) => group.views)];
  for (const card of area.querySelectorAll(".view-region")) {
    const view = all.find((item) => item.path === card.dataset.view);
    if (!view || view.kind === "api" || view.source === null) continue;
    try { await ctx.drawView(card, view.source); }
    catch (error) { card.querySelector(".diagram-output").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
  }
}

const PHASES = [["requirements", "Requirements"], ["design", "Design"], ["frozen", "Frozen"], ["build", "Build"], ["review", "Review"], ["shipped", "Shipped"]];

// A review is clean once it has no unresolved finding and its current wave is accepted.
function reviewClean(review: any) {
  return Boolean(review) && !review.invalid && review.unresolved === 0 && review.blocking === 0 && review.currentWave?.accepted !== false;
}

/**
 * The index of the slice's current phase in PHASES, or PHASES.length when every phase is done: requirements are always done;
 * design is current until the slice has an accepted design, frozen while it has one and has not started, review while a passing
 * verification waits on a required review that is not clean, build while it is in progress without a passing verification, and shipped once it is done.
 */
export function currentPhase(slice: any, { verification = null, review = null }: any = {}) {
  if (slice.status === "done") return PHASES.length;
  if (!slice.design) return 1;
  if (slice.status === "not-started") return 2;
  const passed = Boolean(verification?.passed);
  if (!passed) return 3;
  if (slice.design.review === "required" && !reviewClean(review)) return 4;
  return 5;
}

function stepper(slice: string, data: any) {
  const current = currentPhase(slice, { verification: data.verification, review: data.artifacts?.review ?? null });
  return `<prism-stepper class="slice-lifecycle" label="Lifecycle">${PHASES.map(([phase, label], index) => `<prism-step phase="${phase}" state="${index < current ? "done" : index === current ? "current" : "upcoming"}">${label}</prism-step>`).join("")}</prism-stepper>`;
}

const TABS = [["design", "Design", "document"], ["views", "Views", "diagram"], ["verification", "Verification", "flask"], ["review", "Review", "eye"], ["files", "Files", "file"], ["change-map", "Change map", "grid"]];
// The Files tab and the verified result replace the change map, so its tab is last and says it is deprecated.
const DEPRECATED: Record<string, any> = { "change-map": "Replaced by the Files tab and the verified result; kept until existing slices no longer need it." };

// The count a sub-tab carries: the views, the review ledger's open findings, and the slice folder's files.
function tabCount(value: any, artifacts: any, views: any) {
  if (value === "views") return viewCount(views);
  if (value === "review" && artifacts.review && !artifacts.review.invalid && artifacts.review.unresolved) return artifacts.review.unresolved;
  if (value === "files" && artifacts.files.length) return artifacts.files.length;
  return 0;
}

function tabHtml([value, label, icon]: any, selected: any, artifacts: any, views: any) {
  const count = tabCount(value, artifacts, views);
  const deprecated = DEPRECATED[value];
  const end = count ? ` <prism-badge slot="end" variant="count">${count}</prism-badge>` : deprecated ? ' <prism-badge slot="end" tone="neutral" variant="status">Deprecated</prism-badge>' : "";
  return `<prism-tab value="${value}"${selected ? " selected" : ""}${deprecated ? ` tip="${escapeHtml(deprecated)}"` : ""}><prism-icon slot="start" name="${icon}" size="sm"></prism-icon>${label}${end}</prism-tab>`;
}

const STATUS_WORDS: Record<string, any> = { "not-started": "not started", "in-progress": "in progress", blocked: "blocked", split: "split", done: "done" };

// The head's phase tag: the phase the slice is in, with its gate or status, such as "Design · design gate open" or "Build · in progress".
function phaseTag(slice: any, data: any) {
  const index = currentPhase(slice, { verification: data.verification, review: data.artifacts?.review ?? null });
  const [phase, label] = PHASES[Math.min(index, PHASES.length - 1)];
  const state = data.designReview === "waiting" ? "design gate open" : data.designReview === "answered" ? "design gate answered" : index >= PHASES.length ? null : STATUS_WORDS[slice.status] ?? slice.status;
  const words = index >= PHASES.length ? "Shipped" : [label, state].filter(Boolean).join(" · ");
  return `<prism-phase variant="tag" phase="${phase}">${escapeHtml(words)}</prism-phase>`;
}

function changeMapPanel(slice: any, artifacts: any, data: any, ctx: any) {
  const line = slice.design ? changeMapLine(artifacts.changeMap, data.changeMap, ctx) : legacyChangeMapCard(artifacts.changeMap, ctx);
  if (!line) return emptyState("No change map yet", slice.design ? "The change map is derived from the slice's first passing verification." : "The slice has no change map.");
  return slice.design ? card("Change map", line, { eyebrow: "Derived from the verified result" }) : line;
}

// The Files tab shows the files the slice's latest passing run verified, read after the page renders, and then the slice folder.
function filesPanel(artifacts: any, ctx: any) {
  const verified = '<div class="slice-verified-files" data-slice-files><prism-spinner label="Loading the verified files"></prism-spinner></div>';
  if (!artifacts.files.length) return verified + emptyState("No files yet", "The slice folder is empty.");
  return verified + card("Slice folder", `<ul class="row-list">${artifacts.files.map((file: string) => {
    const { label, code } = fileLabel(file, artifacts.folder);
    return `<li${code ? " data-code-subject" : ""}>${artifactChip(file, ctx, label)}</li>`;
  }).join("")}</ul>`, { eyebrow: plural(artifacts.files.length, "file") });
}

// The page bar's actions for the slice: copy the page's address, open or close the side panel with the slice's diagram, and show the slice's details and its initiative's settings.
function pageActions(diagrams: any, ctx: any, details: any) {
  if (!ctx.setPageActions || typeof document === "undefined") return;
  const button = (text: string) => {
    const element = document.createElement("prism-button");
    element.setAttribute("size", "sm");
    element.setAttribute("variant", "ghost");
    element.textContent = text;
    return element;
  };
  const copy = button("Copy link");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      ctx.showToast("Link copied.");
    } catch {
      ctx.showToast("The browser did not allow copying the link.");
    }
  });
  const side = button("Side panel");
  side.setAttribute("pressed", String(Boolean(ctx.sidePanel?.isOpen())));
  side.toggleAttribute("disabled", !diagrams.length || !ctx.sidePanel);
  side.addEventListener("click", () => {
    if (ctx.sidePanel.isOpen()) ctx.sidePanel.close();
    else void ctx.sidePanel.show(diagrams[0]);
  });
  const follow = (event: any) => {
    if (!side.isConnected) {
      document.removeEventListener("prism:side-panel", follow);
      return;
    }
    side.setAttribute("pressed", String(Boolean(event.detail?.open)));
  };
  document.addEventListener("prism:side-panel", follow);
  const more = button("Details and settings");
  more.toggleAttribute("disabled", !details);
  more.setAttribute("aria-haspopup", "dialog");
  more.addEventListener("click", () => details?.show());
  ctx.setPageActions([copy, side, more]);
}

export async function render(container: any, entity: any, ctx: any) {
  const data = entity.data;
  const slice = data.slice;
  const view = data.designView;
  const artifacts = data.artifacts ?? { files: [] };
  // Diagrams directly in the slice folder, such as the code view, are the design's picture.
  const diagrams = artifacts.files.filter((file: string) => file.endsWith(".puml") && file.slice(artifacts.folder.length + 1).indexOf("/") === -1).sort((left: any, right: any) => Number(right.endsWith("/code.puml")) - Number(left.endsWith("/code.puml")) || left.localeCompare(right));
  const held = slice.claim || slice.expiredClaim ? { claim: slice.claim ?? slice.expiredClaim, scope: null } : data.coveringClaim ? { claim: data.coveringClaim.claim, scope: { slug: data.coveringClaim.slug, title: data.coveringClaim.title } } : null;
  const views = data.views ?? { own: [], slices: [], without: [] };
  // A clause link from another page opens the Design tab at that clause; a page last left on the Diagram tab opens on Views.
  const clause = takeClause(`slice:${data.id}/${data.slug}`);
  if (clause) ctx.state.tab = "design";
  else if (ctx.state.tab === "diagram") ctx.state.tab = "views";
  const tab = TABS.some(([value]) => value === ctx.state.tab) ? ctx.state.tab : "design";
  const panels: Record<string, any> = {
    design: artifacts.narrative
      ? `<section class="view-section design-document" aria-label="Design">${designNotices(view)}${servedClauses(view, ctx, data.titles)}<prism-doc class="document-content" data-narrative><prism-spinner label="Loading the design"></prism-spinner></prism-doc></section>${unplannedCard(view, ctx)}`
      : `${emptyState("No design yet", "The slice has no design document yet.")}${unplannedCard(view, ctx)}`,
    views: viewsPanel(views, { ...ctx, sliceId: data.id }),
    verification: verificationCard(slice.design, data.verification, data.code) + sliceRunTotalsHtml(data.runTotals, data.children.length > 0) || emptyState("No verification yet", "The slice has no accepted design or verification run yet."),
    review: reviewPanel(artifacts.review, ctx),
    "change-map": changeMapPanel(slice, artifacts, data, ctx),
    files: filesPanel(artifacts, ctx)
  };
  const designNote = data.designReview ? `<p class="muted">${data.designReview === "answered" ? "You answered the design question; the agent accepts or revises the design next." : "The design waits for your answer on the Attention page."}</p>` : "";
  container.innerHTML = `${shippedHistoryHtml(data.shippedHistory)}
    <div class="slice-head-tags"><span class="chip-row">${phaseTag(slice, data)}${requirementLinks(slice.requirements, ctx, { icon: "list" })}${componentChip(slice.component)}${data.complete && slice.status === "split" ? badge("all descendants done", "success") : ""}</span>${held ? `<span class="slice-head-claim">${claimChip(held, "inline")}</span>` : ""}</div>
    ${stepper(slice, data)}
    <prism-tabs class="slice-tabs" label="Slice" data-slice-tabs>${TABS.map((entry) => tabHtml((entry as any), entry[0] === tab, artifacts, views)).join("")}</prism-tabs>
    ${TABS.map(([value, label]) => `<div class="slice-tab-pane" role="tabpanel" aria-label="${label}" data-tab-panel="${value}"${value === tab ? "" : " hidden"}>${panels[value]}</div>`).join("")}
    <prism-dialog class="slice-details" heading="Details and settings" size="lg" data-slice-details>
      <section class="slice-details-facts" aria-label="Details">
        <div class="chip-row">${data.designReview ? statusBadge("design-review") : statusBadge(slice.status)}${artifactChip(`initiative:${data.id}`, ctx, data.initiativeTitle)}</div>
        ${designNote}
        ${slice.outcome ? `<p class="item-intent is-large">${escapeHtml(slice.outcome)}</p>` : '<p class="muted">No outcome is recorded for this slice.</p>'}
        ${keyValues([
          ["Slug", `<code>${escapeHtml(data.slug)}</code>`],
          ["Requirements", `<span class="chip-row">${requirementLinks(slice.requirements, ctx)}</span>`],
          ["Parent", slice.parent ? sliceChip(data, slice.parent, ctx) : '<span class="muted">root slice</span>'],
          ["Children", data.children.length ? `<span class="chip-row">${data.children.map((slug: string) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
          ["Depends on", data.effectiveDependencies?.length ? `<span class="chip-row">${data.effectiveDependencies.map((slug: string) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
          ["Needed by", data.dependents.length ? `<span class="chip-row">${data.dependents.map((slug: string) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
          ["Work in progress", presenceChips(entity.presence) || null],
          ["Active work", data.active.length ? `<span class="chip-row">${data.active.map((entry: any) => badge(`${entry.activity} · ${(entry.workers ?? []).join(", ")}${entry.label ? ` · ${entry.label}` : ""}`, "info")).join("")}</span>` : null]
        ])}
      </section>
      <div data-initiative-settings></div>
    </prism-dialog>`;
  // A slice page changes its initiative's settings, so the card names the initiative they belong to.
  const settings = mountInitiativeSettings(container.querySelector("[data-initiative-settings]"), { target: `slice:${data.id}/${data.slug}`, eyebrow: `Initiative: ${data.initiativeTitle}`, ctx });
  const details = container.querySelector("[data-slice-details]");
  // A link in the dialog opens its page, so the dialog closes first.
  details.addEventListener("click", (event: any) => {
    if (event.target.closest?.("prism-chip[data-artifact], a[data-artifact]")) details.close();
  });
  bindLinks(container, ctx);
  // The side panel opens on the slice's first declared drawing, and else on the folder's first diagram.
  const drawings = [...new Set([...views.own.filter((item: any) => item.path.endsWith(".puml")).map((item: any) => item.path), ...diagrams])];
  pageActions(drawings, ctx, details);
  void mountSliceFiles(container.querySelector("[data-slice-files]"), data);
  const showTab = (value: any) => {
    ctx.state.tab = value;
    for (const panel of container.querySelectorAll("[data-tab-panel]")) panel.hidden = panel.dataset.tabPanel !== value;
    if (value === "views") void mountViews(container, views, ctx);
  };
  container.querySelector("[data-slice-tabs]")?.addEventListener("prism-select", (event: any) => {
    if (event.target === event.currentTarget && event.detail?.value) showTab(event.detail.value);
  });
  const highlightClause = (number: any) => {
    const target = container.querySelector(`[data-tab-panel="design"] .design-clause[data-clause-number="${CSS.escape(String(number))}"]`);
    if (!target) return false;
    if (ctx.state.tab !== "design") {
      showTab("design");
      container.querySelector("[data-slice-tabs]").value = "design";
    }
    target.scrollIntoView({ block: "center" });
    target.classList.remove("is-target");
    void target.offsetWidth;
    target.classList.add("is-target");
    return true;
  };
  // A view's clause opens the Design tab at that clause when the page lists it, and else the contract's page; its contract chip opens the contract's page.
  bindViewLinks(container, (ref: any, number: any) => {
    if (number && highlightClause(number)) return;
    requestClause(ref, number);
    ctx.openArtifact(ref);
  });
  container.addEventListener("click", (event: any) => {
    const action = event.target.closest("[data-action]");
    const card = action?.closest(".view-region");
    if (!card || !container.contains(card)) return;
    if (action.dataset.action === "open") ctx.openArtifact(card.dataset.view);
    else if (action.dataset.action === "copy-view") {
      const view = [...views.own, ...views.slices.flatMap((group: any) => group.views)].find((item) => item.path === card.dataset.view);
      navigator.clipboard.writeText(view?.source ?? "").then(() => ctx.showToast("API specification copied."), () => ctx.showToast("The browser could not copy the specification."));
    }
  });
  // A frozen test, a failing test, and the run's log open in the side panel.
  container.addEventListener("click", (event: any) => {
    const test = event.target.closest("[data-frozen-test]");
    const log = event.target.closest("[data-verification-log]");
    if (!ctx.sidePanel || !(test || log) || !container.contains(test ?? log)) return;
    event.preventDefault();
    if (test) openFrozenTest(test.dataset.frozenTest, test.dataset.frozenLine ?? null, data, ctx);
    else void openLog(data.verification, data, ctx);
  });
  container.addEventListener("click", (event: any) => {
    const link = event.target.closest("[data-clause]");
    if (!link || !container.contains(link) || link.dataset.viewClause) return;
    event.preventDefault();
    highlightClause(link.dataset.clause);
  });
  const narrativeTarget = container.querySelector("[data-narrative]");
  if (narrativeTarget) {
    try {
      const narrative = await ctx.fetchArtifact(artifacts.narrative);
      narrativeTarget.innerHTML = ctx.renderMarkdown(narrative.content, artifacts.narrative);
      // The page's title already names the slice, so the design's own title does not repeat it.
      const titles = narrativeTarget.querySelectorAll("h1");
      if (titles.length === 1) titles[0].remove();
      if (view) decorateDesign(narrativeTarget, view, ctx);
    } catch (error) {
      narrativeTarget.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }
  if (artifacts.review && !artifacts.review.invalid) await mountReviewLedger(container, artifacts.review, ctx);
  if (tab === "views") await mountViews(container, views, ctx);
  // The page shows once drawn, so its settings card's first listing is drawn before it does.
  await (settings as any)?.loaded;
  if (clause) highlightClause(clause);
  // While the cards wait for unit locations, the notice follows the index chip, and a finished build redraws the page with the lines.
  if (container.querySelector("[data-index-notice]")) {
    const builtAt = (status: any) => status?.state === "ready" ? status.index?.builtAt ?? "" : null;
    let seen = builtAt(currentIndexStatus());
    const follow = (event: any) => {
      const notice = container.querySelector("[data-index-notice]");
      if (!container.isConnected || !notice) { document.removeEventListener("prism:indexing", follow); return; }
      // Only a newly published index can carry the locations, so an index already seen does not redraw the page again.
      const now = builtAt(event.detail);
      if (now !== null && now !== seen) { document.removeEventListener("prism:indexing", follow); ctx.rerender(); return; }
      seen = now ?? seen;
      notice.outerHTML = indexNotice(view, event.detail);
      container.querySelectorAll("[data-index-wait]").forEach((chip: any) => { chip.setAttribute("tip", indexReason(event.detail)); });
    };
    document.addEventListener("prism:indexing", follow);
  }
}
