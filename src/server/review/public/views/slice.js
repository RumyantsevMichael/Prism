import { artifactChip, bindLinks, card, emptyNote, escapeHtml, keyValues, plural, requirementLinks } from "./util.js";

function sliceChip(data, slug, ctx) {
  return artifactChip(`slice:${data.id}/${slug}`, ctx, data.titles[slug] ?? slug);
}


function reviewCard(review, ctx) {
  if (!review) return card("Review ledger", emptyNote("No review has started for this slice."), { eyebrow: "review.json" });
  if (review.invalid) return card("Review ledger", `<p class="error">The review ledger is not valid JSON.</p>${artifactChip(review.path, ctx, "Open raw")}`, { eyebrow: "review.json" });
  const statuses = Object.entries(review.byStatus).filter(([, count]) => count).map(([status, count]) => `<span class="meta-pill">${escapeHtml(status)}: ${count}</span>`).join(" ");
  return card("Review ledger", `
    <div class="stat-row compact">
      <div class="stat"><span class="stat-value">${review.waves}</span><span class="stat-label">${review.waves === 1 ? "wave" : "waves"}</span></div>
      <div class="stat ${review.unresolved ? "is-warn" : "is-good"}"><span class="stat-value">${review.unresolved}</span><span class="stat-label">unresolved</span></div>
      <div class="stat ${review.blocking ? "is-bad" : ""}"><span class="stat-value">${review.blocking}</span><span class="stat-label">blocker / high not verified</span></div>
    </div>
    ${review.currentWave ? `<p>Current wave <code>${escapeHtml(review.currentWave.id)}</code> (${escapeHtml(review.currentWave.mode)}) is ${review.currentWave.accepted ? "accepted" : "not accepted"}.</p>` : ""}
    ${statuses ? `<p>${statuses}</p>` : ""}
    <p>${artifactChip(review.path, ctx, "Open the findings board")}</p>`, { eyebrow: "review.json" });
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
      ${card("Change map", artifacts.changeMap ? `<p>The planned changes and their readiness.</p><p>${artifactChip(artifacts.changeMap, ctx, "Open the change map")}</p>` : emptyNote("No change map exists yet."), { eyebrow: artifacts.changeMap ? artifacts.changeMap.split("/").pop() : "change-map.json" })}
      ${reviewCard(artifacts.review, ctx)}
    </div>
    ${card("Other documents", others.length ? `<ul class="plain-list">${others.map((file) => `<li>${artifactChip(file, ctx, file.slice(artifacts.folder.length + 1))}</li>`).join("")}</ul>` : emptyNote("The slice folder has no other files."), { eyebrow: plural(artifacts.files.length, "file") + " in the slice folder" })}
    ${artifacts.narrative ? `<section class="view-card"><header class="view-card-header"><p class="eyebrow">slice.md</p><h2>Design narrative</h2></header><div class="document-content" data-narrative><p class="rendering">Loading narrative</p></div></section>` : ""}`;
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
