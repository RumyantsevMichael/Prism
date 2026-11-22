// Generated from src/server/review/public/views/preview.ts by scripts/native-build/compile.mjs.
import { entityLabel, parseEntityRef, progressBar, stateBadge } from "./entities.js";
import { highlight, highlightLines, languageOf } from "./highlight.js";
import { anchorTarget, LINE_RANGE } from "./markdown.js";
import { escapeHtml, pathName } from "./util.js";
import { themeDiagram } from "../kit/diagram-theme.js";
import { shippedHistoryHtml } from "./shipped-history.js";
import { viewKind } from "./design-views.js";
const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 200;
const CACHE_MS = 1e4;
const SOURCE_LINES = 400;
const DIAGRAM_WIDTH = 560;
const DIAGRAM_HEIGHT = 400;
const isHeading = (node) => /^H[1-6]$/.test(node.tagName);
function sectionOf(container, anchor) {
  const target = anchor ? anchorTarget(container, anchor) : null;
  const heading = target && isHeading(target) ? target : null;
  const start = target ?? container.firstElementChild;
  const blocks = [];
  const level = heading ? Number(heading.tagName[1]) : 7;
  for (let node = start; node; node = node.nextElementSibling) {
    if (target && node !== target && isHeading(node) && Number(node.tagName[1]) <= level) break;
    const copy = node.cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    blocks.push(copy.outerHTML);
  }
  return blocks.join("");
}
function entitySummary(entity) {
  const label = entityLabel(entity);
  const data = entity.data;
  let body = "";
  if (entity.kind === "initiative" && data.roadmapItem) {
    const item = data.roadmapItem;
    body = `<p>${stateBadge(item.state)} <span class="muted">${escapeHtml(item.band)}</span></p><p>${escapeHtml(item.intent ?? "")}</p>${progressBar(item.progress)}`;
  } else if (entity.kind === "slice") {
    body = `<p class="chip-row"><prism-badge variant="status">${escapeHtml(data.slice.status)}</prism-badge><span class="muted">${escapeHtml(data.initiativeTitle)}</span></p>${data.slice.outcome ? `<p>${escapeHtml(data.slice.outcome)}</p>` : ""}`;
  } else if (entity.kind === "roadmap") {
    body = `<p>${escapeHtml(data.serves || "")}</p><p class="muted">${data.items?.length ?? 0} initiatives</p>`;
  } else if (entity.kind === "attention" && data.filter) {
    body = `<p class="muted">${escapeHtml(data.filter.label)} \xB7 ${escapeHtml(String(data.filter.items.length))} of ${escapeHtml(String(data.filter.total))} items</p>`;
  } else if (entity.kind === "attention" && data.answered && !data.needsYou) {
    body = `<p class="muted">${escapeHtml(String(data.answered.length))} answered or closed in the last 7 days</p>`;
  } else if (entity.kind === "attention") {
    body = `<p class="muted">${escapeHtml(String(data.gateCount ?? 0))} recorded questions</p>`;
  } else if (Array.isArray(data.entries)) {
    body = `<p class="muted">${data.entries.length} documents</p>`;
  }
  return `${shippedHistoryHtml(data.shippedHistory)}<p class="eyebrow">${escapeHtml(label.eyebrow ?? entity.kind)}</p><h3>${escapeHtml(label.title)}</h3>${body}`;
}
function sourceRange(data, start, end) {
  const all = highlightLines(data.content.replace(/\r\n/g, "\n"), languageOf(data.path));
  const last = Math.min(end, all.length, start + SOURCE_LINES - 1);
  const lines = all.slice(start - 1, last).map((line, index) => `<li data-line="${start + index}"><code>${line || " "}</code></li>`).join("");
  const more = end > last ? `<p class="muted">${end - last} more lines; open the file to see them all.</p>` : "";
  return `<p class="preview-source" data-code-subject>${escapeHtml(data.path)} \xB7 lines ${start}\u2013${end}</p><ol class="source-lines preview-lines" data-code-subject>${lines}</ol>${more}`;
}
function fittedDiagram(svg) {
  const scratch = document.createElement("div");
  scratch.innerHTML = svg;
  const drawing = scratch.querySelector("svg");
  if (!drawing) return svg;
  const width = Number.parseFloat(drawing.getAttribute("width"));
  const height = Number.parseFloat(drawing.getAttribute("height"));
  if (width > 0 && height > 0) {
    if (!drawing.hasAttribute("viewBox")) drawing.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const room = { width: Math.min(DIAGRAM_WIDTH, window.innerWidth - 56), height: Math.min(DIAGRAM_HEIGHT, window.innerHeight * 0.7 - 90) };
    const scale = Math.max(0.05, Math.min(1, room.width / width, room.height / height));
    drawing.setAttribute("width", String(Math.round(width * scale)));
    drawing.setAttribute("height", String(Math.round(height * scale)));
  }
  drawing.setAttribute("aria-hidden", "true");
  return scratch.innerHTML;
}
async function diagramSummary(head, source, drawDiagram) {
  if (!drawDiagram) return `${head}<h3>PlantUML diagram</h3>`;
  const drawn = await drawDiagram(source);
  return drawn.error ? `${head}<p class="error">${escapeHtml(drawn.error)}</p>` : `${head}<div class="preview-diagram" data-diagram-sheet>${fittedDiagram(drawn.svg)}</div>`;
}
function previewHead(data, describe) {
  if (data.view) return `<p class="preview-source">${escapeHtml(viewKind(data.view))}</p><h3>${escapeHtml(data.view.question)}</h3>`;
  const { label, code } = pathName(data.path, { describe });
  return code ? `<p class="preview-source" data-code-subject>${escapeHtml(data.path)}</p>` : `<p class="preview-source">${escapeHtml(label)}</p>`;
}
async function fileSummary(data, anchor, { renderMarkdown, kindLabel, drawDiagram, describe }) {
  const head = previewHead(data, describe);
  if (data.kind === "source") {
    const range = anchor?.match(LINE_RANGE);
    if (range) return sourceRange(data, Number(range[1]), Number(range[2] ?? range[1]));
    const all = data.content.split(/\r?\n/);
    const language = languageOf(data.path);
    const more = all.length > SOURCE_LINES ? `<p class="muted">${all.length - SOURCE_LINES} more lines; open the file to see them all.</p>` : "";
    return `${head}<prism-code${language ? ` language="${language}"` : ""}><pre><code>${highlight(all.slice(0, SOURCE_LINES).join("\n"), language)}</code></pre></prism-code>${more}`;
  }
  if (data.kind) return `${head}<h3>${escapeHtml(kindLabel(data.kind))}</h3>`;
  if (data.path.toLowerCase().endsWith(".puml")) return diagramSummary(head, data.content, drawDiagram);
  const scratch = document.createElement("div");
  scratch.innerHTML = renderMarkdown(data.path, data.content, data.links);
  const section = sectionOf(scratch, anchor);
  return `${head}<prism-doc class="document-content">${section || '<p class="muted">The document is empty.</p>'}</prism-doc>`;
}
async function documentHistory(ref, fetchJson) {
  if (ref.split("/").pop() !== "slice.md") return null;
  const context = await fetchJson(`./api/context?ref=${encodeURIComponent(ref)}`).catch(() => null);
  return context?.shippedHistory ?? null;
}
async function previewHtml({ ref, anchor = null }, { fetchJson, fetchArtifact, renderMarkdown, kindLabel, drawDiagram = null, describe = null }) {
  if (parseEntityRef(ref)) return entitySummary(await fetchJson(`./api/entity?ref=${encodeURIComponent(ref)}`));
  const [data, history] = await Promise.all([fetchArtifact(ref), documentHistory(ref, fetchJson)]);
  return `${shippedHistoryHtml(history)}${await fileSummary(data, anchor, { renderMarkdown, kindLabel, drawDiagram, describe })}`;
}
function createLinkPreview({ root, fetchJson, fetchArtifact, renderMarkdown, kindLabel, currentPath, drawDiagram = null, onShowInPanel = null, describe = null }) {
  const popover = document.createElement("prism-hover-card");
  popover.className = "link-preview";
  popover.hidden = true;
  document.body.appendChild(popover);
  const cache = /* @__PURE__ */ new Map();
  let anchorElement = null;
  let showTimer = 0;
  let hideTimer = 0;
  let request = 0;
  let pending = null;
  function targetOf(element) {
    const anchor = element.dataset.docAnchor ?? null;
    if (element.dataset.docLink) return { ref: element.dataset.docLink, anchor };
    if (element.dataset.artifact) return { ref: element.dataset.artifact, anchor };
    return anchor && !element.closest("prism-contents") && currentPath() ? { ref: currentPath(), anchor } : null;
  }
  async function load({ ref, anchor }) {
    const key = `${ref}#${anchor ?? ""}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.html;
    const html = await previewHtml({ ref, anchor }, { fetchJson, fetchArtifact, renderMarkdown, kindLabel, drawDiagram, describe });
    cache.set(key, { at: Date.now(), html });
    return html;
  }
  async function show(element) {
    const target = targetOf(element);
    if (!target) return;
    const current = ++request;
    try {
      const html = await load(target);
      if (current !== request || anchorElement !== element || !element.isConnected) return;
      const content = document.createElement("div");
      content.className = "link-preview-content";
      content.innerHTML = html;
      const parts = [content];
      if (onShowInPanel && !parseEntityRef(target.ref)) {
        const button = document.createElement("prism-button");
        button.setAttribute("slot", "actions");
        button.setAttribute("variant", "ghost");
        button.setAttribute("size", "sm");
        button.textContent = "Show in side panel";
        button.setAttribute("tip", "Show the whole file beside this page (Alt+click the link)");
        button.addEventListener("click", () => {
          hide();
          onShowInPanel(target.ref, target.anchor);
        });
        parts.unshift(button);
      }
      popover.replaceContent(...parts);
      popover.toggleAttribute("wide", Boolean(content.querySelector("prism-doc, prism-code, .preview-lines, .preview-diagram")));
      const sheet = popover.querySelector("[data-diagram-sheet]");
      if (sheet) themeDiagram(sheet.querySelector("svg"));
      popover.showAt(element);
    } catch {
      if (current === request) hide();
    }
  }
  function hide() {
    clearTimeout(showTimer);
    pending = null;
    request += 1;
    popover.hidden = true;
    anchorElement = null;
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }
  function enter(element) {
    clearTimeout(hideTimer);
    if (element === anchorElement) {
      cancelSwitch();
      return;
    }
    if (popover.hidden) {
      hide();
      anchorElement = element;
      showTimer = setTimeout(() => show(element), SHOW_DELAY_MS);
      return;
    }
    clearTimeout(showTimer);
    pending = element;
    showTimer = setTimeout(() => {
      pending = null;
      request += 1;
      anchorElement = element;
      show(element);
    }, SHOW_DELAY_MS);
  }
  function cancelSwitch() {
    if (!pending) return;
    clearTimeout(showTimer);
    pending = null;
  }
  const selector = "[data-artifact], a[data-doc-link], a[data-doc-anchor]";
  root.addEventListener("pointerover", (event) => {
    const element = event.target.closest(selector);
    if (element && event.pointerType !== "touch" && root.contains(element)) enter(element);
  });
  root.addEventListener("pointerout", (event) => {
    const element = event.target.closest(selector);
    if (!element || element.contains(event.relatedTarget)) return;
    if (element === pending) {
      cancelSwitch();
      if (!popover.contains(event.relatedTarget)) scheduleHide();
    } else if (element === anchorElement) scheduleHide();
  });
  root.addEventListener("focusin", (event) => {
    const element = event.target.closest(selector);
    if (element) enter(element);
  });
  root.addEventListener("focusout", (event) => {
    const element = event.target.closest(selector);
    if (!element) return;
    if (element === pending) cancelSwitch();
    else if (element !== anchorElement) return;
    scheduleHide();
  });
  root.addEventListener("click", hide);
  popover.addEventListener("pointerenter", () => {
    clearTimeout(hideTimer);
    cancelSwitch();
  });
  popover.addEventListener("pointerleave", scheduleHide);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) hide();
  });
  const follow = (event) => {
    if (popover.hidden || !anchorElement || popover.contains(event.target)) return;
    const rect = anchorElement.getBoundingClientRect();
    if (!anchorElement.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) hide();
    else popover.place(anchorElement);
  };
  document.addEventListener("scroll", follow, { capture: true, passive: true });
  window.addEventListener("resize", follow);
  return { hide };
}
export {
  createLinkPreview,
  previewHtml
};
