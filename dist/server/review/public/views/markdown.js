// Generated from src/server/review/public/views/markdown.ts by scripts/native-build/compile.mjs.
import { highlight, languageOf } from "./highlight.js";
import { escapeHtml } from "./util.js";
const HEADING_PREFIX = "md-";
const LINE_RANGE = /^L(\d+)(?:-(\d+))?$/;
const EXPLICIT_ANCHOR = /^\s*&lt;a\s+(?:id|name)=&quot;([^&]+)&quot;\s*&gt;\s*&lt;\/a&gt;\s*$/;
function anchorTarget(root, anchor) {
  const line = anchor?.match(LINE_RANGE);
  const target = anchor && root.querySelector(`#${CSS.escape(HEADING_PREFIX + (line ? `L${line[1]}` : anchor))}`);
  const next = target?.nextElementSibling;
  return target?.classList.contains("md-anchor") && next && /^H[1-6]$/.test(next.tagName) ? next : target;
}
function headingSlug(text) {
  return text.replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "").toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
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
function storeLink(label, href, options) {
  const found = options.links?.get(decode(href));
  if (found === void 0) return null;
  const anchor = decode(href).split("#")[1] ?? "";
  if (found.resolved === null) {
    return `<span class="doc-link-unresolved" data-link="unavailable">${label}<prism-chip tip="${escapeHtml(decode(href))} names a code file that no checkout of its repository on this machine holds">not available on this machine</prism-chip></span>`;
  }
  if (!found.resolved || !found.target) {
    return `<span class="doc-link-unresolved" data-link="unresolved">${label}<prism-chip tone="warning" tip="${escapeHtml(decode(href))} names no artifact in the record store and no file">link not found</prism-chip></span>`;
  }
  return `<a href="./review?artifact=${encodeURIComponent(found.target)}" data-doc-link="${escapeHtml(found.target)}"${anchor ? ` data-doc-anchor="${escapeHtml(anchor)}"` : ""}>${label}</a>`;
}
function linkTargets(links) {
  return Array.isArray(links) ? new Map(links.map((item) => [item.href, { target: item.target ?? null, resolved: item.resolved === void 0 ? false : item.resolved }])) : null;
}
function link(label, href, options) {
  if (/^https?:/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return label;
  const stored = storeLink(label, href, options);
  if (stored !== null) return stored;
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
  return value.replace(/`([^`]+)`/g, (_, code) => `\0${codes.push(code) - 1}\0`).replace(/(!?)\[([^\]]+)\]\(([^)\s]+)\)/g, (_, image, label, href) => image ? label : link(label, href, options)).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}
function inlineLines(lines, options) {
  const HARD_BREAK = /(?: {2,}|\\)$/;
  const marked = lines.map((line, index) => {
    const text = line.trim();
    return index < lines.length - 1 && HARD_BREAK.test(line) ? `${text.replace(/\\$/, "")}` : text;
  });
  return inlineMarkdown(marked.join("\n"), options).replace(/\u0001\n/g, "<br>\n");
}
function quoteParagraphs(lines) {
  const paragraphs = [[]];
  for (const line of lines) {
    if (line.trim()) paragraphs.at(-1).push(line);
    else if (paragraphs.at(-1).length) paragraphs.push([]);
  }
  return paragraphs.filter((paragraph) => paragraph.length);
}
function startsBlock(line, next = "") {
  return FENCE.test(line.trim()) || /^#{1,6}\s/.test(line) || /^\s{0,3}&gt;/.test(line) || /^\s*([-*+]|1[.)])\s+\S/.test(line) || EXPLICIT_ANCHOR.test(line) || line.trim().startsWith("|") && /^\s*\|?\s*:?-+/.test(next);
}
function tableCells(line, options) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim(), options));
}
function codeBlock(html, language) {
  return `<prism-code${language ? ` language="${language}"` : ""}><pre><code${language ? ` class="language-${language}"` : ""}>${html}</code></pre></prism-code>`;
}
function fencedBlock(html, language) {
  return `<pre><code${language ? ` class="language-${language}"` : ""}>${html}</code></pre>`;
}
const FENCE = /^(`{3,}|~{3,})/;
function renderText(path, content, options = {}) {
  const escaped = escapeHtml(content);
  if (!path.toLowerCase().endsWith(".md")) {
    const language = languageOf(path);
    return codeBlock(highlight(content, language), language);
  }
  const lines = escaped.split(/\r?\n/);
  const output = [];
  const slugs = /* @__PURE__ */ new Map();
  let fence = null;
  const lists = [];
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) output.push(`</li></${lists.pop().type}>`);
  };
  const closeList = () => closeLists();
  const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
  const listContinues = (from) => {
    let next = from;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next >= lines.length || !lists.length) return false;
    return LIST_ITEM.test(lines[next]) || /^\s{2,}\S/.test(lines[next]);
  };
  let paragraph = null;
  let quote = null;
  const flush = () => {
    if (paragraph) output.push(`<p>${inlineLines(paragraph, options)}</p>`);
    if (quote) output.push(`<blockquote>${quoteParagraphs(quote).map((lines2) => `<p>${inlineLines(lines2, options)}</p>`).join("\n")}</blockquote>`);
    paragraph = null;
    quote = null;
  };
  const QUOTE = /^\s{0,3}&gt;\s?/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(LIST_ITEM);
    const marker = line.trim().match(FENCE)?.[1] ?? null;
    if (paragraph && (fence || !line.trim() || startsBlock(line, lines[index + 1]))) flush();
    if (quote && !QUOTE.test(line) && (!line.trim() || startsBlock(line, lines[index + 1]) || !quote.at(-1).trim())) flush();
    if (fence && marker?.[0] === fence.marker) {
      output.push(fencedBlock(highlight(decode(fence.lines.join("\n")), fence.language), fence.language));
      fence = null;
    } else if (fence) {
      fence.lines.push(line);
    } else if (quote) {
      quote.push(line.replace(QUOTE, ""));
    } else if (paragraph) {
      paragraph.push(line);
    } else if (marker) {
      closeList();
      fence = { marker: marker[0], language: languageOf(decode(line.trim().slice(marker.length))), lines: [] };
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
      const type = item[3] === void 0 ? "ul" : "ol";
      closeLists(indent);
      const top = lists.at(-1);
      if (top && top.indent === indent && top.type !== type) closeLists(indent - 1);
      if (lists.at(-1)?.indent === indent) {
        output.push("</li>");
      } else {
        const start = type === "ol" && Number(item[3]) !== 1 ? ` start="${Number(item[3])}"` : "";
        output.push(`<${type}${start}>`);
        lists.push({ type, indent });
      }
      output.push(`<li>${inlineMarkdown(item[4], options)}`);
    } else if (lists.length && /^\s{2,}\S/.test(line)) {
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
function decorateFolds(content, folds) {
  content.prismFolds = folds;
  const children = [...content.children];
  children.forEach((heading, index) => {
    const level = headingLevel(heading);
    if (!level || heading.querySelector(":scope > .md-fold")) return;
    const next = children[index + 1];
    if (!next || headingLevel(next) && headingLevel(next) <= level) return;
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
    content.classList.add("has-folds");
    if (folds?.has(heading.id)) heading.classList.add("is-folded");
    const folded = heading.classList.contains("is-folded");
    button.setAttribute("aria-expanded", String(!folded));
    button.setAttribute("tip", folded ? "Expand section" : "Collapse section");
    icon.setAttribute("name", folded ? "chevron-right" : "chevron-down");
  });
  applyFolds(content);
}
function revealInDocument(target) {
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
function decorateDocuments(root, folds = /* @__PURE__ */ new Map()) {
  [...root.querySelectorAll(".document-content")].forEach((content, position) => {
    if (!folds.has(position)) folds.set(position, /* @__PURE__ */ new Set());
    decorateFolds(content, folds.get(position));
  });
  for (const content of root.querySelectorAll(".document-content")) {
    const host = content.parentElement;
    if (!host || content.previousElementSibling?.tagName === "PRISM-CONTENTS") continue;
    const headings = [...content.querySelectorAll("h1[id], h2[id], h3[id]")];
    if (headings.length < TOC_MINIMUM) continue;
    const top = Math.min(...headings.map((heading) => Number(heading.tagName[1])));
    const toc = document.createElement("prism-contents");
    toc.innerHTML = `<ol>${headings.map((heading) => `<li class="depth-${Number(heading.tagName[1]) - top}"><a href="#${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}" data-doc-anchor="${escapeHtml(heading.id.slice(HEADING_PREFIX.length))}">${escapeHtml(heading.textContent)}</a></li>`).join("")}</ol>`;
    content.before(toc);
  }
}
function markCurrentSection(root, viewportTop) {
  for (const toc of root.querySelectorAll("prism-contents")) {
    const host = toc.parentElement;
    const scroller = host.closest(".is-maximized") ?? document.getElementById("workspace");
    toc.fit?.(scroller);
    const links = [...toc.querySelectorAll("a[data-doc-anchor]")];
    const areaTop = scroller?.getBoundingClientRect().top ?? viewportTop;
    const atEnd = scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    let current = links[0];
    for (const anchor of links) {
      const heading = host.querySelector(`#${CSS.escape(HEADING_PREFIX + anchor.dataset.docAnchor)}`);
      if (heading && heading.getBoundingClientRect().top <= (atEnd ? window.innerHeight : areaTop + 96)) current = anchor;
    }
    toc.markCurrent?.(current);
  }
}
export {
  HEADING_PREFIX,
  LINE_RANGE,
  anchorTarget,
  decorateDocuments,
  decorateFolds,
  headingSlug,
  linkTargets,
  markCurrentSection,
  renderText,
  revealInDocument
};
