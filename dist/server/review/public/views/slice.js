import { chipState, currentIndexStatus } from "./indexing.js";
import { artifactChip, bindLinks, card, emptyNote, escapeHtml, formatTime, keyValues, plural, requirementLinks } from "./util.js";
import { sliceRunTotalsHtml } from "./run-totals.js";
import { codeParts } from "./code-location.js";
import { claimChip } from "./claims.js";
import { componentChip } from "./components.js";
import { mountInitiativeSettings } from "./actions.js";

function sliceChip(data, slug, ctx) {
  return artifactChip(`slice:${data.id}/${slug}`, ctx, data.titles[slug] ?? slug);
}


function reviewCard(review, ctx) {
  // A card names a record by its kind, never by its file name.
  if (!review) return card("Review ledger", emptyNote("No review has started for this slice."));
  if (review.invalid) return card("Review ledger", `<p class="error">The review ledger is not valid JSON.</p>${artifactChip(review.path, ctx, "Open raw")}`);
  const statuses = Object.entries(review.byStatus).filter(([, count]) => count).map(([status, count]) => `<span class="meta-pill">${escapeHtml(status)}: ${count}</span>`).join(" ");
  return card("Review ledger", `
    <div class="stat-row compact">
      <div class="stat"><span class="stat-value">${review.waves}</span><span class="stat-label">${review.waves === 1 ? "wave" : "waves"}</span></div>
      <div class="stat ${review.unresolved ? "is-warn" : "is-good"}"><span class="stat-value">${review.unresolved}</span><span class="stat-label">unresolved</span></div>
      <div class="stat ${review.blocking ? "is-bad" : ""}"><span class="stat-value">${review.blocking}</span><span class="stat-label">blocker / high not verified</span></div>
    </div>
    ${review.currentWave ? `<p>Current wave <code>${escapeHtml(review.currentWave.id)}</code> (${escapeHtml(review.currentWave.mode)}) is ${review.currentWave.accepted ? "accepted" : "not accepted"}.</p>` : ""}
    ${statuses ? `<p>${statuses}</p>` : ""}
    <p>${artifactChip(review.path, ctx, "Open the findings board")}</p>`);
}

const REASONS = {
  frozen_tests_changed: "the frozen acceptance tests changed, so the command did not run",
  cancelled: "the run was cancelled",
  timed_out: "the command ran past its timeout",
  command_failed: "the test command failed",
  tracked_files_changed: "the command changed project files while it ran"
};

function seconds(durationMs) {
  return durationMs >= 60000 ? `${Math.round(durationMs / 60000)} min` : durationMs >= 1000 ? `${Math.round(durationMs / 1000)} s` : "under 1 s";
}

// Inline code in a design line is the only markup the view renders.
function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const READINGS = {
  "as-planned": ["as planned", "is-good"],
  partly: ["partly as planned", "is-warn"],
  untouched: ["planned but untouched", "is-warn"],
  unplanned: ["unplanned", "is-info"]
};

const ACTIONS = { ADD: "added", MODIFY: "changed", DELETE: "removed" };
const actualText = (item) => item.unit ? `${ACTIONS[item.action] ?? item.action} <code>${escapeHtml(item.unit)}</code>` : `${ACTIONS[item.action] ?? item.action} the file`;

function readingText(row) {
  const [label, tone] = READINGS[row.reading];
  const notes = [
    row.missing?.length ? `${row.missing.map((unit) => `<code>${escapeHtml(unit)}</code>`).join(", ")} not touched` : "",
    row.extra?.length ? `${plural(row.extra.length, "extra unit")}` : ""
  ].filter(Boolean).join("; ");
  return `<span class="status-pill ${tone}">${label}</span>${notes ? ` <span class="muted">${notes}</span>` : ""}`;
}

