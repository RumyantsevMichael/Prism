import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, recordKind, recordLabel, renderEntity } from "./views/entities.js";
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
import { createPageBar } from "./views/page-bar.js";
import { claimElement, createClaimIndex } from "./views/claim-index.js";
import { createPresence } from "./views/presence.js";
import { DENSITIES, savePreferences, THEMES } from "./kit/preferences.js";
import { shownActionEntries } from "./views/actions.js";
import { themeDiagram } from "./kit/diagram-theme.js";

const project = document.getElementById("project");
const navRoot = document.getElementById("nav");
const sidebar = document.getElementById("sidebar");
const navPlaces = document.getElementById("nav-places");
const navScope = document.getElementById("nav-scope");
const navLibrary = document.getElementById("nav-library");
const navDrawer = document.getElementById("nav-drawer");
const workspace = document.getElementById("workspace");
const appShell = document.getElementById("shell-body");
const connectionBanner = document.getElementById("connection");
const appGoneBanner = document.getElementById("app-gone");
const privateServerBanner = document.getElementById("private-server");
const artifact = document.getElementById("artifact");
const toast = document.getElementById("toast");
const projectButton = document.getElementById("project-button");
const projectMenu = document.getElementById("project-menu");
const projectGates = document.getElementById("project-gates");
const noticeBanner = document.getElementById("notice");
// The latest notice per presenting project; a notice only links, and the page changes project only when the user follows it.
const notices = new Map();
let projectListing = "";
let selectedPath = new URLSearchParams(location.search).get("artifact");
// The server keeps the pages a session has open for the agent: the one shown, one preview page that ordinary navigation replaces, and the pages an agent presented.
let openTabs = [];
let previewTab = null;
let agentTabs = [];
let sessionRevision = 0;
// A replaced review app restarts revisions, so a snapshot from a new instance is accepted whatever its revision.
let sessionInstance = null;
// A page that reconnects to an app of another plugin version reloads, so it never runs old page code against a newer app.
let appVersion = null;
let sessionConnected = false;
let sessionStream;
let saveQueue = Promise.resolve();
let lastSnapshot = "";
// The path whose view the workspace shows, and each visited page's scroll position, so a refresh or a return keeps the reader's place.
let renderedPath = null;
let rebuilding = false;
const scrollPositions = new Map();
let probes = { failures: 0, failingSince: null };
// Live, retrying, or stopped: a stopped page keeps checking, and it returns to live when the same app or a handed-off successor answers.
let connection = "live";
// A link to a heading in another document scrolls there once that document has rendered.
let pendingAnchor = null;
// A text match chosen in the palette is highlighted once its document has rendered.
let pendingFind = null;
let availableArtifacts = new Set();
// Prism's own records and documents, which are named by title and kind; every other repository file is named by its path.
let prismRecords = new Set();
// Open pages whose file was moved or deleted, or whose entity no longer resolves, as the server's snapshot reports them.
let missingTabs = new Set();
let navigation = { attention: {}, glossary: {}, diagnostics: [], index: [], initiatives: [] };
let currentContext = null;
let contextSnapshot = "";
let palette;
let linkPreview;
let sidePanel;
let panelPreview;
let pageBar;
let claimIndex;
let presence;
const viewStates = new Map();
const treeToggles = new Map();

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function welcome() {
  renderedPath = null;
  document.body.classList.remove("has-maximized");
  const empty = document.createElement("prism-empty-state");
  empty.className = "welcome";
  empty.setAttribute("heading", "Nothing is open");
  empty.append(element("p", "", "Choose Attention, the roadmap, or a library section, or press Ctrl K to jump."));
  artifact.replaceChildren(empty);
  setBusy(false);
}

// The pages this browser tab visited sit in the browser's own history, each entry numbered, so Back and Forward know whether there is a page to go to.
const HISTORY_KEY = "prism.review.history";
const pages = { index: 0, top: 0 };

// The highest page the tab may move forward to is kept for this tab, with the page it was on when the tab last left the app.
function readHistoryTop() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "null");
    return { top: Number(stored?.top) || 0, left: Number.isInteger(stored?.left) ? stored.left : null };
  } catch {
    return { top: 0, left: null };
  }
}

function storeHistoryTop(left = null) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify({ top: pages.top, left }));
  } catch {
  }
}

// When the browser lists this tab's entries, the app's own pages after the current one are exactly the pages Forward can reach.
function forwardEntries() {
  const entries = window.navigation?.entries?.();
  const current = window.navigation?.currentEntry;
  if (!Array.isArray(entries) || !current || !Number.isInteger(current.index) || current.index < 0) return null;
  return entries.length - 1 - current.index;
}

// The browser drops the pages after the current one when the tab opens another page from it, so a tab that left the app may move forward only to the page it left from, unless it only reloaded.
function settleHistoryTop(index, stored) {
  const ahead = forwardEntries();
  if (ahead !== null) return index + ahead;
  const reloaded = performance.getEntriesByType?.("navigation")?.[0]?.type === "reload";
  if (reloaded || stored.left === null) return Math.max(index, stored.top);
  return Math.max(index, Math.min(stored.top, stored.left));
}

function startHistory() {
  const index = history.state?.index;
  if (Number.isInteger(index)) {
    pages.index = index;
    pages.top = settleHistoryTop(index, readHistoryTop());
  } else {
    pages.index = 0;
    pages.top = 0;
  }
  storeHistoryTop();
}

// A page the browser kept while the tab was away resumes with the same check as a page it loads again.
function watchHistoryLeave() {
  window.addEventListener("pagehide", () => storeHistoryTop(pages.index));
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    const ahead = forwardEntries();
    pages.top = ahead === null ? pages.index : pages.index + ahead;
    storeHistoryTop();
    showHistory();
  });
}

// Back and Forward, and Alt+arrows, move only through the pages visited in this tab, so they never leave the review app.
function goBack() {
  if (pages.index > 0) history.back();
}

function goForward() {
  if (pages.index < pages.top) history.forward();
}

function showHistory() {
  pageBar?.setHistory({ back: pages.index > 0, forward: pages.index < pages.top });
}

// A tab writes only with the write session it took from the one-time grant in the URL Prism opened; the tab's session storage keeps it,
// which no other tab shares, so a tab opened from a link an agent handed over stays read-only.
const WRITE_SESSION_KEY = "prism-write-session";

