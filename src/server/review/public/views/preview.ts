import { entityLabel, parseEntityRef, progressBar, stateBadge } from "./entities.js";
import { highlight, highlightLines, languageOf } from "./highlight.js";
import { anchorTarget, LINE_RANGE } from "./markdown.js";
import { escapeHtml, pathName } from "./util.js";
import { themeDiagram } from "../kit/diagram-theme.js";
import { shippedHistoryHtml } from "./shipped-history.js";
import { viewKind } from "./design-views.js";

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 200;
const CACHE_MS = 10000;
// A source file previews whole up to this many lines, and a line range up to as many from its start, since the card scrolls.
const SOURCE_LINES = 400;
// A diagram shrinks to fit the card, within the window, and never grows past its drawn size.
const DIAGRAM_WIDTH = 560;
const DIAGRAM_HEIGHT = 400;

const isHeading = (node: any) => /^H[1-6]$/.test(node.tagName);

// A link with an anchor previews the whole section it names: a heading and everything up to the next heading of its level or above,
// or a block and everything up to the next heading. A link without one previews the whole document.
function sectionOf(container: any, anchor: any) {
  const target = anchor ? anchorTarget(container, anchor) : null;
  const heading = target && isHeading(target) ? target : null;
  const start = target ?? container.firstElementChild;
  const blocks = [];
  const level = heading ? Number(heading.tagName[1]) : 7;
  for (let node = start; node; node = node.nextElementSibling) {
    if (target && node !== target && isHeading(node) && Number(node.tagName[1]) <= level) break;
    // Copies drop heading ids so the preview never duplicates an id of the open document.
    const copy = node.cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((element: any) => element.removeAttribute("id"));
    blocks.push(copy.outerHTML);
  }
  return blocks.join("");
}

function entitySummary(entity: any) {
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
    body = `<p class="muted">${escapeHtml(data.filter.label)} · ${escapeHtml(String(data.filter.items.length))} of ${escapeHtml(String(data.filter.total))} items</p>`;
  } else if (entity.kind === "attention" && data.answered && !data.needsYou) {
    body = `<p class="muted">${escapeHtml(String(data.answered.length))} answered or closed in the last 7 days</p>`;
  } else if (entity.kind === "attention") {
    body = `<p class="muted">${escapeHtml(String(data.gateCount ?? 0))} recorded questions</p>`;
  } else if (Array.isArray(data.entries)) {
    body = `<p class="muted">${data.entries.length} documents</p>`;
  }
  return `${shippedHistoryHtml(data.shippedHistory)}<p class="eyebrow">${escapeHtml(label.eyebrow ?? entity.kind)}</p><h3>${escapeHtml(label.title)}</h3>${body}`;
}

// A line range previews those lines with their numbers, up to a cap, so a planned change shows the code it touches.
function sourceRange(data: any, start: any, end: any) {
  const all = highlightLines(data.content.replace(/\r\n/g, "\n"), languageOf(data.path));
  const last = Math.min(end, all.length, start + SOURCE_LINES - 1);
  const lines = all.slice(start - 1, last).map((line, index) => `<li data-line="${start + index}"><code>${line || " "}</code></li>`).join("");
  const more = end > last ? `<p class="muted">${end - last} more lines; open the file to see them all.</p>` : "";
  return `<p class="preview-source" data-code-subject>${escapeHtml(data.path)} · lines ${start}–${end}</p><ol class="source-lines preview-lines" data-code-subject>${lines}</ol>${more}`;
}

