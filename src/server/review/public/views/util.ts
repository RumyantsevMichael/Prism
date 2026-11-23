import { formatBadge } from "./format-marks.js";

export const EVIDENCE_ID = /^[a-f0-9]{64}$/;

export function escapeHtml(value: any) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// A path under .prism/ or a JSON file name inside a sentence, without the punctuation that ends the sentence.
const CODE_SUBJECT = /\.prism\/\S*?(?=[.,;:!?)]*(?:\s|$))|[\w.-]*[\w-]\.json\b/g;

/** A message as HTML, with each path under .prism/ and each JSON file name in code marked data-code-subject. */
export function messageHtml(text: string) {
  const value = String(text ?? "");
  let html = "";
  let last = 0;
  for (const match of value.matchAll(CODE_SUBJECT)) {
    html += `${escapeHtml(value.slice(last, match.index))}<code data-code-subject>${escapeHtml(match[0])}</code>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(last));
}

export function shortId(value: any) {
  return typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : String(value ?? "");
}

export function plural(count: number, word: any) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatSelector(selector: any) {
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

export function formatReference(reference: any) {
  const selector = formatSelector(reference?.selector);
  return selector ? `${reference.path} › ${selector}` : String(reference?.path ?? "");
}

export function formatTime(value: any) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : String(value ?? "");
}

// The source names the file a card reads, in a quiet label beside the title; the workflow views name records by kind instead.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A decision's date as `<day> <month>`, with the year when it is not the current year or when `year` asks for it, such as `9 Nov` or `14 Jun 2025`;
 * an unreadable time gives an empty text.
 */
export function shortDate(value: any, { year = false, now = new Date() }: any = {}) {
  const day = new Date(value ?? "");
  if (!value || Number.isNaN(day.getTime())) return "";
  const shown = `${day.getDate()} ${MONTHS[day.getMonth()]}`;
  return year || day.getFullYear() !== now.getFullYear() ? `${shown} ${day.getFullYear()}` : shown;
}

export function cardSource(source: any) {
  return source ? `<span class="card-source">${escapeHtml(source)}</span>` : "";
}

// A card is a kit panel; it names what it shows by its heading and an eyebrow, never by the file it reads.
export function card(title: string, body: any, { eyebrow = "", className = "", level = 2 }: any = {}) {
  return `<prism-panel class="view-section ${escapeHtml(className)}" heading="${escapeHtml(title)}"${eyebrow ? ` eyebrow="${escapeHtml(eyebrow)}"` : ""}${level === 2 ? "" : ` level="${level}"`}>${body}</prism-panel>`;
}

// A summary block is a kit panel without a heading, for a page's figures and controls above its cards.
export function summaryPanel(body: any, className = "") {
  return `<prism-panel class="view-section summary-block ${escapeHtml(className)}">${body}</prism-panel>`;
}

/** A kit figure; `tip` gives a value shortened for display, such as a compact count, in full. */
export function stat(label: string, value: any, { tone = "", hint = "", tip = "", attributes = "" }: any = {}) {
  return `<prism-stat label="${escapeHtml(label)}" value="${escapeHtml(value)}"${hint ? ` hint="${escapeHtml(hint)}"` : ""}${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}></prism-stat>`;
}

/** A kit status badge in a tone: neutral, accent, danger, warning, success, or info. */
export function badge(text: string, tone = "neutral") {
  return `<prism-badge variant="status" tone="${escapeHtml(tone)}">${escapeHtml(text)}</prism-badge>`;
}

/** A record's status as a kit prism-status, in its class's color and glyph; `label` replaces the registry's word, and `glyphOnly` keeps it for the accessible name. */
export function status(value: any, { label = "", variant = "", glyphOnly = false, attributes = "" }: any = {}) {
  return `<prism-status value="${escapeHtml(value ?? "")}"${label ? ` label="${escapeHtml(label)}"` : ""}${variant ? ` variant="${escapeHtml(variant)}"` : ""}${glyphOnly ? " glyph-only" : ""}${attributes}></prism-status>`;
}

/** A status a record writes by hand, such as Accepted 3 Nov 2026: its first word picks the class, and the whole text shows when it says more. */
export function recordStatus(text: string) {
  // A status that links its record, such as an ADR's "Superseded by [Title](file.md)", reads as the link's text.
  const written = String(text ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  const [word = "", ...rest] = written.split(/\s+/);
  return status(word, { label: rest.length ? written : "" });
}

/** A static kit chip, with optional quieter meta text. */
export function chip(html: any, { tone = "", meta = "", tip = "", attributes = "" }: any = {}) {
  return `<prism-chip${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}>${html}${meta ? `<span slot="meta">${meta}</span>` : ""}</prism-chip>`;
}

/** A kit empty state with its heading and an optional line below it. */
/**
 * A line under the page's title, a kit prism-page-sub: `html` is its text, which may name things in <b>,
 * `glyph` the markup of a glyph that leads it, `end` the markup that ends it, such as a link, and `detail` a quieter line.
 */
export function pageSub(html: any, { glyph = "", end = "", detail = false }: any = {}) {
  const slotted = (markup: any, slot: any) => markup.replace(/^<([a-z][\w-]*)/, `<$1 slot="${slot}"`);
  return `<prism-page-sub${detail ? " detail" : ""}>${glyph ? slotted(glyph, "glyph") : ""}${html}${end ? slotted(end, "end") : ""}</prism-page-sub>`;
}

/**
 * Puts `html`, one element of page-sub lines or nothing, under the title in the page head above `container`, in place of the lines an earlier draw put there,
 * and binds its links; it answers false when the page has no head, so the caller can put the lines at the top of the page instead.
 */
export function setPageSub(container: any, html: any, ctx: any) {
  const head = container.parentElement?.querySelector(".artifact-header > div:first-child");
  if (!head) return false;
  head.querySelector(":scope > [data-page-sub]")?.remove();
  if (!html) return true;
  const holder = document.createElement("div");
  holder.innerHTML = html.trim();
  const node = holder.firstElementChild;
  node!.setAttribute("data-page-sub", "");
  head.append(node);
  bindLinks(node, ctx);
  return true;
}

/**
 * Puts an eyebrow above the title and `end`, the page's own controls, at the end of the page head above `container`, in place of what an earlier draw put there,
 * and answers the element that holds `end`, or null when the page has no head or nothing to put there.
 */
export function setPageHead(container: any, { eyebrow = "", end = "" }: any = {}, ctx = null) {
  const header = container.parentElement?.querySelector?.(".artifact-header");
  const head = header?.querySelector(":scope > div:first-child");
  if (!head) return null;
  head.querySelector(":scope > [data-page-eyebrow]")?.remove();
  header.querySelector(":scope > [data-page-end]")?.remove();
  if (eyebrow) head.insertAdjacentHTML("afterbegin", `<p class="eyebrow" data-page-eyebrow>${escapeHtml(eyebrow)}</p>`);
  if (!end) return null;
  header.insertAdjacentHTML("beforeend", `<div class="artifact-meta page-end" data-page-end>${end}</div>`);
  const holder = header.querySelector(":scope > [data-page-end]");
  if (ctx) bindLinks(holder, ctx);
  return holder;
}

export function emptyState(heading: string, text = "") {
  return `<prism-empty-state heading="${escapeHtml(heading)}">${text ? `<p>${escapeHtml(text)}</p>` : ""}</prism-empty-state>`;
}

export function evidenceChip(id: string, label: string) {
  if (!id) {
    return "";
  }
  return `<prism-chip interactive tone="accent" data-evidence="${escapeHtml(id)}" data-label="${escapeHtml(label)}" tip="${escapeHtml(id)}">${escapeHtml(label)}<code slot="meta">${escapeHtml(shortId(id))}</code></prism-chip>`;
}

// A link to a page or file opens it; without a label it names a repository file by its path, which is then the subject.
export function artifactChip(path: any, ctx: any, label = path) {
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
export function artifactLink(path: any, ctx: any, label = path) {
  if (!path) return "";
  const code = label === path && !/^(?:initiative|slice):/.test(path) ? " data-code-subject" : "";
  if (!ctx.hasArtifact(path)) return `<span class="muted"${code}>${escapeHtml(label)}</span>`;
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(path)}" data-artifact="${escapeHtml(path)}"${code}>${escapeHtml(label)}</a>`;
}

/**
 * Names a path for the record views: one of Prism's records by its title and kind, and a repository file by its path, marked as where code is the subject.
 * Returns { label, code }.
 */
export function pathName(path: any, ctx: any) {
  const named = ctx?.describe?.(path);
  if (!named || named.code) return { label: String(path ?? ""), code: true };
  const title = ctx.recordTitle?.(path) ?? named.label;
  return { label: title === named.kind ? named.kind : `${named.kind} · ${title}`, code: false };
}

/** A path as inline text: a record's title and kind, or the repository path in code marked data-code-subject. */
export function pathText(path: any, ctx: any, selector = "") {
  const { label, code } = pathName(path, ctx);
  const detail = selector ? ` › ${escapeHtml(selector)}` : "";
  return code ? `<code data-code-subject>${escapeHtml(path)}${detail}</code>` : `<span>${escapeHtml(label)}${detail}</span>`;
}

/** A link chip to a path, named as pathName names it; a path the review cannot open is static text. */
export function recordChip(path: any, ctx: any, { selector = "", anchor = "" }: any = {}) {
  if (!path) return "";
  const { label, code } = pathName(path, ctx);
  const text = `${escapeHtml(label)}${selector ? `<span slot="meta">${escapeHtml(selector)}</span>` : ""}`;
  const subject = code ? " data-code-subject" : "";
  if (!ctx?.hasArtifact?.(path)) return `<prism-chip${subject}>${text}</prism-chip>`;
  return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(path)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}${subject}>${text}</prism-chip>`;
}

function words(name: string) {
  const text = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : name;
}

/** The title of one of Prism's documents, such as a requirements file, from the page's index, or its file name in words. */
export function documentTitle(path: any, ctx: any) {
  return ctx.recordTitle?.(path) ?? words(String(path).split("/").pop() ?? "");
}

// A requirement reference keeps its anchor, so the link opens and previews the requirement's own section; it reads as the requirement and its file's title.
export function requirementLinks(references: any, ctx: any, { icon = null }: any = {}) {
  const marked = new Set();
  return references.map((reference: any) => {
    const [file, anchor] = reference.split("#");
    // A file that breaks its format is marked once, after its first link.
    const format = marked.has(file) ? null : ctx.formatOf?.(file) ?? null;
    marked.add(file);
    const mark = format ? ` ${formatBadge(format)}` : "";
    const title = documentTitle(file, ctx);
    const label = anchor ? `Requirement ${anchor} · ${title}` : `${title} · Requirements`;
    const glyph = icon ? `<prism-icon name="${escapeHtml(icon)}" size="xs"></prism-icon> ` : "";
    return ctx.hasArtifact(file)
      ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(file)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${glyph}${escapeHtml(label)}</prism-chip>${mark}`
      : `<prism-chip>${glyph}${escapeHtml(label)}</prism-chip>${mark}`;
  }).join(" ");
}

