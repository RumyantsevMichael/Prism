import { entityLabel, parseEntityRef, progressBar, stateBadge } from "./entities.js";
import { highlight, highlightLines, languageOf } from "./highlight.js";
import { anchorTarget, LINE_RANGE } from "./markdown.js";
import { escapeHtml, pathName } from "./util.js";
import { themeDiagram } from "../kit/diagram-theme.js";

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 200;
const CACHE_MS = 10000;
const BLOCK_LIMIT = 8;
const SOURCE_LINES = 14;
const RANGE_LINES = 40;
// A diagram shrinks to fit a preview larger than a text preview, within the window, and never grows past its drawn size.
const DIAGRAM_WIDTH = 560;
const DIAGRAM_HEIGHT = 400;

function sectionOf(container, anchor) {
  const target = anchorTarget(container, anchor);
  const heading = target && /^H[1-6]$/.test(target.tagName) ? target : null;
  const start = target ?? container.firstElementChild;
  const blocks = [];
  const level = heading ? Number(heading.tagName[1]) : 0;
  for (let node = start; node && blocks.length < BLOCK_LIMIT; node = node.nextElementSibling) {
    if (heading && node !== heading && /^H[1-6]$/.test(node.tagName) && Number(node.tagName[1]) <= level) break;
    // Copies drop heading ids so the preview never duplicates an id of the open document.
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
  } else if (entity.kind === "attention") {
    body = `<p class="muted">${escapeHtml(String(data.gateCount ?? 0))} recorded questions</p>`;
  } else if (Array.isArray(data.entries)) {
    body = `<p class="muted">${data.entries.length} documents</p>`;
  }
  return `<p class="eyebrow">${escapeHtml(label.eyebrow ?? entity.kind)}</p><h3>${escapeHtml(label.title)}</h3>${body}`;
}

// A line range previews those lines with their numbers, up to a cap, so a planned change shows the code it touches.
function sourceRange(data, start, end) {
  const all = highlightLines(data.content.replace(/\r\n/g, "\n"), languageOf(data.path));
  const last = Math.min(end, all.length, start + RANGE_LINES - 1);
  const lines = all.slice(start - 1, last).map((line, index) => `<li data-line="${start + index}"><code>${line || " "}</code></li>`).join("");
  const more = end > last ? `<p class="muted">${end - last} more lines; open the file to see them all.</p>` : "";
  return `<p class="preview-source" data-code-subject>${escapeHtml(data.path)} · lines ${start}–${end}</p><ol class="source-lines preview-lines" data-code-subject>${lines}</ol>${more}`;
}