// Each Contract clause gets a badge for the tests cited for it, which opens their examples.
function clauseBadge(clause, view, ctx) {
  if (!view.examplesWritten) return "";
  if (!clause.examples.length) return '<span class="design-badge"><span class="status-pill is-warn">no test</span></span>';
  return `<details class="design-badge"><summary><span class="meta-pill">${plural(clause.examples.length, "test")}</span></summary><ul class="design-examples">${clause.examples.map((item) => `<li><span class="example-text">${inline(item.example)}</span> ${artifactChip(item.file, ctx, item.test)}</li>`).join("")}</ul></details>`;
}

const ACTION_LABELS = { add: "add", change: "change", remove: "remove" };
const ACTION_TITLES = { add: "A new file", change: "An existing file changes", remove: "An existing file is removed" };

// A unit chip names where the change lands; hovering it previews those lines, and clicking opens the file there.
function placeChips(change, ctx) {
  if (change.action === "add") return '<span class="change-where-new">new file</span>';
  // Without unit locations each named unit still shows, disabled, and its tooltip says why its lines are missing.
  if (!change.places) return change.units.map((unit) => `<span class="link-chip disabled code-span-chip" data-index-wait title="${escapeHtml(indexReason(currentIndexStatus()))}"><code>${escapeHtml(unit)}</code><span class="code-span-lines">lines –</span></span>`).join(" ");
  if (!change.places.length) return change.units.length ? '<span class="muted">not in the code index</span>' : '<span class="muted">the whole file</span>';
  const linked = ctx.hasArtifact(change.path);
  return change.places.map((place) => {
    if (place.startLine === null) return `<span class="link-chip disabled code-span-chip" title="The code index has no ${escapeHtml(place.unit)} in this file, so the change adds it"><code>${escapeHtml(place.unit)}</code><span class="code-span-lines">new</span></span>`;
    const label = `<code>${escapeHtml(place.unit)}</code><span class="code-span-lines">${place.startLine}–${place.endLine}</span>`;
    return linked
      ? `<button type="button" class="link-chip artifact-chip code-span-chip" data-artifact="${escapeHtml(change.path)}" data-doc-anchor="L${place.startLine}-${place.endLine}" title="Open ${escapeHtml(change.path)} at line ${place.startLine}">${label}</button>`
      : `<span class="link-chip disabled code-span-chip">${label}</span>`;
  }).join(" ");
}

function clauseLinks(clauses) {
  return clauses.map((number) => `<a href="#" class="clause-link clause-tag" data-clause="${number}">§${number}</a>`).join("");
}

// The footer says which Contract clauses a change serves and which tests stand behind them.
function changeFooter(changes, ctx) {
  const clauses = [...new Set(changes.flatMap((change) => change.clauses))].sort((left, right) => left - right);
  if (!clauses.length) return '<footer class="change-card-footer"><span class="muted">Supports the whole slice</span></footer>';
  const tests = [...new Map(changes.flatMap((change) => change.tests ?? []).map((item) => [`${item.file}#${item.test}`, item])).values()];
  return `<footer class="change-card-footer">
    <span class="change-serves"><span class="change-label">Serves</span>${clauseLinks(clauses)}</span>
    <span class="change-tests">${tests.length ? `<span class="change-label">Tests</span>${tests.map((item) => `<span class="test-chip">${artifactChip(item.file, ctx, item.test)}</span>`).join("")}` : '<span class="status-pill is-warn">no test cited</span>'}</span>
  </footer>`;
}

function verifiedRow(change, view) {
  return view.comparison?.find((item) => item.planned && item.planned.item === change.item && item.path === change.path) ?? null;
}

