import { escapeHtml } from "./util.js";

// Heading ids carry a prefix so a heading such as "Tabs" never collides with an id the page itself uses.
export const HEADING_PREFIX = "md-";

// A source anchor names one line, `L12`, or a range, `L12-39`.
export const LINE_RANGE = /^L(\d+)(?:-(\d+))?$/;

// GitHub-style slugs, so an anchor written for the repository host also lands here.
// A Markdown file can name a section with an explicit anchor line, such as `<a id="1"></a>` above a requirement heading.
const EXPLICIT_ANCHOR = /^\s*&lt;a\s+(?:id|name)=&quot;([^&]+)&quot;\s*&gt;\s*&lt;\/a&gt;\s*$/;

// Resolves an anchor to its heading, also when an explicit anchor stands just above the heading it names.
// A source line range such as `L12-39` resolves to its first line.
export function anchorTarget(root, anchor) {
  const line = anchor?.match(LINE_RANGE);
  const target = anchor && root.querySelector(`#${CSS.escape(HEADING_PREFIX + (line ? `L${line[1]}` : anchor))}`);
  const next = target?.nextElementSibling;
  return target?.classList.contains("md-anchor") && next && /^H[1-6]$/.test(next.tagName) ? next : target;
}

export function headingSlug(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function decode(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

// External links open in a new tab; in-document anchors scroll; repository paths open as review tabs when the review knows them.
function link(label, href, options) {
  if (/^https?:/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return label;
  const [target, anchor = ""] = decode(href).split("#");
  if (!target) return `<a href="#${escapeHtml(anchor)}" data-doc-anchor="${escapeHtml(anchor)}">${label}</a>`;
  const base = options.basePath ? options.basePath.split("/").slice(0, -1).join("/") : "";
  const resolved = normalizePath(target.startsWith("/") ? target : `${base}/${target}`);
  if (resolved === null || !options.isKnown?.(resolved)) {
    return `<span class="doc-link-missing" title="${escapeHtml(resolved ?? target)} is not a reviewable file in this project">${label}</span>`;
  }
  return `<a href="./review?artifact=${encodeURIComponent(resolved)}" data-doc-link="${escapeHtml(resolved)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${label}</a>`;
}

function inlineMarkdown(value, options) {
  const codes = [];
  return value
    .replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => link(label, href, options))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

function tableCells(line, options) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim(), options));
}

// Renders the small Markdown subset Prism artifacts use; any other file shows as preformatted text.
export function renderText(path, content, options = {}) {
  const escaped = escapeHtml(content);
  if (!path.toLowerCase().endsWith(".md")) {
    return `<pre><code>${escaped}</code></pre>`;
  }
  const lines = escaped.split(/\r?\n/);
  const output = [];
  const slugs = new Map();
  let inCode = false;
  // Open lists, outermost first: each keeps its type and the indent of its items, and its last item stays open so a deeper list nests inside it.
  const lists = [];
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) output.push(`</li></${lists.pop().type}>`);
  };
  const closeList = () => closeLists();
  const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
  // A blank line ends the open lists unless a list item or an indented continuation follows it.
  const listContinues = (from) => {
    let next = from;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next >= lines.length || !lists.length) return false;
    return LIST_ITEM.test(lines[next]) || /^\s{2,}\S/.test(lines[next]);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(LIST_ITEM);
    if (line.trim().startsWith("```")) {
      closeList();
      output.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
    } else if (inCode) {
      output.push(`${line}\n`);
    } else if (line.trim().startsWith("|") && /^\s*\|?\s*:?-+/.test(lines[index + 1] ?? "")) {
      closeList();
      const headers = tableCells(line, options);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableCells(lines[index], options));
        index += 1;
      }
      index -= 1;
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (EXPLICIT_ANCHOR.test(line)) {
      closeList();
      output.push(`<span class="md-anchor" id="${HEADING_PREFIX}${line.match(EXPLICIT_ANCHOR)[1]}"></span>`);
    } else if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      const text = line.slice(level + 1);
      const slug = headingSlug(text);
      const seen = slugs.get(slug) ?? 0;
      slugs.set(slug, seen + 1);
      output.push(`<h${level} id="${HEADING_PREFIX}${escapeHtml(seen ? `${slug}-${seen}` : slug)}">${inlineMarkdown(text, options)}</h${level}>`);
    } else if (item) {
      const indent = item[1].replace(/\t/g, "    ").length;
      const type = item[3] === undefined ? "ul" : "ol";
      closeLists(indent);
      const top = lists.at(-1);
      if (top && top.indent === indent && top.type !== type) closeLists(indent - 1);
      if (lists.at(-1)?.indent === indent) {
        output.push("</li>");
      } else {
        // An ordered list starts at its first item's number, as CommonMark does; later items count up from there.
        const start = type === "ol" && Number(item[3]) !== 1 ? ` start="${Number(item[3])}"` : "";
        output.push(`<${type}${start}>`);
        lists.push({ type, indent });
      }
      output.push(`<li>${inlineMarkdown(item[4], options)}`);
    } else if (lists.length && /^\s{2,}\S/.test(line)) {
      // An indented line under an item continues that item.
      output.push(`<br>${inlineMarkdown(line.trim(), options)}`);
    } else if (/^&gt;\s?/.test(line)) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^&gt;\s?/, ""), options)}</blockquote>`);
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${inlineMarkdown(line, options)}</p>`);
    } else if (!listContinues(index + 1)) {
      closeList();
    }
  }
  closeList();
  return output.join("\n");
}

