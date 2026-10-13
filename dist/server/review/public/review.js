import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, renderEntity } from "./views/entities.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const artifact = document.getElementById("artifact");
const tabs = document.getElementById("tabs");
const artifactCount = document.getElementById("artifact-count");
const artifactFilter = document.getElementById("artifact-filter");
const emptyFilter = document.getElementById("empty-filter");
const toast = document.getElementById("toast");
let selectedPath = new URLSearchParams(location.search).get("artifact");
let openTabs = [];
let sessionRevision = 0;
let sessionConnected = false;
let sessionStream;
let saveQueue = Promise.resolve();
let lastSnapshot = "";
let toastTimer;
let availableArtifacts = new Set();
let navigation = { initiatives: [], glossary: {}, diagnostics: [] };
const sliceTitles = new Map();
const viewStates = new Map();

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function welcome() {
  artifact.innerHTML = `<div class="welcome-card">
    <span class="welcome-mark" aria-hidden="true"></span>
    <p class="eyebrow">Human review</p>
    <h1>Open the roadmap</h1>
    <p>Choose the roadmap, an initiative, or a library section.</p>
  </div>`;
}

function updateLocation(path) {
  const url = new URL(location.href);
  if (path) {
    url.searchParams.set("artifact", path);
  } else {
    url.searchParams.delete("artifact");
  }
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function renderTabs() {
  tabs.replaceChildren();
  for (const path of openTabs) {
    const tab = document.createElement("div");
    tab.className = "artifact-tab";
    tab.setAttribute("role", "presentation");
    const select = document.createElement("button");
    select.className = "artifact-tab-select";
    select.type = "button";
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(path === selectedPath));
    select.title = path;
    select.textContent = tabLabel(path);
    select.addEventListener("click", () => selectTab(path));
    const close = document.createElement("button");
    close.className = "artifact-tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${path}`);
    close.textContent = "×";
    close.addEventListener("click", () => closeTab(path));
    tab.append(select, close);
    tabs.appendChild(tab);
  }
}

function saveSession() {
  const payload = { openTabs: [...openTabs], activeTab: selectedPath };
  const request = async () => {
    const response = await fetch("./api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    synchronizeSession(await response.json());
  };
  const queued = saveQueue.then(request, request);
  saveQueue = queued.catch(() => {});
  return queued;
}

function selectTab(path) {
  if (!openTabs.includes(path)) {
    openTabs.push(path);
  }
  selectedPath = path;
  lastSnapshot = "";
  updateLocation(path);
  renderTabs();
  void showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
}

function closeTab(path) {
  openTabs = openTabs.filter((tab) => tab !== path);
  if (selectedPath === path) {
    selectedPath = openTabs[openTabs.length - 1] ?? null;
    lastSnapshot = "";
    updateLocation(selectedPath);
  }
  renderTabs();
  if (selectedPath) {
    void showArtifact(selectedPath);
  } else {
    welcome();
  }
  void saveSession().catch((error) => showToast(error.message));
}

function synchronizeSession(snapshot) {
  const nextRevision = Number.isInteger(snapshot.revision) ? snapshot.revision : sessionRevision;
  if (nextRevision <= sessionRevision) {
    return;
  }
  const nextTabs = Array.isArray(snapshot.openTabs) ? [...snapshot.openTabs] : [];
  const nextSelectedPath = Object.hasOwn(snapshot, "activeTab")
    ? snapshot.activeTab
    : nextTabs.includes(selectedPath) ? selectedPath : nextTabs[0] ?? null;
  const tabsChanged = !samePaths(openTabs, nextTabs);
  const selectionChanged = selectedPath !== nextSelectedPath;
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  selectedPath = nextSelectedPath && nextTabs.includes(nextSelectedPath) ? nextSelectedPath : null;
  if (!tabsChanged && !selectionChanged) {
    return;
  }
  if (selectionChanged) {
    lastSnapshot = "";
    updateLocation(selectedPath);
  }
  renderTabs();
  if (selectedPath) {
    void showArtifact(selectedPath);
  } else {
    welcome();
  }
}

function connectSessionEvents() {
  sessionStream = new EventSource("./api/events");
  sessionStream.onopen = () => {
    sessionConnected = true;
  };
  sessionStream.onerror = () => {
    sessionConnected = false;
  };
  sessionStream.addEventListener("session", (event) => {
    sessionConnected = true;
    try {
      synchronizeSession(JSON.parse(event.data));
    } catch (error) {
      showToast(error.message);
    }
  });
}

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
      const sourceButton = event.target.closest("button");
      sourcePanel.hidden = !sourcePanel.hidden;
      sourceButton.setAttribute("aria-expanded", String(!sourcePanel.hidden));
      sourceButton.setAttribute("aria-label", sourcePanel.hidden ? "Show source" : "Hide source");
      sourceButton.textContent = sourcePanel.hidden ? "Show source" : "Hide source";
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
    }, { maxSvgSize: 8192 });
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
        <button class="tool-button" data-action="source" type="button" aria-label="Show source" aria-expanded="false">Show source</button>
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

