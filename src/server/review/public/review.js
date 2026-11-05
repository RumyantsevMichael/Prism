import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, renderEntity } from "./views/entities.js";
import { createPalette } from "./views/palette.js";
import { highlight, highlightLines, languageOf } from "./views/highlight.js";
import { anchorTarget, decorateDocuments, HEADING_PREFIX, LINE_RANGE, markCurrentSection, renderText, revealInDocument } from "./views/markdown.js";
import { createLinkPreview } from "./views/preview.js";
import { createSidePanel } from "./views/side-panel.js";
import { createIndexingStatus } from "./views/indexing.js";
import { createRecordStoreStatus } from "./views/record-store.js";
import { connectionState, recordProbe, STOPPED_MESSAGE } from "./views/connection.js";
import { badgedIcon, notificationText, shouldNotify, signalTitle } from "./views/attention-signal.js";
import { missingNotice, nextMissingTabs, renderMissing } from "./views/missing-tab.js";

const project = document.getElementById("project");
const artifacts = document.getElementById("artifacts");
const navPlaces = document.getElementById("nav-places");
const navLibrary = document.getElementById("nav-library");
const workspace = document.getElementById("workspace");
const appShell = document.getElementById("app-shell");
const sidebarToggle = document.getElementById("sidebar-toggle");
const connectionBanner = document.getElementById("connection");
const appGoneBanner = document.getElementById("app-gone");
const privateServerBanner = document.getElementById("private-server");
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
// A tab that reconnects to an app of another plugin version reloads, so it never runs old page code against a newer app.
let appVersion = null;
let sessionConnected = false;
let sessionStream;
let saveQueue = Promise.resolve();
let lastSnapshot = "";
// The path whose view the workspace shows, and each open tab's scroll position, so a refresh or a tab switch keeps the reader's place.
let renderedPath = null;
let rebuilding = false;
const scrollPositions = new Map();
let probes = { failures: 0, failingSince: null };
// Live, retrying, or stopped: a stopped tab keeps checking, and it returns to live when the same app or a handed-off successor answers.
let connection = "live";
// A link to a heading in another document scrolls there once that document has rendered.
let pendingAnchor = null;
// A text match chosen in the palette is highlighted once its document has rendered.
let pendingFind = null;
let toastTimer;
let availableArtifacts = new Set();
// Open tabs whose file was moved or deleted, or whose entity no longer resolves, as the server's snapshot reports them.
let missingTabs = new Set();
let navigation = { attention: {}, glossary: {}, diagnostics: [], index: [] };
let currentContext = null;
let contextSnapshot = "";
let palette;
let linkPreview;
let sidePanel;
let panelPreview;
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
    <img class="welcome-mark" src="./prism-mark.svg" alt="" aria-hidden="true">
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
    const isMissing = missingTabs.has(path);
    const tab = document.createElement("div");
    tab.className = `artifact-tab${isPreview ? " is-preview" : ""}${isAgent ? " is-agent" : ""}${isMissing ? " is-missing" : ""}`;
    tab.setAttribute("role", "presentation");
    const select = document.createElement("button");
    select.className = "artifact-tab-select";
    select.type = "button";
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(path === selectedPath));
    select.title = [isMissing ? missingNotice(path, { entity: Boolean(parseEntityRef(path)), label: tabLabel(path) }).tooltip : path, isPreview ? "Preview tab: the next link replaces it. Double-click to keep it open." : "", isAgent ? "Presented by the agent." : ""].filter(Boolean).join("\n");
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
    if (isMissing) select.appendChild(element("span", "sr-only", ", no longer exists"));
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
  if (!path || !requireApp()) {
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
  if (previewTab !== path || !requireApp()) {
    return;
  }
  previewTab = null;
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}

