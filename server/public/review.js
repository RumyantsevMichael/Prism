import { renderToString } from "./vendor/plantuml.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const artifact = document.getElementById("artifact");
const artifactCount = document.getElementById("artifact-count");
const artifactFilter = document.getElementById("artifact-filter");
const emptyFilter = document.getElementById("empty-filter");
const toast = document.getElementById("toast");
let selectedPath = new URLSearchParams(location.search).get("artifact");
let lastSnapshot = "";
let toastTimer;

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inlineMarkdown(value) {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const allowed = /^(https?:|#)/i.test(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//"));
      return allowed ? `<a href="${href}">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim()));
}

function renderText(path, content) {
  const escaped = escapeHtml(content);
  if (!path.toLowerCase().endsWith(".md")) {
    return `<pre><code>${escaped}</code></pre>`;
  }
  const lines = escaped.split(/\r?\n/);
  const output = [];
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
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      output.push(`<h${level}>${inlineMarkdown(line.slice(level + 1))}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== "ul") {
        closeList();
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== "ol") {
        closeList();
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
    } else if (/^&gt;\s?/.test(line)) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^&gt;\s?/, ""))}</blockquote>`);
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return output.join("\n");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1800);
}

function setDiagramScale(section, scale) {
  const svg = section.querySelector("svg");
  if (!svg) {
    return;
  }
  const nextScale = Math.min(2.5, Math.max(0.35, scale));
  section.dataset.scale = String(nextScale);
  svg.style.width = `${Number(section.dataset.naturalWidth) * nextScale}px`;
  svg.style.height = `${Number(section.dataset.naturalHeight) * nextScale}px`;
  section.querySelector("[data-scale-label]").textContent = `${Math.round(nextScale * 100)}%`;
}

function configureDiagram(section, source) {
  const svg = section.querySelector("svg");
  if (!svg) {
    return;
  }
  const width = Number.parseFloat(svg.getAttribute("width")) || svg.getBoundingClientRect().width;
  const height = Number.parseFloat(svg.getAttribute("height")) || svg.getBoundingClientRect().height;
  section.dataset.naturalWidth = String(width);
  section.dataset.naturalHeight = String(height);
  section.dataset.scale = "1";

  section.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) {
      return;
    }
    const currentScale = Number(section.dataset.scale);
    if (action === "zoom-in") {
      setDiagramScale(section, currentScale + 0.15);
    } else if (action === "zoom-out") {
      setDiagramScale(section, currentScale - 0.15);
    } else if (action === "reset") {
      setDiagramScale(section, 1);
    } else if (action === "source") {
      const sourcePanel = section.querySelector(".source-panel");
      sourcePanel.hidden = !sourcePanel.hidden;
      event.target.closest("button").setAttribute("aria-expanded", String(!sourcePanel.hidden));
    } else if (action === "copy") {
      try {
        await navigator.clipboard.writeText(source);
        showToast("PlantUML source copied.");
      } catch {
        showToast("The browser could not copy the source.");
      }
    }
  });
}

function renderDiagram(source, target, section) {
  return new Promise((resolve) => {
    renderToString(source.split(/\r?\n/), (svg) => {
      if (svg.includes("Syntax Error")) {
        target.innerHTML = '<p class="error">PlantUML reported a syntax error.</p>';
      } else {
        target.innerHTML = svg;
        configureDiagram(section, source);
      }
      resolve();
    }, (message) => {
      target.innerHTML = `<p class="error">${escapeHtml(String(message))}</p>`;
      resolve();
    });
  });
}

function diagramCard(diagram) {
  const section = document.createElement("section");
  section.className = "diagram-card";
  section.innerHTML = `
    <header class="diagram-header">
      <div class="diagram-title">
        <p class="eyebrow">PlantUML diagram</p>
        <h2 title="${escapeHtml(diagram.path)}">${escapeHtml(diagram.path)}</h2>
      </div>
      <div class="diagram-tools" aria-label="Diagram controls">
        <button class="tool-button" data-action="zoom-out" type="button" aria-label="Zoom out">−</button>
        <button class="tool-button" data-action="reset" data-scale-label type="button" aria-label="Reset zoom">100%</button>
        <button class="tool-button" data-action="zoom-in" type="button" aria-label="Zoom in">+</button>
        <button class="tool-button" data-action="source" type="button" aria-label="Toggle source" aria-expanded="false">Source</button>
        <button class="tool-button" data-action="copy" type="button" aria-label="Copy PlantUML source">Copy</button>
      </div>
    </header>
    <div class="diagram-output"><p class="rendering">Rendering diagram</p></div>
    <div class="source-panel" hidden><pre><code>${escapeHtml(diagram.source)}</code></pre></div>`;
  return section;
}

function fileName(path) {
  return path.split("/").pop();
}

function fileType(path) {
  return path.split(".").pop().toUpperCase();
}

function selectNavigation(path) {
  for (const link of artifacts.querySelectorAll("a")) {
    if (link.dataset.path === path) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

async function showArtifact(path) {
  const response = await fetch(`./api/artifact?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) {
    artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(await response.text())}</p></div>`;
    return;
  }
  const data = await response.json();
  const snapshot = JSON.stringify(data);
  if (snapshot === lastSnapshot) {
    return;
  }
  lastSnapshot = snapshot;
  selectNavigation(path);
  const diagramLabel = `${data.diagrams.length} diagram${data.diagrams.length === 1 ? "" : "s"}`;
  const refreshed = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <p class="eyebrow">Human review</p>
        <h1>${escapeHtml(fileName(data.path))}</h1>
        <p class="artifact-path">${escapeHtml(data.path)}</p>
      </div>
      <div class="artifact-meta">
        <span class="meta-pill">${escapeHtml(fileType(data.path))}</span>
        <span class="meta-pill">${diagramLabel}</span>
        <span class="meta-pill live" title="Last refreshed at ${refreshed}">Live</span>
      </div>
    </header>
    <section class="document-card"><div class="document-content">${renderText(data.path, data.content)}</div></section>`;
  for (const diagram of data.diagrams) {
    const section = diagramCard(diagram);
    artifact.appendChild(section);
    await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
  }
}

