import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
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
import { DEFAULT_PLACE, PLACES, placeNamed } from "./views/places.js";
import { claimElement, createClaimIndex } from "./views/claim-index.js";
import { createPresence } from "./views/presence.js";
import { DENSITIES, savePreferences, THEMES } from "./kit/preferences.js";
import { shownActionEntries } from "./views/actions.js";
import { themeDiagram } from "./kit/diagram-theme.js";
import { currentPhase } from "./views/slice.js";
import { messageHtml } from "./views/util.js";
import { createPoller, deadline, POLL_DEADLINE_MS } from "./views/poller.js";
import { createEventRelay } from "./views/event-relay.js";

const project = document.getElementById("project");
const navRoot = document.getElementById("nav");
const sidebar = document.getElementById("sidebar");
const shell = document.getElementById("shell");
const navDrawer = document.getElementById("nav-drawer");
const drawerPlaces = document.getElementById("drawer-places");
const railDock = document.getElementById("rail-dock");
const shellRail = document.getElementById("rail");
const drawerRail = document.getElementById("drawer-rail");
const placeHead = document.getElementById("place-head");
const sidebarToggle = document.getElementById("sidebar-toggle");
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
const projectTile = document.getElementById("project-tile");
const attentionButton = document.getElementById("attention-button");
const noticeBanner = document.getElementById("notice");
// The latest notice per presenting project; a notice only links, and the page changes project only when the user follows it.
const notices = new Map();
let projectListing = "";
let selectedPath = new URLSearchParams(location.search).get("artifact");
// The app sends a page of a project it no longer lists to the project used last, marked so this page says why; the mark leaves the address at once.
if (new URLSearchParams(location.search).get("missing") === "project") {
  document.getElementById("missing-project").hidden = false;
  const kept = new URLSearchParams(location.search);
  kept.delete("missing");
  history.replaceState(history.state, "", `${location.pathname}${kept.size ? `?${kept}` : ""}${location.hash}`);
}
// The server keeps the session's open tabs for every window and for the agent: the selected tab, one preview tab that ordinary navigation replaces, and the tabs an agent presented.
let openTabs = [];
let previewTab = null;
let agentTabs = [];
let sessionRevision = 0;
// A replaced review app restarts revisions, so a snapshot from a new instance is accepted whatever its revision.
let sessionInstance = null;
// A page that reconnects to an app of another plugin version reloads, so it never runs old page code against a newer app.
let appVersion = null;
let sessionConnected = false;
// The origin's shared event stream, which one tab holds for every tab of the review app.
let relay = null;
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
// Attention's kinds in the sidebar's order, each with its icon; every kind shows its count, also at 0.
const ATTENTION_KINDS = [
  ["questions", "Questions", "gate"],
  ["findings", "Review findings", "eye"],
  ["failed", "Failed verifications", "flask"],
  ["blocked", "Blocked work", "warning"],
  ["ready", "Ready to ship", "check-circle"],
  ["problems", "Problems", "warning"]
];
// The row of By work that shows the initiatives past the first few; choosing it shows or hides them below it.
const ATTENTION_MORE = "attention:more";
let attentionMoreOpen = false;

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

// Every request has a deadline, so a request the browser holds back for want of a free connection fails and shows the connection banner instead of freezing the page.
function appFetch(url, options = {}) {
  const { deadlineMs, ...rest } = options;
  return fetch(url, { signal: deadline(deadlineMs), ...rest });
}

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
    const response = await appFetch(`./api/actions?target=${encodeURIComponent(target)}`, { cache: "no-store", headers: writeHeaders() });
    const listing = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(listing.message ?? "The actions could not be read."), { code: listing.code });
    return listing;
  },
  async apply(request) {
    if (connection === "stopped") return { status: 0, json: { message: STOPPED_MESSAGE } };
    const response = await appFetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify(request) })
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
    const response = await appFetch("./api/write-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant }) });
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
  // A place= address chose the place when the page loaded; the place is stored, so the address leaves it out from then on.
  url.searchParams.delete("place");
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

// A window opened from a link of another window, by a middle click or a Shift click, holds its page as a kept tab of the session
// without selecting it for the other windows, so following the link in a new window leaves the window it came from as it was.
// It holds the page until the person opens or closes a page here, or another window selects a tab.
let held = null;

// The review page notes a link it hands to the browser by a middle click or a Shift click, so the window that opens knows it came from a link.
const LINK_KEY = "prism.review.link";

function noteLinkOpened(event) {
  if (!(event.button === 1 || (event.button === 0 && event.shiftKey))) return;
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.href);
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  const ref = url.searchParams.get("artifact");
  if (!ref || url.origin !== location.origin || url.pathname !== location.pathname) return;
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch {
    // Without storage the window that opens takes the page as any window does.
  }
}

function openedFromLink(ref) {
  try {
    const note = JSON.parse(localStorage.getItem(LINK_KEY) ?? "null");
    localStorage.removeItem(LINK_KEY);
    return Boolean(note && note.ref === ref && Date.now() - note.at < 15000);
  } catch {
    return false;
  }
}

function holdPage(path) {
  held = { page: path, sessionTab: selectedPath };
  if (!openTabs.includes(path)) openTabs.push(path);
  selectedPath = path;
  lastSnapshot = "";
  updateLocation(path);
  setBusy(true);
  renderTabs();
  renderNavigation();
  void showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
}

