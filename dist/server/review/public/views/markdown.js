import { escapeHtml } from "./util.js";

// Heading ids carry a prefix so a heading such as "Tabs" never collides with an id the page itself uses.
export const HEADING_PREFIX = "md-";

// GitHub-style slugs, so an anchor written for the repository host also lands here.
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
  let listType = null;
  const closeList = () => {
    if (listType) {
      output.push(`</${listType}>`);
      listType = null;
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
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
    } else if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      const text = line.slice(level + 1);
      const slug = headingSlug(text);
      const seen = slugs.get(slug) ?? 0;
      slugs.set(slug, seen + 1);
      output.push(`<h${level} id="${HEADING_PREFIX}${escapeHtml(seen ? `${slug}-${seen}` : slug)}">${inlineMarkdown(text, options)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== "ul") {
        closeList();
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""), options)}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== "ol") {
        closeList();
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""), options)}</li>`);
    } else if (/^&gt;\s?/.test(line)) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^&gt;\s?/, ""), options)}</blockquote>`);
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${inlineMarkdown(line, options)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return output.join("\n");
}

const TOC_MINIMUM = 3;

// A rendered document with enough headings gets a contents list beside it; the current section is marked while scrolling.
export function decorateDocuments(root) {
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