function writeSession() {
  try {
    return sessionStorage.getItem(WRITE_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeHeaders() {
  const token = writeSession();
  return token ? { "X-Prism-Write": token } : {};
}

// The action registry as the views use it: listings carry whether this tab can write, and every change goes through the apply route with the write session.
const actionApi = {
  async list(target) {
    if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
    const response = await fetch(`./api/actions?target=${encodeURIComponent(target)}`, { cache: "no-store", headers: writeHeaders() });
    const listing = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(listing.message ?? "The actions could not be read."), { code: listing.code });
    return listing;
  },
  async apply(request) {
    if (connection === "stopped") return { status: 0, json: { message: STOPPED_MESSAGE } };
    const response = await fetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify(request) })
      .catch(() => null);
    if (!response) return { status: 0, json: { message: "The review app did not answer, so the change was not applied. Try again in a moment." } };
    return { status: response.status, json: await response.json().catch(() => ({ message: "The server returned an unreadable response." })) };
  },
  confirm: confirmAction,
  toast: (message) => showToast(message)
};

// A change that needs the person's confirmation asks in the page's kit dialog; Escape, the scrim, Close, and Cancel decline, and only Confirm resolves true.
// The dialog opens on Cancel and returns focus to the control that asked.
function confirmAction({ title, message }) {
  const dialog = document.getElementById("action-dialog");
  const confirm = document.getElementById("action-dialog-confirm");
  const cancel = document.getElementById("action-dialog-cancel");
  return new Promise((resolve) => {
    let accepted = false;
    const onConfirm = () => {
      accepted = true;
      dialog.close();
    };
    const onCancel = () => dialog.close();
    confirm.addEventListener("click", onConfirm);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("prism-close", () => {
      confirm.removeEventListener("click", onConfirm);
      cancel.removeEventListener("click", onCancel);
      resolve(accepted);
    }, { once: true });
    dialog.setAttribute("heading", title);
    document.getElementById("action-dialog-message").textContent = message;
    dialog.show();
  });
}