function saveSession() {
  const payload = { openTabs: [...openTabs], activeTab: held ? held.sessionTab : selectedPath, previewTab, agentTabs: agentTabs.filter((tab) => openTabs.includes(tab)) };
  const request = async () => {
    const response = await appFetch("./api/session", {
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

// The strip of open documents at the top of the main island: one tab per open page, the italic preview tab, kept tabs, and the tabs an agent presented.
const tabStrip = document.getElementById("open-tabs");
const PREVIEW_TIP = "Preview tab: the next link replaces it. Double-click to keep it open.";

// A tab names its page by its title: a record by its title, or by its kind and owner when its kind is its name, and a repository file by its name.
// The tooltip gives the full name, a repository file's path, and what the tab's state means.
function tabNames(path) {
  if (parseEntityRef(path)) return { title: pageLabel(path), full: pageLabel(path) };
  const named = describe(path);
  if (named.code) return { title: fileName(path), full: path, code: true };
  const title = named.label === named.kind && named.owner ? `${named.kind} · ${named.owner}` : named.label;
  return { title, full: title === named.kind ? title : `${named.kind} · ${title}` };
}

function renderTabs() {
  if (typeof tabStrip.setTabs !== "function") {
    void customElements.whenDefined("prism-doc-tabs").then(renderTabs);
    return;
  }
  tabStrip.setTabs(openTabs.map((path) => {
    const entity = Boolean(parseEntityRef(path));
    const { title, full, code = false } = tabNames(path);
    const missing = missingTabs.has(path);
    const preview = path === previewTab;
    const agent = agentTabs.includes(path);
    const tip = [missing ? missingNotice(path, { entity, label: title }).tooltip : full, preview ? PREVIEW_TIP : "", agent ? "Presented by the agent." : ""].filter(Boolean).join(" ");
    return { value: path, label: title, tip, selected: path === selectedPath, preview, agent, missing, code };
  }));
}

tabStrip.addEventListener("prism-select", (event) => openRef(event.detail?.value));
tabStrip.addEventListener("prism-tab-keep", (event) => keepTab(event.detail?.value));
tabStrip.addEventListener("prism-tab-close", (event) => closeTab(event.detail?.value));

// Opening a page shows it in a tab and pushes it onto the browser history, so Back, Forward, and the browser's own buttons move through the same pages.
// An ordinary open replaces the preview tab; `keep` opens a kept tab instead, or keeps the preview, and a new tab goes right after the selected one.
function openRef(path, { keep = false, fromHistory = false, keepDrawer = false } = {}) {
  if (!path || !requireApp()) {
    return;
  }
  held = null;
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
  if (navDrawer.isOpen && !keepDrawer) navDrawer.close();
  setBusy(true);
  renderTabs();
  renderNavigation();
  void showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
}

// Keeping the preview tab turns it into an ordinary tab, so the next link opens a new preview beside it.
function keepTab(path) {
  if (previewTab !== path || !requireApp()) {
    return;
  }
  previewTab = null;
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}

// With no tab open, the page says nothing is open and the page bar and sidebar name no page.
function showNothing() {
  welcome();
  pageBar.setTrail([]);
  pageBar.setActions([]);
  currentContext = null;
  contextSnapshot = "";
  renderNavigation();
}

// Closing the selected tab shows the last open tab in its place, and closing the last tab leaves nothing open.
function closeTab(path) {
  if (!path || !requireApp()) return;
  held = null;
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
    setBusy(true);
    renderNavigation();
    void showArtifact(selectedPath);
  } else {
    showNothing();
  }
  void saveSession().catch((error) => showToast(error.message));
}

// Every window of the session shows the same tabs; a page an agent presents, or one another window opened, becomes the next page of this tab's history.
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
  let nextSelectedPath = Object.hasOwn(snapshot, "activeTab")
    ? snapshot.activeTab
    : nextTabs.includes(selectedPath) ? selectedPath : nextTabs[0] ?? null;
  // A held page stays shown while the session still selects the tab it held it beside; any other selection is followed.
  if (held && nextSelectedPath === held.sessionTab && nextTabs.includes(held.page)) nextSelectedPath = held.page;
  else held = null;
  const nextPreview = nextTabs.includes(snapshot.previewTab) ? snapshot.previewTab : null;
  const nextAgentTabs = Array.isArray(snapshot.agentTabs) ? snapshot.agentTabs.filter((tab) => nextTabs.includes(tab)) : [];
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  previewTab = nextPreview;
  agentTabs = nextAgentTabs;
  const next = nextSelectedPath && nextTabs.includes(nextSelectedPath) ? nextSelectedPath : null;
  if (next === selectedPath) {
    renderTabs();
    return;
  }
  selectedPath = next;
  lastSnapshot = "";
  renderTabs();
  if (!next) {
    updateLocation(null);
    showNothing();
    return;
  }
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
  // The folder shows under the checkout's name, as two checkouts of one repository differ by their folders.
  const folder = element("span", "project-folder", entry.projectRoot);
  folder.slot = "detail";
  item.append(folder);
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

// The review app lists its projects; a session server has no list, so its page stops asking.
let projectPoller = null;

async function refreshProjects() {
  let listing;
  try {
    const response = await appFetch("./api/projects", { cache: "no-store", deadlineMs: POLL_DEADLINE_MS });
    if (response.status === 404) projectPoller?.stop();
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
    // Choosing the workspace opens its records through the checkout already open, else one an agent is using, else the one used last.
    // Every checkout of a workspace shows the same records, so only code views, such as source files and the index, differ between them.
    const opened = members.find(({ entry }) => entry.id === listing.current) ?? members.find(({ entry }) => entry.live) ?? listing.projects.map((entry) => members.find((member) => member.entry === entry)).find(Boolean);
    const through = [opened.identity.repository, workspaceName(opened.identity) ?? folderName(opened.entry.projectRoot)].filter(Boolean).join(" / ");
    const repositoryCount = new Set(members.map(({ identity }) => identity.repository)).size;
    const head = document.createElement("prism-menu-item");
    head.setAttribute("value", opened.entry.url);
    head.setAttribute("tip", `Workspace ${storeName(shared.store)}: ${members.length} ${members.length === 1 ? "checkout" : "checkouts"}${repositoryCount > 1 ? ` of ${repositoryCount} repositories` : ""} keep their records in ${shared.store.location ?? shared.store.label}, so their roadmap, initiatives, and gates are the same. Opens through ${through}.`);
    head.append(`Workspace ${storeName(shared.store)}`);
    const via = element("span", "project-folder", `Opens through ${through}`);
    via.slot = "detail";
    head.append(via);
    group.append(head, ...members.map((member) => projectItem(member, listing.current, { gates: false, repository: true })));
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
  projectTile.setAttribute("name", workspace ?? identity.repository ?? folderName(projectRoot));
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
  // The top bar's bell, which shows while the rail is hidden, counts the same recorded questions and opens Attention.
  if (count > 0) {
    attentionButton.setAttribute("count", String(count));
    attentionButton.setAttribute("count-label", `${count} ${count === 1 ? "question" : "questions"}`);
  } else {
    attentionButton.removeAttribute("count");
    attentionButton.removeAttribute("count-label");
  }
  document.title = signalTitle(baseTitle(), count);
  if (signals.icon && signals.plainIcon) {
    if (count > 0) {
      signals.badged ??= await appFetch(signals.plainIcon).then((response) => response.ok ? response.text() : null).then((svg) => svg && `data:image/svg+xml,${encodeURIComponent(badgedIcon(svg))}`).catch(() => null);
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

// A tab joins and leaves the shared stream itself, with its own write session, so the server counts it as a writable tab exactly when it holds one.
async function joinStream(stream, tab) {
  const response = await appFetch("./api/events/join", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ stream, tab }), deadlineMs: POLL_DEADLINE_MS });
  return response.ok;
}

function leaveStream(stream, tab, { keepalive = false } = {}) {
  return appFetch("./api/events/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stream, tab }), keepalive, deadlineMs: POLL_DEADLINE_MS });
}

function onStreamEvent(name, data) {
  if (name === "notice") {
    notices.delete(data.projectId);
    notices.set(data.projectId, data);
    renderNotices();
  } else if (name === "action") {
    // An applied action of this page or of another checkout's page on the same records: views that show it update without a reload.
    document.dispatchEvent(new CustomEvent("prism:action", { detail: data }));
  } else if (name === "session") {
    sessionConnected = true;
    try {
      synchronizeSession(data);
    } catch (error) {
      showToast(error.message);
    }
  }
}

function connectSessionEvents() {
  relay = createEventRelay({
    join: joinStream,
    leave: leaveStream,
    onEvent: onStreamEvent,
    onStatus: ({ open, joined }) => {
      sessionConnected = joined;
      if (open) reportRefresh(true);
    }
  });
  window.addEventListener("pagehide", () => relay.close());
  // A page restored from the back-forward cache left the stream as it went, so it loads again to rejoin it.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
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
  const next = connectionState({ ...probes, now: Date.now(), streamOpen: Boolean(relay?.open) });
  if (next === connection) return;
  const recovered = connection === "stopped" && next === "live";
  connection = next;
  connectionBanner.hidden = next !== "retrying";
  appGoneBanner.hidden = next !== "stopped";
  if (!recovered) return;
  // A stream that met another listener on the port gave up, so a returning app needs a new one; the next poll redraws the open view.
  relay?.reconnect();
  lastSnapshot = "";
  void projectPoller?.now();
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
  if (parsed.page) return attentionPageLabel(path, parsed.page);
  if (ENTITY_LABELS[parsed.kind]) return ENTITY_LABELS[parsed.kind];
  const indexed = navigation.index?.find((entry) => entry.ref === path)?.label;
  if (indexed) return indexed;
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  return parsed.kind === "slice" ? parsed.slug : parsed.id;
}

// A filtered page of Attention is named by its filter: a kind, Answered in the last 7 days, or an initiative's title.
function attentionPageLabel(path, page) {
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  const kind = [...ATTENTION_KINDS, ["answered", "Answered in the last 7 days"]].find(([name]) => name === page);
  if (kind) return kind[1];
  const id = page.replace(/^work\//, "");
  return navigation.places?.attention?.work?.find((entry) => entry.id === id)?.title ?? navigation.initiatives?.find((item) => item.id === id)?.title ?? id;
}

// The trail of the page's place, initiative, and slice by title; a record of Prism's ends with its kind, since the crumbs before it name its owner.
// The first crumb of a page of a place names the place and carries it, so the page bar draws it as the link that chooses the place.
function trailOf(path) {
  const trail = currentContext?.ref === path ? currentContext.value.trail : [{ ref: path, label: pageLabel(path) }];
  return trail.map((crumb, index) => {
    if (crumb.place) return { ref: crumb.ref, label: crumb.label, place: crumb.place };
    if (!crumb.ref || parseEntityRef(crumb.ref)) return { ref: crumb.ref, label: crumb.ref === null && crumb.label === "Files" && !describe(path).code ? "Documents" : crumb.label };
    const named = describe(crumb.ref);
    if (named.code) return { ref: crumb.ref, label: crumb.ref, code: true };
    const owned = index > 0 && trail.slice(0, index).some((before) => before.label === named.owner);
    return { ref: crumb.ref, label: owned || named.label === named.kind ? named.kind : named.label };
  });
}

const STATE_WORDS = { envisioned: "Envisioned", planned: "Planned", "in-progress": "In progress", shipped: "Shipped", superseded: "Superseded", unlisted: "Not on the roadmap" };
const STATUS_WORDS = { "not-started": "Not started", "in-progress": "In progress", blocked: "Blocked", split: "Split", done: "Done" };
const PHASE_STEPS = [["requirements", "Requirements"], ["design", "Design"], ["frozen", "Tests frozen"], ["build", "Build"], ["review", "Review"], ["shipped", "Shipped"]];

function pageHref(ref) {
  return `./review?artifact=${encodeURIComponent(ref)}`;
}

function kitElement(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : String(value));
  if (text) node.textContent = text;
  return node;
}

function treeItem(value, label, { selected = false, expanded = false, start = [], end = [], children = [], tip = null, href = pageHref(value) } = {}) {
  const item = document.createElement("prism-tree-item");
  item.setAttribute("value", value);
  item.setAttribute("label", label);
  if (href) item.setAttribute("href", href);
  if (tip) item.setAttribute("tip", tip);
  item.toggleAttribute("selected", selected);
  item.toggleAttribute("expanded", expanded);
  for (const node of start) {
    node.slot = "start";
    item.append(node);
  }
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

// A group of a place's sidebar starts with its name as a level 3 heading, and its count when it has one.
function section(label, count = null) {
  const heading = element("h3", "nav-section");
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

function navIcon(name) {
  return kitElement("prism-icon", { name });
}

function meta(text) {
  return element("span", "nav-meta", text);
}

// The phase a slice is in, as the roadmap draws it: a slice that has not started and has no design is in no phase yet.
function slicePhaseStep(node) {
  if (node.status === "not-started" && !node.designed) return null;
  const index = currentPhase({ status: node.status, design: node.designed ? { review: node.review } : null });
  return PHASE_STEPS[Math.min(index, PHASE_STEPS.length - 1)];
}

function isActiveSlice(node, ref) {
  if (node.status === "in-progress" || node.status === "blocked") return true;
  const claim = claimIndex?.claimFor(ref);
  return Boolean(claim && !claim.expired);
}

// A claim's line for a tooltip: who holds the slice, for what, and until when.
function claimLine(claim) {
  if (!claim) return null;
  const end = Date.parse(claim.expiresAt);
  const until = Number.isFinite(end) ? `${claim.expired || end <= Date.now() ? "expired" : "until"} ${new Date(end).toLocaleString()}` : null;
  return [`${claim.label} holds it for ${claim.activity}`, until].filter(Boolean).join(", ");
}

function leafCounts(nodes) {
  const leaves = nodes.filter((node) => node.depth > 0 && !node.hasChildren);
  return { done: leaves.filter((node) => node.status === "done").length, total: leaves.length };
}

// A split slice's glyph sums up its descendants: shipped once all are done, in progress once one has started, planned before.
function branchState(id, nodes, slug) {
  const below = [];
  const visit = (parent) => {
    for (const child of nodes.filter((node) => node.parent === parent)) {
      below.push(child);
      visit(child.slug);
    }
  };
  visit(slug);
  const leaves = below.filter((node) => !node.hasChildren);
  if (leaves.length && leaves.every((node) => node.status === "done")) return "shipped";
  if (below.some((node) => node.status !== "not-started" || isActiveSlice(node, `slice:${id}/${node.slug}`))) return "in-progress";
  return "planned";
}

// A slice is being worked on while it is in progress or under a live claim.
function isWorkingSlice(node, ref) {
  if (node.status === "in-progress") return true;
  const claim = claimIndex?.claimFor(ref);
  return Boolean(claim && !claim.expired);
}

function isBelow(bySlug, node, ancestor) {
  for (let slug = node.parent; slug; slug = bySlug.get(slug)?.parent) if (slug === ancestor) return true;
  return false;
}

// One slice of Work as a row: its phase glyph in its phase's color, or a split slice's state glyph, its title, `Blocked`, its blocking findings, and its holder.
function sliceRow(id, node, nodes) {
  const ref = `slice:${id}/${node.slug}`;
  const start = [];
  const end = [];
  const status = STATUS_WORDS[node.status] ?? node.status;
  const phase = slicePhaseStep(node);
  const bySlug = new Map(nodes.map((other) => [other.slug, other]));
  let stateWord;
  if (node.hasChildren) {
    const state = branchState(id, nodes, node.slug);
    stateWord = `Split · ${STATE_WORDS[state]}`;
    start.push(kitElement("prism-state", { state, label: stateWord }));
  } else {
    stateWord = [phase ? phase[1] : null, status].filter(Boolean).join(" · ");
    start.push(kitElement("prism-phase", { phase: phase?.[0] ?? null, label: stateWord }));
  }
  if (node.status === "blocked") end.push(element("span", "prism-tree-flag", "Blocked"));
  if (node.blocking) end.push(badge(String(node.blocking), "danger", `${node.blocking} blocking ${node.blocking === 1 ? "finding" : "findings"}`));
  const claim = claimIndex?.claimFor(ref);
  if (claim) end.push(claimElement(claim, "avatar"));
  const counts = node.hasChildren ? leafCounts(nodes.filter((other) => isBelow(bySlug, other, node.slug))) : null;
  const tip = [node.title, stateWord, counts && counts.total ? `${counts.done} of ${counts.total} shipped` : null, node.blocking ? `${node.blocking} blocking ${node.blocking === 1 ? "finding" : "findings"}` : null, claimLine(claim)].filter(Boolean).join(" · ");
  return treeItem(ref, node.title, { selected: selectedPath === ref, start, end, tip });
}

// The most unfinished slices an expanded initiative of Work lists before the row that leads to all of them.
const WORK_SHORT_LIST = 5;

/**
 * One initiative of Work: its state glyph, its title, and its shipped leaf slices out of all.
 * Expanded, it lists at most five unfinished leaf slices, the open one first, then those being worked on, then blocked ones, then the rest,
 * each part in the order of the slice tree, and then one row for the rest that opens the initiative's page.
 * While the filter holds text, it lists the slices whose titles hold it instead, and expands when one does.
 */
function workInitiativeItem(item, nodes, scope, query) {
  const ref = `initiative:${item.id}`;
  const inScope = scope.kind === "initiative" && scope.id === item.id;
  const leaves = nodes.filter((node) => node.depth > 0 && !node.hasChildren);
  const counts = leafCounts(nodes);
  const state = item.state === "unlisted" ? "planned" : item.state;
  const stateWord = STATE_WORDS[item.state] ?? item.state;
  const end = counts.total ? [meta(`${counts.done}/${counts.total}`)] : [];
  const tip = [item.title, stateWord, counts.total ? `${counts.done} of ${counts.total} shipped` : null].filter(Boolean).join(" · ");
  const sliceRef = (node) => `slice:${item.id}/${node.slug}`;
  let children;
  let expanded;
  if (query) {
    children = nodes.filter((node) => node.depth > 0 && node.title.toLowerCase().includes(query)).map((node) => sliceRow(item.id, node, nodes));
    expanded = children.length > 0;
  } else {
    const unfinished = leaves.filter((node) => node.status !== "done");
    const open = inScope ? unfinished.find((node) => node.slug === scope.current) : null;
    const rest = unfinished.filter((node) => node !== open);
    const working = rest.filter((node) => isWorkingSlice(node, sliceRef(node)));
    const blocked = rest.filter((node) => !working.includes(node) && node.status === "blocked");
    const others = rest.filter((node) => !working.includes(node) && !blocked.includes(node));
    const shown = [open, ...working, ...blocked, ...others].filter(Boolean).slice(0, WORK_SHORT_LIST);
    children = shown.map((node) => sliceRow(item.id, node, nodes));
    const more = unfinished.length - shown.length;
    const done = leaves.length - unfinished.length;
    if (more > 0 || done > 0) {
      const label = more > 0 ? `${more} more unfinished` : "All slices";
      const moreTip = [more > 0 ? `${more} more unfinished` : null, done > 0 ? `${done} done` : null].filter(Boolean).join(", ");
      children.push(treeItem(ref, label, { start: [navIcon("more")], end: done > 0 ? [meta(`${done} done`)] : [], tip: `${moreTip}: open ${item.title} for all its slices` }));
    }
    // An initiative expands when the person expanded it, when its page or one of its slices' pages is open, or when one of its slices is being worked on.
    const hasWorking = nodes.some((node) => node.depth > 0 && isWorkingSlice(node, sliceRef(node)));
    expanded = children.length > 0 && (treeToggles.get(ref) ?? (inScope || hasWorking));
  }
  return treeItem(ref, item.title, { selected: selectedPath === ref, expanded, start: [kitElement("prism-state", { state, label: stateWord })], end, children, tip });
}

// The current place: the one the person chose last in this browser, or the one a `place=` address names, and Attention when none was stored.
const PLACE_KEY = "prism.review.place";

function readStoredPlace() {
  try {
    const stored = localStorage.getItem(PLACE_KEY);
    return placeNamed(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storePlace(name) {
  try {
    localStorage.setItem(PLACE_KEY, name);
  } catch {
    // A browser without storage keeps the place for this page only.
  }
}

const addressedPlace = new URLSearchParams(location.search).get("place");
let currentPlace = placeNamed(addressedPlace) ? addressedPlace : readStoredPlace() ?? DEFAULT_PLACE;
if (placeNamed(addressedPlace)) storePlace(addressedPlace);

/**
 * Makes a place current and shows its sidebar, also when the sidebar was hidden; the open page stays.
 * Choosing Roadmap on the rail also opens the Roadmap page, as its sidebar link would; choosing the current place again changes nothing.
 */
function choosePlace(name, { fromRail = false, keep = false } = {}) {
  if (!placeNamed(name)) return;
  if (wideWindow.matches && shell.classList.contains("sidebar-collapsed")) setSidebarCollapsed(false);
  if (name === currentPlace) return;
  currentPlace = name;
  storePlace(name);
  renderNavigation();
  // Roadmap opens its page as its sidebar entry would, in a kept tab from a Ctrl or Cmd click, and the drawer stays open, as it does for every place.
  if (fromRail && name === "roadmap") openRef("roadmap", { keep, keepDrawer: true });
}

// The rail's place buttons, in the order of PLACES; the Attention button counts the recorded questions that wait for an answer.
function renderRail(rail, questions) {
  const items = new Map([...rail.querySelectorAll("prism-rail-item[data-place]")].map((item) => [item.dataset.place, item]));
  for (const place of PLACES) {
    let item = items.get(place.name);
    if (!item) {
      item = kitElement("prism-rail-item", { "data-place": place.name, value: place.name, label: place.label, icon: place.icon });
      rail.append(item);
    }
    item.setAttribute("pressed", String(place.name === currentPlace));
    if (place.name === "attention" && questions > 0) {
      item.setAttribute("count", String(questions));
      item.setAttribute("count-label", `${questions} ${questions === 1 ? "question" : "questions"}`);
    } else {
      item.removeAttribute("count");
      item.removeAttribute("count-label");
    }
  }
}

// Each place's own navigation below its head, by the place's name; a place lists only what Prism provides, and nothing disabled or planned.
const PLACE_NAVIGATION = {
  attention: attentionNavigation,
  work: workNavigation,
  roadmap: roadmapNavigation,
  knowledge: knowledgeNavigation,
  history: historyNavigation
};

/**
 * Attention: Everything, each kind with its count, the initiatives with the most items and a row for the rest, and this week's answered questions;
 * each entry opens Attention filtered to it, and the workflow settings warnings follow as a note.
 */
function attentionNavigation() {
  const place = navigation.places?.attention ?? {};
  const kinds = place.kinds ?? {};
  const count = (value) => [meta(String(value ?? 0))];
  const row = (ref, label, icon, value, tip = null) => treeItem(ref, label, { selected: selectedPath === ref, start: [navIcon(icon)], end: count(value), tip });
  const parts = [tree("Everything", [row("attention", "Everything", "bell", place.everything)])];
  parts.push(section("By kind"), tree("By kind", ATTENTION_KINDS.map(([kind, label, icon]) => row(`attention:${kind}`, label, icon, kinds[kind]))));
  const work = place.work ?? [];
  if (work.length) {
    const shown = place.shown ?? 3;
    const workRow = (entry) => row(`attention:work/${entry.id}`, entry.title, "tree", entry.count, `${entry.title} · ${entry.count} ${entry.count === 1 ? "item" : "items"}`);
    const rows = work.slice(0, shown).map(workRow);
    const rest = work.slice(shown);
    if (rest.length) {
      const total = rest.reduce((sum, entry) => sum + entry.count, 0);
      const tip = `${attentionMoreOpen ? "Hide" : "Show"} ${rest.length} more ${rest.length === 1 ? "initiative" : "initiatives"}`;
      rows.push(treeItem(ATTENTION_MORE, `${rest.length} more`, { start: [navIcon("more")], end: count(total), tip, href: null }));
      if (attentionMoreOpen) rows.push(...rest.map(workRow));
    }
    parts.push(section("By work"), tree("By work", rows));
  }
  parts.push(section("Answered"), tree("Answered", [row("attention:answered", "Answered in the last 7 days", "check-circle", place.answered)]));
  if (navigation.diagnostics?.length) {
    const warnings = document.createElement("prism-disclosure");
    warnings.className = "nav-diagnostics";
    warnings.setAttribute("summary", `${navigation.diagnostics.length} workflow ${navigation.diagnostics.length === 1 ? "setting warning" : "setting warnings"}`);
    const list = element("ul", "");
    list.append(...navigation.diagnostics.map((item) => {
      const line = element("li", "");
      line.innerHTML = messageHtml(item.message);
      return line;
    }));
    warnings.append(list);
    parts.push(warnings);
  }
  return parts;
}

// Sidebar rows that change the sidebar instead of opening a page, by their value.
const NAVIGATION_ACTIONS = {
  [ATTENTION_MORE]: () => {
    attentionMoreOpen = !attentionMoreOpen;
    renderNavigation();
  }
};

// Work's filter field stays one element across renders, so typing in it keeps its focus and its text while the groups below it change.
let workFilterField = null;

function workFilter() {
  if (!workFilterField) {
    workFilterField = kitElement("prism-field", { type: "search", variant: "filter", label: "Filter work", placeholder: "Filter work", class: "nav-filter" });
    const icon = navIcon("filter");
    icon.slot = "start";
    icon.setAttribute("size", "sm");
    workFilterField.append(icon);
    workFilterField.addEventListener("input", () => renderNavigation());
    workFilterField.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !workFilterField.value) return;
      event.preventDefault();
      event.stopPropagation();
      workFilterField.value = "";
      renderNavigation();
    });
  }
  return workFilterField;
}

/**
 * Work: designed, unshipped initiatives grouped by state, each group with its count and an empty one left out, in the server's order,
 * then the note that says where the rest went; the filter keeps the initiatives and slices whose titles hold its text.
 */
function workNavigation({ scope }) {
  const field = workFilter();
  const typed = (field.value ?? "").trim();
  const query = typed.toLowerCase();
  const byId = new Map((navigation.initiatives ?? []).map((item) => [item.id, item]));
  const parts = [field];
  let shown = 0;
  for (const group of navigation.places?.work?.groups ?? []) {
    const rows = [];
    for (const { id, title } of group.initiatives) {
      const listed = byId.get(id) ?? { id, title, state: group.key === "unlisted" ? "unlisted" : "planned" };
      const open = scope.kind === "initiative" && scope.id === id;
      const item = { ...listed, title: open ? scope.title ?? listed.title ?? title : listed.title ?? title };
      const nodes = (open ? scope.tree : null) ?? listed.tree ?? [];
      if (query && !item.title.toLowerCase().includes(query) && !nodes.some((node) => node.depth > 0 && node.title.toLowerCase().includes(query))) continue;
      rows.push(workInitiativeItem(item, nodes, scope, query));
    }
    if (!rows.length) continue;
    shown += rows.length;
    parts.push(section(group.label, rows.length), tree(group.label, rows));
  }
  if (!shown) parts.push(element("p", "nav-note", typed ? `No work matches "${typed}".` : "Nothing is designed and unshipped."));
  if (scope.kind === "initiative" && scope.valid === false && (navigation.places?.work?.groups ?? []).some((group) => group.initiatives.some((entry) => entry.id === scope.id))) parts.push(element("p", "nav-note", "The initiative record is invalid."));
  const foot = element("p", "nav-foot");
  const glyph = element("span", "nav-foot-glyph");
  glyph.append(kitElement("prism-icon", { name: "clock", size: "xs" }));
  foot.append(glyph, element("span", "", "Shipped work moves to History. Emerging and unplanned items stay on the Roadmap."));
  parts.push(foot);
  return parts;
}

// The Roadmap place shows its page as current on the rail and in its head, so its one entry leads to the page without a selected row.
function roadmapNavigation() {
  return [tree("Roadmap", [treeItem("roadmap", "Roadmap", { start: [navIcon("roadmap")] })])];
}

function knowledgeNavigation() {
  const glossary = navigation.glossary ?? {};
  const library = navigation.library ?? {};
  const count = (value) => Number.isInteger(value) ? [meta(String(value))] : [];
  return [section("Browse by kind"), tree("Browse by kind", [
    treeItem("requirements", ENTITY_LABELS.requirements, { selected: selectedPath === "requirements", start: [navIcon("list")], end: count(library.requirements) }),
    treeItem("decisions", ENTITY_LABELS.decisions, { selected: selectedPath === "decisions", start: [navIcon("scale")], end: count(library.decisions) }),
    treeItem("glossary", "Glossary", { selected: selectedPath === "glossary", start: [navIcon("book")], end: glossary.exists ? count(library.terms) : [element("span", "nav-state", "missing")] })
  ])];
}

// The initiatives with a shipped or superseded decision, each leading to its page.
function historyNavigation() {
  const settled = (navigation.initiatives ?? []).filter((item) => item.place === "history");
  if (!settled.length) return [element("p", "nav-note", "Nothing has shipped yet.")];
  return [tree("History", settled.map((item) => {
    const ref = `initiative:${item.id}`;
    const stateWord = STATE_WORDS[item.state] ?? item.state;
    return treeItem(ref, item.title, { selected: selectedPath === ref, start: [kitElement("prism-state", { state: item.state, label: stateWord })], tip: `${item.title} · ${stateWord}` });
  }))];
}

// The rail, the current place's head, and the place's own navigation; the sidebar changes only when the person chooses a place,
// and marks the open page only when the place lists it.
let navigationKey = "";

function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  void updateAttentionSignals(attention.gates ?? 0);
  for (const rail of [shellRail, drawerRail]) renderRail(rail, attention.gates ?? 0);
  const entity = Boolean(parseEntityRef(selectedPath ?? ""));
  const claims = claimIndex ? [...claimIndex.live(), ...claimIndex.expired()].map((claim) => [claim.ref, claim.expiresAt, claim.label]) : [];
  const key = JSON.stringify([currentPlace, selectedPath, scope, attention, navigation.initiatives, navigation.places, navigation.glossary, navigation.library, navigation.diagnostics, claims, [...treeToggles], workFilterField?.value ?? "", attentionMoreOpen]);
  if (key === navigationKey) return;
  navigationKey = key;
  const focused = document.activeElement?.closest?.("prism-tree-item");
  const refocus = focused && navRoot.contains(focused) ? focused.getAttribute("value") : null;
  const place = placeNamed(currentPlace);
  placeHead.setAttribute("heading", place.label);
  placeHead.setAttribute("subtitle", place.subtitle);
  sidebar.setAttribute("aria-label", place.label);
  // A field of the place, such as Work's filter, is the same element after the render, so it keeps the focus and the caret it had.
  const field = document.activeElement?.closest?.("prism-field");
  const typing = field && navRoot.contains(field) ? { field, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  navRoot.replaceChildren(...PLACE_NAVIGATION[place.name]({ scope, entity }));
  if (typing && navRoot.contains(typing.field) && typing.field.control) {
    typing.field.control.focus();
    try {
      typing.field.control.setSelectionRange(typing.start, typing.end);
    } catch {
      // A control without a caret keeps the focus only.
    }
  }
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
  pageBar.setTrail(trailOf(path), path);
  // A slice's or initiative's tab takes the title its context names.
  renderTabs();
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
  if (!missingTabs.has(path)) {
    missingTabs.add(path);
    renderTabs();
  }
  if (path !== selectedPath) return;
  if (lastSnapshot !== `missing:${path}`) {
    lastSnapshot = `missing:${path}`;
    renderedPath = null;
    document.body.classList.remove("has-maximized");
    pageBar.setActions([]);
    renderMissing(artifact, path, { entity: Boolean(parseEntityRef(path)), label: pageLabel(path), onClose: () => closeTab(path) });
  }
  setBusy(false);
}

function updateMissingTabs(reported) {
  const { next, changed } = nextMissingTabs(missingTabs, reported);
  missingTabs = next;
  if (changed) renderTabs();
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
  const response = await appFetch(`./api/entity?ref=${encodeURIComponent(path)}`, { cache: "no-store" });
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
  const response = await appFetch(`./api/artifact?path=${encodeURIComponent(path)}`, { cache: "no-store" });
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
  const response = await appFetch(url, { cache: "no-store" });
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
      // A diagram mounted after the page drew, such as on a slice's Diagram tab, gets its Maximize control too.
      if (path === selectedPath) decorateMaximize(path);
    },
    // A gate answer is the gate's answer action, applied against the revision its listing shows.
    async answerGate({ initiative, id, choice, note }) {
      if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
      const target = `gate:${initiative}/${id}`;
      const unanswered = () => {
        throw new Error("The review app did not answer, so the answer was not recorded. Try again in a moment.");
      };
      const listed = await appFetch(`./api/actions?target=${encodeURIComponent(target)}`, { headers: writeHeaders() }).catch(unanswered);
      const listing = await listed.json().catch(() => ({}));
      if (!listed.ok) throw Object.assign(new Error(listing.message ?? "The answer was not recorded."), { code: listing.code === "unknown_target" ? "unknown_gate" : listing.code });
      const action = (listing.actions ?? []).find((item) => item.id === "gate.answer");
      const names = new Set((action?.fields ?? []).map((field) => field.name));
      const input = Object.fromEntries([["choice", choice], ["note", note]].filter(([name, value]) => names.has(name) && value !== null && value !== undefined && value !== ""));
      const response = await appFetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ action: "gate.answer", target, input, revision: action?.revision ?? null }) }).catch(unanswered);
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

// The drawer holds a rail of its own beside the sidebar, which moves into the drawer while the drawer is open, so one set of trees serves both.
// Focus goes to the sidebar's selected item, or else to the current place's button of the rail beside it.
function focusPlaces(rail) {
  const selected = navRoot.querySelector("prism-tree-item[selected]");
  if (selected) return selected.focus();
  rail.querySelector(`prism-rail-item[data-place="${currentPlace}"]`)?.focus();
}

// Above 1100px the sidebar can hide and leave the rail; the choice is remembered in this browser, and narrower windows ignore it.
const SIDEBAR_KEY = "prism.review.sidebar";
const wideWindow = matchMedia("(min-width: 1101px)");

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  shell.classList.toggle("sidebar-collapsed", collapsed);
  const action = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("label", action);
  sidebarToggle.setAttribute("tip", `${action} ([)`);
  if (!remember) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // A browser without storage keeps the choice for this page only.
  }
}

// The drawer places its children in its body a microtask after they arrive, so focus moves once the sidebar sits inside the open drawer.
async function openDrawer() {
  drawerPlaces.append(sidebar);
  navDrawer.show();
  await Promise.resolve();
  if (navDrawer.isOpen && drawerPlaces.contains(sidebar)) focusPlaces(drawerRail);
}

// At 720px and below the search button is a bare icon, as the other top bar tools are; its label still names it.
function watchSearchWidth() {
  const jump = document.getElementById("jump");
  const narrow = matchMedia("(max-width: 720px)");
  const apply = () => jump.setAttribute("variant", narrow.matches ? "chrome" : "search");
  apply();
  narrow.addEventListener("change", apply);
}

function closeDrawer() {
  if (sidebar.parentElement !== appShell) railDock.after(sidebar);
}

// Above 1100px the rail and the sidebar stand beside the page, so a drawer left open as the window widens closes and gives them back.
function watchDrawerWidth() {
  const wide = matchMedia("(min-width: 1101px)");
  // Focus in the rail or the sidebar would fall to the page when they hide, so it moves to the Navigation button that opens the drawer.
  let navigationFocused = false;
  document.addEventListener("focusin", (event) => { navigationFocused = sidebar.contains(event.target) || shellRail.contains(event.target); });
  wide.addEventListener("change", () => {
    if (!wide.matches) {
      if (navDrawer.isOpen || !navigationFocused) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || sidebar.contains(active) || shellRail.contains(active)) document.getElementById("nav-button").focus();
      });
      return;
    }
    if (!navDrawer.isOpen) return closeDrawer();
    const active = document.activeElement;
    const item = active?.closest?.("prism-tree-item");
    const inDrawer = Boolean(active && navDrawer.contains(active));
    const value = item && sidebar.contains(item) ? item.getAttribute("value") : null;
    navDrawer.close();
    closeDrawer();
    // The drawer returns focus to the Navigation button that opened it, which is hidden now, so focus moves to the rail and the sidebar beside the page.
    const now = document.activeElement;
    if (!inDrawer && now && now !== document.body && !now.closest("#nav-button, .topbar-navigation") && now.getClientRects().length > 0) return;
    const again = value ? [...navRoot.querySelectorAll("prism-tree-item")].find((node) => node.getAttribute("value") === value) : null;
    if (again) again.focus();
    else focusPlaces(shellRail);
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
    onOpen: (ref, event) => openRef(ref, { keep: Boolean(event?.ctrlKey || event?.metaKey) }),
    onPlace: (name) => choosePlace(name)
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
  projectPoller = createPoller({ run: refreshProjects, interval: 5000 });
  projectButton.addEventListener("click", () => void projectPoller.now());
  projectMenu.addEventListener("prism-select", (event) => {
    const url = event.detail?.value;
    if (url && url !== location.href) location.href = url;
  });
  void projectPoller.start();
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
    scopes: document.getElementById("palette-scopes"),
    count: document.getElementById("palette-count"),
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
  // Ctrl-click or Cmd-click on a sidebar item opens it as a kept tab, and a double click keeps the tab it opened.
  let navKeep = false;
  navRoot.addEventListener("click", (event) => {
    navKeep = event.ctrlKey || event.metaKey;
  }, { capture: true });
  navRoot.addEventListener("prism-select", (event) => {
    const ref = event.detail?.value;
    if (ref && Object.hasOwn(NAVIGATION_ACTIONS, ref)) NAVIGATION_ACTIONS[ref]();
    else if (ref) openRef(ref, { keep: navKeep });
    navKeep = false;
  });
  navRoot.addEventListener("dblclick", (event) => {
    const ref = event.target.closest?.("prism-tree-item")?.getAttribute("value");
    if (ref && ref === selectedPath) keepTab(ref);
  });
  navRoot.addEventListener("prism-toggle", (event) => {
    const value = event.detail?.value;
    if (!value) return;
    treeToggles.set(value, Boolean(event.detail.expanded));
    renderNavigation();
  });
  // A place button chooses its place; in the drawer the drawer stays open, so the person can look through the places before choosing a page.
  for (const rail of [shellRail, drawerRail]) {
    rail.addEventListener("prism-select", (event) => {
      if (event.target === sidebarToggle) return;
      choosePlace(event.detail?.value, { fromRail: true, keep: Boolean(event.detail?.keep) });
    });
  }
  document.getElementById("nav-button").addEventListener("click", openDrawer);
  setSidebarCollapsed(readSidebarCollapsed(), { remember: false });
  sidebarToggle.addEventListener("prism-select", () => setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed")));
  navDrawer.addEventListener("prism-close", closeDrawer);
  watchDrawerWidth();
  document.getElementById("jump").addEventListener("click", () => palette.show());
  attentionButton.addEventListener("prism-select", () => openRef("attention"));
  watchSearchWidth();
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
  const overlayOpen = () => [...document.querySelectorAll("prism-dialog:not([modeless]), prism-popover, prism-menu")].some((overlay) => overlay.isOpen ?? overlay.hasAttribute("open"));
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || Boolean(document.activeElement?.closest?.("prism-field"));
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (palette.isOpen()) palette.hide();
      else palette.show();
    } else if (event.key === "," && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      // Ctrl+, or Meta+, opens the Appearance menu on its first choice, as its title row shows.
      event.preventDefault();
      const menu = document.getElementById("appearance-menu");
      if (menu.isOpen) menu.close({ focus: true });
      else menu.show({ focus: "first" });
    } else if (event.key === "[" && !typing && !overlayOpen() && wideWindow.matches && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed"));
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
    } else if (event.key === "Escape" && document.getElementById("evidence-drawer").isOpen) {
      // The evidence drawer leaves the page usable, so Escape from the page closes it as well as Escape inside it.
      closeEvidence();
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
  document.addEventListener("click", noteLinkOpened, { capture: true });
  document.addEventListener("auxclick", noteLinkOpened, { capture: true });
  if (requestedPath && requestedPath !== selectedPath && selectedPath && openTabs.includes(selectedPath) && openedFromLink(requestedPath)) {
    holdPage(requestedPath);
  } else if (requestedPath && requestedPath !== selectedPath) {
    openRef(requestedPath, { fromHistory: true });
  } else if (!selectedPath) {
    openRef(openTabs[0] ?? "attention", { fromHistory: true });
  } else {
    updateLocation(selectedPath);
    setBusy(true);
    renderTabs();
    await showArtifact(selectedPath);
  }
  let polls = 0;
  // The page checks its project every 1.5 s, one check at a time, and only while the tab is shown; a check without an answer within its deadline counts as failed.
  const indexPoller = createPoller({ interval: 1500, run: async () => {
    // Shown action lists check their listing every few seconds, so a change an agent made shows without a reload.
    if (++polls % 3 === 0 && connection !== "stopped") document.dispatchEvent(new CustomEvent("prism:poll"));
    try {
      const refreshed = await appFetch("./api/index", { cache: "no-store", deadlineMs: POLL_DEADLINE_MS }).catch(() => null);
      const snapshot = refreshed?.ok ? await refreshed.json().catch(() => null) : null;
      reportRefresh(Boolean(snapshot));
      if (snapshot) {
        renderStoreSync(snapshot);
        prismRecords = new Set(snapshot.artifacts);
        availableArtifacts = new Set([...snapshot.artifacts, ...(snapshot.sources ?? [])]);
        updateMissingTabs(snapshot.missingTabs);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          // Claims are read on their own schedule, so only a new or removed initiative reads them again at once.
          const initiatives = (list) => JSON.stringify((list ?? []).map((item) => item.id));
          const added = initiatives(snapshot.navigation?.initiatives) !== initiatives(navigation.initiatives);
          navigation = snapshot.navigation;
          renderNavigation();
          renderTabs();
          if (added) void claimIndex.refresh().catch(() => {});
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
  } });
  // The first check waits one interval, since the page has just drawn from a fresh index.
  setTimeout(() => void indexPoller.start(), 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<div class="document-sheet"><p class="error">${escapeHtml(error.message)}</p></div>`;
  setBusy(false);
});