function closeTab(path) {
  if (!requireApp()) return;
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
  if (typeof snapshot.appVersion === "string" && appVersion !== null && snapshot.appVersion !== appVersion) {
    location.reload();
    return;
  }
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

// A project reads as repository / branch; a server that names no workspace shows its folder.
function workspaceIdentity(entry) {
  return entry.workspace ?? { repository: folderName(entry.projectRoot), worktree: null, branch: null, detached: false };
}

// Mirrors workspaceName in workspace-identity.mjs: the branch names a checkout, because a worktree folder is often a generated name.
function workspaceName(identity) {
  if (identity.branch) return identity.detached ? `detached ${identity.branch}` : identity.branch;
  return identity.worktree;
}

// A checkout of a workspace leads with the workspace's name, because the records it shows belong to the whole workspace.
function projectLabel(identity, workspace = null) {
  const label = element("span", "project-label-text");
  if (workspace) label.append(element("span", "project-workspace", workspace), element("span", "project-separator is-workspace", "·"));
  label.append(element("span", "project-repository", identity.repository));
  const name = workspaceName(identity);
  if (name) label.append(element("span", "project-separator", "/"), element("span", "project-worktree", name));
  return label;
}

function projectTitle(identity, projectRoot) {
  return [projectRoot, identity.branch ? `${identity.detached ? "Detached at" : "Branch:"} ${identity.branch}` : "", identity.worktree ? `Worktree: ${identity.worktree}` : ""].filter(Boolean).join("\n");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Checkouts that resolve their records to one store share them, across repositories too; a checkout with records of its own is its own project.
// A remote store that cannot be cloned right now still groups by its address, so an outage does not scatter its workspace.
function sharedStore(entry) {
  const store = entry.store;
  if (!store || store.kind === "project") return null;
  if (store.location) return `store:${store.location}`;
  return store.kind === "remote" && store.label ? `remote:${store.label}` : null;
}

// A workspace takes the name kept in its store when one is set.
// Otherwise it is named after its store: a folder store by its folder, because each checkout may spell the configured path differently,
// and a remote store by its repository, so the name reads as a name rather than an address.
function storeName(store) {
  if (store.workspaceName) return store.workspaceName;
  if (store.kind === "folder" && store.location) return folderName(store.location);
  if (store.kind === "remote" && store.label) return store.label.replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean).pop()?.replace(/\.git$/i, "") || store.label;
  return store.label ?? "records";
}

// Only a store that other checkouts can share makes a workspace; a checkout's own records do not.
function workspaceOf(store) {
  return store && store.kind !== "project" ? storeName(store) : null;
}

function storeKey(entry) {
  return sharedStore(entry) ?? `project:${entry.id}`;
}

// Entries keep one order, by name, so a sync that changes recency or liveness never moves an entry under the pointer.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareMembers(left, right) {
  const key = ({ entry, identity }) => [identity.repository ?? "", workspaceName(identity) ?? folderName(entry.projectRoot), entry.projectRoot];
  const a = key(left);
  const b = key(right);
  for (let index = 0; index < a.length; index += 1) {
    const order = collator.compare(a[index], b[index]) || (a[index] < b[index] ? -1 : a[index] > b[index] ? 1 : 0);
    if (order) return order;
  }
  return 0;
}

