import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, renderEntity } from "./views/entities.js";
import { createPalette } from "./views/palette.js";
import { anchorTarget, decorateDocuments, markCurrentSection, renderText } from "./views/markdown.js";
import { createLinkPreview } from "./views/preview.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const navPlaces = document.getElementById("nav-places");
const navLibrary = document.getElementById("nav-library");
const workspace = document.getElementById("workspace");
const appShell = document.getElementById("app-shell");
const sidebarToggle = document.getElementById("sidebar-toggle");
const connectionBanner = document.getElementById("connection");
const artifact = document.getElementById("artifact");
const tabs = document.getElementById("tabs");
const toast = document.getElementById("toast");
const projectButton = document.getElementById("project-button");
const projectMenu = document.getElementById("project-menu");
const projectList = document.getElementById("project-list");
const projectGates = document.getElementById("project-gates");
const noticeBanner = document.getElementById("notice");
// The latest notice per presenting project; a notice only links, and the tab changes project only when the user follows it.
const notices = new Map();
let projectListing = "";
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
// The path whose view the workspace shows, and each open tab's scroll position, so a refresh or a tab switch keeps the reader's place.
let renderedPath = null;
let rebuilding = false;
const scrollPositions = new Map();
let failedRefreshes = 0;
// A link to a heading in another document scrolls there once that document has rendered.
let pendingAnchor = null;
// A text match chosen in the palette is highlighted once its document has rendered.
let pendingFind = null;
let toastTimer;
let availableArtifacts = new Set();
let navigation = { attention: {}, glossary: {}, diagnostics: [], index: [] };
let currentContext = null;
let contextSnapshot = "";
let palette;
let linkPreview;
const viewStates = new Map();
const treeToggles = new Map();

const ICON_PATHS = {
  attention: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  roadmap: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  requirements: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
  decisions: '<path d="M12 3v18M5 7h14"/><path d="m5 7-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z"/>',
  glossary: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5a2.5 2.5 0 0 0 0 5H20"/>'
};

