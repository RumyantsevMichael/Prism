import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, renderEntity } from "./views/entities.js";
import { createPalette } from "./views/palette.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const artifact = document.getElementById("artifact");
const tabs = document.getElementById("tabs");
const toast = document.getElementById("toast");
let selectedPath = new URLSearchParams(location.search).get("artifact");
let openTabs = [];
// One preview tab is replaced by ordinary navigation; kept and agent-presented tabs stay until closed.
let previewTab = null;
let agentTabs = [];
let sessionRevision = 0;
// A replaced review app restarts revisions, so a snapshot from a new instance is accepted whatever its revision.
let sessionInstance = null;
let sessionConnected = false;
let sessionStream;
let saveQueue = Promise.resolve();
let lastSnapshot = "";
let toastTimer;
let availableArtifacts = new Set();
let navigation = { attention: {}, glossary: {}, diagnostics: [], index: [] };
let currentContext = null;
let contextSnapshot = "";
let palette;
const viewStates = new Map();
const treeToggles = new Map();

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function welcome() {
  artifact.innerHTML = `<div class="welcome-card">
    <span class="welcome-mark" aria-hidden="true"></span>
    <p class="eyebrow">Human review</p>
    <h1>Nothing is open</h1>
    <p>Choose Attention, the roadmap, or a library section, or press Ctrl K to jump.</p>
  </div>`;
}

function updateLocation(path, push = false) {
  const url = new URL(location.href);
  if (path) {
    url.searchParams.set("artifact", path);
  } else {
    url.searchParams.delete("artifact");
  }
  if (push) {
    history.pushState({ ref: path }, "", `${url.pathname}${url.search}`);
  } else {
    history.replaceState({ ref: path }, "", `${url.pathname}${url.search}`);
  }
}

function renderTabs() {
  tabs.replaceChildren();
  for (const path of openTabs) {
    const isPreview = path === previewTab;
    const isAgent = agentTabs.includes(path);
    const tab = document.createElement("div");
    tab.className = `artifact-tab${isPreview ? " is-preview" : ""}${isAgent ? " is-agent" : ""}`;
    tab.setAttribute("role", "presentation");
    const select = document.createElement("button");
    select.className = "artifact-tab-select";
    select.type = "button";
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(path === selectedPath));
    select.title = [path, isPreview ? "Preview tab: the next link replaces it. Double-click to keep it open." : "", isAgent ? "Presented by the agent." : ""].filter(Boolean).join("\n");
    if (isAgent) {
      const mark = document.createElement("span");
      mark.className = "agent-mark";
      mark.setAttribute("aria-label", "Presented by the agent");
      select.appendChild(mark);
    }
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabLabel(path);
    select.appendChild(label);
    select.addEventListener("click", () => openRef(path));
    select.addEventListener("dblclick", () => keepTab(path));
    tab.appendChild(select);
    if (isPreview) {
      const keep = document.createElement("button");
      keep.className = "artifact-tab-keep";
      keep.type = "button";
      keep.title = "Keep this tab open";
      keep.setAttribute("aria-label", `Keep ${tabLabel(path)} open`);
      keep.textContent = "Keep";
      keep.addEventListener("click", () => keepTab(path));
      tab.appendChild(keep);
    }
    const close = document.createElement("button");
    close.className = "artifact-tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${tabLabel(path)}`);
    close.textContent = "×";
    close.addEventListener("click", () => closeTab(path));
    tab.appendChild(close);
    tabs.appendChild(tab);
  }
}

function saveSession() {
  const payload = { openTabs: [...openTabs], activeTab: selectedPath, previewTab, agentTabs: agentTabs.filter((tab) => openTabs.includes(tab)) };
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

function openRef(path, { keep = false, fromHistory = false } = {}) {
  if (!path) {
    return;
  }
  if (openTabs.includes(path)) {
    if (keep && previewTab === path) {
      previewTab = null;
    }
  } else if (keep || !previewTab || !openTabs.includes(previewTab)) {
    const position = openTabs.indexOf(selectedPath);
    openTabs.splice(position === -1 ? openTabs.length : position + 1, 0, path);
    if (!keep) {
      previewTab = path;
    }
  } else {
    openTabs[openTabs.indexOf(previewTab)] = path;
    previewTab = path;
  }
  const moved = selectedPath !== path;
  selectedPath = path;
  lastSnapshot = "";
  updateLocation(path, moved && !fromHistory);
  renderTabs();
  void showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
}

function keepTab(path) {
  if (previewTab !== path) {
    return;
  }
  previewTab = null;
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}

function closeTab(path) {
  openTabs = openTabs.filter((tab) => tab !== path);
  agentTabs = agentTabs.filter((tab) => tab !== path);
  if (previewTab === path) {
    previewTab = null;
  }
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
    currentContext = null;
    contextSnapshot = "";
    renderNavigation();
  }
  void saveSession().catch((error) => showToast(error.message));
}