function projectEntry({ entry, identity }, current, { gates: showGates = true, repository = false } = {}) {
  const link = element("a", `project-entry${showGates ? "" : " project-checkout"}`);
  link.dataset.project = entry.id;
  link.href = entry.url;
  link.title = projectTitle(identity, entry.projectRoot);
  if (entry.id === current) link.setAttribute("aria-current", "page");
  const liveMark = element("span", `project-entry-live${entry.live ? " live" : ""}`);
  liveMark.title = entry.live ? "An agent session is using this project" : "Recently used";
  const checkout = workspaceName(identity) ?? folderName(entry.projectRoot);
  const name = element("span", "project-entry-name");
  // A workspace can hold several repositories, so its rows name the repository as well as the checkout.
  if (repository && identity.repository) name.append(element("span", "project-entry-repository", identity.repository), element("span", "project-separator", "/"));
  name.append(element("span", "project-entry-checkout", checkout));
  // Only a running or failed build is marked, because the status bar covers the open project's other states.
  if (entry.indexing === "preparing" || entry.indexing === "failed") {
    const indexing = element("span", `project-entry-indexing ${entry.indexing}`);
    indexing.title = entry.indexing === "preparing" ? "Indexing the repository" : "The last index build failed";
    name.append(indexing);
  }
  link.append(liveMark, name);
  if (showGates) {
    const gates = element("span", `project-entry-gates${entry.gates ? "" : " none"}`, entry.gates === null ? "?" : String(entry.gates));
    gates.title = entry.gates === null ? "The project's folder or records cannot be read" : `${entry.gates} open ${entry.gates === 1 ? "gate" : "gates"}`;
    link.append(gates);
  }
  link.append(element("span", "project-entry-root", entry.projectRoot));
  return link;
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
  // Checkouts that share a record store share their gates, so each store counts once.
  const current = listing.projects.find((entry) => entry.id === listing.current);
  const counted = new Set([current ? storeKey(current) : null]);
  let waiting = 0;
  for (const entry of listing.projects) {
    if (counted.has(storeKey(entry))) continue;
    counted.add(storeKey(entry));
    waiting += entry.gates ?? 0;
  }
  projectGates.hidden = waiting === 0;
  projectGates.textContent = String(waiting);
  projectGates.title = `${waiting} open ${waiting === 1 ? "gate" : "gates"} in other projects`;
  // An unchanged list is left alone, and a rebuilt one keeps keyboard focus on the same project.
  // The server lists projects by recency, so the comparison ignores order and a sync that only reorders them leaves the menu alone.
  const text = JSON.stringify({ ...listing, projects: [...listing.projects].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) });
  if (text === projectListing) return;
  projectListing = text;
  const focused = document.activeElement?.closest?.(".project-entry")?.dataset.project;
  if (current) setProjectLabel(workspaceIdentity(current), current.projectRoot, current.store);
  // Checkouts that share one record store form one workspace, whichever repositories they belong to: its records and gates show once, and each checkout stays reachable for its code.
  // Every other checkout is listed under its repository, even a repository with one checkout.
  // Workspaces come first, then repositories, each in name order.
  const workspaces = new Map();
  const repositories = new Map();
  for (const entry of listing.projects) {
    const member = { entry, identity: workspaceIdentity(entry) };
    const shared = sharedStore(entry);
    const groups = shared ? workspaces : repositories;
    const key = shared ?? member.identity.repository ?? folderName(entry.projectRoot);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(member);
  }
  const items = [];
  const workspaceList = [...workspaces.values()].map((members) => members.sort(compareMembers));
  workspaceList.sort((left, right) => collator.compare(storeName(left[0].entry.store), storeName(right[0].entry.store)) || compareMembers(left[0], right[0]));
  for (const members of workspaceList) {
    const shared = members[0].entry;
    const gates = Math.max(...members.map(({ entry }) => entry.gates ?? 0));
    const repositoryCount = new Set(members.map(({ identity }) => identity.repository)).size;
    const item = element("li", "project-cluster");
    // Choosing the workspace opens its records through the checkout already open, else one an agent is using, else the one used last.
    // Every checkout shows the same records, so only code views, such as source files and the index, differ between them.
    const opened = members.find(({ entry }) => entry.id === listing.current) ?? members.find(({ entry }) => entry.live) ?? listing.projects.map((entry) => members.find((member) => member.entry === entry)).find(Boolean);
    const head = element("a", "project-cluster-head");
    head.href = opened.entry.url;
    head.dataset.project = `workspace:${opened.entry.id}`;
    if (opened.entry.id === listing.current) head.setAttribute("aria-current", "true");
    const holders = `${members.length} ${members.length === 1 ? "checkout" : "checkouts"}${repositoryCount > 1 ? ` of ${repositoryCount} repositories` : ""}`;
    head.title = `Workspace ${storeName(shared.store)}: ${holders} keep their records in ${shared.store.location ?? shared.store.label}, so their roadmap, initiatives, and gates are the same.\nOpens through ${[opened.identity.repository, workspaceName(opened.identity)].filter(Boolean).join("/")}.`;
    const badge = element("span", `project-entry-gates${gates ? "" : " none"}`, String(gates));
    badge.title = `${gates} open ${gates === 1 ? "gate" : "gates"}`;
    head.append(element("span", "store-icon"), element("span", "project-cluster-name", storeName(shared.store)), badge);
    const checkouts = element("ul", "project-checkouts");
    for (const member of members) {
      const row = element("li");
      row.append(projectEntry(member, listing.current, { gates: false, repository: true }));
      checkouts.append(row);
    }
    item.append(head, checkouts);
    items.push(item);
  }
  for (const [repository, members] of [...repositories].sort(([left], [right]) => collator.compare(left, right))) {
    items.push(element("li", "project-group", repository));
    for (const member of members.sort(compareMembers)) {
      const item = element("li");
      item.append(projectEntry(member, listing.current));
      items.push(item);
    }
  }
  projectList.replaceChildren(...items);
  if (focused) projectList.querySelector(`[data-project="${focused}"]`)?.focus();
}