const TOC_MINIMUM = 3;
const HEADING = /^H([1-6])$/;

const headingLevel = (node) => Number(HEADING.exec(node.tagName)?.[1] ?? 0);

// Hides every block under a folded heading, up to the next heading of the same or a higher level; a nested fold stays folded when its parent opens.
function applyFolds(content) {
  const open = [];
  for (const node of content.children) {
    const level = headingLevel(node);
    if (level) while (open.length && open.at(-1).level >= level) open.pop();
    node.classList.toggle("md-folded-away", open.some((heading) => heading.folded));
    if (level) open.push({ level, folded: node.classList.contains("is-folded") });
  }
}

function setFold(content, heading, folded) {
  heading.classList.toggle("is-folded", folded);
  const button = heading.querySelector(":scope > .md-fold");
  button?.setAttribute("aria-expanded", String(!folded));
  if (button) button.title = folded ? "Expand section" : "Collapse section";
  const folds = content.prismFolds;
  if (folds) {
    if (folded) folds.add(heading.id);
    else folds.delete(heading.id);
  }
  applyFolds(content);
}

// Each heading with content under it gets a fold toggle; the folds set, kept by the caller per view, survives a re-render.
function decorateFolds(content, folds) {
  content.prismFolds = folds;
  const children = [...content.children];
  children.forEach((heading, index) => {
    const level = headingLevel(heading);
    if (!level || heading.querySelector(":scope > .md-fold")) return;
    const next = children[index + 1];
    if (!next || (headingLevel(next) && headingLevel(next) <= level)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-fold";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Collapse or expand this section");
    button.title = "Collapse section";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setFold(content, heading, !heading.classList.contains("is-folded"));
    });
    heading.classList.add("md-foldable");
    heading.prepend(button);
    if (folds?.has(heading.id)) heading.classList.add("is-folded");
    button.setAttribute("aria-expanded", String(!heading.classList.contains("is-folded")));
  });
  applyFolds(content);
}

// Opens a folded target heading and every folded heading above a target, so a link, a contents entry, or a find can land inside a folded section.
export function revealInDocument(target) {
  const content = target?.closest?.(".document-content");
  if (!content) return;
  let node = target;
  while (node && node.parentElement !== content) node = node.parentElement;
  if (node?.classList.contains("is-folded")) setFold(content, node, false);
  let level = node ? headingLevel(node) || 7 : 7;
  for (let previous = node?.previousElementSibling; previous && level > 1; previous = previous.previousElementSibling) {
    const previousLevel = headingLevel(previous);
    if (!previousLevel || previousLevel >= level) continue;
    level = previousLevel;
    if (previous.classList.contains("is-folded")) setFold(content, previous, false);
  }
}

// A rendered document with enough headings gets a contents list beside it; the current section is marked while scrolling.
// folds holds the ids of the folded headings, keyed by the document's position on the page.
export function decorateDocuments(root, folds = new Map()) {
  [...root.querySelectorAll(".document-content")].forEach((content, position) => {
    if (!folds.has(position)) folds.set(position, new Set());
    decorateFolds(content, folds.get(position));
  });
  for (const content of root.querySelectorAll(".document-content")) {
    const host = content.closest(".document-card, .view-card") ?? content.parentElement;
    if (host.querySelector(":scope > .doc-toc")) continue;
    const headings = [...content.querySelectorAll("h1[id], h2[id], h3[id]")];
    if (headings.length < TOC_MINIMUM) continue;
    const top = Math.min(...headings.map((heading) => Number(heading.tagName[1])));
    const toc = document.createElement("nav");
    toc.className = "doc-toc";
    toc.setAttribute("aria-label", "Contents");
    toc.innerHTML = `<button type="button" class="doc-toc-toggle" aria-expanded="false">Contents</button>
      <ol>${headings.map((heading) => `<li class="toc-depth-${Number(heading.tagName[1]) - top}"><a href="#${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}" data-doc-anchor="${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}">${escapeHtml(heading.textContent)}</a></li>`).join("")}</ol>`;
    toc.querySelector(".doc-toc-toggle").addEventListener("click", (event) => {
      const open = toc.classList.toggle("is-open");
      event.currentTarget.setAttribute("aria-expanded", String(open));
    });
    host.classList.add("has-toc");
    host.prepend(toc);
  }
}

export function markCurrentSection(root, viewportTop) {
  for (const toc of root.querySelectorAll(".doc-toc")) {
    const host = toc.parentElement;
    const links = [...toc.querySelectorAll("a[data-doc-anchor]")];
    const scroller = host.closest(".is-maximized") ?? document.getElementById("workspace");
    const atEnd = scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    let current = links[0];
    for (const anchor of links) {
      const heading = host.querySelector(`#${CSS.escape(HEADING_PREFIX + anchor.dataset.docAnchor)}`);
      // At the end of the scroll the last heading on screen is current, since later headings can never reach the top.
      if (heading && heading.getBoundingClientRect().top <= (atEnd ? window.innerHeight : viewportTop + 96)) current = anchor;
    }
    for (const anchor of links) {
      if (anchor === current) anchor.setAttribute("aria-current", "location");
      else anchor.removeAttribute("aria-current");
    }
  }
}