function synchronizeSession(snapshot) {
  const nextRevision = Number.isInteger(snapshot.revision) ? snapshot.revision : sessionRevision;
  const nextInstance = typeof snapshot.instance === "string" ? snapshot.instance : sessionInstance;
  if (nextRevision <= sessionRevision && nextInstance === sessionInstance) {
    return;
  }
  sessionInstance = nextInstance;
  const nextTabs = Array.isArray(snapshot.openTabs) ? [...snapshot.openTabs] : [];
  const nextSelectedPath = Object.hasOwn(snapshot, "activeTab")
    ? snapshot.activeTab
    : nextTabs.includes(selectedPath) ? selectedPath : nextTabs[0] ?? null;
  const nextPreview = nextTabs.includes(snapshot.previewTab) ? snapshot.previewTab : null;
  const nextAgentTabs = Array.isArray(snapshot.agentTabs) ? snapshot.agentTabs.filter((tab) => nextTabs.includes(tab)) : [];
  const tabsChanged = !samePaths(openTabs, nextTabs) || previewTab !== nextPreview || !samePaths(agentTabs, nextAgentTabs);
  const selectionChanged = selectedPath !== nextSelectedPath;
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  previewTab = nextPreview;
  agentTabs = nextAgentTabs;
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

function navLink(ref, label, { meta = "", className = "", depth = 0, current = false, toggle = null } = {}) {
  const item = document.createElement("li");
  item.className = `nav-item depth-${Math.min(depth, 6)} ${className}`.trim();
  item.dataset.ref = ref;
  if (toggle) {
    item.appendChild(toggle);
  }
  const link = document.createElement("a");
  link.href = `./review?artifact=${encodeURIComponent(ref)}`;
  link.dataset.path = ref;
  link.innerHTML = `<span class="nav-label">${escapeHtml(label)}</span>${meta}`;
  link.title = label;
  if (current) {
    link.setAttribute("aria-current", "page");
  }
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openRef(ref, { keep: event.ctrlKey || event.metaKey });
  });
  link.addEventListener("dblclick", () => openRef(ref, { keep: true }));
  item.appendChild(link);
  return item;
}

function navHeading(title) {
  const item = document.createElement("li");
  item.className = "nav-heading";
  item.textContent = title;
  return item;
}

function stateDot(state) {
  return `<span class="state-dot state-${escapeHtml(state)}" title="${escapeHtml(state)}"></span>`;
}

function statusDot(status) {
  return `<span class="slice-dot status-${escapeHtml(status)}" title="${escapeHtml(status)}"></span>`;
}

function docDot(status) {
  const value = String(status ?? "unknown").toLowerCase().split(/\s/)[0].replace(/[^a-z-]/g, "");
  return `<span class="doc-dot dot-${escapeHtml(value)}" title="${escapeHtml(status ?? "no status")}"></span>`;
}

function isExpanded(scope, node, ancestorsOfCurrent) {
  const toggles = treeToggles.get(scope.id);
  if (toggles?.has(node.slug)) {
    return toggles.get(node.slug);
  }
  // Fully done branches start collapsed unless they contain the current slice.
  return !node.complete || ancestorsOfCurrent.has(node.slug);
}

