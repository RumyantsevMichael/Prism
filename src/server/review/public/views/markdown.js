import { highlight, languageOf } from "./highlight.js";
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
    return `<prism-chip class="doc-link-missing" tip="${escapeHtml(resolved ?? target)} is not a reviewable file in this project">${label}</prism-chip>`;
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

// Renders the lines of one paragraph; a line that ends in two spaces or a backslash keeps its line break, as in CommonMark.
function inlineLines(lines, options) {
  const HARD_BREAK = /(?: {2,}|\\)$/;
  const marked = lines.map((line, index) => {
    const text = line.trim();
    return index < lines.length - 1 && HARD_BREAK.test(line) ? `${text.replace(/\\$/, "")}\u0001` : text;
  });
  return inlineMarkdown(marked.join("\n"), options).replace(/\u0001\n/g, "<br>\n");
}

// Splits the lines of a quote into its paragraphs at its blank lines.
function quoteParagraphs(lines) {
  const paragraphs = [[]];
  for (const line of lines) {
    if (line.trim()) paragraphs.at(-1).push(line);
    else if (paragraphs.at(-1).length) paragraphs.push([]);
  }
  return paragraphs.filter((paragraph) => paragraph.length);
}

// A line that starts a block of its own, so it ends an open paragraph instead of continuing it.
function startsBlock(line, next = "") {
  return line.trim().startsWith("```")
    || /^#{1,6}\s/.test(line)
    || /^\s{0,3}&gt;/.test(line)
    || /^\s*([-*+]|1[.)])\s+\S/.test(line)
    || EXPLICIT_ANCHOR.test(line)
    || (line.trim().startsWith("|") && /^\s*\|?\s*:?-+/.test(next));
}

function tableCells(line, options) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim(), options));
}

// A highlighted code block in the kit's code element, which colors its tok-<name> spans with the theme's syntax colors.
function codeBlock(html, language) {
  return `<prism-code${language ? ` language="${language}"` : ""}><pre><code${language ? ` class="language-${language}"` : ""}>${html}</code></pre></prism-code>`;
}

// A fenced block inside a document, which prism-doc styles as a code block with the theme's syntax colors.
function fencedBlock(html, language) {
  return `<pre><code${language ? ` class="language-${language}"` : ""}>${html}</code></pre>`;
}

// Renders the small Markdown subset Prism artifacts use; any other file shows as preformatted text.
export function renderText(path, content, options = {}) {
  const escaped = escapeHtml(content);
  if (!path.toLowerCase().endsWith(".md")) {
    const language = languageOf(path);
    return codeBlock(highlight(content, language), language);
  }
  const lines = escaped.split(/\r?\n/);
  const output = [];
  const slugs = new Map();
  // An open fence keeps its language and its lines until it closes, so the block is highlighted as a whole.
  let fence = null;
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
  // Consecutive text lines form one paragraph, and consecutive quoted lines one quote, as in CommonMark: a single line break inside them is a space.
  let paragraph = null;
  let quote = null;
  const flush = () => {
    if (paragraph) output.push(`<p>${inlineLines(paragraph, options)}</p>`);
    if (quote) output.push(`<blockquote>${quoteParagraphs(quote).map((lines) => `<p>${inlineLines(lines, options)}</p>`).join("\n")}</blockquote>`);
    paragraph = null;
    quote = null;
  };
  const QUOTE = /^\s{0,3}&gt;\s?/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(LIST_ITEM);
    // A paragraph or quote ends at a blank line or at any line that starts another block; a quote also takes unmarked lines that continue its text.
    if (paragraph && (fence || !line.trim() || startsBlock(line, lines[index + 1]))) flush();
    if (quote && !QUOTE.test(line) && (!line.trim() || startsBlock(line, lines[index + 1]) || !quote.at(-1).trim())) flush();
    if (fence && line.trim().startsWith("```")) {
      output.push(fencedBlock(highlight(decode(fence.lines.join("\n")), fence.language), fence.language));
      fence = null;
    } else if (fence) {
      fence.lines.push(line);
    } else if (quote) {
      quote.push(line.replace(QUOTE, ""));
    } else if (paragraph) {
      paragraph.push(line);
    } else if (line.trim().startsWith("```")) {
      closeList();
      fence = { language: languageOf(decode(line.trim().slice(3))), lines: [] };
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
      // An indented line under an item continues that item: right after the item's text it continues the same paragraph, after a blank line it starts a new one.
      output.push(`${lines[index - 1]?.trim() ? "" : "<br>"}${inlineMarkdown(line.trim(), options)}`);
    } else if (QUOTE.test(line)) {
      closeList();
      quote = [line.replace(QUOTE, "")];
    } else if (line.trim()) {
      closeList();
      paragraph = [line];
    } else if (!listContinues(index + 1)) {
      closeList();
    }
  }
  flush();
  if (fence) output.push(fencedBlock(highlight(decode(fence.lines.join("\n")), fence.language), fence.language));
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
  button?.setAttribute("tip", folded ? "Expand section" : "Collapse section");
  button?.firstElementChild?.setAttribute("name", folded ? "chevron-right" : "chevron-down");
  const folds = content.prismFolds;
  if (folds) {
    if (folded) folds.add(heading.id);
    else folds.delete(heading.id);
  }
  applyFolds(content);
}

