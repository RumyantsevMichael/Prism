import { artifactChip, bindLinks, card, cardSource, emptyNote, escapeHtml, formatTime, keyValues, plural, requirementLinks } from "./util.js";

function sliceChip(data, slug, ctx) {
  return artifactChip(`slice:${data.id}/${slug}`, ctx, data.titles[slug] ?? slug);
}


function reviewCard(review, ctx) {
  if (!review) return card("Review ledger", emptyNote("No review has started for this slice."), { source: "review.json" });
  if (review.invalid) return card("Review ledger", `<p class="error">The review ledger is not valid JSON.</p>${artifactChip(review.path, ctx, "Open raw")}`, { source: "review.json" });
  const statuses = Object.entries(review.byStatus).filter(([, count]) => count).map(([status, count]) => `<span class="meta-pill">${escapeHtml(status)}: ${count}</span>`).join(" ");
  return card("Review ledger", `
    <div class="stat-row compact">
      <div class="stat"><span class="stat-value">${review.waves}</span><span class="stat-label">${review.waves === 1 ? "wave" : "waves"}</span></div>
      <div class="stat ${review.unresolved ? "is-warn" : "is-good"}"><span class="stat-value">${review.unresolved}</span><span class="stat-label">unresolved</span></div>
      <div class="stat ${review.blocking ? "is-bad" : ""}"><span class="stat-value">${review.blocking}</span><span class="stat-label">blocker / high not verified</span></div>
    </div>
    ${review.currentWave ? `<p>Current wave <code>${escapeHtml(review.currentWave.id)}</code> (${escapeHtml(review.currentWave.mode)}) is ${review.currentWave.accepted ? "accepted" : "not accepted"}.</p>` : ""}
    ${statuses ? `<p>${statuses}</p>` : ""}
    <p>${artifactChip(review.path, ctx, "Open the findings board")}</p>`, { source: "review.json" });
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

// Verification shows the accepted design's frozen tests and the latest run of the project's test command.
function changeMapCard(path, state, ctx) {
  const source = { source: path ? path.split("/").pop() : "change-map.json" };
  if (state?.pending) return card("Change map", `<p>Building the change map from the verified result.</p>${path ? `<p>${artifactChip(path, ctx, "Open the previous change map")}</p>` : ""}`, source);
  if (state?.failed) return card("Change map", `<p class="error">The change map could not be derived: ${escapeHtml(state.failed)}</p>`, source);
  if (state?.empty) return card("Change map", emptyNote("The verified result changed no source compared with the design."), source);
  if (!path) return card("Change map", emptyNote("No change map exists yet."), source);
  const text = state?.derived ? "What the verified result changed, compared with the source when the design was accepted." : "The planned changes and their readiness.";
  return card("Change map", `<p>${text}</p><p>${artifactChip(path, ctx, "Open the change map")}</p>`, source);
}

function verificationCard(design, run) {
  if (!design && !run) return "";
  const result = run ? `<p><span class="status-pill ${run.passed ? "is-good" : "is-bad"}">${run.passed ? "passed" : "failed"}</span> ${escapeHtml(formatTime(run.finishedAt))}${run.reason ? `: ${escapeHtml(REASONS[run.reason] ?? run.reason)}` : ""}</p>` : emptyNote("No verification run yet.");
  return card("Verification", `
    ${result}
    ${keyValues([
      ["Design accepted", design ? escapeHtml(formatTime(design.acceptedAt)) : null],
      ["Review", design ? (design.review === "required" ? "required" : "not required") : null],
      ["Frozen tests", design?.frozenTests.length ? design.frozenTests.map((item) => `<code>${escapeHtml(item.path)}</code>`).join(" ") : null],
      ["Command", run ? `<code>${escapeHtml(run.command)}</code>` : null],
      ["Duration", run?.durationMs ? seconds(run.durationMs) : null],
      ["Exit code", run && run.exitCode !== null ? String(run.exitCode) : null]
    ])}
    ${run?.outputTail ? `<details><summary>Output tail</summary><pre>${escapeHtml(run.outputTail)}</pre></details>` : ""}`, { source: "runs" });
}

export async function render(container, entity, ctx) {
  const data = entity.data;
  const slice = data.slice;
  const artifacts = data.artifacts ?? { files: [] };
  const known = new Set([artifacts.narrative, artifacts.changeMap, artifacts.review?.path].filter(Boolean));
  const others = artifacts.files.filter((file) => !known.has(file));
  container.innerHTML = `
    <section class="view-card summary-card">
      <div class="summary-row">
        <div class="summary-status"><span class="slice-status status-${escapeHtml(slice.status)}">${escapeHtml(slice.status)}</span>${data.complete && slice.status === "split" ? '<span class="status-pill is-good">all descendants done</span>' : ""}</div>
        <div class="summary-links">${artifactChip(`initiative:${data.id}`, ctx, data.initiativeTitle)}</div>
      </div>
      ${slice.outcome ? `<p class="initiative-intent large">${escapeHtml(slice.outcome)}</p>` : '<p class="muted">No outcome is recorded for this slice.</p>'}
      ${keyValues([
        ["Slug", `<code>${escapeHtml(data.slug)}</code>`],
        ["Requirements", requirementLinks(slice.requirements, ctx)],
        ["Parent", slice.parent ? sliceChip(data, slice.parent, ctx) : '<span class="muted">root slice</span>'],
        ["Children", data.children.length ? data.children.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Depends on", data.effectiveDependencies?.length ? data.effectiveDependencies.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Needed by", data.dependents.length ? data.dependents.map((slug) => sliceChip(data, slug, ctx)).join(" ") : null],
        ["Active work", data.active.length ? data.active.map((entry) => `<span class="meta-pill">${escapeHtml(entry.activity)} · ${escapeHtml((entry.workers ?? []).join(", "))}${entry.label ? ` · ${escapeHtml(entry.label)}` : ""}</span>`).join(" ") : null]
      ])}
    </section>
    <div class="artifact-cards">
      ${changeMapCard(artifacts.changeMap, data.changeMap, ctx)}
      ${reviewCard(artifacts.review, ctx)}
      ${verificationCard(slice.design, data.verification)}
    </div>
    ${card("Other documents", others.length ? `<ul class="plain-list">${others.map((file) => `<li>${artifactChip(file, ctx, file.slice(artifacts.folder.length + 1))}</li>`).join("")}</ul>` : emptyNote("The slice folder has no other files."), { eyebrow: plural(artifacts.files.length, "file") + " in the slice folder" })}
    ${artifacts.narrative ? `<section class="view-card"><header class="view-card-header"><div class="view-card-title"><h2>Design narrative</h2>${cardSource(artifacts.narrative.split("/").pop())}</div></header><div class="document-content" data-narrative><p class="rendering">Loading narrative</p></div></section>` : ""}`;
  bindLinks(container, ctx);
  if (artifacts.narrative) {
    try {
      const narrative = await ctx.fetchArtifact(artifacts.narrative);
      container.querySelector("[data-narrative]").innerHTML = ctx.renderMarkdown(narrative.content, artifacts.narrative);
    } catch (error) {
      container.querySelector("[data-narrative]").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }
}