function icon(name) {
  return `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function welcome() {
  renderedPath = null;
  document.body.classList.remove("has-maximized");
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
  const selected = tabs.querySelector('[aria-selected="true"]')?.parentElement;
  if (selected) {
    const left = selected.offsetLeft - tabs.offsetLeft;
    if (left < tabs.scrollLeft) tabs.scrollLeft = left;
    else if (left + selected.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = left + selected.offsetWidth - tabs.clientWidth;
  }
  updateTabFades();
}

function updateTabFades() {
  tabs.classList.toggle("fade-start", tabs.scrollLeft > 1);
  tabs.classList.toggle("fade-end", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
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
  scrollPositions.delete(path);
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

function folderName(root) {
  return String(root).split(/[\\/]/).filter(Boolean).pop() ?? String(root);
}

// A linked worktree reads as repository / worktree; a plain checkout, or a server that names no workspace, shows its folder.
function workspaceIdentity(entry) {
  return entry.workspace ?? { repository: folderName(entry.projectRoot), worktree: null, branch: null };
}

function projectLabel(identity) {
  const label = element("span", "project-label-text");
  label.append(element("span", "project-repository", identity.repository));
  if (identity.worktree) label.append(element("span", "project-separator", "/"), element("span", "project-worktree", identity.worktree));
  return label;
}

function projectTitle(identity, projectRoot) {
  return [projectRoot, identity.branch ? `Branch: ${identity.branch}` : ""].filter(Boolean).join("\n");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The review app lists its projects; a session server has no list, so its page keeps a plain project label.
async function refreshProjects() {
  let listing;
  try {
    const response = await fetch("./api/projects", { cache: "no-store" });
    if (!response.ok) return;
    listing = await response.json();
  } catch {
    return;
  }
  projectButton.disabled = false;
  const waiting = listing.projects.filter((entry) => entry.id !== listing.current).reduce((sum, entry) => sum + (entry.gates ?? 0), 0);
  projectGates.hidden = waiting === 0;
  projectGates.textContent = String(waiting);
  projectGates.title = `${waiting} open ${waiting === 1 ? "gate" : "gates"} in other projects`;
  // An unchanged list is left alone, and a rebuilt one keeps keyboard focus on the same project.
  const text = JSON.stringify(listing);
  if (text === projectListing) return;
  projectListing = text;
  const focused = document.activeElement?.closest?.(".project-entry")?.dataset.project;
  const current = listing.projects.find((entry) => entry.id === listing.current);
  if (current) setProjectLabel(workspaceIdentity(current), current.projectRoot);
  // Worktrees of one repository are listed together under it, in the order the first of them appears.
  const groups = new Map();
  for (const entry of listing.projects) {
    const identity = workspaceIdentity(entry);
    if (!groups.has(identity.repository)) groups.set(identity.repository, []);
    groups.get(identity.repository).push({ entry, identity });
  }
  const items = [];
  for (const [repository, members] of groups) {
    const grouped = members.length > 1 || members.some(({ identity }) => identity.worktree);
    if (grouped) items.push(element("li", "project-group", repository));
    for (const { entry, identity } of members) {
      const link = element("a", `project-entry${grouped ? " is-grouped" : ""}`);
      link.dataset.project = entry.id;
      link.href = entry.url;
      link.title = projectTitle(identity, entry.projectRoot);
      if (entry.id === listing.current) link.setAttribute("aria-current", "page");
      const liveMark = element("span", `project-entry-live${entry.live ? " live" : ""}`);
      liveMark.title = entry.live ? "An agent session is using this project" : "Recently used";
      const gates = element("span", `project-entry-gates${entry.gates ? "" : " none"}`, entry.gates === null ? "?" : String(entry.gates));
      gates.title = entry.gates === null ? "The project's folder or records cannot be read" : `${entry.gates} open ${entry.gates === 1 ? "gate" : "gates"}`;
      link.append(liveMark, element("span", "project-entry-name", identity.worktree ?? identity.repository), gates, element("span", "project-entry-root", entry.projectRoot));
      const item = element("li");
      item.append(link);
      items.push(item);
    }
  }
  projectList.replaceChildren(...items);
  if (focused) projectList.querySelector(`[data-project="${focused}"]`)?.focus();
}

function setProjectLabel(identity, projectRoot) {
  project.replaceChildren(projectLabel(identity));
  projectButton.title = projectTitle(identity, projectRoot);
}

const SIDEBAR_KEY = "prism.review.sidebar";

function readSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  appShell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  const action = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  sidebarToggle.title = `${action} ([)`;
  sidebarToggle.querySelector(".sr-only").textContent = action;
  if (!remember) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
  }
}

function setProjectMenu(open) {
  projectMenu.hidden = !open;
  projectButton.setAttribute("aria-expanded", String(open));
  if (open) void refreshProjects();
}

function renderNotices() {
  noticeBanner.hidden = notices.size === 0;
  noticeBanner.replaceChildren(...[...notices.values()].reverse().map((notice) => {
    const item = element("div", "notice-item");
    const text = element("p", "", "An agent presented a review in ");
    text.append(element("strong", "", notice.name), ". ");
    const link = element("a", "", "Open it");
    link.href = notice.url;
    link.title = notice.projectRoot;
    text.append(link);
    const dismiss = element("button", "notice-dismiss", "×");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", `Dismiss the notice about ${notice.name}`);
    dismiss.addEventListener("click", () => {
      notices.delete(notice.projectId);
      renderNotices();
    });
    item.append(text, dismiss);
    return item;
  }));
}

function connectSessionEvents() {
  sessionStream = new EventSource("./api/events");
  sessionStream.onopen = () => {
    sessionConnected = true;
  };
  sessionStream.onerror = () => {
    sessionConnected = false;
  };
  sessionStream.addEventListener("notice", (event) => {
    try {
      const notice = JSON.parse(event.data);
      notices.delete(notice.projectId);
      notices.set(notice.projectId, notice);
      renderNotices();
    } catch {
    }
  });
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

function markdownOptions(basePath) {
  return { basePath, isKnown: (path) => availableArtifacts.has(path) };
}

// One failed poll can be a restart in progress, so the banner waits for a second one and clears on the next success.
function reportRefresh(ok) {
  failedRefreshes = ok ? 0 : failedRefreshes + 1;
  connectionBanner.hidden = failedRefreshes < 2;
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

function navLink(ref, label, { meta = "", className = "", depth = 0, current = false, toggle = null, iconName = null } = {}) {
  const item = document.createElement("li");
  item.className = `nav-item depth-${Math.min(depth, 6)} ${className}`.trim();
  item.dataset.ref = ref;
  if (toggle) {
    item.appendChild(toggle);
  }
  const link = document.createElement("a");
  link.href = `./review?artifact=${encodeURIComponent(ref)}`;
  link.dataset.path = ref;
  link.innerHTML = `${iconName ? icon(iconName) : ""}<span class="nav-label">${escapeHtml(label)}</span>${meta}`;
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

// The sidebar keeps its places and library sections in fixed groups and expands only the path to what is open between them:
// an initiative's slices or a library section's documents.
function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  const badge = attention.needsYou ? `<span class="count-badge${attention.gates ? " is-alert" : ""}" title="${attention.gates} recorded ${attention.gates === 1 ? "question" : "questions"} and ${attention.needsYou - attention.gates} other ${attention.needsYou - attention.gates === 1 ? "item" : "items"} need you">${attention.needsYou}</span>` : "";
  navPlaces.replaceChildren(
    navLink("attention", "Attention", { meta: badge, className: "nav-place place-attention", current: selectedPath === "attention", iconName: "attention" }),
    navLink("roadmap", "Roadmap", { className: "nav-place place-roadmap", current: selectedPath === "roadmap", iconName: "roadmap" })
  );
  const items = [];
  if (scope.kind === "initiative") {
    items.push(...initiativeBranch(scope));
  } else if (scope.kind === "library") {
    items.push(navHeading(ENTITY_LABELS[scope.section] ?? scope.section), ...libraryBranch(scope));
  }
  if (navigation.diagnostics?.length) {
    const warning = document.createElement("li");
    warning.className = "nav-diagnostics";
    warning.innerHTML = `<details><summary>${navigation.diagnostics.length} workflow config ${navigation.diagnostics.length === 1 ? "warning" : "warnings"}</summary><ul>${navigation.diagnostics.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul></details>`;
    items.push(warning);
  }
  const scrolled = artifacts.parentElement.scrollTop;
  artifacts.replaceChildren(...items);
  artifacts.parentElement.scrollTop = scrolled;
  const glossary = navigation.glossary ?? {};
  navLibrary.replaceChildren(
    navHeading("Library"),
    ...["requirements", "decisions"].map((section) => navLink(section, ENTITY_LABELS[section], { className: "nav-place nav-library", current: selectedPath === section, iconName: section })),
    navLink("glossary", "Glossary", { meta: glossary.exists ? "" : '<span class="nav-note">missing</span>', className: "nav-place nav-library", current: selectedPath === "glossary" || (glossary.path && selectedPath === glossary.path), iconName: "glossary" })
  );
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

function controlsOf(root) {
  return [...root.querySelectorAll("button, a[href], input, textarea, select, summary, [tabindex]")];
}

// A rebuilt view starts empty and renders graphs and diagrams asynchronously, so the old height is held until it is done
// and then the scroll position, open sections, and focus come back; a newly opened path starts where its tab was left, or at the top.
function beginRebuild(path) {
  const same = renderedPath === path;
  const memory = { path, top: same ? workspace.scrollTop : scrollPositions.get(path) ?? 0, open: null, focus: -1 };
  if (same) {
    memory.open = [...artifact.querySelectorAll("details")].map((details) => [details.querySelector("summary")?.textContent ?? "", details.open]);
    memory.focus = artifact.contains(document.activeElement) ? controlsOf(artifact).indexOf(document.activeElement) : -1;
    artifact.style.minHeight = `${artifact.offsetHeight}px`;
  } else {
    artifact.style.minHeight = "";
  }
  rebuilding = true;
  linkPreview?.hide();
  return memory;
}

function scrollToAnchor(anchor) {
  const target = anchorTarget(artifact, anchor);
  if (!target) return false;
  workspace.scrollTop += target.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 16;
  target.classList.remove("is-target");
  void target.offsetWidth;
  target.classList.add("is-target");
  return true;
}

const MAXIMIZABLE = ".graph-card, .diagram-card, .document-card";

// Graphs, diagrams, and documents can fill the window. The maximized card is remembered in the view state,
// so a refresh that rebuilds the view keeps it maximized instead of dropping out as browser fullscreen would.
function decorateMaximize(path) {
  const state = viewState(path);
  let found = false;
  [...artifact.querySelectorAll(MAXIMIZABLE)].forEach((card, index) => {
    const key = `${card.className.split(" ")[0]}:${index}`;
    let button = card.querySelector(":scope [data-maximize]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "tool-button maximize-button";
      button.dataset.maximize = key;
      const tools = card.querySelector(".diagram-tools");
      if (tools) tools.appendChild(button);
      else card.prepend(button);
      button.addEventListener("click", () => setMaximized(path, state.maximized === key ? null : key));
    }
    const maximized = state.maximized === key;
    found ||= maximized;
    card.classList.toggle("is-maximized", maximized);
    button.textContent = maximized ? "Restore" : "Maximize";
    button.setAttribute("aria-pressed", String(maximized));
    button.title = maximized ? "Restore (Esc)" : "Fill the window";
  });
  if (!found) state.maximized = null;
  document.body.classList.toggle("has-maximized", found);
}

function setMaximized(path, key) {
  viewState(path).maximized = key;
  decorateMaximize(path);
  const card = artifact.querySelector(".is-maximized") ?? artifact;
  card.querySelectorAll('[data-zoom="fit"]').forEach((button) => button.click());
}

// Marks the first rendered occurrence of the query's longest term and scrolls to it.
function highlightText(query) {
  const term = query.toLowerCase().split(/\s+/).filter(Boolean).sort((left, right) => right.length - left.length)[0];
  if (!term) return false;
  const walker = document.createTreeWalker(artifact, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(".doc-toc, .maximize-button, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.data.toLowerCase().indexOf(term);
    if (index === -1) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + term.length);
    const mark = document.createElement("mark");
    mark.className = "find-hit";
    range.surroundContents(mark);
    workspace.scrollTop += mark.getBoundingClientRect().top - workspace.getBoundingClientRect().top - workspace.clientHeight / 3;
    return true;
  }
  return false;
}

function endRebuild(memory) {
  rebuilding = false;
  if (memory.path !== selectedPath) {
    artifact.style.minHeight = "";
    return;
  }
  decorateDocuments(artifact);
  decorateMaximize(memory.path);
  if (memory.open) {
    const sections = artifact.querySelectorAll("details");
    memory.open.forEach(([summary, open], index) => {
      if (sections[index] && (sections[index].querySelector("summary")?.textContent ?? "") === summary) sections[index].open = open;
    });
  }
  if (memory.focus >= 0 && !artifact.contains(document.activeElement)) controlsOf(artifact)[memory.focus]?.focus({ preventScroll: true });
  workspace.scrollTop = memory.top;
  if (pendingAnchor?.path === memory.path) {
    scrollToAnchor(pendingAnchor.anchor);
    pendingAnchor = null;
  }
  if (pendingFind?.path === memory.path) {
    if (!highlightText(pendingFind.text)) showToast("The match is not visible in this view; try the Raw view.");
    pendingFind = null;
  }
  renderedPath = memory.path;
  markCurrentSection(artifact, workspace.getBoundingClientRect().top);
  requestAnimationFrame(() => {
    artifact.style.minHeight = "";
  });
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
  const state = viewState(path);
  const memory = beginRebuild(path);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <nav class="breadcrumbs" aria-label="Location" data-breadcrumbs>${breadcrumbHtml(path)}</nav>
        <h1>${escapeHtml(label.title)}</h1>
        ${label.lead ? `<div class="artifact-lead${state.leadExpanded ? " is-expanded" : ""}"><p>${escapeHtml(label.lead)}</p><button type="button" class="text-button lead-toggle" hidden>${state.leadExpanded ? "Less" : "More"}</button></div>` : ""}
        ${label.subtitle ? `<p class="artifact-path">${escapeHtml(label.subtitle)}</p>` : ""}
      </div>
    </header>`;
  const lead = artifact.querySelector(".artifact-lead");
  if (lead) {
    const text = lead.querySelector("p");
    const toggle = lead.querySelector(".lead-toggle");
    toggle.hidden = !state.leadExpanded && text.scrollHeight <= text.clientHeight + 1;
    toggle.addEventListener("click", () => {
      state.leadExpanded = !state.leadExpanded;
      lead.classList.toggle("is-expanded", state.leadExpanded);
      toggle.textContent = state.leadExpanded ? "Less" : "More";
    });
  }
  const container = document.createElement("div");
  container.className = "structured-view";
  artifact.appendChild(container);
  await renderEntity(container, entity, { ...viewContext(path, state), renderMarkdown: (source, basePath = null) => renderText("document.md", source, markdownOptions(basePath)) });
  endRebuild(memory);
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
  const source = data.kind === "source";
  const structured = Boolean(data.kind) && !source;
  const documentCard = source
    ? `<section class="document-card source-card"><ol class="source-lines">${data.content.replace(/\n$/, "").split(/\r?\n/).map((line) => `<li><code>${escapeHtml(line) || " "}</code></li>`).join("")}</ol></section>`
    : structured || data.path.toLowerCase().endsWith(".puml")
      ? ""
      : `<section class="document-card"><div class="document-content">${renderText(data.path, data.content, markdownOptions(data.path))}</div></section>`;
  const state = viewState(data.path);
  const memory = beginRebuild(path);
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
    endRebuild(memory);
    return;
  }
  for (const diagram of data.diagrams) {
    const section = diagramCard(diagram);
    artifact.appendChild(section);
    await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
  }
  endRebuild(memory);
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
      const { anchor, ...rest } = options;
      pendingAnchor = anchor ? { path: artifactPath, anchor } : null;
      openRef(artifactPath, rest);
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
  setProjectLabel(workspaceIdentity(data), data.projectRoot);
  setSidebarCollapsed(readSidebarPreference(), { remember: false });
  sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed")));
  tabs.addEventListener("scroll", updateTabFades, { passive: true });
  window.addEventListener("resize", updateTabFades);
  let sectionFrame = 0;
  workspace.addEventListener("scroll", () => {
    if (!rebuilding && renderedPath && renderedPath === selectedPath) scrollPositions.set(renderedPath, workspace.scrollTop);
    cancelAnimationFrame(sectionFrame);
    sectionFrame = requestAnimationFrame(() => markCurrentSection(artifact, workspace.getBoundingClientRect().top));
  }, { passive: true });
  projectButton.addEventListener("click", () => setProjectMenu(projectMenu.hidden));
  document.addEventListener("click", (event) => {
    if (!projectMenu.hidden && !event.target.closest("#project-switcher")) setProjectMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !projectMenu.hidden) {
      setProjectMenu(false);
      projectButton.focus();
    }
  });
  void refreshProjects();
  setInterval(refreshProjects, 5000);
  availableArtifacts = new Set([...data.artifacts, ...(data.sources ?? [])]);
  navigation = data.navigation;
  palette = createPalette({
    dialog: document.getElementById("palette"),
    input: document.getElementById("palette-input"),
    results: document.getElementById("palette-results"),
    entries: paletteEntries,
    search: async (query) => (await fetchJson(`./api/search?q=${encodeURIComponent(query)}`)).results,
    onOpen: (ref, { find, ...options }) => {
      pendingFind = find ? { path: ref, text: find } : null;
      openRef(ref, options);
    }
  });
  linkPreview = createLinkPreview({
    root: workspace,
    fetchJson,
    renderMarkdown: (path, content) => renderText(path, content, markdownOptions(path)),
    kindLabel: (kind) => KIND_LABELS[kind] ?? "Structured record",
    currentPath: () => selectedPath
  });
  document.getElementById("jump").addEventListener("click", () => palette.show());
  document.getElementById("evidence-close").addEventListener("click", closeEvidence);
  artifact.addEventListener("click", (event) => {
    const crumb = event.target.closest("[data-crumb]");
    if (crumb) {
      openRef(crumb.dataset.crumb, { keep: event.ctrlKey || event.metaKey });
      return;
    }
    // Markdown links to repository files open as review tabs, and anchors scroll within the document they name.
    const docLink = event.target.closest("a[data-doc-link], a[data-doc-anchor]");
    if (!docLink || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = docLink.dataset.docLink;
    const anchor = docLink.dataset.docAnchor;
    if (!target || target === selectedPath) {
      if (!scrollToAnchor(anchor)) showToast(`No heading #${anchor} in this document.`);
      else if (docLink.closest(".doc-toc")) {
        requestAnimationFrame(() => {
          for (const link of docLink.closest(".doc-toc").querySelectorAll("a")) link.toggleAttribute("aria-current", link === docLink);
          docLink.setAttribute("aria-current", "location");
        });
      }
      return;
    }
    pendingAnchor = anchor ? { path: target, anchor } : null;
    openRef(target, { keep: event.ctrlKey || event.metaKey });
  });
  artifact.addEventListener("dblclick", (event) => {
    const docLink = event.target.closest("a[data-doc-link]");
    if (docLink) openRef(docLink.dataset.docLink, { keep: true });
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
    } else if (event.key === "[" && !typing && !palette.isOpen() && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed"));
    } else if (event.key === "Escape" && !palette.isOpen() && !document.getElementById("evidence-drawer").hidden) {
      closeEvidence();
    } else if (event.key === "Escape" && !palette.isOpen() && selectedPath && viewState(selectedPath).maximized) {
      setMaximized(selectedPath, null);
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
      const refreshed = await fetch("./api/index", { cache: "no-store" }).catch(() => null);
      reportRefresh(Boolean(refreshed?.ok));
      if (refreshed?.ok) {
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