/** Requirement references as one chip per requirements file, named by the file's title and the numbers it cites, which opens the file at the first one. */
export function requirementGroups(references: any, ctx: any) {
  const files = new Map();
  for (const reference of references) {
    const [file, anchor] = reference.split("#");
    if (!files.has(file)) files.set(file, []);
    if (anchor) files.get(file).push(anchor);
  }
  return [...files].map(([file, anchors]) => {
    const title = documentTitle(file, ctx);
    const numbers = anchors.length ? `<span slot="meta">${escapeHtml(anchors.join(", "))}</span>` : "";
    const tip = anchors.length ? `${anchors.length === 1 ? "Requirement" : "Requirements"} ${anchors.join(", ")} of ${title}` : title;
    return ctx.hasArtifact(file)
      ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(file)}"${anchors[0] ? ` data-doc-anchor="${escapeHtml(anchors[0])}"` : ""} tip="${escapeHtml(tip)}">${escapeHtml(title)}${numbers}</prism-chip>`
      : `<prism-chip tip="${escapeHtml(tip)}">${escapeHtml(title)}${numbers}</prism-chip>`;
  }).join(" ");
}

function linkTarget(element: any, keep: any) {
  return [element.dataset.artifact, { keep, anchor: element.dataset.docAnchor }];
}

export function bindLinks(root: any, ctx: any) {
  root.addEventListener("click", (event: any) => {
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
  root.addEventListener("dblclick", (event: any) => {
    const artifactLink = event.target.closest("[data-artifact]");
    if (artifactLink && root.contains(artifactLink)) ctx.openArtifact(...linkTarget(artifactLink, true));
  });
  root.addEventListener("auxclick", (event: any) => {
    const artifactLink = event.target.closest("[data-artifact]");
    if (event.button === 1 && artifactLink && root.contains(artifactLink)) {
      event.preventDefault();
      ctx.openArtifact(...linkTarget(artifactLink, true));
    }
  });
}

export function emptyNote(text: string) {
  return `<p class="empty-note">${escapeHtml(text)}</p>`;
}

export function keyValues(entries: any) {
  const rows = entries.filter(([, value]: any) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) {
    return "";
  }
  return `<dl class="key-values">${rows.map(([key, value]: any) => `<div><dt>${escapeHtml(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
