export const EVIDENCE_ID = /^[a-f0-9]{64}$/;

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function shortId(value) {
  return typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : String(value ?? "");
}

export function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatSelector(selector) {
  if (selector === undefined || selector === null || selector === "") {
    return "";
  }
  if (typeof selector === "string") {
    return selector;
  }
  if (selector.type === "span") {
    return `span ${selector.start}–${selector.end}`;
  }
  return `${selector.type}: ${selector.value}`;
}

export function formatReference(reference) {
  const selector = formatSelector(reference?.selector);
  return selector ? `${reference.path} › ${selector}` : String(reference?.path ?? "");
}

export function formatTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : String(value ?? "");
}

// The source names the file a card reads, in a quiet label beside the title rather than in the eyebrow.
export function cardSource(source) {
  return source ? `<span class="card-source">${escapeHtml(source)}</span>` : "";
}

export function card(title, body, { eyebrow = "", source = "", className = "" } = {}) {
  return `<section class="view-card ${className}">
    <header class="view-card-header">${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ""}<div class="view-card-title"><h2>${escapeHtml(title)}</h2>${cardSource(source)}</div></header>
    <div class="view-card-body">${body}</div>
  </section>`;
}

export function evidenceChip(id, label) {
  if (!id) {
    return "";
  }
  return `<button type="button" class="link-chip evidence-chip" data-evidence="${escapeHtml(id)}" data-label="${escapeHtml(label)}" title="${escapeHtml(id)}"><span>${escapeHtml(label)}</span><code>${escapeHtml(shortId(id))}</code></button>`;
}

export function artifactChip(path, ctx, label = path) {
  if (!path) {
    return "";
  }
  if (!ctx.hasArtifact(path)) {
    return `<span class="link-chip disabled" title="Not a reviewable artifact"><code>${escapeHtml(label)}</code></span>`;
  }
  return `<button type="button" class="link-chip artifact-chip" data-artifact="${escapeHtml(path)}" title="Open ${escapeHtml(path)}"><code>${escapeHtml(label)}</code></button>`;
}

// A requirement reference keeps its anchor, so the link opens and previews the requirement's own section.
export function requirementLinks(references, ctx) {
  return references.map((reference) => {
    const [file, anchor] = reference.split("#");
    const label = `${file.split("/").pop()}${anchor ? `#${anchor}` : ""}`;
    return ctx.hasArtifact(file) ? `<button type="button" class="link-chip artifact-chip" data-artifact="${escapeHtml(file)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}><code>${escapeHtml(label)}</code></button>` : `<code>${escapeHtml(reference)}</code>`;
  }).join(" ");
}

function linkTarget(element, keep) {
  return [element.dataset.artifact, { keep, anchor: element.dataset.docAnchor }];
}

export function bindLinks(root, ctx) {
  root.addEventListener("click", (event) => {
    const evidence = event.target.closest("[data-evidence]");
    if (evidence && root.contains(evidence)) {
      event.preventDefault();
      ctx.openEvidence(evidence.dataset.evidence, evidence.dataset.label || "Evidence");
      return;
    }
    const artifactLink = event.target.closest("[data-artifact]");
    if (artifactLink && root.contains(artifactLink)) {
      event.preventDefault();
      ctx.openArtifact(...linkTarget(artifactLink, event.ctrlKey || event.metaKey));
    }
  });
  // A single click previews a link; a double click or a middle click keeps it open, as in an editor.
  root.addEventListener("dblclick", (event) => {
    const artifactLink = event.target.closest("[data-artifact]");
    if (artifactLink && root.contains(artifactLink)) ctx.openArtifact(...linkTarget(artifactLink, true));
  });
  root.addEventListener("auxclick", (event) => {
    const artifactLink = event.target.closest("[data-artifact]");
    if (event.button === 1 && artifactLink && root.contains(artifactLink)) {
      event.preventDefault();
      ctx.openArtifact(...linkTarget(artifactLink, true));
    }
  });
}

export function emptyNote(text) {
  return `<p class="empty-note">${escapeHtml(text)}</p>`;
}

export function keyValues(entries) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) {
    return "";
  }
  return `<dl class="key-values">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