// One Changes line becomes one card: what happens to which file, where, why, and what checks it.
function changeCard(changes, view, ctx) {
  const action = changes[0].action;
  const rows = changes.map((change) => verifiedRow(change, view));
  const verified = rows.some(Boolean);
  const reading = verified ? (rows.every((row) => row?.reading === "as-planned") ? "as-planned" : rows.some((row) => row?.reading === "untouched") && rows.every((row) => !row || row.reading === "untouched") ? "untouched" : "partly") : null;
  const badge = `<span class="change-action" title="${escapeHtml(ACTION_TITLES[action] ?? action)}">${ACTION_LABELS[action] ?? escapeHtml(action)}</span>`;
  const paths = changes.map((change, index) => `<div class="change-path-row">
      ${artifactChip(change.path, ctx)}${badge}
      <span class="change-where">${verified ? (rows[index] ? readingText(rows[index]) : "") : placeChips(change, ctx)}</span>
    </div>`).join("");
  // After verification, what the result actually did follows the plan's reason, path by path.
  const actual = rows.map((row, index) => row?.actual.length ? `<p class="change-actual"><span class="change-label">Actual</span>${changes.length > 1 ? `<code>${escapeHtml(changes[index].path)}</code>: ` : ""}${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</p>` : "").join("");
  return `<article class="change-card action-${escapeHtml(action)}${reading ? ` reading-${reading}` : ""}">
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

// The rendered slice.md is the page; Prism's checks decorate its Contract items and turn its Changes items into cards.
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
      // A line Prism could not read stays as written, inside a card, so the reader still sees it.
      return named.length ? changeCard(named, view, ctx) : `<article class="change-card is-unread"><p>${item.innerHTML}</p></article>`;
    });
    changes.insertAdjacentHTML("afterend", `${indexNotice(view, currentIndexStatus())}<div class="change-list">${cards.join("")}</div>`);
    changes.remove();
  }
}

// Without unit locations the cards cannot show the lines a change touches, so the notice above them says why, following the index chip live.
function indexReason(status) {
  const chip = chipState(status);
  return !status
    ? "Checking the code index for the lines each change touches."
    : status.state === "unavailable"
    ? "Prism has no code index on this platform, so the cards cannot show the lines each change touches."
    : status.state === "preparing"
      ? `The code index is being built (${escapeHtml([chip.label, chip.detail].filter(Boolean).join(", "))}). The lines each change touches appear here when it finishes.`
      : status.state === "failed" || status.state === "interrupted"
        ? "The last code index build did not finish, so the cards cannot show the lines each change touches. Open the index chip at the top for details."
        : status.state === "none"
          ? "The project has no code index yet, so the cards cannot show the lines each change touches. Prism starts building it when its server starts."
          : "The current code index was built before Prism recorded unit locations. They appear after the next index build, which starts when the Prism server restarts.";
}

function indexNotice(view, status) {
  if (!view || view.indexed || view.comparison || !view.changes.some((change) => change.action !== "add")) return "";
  return `<div class="notice index-notice" data-index-notice>${indexReason(status)}</div>`;
}

// A slice of a split scope has no Contract of its own, so the page lists the scope's clauses its Changes serve.
function servedClauses(view, ctx) {
  if (!view?.contract || !view.clauses.length) return "";
  return `<div class="served-clauses"><p class="change-label">Contract clauses this slice serves, from ${artifactChip(view.contract.path, ctx)}</p><ol>${view.clauses.map((clause) => `<li value="${clause.number}" class="design-clause" data-clause-number="${clause.number}">${inline(clause.text)}${clauseBadge(clause, view, ctx)}</li>`).join("")}</ol></div>`;
}

function designNotices(view) {
  if (!view) return "";
  const notes = [];
  if (view.stale.length) notes.push(`<div class="notice"><p>The test examples describe an earlier version of this design: ${view.stale.map(escapeHtml).join(" ")}</p></div>`);
  if (view.gaps.length) notes.push(`<p><span class="status-pill is-warn">${view.gaps.length === 1 ? "1 clause without a test" : `${view.gaps.length} clauses without a test`}</span> ${view.gaps.map((number) => `<a href="#" class="clause-link" data-clause="${number}">§${number}</a>`).join(", ")}</p>`);
  if (view.changeProblems.length) notes.push(`<ul class="plain-list error">${view.changeProblems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`);
  if (!view.examplesWritten && view.clauses.length) notes.push('<p class="muted">No test examples were written for this design, so the tests behind each clause are not shown.</p>');
  return notes.join("");
}

function unplannedCard(view, ctx) {
  const rows = view?.comparison?.filter((row) => !row.planned) ?? [];
  if (!rows.length) return "";
  return card("Changed without a plan", `<ul class="plain-list">${rows.map((row) => `<li>${artifactChip(row.path, ctx)} <span class="muted">${row.actual.slice(0, 6).map(actualText).join(", ")}${row.actual.length > 6 ? `, ${row.actual.length - 6} more` : ""}</span></li>`).join("")}</ul>`, { eyebrow: "The verified result changed these files, and Changes does not name them" });
}

function changeMapLine(path, state, ctx) {
  if (state?.pending) return "<p>Building the change map from the verified result.</p>";
  if (state?.failed) return `<p class="error">The change map could not be derived: ${escapeHtml(state.failed)}</p>`;
  if (state?.empty) return "<p>The verified result changed no source compared with the design.</p>";
  return path ? `<p>${artifactChip(path, ctx, "Open the change map")}</p>` : "";
}

// A slice designed before slice.md carried a contract may still have a hand-written change map.
function legacyChangeMapCard(path, ctx) {
  if (!path) return "";
  return card("Change map", `<p>The planned changes and their readiness.</p><p>${artifactChip(path, ctx, "Open the change map")}</p>`);
}

function failingList(run) {
  const more = (run.failingCount ?? run.failing.length) - run.failing.length;
  return `${run.failing.map((name) => `<code>${escapeHtml(name)}</code>`).join(" ")}${more > 0 ? ` and ${more} more` : ""}`;
}

// The line names the last passing run, which need not be the latest run shown above it; a malformed shared record shows nothing.
// On a known host the branch, commit, and repository link to the remote's web pages.
export function codeLine(code) {
  const parts = codeParts(code);
  if (!parts) return "";
  return `<p class="muted">Last passing run ${parts.branch ? `on ${parts.branch} ` : ""}at ${parts.commit}${parts.remote ? ` · ${parts.remote}` : ""}${code.dirty === true ? " with uncommitted changes" : ""}</p>`;
}

// Verification shows the accepted design's frozen tests, the latest run of the project's test command, and the derived change map.
function verificationCard(design, run, changeMap = "", code = null) {
  if (!design && !run) return "";
  const result = run ? `<p><span class="status-pill ${run.passed ? "is-good" : "is-bad"}">${run.passed ? "passed" : "failed"}</span> ${escapeHtml(formatTime(run.finishedAt))}${run.reason ? `: ${escapeHtml(REASONS[run.reason] ?? run.reason)}` : ""}</p>` : emptyNote("No verification run yet.");
  return card("Verification", `
    ${result}
    ${codeLine(code)}
    ${keyValues([
      ["Design accepted", design ? escapeHtml(formatTime(design.acceptedAt)) : null],
      ["Review", design ? (design.review === "required" ? "required" : "not required") : null],
      ["Frozen tests", design?.frozenTests.length ? design.frozenTests.map((item) => `<code>${escapeHtml(item.path)}</code>`).join(" ") : null],
      ["Command", run ? `<code>${escapeHtml(run.command)}</code>` : null],
      ["Duration", run?.durationMs ? seconds(run.durationMs) : null],
      ["Exit code", run && run.exitCode !== null ? String(run.exitCode) : null],
      ["Failing tests", run?.failing?.length ? failingList(run) : null]
    ])}
    ${run?.outputTail ? `<details><summary>Output tail</summary><pre>${escapeHtml(run.outputTail)}</pre></details>` : ""}
    ${changeMap}`, { source: "runs" });
}

// The slice folder may hold any number of diagrams, or none; the code view comes first when it exists.
function diagramLabel(file) {
  const name = file.split("/").pop().replace(/\.puml$/, "");
  return name === "code" ? "Code view" : name.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function diagramsCard(diagrams, folder, ctx) {
  if (!diagrams.length) return "";
  const selected = diagrams.includes(ctx.state.diagram) ? ctx.state.diagram : diagrams[0];
  const tabs = diagrams.length > 1 ? `<div class="diagram-tabs" role="tablist" aria-label="Diagrams">${diagrams.map((file) => `<button type="button" role="tab" class="diagram-tab" data-diagram="${escapeHtml(file)}" aria-selected="${file === selected}" title="${escapeHtml(file.slice(folder.length + 1))}">${escapeHtml(diagramLabel(file))}</button>`).join("")}</div>` : "";
  return `<section class="slice-diagrams" data-diagrams>${tabs}<div class="diagram-slot" data-diagram-slot="${escapeHtml(selected)}"></div></section>`;
}

async function mountDiagrams(container, diagrams, ctx) {
  const area = container.querySelector("[data-diagrams]");
  if (!area) return;
  const show = async (file) => {
    ctx.state.diagram = file;
    area.querySelectorAll(".diagram-tab").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.diagram === file)));
    const slot = area.querySelector("[data-diagram-slot]");
    slot.dataset.diagramSlot = file;
    slot.innerHTML = "";
    try { await ctx.mountDiagram(slot, file); }
    catch (error) { slot.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
  };
  area.addEventListener("click", (event) => {
    const tab = event.target.closest(".diagram-tab");
    if (tab && tab.getAttribute("aria-selected") !== "true") void show(tab.dataset.diagram);
  });
  await show(area.querySelector("[data-diagram-slot]").dataset.diagramSlot);
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  const slice = data.slice;
  const view = data.designView;
  const artifacts = data.artifacts ?? { files: [] };
  // Diagrams directly in the slice folder, such as the code view, show above the document as the design's picture.
  const diagrams = artifacts.files.filter((file) => file.endsWith(".puml") && file.slice(artifacts.folder.length + 1).indexOf("/") === -1).sort((left, right) => Number(right.endsWith("/code.puml")) - Number(left.endsWith("/code.puml")) || left.localeCompare(right));
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status">${data.designReview ? `<span class="slice-status status-design-review">design review</span><span class="muted">${data.designReview === "answered" ? "You answered the design question; the agent accepts or revises the design next." : "The design waits for your answer on the Attention page."}</span>` : `<span class="slice-status status-${escapeHtml(slice.status)}">${escapeHtml(slice.status)}</span>`}${data.complete && slice.status === "split" ? '<span class="status-pill is-good">all descendants done</span>' : ""}</div>
        <div class="summary-links">${artifactChip(`initiative:${data.id}`, ctx, data.initiativeTitle)}</div>
      </div>
      ${slice.outcome ? `<p class="initiative-intent large">${escapeHtml(slice.outcome)}</p>` : '<p class="muted">No outcome is recorded for this slice.</p>'}
      ${keyValues([
        ["Slug", `<code>${escapeHtml(data.slug)}</code>`],
        ["Component", componentChip(slice.component) || null],
        ["Requirements", requirementLinks(slice.requirements, ctx)],
        ["Parent", slice.parent ? sliceChip(data, slice.parent, ctx) : '<span class="muted">root slice</span>'],
        ["Children", data.children.length ? data.children.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Depends on", data.effectiveDependencies?.length ? data.effectiveDependencies.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Needed by", data.dependents.length ? data.dependents.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Claim", claimChip(slice.claim || slice.expiredClaim ? { claim: slice.claim ?? slice.expiredClaim, scope: null } : data.coveringClaim ? { claim: data.coveringClaim.claim, scope: { slug: data.coveringClaim.slug, title: data.coveringClaim.title } } : null) || null],
        ["Active work", data.active.length ? data.active.map((entry) => `<span class="meta-pill">${escapeHtml(entry.activity)} · ${escapeHtml((entry.workers ?? []).join(", "))}${entry.label ? ` · ${escapeHtml(entry.label)}` : ""}</span>`).join(" ") : null]
      ])}
    </section>
    ${diagramsCard(diagrams, artifacts.folder, ctx)}
    ${artifacts.narrative ? `<section class="view-card design-document"><header class="view-card-header"><div class="view-card-title"><h2>Design</h2></div></header>${designNotices(view)}${servedClauses(view, ctx)}<div class="document-content" data-narrative><p class="rendering">Loading the design</p></div></section>` : ""}
    ${unplannedCard(view, ctx)}
    ${sliceRunTotalsHtml(data.runTotals, data.children.length > 0)}
    <div class="artifact-cards">
      ${verificationCard(slice.design, data.verification, slice.design ? changeMapLine(artifacts.changeMap, data.changeMap, ctx) : "", data.code)}
      ${reviewCard(artifacts.review, ctx)}
      ${slice.design ? "" : legacyChangeMapCard(artifacts.changeMap, ctx)}
    </div>
    ${card("Slice folder", artifacts.files.length ? `<ul class="plain-list">${artifacts.files.map((file) => `<li>${artifactChip(file, ctx, file.slice(artifacts.folder.length + 1))}</li>`).join("")}</ul>` : emptyNote("The slice folder is empty."), { eyebrow: plural(artifacts.files.length, "file") })}
    <div data-initiative-settings></div>`;
  // A slice page changes its initiative's settings, so the card names the initiative they belong to.
  mountInitiativeSettings(container.querySelector("[data-initiative-settings]"), { target: `slice:${data.id}/${data.slug}`, eyebrow: `Initiative: ${data.initiativeTitle}`, ctx });
  bindLinks(container, ctx);
  container.addEventListener("click", (event) => {
    const link = event.target.closest("[data-clause]");
    if (!link || !container.contains(link)) return;
    event.preventDefault();
    const target = container.querySelector(`.design-clause[data-clause-number="${CSS.escape(link.dataset.clause)}"]`);
    if (target) { target.scrollIntoView({ block: "center" }); target.classList.remove("is-target"); void target.offsetWidth; target.classList.add("is-target"); }
  });
  const narrativeTarget = container.querySelector("[data-narrative]");
  if (narrativeTarget) {
    try {
      const narrative = await ctx.fetchArtifact(artifacts.narrative);
      narrativeTarget.innerHTML = ctx.renderMarkdown(narrative.content, artifacts.narrative);
      if (view) decorateDesign(narrativeTarget, view, ctx);
    } catch (error) {
      narrativeTarget.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }
  await mountDiagrams(container, diagrams, ctx);
  // While the cards wait for unit locations, the notice follows the index chip, and a finished build redraws the page with the lines.
  if (container.querySelector("[data-index-notice]")) {
    const builtAt = (status) => status?.state === "ready" ? status.index?.builtAt ?? "" : null;
    let seen = builtAt(currentIndexStatus());
    const follow = (event) => {
      const notice = container.querySelector("[data-index-notice]");
      if (!container.isConnected || !notice) { document.removeEventListener("prism:indexing", follow); return; }
      // Only a newly published index can carry the locations, so an index already seen does not redraw the page again.
      const now = builtAt(event.detail);
      if (now !== null && now !== seen) { document.removeEventListener("prism:indexing", follow); ctx.rerender(); return; }
      seen = now ?? seen;
      notice.outerHTML = indexNotice(view, event.detail);
      container.querySelectorAll("[data-index-wait]").forEach((chip) => { chip.title = indexReason(event.detail); });
    };
    document.addEventListener("prism:indexing", follow);
  }
}