function initiativeBranch(scope) {
  const items = [];
  const nodes = new Map(scope.tree.map((node) => [node.slug, node]));
  const ancestorsOfCurrent = new Set();
  for (let slug = scope.current; slug; slug = nodes.get(slug)?.parent) {
    ancestorsOfCurrent.add(slug);
  }
  const initiativeRef = `initiative:${scope.id}`;
  items.push(navLink(initiativeRef, scope.title, { meta: stateDot(scope.state), className: "nav-scope-head", depth: 1, current: selectedPath === initiativeRef || (!scope.current && !parseEntityRef(selectedPath ?? "")) }));
  const hidden = new Set();
  for (const node of scope.tree) {
    if (node.depth === 0) {
      continue;
    }
    if (node.parent && (hidden.has(node.parent) || (nodes.get(node.parent).depth > 0 && !isExpanded(scope, nodes.get(node.parent), ancestorsOfCurrent)))) {
      hidden.add(node.slug);
      continue;
    }
    const ref = `slice:${scope.id}/${node.slug}`;
    let toggle = null;
    if (node.hasChildren) {
      const expanded = isExpanded(scope, node, ancestorsOfCurrent);
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${node.title}`);
      toggle.addEventListener("click", () => {
        if (!treeToggles.has(scope.id)) {
          treeToggles.set(scope.id, new Map());
        }
        treeToggles.get(scope.id).set(node.slug, !expanded);
        renderNavigation();
      });
    }
    const meta = `${node.blocking ? `<span class="nav-flag is-bad" title="${node.blocking} blocking findings">${node.blocking}</span>` : ""}${statusDot(node.status)}`;
    items.push(navLink(ref, node.title, { meta, className: `nav-slice${node.hasChildren ? " has-children" : ""}`, depth: node.depth + 1, current: selectedPath === ref || (scope.current === node.slug && !parseEntityRef(selectedPath ?? "")), toggle }));
  }
  if (!scope.tree.length) {
    const note = document.createElement("li");
    note.className = "nav-empty depth-2";
    note.textContent = scope.valid === false ? "The initiative record is invalid." : "No slices yet.";
    items.push(note);
  }
  return items;
}

function libraryBranch(scope) {
  const items = [];
  let topic;
  for (const entry of scope.entries) {
    if (scope.section === "decisions" && (entry.topic ?? "General") !== topic) {
      topic = entry.topic ?? "General";
      const heading = document.createElement("li");
      heading.className = "nav-subheading depth-2";
      heading.textContent = topic;
      items.push(heading);
    }
    items.push(navLink(entry.path, entry.title, { meta: docDot(entry.status), className: "nav-document", depth: 2, current: selectedPath === entry.path }));
  }
  if (!scope.entries.length) {
    const note = document.createElement("li");
    note.className = "nav-empty depth-2";
    note.textContent = "No documents.";
    items.push(note);
  }
  return items;
}

// The sidebar lists fixed places and expands only the path to what is open: an initiative's slices or a library section's documents.
function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  const items = [];
  const badge = attention.needsYou ? `<span class="count-badge${attention.gates ? " is-alert" : ""}" title="${attention.gates} recorded ${attention.gates === 1 ? "question" : "questions"} and ${attention.needsYou - attention.gates} other ${attention.needsYou - attention.gates === 1 ? "item" : "items"} need you">${attention.needsYou}</span>` : "";
  items.push(navLink("attention", "Attention", { meta: badge, className: "nav-place place-attention", current: selectedPath === "attention" }));
  items.push(navLink("roadmap", "Roadmap", { className: "nav-place place-roadmap", current: selectedPath === "roadmap" }));
  if (scope.kind === "initiative") {
    items.push(...initiativeBranch(scope));
  }
  items.push(navHeading("Library"));
  for (const section of ["requirements", "decisions"]) {
    items.push(navLink(section, ENTITY_LABELS[section], { className: "nav-place nav-library", current: selectedPath === section }));
    if (scope.kind === "library" && scope.section === section) {
      items.push(...libraryBranch(scope));
    }
  }
  const glossary = navigation.glossary ?? {};
  items.push(navLink("glossary", "Glossary", { meta: glossary.exists ? "" : '<span class="nav-note">missing</span>', className: "nav-place nav-library", current: selectedPath === "glossary" || (glossary.path && selectedPath === glossary.path) }));
  if (navigation.diagnostics?.length) {
    const warning = document.createElement("li");
    warning.className = "nav-diagnostics";
    warning.innerHTML = `<details><summary>${navigation.diagnostics.length} workflow config ${navigation.diagnostics.length === 1 ? "warning" : "warnings"}</summary><ul>${navigation.diagnostics.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul></details>`;
    items.push(warning);
  }
  artifacts.replaceChildren(...items);
  artifacts.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
}

function breadcrumbHtml(path) {
  const trail = currentContext?.ref === path ? currentContext.value.trail : [{ ref: path, label: tabLabel(path) }];
  return trail.map((crumb, index) => {
    if (index === trail.length - 1) {
      return `<span class="crumb is-current" aria-current="location">${escapeHtml(crumb.label)}</span>`;
    }
    return crumb.ref
      ? `<button type="button" class="crumb" data-crumb="${escapeHtml(crumb.ref)}">${escapeHtml(crumb.label)}</button>`
      : `<span class="crumb is-static">${escapeHtml(crumb.label)}</span>`;
  }).join('<span class="crumb-separator" aria-hidden="true">›</span>');
}

async function refreshContext(path) {
  let value;
  try {
    value = await fetchJson(`./api/context?ref=${encodeURIComponent(path)}`);
  } catch {
    value = { trail: [{ ref: path, label: tabLabel(path) }], scope: { kind: "global" } };
  }
  if (path !== selectedPath) {
    return;
  }
  const snapshot = JSON.stringify([path, value]);
  if (snapshot === contextSnapshot) {
    return;
  }
  contextSnapshot = snapshot;
  currentContext = { ref: path, value };
  renderNavigation();
  const crumbs = artifact.querySelector("[data-breadcrumbs]");
  if (crumbs) {
    crumbs.innerHTML = breadcrumbHtml(path);
  }
  renderTabs();
}

function tabLabel(path) {
  const parsed = parseEntityRef(path);
  if (!parsed) return fileName(path);
  if (ENTITY_LABELS[parsed.kind]) return ENTITY_LABELS[parsed.kind];
  const indexed = navigation.index?.find((entry) => entry.ref === path)?.label;
  if (indexed) return indexed;
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  return parsed.kind === "slice" ? parsed.slug : parsed.id;
}

async function showEntity(path) {
  const response = await fetch(`./api/entity?ref=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) {
    artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(await response.text())}</p></div>`;
    return;
  }
  const entity = await response.json();
  const snapshot = JSON.stringify(entity);
  if (snapshot === lastSnapshot || path !== selectedPath) {
    return;
  }
  lastSnapshot = snapshot;
  const label = entityLabel(entity);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <nav class="breadcrumbs" aria-label="Location" data-breadcrumbs>${breadcrumbHtml(path)}</nav>
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
  await refreshContext(path);
  if (path !== selectedPath) {
    return;
  }
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
  if (snapshot === lastSnapshot || path !== selectedPath) {
    return;
  }
  lastSnapshot = snapshot;
  const diagramLabel = `${data.diagrams.length} diagram${data.diagrams.length === 1 ? "" : "s"}`;
  const refreshed = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const source = data.kind === "source";
  const structured = Boolean(data.kind) && !source;
  const documentCard = source
    ? `<section class="document-card source-card"><ol class="source-lines">${data.content.replace(/\n$/, "").split(/\r?\n/).map((line) => `<li><code>${escapeHtml(line) || " "}</code></li>`).join("")}</ol></section>`
    : structured || data.path.toLowerCase().endsWith(".puml")
      ? ""
      : `<section class="document-card"><div class="document-content">${renderText(data.path, data.content)}</div></section>`;
  const state = viewState(data.path);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <nav class="breadcrumbs" aria-label="Location" data-breadcrumbs>${breadcrumbHtml(path)}</nav>
        <h1>${escapeHtml(fileName(data.path))}</h1>
        <p class="artifact-path">${escapeHtml(data.path)}</p>
      </div>
      <div class="artifact-meta">
        ${structured ? `<div class="segmented" role="group" aria-label="View mode">
          <button type="button" data-mode="structured" aria-pressed="${!state.raw}">Structured</button>
          <button type="button" data-mode="raw" aria-pressed="${Boolean(state.raw)}">Raw</button>
        </div>` : ""}
        ${structured ? `<span class="meta-pill">${escapeHtml(KIND_LABELS[data.kind] ?? "JSON")}</span>` : ""}
        <span class="meta-pill">${escapeHtml(fileType(data.path))}</span>
        ${source ? '<span class="meta-pill">Read-only</span>' : structured ? "" : `<span class="meta-pill">${diagramLabel}</span>`}
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
    openArtifact(artifactPath, options = {}) {
      if (!availableArtifacts.has(artifactPath) && !parseEntityRef(artifactPath)) {
        showToast(`Not a reviewable artifact: ${artifactPath}`);
        return;
      }
      openRef(artifactPath, options);
    },
    openEvidence: (id, label) => openEvidence(id, label, viewContext(path, state)),
    async answerGate(payload) {
      const response = await fetch("./api/gates/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({ message: "The server returned an unreadable response." }));
      if (!response.ok) {
        throw Object.assign(new Error(result.message ?? "The answer was not recorded."), { code: result.code });
      }
      return result;
    },
    rerender() {
      lastSnapshot = "";
      void showArtifact(path);
    }
  };
}

function paletteEntries() {
  const places = [
    { ref: "attention", label: "Attention", kind: "place", detail: "What needs you" },
    { ref: "roadmap", label: "Roadmap", kind: "place", detail: "Initiatives by band" },
    { ref: "requirements", label: "Requirements", kind: "place", detail: "Library" },
    { ref: "decisions", label: "Decisions", kind: "place", detail: "Library" },
    { ref: "glossary", label: "Glossary", kind: "place", detail: "Library" }
  ];
  const indexed = navigation.index ?? [];
  const known = new Set(indexed.map((entry) => entry.ref));
  const files = [...availableArtifacts].filter((file) => !known.has(file)).map((file) => ({ ref: file, label: fileName(file), kind: "file", detail: file }));
  return [...places, ...indexed, ...files];
}

async function initialize() {
  const data = await fetchJson("./api/index");
  openTabs = data.openTabs;
  previewTab = openTabs.includes(data.previewTab) ? data.previewTab : null;
  agentTabs = (data.agentTabs ?? []).filter((tab) => openTabs.includes(tab));
  sessionRevision = Number.isInteger(data.revision) ? data.revision : 0;
  sessionInstance = typeof data.instance === "string" ? data.instance : null;
  const requestedPath = selectedPath;
  selectedPath = Object.hasOwn(data, "activeTab") ? data.activeTab : null;
  project.textContent = data.projectRoot;
  availableArtifacts = new Set([...data.artifacts, ...(data.sources ?? [])]);
  navigation = data.navigation;
  palette = createPalette({
    dialog: document.getElementById("palette"),
    input: document.getElementById("palette-input"),
    results: document.getElementById("palette-results"),
    entries: paletteEntries,
    onOpen: (ref, options) => openRef(ref, options)
  });
  document.getElementById("jump").addEventListener("click", () => palette.show());
  document.getElementById("evidence-close").addEventListener("click", closeEvidence);
  artifact.addEventListener("click", (event) => {
    const crumb = event.target.closest("[data-crumb]");
    if (crumb) {
      openRef(crumb.dataset.crumb, { keep: event.ctrlKey || event.metaKey });
    }
  });
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (palette.isOpen()) palette.hide();
      else palette.show();
    } else if (event.key === "/" && !typing && !palette.isOpen()) {
      event.preventDefault();
      palette.show();
    } else if (event.key === "Escape" && !palette.isOpen() && !document.getElementById("evidence-drawer").hidden) {
      closeEvidence();
    }
  });
  window.addEventListener("popstate", (event) => {
    const ref = event.state?.ref ?? new URLSearchParams(location.search).get("artifact");
    if (ref && ref !== selectedPath) {
      openRef(ref, { fromHistory: true });
    }
  });
  connectSessionEvents();
  renderNavigation();
  if (requestedPath && requestedPath !== selectedPath) {
    openRef(requestedPath, { fromHistory: true });
  } else if (!selectedPath) {
    openRef(openTabs[0] ?? "attention", { fromHistory: true });
  } else {
    updateLocation(selectedPath);
    renderTabs();
    await showArtifact(selectedPath);
  }
  setInterval(async () => {
    try {
      const refreshed = await fetch("./api/index", { cache: "no-store" });
      if (refreshed.ok) {
        const snapshot = await refreshed.json();
        availableArtifacts = new Set([...snapshot.artifacts, ...(snapshot.sources ?? [])]);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          navigation = snapshot.navigation;
          renderNavigation();
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