function setProjectLabel(identity, projectRoot, store = null) {
  const workspace = workspaceOf(store);
  project.replaceChildren(projectLabel(identity, workspace));
  projectButton.title = [workspace ? `Workspace: ${workspace}` : "", projectTitle(identity, projectRoot)].filter(Boolean).join("\n");
  signals.project = [workspace, [identity.repository ?? folderName(projectRoot), workspaceName(identity)].filter(Boolean).join("/")].filter(Boolean).join(" · ");
  document.title = signalTitle(baseTitle(), signals.count ?? 0);
}

const baseTitle = () => signals.project ? `${signals.project} · Prism` : "Prism review";

// The tab title, the tab icon, and an installed app's badge count the recorded questions, so a waiting question shows in a background tab.
const signals = { project: null, count: null, icon: document.querySelector('link[rel="icon"]'), plainIcon: null, badged: null };
signals.plainIcon = signals.icon?.getAttribute("href") ?? null;

async function updateAttentionSignals(count) {
  const previous = signals.count;
  signals.count = count;
  document.title = signalTitle(baseTitle(), count);
  if (signals.icon && signals.plainIcon) {
    if (count > 0) {
      signals.badged ??= await fetch(signals.plainIcon).then((response) => response.ok ? response.text() : null).then((svg) => svg && `data:image/svg+xml,${encodeURIComponent(badgedIcon(svg))}`).catch(() => null);
      if (signals.badged && signals.count > 0) signals.icon.setAttribute("href", signals.badged);
    } else {
      signals.icon.setAttribute("href", signals.plainIcon);
    }
  }
  if (navigator.setAppBadge) void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
  const permission = typeof Notification === "undefined" ? null : Notification.permission;
  if (!shouldNotify({ previous, count, permission, visible: document.visibilityState === "visible" && document.hasFocus() })) return;
  const text = notificationText(count, signals.project ?? "this project");
  try {
    const notification = new Notification(text.title, { body: text.body, tag: `prism-attention-${signals.project}` });
    notification.addEventListener("click", () => {
      window.focus();
      openRef("attention");
      notification.close();
    });
  } catch {
    // A browser that allows the permission but not page notifications, such as some mobile browsers, keeps the title and icon only.
  }
}

const SIDEBAR_KEY = "prism.review.sidebar";

// Without a remembered choice the sidebar starts collapsed on narrow screens, where it would stack above the artifact.
function readSidebarPreference() {
  let stored = null;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY);
  } catch {
  }
  return stored ? stored === "collapsed" : window.matchMedia("(max-width: 800px)").matches;
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
    reportRefresh(true);
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

// A short outage shows the retrying banner; one that outlasts the grace period shows the stopped banner, and any answer clears both.
function reportRefresh(ok) {
  probes = recordProbe(probes, ok, Date.now());
  const next = connectionState({ ...probes, now: Date.now(), streamOpen: sessionStream?.readyState === EventSource.OPEN });
  if (next === connection) return;
  const recovered = connection === "stopped" && next === "live";
  connection = next;
  connectionBanner.hidden = next !== "retrying";
  appGoneBanner.hidden = next !== "stopped";
  if (!recovered) return;
  // A stream that met another listener on the port gave up, so a returning app needs a new one; the next poll redraws the open view.
  if (sessionStream?.readyState === EventSource.CLOSED) connectSessionEvents();
  lastSnapshot = "";
  void refreshProjects();
}

// A session that could not reach the shared app serves this page itself, so the page says why another link may show the same project.
function showPrivateServer(privateServer) {
  if (!privateServer) return;
  document.getElementById("private-server-reason").textContent = privateServer.reason ? `Reason: ${privateServer.reason}` : "";
  document.getElementById("private-server-dismiss").addEventListener("click", () => { privateServerBanner.hidden = true; }, { once: true });
  privateServerBanner.hidden = false;
}

