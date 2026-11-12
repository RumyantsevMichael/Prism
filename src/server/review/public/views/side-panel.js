import { highlight, highlightLines, languageOf } from "./highlight.js";
import { anchorTarget, decorateFolds, HEADING_PREFIX, LINE_RANGE, revealInDocument } from "./markdown.js";
import { escapeHtml } from "./util.js";
import { onPreferencesChange, preference, setPreference } from "../kit/preferences.js";

// The panel's width is the person's preference, kept by the review app for every port; the width an older page kept in this browser moves there once.
const LEGACY_WIDTH_KEY = "prism.sidePanelWidth";
const MIN_WIDTH = 320;
const MAX_SHARE = 0.42;

function storedWidth() {
  const value = preference("sidePanel.width");
  return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
}

function storeWidth(value) {
  void setPreference("sidePanel.width", Math.round(value)).catch(() => {});
}

function legacyWidth() {
  try {
    const value = Number(localStorage.getItem(LEGACY_WIDTH_KEY));
    localStorage.removeItem(LEGACY_WIDTH_KEY);
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

// The panel shows a file the way its tab shows it: Markdown rendered with its diagrams drawn, code highlighted with line numbers, a diagram drawn, and a record as highlighted source.
function fileBody(data, { renderMarkdown }) {
  if (data.kind === "source") {
    const lines = highlightLines(data.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(data.path));
    return `<ol class="source-lines">${lines.map((line, index) => `<li id="${HEADING_PREFIX}L${index + 1}"><code>${line || " "}</code></li>`).join("")}</ol>`;
  }
  if (data.path.toLowerCase().endsWith(".md")) {
    return `<prism-doc class="document-content">${renderMarkdown(data.path, data.content, data.links) || '<p class="muted">The document is empty.</p>'}</prism-doc>`;
  }
  if (data.path.toLowerCase().endsWith(".puml")) return "";
  const note = data.kind ? '<p class="side-panel-note">Open it as a page to see it as a structured view.</p>' : "";
  return `${note}<prism-code language="${escapeHtml(languageOf(data.path) ?? "")}"><pre><code>${highlight(data.content, languageOf(data.path))}</code></pre></prism-code>`;
}

const NARROW = "(max-width: 720px)";

/**
 * One island beside the main island that shows a single item at a time: a file opened from a link preview or link, or other context such as a review finding.
 * Opening another item replaces the current one. At 720px and below the island opens in `sheet`, a prism-dialog that rises from the bottom edge.
 * `describe(path)` names a file: { label, kind, code }, where code marks a repository file whose path is the subject.
 */
export function createSidePanel({ shell, sheet = null, fetchJson, renderMarkdown, mountDiagram = null, onOpenTab, onChange, describe = (path) => ({ label: path.split("/").pop() || path, kind: "File", code: true }) }) {
  const root = document.getElementById("side-panel");
  const home = { parent: root.parentElement, next: root.nextSibling };
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
  const legacy = legacyWidth();
  if (legacy && storedWidth() === null) storeWidth(legacy);
  const saved = storedWidth();
  if (saved) applyWidth(saved);
  // The review app's stored width may arrive after the panel started, and applies when it does.
  onPreferencesChange((keys) => {
    const width = keys.includes("sidePanel.width") ? storedWidth() : null;
    if (width) applyWidth(width);
  });

  const inSheet = () => Boolean(sheet) && root.parentElement !== home.parent;

  function goHome() {
    if (inSheet()) home.parent.insertBefore(root, home.next?.parentNode === home.parent ? home.next : null);
  }

  function setOpen(open) {
    const narrow = open && sheet && (globalThis.matchMedia?.(NARROW).matches ?? false);
    root.hidden = !open;
    if (narrow) {
      if (!inSheet()) sheet.append(root);
      if (!sheet.isOpen) sheet.show();
    } else {
      if (inSheet() && sheet.isOpen) sheet.close();
      goHome();
    }
    shell.classList.toggle("side-panel-open", open && !narrow);
    onChange?.(open);
  }

  function header({ eyebrow, name, detail, ref, code = false }) {
    root.setAttribute("eyebrow", eyebrow);
    root.setAttribute("heading", name);
    sheet?.setAttribute("heading", name);
    source.textContent = detail ?? "";
    source.hidden = !detail;
    source.toggleAttribute("data-code-subject", code);
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

  // A diagram file and the diagrams a document links are drawn after the text, as its tab draws them.
  async function drawDiagrams(data, ticket) {
    if (!mountDiagram || data.kind) return;
    const diagrams = data.diagrams?.length ? data.diagrams : data.path.toLowerCase().endsWith(".puml") ? [{ path: data.path, source: data.content }] : [];
    for (const diagram of diagrams) {
      if (ticket !== request) return;
      const slot = document.createElement("div");
      slot.className = "side-panel-diagram";
      body.appendChild(slot);
      await mountDiagram(slot, diagram).catch((error) => {
        slot.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
      });
    }
  }

  function render(data, anchor, { keepScroll = false } = {}) {
    const top = body.scrollTop;
    body.innerHTML = fileBody(data, { renderMarkdown });
    for (const content of body.querySelectorAll(".document-content")) decorateFolds(content, current.folds);
    void drawDiagrams(data, request).then(() => {
      if (keepScroll) body.scrollTop = top;
    });
    if (keepScroll) body.scrollTop = top;
    else scrollTo(anchor);
  }

  async function showFile(path, anchor = null) {
    const ticket = ++request;
    const same = current?.ref === path;
    current = { ref: path, anchor, content: same ? current.content : null, diagrams: same ? current.diagrams : null, folds: same ? current.folds : new Set() };
    const named = describe(path);
    const where = anchor ? (anchor.match(LINE_RANGE) ? `lines ${anchor.slice(1).replace("-", "–")}` : `#${anchor}`) : "";
    header({ eyebrow: named.kind, name: named.label, detail: named.code ? [path, where].filter(Boolean).join(" · ") : where, ref: path, code: named.code });
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
      current.diagrams = JSON.stringify(data.diagrams ?? []);
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

  // The bottom sheet closes with Escape, its Close button, or a click on the scrim, which closes the panel too.
  sheet?.addEventListener("prism-close", () => {
    if (inSheet() && !root.hidden) close();
  });

  // A changed file or linked diagram re-renders in place and keeps the reader's scroll position; an unchanged one is left alone.
  async function refresh() {
    if (!current?.ref || current.custom || current.content === null) return;
    const ticket = request;
    try {
      const data = await fetchJson(`./api/artifact?path=${encodeURIComponent(current.ref)}`);
      const diagrams = JSON.stringify(data.diagrams ?? []);
      if (ticket !== request || !current || (data.content === current.content && diagrams === current.diagrams)) return;
      current.content = data.content;
      current.diagrams = diagrams;
      render(data, current.anchor, { keepScroll: true });
    } catch {
    }
  }

  openButton.addEventListener("click", () => {
    if (current?.ref) onOpenTab(current.ref, current.anchor);
  });
  closeButton.addEventListener("click", close);

  // Dragging the panel's edge sets its width, which the review app keeps as the person's preference.
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
