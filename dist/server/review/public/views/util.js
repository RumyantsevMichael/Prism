// Generated from src/server/review/public/views/util.ts by scripts/native-build/compile.mjs.
const EVIDENCE_ID = /^[a-f0-9]{64}$/;
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
const CODE_SUBJECT = /\.prism\/\S*?(?=[.,;:!?)]*(?:\s|$))|[\w.-]*[\w-]\.json\b/g;
function messageHtml(text) {
  const value = String(text ?? "");
  let html = "";
  let last = 0;
  for (const match of value.matchAll(CODE_SUBJECT)) {
    html += `${escapeHtml(value.slice(last, match.index))}<code data-code-subject>${escapeHtml(match[0])}</code>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(last));
}
function shortId(value) {
  return typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}\u2026${value.slice(-4)}` : String(value ?? "");
}
function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function formatSelector(selector) {
  if (selector === void 0 || selector === null || selector === "") {
    return "";
  }
  if (typeof selector === "string") {
    return selector;
  }
  if (selector.type === "span") {
    return `span ${selector.start}\u2013${selector.end}`;
  }
  return `${selector.type}: ${selector.value}`;
}
function formatReference(reference) {
  const selector = formatSelector(reference?.selector);
  return selector ? `${reference.path} \u203A ${selector}` : String(reference?.path ?? "");
}
function formatTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : String(value ?? "");
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(value, { year = false, now = /* @__PURE__ */ new Date() } = {}) {
  const day = new Date(value ?? "");
  if (!value || Number.isNaN(day.getTime())) return "";
  const shown = `${day.getDate()} ${MONTHS[day.getMonth()]}`;
  return year || day.getFullYear() !== now.getFullYear() ? `${shown} ${day.getFullYear()}` : shown;
}
function cardSource(source) {
  return source ? `<span class="card-source">${escapeHtml(source)}</span>` : "";
}
function card(title, body, { eyebrow = "", className = "", level = 2 } = {}) {
  return `<prism-panel class="view-section ${escapeHtml(className)}" heading="${escapeHtml(title)}"${eyebrow ? ` eyebrow="${escapeHtml(eyebrow)}"` : ""}${level === 2 ? "" : ` level="${level}"`}>${body}</prism-panel>`;
}
function summaryPanel(body, className = "") {
  return `<prism-panel class="view-section summary-block ${escapeHtml(className)}">${body}</prism-panel>`;
}
function stat(label, value, { tone = "", hint = "", tip = "", attributes = "" } = {}) {
  return `<prism-stat label="${escapeHtml(label)}" value="${escapeHtml(value)}"${hint ? ` hint="${escapeHtml(hint)}"` : ""}${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}></prism-stat>`;
}
function badge(text, tone = "neutral") {
  return `<prism-badge variant="status" tone="${escapeHtml(tone)}">${escapeHtml(text)}</prism-badge>`;
}
function status(value, { label = "", variant = "", glyphOnly = false, attributes = "" } = {}) {
  return `<prism-status value="${escapeHtml(value ?? "")}"${label ? ` label="${escapeHtml(label)}"` : ""}${variant ? ` variant="${escapeHtml(variant)}"` : ""}${glyphOnly ? " glyph-only" : ""}${attributes}></prism-status>`;
}
function recordStatus(text) {
  const written = String(text ?? "").trim();
  const [word = "", ...rest] = written.split(/\s+/);
  return status(word, { label: rest.length ? written : "" });
}
function chip(html, { tone = "", meta = "", tip = "", attributes = "" } = {}) {
  return `<prism-chip${tone ? ` tone="${escapeHtml(tone)}"` : ""}${tip ? ` tip="${escapeHtml(tip)}"` : ""}${attributes}>${html}${meta ? `<span slot="meta">${meta}</span>` : ""}</prism-chip>`;
}
function pageSub(html, { glyph = "", end = "", detail = false } = {}) {
  const slotted = (markup, slot) => markup.replace(/^<([a-z][\w-]*)/, `<$1 slot="${slot}"`);
  return `<prism-page-sub${detail ? " detail" : ""}>${glyph ? slotted(glyph, "glyph") : ""}${html}${end ? slotted(end, "end") : ""}</prism-page-sub>`;
}
function setPageSub(container, html, ctx) {
  const head = container.parentElement?.querySelector(".artifact-header > div:first-child");
  if (!head) return false;
  head.querySelector(":scope > [data-page-sub]")?.remove();
  if (!html) return true;
  const holder = document.createElement("div");
  holder.innerHTML = html.trim();
  const node = holder.firstElementChild;
  node.setAttribute("data-page-sub", "");
  head.append(node);
  bindLinks(node, ctx);
  return true;
}
function setPageHead(container, { eyebrow = "", end = "" } = {}, ctx = null) {
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
function emptyState(heading, text = "") {
  return `<prism-empty-state heading="${escapeHtml(heading)}">${text ? `<p>${escapeHtml(text)}</p>` : ""}</prism-empty-state>`;
}
function evidenceChip(id, label) {
  if (!id) {
    return "";
  }
  return `<prism-chip interactive tone="accent" data-evidence="${escapeHtml(id)}" data-label="${escapeHtml(label)}" tip="${escapeHtml(id)}">${escapeHtml(label)}<code slot="meta">${escapeHtml(shortId(id))}</code></prism-chip>`;
}
function artifactChip(path, ctx, label = path) {
  if (!path) {
    return "";
  }
  const code = label === path && !/^(?:initiative|slice):/.test(path) ? " data-code-subject" : "";
  if (!ctx.hasArtifact(path)) {
    return `<prism-chip tip="Not a reviewable artifact"${code}>${escapeHtml(label)}</prism-chip>`;
  }
  return `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(path)}"${code}>${escapeHtml(label)}</prism-chip>`;
}
function artifactLink(path, ctx, label = path) {
  if (!path) return "";
  const code = label === path && !/^(?:initiative|slice):/.test(path) ? " data-code-subject" : "";
  if (!ctx.hasArtifact(path)) return `<span class="muted"${code}>${escapeHtml(label)}</span>`;
  return `<a class="title-link" href="./review?artifact=${encodeURIComponent(path)}" data-artifact="${escapeHtml(path)}"${code}>${escapeHtml(label)}</a>`;
}
function pathName(path, ctx) {
  const named = ctx?.describe?.(path);
  if (!named || named.code) return { label: String(path ?? ""), code: true };
  const title = ctx.recordTitle?.(path) ?? named.label;
  return { label: title === named.kind ? named.kind : `${named.kind} \xB7 ${title}`, code: false };
}
function pathText(path, ctx, selector = "") {
  const { label, code } = pathName(path, ctx);
  const detail = selector ? ` \u203A ${escapeHtml(selector)}` : "";
  return code ? `<code data-code-subject>${escapeHtml(path)}${detail}</code>` : `<span>${escapeHtml(label)}${detail}</span>`;
}
function recordChip(path, ctx, { selector = "", anchor = "" } = {}) {
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
function documentTitle(path, ctx) {
  return ctx.recordTitle?.(path) ?? words(String(path).split("/").pop() ?? "");
}
function requirementLinks(references, ctx, { icon = null } = {}) {
  return references.map((reference) => {
    const [file, anchor] = reference.split("#");
    const title = documentTitle(file, ctx);
    const label = anchor ? `Requirement ${anchor} \xB7 ${title}` : `${title} \xB7 Requirements`;
    const glyph = icon ? `<prism-icon name="${escapeHtml(icon)}" size="xs"></prism-icon> ` : "";
    return ctx.hasArtifact(file) ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(file)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${glyph}${escapeHtml(label)}</prism-chip>` : `<prism-chip>${glyph}${escapeHtml(label)}</prism-chip>`;
  }).join(" ");
}
function requirementGroups(references, ctx) {
  const files = /* @__PURE__ */ new Map();
  for (const reference of references) {
    const [file, anchor] = reference.split("#");
    if (!files.has(file)) files.set(file, []);
    if (anchor) files.get(file).push(anchor);
  }
  return [...files].map(([file, anchors]) => {
    const title = documentTitle(file, ctx);
    const numbers = anchors.length ? `<span slot="meta">${escapeHtml(anchors.join(", "))}</span>` : "";
    const tip = anchors.length ? `${anchors.length === 1 ? "Requirement" : "Requirements"} ${anchors.join(", ")} of ${title}` : title;
    return ctx.hasArtifact(file) ? `<prism-chip interactive tone="accent" data-artifact="${escapeHtml(file)}"${anchors[0] ? ` data-doc-anchor="${escapeHtml(anchors[0])}"` : ""} tip="${escapeHtml(tip)}">${escapeHtml(title)}${numbers}</prism-chip>` : `<prism-chip tip="${escapeHtml(tip)}">${escapeHtml(title)}${numbers}</prism-chip>`;
  }).join(" ");
}
function linkTarget(element, keep) {
  return [element.dataset.artifact, { keep, anchor: element.dataset.docAnchor }];
}
function bindLinks(root, ctx) {
  root.addEventListener("click", (event) => {
    const evidence = event.target.closest("[data-evidence]");
    if (evidence && root.contains(evidence)) {
      event.preventDefault();
      ctx.openEvidence(evidence.dataset.evidence, evidence.dataset.label || "Evidence");
      return;
    }
    const artifactLink2 = event.target.closest("[data-artifact]");
    if (artifactLink2 && root.contains(artifactLink2)) {
      event.preventDefault();
      ctx.openArtifact(...linkTarget(artifactLink2, event.ctrlKey || event.metaKey));
    }
  });
  root.addEventListener("dblclick", (event) => {
    const artifactLink2 = event.target.closest("[data-artifact]");
    if (artifactLink2 && root.contains(artifactLink2)) ctx.openArtifact(...linkTarget(artifactLink2, true));
  });
  root.addEventListener("auxclick", (event) => {
    const artifactLink2 = event.target.closest("[data-artifact]");
    if (event.button === 1 && artifactLink2 && root.contains(artifactLink2)) {
      event.preventDefault();
      ctx.openArtifact(...linkTarget(artifactLink2, true));
    }
  });
}
function emptyNote(text) {
  return `<p class="empty-note">${escapeHtml(text)}</p>`;
}
function keyValues(entries) {
  const rows = entries.filter(([, value]) => value !== void 0 && value !== null && value !== "");
  if (rows.length === 0) {
    return "";
  }
  return `<dl class="key-values">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
export {
  EVIDENCE_ID,
  artifactChip,
  artifactLink,
  badge,
  bindLinks,
  card,
  cardSource,
  chip,
  documentTitle,
  emptyNote,
  emptyState,
  escapeHtml,
  evidenceChip,
  formatReference,
  formatSelector,
  formatTime,
  keyValues,
  messageHtml,
  pageSub,
  pathName,
  pathText,
  plural,
  recordChip,
  recordStatus,
  requirementGroups,
  requirementLinks,
  setPageHead,
  setPageSub,
  shortDate,
  shortId,
  stat,
  status,
  summaryPanel
};
