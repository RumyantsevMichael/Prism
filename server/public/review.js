import { renderToString } from "./vendor/plantuml.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const artifact = document.getElementById("artifact");
let selectedPath = new URLSearchParams(location.search).get("artifact");
let lastSnapshot = "";

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
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
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
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      output.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
    } else if (inCode) {
      output.push(`${line}\n`);
    } else if (line.trim().startsWith("|") && /^\s*\|?\s*:?-+/.test(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      output.push(`<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      output.push(`<h${level}>${inlineMarkdown(line.slice(level + 1))}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      output.push(`<p>• ${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</p>`);
    } else if (line.trim()) {
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  return output.join("\n");
}

function renderDiagram(source, target) {
  return new Promise((resolve) => {
    renderToString(source.split(/\r?\n/), (svg) => {
      if (svg.includes("Syntax Error")) {
        target.innerHTML = '<p class="error">PlantUML reported a syntax error.</p>';
      } else {
        target.innerHTML = svg;
      }
      resolve();
    }, (message) => {
      target.innerHTML = `<p class="error">${escapeHtml(String(message))}</p>`;
      resolve();
    });
  });
}

async function showArtifact(path) {
  const response = await fetch(`./api/artifact?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) {
    artifact.innerHTML = `<p class="error">${escapeHtml(await response.text())}</p>`;
    return;
  }
  const data = await response.json();
  const snapshot = JSON.stringify(data);
  if (snapshot === lastSnapshot) {
    return;
  }
  lastSnapshot = snapshot;
  artifact.innerHTML = `<h1>${escapeHtml(data.path)}</h1><section>${renderText(data.path, data.content)}</section>`;
  for (const diagram of data.diagrams) {
    const section = document.createElement("section");
    section.className = "diagram";
    section.innerHTML = `<h2>${escapeHtml(diagram.path)}</h2><div class="diagram-output"><p>Rendering diagram.</p></div>`;
    artifact.appendChild(section);
    await renderDiagram(diagram.source, section.querySelector(".diagram-output"));
  }
}

async function initialize() {
  const response = await fetch("./api/index", { cache: "no-store" });
  const data = await response.json();
  project.textContent = data.projectRoot;
  for (const path of data.artifacts) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `./review?artifact=${encodeURIComponent(path)}`;
    link.textContent = path;
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
  if (selectedPath) {
    await showArtifact(selectedPath);
  }
  setInterval(() => selectedPath && showArtifact(selectedPath), 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
});