// Each heading with content under it gets a fold toggle; the folds set, kept by the caller per view, survives a re-render.
export function decorateFolds(content, folds) {
  content.prismFolds = folds;
  const children = [...content.children];
  children.forEach((heading, index) => {
    const level = headingLevel(heading);
    if (!level || heading.querySelector(":scope > .md-fold")) return;
    const next = children[index + 1];
    if (!next || (headingLevel(next) && headingLevel(next) <= level)) return;
    const button = document.createElement("prism-button");
    button.setAttribute("variant", "ghost");
    button.setAttribute("size", "sm");
    button.className = "md-fold";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("label", "Collapse or expand this section");
    button.setAttribute("tip", "Collapse section");
    const icon = document.createElement("prism-icon");
    icon.setAttribute("name", "chevron-down");
    icon.setAttribute("size", "xs");
    button.append(icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setFold(content, heading, !heading.classList.contains("is-folded"));
    });
    heading.classList.add("md-foldable");
    heading.prepend(button);
    // The toggles sit in a gutter that the content keeps for them, so they never reach past the card, panel, or preview that holds the document.
    content.classList.add("has-folds");
    if (folds?.has(heading.id)) heading.classList.add("is-folded");
    const folded = heading.classList.contains("is-folded");
    button.setAttribute("aria-expanded", String(!folded));
    button.setAttribute("tip", folded ? "Expand section" : "Collapse section");
    icon.setAttribute("name", folded ? "chevron-right" : "chevron-down");
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
    const host = content.parentElement;
    if (!host || content.previousElementSibling?.classList.contains("doc-toc")) continue;
    const headings = [...content.querySelectorAll("h1[id], h2[id], h3[id]")];
    if (headings.length < TOC_MINIMUM) continue;
    const top = Math.min(...headings.map((heading) => Number(heading.tagName[1])));
    const toc = document.createElement("nav");
    toc.className = "doc-toc";
    toc.setAttribute("aria-label", "Contents");
    // Beside the text the contents are always shown, so their header is a plain title; above the text, in a narrow window, the header folds them.
    toc.innerHTML = `<div class="doc-toc-body"><div class="doc-toc-head"><span class="doc-toc-title">Contents</span><prism-button variant="ghost" size="sm" class="doc-toc-toggle" aria-expanded="false"><prism-icon name="chevron-right" size="xs"></prism-icon>Contents</prism-button></div>
      <ol>${headings.map((heading) => `<li class="toc-depth-${Number(heading.tagName[1]) - top}"><a href="#${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}" data-doc-anchor="${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}">${escapeHtml(heading.textContent)}</a></li>`).join("")}</ol></div>`;
    const toggle = toc.querySelector(".doc-toc-toggle");
    toggle.addEventListener("click", () => {
      const open = toc.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.firstElementChild?.setAttribute("name", open ? "chevron-down" : "chevron-right");
    });
    host.classList.add("has-toc");
    content.before(toc);
  }
}

// Fits the contents into the part of the scrolling area that shows them, so the page scrolls the document and the contents scroll only when they are longer than that part.
function fitContents(toc, scroller) {
  const body = toc.querySelector(":scope > .doc-toc-body");
  if (!body || !scroller) return;
  const area = scroller.getBoundingClientRect();
  const visibleTop = area.top + scroller.clientTop;
  const visibleBottom = visibleTop + scroller.clientHeight;
  const style = getComputedStyle(body);
  let height;
  if (style.position === "sticky") {
    // Beside the text the list sticks at the scrolling area's content edge, moved by its own top offset, and ends with the sheet.
    const box = toc.getBoundingClientRect();
    const stuck = visibleTop + parseFloat(getComputedStyle(scroller).paddingTop) + parseFloat(style.top);
    height = Math.min(visibleBottom, box.bottom) - Math.max(box.top, stuck);
  } else {
    height = visibleBottom - body.getBoundingClientRect().top;
  }
  body.style.setProperty("--doc-toc-fit", `${Math.max(Math.floor(height), 0)}px`);
}

// Scrolls the contents list, and only that list, so the current entry is in view.
function revealEntry(list, anchor) {
  if (!list || list.scrollHeight <= list.clientHeight) return;
  const frame = list.getBoundingClientRect();
  const entry = anchor.getBoundingClientRect();
  if (entry.top < frame.top) list.scrollTop -= frame.top - entry.top;
  else if (entry.bottom > frame.bottom) list.scrollTop += entry.bottom - frame.bottom;
}

export function markCurrentSection(root, viewportTop) {
  for (const toc of root.querySelectorAll(".doc-toc")) {
    const host = toc.parentElement;
    const links = [...toc.querySelectorAll("a[data-doc-anchor]")];
    const scroller = host.closest(".is-maximized") ?? document.getElementById("workspace");
    fitContents(toc, scroller);
    const areaTop = scroller?.getBoundingClientRect().top ?? viewportTop;
    const atEnd = scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    let current = links[0];
    for (const anchor of links) {
      const heading = host.querySelector(`#${CSS.escape(HEADING_PREFIX + anchor.dataset.docAnchor)}`);
      // At the end of the scroll the last heading on screen is current, since later headings can never reach the top.
      if (heading && heading.getBoundingClientRect().top <= (atEnd ? window.innerHeight : areaTop + 96)) current = anchor;
    }
    for (const anchor of links) {
      if (anchor === current) {
        if (!anchor.hasAttribute("aria-current")) revealEntry(toc.querySelector(":scope > .doc-toc-body > ol"), anchor);
        anchor.setAttribute("aria-current", "location");
      } else {
        anchor.removeAttribute("aria-current");
      }
    }
  }
}