// Actions that need the server explain why they cannot run while the app is stopped instead of failing silently.
function requireApp() {
  if (connection !== "stopped") return true;
  showToast(STOPPED_MESSAGE);
  return false;
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

// The PlantUML runtime draws one diagram at a time, so previews, the side panel, and the open tab take turns.
let plantUmlQueue = Promise.resolve();

function drawPlantUml(source) {
  const drawn = plantUmlQueue.then(() => new Promise((resolve) => {
    renderToString(source.split(/\r?\n/), (svg) => {
      // The page's style policy refuses inline style attributes, so the stylesheet sets PlantUML's preserved text spacing instead.
      // The runtime still sets that attribute once while it renders, and the browser logs that refusal.
      resolve(svg.includes("Syntax Error") ? { error: "PlantUML reported a syntax error." } : { svg: svg.replace(/ style="white-space: ?pre;?"/g, "") });
    }, (message) => resolve({ error: String(message) }), { maxSvgSize: 8192 });
  }));
  plantUmlQueue = drawn.catch(() => {});
  return drawn;
}

async function renderDiagram(source, target, section, { fit = false } = {}) {
  const drawn = await drawPlantUml(source);
  if (drawn.error) {
    target.innerHTML = `<p class="error">${escapeHtml(drawn.error)}</p>`;
    return;
  }
  target.innerHTML = drawn.svg;
  configureDiagram(section, source);
  // A narrow place, such as the side panel, starts the diagram at the width it has, and the zoom buttons still reach every size.
  if (fit) {
    const room = target.clientWidth - 2 * Number.parseFloat(getComputedStyle(target).paddingLeft || "0");
    const natural = Number(section.dataset.naturalWidth);
    if (room > 0 && natural > room) setDiagramScale(section, room / natural);
  }
}

// A compact card leaves the name to its container, such as the side panel, whose header already names the file.
function diagramCard(diagram, { compact = false } = {}) {
  const section = document.createElement("section");
  section.className = `diagram-card${compact ? " is-compact" : ""}`;
  section.innerHTML = `
    <header class="diagram-header">
      ${compact ? "" : `<div class="diagram-title">
        <p class="eyebrow">PlantUML diagram</p>
        <h2 title="${escapeHtml(diagram.path)}">${escapeHtml(diagram.path)}</h2>
      </div>`}
      <div class="diagram-tools" aria-label="Diagram controls">
        <button class="tool-button" data-action="zoom-out" type="button" aria-label="Zoom out">−</button>
        <button class="tool-button" data-action="reset" data-scale-label type="button" aria-label="Reset zoom">100%</button>
        <button class="tool-button" data-action="zoom-in" type="button" aria-label="Zoom in">+</button>
        <button class="tool-button" data-action="source" type="button" aria-label="Show source" aria-expanded="false">Show source</button>
        <button class="tool-button" data-action="copy" type="button" aria-label="Copy PlantUML source">Copy</button>
      </div>
    </header>
    <div class="diagram-output"><p class="rendering">Rendering diagram</p></div>
    <div class="source-panel" hidden><pre><code>${highlight(diagram.source, "plantuml")}</code></pre></div>`;
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
  void updateAttentionSignals(attention.gates ?? 0);
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
  revealInDocument(target);
  // A line range stays marked in the source view, so the reader sees which lines a link meant.
  const range = anchor.match(LINE_RANGE);
  artifact.querySelectorAll(".source-lines li.in-range").forEach((line) => line.classList.remove("in-range"));
  if (range?.[2]) {
    for (let line = target; line && Number(line.id.slice(HEADING_PREFIX.length + 1)) <= Number(range[2]); line = line.nextElementSibling) line.classList.add("in-range");
  }
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
    revealInDocument(node.parentElement);
    range.surroundContents(mark);
    workspace.scrollTop += mark.getBoundingClientRect().top - workspace.getBoundingClientRect().top - workspace.clientHeight / 3;
    return true;
  }
  return false;
}

// Chips are one line, so a label cut off by its ellipsis gets its full text as a tooltip.
const CHIPS = ".status-pill, .meta-pill, .relation-chip, .link-chip, .claim-chip, .readiness-jump, .type-badge, .code-span-chip, .component-chip";

function titleClippedChips(root) {
  for (const chip of root.querySelectorAll(CHIPS)) {
    if (chip.title) continue;
    const clipped = [chip, ...chip.querySelectorAll("*")].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible");
    if (clipped) chip.title = chip.textContent.trim().replace(/\s+/g, " ");
  }
}