const BAND_ORDER = ["Now", "Next", "Later", "Parked", "Shipped"];

function navItem(ref, label, meta = "", extraClass = "") {
  const item = document.createElement("li");
  item.className = `nav-item ${extraClass}`;
  item.dataset.ref = ref;
  item.dataset.filter = `${label} ${ref}`.toLowerCase();
  const link = document.createElement("a");
  link.href = `./review?artifact=${encodeURIComponent(ref)}`;
  link.dataset.path = ref;
  link.innerHTML = `<span class="nav-label">${escapeHtml(label)}</span>${meta}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    selectTab(ref);
  });
  item.appendChild(link);
  return item;
}

function navGroup(title, items) {
  const group = document.createElement("li");
  group.className = "nav-group";
  group.innerHTML = `<p class="nav-group-title">${escapeHtml(title)}</p>`;
  const list = document.createElement("ul");
  list.append(...items);
  group.appendChild(list);
  return group;
}

function stateDot(state) {
  return `<span class="state-dot state-${escapeHtml(state)}" title="${escapeHtml(state)}"></span>`;
}

function renderNavigation() {
  const groups = [navGroup("Overview", [navItem("roadmap", "Roadmap", "", "nav-primary")])];
  const initiatives = navigation.initiatives ?? [];
  const bucket = (item) => item.state === "superseded" ? "Superseded" : item.state === "unlisted" ? "Not on the roadmap" : item.band;
  for (const band of [...BAND_ORDER, "Superseded", "Not on the roadmap"]) {
    const members = initiatives.filter((item) => bucket(item) === band);
    if (members.length) {
      groups.push(navGroup(band, members.map((item) => navItem(`initiative:${item.id}`, item.title, stateDot(item.state)))));
    }
  }
  const glossary = navigation.glossary ?? {};
  groups.push(navGroup("Library", [
    navItem("requirements", "Requirements"),
    navItem("decisions", "Decisions"),
    navItem("glossary", "Glossary", glossary.exists ? "" : '<span class="nav-note">missing</span>')
  ]));
  artifacts.replaceChildren(...groups);
  if (navigation.diagnostics?.length) {
    const warning = document.createElement("li");
    warning.className = "nav-diagnostics";
    warning.innerHTML = `<details><summary>${navigation.diagnostics.length} workflow config ${navigation.diagnostics.length === 1 ? "warning" : "warnings"}</summary><ul>${navigation.diagnostics.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul></details>`;
    artifacts.appendChild(warning);
  }
  artifactCount.textContent = String(initiatives.length);
  updateTreeState();
}

function updateTreeState() {
  const query = artifactFilter.value.trim().toLowerCase();
  let visible = 0;
  for (const item of artifacts.querySelectorAll(".nav-item")) {
    const matches = !query || item.dataset.filter.includes(query);
    item.hidden = !matches;
    visible += matches ? 1 : 0;
  }
  for (const group of artifacts.querySelectorAll(".nav-group")) {
    group.hidden = ![...group.querySelectorAll(".nav-item")].some((item) => !item.hidden);
  }
  emptyFilter.hidden = visible !== 0;
}

function navigationKey(path) {
  const parsed = parseEntityRef(path);
  if (parsed?.kind === "slice") return `initiative:${parsed.id}`;
  return path;
}

function selectNavigation(path) {
  const key = navigationKey(path);
  for (const link of artifacts.querySelectorAll("a[data-path]")) {
    if (link.dataset.path === key) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function tabLabel(path) {
  const parsed = parseEntityRef(path);
  if (!parsed) return fileName(path);
  if (parsed.kind === "initiative") return navigation.initiatives.find((item) => item.id === parsed.id)?.title ?? parsed.id;
  if (parsed.kind === "slice") return sliceTitles.get(path) ?? parsed.slug;
  return ENTITY_LABELS[parsed.kind];
}

async function showEntity(path) {
  const response = await fetch(`./api/entity?ref=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) {
    artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(await response.text())}</p></div>`;
    return;
  }
  const entity = await response.json();
  const snapshot = JSON.stringify(entity);
  if (snapshot === lastSnapshot) {
    return;
  }
  lastSnapshot = snapshot;
  selectNavigation(path);
  if (entity.kind === "slice") {
    sliceTitles.set(path, entity.data.slice.title);
    renderTabs();
  }
  const label = entityLabel(entity);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <p class="eyebrow">${escapeHtml(label.eyebrow)}</p>
        <h1>${escapeHtml(label.title)}</h1>
        ${label.subtitle ? `<p class="artifact-path">${escapeHtml(label.subtitle)}</p>` : ""}
      </div>
      <div class="artifact-meta"><span class="meta-pill live">Live</span></div>
    </header>`;
  const container = document.createElement("div");
  container.className = "structured-view";
  artifact.appendChild(container);
  await renderEntity(container, entity, { ...viewContext(path, viewState(path)), renderMarkdown: (source) => renderText("document.md", source) });
}