function fittedDiagram(svg: any) {
  const scratch = document.createElement("div");
  scratch.innerHTML = svg;
  const drawing = scratch.querySelector("svg");
  if (!drawing) return svg;
  const width = Number.parseFloat((drawing.getAttribute("width") as any));
  const height = Number.parseFloat((drawing.getAttribute("height") as any));
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

async function diagramSummary(head: any, source: any, drawDiagram: any) {
  if (!drawDiagram) return `${head}<h3>PlantUML diagram</h3>`;
  const drawn = await drawDiagram(source);
  return drawn.error
    ? `${head}<p class="error">${escapeHtml(drawn.error)}</p>`
    : `${head}<div class="preview-diagram" data-diagram-sheet>${fittedDiagram(drawn.svg)}</div>`;
}

// A preview names one of Prism's records by title and kind, and a repository file by its path, where code is the subject.
// A declared design view previews by its kind and the question it answers.
function previewHead(data: any, describe: any) {
  if (data.view) return `<p class="preview-source">${escapeHtml(viewKind(data.view))}</p><h3>${escapeHtml(data.view.question)}</h3>`;
  const { label, code } = pathName(data.path, { describe });
  return code ? `<p class="preview-source" data-code-subject>${escapeHtml(data.path)}</p>` : `<p class="preview-source">${escapeHtml(label)}</p>`;
}

async function fileSummary(data: any, anchor: any, { renderMarkdown, kindLabel, drawDiagram, describe }: { renderMarkdown: any; kindLabel: any; drawDiagram: any; describe: any }) {
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

// A slice document of a shipped initiative previews with the label its page shows, so a link to old work never reads as current intent.
async function documentHistory(ref: any, fetchJson: any) {
  if (ref.split("/").pop() !== "slice.md") return null;
  const context = await fetchJson(`./api/context?ref=${encodeURIComponent(ref)}`).catch(() => null);
  return context?.shippedHistory ?? null;
}

/**
 * The preview of an internal link's target: an entity's summary, or a whole file or its linked section under any shipped history label it carries.
 * A file is read with fetchArtifact, the page's own read of a tab, so a link previews exactly the artifact that following it opens.
 */
export async function previewHtml({ ref, anchor = null }: { ref: any; anchor?: any }, { fetchJson, fetchArtifact, renderMarkdown, kindLabel, drawDiagram = null, describe = null }: { fetchJson: any; fetchArtifact: any; renderMarkdown: any; kindLabel: any; drawDiagram?: any; describe?: any }) {
  if (parseEntityRef(ref)) return entitySummary(await fetchJson(`./api/entity?ref=${encodeURIComponent(ref)}`));
  const [data, history] = await Promise.all([fetchArtifact(ref), documentHistory(ref, fetchJson)]);
  return `${shippedHistoryHtml(history)}${await fileSummary(data, anchor, { renderMarkdown, kindLabel, drawDiagram, describe })}`;
}

// Hovering or focusing an internal link shows what it points to: an entity's summary, the start of a file or the linked section, or a diagram drawn small.
// A file's preview offers to show the whole file in the side panel when the page has one.
// The preview is a hover card on glass that only repeats what the link leads to, so it is no landmark or dialog of its own.
export function createLinkPreview({ root, fetchJson, fetchArtifact, renderMarkdown, kindLabel, currentPath, drawDiagram = null, onShowInPanel = null, describe = null }: { root: any; fetchJson: any; fetchArtifact: any; renderMarkdown: any; kindLabel: any; currentPath: any; drawDiagram?: any; onShowInPanel?: any; describe?: any }) {
  const popover: any = document.createElement("prism-hover-card");
  popover.className = "link-preview";
  popover.hidden = true;
  document.body.appendChild(popover);
  const cache = new Map();
  let anchorElement: any = null;
  let showTimer = 0;
  let hideTimer = 0;
  let request = 0;
  // A link the pointer entered while a preview was open, which takes the preview over only if the pointer rests on it.
  let pending: any = null;

  function targetOf(element: any) {
    const anchor = element.dataset.docAnchor ?? null;
    if (element.dataset.docLink) return { ref: element.dataset.docLink, anchor };
    if (element.dataset.artifact) return { ref: element.dataset.artifact, anchor };
    // An in-document anchor previews its section of the open document; contents entries need no preview.
    return anchor && !element.closest("prism-contents") && currentPath() ? { ref: currentPath(), anchor } : null;
  }

  async function load({ ref, anchor }: { ref: any; anchor: any }) {
    const key = `${ref}#${anchor ?? ""}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.html;
    const html = await previewHtml({ ref, anchor }, { fetchJson, fetchArtifact, renderMarkdown, kindLabel, drawDiagram, describe });
    cache.set(key, { at: Date.now(), html });
    return html;
  }

  async function show(element: any) {
    const target = targetOf(element);
    if (!target) return;
    const current = ++request;
    try {
      const html = await load(target);
      if (current !== request || anchorElement !== element || !element.isConnected) return;
      const content = document.createElement("div");
      content.className = "link-preview-content";
      content.innerHTML = html;
      const parts: any[] = [content];
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
      // A document, a source file, or a diagram takes the card's full width, so the card keeps its size while the pointer moves between such links.
      popover.toggleAttribute("wide", Boolean(content.querySelector("prism-doc, prism-code, .preview-lines, .preview-diagram")));
      // A previewed diagram is recolored for the theme from the runtime's SVG text each time it shows.
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
    (hideTimer as any) = setTimeout(hide, HIDE_DELAY_MS);
  }

  function enter(element: any) {
    clearTimeout(hideTimer);
    if (element === anchorElement) {
      cancelSwitch();
      return;
    }
    if (popover.hidden) {
      hide();
      anchorElement = element;
      (showTimer as any) = setTimeout(() => show(element), SHOW_DELAY_MS);
      return;
    }
    // An open preview stays while the pointer crosses a neighboring link on its way to the preview, such as the next item of a list;
    // only resting on that link switches the preview to it, and reaching the preview first cancels the switch.
    clearTimeout(showTimer);
    pending = element;
    (showTimer as any) = setTimeout(() => {
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
  root.addEventListener("pointerover", (event: any) => {
    const element = event.target.closest(selector);
    if (element && event.pointerType !== "touch" && root.contains(element)) enter(element);
  });
  root.addEventListener("pointerout", (event: any) => {
    const element = event.target.closest(selector);
    if (!element || element.contains(event.relatedTarget)) return;
    if (element === pending) {
      // Leaving a crossed link keeps the open preview only if the pointer goes on to it.
      cancelSwitch();
      if (!popover.contains(event.relatedTarget)) scheduleHide();
    } else if (element === anchorElement) scheduleHide();
  });
  root.addEventListener("focusin", (event: any) => {
    const element = event.target.closest(selector);
    if (element) enter(element);
  });
  root.addEventListener("focusout", (event: any) => {
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
  // The card follows its link when the page scrolls or the window resizes, and closes once the link leaves the window; scrolling inside the card reads on.
  const follow = (event: any) => {
    if (popover.hidden || !anchorElement || popover.contains(event.target)) return;
    const rect = anchorElement.getBoundingClientRect();
    if (!anchorElement.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) hide();
    else popover.place(anchorElement);
  };
  document.addEventListener("scroll", follow, { capture: true, passive: true });
  window.addEventListener("resize", follow);
  return { hide };
}