// Exchanges a grant in the address fragment once, and removes the fragment without a new history entry so a reload or a copied address holds no grant.
async function takeWriteGrant() {
  const grant = new URLSearchParams(location.hash.slice(1)).get("write");
  if (!grant) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  try {
    const response = await fetch("./api/write-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant }) });
    const answer = await response.json().catch(() => ({}));
    if (response.ok && typeof answer.token === "string") sessionStorage.setItem(WRITE_SESSION_KEY, answer.token);
  } catch {
  }
}

function updateLocation(path, push = false) {
  const url = new URL(location.href);
  if (path) {
    url.searchParams.set("artifact", path);
  } else {
    url.searchParams.delete("artifact");
  }
  if (push) {
    pages.index += 1;
    pages.top = pages.index;
    history.pushState({ ref: path, index: pages.index }, "", `${url.pathname}${url.search}`);
  } else {
    history.replaceState({ ref: path, index: pages.index }, "", `${url.pathname}${url.search}`);
  }
  storeHistoryTop();
  showHistory();
}

// The artifact area says it is busy from the moment a page starts loading until its view has rendered.
function setBusy(busy) {
  artifact.setAttribute("aria-busy", String(busy));
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

// Opening a page pushes it onto the browser history, so Back, Forward, and the browser's own buttons move through the same pages.
// The session keeps the page and a preview of recent ones for the agent; `keep` keeps a page among them when the next one opens.
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
  if (navDrawer.isOpen) navDrawer.close();
  setBusy(true);
  renderNavigation();
  void showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
}

// A page that no longer exists leaves for the page before it, or for Attention when it was the first.
function closePage(path) {
  if (!requireApp()) return;
  scrollPositions.delete(path);
  openTabs = openTabs.filter((tab) => tab !== path);
  agentTabs = agentTabs.filter((tab) => tab !== path);
  if (previewTab === path) previewTab = null;
  if (selectedPath !== path) return;
  if (pages.index > 0) history.back();
  else openRef("attention");
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
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  previewTab = nextPreview;
  agentTabs = nextAgentTabs;
  const next = nextSelectedPath && nextTabs.includes(nextSelectedPath) ? nextSelectedPath : null;
  // A page an agent presents, or one another window of this session opened, becomes the next page of this tab's history.
  if (!next || next === selectedPath) return;
  selectedPath = next;
  lastSnapshot = "";
  updateLocation(selectedPath, true);
  setBusy(true);
  renderNavigation();
  void showArtifact(selectedPath);
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

// One project of the menu: its checkout, marked when it is the open one, with its open gates and whether an agent uses it, and its folder as the tip.
function projectItem({ entry, identity }, current, { gates: showGates = true, repository = false, value = entry.url } = {}) {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("type", "radio");
  item.setAttribute("value", value);
  item.toggleAttribute("checked", entry.id === current);
  item.setAttribute("tip", projectTitle(identity, entry.projectRoot));
  const checkout = workspaceName(identity) ?? folderName(entry.projectRoot);
  // A workspace can hold several repositories, so its items name the repository as well as the checkout.
  item.append(repository && identity.repository ? `${identity.repository} / ${checkout}` : checkout);
  const states = [];
  if (entry.live) states.push("in use");
  // Only a running or failed build is marked, because the status bar covers the open project's other states.
  if (entry.indexing === "preparing") states.push("indexing");
  if (entry.indexing === "failed") states.push("index failed");
  if (showGates && entry.gates === null) states.push("unreadable");
  else if (showGates && entry.gates) states.push(`${entry.gates} ${entry.gates === 1 ? "gate" : "gates"}`);
  if (states.length) {
    const hint = element("span", "project-states", states.join(" · "));
    hint.slot = "hint";
    item.append(hint);
  }
  return item;
}

// A session server has no list of projects, so its menu holds the one project it serves.
let thisProject = null;

function showOneProject() {
  if (!thisProject || projectListing === "one") return;
  projectListing = "one";
  const member = { entry: { id: "this", url: location.href, projectRoot: thisProject.projectRoot }, identity: workspaceIdentity(thisProject) };
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", member.identity.repository ?? folderName(thisProject.projectRoot));
  group.append(projectItem(member, "this", { gates: false }));
  projectMenu.replaceChildren(group);
  projectButton.removeAttribute("disabled");
}

// The review app lists its projects.
async function refreshProjects() {
  let listing;
  try {
    const response = await fetch("./api/projects", { cache: "no-store" });
    if (!response.ok) {
      showOneProject();
      return;
    }
    listing = await response.json();
  } catch {
    return;
  }
  projectButton.removeAttribute("disabled");
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
  projectGates.setAttribute("tip", `${waiting} open ${waiting === 1 ? "gate" : "gates"} in other projects`);
  // An unchanged list is left alone, and the server lists projects by recency, so the comparison ignores order and a sync that only reorders them leaves the menu alone.
  const text = JSON.stringify({ ...listing, projects: [...listing.projects].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) });
  if (text === projectListing) return;
  projectListing = text;
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
  const groups = [];
  const workspaceList = [...workspaces.values()].map((members) => members.sort(compareMembers));
  workspaceList.sort((left, right) => collator.compare(storeName(left[0].entry.store), storeName(right[0].entry.store)) || compareMembers(left[0], right[0]));
  for (const members of workspaceList) {
    const shared = members[0].entry;
    const gates = Math.max(...members.map(({ entry }) => entry.gates ?? 0));
    const group = document.createElement("prism-menu-group");
    group.setAttribute("label", `Workspace ${storeName(shared.store)}${gates ? ` · ${gates} ${gates === 1 ? "gate" : "gates"}` : ""}`);
    // Every checkout of a workspace shows the same records, so only code views, such as source files and the index, differ between them.
    group.append(...members.map((member) => projectItem(member, listing.current, { gates: false, repository: true })));
    groups.push(group);
  }
  for (const [repository, members] of [...repositories].sort(([left], [right]) => collator.compare(left, right))) {
    const group = document.createElement("prism-menu-group");
    group.setAttribute("label", repository);
    group.append(...members.sort(compareMembers).map((member) => projectItem(member, listing.current)));
    groups.push(group);
  }
  projectMenu.replaceChildren(...groups);
}

function setProjectLabel(identity, projectRoot, store = null) {
  const workspace = workspaceOf(store);
  project.replaceChildren(projectLabel(identity, workspace));
  projectButton.setAttribute("tip", [workspace ? `Workspace: ${workspace}` : "", projectTitle(identity, projectRoot)].filter(Boolean).join("\n"));
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

function renderNotices() {
  noticeBanner.hidden = notices.size === 0;
  noticeBanner.replaceChildren(...[...notices.values()].reverse().map((notice) => {
    const banner = document.createElement("prism-banner");
    banner.setAttribute("tone", "info");
    banner.setAttribute("dismissible", "");
    const text = element("p", "", "An agent presented a review in ");
    text.append(element("strong", "", notice.name), ". ");
    const link = element("a", "", "Open it");
    link.href = notice.url;
    text.append(link);
    banner.append(text);
    banner.addEventListener("prism-dismiss", () => {
      notices.delete(notice.projectId);
      renderNotices();
    });
    return banner;
  }));
}

function connectSessionEvents() {
  const token = writeSession();
  sessionStream = new EventSource(token ? `./api/events?write=${encodeURIComponent(token)}` : "./api/events");
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
  // An applied action of this page or of another checkout's page on the same records: views that show it update without a reload.
  sessionStream.addEventListener("action", (event) => {
    try {
      document.dispatchEvent(new CustomEvent("prism:action", { detail: JSON.parse(event.data) }));
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
  privateServerBanner.hidden = false;
}

// Actions that need the server explain why they cannot run while the app is stopped instead of failing silently.
function requireApp() {
  if (connection !== "stopped") return true;
  showToast(STOPPED_MESSAGE);
  return false;
}

// The status bar's Appearance menu: its radio items show the theme and density the page applies, and choosing one applies and stores it.
function startAppearanceMenu() {
  const menu = document.getElementById("appearance-menu");
  if (!menu) return;
  const root = document.documentElement;
  const showChoice = () => {
    for (const item of menu.querySelectorAll('prism-menu-item[type="radio"]')) {
      const value = item.getAttribute("value");
      item.toggleAttribute("checked", value === root.dataset.themeChoice || value === root.dataset.density);
    }
  };
  showChoice();
  new MutationObserver(showChoice).observe(root, { attributes: true, attributeFilter: ["data-theme-choice", "data-density"] });
  menu.addEventListener("prism-select", (event) => {
    const value = event.detail?.value;
    if (value === "catalog") {
      window.open(new URL("./kit/catalog", location.href).href, "_blank", "noopener");
      return;
    }
    const change = THEMES.includes(value) ? { theme: value } : DENSITIES.includes(value) ? { density: value } : null;
    if (!change) return;
    savePreferences(change).catch(() => showToast("The appearance applies here, but the review app could not store it."));
  });
}

function showToast(message, { tone = "neutral" } = {}) {
  toast.show?.(message, { tone });
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
    const control = event.target.closest("[data-action]");
    const action = control?.dataset.action;
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
      const sourcePanel = section.querySelector(".diagram-source");
      sourcePanel.hidden = !sourcePanel.hidden;
      control.setAttribute("aria-expanded", String(!sourcePanel.hidden));
      control.textContent = sourcePanel.hidden ? "Show source" : "Hide source";
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

// The runtime sets style attributes on the SVG it builds, which the page's style policy refuses and reports, so they are left out while it draws:
// the stylesheet sets PlantUML's preserved text spacing, and a diagram's background color is also a rectangle the runtime draws.
const setAttribute = Element.prototype.setAttribute;
function holdStyleAttributes() {
  Element.prototype.setAttribute = function setAttributeWithoutStyle(name, value) {
    if (this instanceof SVGElement && String(name).toLowerCase() === "style") return;
    setAttribute.call(this, name, value);
  };
  return () => {
    Element.prototype.setAttribute = setAttribute;
  };
}

function drawPlantUml(source) {
  const drawn = plantUmlQueue.then(() => new Promise((resolve) => {
    const release = holdStyleAttributes();
    const finish = (result) => {
      release();
      resolve(result);
    };
    try {
      renderToString(source.split(/\r?\n/), (svg) => {
        finish(svg.includes("Syntax Error") ? { error: "PlantUML reported a syntax error." } : { svg: svg.replace(/ style="[^"]*"/g, "") });
      }, (message) => finish({ error: String(message) }), { maxSvgSize: 8192 });
    } catch (error) {
      finish({ error: String(error?.message ?? error) });
    }
  }));
  plantUmlQueue = drawn.catch(() => {});
  return drawn;
}

// Each shown diagram keeps the SVG text the runtime returned, so a theme change recolors a fresh copy rather than a recolored one.
const shownDiagrams = new Set();

/** Puts the runtime's SVG text on a sheet and recolors it for the theme computed there. */
function placeDiagram(sheet, svgText) {
  sheet.innerHTML = svgText;
  themeDiagram(sheet.querySelector("svg"));
}

function retheme() {
  for (const shown of shownDiagrams) {
    if (!shown.sheet.isConnected) {
      shownDiagrams.delete(shown);
      continue;
    }
    placeDiagram(shown.sheet, shown.svg);
    shown.restore?.();
  }
}

function watchDiagramTheme() {
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/** Shows a drawn SVG on a sheet, recolored now and again whenever the theme changes; `restore` reapplies a zoom after each recoloring. */
function showDiagram(sheet, svgText, restore = null) {
  for (const shown of shownDiagrams) if (shown.sheet === sheet) shownDiagrams.delete(shown);
  placeDiagram(sheet, svgText);
  shownDiagrams.add({ sheet, svg: svgText, restore });
}

async function renderDiagram(source, target, section, { fit = false } = {}) {
  const drawn = await drawPlantUml(source);
  if (drawn.error) {
    target.innerHTML = `<p class="error">${escapeHtml(drawn.error)}</p>`;
    return;
  }
  showDiagram(target, drawn.svg, () => setDiagramScale(section, Number(section.dataset.scale) || 1));
  configureDiagram(section, source);
  // A narrow place, such as the side panel, starts the diagram at the width it has, and the zoom buttons still reach every size.
  if (fit) {
    const room = target.clientWidth - 2 * Number.parseFloat(getComputedStyle(target).paddingLeft || "0");
    const natural = Number(section.dataset.naturalWidth);
    if (room > 0 && natural > room) setDiagramScale(section, room / natural);
  }
}

// A diagram is named by the title its source gives, or by its own name in words, never its file name.
function diagramName(path, source = "") {
  const title = /^\s*title\s+(.+?)\s*$/im.exec(source)?.[1];
  if (title) return title;
  const words = fileName(path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Diagram";
}

// A compact card leaves the name to its container, such as the side panel, whose header already names the diagram.
function diagramCard(diagram, { compact = false } = {}) {
  const section = document.createElement("prism-panel");
  section.className = `diagram-view${compact ? " is-compact" : ""}`;
  section.setAttribute("variant", compact ? "plain" : "card");
  if (!compact) {
    section.setAttribute("heading", diagramName(diagram.path, diagram.source));
    section.setAttribute("eyebrow", "Diagram");
  }
  section.innerHTML = `
    <div slot="tools" class="diagram-tools" role="group" aria-label="Diagram controls">
      <prism-button variant="ghost" size="sm" data-action="zoom-out" label="Zoom out" tip="Zoom out">−</prism-button>
      <prism-button variant="ghost" size="sm" data-action="reset" data-scale-label tip="Reset zoom">100%</prism-button>
      <prism-button variant="ghost" size="sm" data-action="zoom-in" label="Zoom in" tip="Zoom in">+</prism-button>
      <prism-button variant="ghost" size="sm" data-action="source" aria-expanded="false">Show source</prism-button>
      <prism-button variant="ghost" size="sm" data-action="copy" tip="Copy PlantUML source">Copy</prism-button>
    </div>
    <div class="diagram-output"><prism-spinner label="Rendering diagram"></prism-spinner></div>
    <div class="diagram-source" hidden><prism-code language="plantuml"><pre><code>${highlight(diagram.source, "plantuml")}</code></pre></prism-code></div>`;
  return section;
}

function fileName(path) {
  return path.split("/").pop();
}

function fileType(path) {
  return path.split(".").pop().toUpperCase();
}

// Names a page or file for the page bar, the palette, and the side panel: Prism's records by title and kind, repository files by their path.
function titleIndex() {
  return new Map((navigation.index ?? []).filter((entry) => entry.kind === "initiative" || entry.kind === "slice").map((entry) => [entry.ref, entry.label]));
}

function describe(path) {
  const record = (prismRecords.has(path) || path.startsWith(".prism/")) && recordKind(path);
  if (!record) return { label: fileName(path), kind: "File", owner: null, code: true };
  return { ...recordLabel(path, titleIndex()), code: false };
}

function pageLabel(path) {
  const parsed = parseEntityRef(path);
  if (!parsed) {
    const named = describe(path);
    return named.code ? path : named.label === named.kind ? named.kind : `${named.kind} · ${named.label}`;
  }
  if (ENTITY_LABELS[parsed.kind]) return ENTITY_LABELS[parsed.kind];
  const indexed = navigation.index?.find((entry) => entry.ref === path)?.label;
  if (indexed) return indexed;
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  return parsed.kind === "slice" ? parsed.slug : parsed.id;
}

// The trail of the page's place, initiative, and slice by title; a record of Prism's ends with its kind, since the crumbs before it name its owner.
function trailOf(path) {
  const trail = currentContext?.ref === path ? currentContext.value.trail : [{ ref: path, label: pageLabel(path) }];
  return trail.map((crumb, index) => {
    if (!crumb.ref || parseEntityRef(crumb.ref)) return { ref: crumb.ref, label: crumb.ref === null && crumb.label === "Files" && !describe(path).code ? "Documents" : crumb.label };
    const named = describe(crumb.ref);
    if (named.code) return { ref: crumb.ref, label: crumb.ref, code: true };
    const owned = index > 0 && trail.slice(0, index).some((before) => before.label === named.owner);
    return { ref: crumb.ref, label: owned || named.label === named.kind ? named.kind : named.label };
  });
}

const STATE_WORDS = { envisioned: "Envisioned", planned: "Planned", "in-progress": "In progress", shipped: "Shipped", unlisted: "Not on the roadmap" };

function treeItem(value, label, { selected = false, expanded = false, end = [], children = [] } = {}) {
  const item = document.createElement("prism-tree-item");
  item.setAttribute("value", value);
  item.setAttribute("label", label);
  item.toggleAttribute("selected", selected);
  item.toggleAttribute("expanded", expanded);
  for (const node of end) {
    node.slot = "end";
    item.append(node);
  }
  item.append(...children);
  return item;
}

function tree(label, items) {
  const holder = document.createElement("prism-tree");
  holder.setAttribute("label", label);
  holder.append(...items);
  return holder;
}

function section(label, count = null) {
  const heading = element("p", "nav-section");
  heading.append(element("span", "", label));
  if (count !== null) heading.append(element("span", "nav-count", String(count)));
  return heading;
}

function badge(text, tone = "neutral", tip = null) {
  const node = element("prism-badge", "", text);
  node.setAttribute("variant", "count");
  node.setAttribute("tone", tone);
  if (tip) node.setAttribute("tip", tip);
  return node;
}

// A branch expands when the user expanded it or when it leads to the open slice, so every other row stays one line.
function isExpanded(scope, slug, ancestorsOfCurrent) {
  const toggled = treeToggles.get(`slice:${scope.id}/${slug}`);
  return toggled ?? ancestorsOfCurrent.has(slug);
}

function sliceItems(scope, entity) {
  const nodes = new Map(scope.tree.map((node) => [node.slug, node]));
  const ancestorsOfCurrent = new Set();
  for (let slug = nodes.get(scope.current)?.parent; slug; slug = nodes.get(slug)?.parent) ancestorsOfCurrent.add(slug);
  const build = (node) => {
    const ref = `slice:${scope.id}/${node.slug}`;
    const end = [];
    if (node.blocking) end.push(badge(String(node.blocking), "danger", `${node.blocking} blocking ${node.blocking === 1 ? "finding" : "findings"}`));
    const claim = claimIndex?.claimFor(ref);
    if (claim) end.push(claimElement(claim, "avatar"));
    const children = scope.tree.filter((child) => child.parent === node.slug).map(build);
    return treeItem(ref, node.title, { selected: selectedPath === ref || (scope.current === node.slug && !entity), expanded: children.length > 0 && isExpanded(scope, node.slug, ancestorsOfCurrent), end, children });
  };
  return scope.tree.filter((node) => node.depth === 1).map(build);
}

// The sidebar is the only navigation: places, every initiative, the open initiative's slices or the open library section's documents, and the library.
let navigationKey = "";

function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  void updateAttentionSignals(attention.gates ?? 0);
  const entity = Boolean(parseEntityRef(selectedPath ?? ""));
  const claims = claimIndex ? [...claimIndex.live(), ...claimIndex.expired()].map((claim) => [claim.ref, claim.expiresAt, claim.label]) : [];
  const key = JSON.stringify([selectedPath, scope, attention, navigation.initiatives, navigation.glossary, navigation.diagnostics, claims, [...treeToggles]]);
  if (key === navigationKey) return;
  navigationKey = key;
  const focused = document.activeElement?.closest?.("prism-tree-item");
  const refocus = focused && navRoot.contains(focused) ? focused.getAttribute("value") : null;
  const others = attention.needsYou - attention.gates;
  const attentionEnd = attention.needsYou ? [badge(String(attention.needsYou), attention.gates ? "danger" : "accent", `${attention.gates} recorded ${attention.gates === 1 ? "question" : "questions"} and ${others} other ${others === 1 ? "item" : "items"} need you`)] : [];
  navPlaces.replaceChildren(
    treeItem("attention", "Attention", { selected: selectedPath === "attention", end: attentionEnd }),
    treeItem("roadmap", "Roadmap", { selected: selectedPath === "roadmap" })
  );
  const parts = [];
  const initiatives = navigation.initiatives ?? [];
  parts.push(section("Initiatives", initiatives.length));
  if (initiatives.length) {
    parts.push(tree("Initiatives", initiatives.map((item) => {
      const ref = `initiative:${item.id}`;
      const current = scope.kind === "initiative" && scope.id === item.id && !scope.current && !entity;
      const state = element("span", "nav-state", STATE_WORDS[item.state] ?? item.state);
      return treeItem(ref, item.title, { selected: selectedPath === ref || current, end: [state] });
    })));
  } else parts.push(element("p", "nav-note", "No initiatives yet."));
  if (scope.kind === "initiative") {
    parts.push(section(scope.title));
    const items = sliceItems(scope, entity);
    if (items.length) parts.push(tree(`Slices of ${scope.title}`, items));
    else parts.push(element("p", "nav-note", scope.valid === false ? "The initiative record is invalid." : "No slices yet."));
  } else if (scope.kind === "library") {
    const name = ENTITY_LABELS[scope.section] ?? scope.section;
    const topics = new Map();
    for (const entry of scope.entries) {
      const topic = scope.section === "decisions" ? entry.topic ?? "General" : name;
      if (!topics.has(topic)) topics.set(topic, []);
      topics.get(topic).push(entry);
    }
    if (scope.section !== "decisions") parts.push(section(name, scope.entries.length));
    for (const [topic, entries] of topics) {
      if (scope.section === "decisions") parts.push(section(topic, entries.length));
      parts.push(tree(topic, entries.map((entry) => treeItem(entry.path, entry.title, { selected: selectedPath === entry.path, end: entry.status ? [element("span", "nav-state", entry.status)] : [] }))));
    }
    if (!scope.entries.length) parts.push(element("p", "nav-note", "No documents."));
  }
  if (navigation.diagnostics?.length) {
    const warnings = document.createElement("prism-disclosure");
    warnings.className = "nav-diagnostics";
    warnings.setAttribute("summary", `${navigation.diagnostics.length} workflow ${navigation.diagnostics.length === 1 ? "setting warning" : "setting warnings"}`);
    const list = element("ul", "");
    list.append(...navigation.diagnostics.map((item) => element("li", "", item.message)));
    warnings.append(list);
    parts.push(warnings);
  }
  navScope.replaceChildren(...parts);
  const glossary = navigation.glossary ?? {};
  navLibrary.replaceChildren(section("Library"), tree("Library", [
    ...["requirements", "decisions"].map((ref) => treeItem(ref, ENTITY_LABELS[ref], { selected: selectedPath === ref })),
    treeItem("glossary", "Glossary", { selected: selectedPath === "glossary" || (glossary.path && selectedPath === glossary.path), end: glossary.exists ? [] : [element("span", "nav-state", "missing")] })
  ]));
  if (refocus) [...navRoot.querySelectorAll("prism-tree-item")].find((item) => item.getAttribute("value") === refocus)?.focus();
  navRoot.querySelector("prism-tree-item[selected]")?.scrollIntoView?.({ block: "nearest" });
}

async function refreshContext(path) {
  let value;
  try {
    value = await fetchJson(`./api/context?ref=${encodeURIComponent(path)}`);
  } catch {
    value = { trail: [{ ref: path, label: pageLabel(path) }], scope: { kind: "global" } };
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
  pageBar.setTrail(trailOf(path));
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
    memory.open = [...artifact.querySelectorAll("prism-disclosure")].map((disclosure) => [disclosure.getAttribute("summary") ?? "", disclosure.open]);
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

const MAXIMIZABLE = ".graph-view, .diagram-view:not(.is-compact), .document-sheet";

// Graphs, diagrams, and documents can fill the window. The maximized card is remembered in the view state,
// so a refresh that rebuilds the view keeps it maximized instead of dropping out as browser fullscreen would.
function decorateMaximize(path) {
  const state = viewState(path);
  let found = false;
  [...artifact.querySelectorAll(MAXIMIZABLE)].forEach((card, index) => {
    const key = `${card.className.split(" ")[0]}:${index}`;
    let button = card.querySelector(":scope [data-maximize]");
    if (!button) {
      button = document.createElement("prism-button");
      button.setAttribute("variant", "ghost");
      button.setAttribute("size", "sm");
      button.className = "maximize-control";
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
    button.setAttribute("pressed", String(maximized));
    button.setAttribute("tip", maximized ? "Restore (Esc)" : "Fill the window");
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
    acceptNode: (node) => node.parentElement?.closest(".doc-toc, [data-maximize], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
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

// Chips are one line, so a label cut off by its ellipsis is marked shortened, and the kit's tooltip shows its full text.
const CHIPS = ".status-pill, .meta-pill, .relation-chip, .link-chip, .claim-chip, .readiness-jump, .type-badge, .code-span-chip, .component-chip";

function markClippedChips(root) {
  for (const chip of root.querySelectorAll(CHIPS)) {
    const clipped = [chip, ...chip.querySelectorAll("*")].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible");
    chip.toggleAttribute("shortened", clipped);
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
  requestAnimationFrame(() => markClippedChips(artifact));
  if (memory.open) {
    const sections = artifact.querySelectorAll("prism-disclosure");
    memory.open.forEach(([summary, open], index) => {
      if (sections[index] && (sections[index].getAttribute("summary") ?? "") === summary) sections[index].open = open;
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
  setBusy(false);
}

// A page whose file or entity is gone shows a short page with a button that closes it; the next refresh restores a target that comes back.
function showMissing(path) {
  missingTabs.add(path);
  if (path !== selectedPath) return;
  if (lastSnapshot !== `missing:${path}`) {
    lastSnapshot = `missing:${path}`;
    renderedPath = null;
    document.body.classList.remove("has-maximized");
    pageBar.setActions([]);
    renderMissing(artifact, path, { entity: Boolean(parseEntityRef(path)), label: pageLabel(path), onClose: () => closePage(path) });
  }
  setBusy(false);
}

function updateMissingTabs(reported) {
  missingTabs = nextMissingTabs(missingTabs, reported).next;
}

// A page that could not load says why in the artifact area, and the area is no longer busy.
async function showError(response) {
  pageBar.setActions([]);
  artifact.innerHTML = `<div class="document-sheet"><p class="error">${escapeHtml(await response.text())}</p></div>`;
  setBusy(false);
}

// A view's own actions, such as the structured and raw modes of a record, sit at the end of the page bar.
function modeButtons(state, path) {
  return [["structured", "Structured"], ["raw", "Raw"]].map(([mode, text]) => {
    const button = element("prism-button", "", text);
    button.setAttribute("size", "sm");
    button.setAttribute("variant", "ghost");
    button.dataset.mode = mode;
    button.setAttribute("pressed", String(mode === "raw" ? Boolean(state.raw) : !state.raw));
    button.addEventListener("click", () => {
      state.raw = mode === "raw";
      lastSnapshot = "";
      void showArtifact(path);
    });
    return button;
  });
}

async function showEntity(path) {
  const response = await fetch(`./api/entity?ref=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (response.status === 404) {
    showMissing(path);
    return;
  }
  if (!response.ok) {
    await showError(response);
    return;
  }
  const entity = await response.json();
  const snapshot = JSON.stringify(entity);
  if (path !== selectedPath) return;
  if (snapshot === lastSnapshot) {
    setBusy(false);
    return;
  }
  lastSnapshot = snapshot;
  const label = entityLabel(entity);
  const state = viewState(path);
  const memory = beginRebuild(path);
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        <h1>${escapeHtml(label.title)}</h1>
        ${label.lead ? `<div class="artifact-lead${state.leadExpanded ? " is-expanded" : ""}"><p>${escapeHtml(label.lead)}</p><prism-button variant="ghost" size="sm" data-lead-toggle hidden>${state.leadExpanded ? "Less" : "More"}</prism-button></div>` : ""}
      </div>
    </header>`;
  const lead = artifact.querySelector(".artifact-lead");
  if (lead) {
    const text = lead.querySelector("p");
    const toggle = lead.querySelector("[data-lead-toggle]");
    toggle.hidden = !state.leadExpanded && text.scrollHeight <= text.clientHeight + 1;
    toggle.addEventListener("click", () => {
      state.leadExpanded = !state.leadExpanded;
      lead.classList.toggle("is-expanded", state.leadExpanded);
      toggle.textContent = state.leadExpanded ? "Less" : "More";
    });
  }
  pageBar.setActions([]);
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
    await showError(response);
    return;
  }
  const data = await response.json();
  const snapshot = JSON.stringify(data);
  if (path !== selectedPath) return;
  if (snapshot === lastSnapshot) {
    setBusy(false);
    return;
  }
  lastSnapshot = snapshot;
  const diagramLabel = `${data.diagrams.length} diagram${data.diagrams.length === 1 ? "" : "s"}`;
  const source = data.kind === "source";
  const structured = Boolean(data.kind) && !source;
  const documentCard = source
    ? `<section class="document-sheet source-sheet" data-code-subject><ol class="source-lines">${highlightLines(data.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(data.path)).map((line, index) => `<li id="${HEADING_PREFIX}L${index + 1}"><code>${line || " "}</code></li>`).join("")}</ol></section>`
    : structured || data.path.toLowerCase().endsWith(".puml")
      ? ""
      : `<section class="document-sheet"><prism-doc class="document-content">${renderText(data.path, data.content, markdownOptions(data.path))}</prism-doc></section>`;
  const state = viewState(data.path);
  const memory = beginRebuild(path);
  // A repository file is named by its path; a record of Prism's by its title and kind, never its file name.
  const named = describe(data.path);
  const heading = named.code ? fileName(data.path) : named.label === named.kind ? named.kind : named.label;
  const kind = structured ? KIND_LABELS[data.kind] ?? "JSON" : named.code ? fileType(data.path) : named.kind;
  artifact.innerHTML = `
    <header class="artifact-header">
      <div>
        ${named.code ? "" : `<p class="eyebrow">${escapeHtml(named.kind)}</p>`}
        <h1${named.code ? " data-code-subject" : ""}>${escapeHtml(heading)}</h1>
        ${named.code ? `<p class="artifact-path" data-code-subject>${escapeHtml(data.path)}</p>` : ""}
      </div>
      <div class="artifact-meta">
        ${named.code || structured ? `<prism-chip>${escapeHtml(kind)}</prism-chip>` : ""}
        ${source ? "<prism-chip>Read-only</prism-chip>" : structured ? "" : `<prism-chip>${diagramLabel}</prism-chip>`}
      </div>
    </header>
    ${documentCard}`;
  pageBar.setActions(structured ? modeButtons(state, path) : []);
  if (structured) {
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
    actionApi,
    // Names one of Prism's records by title and kind, or a repository file by its path, as the page bar and the palette do.
    describe,
    recordTitle: (recordPath) => (navigation.index ?? []).find((entry) => entry.ref === recordPath)?.label ?? null,
    // A view's own actions sit at the end of the page bar while it shows.
    setPageActions: (nodes) => {
      if (path === selectedPath) pageBar.setActions(nodes);
    },
    sidePanel: {
      show: (ref) => sidePanel.showFile(ref),
      close: () => sidePanel.close(),
      isOpen: () => sidePanel.isOpen()
    },
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
      const listed = await fetch(`./api/actions?target=${encodeURIComponent(target)}`, { headers: writeHeaders() }).catch(unanswered);
      const listing = await listed.json().catch(() => ({}));
      if (!listed.ok) throw Object.assign(new Error(listing.message ?? "The answer was not recorded."), { code: listing.code === "unknown_target" ? "unknown_gate" : listing.code });
      const action = (listing.actions ?? []).find((item) => item.id === "gate.answer");
      const names = new Set((action?.fields ?? []).map((field) => field.name));
      const input = Object.fromEntries([["choice", choice], ["note", note]].filter(([name, value]) => names.has(name) && value !== null && value !== undefined && value !== ""));
      const response = await fetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ action: "gate.answer", target, input, revision: action?.revision ?? null }) }).catch(unanswered);
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
  const titles = titleIndex();
  // Prism's own records are named by title and kind; repository files keep their paths, since code is their subject.
  const files = [...availableArtifacts].filter((file) => !known.has(file)).map((file) => {
    if (describe(file).code) return { ref: file, label: fileName(file), kind: "file", detail: file };
    // A record that belongs to a slice or initiative reads as its kind, so its owner's title stays the owner's own result; the preview names the owner.
    const named = recordLabel(file, titles);
    if (named.owner) return { ref: file, label: named.kind, kind: "record", kindLabel: "Record", detail: named.owner, preview: { kind: named.kind, title: named.owner } };
    return { ref: file, label: named.label, kind: "record", kindLabel: named.kind };
  });
  return [...shownActionEntries(), ...places, ...indexed, ...files];
}

let recordStoreStatus = null;

// The record store and its sync live in the status bar: where records live, and the sync state, which opens details with every saved conflict.
function renderStoreSync(data) {
  recordStoreStatus?.update(data.recordStore, data.storeSync);
}

startAppearanceMenu();
watchDiagramTheme();

// The sidebar moves into the drawer while the drawer is open, so one set of trees serves both.
function focusTrees() {
  (navRoot.querySelector("prism-tree-item[selected]") ?? navRoot.querySelector("prism-tree-item"))?.focus();
}

// The drawer places its children in its body a microtask after they arrive, so the trees take focus once they sit inside the open drawer.
async function openDrawer() {
  navDrawer.append(navRoot);
  navDrawer.show();
  await Promise.resolve();
  if (navDrawer.isOpen && navDrawer.contains(navRoot)) focusTrees();
}

function closeDrawer() {
  if (navRoot.parentElement !== sidebar) sidebar.append(navRoot);
}

// Above 1100px the sidebar shows the trees, so a drawer left open as the window widens closes and gives them back.
function watchDrawerWidth() {
  const wide = matchMedia("(min-width: 1101px)");
  wide.addEventListener("change", () => {
    if (!wide.matches) return;
    if (!navDrawer.isOpen) return closeDrawer();
    navDrawer.close();
    closeDrawer();
    // The drawer returns focus to the Navigation button that opened it, which is hidden now, so focus moves to the trees.
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("#nav-button, .topbar-navigation") || active.getClientRects().length === 0) focusTrees();
  });
}

async function initialize() {
  await takeWriteGrant();
  const data = await fetchJson("./api/index");
  startHistory();
  watchHistoryLeave();
  pageBar = createPageBar({
    root: document.getElementById("page-bar"),
    onBack: goBack,
    onForward: goForward,
    onOpen: (ref) => openRef(ref)
  });
  showHistory();
  recordStoreStatus = createRecordStoreStatus({
    storeButton: document.getElementById("store-status"),
    storeLabel: document.getElementById("store-status-label"),
    syncButton: document.getElementById("store-sync"),
    syncLabel: document.getElementById("store-sync-label"),
    dialog: document.getElementById("store-dialog"),
    fetchJson,
    openRecord: (path) => openRef(path),
    hasArtifact: (path) => availableArtifacts.has(path),
    describe
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
  thisProject = data;
  showPrivateServer(data.privateServer);
  let sectionFrame = 0;
  workspace.addEventListener("scroll", () => {
    if (!rebuilding && renderedPath && renderedPath === selectedPath) scrollPositions.set(renderedPath, workspace.scrollTop);
    cancelAnimationFrame(sectionFrame);
    sectionFrame = requestAnimationFrame(() => markCurrentSection(artifact, workspace.getBoundingClientRect().top));
  }, { passive: true });
  // Choosing another project opens its review page; opening the menu refreshes the list first.
  projectButton.addEventListener("click", () => void refreshProjects());
  projectMenu.addEventListener("prism-select", (event) => {
    const url = event.detail?.value;
    if (url && url !== location.href) location.href = url;
  });
  void refreshProjects();
  setInterval(refreshProjects, 5000);
  createIndexingStatus({
    root: document.getElementById("indexing"),
    button: document.getElementById("indexing-button"),
    label: document.getElementById("indexing-label"),
    component: document.getElementById("indexing-component"),
    detail: document.getElementById("indexing-detail"),
    meter: document.getElementById("indexing-meter"),
    panel: document.getElementById("indexing-panel"),
    fetchJson,
    actionApi
  });
  prismRecords = new Set(data.artifacts);
  availableArtifacts = new Set([...data.artifacts, ...(data.sources ?? [])]);
  missingTabs = new Set(data.missingTabs ?? []);
  navigation = data.navigation;
  claimIndex = createClaimIndex({
    fetchJson,
    initiatives: () => navigation.initiatives ?? [],
    onChange: () => {
      navigationKey = "";
      renderNavigation();
      presence?.render();
    }
  });
  await claimIndex.refresh().catch(() => {});
  presence = createPresence({
    button: document.getElementById("presence-button"),
    popover: document.getElementById("presence"),
    claims: claimIndex,
    onOpen: (ref) => openRef(ref)
  });
  palette = createPalette({
    dialog: document.getElementById("palette"),
    field: document.getElementById("palette-input"),
    results: document.getElementById("palette-results"),
    preview: document.getElementById("palette-preview"),
    entries: paletteEntries,
    describe,
    claimFor: (ref) => claimIndex.claimFor(ref),
    search: async (query) => (await fetchJson(`./api/search?q=${encodeURIComponent(query)}`)).results,
    onOpen: (ref, { find, ...options }) => {
      pendingFind = find ? { path: ref, text: find } : null;
      openRef(ref, options);
    }
  });
  sidePanel = createSidePanel({
    shell: appShell,
    sheet: document.getElementById("side-panel-sheet"),
    describe,
    // A page's Side panel button follows the panel, however it opens or closes.
    onChange: (open) => document.dispatchEvent(new CustomEvent("prism:side-panel", { detail: { open } })),
    fetchJson,
    renderMarkdown: (path, content) => renderText(path, content, markdownOptions(path)),
    // The panel draws a diagram as the same card its page shows, without the name its header already gives, and fitted to the panel's width.
    mountDiagram: async (target, diagram) => {
      const section = diagramCard(diagram, { compact: true });
      target.appendChild(section);
      await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section, { fit: true });
    },
    onOpenTab: (ref, anchor) => {
      pendingAnchor = anchor ? { path: ref, anchor } : null;
      // The file moves into its page, so the panel closes rather than showing it twice.
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
    describe,
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
    describe,
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
  navRoot.addEventListener("prism-select", (event) => {
    const ref = event.detail?.value;
    if (ref) openRef(ref);
  });
  navRoot.addEventListener("prism-toggle", (event) => {
    const value = event.detail?.value;
    if (!value) return;
    treeToggles.set(value, Boolean(event.detail.expanded));
    renderNavigation();
  });
  document.getElementById("nav-button").addEventListener("click", openDrawer);
  navDrawer.addEventListener("prism-close", closeDrawer);
  watchDrawerWidth();
  document.getElementById("jump").addEventListener("click", () => palette.show());
  artifact.addEventListener("click", (event) => {
    // Markdown links to repository files open as review pages, and anchors scroll within the document they name.
    const docLink = event.target.closest("a[data-doc-link], a[data-doc-anchor]");
    // Alt+click shows a linked file in the side panel and keeps the current page.
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
  const overlayOpen = () => [...document.querySelectorAll("prism-dialog, prism-popover, prism-menu")].some((overlay) => overlay.isOpen ?? overlay.hasAttribute("open"));
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || Boolean(document.activeElement?.closest?.("prism-field"));
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (palette.isOpen()) palette.hide();
      else palette.show();
    } else if (event.key === "/" && !typing && !palette.isOpen()) {
      event.preventDefault();
      palette.show();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !typing) {
      // The browser may move through history on Alt+arrows itself, so the page does it once and keeps the key from the browser.
      event.preventDefault();
      if (event.key === "ArrowLeft") goBack();
      else goForward();
    } else if (event.key === "Escape" && overlayOpen()) {
      // An open dialog, popover, or menu closes on its own Escape.
    } else if (event.key === "Escape" && selectedPath && viewState(selectedPath).maximized) {
      setMaximized(selectedPath, null);
    } else if (event.key === "Escape" && sidePanel.isOpen() && !document.querySelector(".link-preview:not([hidden])")) {
      sidePanel.close();
    }
  });
  window.addEventListener("popstate", (event) => {
    if (Number.isInteger(event.state?.index)) pages.index = event.state.index;
    showHistory();
    const ref = event.state?.ref ?? new URLSearchParams(location.search).get("artifact");
    if (ref && ref !== selectedPath) openRef(ref, { fromHistory: true });
  });
  connectSessionEvents();
  renderNavigation();
  presence.render();
  if (requestedPath && requestedPath !== selectedPath) {
    openRef(requestedPath, { fromHistory: true });
  } else if (!selectedPath) {
    openRef(openTabs[0] ?? "attention", { fromHistory: true });
  } else {
    updateLocation(selectedPath);
    setBusy(true);
    await showArtifact(selectedPath);
  }
  let polls = 0;
  setInterval(async () => {
    // Shown action lists check their listing every few seconds, so a change an agent made shows without a reload.
    if (++polls % 3 === 0 && connection !== "stopped") document.dispatchEvent(new CustomEvent("prism:poll"));
    try {
      const refreshed = await fetch("./api/index", { cache: "no-store" }).catch(() => null);
      reportRefresh(Boolean(refreshed?.ok));
      if (refreshed?.ok) {
        const snapshot = await refreshed.json();
        renderStoreSync(snapshot);
        prismRecords = new Set(snapshot.artifacts);
        availableArtifacts = new Set([...snapshot.artifacts, ...(snapshot.sources ?? [])]);
        updateMissingTabs(snapshot.missingTabs);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          navigation = snapshot.navigation;
          renderNavigation();
          void claimIndex.refresh().catch(() => {});
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
  artifact.innerHTML = `<div class="document-sheet"><p class="error">${escapeHtml(error.message)}</p></div>`;
  setBusy(false);
});
