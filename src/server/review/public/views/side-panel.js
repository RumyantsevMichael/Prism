import { highlight, highlightLines, languageOf } from "./highlight.js";
import { anchorTarget, decorateFolds, HEADING_PREFIX, LINE_RANGE, revealInDocument } from "./markdown.js";
import { escapeHtml } from "./util.js";

const WIDTH_KEY = "prism.sidePanelWidth";
const MIN_WIDTH = 320;
const MAX_SHARE = 0.42;

function storedWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(value) {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(value)));
  } catch {
  }
}

function fileName(path) {
  return path.split("/").pop() || path;
}

// The panel shows a file the way its tab would show its text: Markdown rendered, code highlighted with line numbers, and a record or diagram as highlighted source.
function fileBody(data, { renderMarkdown }) {
  if (data.kind === "source") {
    const lines = highlightLines(data.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(data.path));
    return `<ol class="source-lines">${lines.map((line, index) => `<li id="${HEADING_PREFIX}L${index + 1}"><code>${line || " "}</code></li>`).join("")}</ol>`;
  }
  if (data.path.toLowerCase().endsWith(".md")) {
    return `<div class="document-content">${renderMarkdown(data.path, data.content) || '<p class="muted">The document is empty.</p>'}</div>`;
  }
  const language = languageOf(data.path);
  const note = data.kind || language === "plantuml" ? `<p class="side-panel-note">Open it as a tab to see it ${language === "plantuml" ? "drawn" : "as a structured view"}.</p>` : "";
  return `${note}<pre><code>${highlight(data.content, language)}</code></pre>`;
}

/**
 * One panel beside the workspace that shows a single item at a time: a file opened from a link preview or link, or other context such as a review finding.
 * Opening another item replaces the current one; there are no tabs.
 */
export function createSidePanel({ shell, fetchJson, renderMarkdown, onOpenTab, onChange }) {
  const root = document.getElementById("side-panel");
  const kind = document.getElementById("side-panel-kind");
  const title = document.getElementById("side-panel-title");
  const source = document.getElementById("side-panel-source");
  const body = document.getElementById("side-panel-body");
  const openButton = document.getElementById("side-panel-open");
  const closeButton = document.getElementById("side-panel-close");
  const resizer = document.getElementById("side-panel-resizer");
  let current = null;
  let request = 0;

  const applyWidth = (value) => {
    // The workspace keeps most of the window; the stylesheet applies the same cap when the window shrinks later.
    const limit = Math.max(MIN_WIDTH, window.innerWidth * MAX_SHARE);
    const width = Math.min(Math.max(value, MIN_WIDTH), limit);
    shell.style.setProperty("--side-panel-width", `${width}px`);
    return width;
  };
  const saved = storedWidth();
  if (saved) applyWidth(saved);

  function setOpen(open) {
    root.hidden = !open;
    shell.classList.toggle("has-side-panel", open);
    onChange?.(open);
  }

  function header({ eyebrow, name, detail, ref }) {
    kind.textContent = eyebrow;
    title.textContent = name;
    title.title = name;
    source.textContent = detail ?? "";
    source.title = detail ?? "";
    source.hidden = !detail;
    openButton.hidden = !ref;
  }

  function scrollTo(anchor) {
    body.querySelectorAll(".source-lines li.in-range").forEach((line) => line.classList.remove("in-range"));
    if (!anchor) {
      body.scrollTop = 0;
      return;
    }
    const target = anchorTarget(body, anchor);
    if (!target) return;
    revealInDocument(target);
    const range = anchor.match(LINE_RANGE);
    if (range) {
      const end = Number(range[2] ?? range[1]);
      for (let line = target; line && Number(line.id.slice(HEADING_PREFIX.length + 1)) <= end; line = line.nextElementSibling) line.classList.add("in-range");
    }
    body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
  }

  function render(data, anchor, { keepScroll = false } = {}) {
    const top = body.scrollTop;
    body.innerHTML = fileBody(data, { renderMarkdown });
    for (const content of body.querySelectorAll(".document-content")) decorateFolds(content, current.folds);
    if (keepScroll) body.scrollTop = top;
    else scrollTo(anchor);
  }

  async function showFile(path, anchor = null) {
    const ticket = ++request;
    const same = current?.ref === path;
    current = { ref: path, anchor, content: same ? current.content : null, folds: same ? current.folds : new Set() };
    header({ eyebrow: "File", name: fileName(path), detail: anchor ? `${path} · ${anchor.match(LINE_RANGE) ? `lines ${anchor.slice(1).replace("-", "–")}` : `#${anchor}`}` : path, ref: path });
    setOpen(true);
    if (same && current.content !== null) {
      scrollTo(anchor);
      return;
    }
    body.innerHTML = '<p class="muted side-panel-loading">Loading…</p>';
    try {
      const data = await fetchJson(`./api/artifact?path=${encodeURIComponent(path)}`);
      if (ticket !== request) return;
      current.content = data.content;
      render(data, anchor);
    } catch (error) {
      if (ticket !== request) return;
      body.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }

  // Shows prepared content, such as a review finding, with an optional tab to open for the whole record.
  function showContent({ eyebrow, name, detail = null, html, ref = null }) {
    ++request;
    current = { ref, anchor: null, content: null, folds: new Set(), custom: true };
    header({ eyebrow, name, detail, ref });
    body.innerHTML = html;
    for (const content of body.querySelectorAll(".document-content")) decorateFolds(content, current.folds);
    body.scrollTop = 0;
    setOpen(true);
  }

  function close() {
    ++request;
    current = null;
    body.replaceChildren();
    setOpen(false);
  }

  // A changed file re-renders in place and keeps the reader's scroll position; an unchanged one is left alone.
  async function refresh() {
    if (!current?.ref || current.custom || current.content === null) return;
    const ticket = request;
    try {
      const data = await fetchJson(`./api/artifact?path=${encodeURIComponent(current.ref)}`);
      if (ticket !== request || !current || data.content === current.content) return;
      current.content = data.content;
      render(data, current.anchor, { keepScroll: true });
    } catch {
    }
  }

  openButton.addEventListener("click", () => {
    if (current?.ref) onOpenTab(current.ref, current.anchor);
  });
  closeButton.addEventListener("click", close);

  // Dragging the panel's edge sets its width, which the browser remembers.
  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    const right = shell.getBoundingClientRect().right;
    const move = (next) => applyWidth(right - next.clientX);
    const stop = (last) => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      storeWidth(applyWidth(right - last.clientX));
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const width = root.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 32 : -32);
    storeWidth(applyWidth(width));
  });

  return { showFile, showContent, close, refresh, isOpen: () => !root.hidden, body, current: () => current };
}