function addArtifactLink(path) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = `./review?artifact=${encodeURIComponent(path)}`;
  link.dataset.path = path;
  link.title = path;
  link.innerHTML = `<span class="file-icon" aria-hidden="true"></span><span class="file-name">${escapeHtml(fileName(path))}</span><span class="type-badge">${escapeHtml(fileType(path))}</span>`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    selectedPath = path;
    history.replaceState(null, "", link.href);
    lastSnapshot = "";
    showArtifact(path);
  });
  item.appendChild(link);
  artifacts.appendChild(item);
}

function filterArtifacts() {
  const query = artifactFilter.value.trim().toLowerCase();
  let visible = 0;
  for (const item of artifacts.children) {
    const matches = item.querySelector("a").dataset.path.toLowerCase().includes(query);
    item.hidden = !matches;
    visible += matches ? 1 : 0;
  }
  artifactCount.textContent = String(visible);
  emptyFilter.hidden = visible !== 0;
}

async function initialize() {
  const response = await fetch("./api/index", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = await response.json();
  project.textContent = data.projectRoot;
  artifactCount.textContent = String(data.artifacts.length);
  data.artifacts.forEach(addArtifactLink);
  artifactFilter.addEventListener("input", filterArtifacts);
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== artifactFilter) {
      event.preventDefault();
      artifactFilter.focus();
    } else if (event.key === "Escape" && document.activeElement === artifactFilter) {
      artifactFilter.value = "";
      filterArtifacts();
      artifactFilter.blur();
    }
  });
  if (selectedPath) {
    await showArtifact(selectedPath);
  }
  setInterval(() => selectedPath && showArtifact(selectedPath), 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(error.message)}</p></div>`;
});
