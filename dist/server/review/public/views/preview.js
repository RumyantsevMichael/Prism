import { entityLabel, parseEntityRef, progressBar, stateBadge } from "./entities.js";
import { HEADING_PREFIX } from "./markdown.js";
import { escapeHtml } from "./util.js";

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 200;
const CACHE_MS = 10000;
const BLOCK_LIMIT = 8;
const SOURCE_LINES = 14;

function sectionOf(container, anchor) {
  const heading = anchor && container.querySelector(`#${CSS.escape(HEADING_PREFIX + anchor)}`);
  const start = heading ?? container.firstElementChild;
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
    body = `<p><span class="slice-status status-${escapeHtml(data.slice.status)}">${escapeHtml(data.slice.status)}</span> <span class="muted">${escapeHtml(data.initiativeTitle)}</span></p>${data.slice.outcome ? `<p>${escapeHtml(data.slice.outcome)}</p>` : ""}`;
  } else if (entity.kind === "roadmap") {
    body = `<p>${escapeHtml(data.serves || "")}</p><p class="muted">${data.items?.length ?? 0} initiatives</p>`;
  } else if (entity.kind === "attention") {
    body = `<p class="muted">${escapeHtml(String(data.gateCount ?? 0))} recorded questions</p>`;
  } else if (Array.isArray(data.entries)) {
    body = `<p class="muted">${data.entries.length} documents in ${escapeHtml(data.directory ?? "")}</p>`;
  }
  return `<p class="eyebrow">${escapeHtml(label.eyebrow ?? entity.kind)}</p><h3>${escapeHtml(label.title)}</h3>${body}`;
}

function fileSummary(data, anchor, { renderMarkdown, kindLabel }) {
  const head = `<p class="eyebrow">${escapeHtml(data.path)}</p>`;
  if (data.kind === "source") {
    const lines = data.content.split(/\r?\n/).slice(0, SOURCE_LINES).join("\n");
    return `${head}<pre><code>${escapeHtml(lines)}</code></pre>`;
  }
  if (data.kind) return `${head}<h3>${escapeHtml(kindLabel(data.kind))}</h3>`;
  if (data.path.toLowerCase().endsWith(".puml")) return `${head}<h3>PlantUML diagram</h3>`;
  const scratch = document.createElement("div");
  scratch.innerHTML = renderMarkdown(data.path, data.content);
  const section = sectionOf(scratch, anchor);
  return `${head}<div class="document-content">${section || '<p class="muted">The document is empty.</p>'}</div>`;
}

// Hovering or focusing an internal link shows what it points to: an entity's summary, or the start of a file or the linked section.
export function createLinkPreview({ root, fetchJson, renderMarkdown, kindLabel }) {
  const popover = document.createElement("div");
  popover.className = "link-preview";
  popover.setAttribute("role", "tooltip");
  popover.hidden = true;
  document.body.appendChild(popover);
  const cache = new Map();
  let anchorElement = null;
  let showTimer = 0;
  let hideTimer = 0;
  let request = 0;

  function targetOf(element) {
    if (element.dataset.docLink) return { ref: element.dataset.docLink, anchor: element.dataset.docAnchor ?? null };
    const ref = element.dataset.artifact;
    return ref ? { ref, anchor: null } : null;
  }

  async function load({ ref, anchor }) {
    const key = `${ref}#${anchor ?? ""}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.html;
    const html = parseEntityRef(ref)
      ? entitySummary(await fetchJson(`./api/entity?ref=${encodeURIComponent(ref)}`))
      : fileSummary(await fetchJson(`./api/artifact?path=${encodeURIComponent(ref)}`), anchor, { renderMarkdown, kindLabel });
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
      popover.hidden = false;
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

  const selector = "[data-artifact], a[data-doc-link]";
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