async function showArtifact(path) {
  if (parseEntityRef(path)) {
    await showEntity(path);
    return;
  }
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
  const structured = Boolean(data.kind);
  const documentCard = structured || data.path.toLowerCase().endsWith(".puml")
    ? ""
    : `<section class="document-card"><div class="document-content">${renderText(data.path, data.content)}</div></section>`;
  const state = viewState(data.path);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <p class="eyebrow">${structured ? escapeHtml(KIND_LABELS[data.kind] ?? "JSON") : "Human review"}</p>
        <h1>${escapeHtml(fileName(data.path))}</h1>
        <p class="artifact-path">${escapeHtml(data.path)}</p>
      </div>
      <div class="artifact-meta">
        ${structured ? `<div class="segmented" role="group" aria-label="View mode">
          <button type="button" data-mode="structured" aria-pressed="${!state.raw}">Structured</button>
          <button type="button" data-mode="raw" aria-pressed="${Boolean(state.raw)}">Raw</button>
        </div>` : ""}
        <span class="meta-pill">${escapeHtml(fileType(data.path))}</span>
        ${structured ? "" : `<span class="meta-pill">${diagramLabel}</span>`}
        <span class="meta-pill live" title="Last refreshed at ${refreshed}">Live</span>
      </div>
    </header>
    ${documentCard}`;
  if (structured) {
    for (const button of artifact.querySelectorAll(".segmented button")) {
      button.addEventListener("click", () => {
        state.raw = button.dataset.mode === "raw";
        lastSnapshot = "";
        void showArtifact(path);
      });
    }
    const container = document.createElement("div");
    container.className = "structured-view";
    artifact.appendChild(container);
    await renderView(container, data, viewContext(data.path, state));
    return;
  }
  for (const diagram of data.diagrams) {
    const section = diagramCard(diagram);
    artifact.appendChild(section);
    await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
  }
}

const KIND_LABELS = {
  "concept-delta": "Concept delta",
  "review-ledger": "Review ledger",
  "coordination-state": "Coordination state",
  json: "JSON artifact"
};

function viewState(path) {
  if (!viewStates.has(path)) {
    viewStates.set(path, {});
  }
  return viewStates.get(path);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function viewContext(path, state) {
  return {
    path,
    state,
    escapeHtml,
    showToast,
    fetchArtifact: (artifactPath) => fetchJson(`./api/artifact?path=${encodeURIComponent(artifactPath)}`),
    fetchEvidence: (id) => fetchJson(`./api/evidence?id=${encodeURIComponent(id)}`),
    hasArtifact: (artifactPath) => availableArtifacts.has(artifactPath) || Boolean(parseEntityRef(artifactPath)),
    openArtifact(artifactPath) {
      if (!availableArtifacts.has(artifactPath) && !parseEntityRef(artifactPath)) {
        showToast(`Not a reviewable artifact: ${artifactPath}`);
        return;
      }
      selectTab(artifactPath);
    },
    openEvidence: (id, label) => openEvidence(id, label, viewContext(path, state)),
    rerender() {
      lastSnapshot = "";
      void showArtifact(path);
    }
  };
}

function filterArtifacts() {
  updateTreeState();
}

async function initialize() {
  const response = await fetch("./api/index", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = await response.json();
  openTabs = data.openTabs;
  sessionRevision = Number.isInteger(data.revision) ? data.revision : 0;
  const requestedPath = selectedPath;
  const hasServerActiveTab = Object.hasOwn(data, "activeTab");
  if (hasServerActiveTab) {
    selectedPath = data.activeTab;
  }
  if (requestedPath && !openTabs.includes(requestedPath)) {
    selectedPath = requestedPath;
    openTabs.push(requestedPath);
    await saveSession();
  }
  if (!selectedPath && !hasServerActiveTab) {
    selectedPath = openTabs[0] ?? null;
  }
  project.textContent = data.projectRoot;
  availableArtifacts = new Set(data.artifacts);
  navigation = data.navigation;
  renderNavigation();
  if (!selectedPath && openTabs.length === 0) {
    selectedPath = "roadmap";
    openTabs = ["roadmap"];
    await saveSession();
  }
  renderTabs();
  connectSessionEvents();
  artifactFilter.addEventListener("input", filterArtifacts);
  document.getElementById("evidence-close").addEventListener("click", closeEvidence);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.activeElement !== artifactFilter && !document.getElementById("evidence-drawer").hidden) {
      closeEvidence();
    } else if (event.key === "/" && document.activeElement !== artifactFilter) {
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
  setInterval(async () => {
    try {
      const refreshed = await fetch("./api/index", { cache: "no-store" });
      if (refreshed.ok) {
        const snapshot = await refreshed.json();
        availableArtifacts = new Set(snapshot.artifacts);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          navigation = snapshot.navigation;
          renderNavigation();
          selectNavigation(selectedPath ?? "");
          renderTabs();
        }
        if (!sessionConnected) {
          synchronizeSession(snapshot);
        }
      }
      if (selectedPath) {
        await showArtifact(selectedPath);
      }
    } catch {
    }
  }, 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(error.message)}</p></div>`;
});
