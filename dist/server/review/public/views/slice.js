// Generated from src/server/review/public/views/slice.ts by scripts/native-build/compile.mjs.
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
function sliceChip(data, slug, ctx) {
  return artifactChip(`slice:${data.id}/${slug}`, ctx, data.titles[slug] ?? slug);
}
function reviewPanel(review, ctx) {
  if (!review) return emptyState("No review yet", "No review has started for this slice.");
  if (review.invalid) return `<p class="error">The review ledger is not valid JSON.</p>${artifactChip(review.path, ctx, "Open raw")}`;
  return '<div class="slice-review-ledger" data-review-ledger><prism-spinner label="Loading the review ledger"></prism-spinner></div>';
}
async function mountReviewLedger(container, review, ctx) {
  const target = container.querySelector("[data-review-ledger]");
  if (!target) return;
  try {
    const artifact = await ctx.fetchArtifact(review.path);
    if (!target.isConnected && target.isConnected !== void 0) return;
    ctx.state.ledger ??= {};
    mountLedger(target, artifact, ctx, ctx.state.ledger);
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
const REASONS = {
  frozen_tests_changed: "the frozen acceptance tests changed, so the command did not run",
  cancelled: "the run was cancelled",
  timed_out: "the command ran past its timeout",
  command_failed: "the test command failed",
  tracked_files_changed: "the command changed project files while it ran"
};
function seconds(durationMs) {
  return durationMs >= 6e4 ? `${Math.round(durationMs / 6e4)} min` : durationMs >= 1e3 ? `${Math.round(durationMs / 1e3)} s` : "under 1 s";
}
function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}
const READINGS = {
  "as-planned": ["as planned", "success"],
  partly: ["partly as planned", "warning"],
  untouched: ["planned but untouched", "warning"],
  unplanned: ["unplanned", "info"]
};
const ACTIONS = { ADD: "added", MODIFY: "changed", DELETE: "removed" };
const actualText = (item) => item.unit ? `${ACTIONS[item.action] ?? item.action} <code>${escapeHtml(item.unit)}</code>` : `${ACTIONS[item.action] ?? item.action} the file`;
function readingText(row) {
  const [label, tone] = READINGS[row.reading];
  const notes = [
    row.missing?.length ? `${row.missing.map((unit) => `<code>${escapeHtml(unit)}</code>`).join(", ")} not touched` : "",
    row.extra?.length ? `${plural(row.extra.length, "extra unit")}` : ""
  ].filter(Boolean).join("; ");
  return `${badge(label, tone)}${notes ? ` <span class="muted">${notes}</span>` : ""}`;
}
function clauseBadge(clause, view, ctx) {
  if (!view.examplesWritten) return "";
  if (!clause.examples.length) return `<span class="clause-tests">${badge("no test", "warning")}</span>`;
  return `<prism-disclosure class="clause-tests" summary="${plural(clause.examples.length, "test")}"><ul class="design-examples">${clause.examples.map((item) => `<li><span class="example-text">${inline(item.example)}</span> ${artifactChip(item.file, ctx, item.test)}</li>`).join("")}</ul></prism-disclosure>`;
}
const ACTION_LABELS = { add: "add", change: "change", remove: "remove" };
const ACTION_TITLES = { add: "A new file", change: "An existing file changes", remove: "An existing file is removed" };
function placeChips(change, ctx) {
  if (change.action === "add") return '<span class="change-where-new">new file</span>';
  if (!change.places) return change.units.map((unit) => `<prism-chip data-index-wait tip="${escapeHtml(indexReason(currentIndexStatus()))}"><code>${escapeHtml(unit)}</code><span slot="meta">lines \u2013</span></prism-chip>`).join("");
  if (!change.places.length) return change.units.length ? '<span class="muted">not in the code index</span>' : '<span class="muted">the whole file</span>';
  const linked = ctx.hasArtifact(change.path);
  return change.places.map((place) => {
    if (place.startLine === null) return `<prism-chip tip="The code index has no ${escapeHtml(place.unit)} in this file, so the change adds it"><code>${escapeHtml(place.unit)}</code><span slot="meta">new</span></prism-chip>`;
    const label = `<code>${escapeHtml(place.unit)}</code><span slot="meta">${place.startLine}\u2013${place.endLine}</span>`;
    return linked ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(change.path)}" data-doc-anchor="L${place.startLine}-${place.endLine}" tip="Open ${escapeHtml(change.path)} at line ${place.startLine}">${label}</prism-chip>` : `<prism-chip>${label}</prism-chip>`;
  }).join("");
}
function clauseLinks(clauses) {
  return clauses.map((number) => `<a href="#" class="clause-link clause-ref" data-clause="${number}">\xA7${number}</a>`).join("");
}
function changeFooter(changes, ctx) {
  const clauses = [...new Set(changes.flatMap((change) => change.clauses))].sort((left, right) => left - right);
  if (!clauses.length) return '<footer class="change-entry-foot"><span class="muted">Supports the whole slice</span></footer>';
  const tests = [...new Map(changes.flatMap((change) => change.tests ?? []).map((item) => [`${item.file}#${item.test}`, item])).values()];
  return `<footer class="change-entry-foot">
    <span class="change-serves"><span class="change-label">Serves</span>${clauseLinks(clauses)}</span>
    <span class="change-tests">${tests.length ? `<span class="change-label">Tests</span>${tests.map((item) => artifactChip(item.file, ctx, item.test)).join("")}` : badge("no test cited", "warning")}</span>
  </footer>`;
}
function verifiedRow(change, view) {
  return view.comparison?.find((item) => item.planned && item.planned.item === change.item && item.path === change.path) ?? null;
}
function changeCard(changes, view, ctx) {
  const action = changes[0].action;
  const rows = changes.map((change) => verifiedRow(change, view));
  const verified = rows.some(Boolean);
  const reading = verified ? rows.every((row) => row?.reading === "as-planned") ? "as-planned" : rows.some((row) => row?.reading === "untouched") && rows.every((row) => !row || row.reading === "untouched") ? "untouched" : "partly" : null;
  const actionChip = chip(ACTION_LABELS[action] ?? escapeHtml(action), { tip: ACTION_TITLES[action] ?? action, attributes: ' class="change-action"' });
  const paths = changes.map((change, index) => `<div class="change-path-row">
      ${artifactChip(change.path, ctx)}${actionChip}
      <span class="change-where chip-row">${verified ? rows[index] ? readingText(rows[index]) : "" : placeChips(change, ctx)}</span>
    </div>`).join("");
  const actual = rows.map((row, index) => row?.actual.length ? `<p class="change-actual"><span class="change-label">Actual</span>${changes.length > 1 ? `<code>${escapeHtml(changes[index].path)}</code>: ` : ""}${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</p>` : "").join("");
  return `<article class="change-entry action-${escapeHtml(action)}${reading ? ` reading-${reading}` : ""}">
    <header class="change-paths">${paths}</header>
    ${changes[0].note ? `<p class="change-why">${inline(changes[0].note)}</p>` : ""}
    ${actual}
    ${changeFooter(changes, ctx)}
  </article>`;
}
function listAfterHeading(root, title) {
  const heading = [...root.querySelectorAll("h2")].find((element) => element.textContent.trim().replace(/\s*#$/, "") === title);
  for (let node = heading?.nextElementSibling; node && node.tagName !== "H2"; node = node.nextElementSibling) {
    if (node.tagName === "OL" || node.tagName === "UL") return node;
  }
  return null;
}
function decorateDesign(root, view, ctx) {
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
      const named = view.changes.filter((change) => change.item === index);
      return named.length ? changeCard(named, view, ctx) : `<article class="change-entry is-unread"><p>${item.innerHTML}</p></article>`;
    });
    changes.insertAdjacentHTML("afterend", `${indexNotice(view, currentIndexStatus())}<div class="change-list" data-code-subject>${cards.join("")}</div>`);
    changes.remove();
  }
}
function indexReason(status) {
  const chip2 = chipState(status);
  return !status ? "Checking the code index for the lines each change touches." : status.state === "unavailable" ? "Prism has no code index on this platform, so the cards cannot show the lines each change touches." : status.state === "preparing" ? `The code index is being built (${escapeHtml([chip2.label, chip2.detail].filter(Boolean).join(", "))}). The lines each change touches appear here when it finishes.` : status.state === "failed" || status.state === "interrupted" ? "The last code index build did not finish, so the cards cannot show the lines each change touches. Open the index chip at the top for details." : status.state === "none" ? "The project has no code index yet, so the cards cannot show the lines each change touches. Prism starts building it when its server starts." : "The current code index was built before Prism recorded unit locations. They appear after the next index build, which starts when the Prism server restarts.";
}
function indexNotice(view, status) {
  if (!view || view.indexed || view.comparison || !view.changes.some((change) => change.action !== "add")) return "";
  return `<div class="notice index-notice" data-index-notice>${indexReason(status)}</div>`;
}
function servedClauses(view, ctx, titles = {}) {
  if (!view?.contract || !view.clauses.length) return "";
  return `<div class="served-clauses"><p class="change-label">Contract clauses this slice serves, from ${artifactChip(view.contract.path, ctx, `${titles[view.contract.slice] ?? "Scope"} \xB7 Design`)}</p><ol>${view.clauses.map((clause) => `<li value="${clause.number}" class="design-clause" data-clause-number="${clause.number}">${inline(clause.text)}${clauseBadge(clause, view, ctx)}</li>`).join("")}</ol></div>`;
}
function designNotices(view) {
  if (!view) return "";
  const notes = [];
  if (view.stale.length) notes.push(`<div class="notice"><p>The test examples describe an earlier version of this design: ${view.stale.map(escapeHtml).join(" ")}</p></div>`);
  if (view.gaps.length) notes.push(`<p>${badge(view.gaps.length === 1 ? "1 clause without a test" : `${view.gaps.length} clauses without a test`, "warning")} ${view.gaps.map((number) => `<a href="#" class="clause-link" data-clause="${number}">\xA7${number}</a>`).join(", ")}</p>`);
  if (view.changeProblems.length) notes.push(`<ul class="plain-list error">${view.changeProblems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`);
  if (!view.examplesWritten && view.clauses.length) notes.push('<p class="muted">No test examples were written for this design, so the tests behind each clause are not shown.</p>');
  return notes.join("");
}
function unplannedCard(view, ctx) {
  const rows = view?.comparison?.filter((row) => !row.planned) ?? [];
  if (!rows.length) return "";
  return card("Changed without a plan", `<ul class="row-list" data-code-subject>${rows.map((row) => `<li>${artifactChip(row.path, ctx)} <span class="muted">${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</span></li>`).join("")}</ul>`, { eyebrow: "The verified result changed these files, and Changes does not name them" });
}
function changeMapLine(path, state, ctx) {
  if (state?.pending) return "<p>Building the change map from the verified result.</p>";
  if (state?.failed) return `<p class="error">The change map could not be derived: ${escapeHtml(state.failed)}</p>`;
  if (state?.empty) return "<p>The verified result changed no source compared with the design.</p>";
  return path ? `<p>${artifactChip(path, ctx, "Open the change map")}</p>` : "";
}
function legacyChangeMapCard(path, ctx) {
  if (!path) return "";
  return card("Change map", `<p>The planned changes and their readiness.</p><p>${artifactChip(path, ctx, "Open the change map")}</p>`);
}
function failingList(run) {
  const more = (run.failingCount ?? run.failing.length) - run.failing.length;
  return `${run.failing.map((name) => `<code>${escapeHtml(name)}</code>`).join(" ")}${more > 0 ? ` and ${more} more` : ""}`;
}
function codeLine(code) {
  const parts = codeParts(code);
  if (!parts) return "";
  return `<p class="muted">Last passing run ${parts.branch ? `on ${parts.branch} ` : ""}at ${parts.commit}${parts.remote ? ` \xB7 ${parts.remote}` : ""}${code.dirty === true ? " with uncommitted changes" : ""}</p>`;
}
function verificationCard(design, run, code = null) {
  if (!design && !run) return "";
  const result = run ? `<p>${badge(run.passed ? "passed" : "failed", run.passed ? "success" : "danger")} ${escapeHtml(formatTime(run.finishedAt))}${run.reason ? `: ${escapeHtml(REASONS[run.reason] ?? run.reason)}` : ""}</p>` : emptyNote("No verification run yet.");
  return card("Verification", `
    ${result}
    ${codeLine(code)}
    ${keyValues([
    ["Design accepted", design ? escapeHtml(formatTime(design.acceptedAt)) : null],
    ["Review", design ? design.review === "required" ? "required" : "not required" : null],
    ["Frozen tests", design?.frozenTests.length ? `<span class="code-list" data-code-subject>${design.frozenTests.map((item) => `<code>${escapeHtml(item.path)}</code>`).join(" ")}</span>` : null],
    ["Command", run ? `<code>${escapeHtml(run.command)}</code>` : null],
    ["Duration", run?.durationMs ? seconds(run.durationMs) : null],
    ["Exit code", run && run.exitCode !== null ? String(run.exitCode) : null],
    ["Failing tests", run?.failing?.length ? failingList(run) : null]
  ])}
    ${run?.outputTail ? `<prism-disclosure summary="Output tail"><pre class="output-tail">${escapeHtml(run.outputTail)}</pre></prism-disclosure>` : ""}`, { eyebrow: "Latest run" });
}
function diagramLabel(file) {
  const name = file.split("/").pop().replace(/\.puml$/, "");
  return name === "code" ? "Code view" : words(name);
}
function words(name) {
  const text = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return text ? text.replace(/^./, (letter) => letter.toUpperCase()) : name;
}
function fileLabel(file, folder) {
  const relative = file.slice(folder.length + 1);
  const parts = relative.split("/");
  const where = parts.length > 1 ? `${parts.slice(0, -1).map(words).join(" \u203A ")} \xB7 ` : "";
  if (file.toLowerCase().endsWith(".puml")) return { label: `${where}${diagramLabel(file)} \xB7 Diagram` };
  const kind = recordKind(file);
  if (!kind) return { label: relative, code: true };
  if (kind === "Document" || kind === "Record") return { label: `${where}${words(parts.at(-1))} \xB7 ${kind}` };
  return { label: `${where}${kind}` };
}
function viewCount(views) {
  return (views?.own.length ?? 0) + (views?.slices ?? []).reduce((sum, group) => sum + group.views.length, 0);
}
function viewsPanel(views, ctx) {
  if (!viewCount(views)) {
    const none2 = views?.without?.length ? `<p class="slice-views-none">${escapeHtml(views.without.map((entry) => entry.title).join(", "))} ${views.without.length === 1 ? "declares" : "declare"} no views.</p>` : "";
    return emptyState("No views", "This design declares no views. Its contract and Changes are on the Design tab.") + none2;
  }
  const group = (entry) => `<prism-panel class="slice-views-group" variant="plain" level="2" region heading="${escapeHtml(entry.title)}" eyebrow="Planned slice"><div slot="tools">${artifactChip(`slice:${ctx.sliceId}/${entry.slug}`, ctx, "Open slice")}</div>${entry.views.map((view) => viewCardHtml(view, 3)).join("")}</prism-panel>`;
  const none = views.without.length ? `<p class="slice-views-none">${escapeHtml(views.without.map((entry) => entry.title).join(", "))} ${views.without.length === 1 ? "declares" : "declare"} no views.</p>` : "";
  return `<section class="slice-views" data-views aria-label="Views">${views.own.map((view) => viewCardHtml(view)).join("")}${views.slices.map(group).join("")}${none}</section>`;
}
async function mountViews(container, views, ctx) {
  const area = container.querySelector("[data-views]");
  if (!area || area.dataset.mounted) return;
  area.dataset.mounted = "true";
  markViewFiles(area);
  const all = [...views.own, ...views.slices.flatMap((group) => group.views)];
  for (const card2 of area.querySelectorAll(".view-region")) {
    const view = all.find((item) => item.path === card2.dataset.view);
    if (!view || view.kind === "api" || view.source === null) continue;
    try {
      await ctx.drawView(card2, view.source);
    } catch (error) {
      card2.querySelector(".diagram-output").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }
}
const PHASES = [["requirements", "Requirements"], ["design", "Design"], ["frozen", "Frozen"], ["build", "Build"], ["review", "Review"], ["shipped", "Shipped"]];
function reviewClean(review) {
  return Boolean(review) && !review.invalid && review.unresolved === 0 && review.blocking === 0 && review.currentWave?.accepted !== false;
}
function currentPhase(slice, { verification = null, review = null } = {}) {
  if (slice.status === "done") return PHASES.length;
  if (!slice.design) return 1;
  if (slice.status === "not-started") return 2;
  const passed = Boolean(verification?.passed);
  if (!passed) return 3;
  if (slice.design.review === "required" && !reviewClean(review)) return 4;
  return 5;
}
function stepper(slice, data) {
  const current = currentPhase(slice, { verification: data.verification, review: data.artifacts?.review ?? null });
  return `<prism-stepper class="slice-lifecycle" label="Lifecycle">${PHASES.map(([phase, label], index) => `<prism-step phase="${phase}" state="${index < current ? "done" : index === current ? "current" : "upcoming"}">${label}</prism-step>`).join("")}</prism-stepper>`;
}
const TABS = [["design", "Design", "document"], ["views", "Views", "diagram"], ["verification", "Verification", "flask"], ["review", "Review", "eye"], ["files", "Files", "file"], ["change-map", "Change map", "grid"]];
const DEPRECATED = { "change-map": "Replaced by the Files tab and the verified result; kept until existing slices no longer need it." };
function tabCount(value, artifacts, views) {
  if (value === "views") return viewCount(views);
  if (value === "review" && artifacts.review && !artifacts.review.invalid && artifacts.review.unresolved) return artifacts.review.unresolved;
  if (value === "files" && artifacts.files.length) return artifacts.files.length;
  return 0;
}
function tabHtml([value, label, icon], selected, artifacts, views) {
  const count = tabCount(value, artifacts, views);
  const deprecated = DEPRECATED[value];
  const end = count ? ` <prism-badge slot="end" variant="count">${count}</prism-badge>` : deprecated ? ' <prism-badge slot="end" tone="neutral" variant="status">Deprecated</prism-badge>' : "";
  return `<prism-tab value="${value}"${selected ? " selected" : ""}${deprecated ? ` tip="${escapeHtml(deprecated)}"` : ""}><prism-icon slot="start" name="${icon}" size="sm"></prism-icon>${label}${end}</prism-tab>`;
}
const STATUS_WORDS = { "not-started": "not started", "in-progress": "in progress", blocked: "blocked", split: "split", done: "done" };
function phaseTag(slice, data) {
  const index = currentPhase(slice, { verification: data.verification, review: data.artifacts?.review ?? null });
  const [phase, label] = PHASES[Math.min(index, PHASES.length - 1)];
  const state = data.designReview === "waiting" ? "design gate open" : data.designReview === "answered" ? "design gate answered" : index >= PHASES.length ? null : STATUS_WORDS[slice.status] ?? slice.status;
  const words2 = index >= PHASES.length ? "Shipped" : [label, state].filter(Boolean).join(" \xB7 ");
  return `<prism-phase variant="tag" phase="${phase}">${escapeHtml(words2)}</prism-phase>`;
}
function changeMapPanel(slice, artifacts, data, ctx) {
  const line = slice.design ? changeMapLine(artifacts.changeMap, data.changeMap, ctx) : legacyChangeMapCard(artifacts.changeMap, ctx);
  if (!line) return emptyState("No change map yet", slice.design ? "The change map is derived from the slice's first passing verification." : "The slice has no change map.");
  return slice.design ? card("Change map", line, { eyebrow: "Derived from the verified result" }) : line;
}
function filesPanel(artifacts, ctx) {
  const verified = '<div class="slice-verified-files" data-slice-files><prism-spinner label="Loading the verified files"></prism-spinner></div>';
  if (!artifacts.files.length) return verified + emptyState("No files yet", "The slice folder is empty.");
  return verified + card("Slice folder", `<ul class="row-list">${artifacts.files.map((file) => {
    const { label, code } = fileLabel(file, artifacts.folder);
    return `<li${code ? " data-code-subject" : ""}>${artifactChip(file, ctx, label)}</li>`;
  }).join("")}</ul>`, { eyebrow: plural(artifacts.files.length, "file") });
}
function pageActions(diagrams, ctx, details) {
  if (!ctx.setPageActions || typeof document === "undefined") return;
  const button = (text) => {
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
  const follow = (event) => {
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
async function render(container, entity, ctx) {
  const data = entity.data;
  const slice = data.slice;
  const view = data.designView;
  const artifacts = data.artifacts ?? { files: [] };
  const diagrams = artifacts.files.filter((file) => file.endsWith(".puml") && file.slice(artifacts.folder.length + 1).indexOf("/") === -1).sort((left, right) => Number(right.endsWith("/code.puml")) - Number(left.endsWith("/code.puml")) || left.localeCompare(right));
  const held = slice.claim || slice.expiredClaim ? { claim: slice.claim ?? slice.expiredClaim, scope: null } : data.coveringClaim ? { claim: data.coveringClaim.claim, scope: { slug: data.coveringClaim.slug, title: data.coveringClaim.title } } : null;
  const views = data.views ?? { own: [], slices: [], without: [] };
  const clause = takeClause(`slice:${data.id}/${data.slug}`);
  if (clause) ctx.state.tab = "design";
  else if (ctx.state.tab === "diagram") ctx.state.tab = "views";
  const tab = TABS.some(([value]) => value === ctx.state.tab) ? ctx.state.tab : "design";
  const panels = {
    design: artifacts.narrative ? `<section class="view-section design-document" aria-label="Design">${designNotices(view)}${servedClauses(view, ctx, data.titles)}<prism-doc class="document-content" data-narrative><prism-spinner label="Loading the design"></prism-spinner></prism-doc></section>${unplannedCard(view, ctx)}` : `${emptyState("No design yet", "The slice has no design document yet.")}${unplannedCard(view, ctx)}`,
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
    <prism-tabs class="slice-tabs" label="Slice" data-slice-tabs>${TABS.map((entry) => tabHtml(entry, entry[0] === tab, artifacts, views)).join("")}</prism-tabs>
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
    ["Children", data.children.length ? `<span class="chip-row">${data.children.map((slug) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
    ["Depends on", data.effectiveDependencies?.length ? `<span class="chip-row">${data.effectiveDependencies.map((slug) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
    ["Needed by", data.dependents.length ? `<span class="chip-row">${data.dependents.map((slug) => sliceChip(data, slug, ctx)).join("")}</span>` : null],
    ["Work in progress", presenceChips(entity.presence) || null],
    ["Active work", data.active.length ? `<span class="chip-row">${data.active.map((entry) => badge(`${entry.activity} \xB7 ${(entry.workers ?? []).join(", ")}${entry.label ? ` \xB7 ${entry.label}` : ""}`, "info")).join("")}</span>` : null]
  ])}
      </section>
      <div data-initiative-settings></div>
    </prism-dialog>`;
  mountInitiativeSettings(container.querySelector("[data-initiative-settings]"), { target: `slice:${data.id}/${data.slug}`, eyebrow: `Initiative: ${data.initiativeTitle}`, ctx });
  const details = container.querySelector("[data-slice-details]");
  details.addEventListener("click", (event) => {
    if (event.target.closest?.("prism-chip[data-artifact], a[data-artifact]")) details.close();
  });
  bindLinks(container, ctx);
  const drawings = [.../* @__PURE__ */ new Set([...views.own.filter((item) => item.path.endsWith(".puml")).map((item) => item.path), ...diagrams])];
  pageActions(drawings, ctx, details);
  void mountSliceFiles(container.querySelector("[data-slice-files]"), data);
  const showTab = (value) => {
    ctx.state.tab = value;
    for (const panel of container.querySelectorAll("[data-tab-panel]")) panel.hidden = panel.dataset.tabPanel !== value;
    if (value === "views") void mountViews(container, views, ctx);
  };
  container.querySelector("[data-slice-tabs]")?.addEventListener("prism-select", (event) => {
    if (event.target === event.currentTarget && event.detail?.value) showTab(event.detail.value);
  });
  const highlightClause = (number) => {
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
  bindViewLinks(container, (ref, number) => {
    if (number && highlightClause(number)) return;
    requestClause(ref, number);
    ctx.openArtifact(ref);
  });
  container.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    const card2 = action?.closest(".view-region");
    if (!card2 || !container.contains(card2)) return;
    if (action.dataset.action === "open") ctx.openArtifact(card2.dataset.view);
    else if (action.dataset.action === "copy-view") {
      const view2 = [...views.own, ...views.slices.flatMap((group) => group.views)].find((item) => item.path === card2.dataset.view);
      navigator.clipboard.writeText(view2?.source ?? "").then(() => ctx.showToast("API specification copied."), () => ctx.showToast("The browser could not copy the specification."));
    }
  });
  container.addEventListener("click", (event) => {
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
      const titles = narrativeTarget.querySelectorAll("h1");
      if (titles.length === 1) titles[0].remove();
      if (view) decorateDesign(narrativeTarget, view, ctx);
    } catch (error) {
      narrativeTarget.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }
  if (artifacts.review && !artifacts.review.invalid) await mountReviewLedger(container, artifacts.review, ctx);
  if (tab === "views") await mountViews(container, views, ctx);
  if (clause) highlightClause(clause);
  if (container.querySelector("[data-index-notice]")) {
    const builtAt = (status) => status?.state === "ready" ? status.index?.builtAt ?? "" : null;
    let seen = builtAt(currentIndexStatus());
    const follow = (event) => {
      const notice = container.querySelector("[data-index-notice]");
      if (!container.isConnected || !notice) {
        document.removeEventListener("prism:indexing", follow);
        return;
      }
      const now = builtAt(event.detail);
      if (now !== null && now !== seen) {
        document.removeEventListener("prism:indexing", follow);
        ctx.rerender();
        return;
      }
      seen = now ?? seen;
      notice.outerHTML = indexNotice(view, event.detail);
      container.querySelectorAll("[data-index-wait]").forEach((chip2) => {
        chip2.setAttribute("tip", indexReason(event.detail));
      });
    };
    document.addEventListener("prism:indexing", follow);
  }
}
export {
  codeLine,
  currentPhase,
  render
};
