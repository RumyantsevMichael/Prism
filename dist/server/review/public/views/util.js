export const EVIDENCE_ID = /^[a-f0-9]{64}$/;

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// A path under .prism/ or a JSON file name inside a sentence, without the punctuation that ends the sentence.
const CODE_SUBJECT = /\.prism\/\S*?(?=[.,;:!?)]*(?:\s|$))|[\w.-]*[\w-]\.json\b/g;

/** A message as HTML, with each path under .prism/ and each JSON file name in code marked data-code-subject. */
export function messageHtml(text) {
  const value = String(text ?? "");
  let html = "";
  let last = 0;
  for (const match of value.matchAll(CODE_SUBJECT)) {
    html += `${escapeHtml(value.slice(last, match.index))}<code data-code-subject>${escapeHtml(match[0])}</code>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(last));
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

// The source names the file a card reads, in a quiet label beside the title; the workflow views name records by kind instead.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A decision's date as `<day> <month>`, with the year when it is not the current year or when `year` asks for it, such as `9 Nov` or `14 Jun 2025`;
 * an unreadable time gives an empty text.
 */
export function shortDate(value, { year = false, now = new Date() } = {}) {
  const day = new Date(value ?? "");
  if (!value || Number.isNaN(day.getTime())) return "";
  const shown = `${day.getDate()} ${MONTHS[day.getMonth()]}`;
  return year || day.getFullYear() !== now.getFullYear() ? `${shown} ${day.getFullYear()}` : shown;
}

export function cardSource(source) {
  return source ? `<span class="card-source">${escapeHtml(source)}</span>` : "";
}

// A card is a kit panel; it names what it shows by its heading and an eyebrow, never by the file it reads.
export function card(title, body, { eyebrow = "", className = "", level = 2 } = {}) {
  return `<prism-panel class="view-section ${escapeHtml(className)}" heading="${escapeHtml(title)}"${eyebrow ? ` eyebrow="${escapeHtml(eyebrow)}"` : ""}${level === 2 ? "" : ` level="${level}"`}>${body}</prism-panel>`;
}

// A summary block is a kit panel without a heading, for a page's figures and controls above its cards.
export function summaryPanel(body, className = "") {
  return `<prism-panel class="view-section summary-block ${escapeHtml(className)}">${body}</prism-panel>`;
}

/** A kit figure; `tip` gives a value shortened for display, such as a compact count, in full. */
export function stat(label, value, { tone = "", hint = "", tip = "", attributes = "" } = {}) {
  return `<prism-stat label="${escapeHtml(label)}" value="${escapeHtml(value)}"${hint ? ` hint="${escapeHtml(hint)}"` : ""}${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}></prism-stat>`;
}

/** A kit status badge in a tone: neutral, accent, danger, warning, success, or info. */
export function badge(text, tone = "neutral") {
  return `<prism-badge variant="status" tone="${escapeHtml(tone)}">${escapeHtml(text)}</prism-badge>`;
}

/** A static kit chip, with optional quieter meta text. */
export function chip(html, { tone = "", meta = "", tip = "", attributes = "" } = {}) {
  return `<prism-chip${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}>${html}${meta ? `<span slot="meta">${meta}</span>` : ""}</prism-chip>`;
}

/** A kit empty state with its heading and an optional line below it. */
export function emptyState(heading, text = "") {
  return `<prism-empty-state heading="${escapeHtml(heading)}">${text ? `<p>${escapeHtml(text)}</p>` : ""}</prism-empty-state>`;
}

export function evidenceChip(id, label) {
  if (!id) {
    return "";
  }
  return `<prism-chip interactive tone="accent" data-evidence="${escapeHtml(id)}" data-label="${escapeHtml(label)}" tip="${escapeHtml(id)}">${escapeHtml(label)}<code slot="meta">${escapeHtml(shortId(id))}</code></prism-chip>`;
}

// A link to a page or file opens it; without a label it names a repository file by its path, which is then the subject.
export function artifactChip(path, ctx, label = path) {
  if (!path) {
    return "";
  }
  const code = label === path && !/^(?:initiative|slice):/.test(path) ? " data-code-subject" : "";
  if (!ctx.hasArtifact(path)) {
    return `<prism-chip tip="Not a reviewable artifact"${code}>${escapeHtml(label)}</prism-chip>`;
  }
  return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(path)}"${code}>${escapeHtml(label)}</prism-chip>`;
}

/** A record's title as a link to its page, so the browser can open it in a new tab or window and copy its address; a path that is not reviewable stays text. */
export function artifactLink(path, ctx, label = path) {
  if (!path) return "";
  const code = label === path && !/^(?:initiative|slice):/.test(path) ? " data-code-subject" : "";
  if (!ctx.hasArtifact(path)) return `<span class="muted"${code}>${escapeHtml(label)}</span>`;
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(path)}" data-artifact="${escapeHtml(path)}"${code}>${escapeHtml(label)}</a>`;
}

/**
 * Names a path for the record views: one of Prism's records by its title and kind, and a repository file by its path, marked as where code is the subject.
 * Returns { label, code }.
 */
export function pathName(path, ctx) {
  const named = ctx?.describe?.(path);
  if (!named || named.code) return { label: String(path ?? ""), code: true };
  const title = ctx.recordTitle?.(path) ?? named.label;
  return { label: title === named.kind ? named.kind : `${named.kind} · ${title}`, code: false };
}

/** A path as inline text: a record's title and kind, or the repository path in code marked data-code-subject. */
export function pathText(path, ctx, selector = "") {
  const { label, code } = pathName(path, ctx);
  const detail = selector ? ` › ${escapeHtml(selector)}` : "";
  return code ? `<code data-code-subject>${escapeHtml(path)}${detail}</code>` : `<span>${escapeHtml(label)}${detail}</span>`;
}

/** A link chip to a path, named as pathName names it; a path the review cannot open is static text. */
export function recordChip(path, ctx, { selector = "", anchor = "" } = {}) {
  if (!path) return "";
  const { label, code } = pathName(path, ctx);
  const text = `${escapeHtml(label)}${selector ? `<span slot="meta">${escapeHtml(selector)}</span>` : ""}`;
  const subject = code ? " data-code-subject" : "";
  if (!ctx?.hasArtifact?.(path)) return `<prism-chip${subject}>${text}</prism-chip>`;
  return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(path)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}${subject}>${text}</prism-chip>`;
}

function words(name) {
  const text = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : name;
}

/** The title of one of Prism's documents, such as a requirements file, from the page's index, or its file name in words. */
export function documentTitle(path, ctx) {
  return ctx.recordTitle?.(path) ?? words(String(path).split("/").pop() ?? "");
}

// A requirement reference keeps its anchor, so the link opens and previews the requirement's own section; it reads as the requirement and its file's title.
export function requirementLinks(references, ctx, { icon = null } = {}) {
  return references.map((reference) => {
    const [file, anchor] = reference.split("#");
    const title = documentTitle(file, ctx);
    const label = anchor ? `Requirement ${anchor} · ${title}` : `${title} · Requirements`;
    const glyph = icon ? `<prism-icon name="${escapeHtml(icon)}" size="xs"></prism-icon> ` : "";
    return ctx.hasArtifact(file)
      ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(file)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${glyph}${escapeHtml(label)}</prism-chip>`
      : `<prism-chip>${glyph}${escapeHtml(label)}</prism-chip>`;
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