function fittedDiagram(svg) {
  const scratch = document.createElement("div");
  scratch.innerHTML = svg;
  const drawing = scratch.querySelector("svg");
  if (!drawing) return svg;
  const width = Number.parseFloat(drawing.getAttribute("width"));
  const height = Number.parseFloat(drawing.getAttribute("height"));
  if (width > 0 && height > 0) {
    // A viewBox lets the drawing scale with its new size instead of being cropped.
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
  return drawn.error
    ? `${head}<p class="error">${escapeHtml(drawn.error)}</p>`
    : `${head}<div class="preview-diagram" data-diagram-sheet>${fittedDiagram(drawn.svg)}</div>`;
}

// A preview names one of Prism's records by title and kind, and a repository file by its path, where code is the subject.
function previewHead(data, describe) {
  const { label, code } = pathName(data.path, { describe });
  return code ? `<p class="preview-source" data-code-subject>${escapeHtml(data.path)}</p>` : `<p class="preview-source">${escapeHtml(label)}</p>`;
}

async function fileSummary(data, anchor, { renderMarkdown, kindLabel, drawDiagram, describe }) {
  const head = previewHead(data, describe);
  if (data.kind === "source") {
    const range = anchor?.match(LINE_RANGE);
    if (range) return sourceRange(data, Number(range[1]), Number(range[2] ?? range[1]));
    const lines = data.content.split(/\r?\n/).slice(0, SOURCE_LINES).join("\n");
    const language = languageOf(data.path);
    return `${head}<prism-code${language ? ` language="${language}"` : ""}><pre><code>${highlight(lines, language)}</code></pre></prism-code>`;
  }
  if (data.kind) return `${head}<h3>${escapeHtml(kindLabel(data.kind))}</h3>`;
  if (data.path.toLowerCase().endsWith(".puml")) return diagramSummary(head, data.content, drawDiagram);
  const scratch = document.createElement("div");
  scratch.innerHTML = renderMarkdown(data.path, data.content);
  const section = sectionOf(scratch, anchor);
  return `${head}<prism-doc class="document-content">${section || '<p class="muted">The document is empty.</p>'}</prism-doc>`;
}

// Hovering or focusing an internal link shows what it points to: an entity's summary, the start of a file or the linked section, or a diagram drawn small.
// A file's preview offers to show the whole file in the side panel when the page has one.
// The preview is a hover card on glass that only repeats what the link leads to, so it is no landmark or dialog of its own.
export function createLinkPreview({ root, fetchJson, renderMarkdown, kindLabel, currentPath, drawDiagram = null, onShowInPanel = null, describe = null }) {
  const popover = document.createElement("div");
  popover.className = "link-preview";
  popover.hidden = true;
  document.body.appendChild(popover);
  const cache = new Map();
  let anchorElement = null;
  let showTimer = 0;
  let hideTimer = 0;
  let request = 0;

  function targetOf(element) {
    const anchor = element.dataset.docAnchor ?? null;
    if (element.dataset.docLink) return { ref: element.dataset.docLink, anchor };
    if (element.dataset.artifact) return { ref: element.dataset.artifact, anchor };
    // An in-document anchor previews its section of the open document; contents entries need no preview.
    return anchor && !element.closest(".doc-toc") && currentPath() ? { ref: currentPath(), anchor } : null;
  }

  async function load({ ref, anchor }) {
    const key = `${ref}#${anchor ?? ""}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.html;
    const html = parseEntityRef(ref)
      ? entitySummary(await fetchJson(`./api/entity?ref=${encodeURIComponent(ref)}`))
      : await fileSummary(await fetchJson(`./api/artifact?path=${encodeURIComponent(ref)}`), anchor, { renderMarkdown, kindLabel, drawDiagram, describe });
    cache.set(key, { at: Date.now(), html });
    return html;
  }

  function place() {
    const rect = anchorElement.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  async function show(element) {
    const target = targetOf(element);
    if (!target) return;
    const current = ++request;
    try {
      const html = await load(target);
      if (current !== request || anchorElement !== element || !element.isConnected) return;
      popover.innerHTML = html;
      if (onShowInPanel && !parseEntityRef(target.ref)) {
        const bar = document.createElement("div");
        bar.className = "link-preview-actions";
        const button = document.createElement("prism-button");
        button.setAttribute("variant", "ghost");
        button.setAttribute("size", "sm");
        button.textContent = "Show in side panel";
        button.setAttribute("tip", "Show the whole file beside this page (Alt+click the link)");
        button.addEventListener("click", () => {
          hide();
          onShowInPanel(target.ref, target.anchor);
        });
        bar.append(button);
        popover.prepend(bar);
      }
      popover.hidden = false;
      // A previewed diagram is recolored for the theme from the runtime's SVG text each time it shows.
      const sheet = popover.querySelector("[data-diagram-sheet]");
      if (sheet) themeDiagram(sheet.querySelector("svg"));
      place();
    } catch {
      if (current === request) hide();
    }
  }

  function hide() {
    clearTimeout(showTimer);
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
    if (element === anchorElement) return;
    hide();
    anchorElement = element;
    showTimer = setTimeout(() => show(element), SHOW_DELAY_MS);
  }

  const selector = "[data-artifact], a[data-doc-link], a[data-doc-anchor]";
  root.addEventListener("pointerover", (event) => {
    const element = event.target.closest(selector);
    if (element && event.pointerType !== "touch" && root.contains(element)) enter(element);
  });
  root.addEventListener("pointerout", (event) => {
    const element = event.target.closest(selector);
    if (element && element === anchorElement && !element.contains(event.relatedTarget)) scheduleHide();
  });
  root.addEventListener("focusin", (event) => {
    const element = event.target.closest(selector);
    if (element) enter(element);
  });
  root.addEventListener("focusout", (event) => {
    if (event.target.closest(selector) === anchorElement) scheduleHide();
  });
  root.addEventListener("click", hide);
  popover.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  popover.addEventListener("pointerleave", scheduleHide);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) hide();
  });
  return { hide };
}