function endRebuild(memory) {
  rebuilding = false;
  if (memory.path !== selectedPath) {
    artifact.style.minHeight = "";
    return;
  }
  const state = viewState(memory.path);
  state.folds ??= new Map();
  decorateDocuments(artifact, state.folds);
  decorateMaximize(memory.path);
  requestAnimationFrame(() => titleClippedChips(artifact));
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

// A tab whose file or entity is gone shows a short page with a button that closes it; the next refresh restores a target that comes back.
function showMissing(path) {
  if (!missingTabs.has(path)) {
    missingTabs.add(path);
    renderTabs();
  }
  if (lastSnapshot === `missing:${path}` || path !== selectedPath) return;
  lastSnapshot = `missing:${path}`;
  renderedPath = null;
  document.body.classList.remove("has-maximized");
  renderMissing(artifact, path, { entity: Boolean(parseEntityRef(path)), label: tabLabel(path), onClose: () => closeTab(path) });
}

function updateMissingTabs(reported) {
  const { next, changed } = nextMissingTabs(missingTabs, reported);
  missingTabs = next;
  if (changed) renderTabs();
}

async function showEntity(path) {
  const response = await fetch(`./api/entity?ref=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (response.status === 404) {
    showMissing(path);
    return;
  }
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
  if (response.status === 404) {
    showMissing(path);
    return;
  }
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
    ? `<section class="document-card source-card"><ol class="source-lines">${highlightLines(data.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(data.path)).map((line, index) => `<li id="${HEADING_PREFIX}L${index + 1}"><code>${line || " "}</code></li>`).join("")}</ol></section>`
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
  "change-map": "Change map",
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
  if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
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
    // A view embeds a PlantUML file as the same diagram card that opening the file shows.
    async mountDiagram(target, diagramPath) {
      const data = await fetchJson(`./api/artifact?path=${encodeURIComponent(diagramPath)}`);
      for (const diagram of data.diagrams ?? []) {
        const section = diagramCard(diagram);
        target.appendChild(section);
        await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
      }
    },
    // A gate answer is the gate's answer action, applied against the revision its listing shows.
    async answerGate({ initiative, id, choice, note }) {
      if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
      const target = `gate:${initiative}/${id}`;
      const unanswered = () => {
        throw new Error("The review app did not answer, so the answer was not recorded. Try again in a moment.");
      };
      const listed = await fetch(`./api/actions?target=${encodeURIComponent(target)}`).catch(unanswered);
      const listing = await listed.json().catch(() => ({}));
      if (!listed.ok) throw Object.assign(new Error(listing.message ?? "The answer was not recorded."), { code: listing.code === "unknown_target" ? "unknown_gate" : listing.code });
      const action = (listing.actions ?? []).find((item) => item.id === "gate.answer");
      const names = new Set((action?.fields ?? []).map((field) => field.name));
      const input = Object.fromEntries([["choice", choice], ["note", note]].filter(([name, value]) => names.has(name) && value !== null && value !== undefined && value !== ""));
      const response = await fetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "gate.answer", target, input, revision: action?.revision ?? null }) }).catch(unanswered);
      const result = await response.json().catch(() => ({ message: "The server returned an unreadable response." }));
      if (!response.ok) {
        // The answer form names an answered or withdrawn question as it always has.
        const code = result.code === "action_unavailable" ? "gate_answered" : result.code === "unknown_target" ? "unknown_gate" : result.code;
        throw Object.assign(new Error(result.message ?? "The answer was not recorded."), { code });
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

let recordStoreStatus = null;

// The record store and its sync live in the status bar: where records live, and the sync state, which opens details with every saved conflict.
function renderStoreSync(data) {
  recordStoreStatus?.update(data.recordStore, data.storeSync);
}

async function initialize() {
  const data = await fetchJson("./api/index");
  recordStoreStatus = createRecordStoreStatus({
    storeButton: document.getElementById("store-status"),
    storeLabel: document.getElementById("store-status-label"),
    syncButton: document.getElementById("store-sync"),
    syncLabel: document.getElementById("store-sync-label"),
    dialog: document.getElementById("store-dialog"),
    fetchJson,
    openRecord: (path) => openRef(path),
    hasArtifact: (path) => availableArtifacts.has(path)
  });
  renderStoreSync(data);
  openTabs = data.openTabs;
  previewTab = openTabs.includes(data.previewTab) ? data.previewTab : null;
  agentTabs = (data.agentTabs ?? []).filter((tab) => openTabs.includes(tab));
  sessionRevision = Number.isInteger(data.revision) ? data.revision : 0;
  sessionInstance = typeof data.instance === "string" ? data.instance : null;
  appVersion = typeof data.appVersion === "string" ? data.appVersion : null;
  const requestedPath = selectedPath;
  selectedPath = Object.hasOwn(data, "activeTab") ? data.activeTab : null;
  setProjectLabel(workspaceIdentity(data), data.projectRoot, data.recordStore);
  showPrivateServer(data.privateServer);
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
  createIndexingStatus({
    root: document.getElementById("indexing"),
    button: document.getElementById("indexing-button"),
    label: document.getElementById("indexing-label"),
    detail: document.getElementById("indexing-detail"),
    meter: document.getElementById("indexing-meter"),
    panel: document.getElementById("indexing-panel"),
    fetchJson
  });
  availableArtifacts = new Set([...data.artifacts, ...(data.sources ?? [])]);
  missingTabs = new Set(data.missingTabs ?? []);
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
  sidePanel = createSidePanel({
    shell: appShell,
    fetchJson,
    renderMarkdown: (path, content) => renderText(path, content, markdownOptions(path)),
    // The panel draws a diagram as the same card its tab shows, without the name its header already gives, and fitted to the panel's width.
    mountDiagram: async (target, diagram) => {
      const section = diagramCard(diagram, { compact: true });
      target.appendChild(section);
      await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section, { fit: true });
    },
    onOpenTab: (ref, anchor) => {
      pendingAnchor = anchor ? { path: ref, anchor } : null;
      // The file moves into its tab, so the panel closes rather than showing it twice.
      sidePanel.close();
      if (ref === selectedPath && anchor) scrollToAnchor(anchor);
      else openRef(ref, { keep: true });
    }
  });
  const showInPanel = (ref, anchor) => sidePanel.showFile(ref, anchor);
  linkPreview = createLinkPreview({
    root: workspace,
    fetchJson,
    renderMarkdown: (path, content) => renderText(path, content, markdownOptions(path)),
    kindLabel: (kind) => KIND_LABELS[kind] ?? "Structured record",
    drawDiagram: drawPlantUml,
    currentPath: () => selectedPath,
    onShowInPanel: showInPanel
  });
  // Links inside the panel preview too, and a followed link replaces the panel's file, since the panel holds one item.
  panelPreview = createLinkPreview({
    root: sidePanel.body,
    fetchJson,
    renderMarkdown: (path, content) => renderText(path, content, markdownOptions(path)),
    kindLabel: (kind) => KIND_LABELS[kind] ?? "Structured record",
    drawDiagram: drawPlantUml,
    currentPath: () => sidePanel.current()?.ref ?? null,
    onShowInPanel: showInPanel
  });
  sidePanel.body.addEventListener("click", (event) => {
    const docLink = event.target.closest("a[data-doc-link], a[data-doc-anchor]");
    if (!docLink) return;
    event.preventDefault();
    const target = docLink.dataset.docLink ?? sidePanel.current()?.ref;
    const anchor = docLink.dataset.docAnchor ?? null;
    if (!target) return;
    if (event.ctrlKey || event.metaKey) {
      pendingAnchor = anchor ? { path: target, anchor } : null;
      openRef(target, { keep: true });
    } else {
      sidePanel.showFile(target, anchor);
    }
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
    // Alt+click shows a linked file in the side panel and keeps the current tab.
    if (docLink?.dataset.docLink && event.altKey) {
      event.preventDefault();
      sidePanel.showFile(docLink.dataset.docLink, docLink.dataset.docAnchor ?? null);
      return;
    }
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
    } else if (event.key === "Escape" && !palette.isOpen() && sidePanel.isOpen() && !document.querySelector(".link-preview:not([hidden]), dialog[open]")) {
      sidePanel.close();
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
        renderStoreSync(snapshot);
        availableArtifacts = new Set([...snapshot.artifacts, ...(snapshot.sources ?? [])]);
        updateMissingTabs(snapshot.missingTabs);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          navigation = snapshot.navigation;
          renderNavigation();
          renderTabs();
        }
        if (!sessionConnected) {
          synchronizeSession(snapshot);
        }
        // A failed probe leaves the open view as it is rather than replacing it with an error.
        if (sidePanel.isOpen()) void sidePanel.refresh();
        if (selectedPath) {
          await showArtifact(selectedPath);
        }
      }
    } catch {
    }
  }, 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<div class="document-card"><p class="error">${escapeHtml(error.message)}</p></div>`;
});
