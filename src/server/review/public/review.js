import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, parseEntityRef, recordKind, recordLabel, renderEntity } from "./views/entities.js";
import { createPalette } from "./views/palette.js";
import { highlight, highlightLines, languageOf } from "./views/highlight.js";
import { anchorTarget, decorateDocuments, HEADING_PREFIX, LINE_RANGE, linkTargets, markCurrentSection, renderText, revealInDocument } from "./views/markdown.js";
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
import { artifactReviewHtml, focusAfterMore, mountArtifactReview, readListedComments } from "./views/artifact-review.js";
import { themeDiagram } from "./kit/diagram-theme.js";
import { createWorkspaceForms } from "./views/workspace-forms.js";

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
// A workspace's page names each store artifact by its store location, store:<location>, in its tabs, links, and URLs, never by a checkout's path:
// a checkout path that a record view or an older link names opens as the store artifact it names.
const STORE_REF = "store:";
const isStoreRef = (path) => typeof path === "string" && path.startsWith(STORE_REF);
let pathRefs = new Map();
const localTab = (tab) => typeof tab === "string" ? pathRefs.get(tab) ?? tab : tab;
const localTabs = (tabs) => Array.isArray(tabs) ? [...new Set(tabs.map(localTab))] : tabs;
// Every scope of the workspace's store that holds an artifact, each store artifact's scope label by ref, and the index's notes about the store.
let storeScopes = [];
let refScopes = new Map();
let storeNotes = [];
let storeSignature = "";

function useStoreRefs(data) {
  pathRefs = new Map(Object.entries(data.storeRefs ?? {}));
  storeScopes = Array.isArray(data.scopes) ? data.scopes : [];
  refScopes = new Map(Object.entries(data.artifactScopes ?? {}).filter(([ref]) => isStoreRef(ref)));
  storeNotes = Array.isArray(data.notes) ? data.notes : [];
  storeSignature = JSON.stringify([storeScopes, storeNotes, [...refScopes.keys()].join("\n")]);
}

// The scope filter narrows the store's artifacts to the chosen scope labels, or shows every scope while null, and the page keeps it in its URL's scopes parameter.
function readScopeFilter() {
  const labels = (new URLSearchParams(location.search).get("scopes") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  return labels.length ? new Set(labels) : null;
}
let scopeFilter = readScopeFilter();
const scopeShown = (label) => !scopeFilter || scopeFilter.has(label);

function withScopeFilter(url) {
  if (scopeFilter) url.searchParams.set("scopes", [...scopeFilter].join(","));
  else url.searchParams.delete("scopes");
  return url;
}

function setScopeFilter(labels) {
  scopeFilter = labels && labels.size ? labels : null;
  const url = withScopeFilter(new URL(location.href));
  history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  renderNavigation();
}

// A session snapshot with every store artifact named as the page opens it.
function localSession(snapshot) {
  const named = { ...snapshot };
  for (const key of ["openTabs", "agentTabs", "missingTabs"]) if (Object.hasOwn(snapshot, key)) named[key] = localTabs(snapshot[key]);
  for (const key of ["activeTab", "previewTab"]) if (Object.hasOwn(snapshot, key)) named[key] = localTab(snapshot[key]);
  return named;
}
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

// A button of an empty state that runs one action.
function emptyStateButton(text, onClick, variant = "primary") {
  const button = document.createElement("prism-button");
  button.setAttribute("variant", variant);
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

// The app's root without a workspace: the page offers to add one from its store address, and opens the first workspace as soon as the app lists one.
function showNoWorkspace() {
  renderedPath = null;
  project.textContent = "No workspace";
  document.title = "Prism review";
  projectButton.removeAttribute("disabled");
  watchWorkspaceMenu();
  void refreshProjects();
  const empty = document.createElement("prism-empty-state");
  empty.className = "welcome";
  empty.setAttribute("heading", "No workspace yet");
  const actions = element("div", "welcome-actions");
  actions.append(emptyStateButton("Add a workspace", () => workspaceForms().openAdd()));
  empty.append(
    element("p", "", "A workspace is one record store with every checkout and repository that shares it, or a project that keeps its records itself."),
    element("p", "", "Add one from its store's address, or start a Prism session in one of its projects; it opens here as soon as it is added."),
    actions
  );
  artifact.replaceChildren(empty);
  setBusy(false);
  const check = async () => {
    const listed = await fetch(`${appRoot}api/workspaces`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null, () => null);
    if (listed?.workspaces?.length) location.reload();
    else setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}

// An added workspace that no registered checkout serves: its page names it and says where its records open, and offers to remove it.
// The forms that add and remove the app's workspaces, made once the page first needs them.
let forms = null;
function workspaceForms() {
  forms ??= createWorkspaceForms({
    appRoot,
    writeHeaders,
    canWrite: () => Boolean(writeSession()),
    confirm: confirmAction,
    toast: (message, options) => showToast(message, options),
    open: (url, notice) => openWithNotice(url, notice)
  });
  return forms;
}

// A notice that a page leaves for the page it opens, such as what a removal did with a store's clone, which the next page of this tab shows once.
const NOTICE_KEY = "prism-review-notice";
function openWithNotice(url, notice) {
  try { sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice)); } catch { /* The next page then shows no notice. */ }
  if (new URL(url, location.href).href === location.href) location.reload();
  else location.href = url;
}

function showLeftNotice() {
  let notice = null;
  try {
    notice = JSON.parse(sessionStorage.getItem(NOTICE_KEY) ?? "null");
    sessionStorage.removeItem(NOTICE_KEY);
  } catch { /* A notice that cannot be read is dropped. */ }
  if (typeof notice?.message === "string" && notice.message) showToast(notice.message, { tone: notice.tone });
}

// The listing entry of the open workspace, from the switcher's latest listing.
let listedWorkspaces = [];
const currentEntry = () => listedWorkspaces.find((entry) => entry.id === thisWorkspace?.id) ?? null;

// Removing the open workspace reloads it while a checkout keeps it listed, and otherwise opens the app's root.
async function removeCurrentWorkspace() {
  const entry = currentEntry();
  if (!entry?.added) return;
  const removed = await workspaceForms().remove(entry);
  if (!removed) return;
  const listed = await fetch(`${appRoot}api/workspaces`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null, () => null);
  const notice = { message: removed.message, tone: removed.clone === "kept" ? "warning" : "success" };
  openWithNotice(listed?.workspaces?.some((item) => item.id === entry.id) ? location.href : appRoot, notice);
}

// The workspace menu opens the chosen workspace's page, or runs its Add and Remove items.
let watchingWorkspaceMenu = false;
function watchWorkspaceMenu() {
  if (watchingWorkspaceMenu) return;
  watchingWorkspaceMenu = true;
  projectButton.addEventListener("click", () => void refreshProjects());
  projectMenu.addEventListener("prism-select", (event) => {
    const url = event.detail?.value;
    if (url === "workspace:add") workspaceForms().openAdd();
    else if (url === "workspace:remove") void removeCurrentWorkspace();
    else if (url && url !== location.href) location.href = url;
  });
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
  const url = withScopeFilter(new URL(location.href));
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
function openRef(given, { keep = false, fromHistory = false } = {}) {
  const path = localTab(given);
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

function synchronizeSession(given) {
  const snapshot = localSession(given);
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

// Entries keep one order, by name, so a sync that changes recency or liveness never moves an entry under the pointer.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The review app's root, where the workspace list lives; a workspace's page sits below it at w/<id>/.
const appRoot = location.pathname.replace(/\/w\/[0-9a-f]{16}(?:\/.*)?$/, "/").replace(/[^/]*$/, "");

const countText = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// The states an entry shows at its end: whether an agent uses it, and its open gates, or that its records cannot be read.
function stateHint(entry, { gates = true } = {}) {
  const states = [];
  if (entry.live) states.push("in use");
  // Only a running or failed build is marked, because the status bar covers the open project's other states.
  if (entry.indexing === "preparing") states.push("indexing");
  if (entry.indexing === "failed") states.push("index failed");
  // An added workspace without a checkout here reads no records yet, which its page says, so it is not marked unreadable.
  if (gates && entry.gates === null && entry.checkouts?.length !== 0) states.push("unreadable");
  else if (gates && entry.gates) states.push(countText(entry.gates, "gate", "gates"));
  if (!states.length) return null;
  const hint = element("span", "project-states", states.join(" · "));
  hint.slot = "hint";
  return hint;
}

// One checkout of a session server's menu: its checkout, marked as the open one, with its folder as the tip.
function projectItem({ entry, identity }, current) {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("type", "radio");
  item.setAttribute("value", entry.url);
  item.toggleAttribute("checked", entry.id === current);
  item.setAttribute("tip", projectTitle(identity, entry.projectRoot));
  item.append(workspaceName(identity) ?? folderName(entry.projectRoot));
  return item;
}

// A workspace's repositories and how many of its checkouts this machine has, as information under its name; only the workspace itself is a place to open.
function workspaceDetail(entry) {
  const repositories = entry.repositories.map((repository) => repository.name);
  const held = repositories.length ? repositories.join(", ") : entry.kind === "project" ? "Records kept in the project" : "No repository yet";
  return `${held} · ${countText(entry.checkouts.length, "checkout", "checkouts")}`;
}

function workspaceTip(entry) {
  const lines = [entry.name, ...(entry.store ? [`Store: ${entry.store.label}`] : [])];
  for (const repository of entry.repositories) lines.push(`${repository.name}: ${repository.checkouts.length ? repository.checkouts.join(", ") : "no checkout on this machine"}`);
  const named = new Set(entry.repositories.flatMap((repository) => repository.checkouts));
  for (const checkout of entry.checkouts) if (!named.has(checkout)) lines.push(checkout);
  return lines.join("\n");
}

function workspaceItem(entry, current) {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("type", "radio");
  item.setAttribute("value", entry.url);
  item.toggleAttribute("checked", entry.id === current);
  item.setAttribute("detail", workspaceDetail(entry));
  item.setAttribute("tip", workspaceTip(entry));
  item.append(entry.name);
  const hint = stateHint(entry);
  if (hint) item.append(hint);
  return item;
}

// A session server has no list of workspaces, so its menu holds the one project it serves.
let thisProject = null;
let thisWorkspace = null;

function showOneProject() {
  if (!thisProject || projectListing === "one") return;
  projectListing = "one";
  const member = { entry: { id: "this", url: location.href, projectRoot: thisProject.projectRoot }, identity: workspaceIdentity(thisProject) };
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", member.identity.repository ?? folderName(thisProject.projectRoot));
  group.append(projectItem(member, "this"));
  projectMenu.replaceChildren(group);
  projectButton.removeAttribute("disabled");
}

// The review app lists its workspaces: each one store with its repositories and this machine's checkouts as information, or a project without a store.
async function refreshProjects() {
  let listing;
  try {
    const response = await fetch(`${appRoot}api/workspaces`, { cache: "no-store" });
    if (!response.ok) {
      showOneProject();
      return;
    }
    listing = await response.json();
  } catch {
    return;
  }
  projectButton.removeAttribute("disabled");
  const current = thisWorkspace?.id ?? null;
  const waiting = listing.workspaces.reduce((sum, entry) => sum + (entry.id === current ? 0 : entry.gates ?? 0), 0);
  projectGates.hidden = waiting === 0;
  projectGates.textContent = String(waiting);
  projectGates.setAttribute("tip", `${waiting} open ${waiting === 1 ? "gate" : "gates"} in other workspaces`);
  const entries = [...listing.workspaces].sort((left, right) => collator.compare(left.name, right.name) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // An unchanged list is left alone, so a sync that only reorders the workspaces by recency leaves the menu as it is.
  const text = JSON.stringify(entries);
  if (text === projectListing) return;
  projectListing = text;
  listedWorkspaces = entries;
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", "Workspaces");
  if (entries.length) group.append(...entries.map((entry) => workspaceItem(entry, current)));
  else group.append(noWorkspaceItem());
  projectMenu.replaceChildren(group, manageGroup(entries.find((entry) => entry.id === current) ?? null));
}

// Adding a workspace is offered on every page of the app, and removing one on the page of a workspace that a person added.
function manageGroup(entry) {
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", "Manage");
  const add = document.createElement("prism-menu-item");
  add.setAttribute("value", "workspace:add");
  add.setAttribute("detail", "Clone a store from its address");
  add.append("Add workspace…");
  group.append(add);
  if (entry?.added) {
    const remove = document.createElement("prism-menu-item");
    remove.setAttribute("value", "workspace:remove");
    remove.setAttribute("detail", entry.checkouts.length ? "Its checkouts keep it listed" : "Deletes its clone when nothing here uses it");
    remove.append(`Remove ${entry.name}…`);
    group.append(remove);
  }
  return group;
}

function noWorkspaceItem() {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("disabled", "");
  item.setAttribute("detail", "Add one from its store address, or start a Prism session in a project");
  item.append("No workspace yet");
  return item;
}

// A checkout of a workspace leads with the workspace's name, because the records it shows belong to the whole workspace.
function setProjectLabel(identity, projectRoot, workspace = null) {
  project.replaceChildren(projectLabel(identity, workspace));
  projectButton.setAttribute("tip", [workspace ? `Workspace: ${workspace}` : "", projectTitle(identity, projectRoot)].filter(Boolean).join("\n"));
  signals.project = [workspace, [identity.repository ?? folderName(projectRoot), workspaceName(identity)].filter(Boolean).join("/")].filter(Boolean).join(" · ");
  document.title = signalTitle(baseTitle(), signals.count ?? 0);
}

// A session server names no workspace, so a checkout whose records live in a store takes the store's name, the workspace name it keeps or the store's last segment.
function storeWorkspaceName(store) {
  if (!store || store.kind === "project") return null;
  if (store.workspaceName) return store.workspaceName;
  const place = store.kind === "folder" ? store.location : store.label;
  return String(place ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean).pop()?.replace(/\.git$/i, "") || store.label || null;
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
  // An applied action of this page or of another checkout's page on the same records: views that show it update without a reload,
  // and a comment on the open file shows at once rather than at the next check.
  sessionStream.addEventListener("action", (event) => {
    try {
      const detail = JSON.parse(event.data);
      document.dispatchEvent(new CustomEvent("prism:action", { detail }));
      if (detail?.artifact?.path && detail.artifact.path === selectedPath) void showArtifact(selectedPath);
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

// A store artifact's read carries its links resolved against its store location, which the page renders in place of resolving them itself.
function markdownOptions(basePath, links = null) {
  return { basePath, isKnown: (path) => availableArtifacts.has(path), links: linkTargets(links) };
}

// The read of a page's file: a store artifact, or a code file a store artifact links to, code:<repository>:<path>, by its ref, and any other file by its path.
const isCodeRef = (path) => typeof path === "string" && /^code:[^:/]+:./.test(path);
const artifactQuery = (path) => isStoreRef(path) || isCodeRef(path) ? `ref=${encodeURIComponent(path)}` : `path=${encodeURIComponent(path)}`;

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

// The store tree lists every scope's artifacts together, each scope with its label and count, behind the scope filter; a scope lists its first artifacts and the palette finds the rest.
const SCOPE_ITEM = "store-scope:";
const SCOPE_ARTIFACTS_SHOWN = 50;

// A store artifact's location below its scope's folder, such as requirements/billing.md, as the store tree names it.
function belowScope(ref) {
  const names = ref.slice(STORE_REF.length).split("/");
  const at = names[0] === "repositories" && names.length > 2 ? names[2] === "components" && names.length > 4 ? 4 : 2 : 0;
  return names.slice(at).join("/");
}

function scopeFilterChips() {
  const holder = element("div", "nav-scope-filter");
  holder.dataset.scopeFilter = "";
  holder.setAttribute("role", "group");
  holder.setAttribute("aria-label", "Scope filter");
  for (const scope of storeScopes) {
    const chip = element("prism-chip", "", scope.label);
    chip.setAttribute("interactive", "");
    chip.setAttribute("pressed", String(Boolean(scopeFilter?.has(scope.label))));
    chip.setAttribute("tip", scopeFilter?.has(scope.label) ? `Stop narrowing to ${scope.label}` : `Show only ${scope.label} and the other chosen scopes`);
    chip.append(Object.assign(element("span", "", String(scope.artifacts)), { slot: "meta" }));
    chip.addEventListener("click", () => {
      const next = new Set(scopeFilter ?? []);
      if (next.has(scope.label)) next.delete(scope.label);
      else next.add(scope.label);
      setScopeFilter(next);
    });
    holder.append(chip);
  }
  if (scopeFilter) {
    const all = element("prism-chip", "", "All scopes");
    all.setAttribute("interactive", "");
    all.addEventListener("click", () => setScopeFilter(null));
    holder.append(all);
  }
  return holder;
}

function storeNavigation() {
  if (!storeScopes.length && !storeNotes.length) return [];
  const parts = [section("Store", refScopes.size)];
  for (const note of storeNotes) parts.push(element("p", "nav-note", note.message ?? String(note)));
  if (!storeScopes.length) return parts;
  parts.push(scopeFilterChips());
  const byScope = new Map(storeScopes.map((scope) => [scope.label, []]));
  for (const [ref, label] of refScopes) byScope.get(label)?.push(ref);
  let cut = false;
  const items = storeScopes.filter((scope) => scopeShown(scope.label)).map((scope) => {
    const refs = byScope.get(scope.label) ?? [];
    const value = `${SCOPE_ITEM}${scope.label}`;
    const holdsCurrent = refs.includes(selectedPath);
    const shown = refs.slice(0, SCOPE_ARTIFACTS_SHOWN);
    if (holdsCurrent && !shown.includes(selectedPath)) shown.push(selectedPath);
    if (shown.length < refs.length) cut = true;
    const count = element("span", "nav-count", String(scope.artifacts));
    const children = shown.map((ref) => treeItem(ref, belowScope(ref), { selected: selectedPath === ref }));
    return treeItem(value, scope.label, { expanded: treeToggles.get(value) ?? holdsCurrent, end: [count], children });
  });
  if (items.length) parts.push(tree("Store artifacts by scope", items));
  else parts.push(element("p", "nav-note", "No scope matches the filter."));
  if (cut) parts.push(element("p", "nav-note", `A scope lists its first ${SCOPE_ARTIFACTS_SHOWN} artifacts here; press Ctrl K to find any other.`));
  return parts;
}

// The sidebar is the only navigation: places, every initiative, the open initiative's slices or the open library section's documents, and the library.
let navigationKey = "";

function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  void updateAttentionSignals(attention.gates ?? 0);
  const entity = Boolean(parseEntityRef(selectedPath ?? ""));
  const claims = claimIndex ? [...claimIndex.live(), ...claimIndex.expired()].map((claim) => [claim.ref, claim.expiresAt, claim.label]) : [];
  const key = JSON.stringify([selectedPath, scope, attention, navigation.initiatives, navigation.glossary, navigation.diagnostics, claims, [...treeToggles], storeSignature, scopeFilter && [...scopeFilter]]);
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
      parts.push(tree(topic, entries.map((entry) => treeItem(localTab(entry.path), entry.title, { selected: selectedPath === localTab(entry.path), end: entry.status ? [element("span", "nav-state", entry.status)] : [] }))));
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
  ]), ...storeNavigation());
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
  const memory = { path, top: same ? workspace.scrollTop : scrollPositions.get(path) ?? 0, open: null, focus: -1, focusKey: null };
  if (same) {
    memory.open = [...artifact.querySelectorAll("prism-disclosure")].map((disclosure) => [disclosure.getAttribute("summary") ?? "", disclosure.open]);
    memory.focus = artifact.contains(document.activeElement) ? controlsOf(artifact).indexOf(document.activeElement) : -1;
    // A control whose view names it with data-focus-key, such as a kit button whose own control sits in its shadow, gets its focus back by that name.
    memory.focusKey = artifact.contains(document.activeElement) ? document.activeElement.closest("[data-focus-key]")?.dataset.focusKey ?? null : null;
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
  // Focus that a view named with data-focus-key comes back by that name, and a comment, which is no control, takes it without entering the tab order.
  // A comment is never found again by position, since a list that grew or shrank would move focus to another control: one that is gone hands focus to the More comments button when one is listed.
  // A More comments button that this redraw no longer lists, as when it lists the last comments that a press of it asked for, hands focus on as that press would:
  // to the More comments button that follows the added comments, or else to the first comment that the press added, never to a control found by position.
  const keyed = (key) => [...artifact.querySelectorAll("[data-focus-key]")].find((control) => control.dataset.focusKey === key);
  const comment = memory.focusKey?.startsWith("comment:") === true;
  const more = memory.focusKey === "more-comments";
  if (memory.focusKey && !artifact.contains(document.activeElement)) {
    const found = keyed(memory.focusKey) ?? (comment ? keyed("more-comments") : null);
    if (found?.dataset.commentId !== undefined) found.tabIndex = -1;
    if (found) found.focus({ preventScroll: true });
    else if (more) {
      const list = artifact.querySelector("[data-comment-list]");
      const listed = [...(list?.querySelectorAll("[data-comment-id]") ?? [])];
      // Without a press under way, focus goes to the last listed comment, the place in the list where the button stood.
      const before = state.moreBefore ?? new Set(listed.slice(0, -1).map((item) => item.dataset.commentId));
      if (list) focusAfterMore(list, before);
    }
  }
  if (!comment && !more && memory.focus >= 0 && !artifact.contains(document.activeElement)) controlsOf(artifact)[memory.focus]?.focus({ preventScroll: true });
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
  const response = await fetch(`./api/artifact?${artifactQuery(path)}`, { cache: "no-store" });
  if (response.status === 404) {
    showMissing(path);
    return;
  }
  if (!response.ok) {
    await showError(response);
    return;
  }
  const data = await response.json();
  const state = viewState(data.path);
  // A Review card that lists further comment reads reads them all again with the first, so its list stays the file's first comments as they now are.
  const readPage = (commentOffset) => fetchJson(`./api/artifact?${artifactQuery(data.path)}&commentOffset=${commentOffset}`);
  if (data.artifact && (state.commentReads ?? 1) > 1) {
    const listed = await readListedComments(data.artifact, state, readPage).catch(() => null);
    if (path !== selectedPath) return;
    // Reads that never agreed, or failed, leave the card as it is until the next redraw; a card not shown yet lists the first read alone.
    if (listed) data.artifact = listed;
    else if (renderedPath === path) { setBusy(false); return; }
  }
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
      : `<section class="document-sheet"><prism-doc class="document-content">${renderText(data.path, data.content, markdownOptions(data.path, data.links))}</prism-doc></section>`;
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
        ${data.location ? `<p class="artifact-path" data-code-subject>${escapeHtml(data.location)}</p>` : ""}
      </div>
      <div class="artifact-meta">
        ${data.scope ? `<prism-chip tone="accent" data-scope-label tip="The scope that holds this artifact in the record store">${escapeHtml(data.scope.label)}</prism-chip>` : ""}
        ${data.unresolvedLinks ? `<prism-chip tone="warning" tip="Links in this file that name no artifact in the record store and no file">${escapeHtml(countText(data.unresolvedLinks, "link not found", "links not found"))}</prism-chip>` : ""}
        ${unavailableLinks(data) ? `<prism-chip tip="Links to code files that no checkout of their repository on this machine holds">${escapeHtml(countText(unavailableLinks(data), "code link not available on this machine", "code links not available on this machine"))}</prism-chip>` : ""}
        ${named.code || structured ? `<prism-chip>${escapeHtml(kind)}</prism-chip>` : ""}
        ${source ? "<prism-chip>Read-only</prism-chip>" : structured ? "" : `<prism-chip>${diagramLabel}</prism-chip>`}
      </div>
    </header>
    ${artifactReviewHtml(data, state)}
    ${documentCard}`;
  // A store artifact shows its review view above its content, and its comment form keeps an unsent comment across the page's live updates.
  // More comments lists further comments in place, so the page takes what the card now lists as what it shows and redraws only when that changes.
  mountArtifactReview(artifact, data, { actionApi, state, readPage, onListed: (listed) => { if (listed.path === selectedPath) lastSnapshot = JSON.stringify(listed); } });
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
    fetchArtifact: (artifactPath) => fetchJson(`./api/artifact?${artifactQuery(localTab(artifactPath))}`),
    fetchEvidence: (id) => fetchJson(`./api/evidence?id=${encodeURIComponent(id)}`),
    hasArtifact: (artifactPath) => availableArtifacts.has(localTab(artifactPath)) || Boolean(parseEntityRef(artifactPath)),
    // A store artifact's scope label, which the record views show beside it, or null for any other file.
    scopeLabel: (artifactPath) => refScopes.get(localTab(artifactPath)) ?? null,
    openArtifact(given, options = {}) {
      const artifactPath = localTab(given);
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
      const data = await fetchJson(`./api/artifact?${artifactQuery(localTab(diagramPath))}`);
      for (const diagram of data.diagrams ?? []) {
        const section = diagramCard(diagram);
        target.appendChild(section);
        await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
      }
    },
    // A gate answer is the gate's answer action, applied against the revision its listing shows.
    // An approval gate of a requirement or ADR is the target approval:<id>, since the artifact's status record in the store holds it, and its revision is the artifact's version.
    async answerGate({ initiative, approval, id, choice, note }) {
      if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
      const target = approval ? `approval:${id}` : `gate:${initiative}/${id}`;
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

// The links of a store artifact's read to code files that no checkout on this machine holds.
const unavailableLinks = (data) => Array.isArray(data.links) ? data.links.filter((item) => item.resolved === null).length : 0;

function paletteEntries() {
  const places = [
    { ref: "attention", label: "Attention", kind: "place", detail: "What needs you" },
    { ref: "roadmap", label: "Roadmap", kind: "place", detail: "Initiatives by band" },
    { ref: "requirements", label: "Requirements", kind: "place", detail: "Library" },
    { ref: "decisions", label: "Decisions", kind: "place", detail: "Library" },
    { ref: "glossary", label: "Glossary", kind: "place", detail: "Library" }
  ];
  // A library entry that names a store artifact by the reading checkout's path is that store artifact: it opens by its ref, follows the scope filter, and names its scope,
  // so the Records group below never lists it a second time.
  const indexed = (navigation.index ?? []).flatMap((entry) => {
    const ref = localTab(entry.ref);
    if (!isStoreRef(ref)) return [entry];
    return scopeShown(refScopes.get(ref)) ? [{ ...entry, ref, scope: refScopes.get(ref) ?? "workspace" }] : [];
  });
  const known = new Set(indexed.map((entry) => entry.ref));
  const titles = titleIndex();
  // Prism's own records are named by title and kind; repository files keep their paths, since code is their subject.
  const files = [...availableArtifacts].filter((file) => !known.has(file) && (!isStoreRef(file) || scopeShown(refScopes.get(file)))).map((file) => {
    if (describe(file).code) return { ref: file, label: fileName(file), kind: "file", detail: file };
    // A store artifact names its scope and its place in it, so files of one name in several scopes read apart.
    if (isStoreRef(file)) {
      const named = recordLabel(file, titles);
      return { ref: file, label: named.owner ? named.kind : named.label, kind: "record", kindLabel: named.kind, scope: refScopes.get(file) ?? "workspace", detail: `${refScopes.get(file) ?? "workspace"} · ${belowScope(file)}` };
    }
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
  recordStoreStatus?.update(data.recordStore, data.storeSync, data.sync);
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
  // Focus in the sidebar would fall to the page when the sidebar becomes a closed drawer, so it moves to the Navigation button that opens the drawer.
  const sidebar = document.getElementById("sidebar");
  let sidebarFocused = false;
  document.addEventListener("focusin", (event) => { sidebarFocused = sidebar.contains(event.target); });
  wide.addEventListener("change", () => {
    if (!wide.matches) {
      if (navDrawer.isOpen || !sidebarFocused) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || sidebar.contains(active)) document.getElementById("nav-button").focus();
      });
      return;
    }
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
  showLeftNotice();
  const index = await fetchJson("./api/index");
  if (index.workspace === null && !index.projectRoot) {
    showNoWorkspace();
    return;
  }
  useStoreRefs(index);
  const data = localSession(index);
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
    hasArtifact: (path) => availableArtifacts.has(localTab(path)),
    describe
  });
  renderStoreSync(data);
  openTabs = data.openTabs;
  previewTab = openTabs.includes(data.previewTab) ? data.previewTab : null;
  agentTabs = (data.agentTabs ?? []).filter((tab) => openTabs.includes(tab));
  sessionRevision = Number.isInteger(data.revision) ? data.revision : 0;
  sessionInstance = typeof data.instance === "string" ? data.instance : null;
  appVersion = typeof data.appVersion === "string" ? data.appVersion : null;
  const requestedPath = localTab(selectedPath);
  selectedPath = Object.hasOwn(data, "activeTab") ? data.activeTab : null;
  // A workspace that the app reads through its store's clone alone names no checkout, so the label shows the workspace alone.
  const storeOnly = data.checkout === null && Boolean(data.workspace?.id);
  thisWorkspace = data.checkout || storeOnly ? data.workspace : null;
  if (storeOnly) setProjectLabel({ repository: data.workspace.name, worktree: null, branch: null, detached: false }, data.recordStore?.label ? `Store: ${data.recordStore.label}` : "", null);
  else setProjectLabel(data.checkout ?? workspaceIdentity(data), data.projectRoot, thisWorkspace ? thisWorkspace.kind === "store" ? thisWorkspace.name : null : storeWorkspaceName(data.recordStore));
  thisProject = data;
  showPrivateServer(data.privateServer);
  let sectionFrame = 0;
  workspace.addEventListener("scroll", () => {
    if (!rebuilding && renderedPath && renderedPath === selectedPath) scrollPositions.set(renderedPath, workspace.scrollTop);
    cancelAnimationFrame(sectionFrame);
    sectionFrame = requestAnimationFrame(() => markCurrentSection(artifact, workspace.getBoundingClientRect().top));
  }, { passive: true });
  // Choosing another project opens its review page; opening the menu refreshes the list first.
  watchWorkspaceMenu();
  void refreshProjects();
  // The project list is checked 5 s after its last check ended, so checks never overlap.
  const checkProjects = () => refreshProjects().catch(() => {}).finally(() => setTimeout(checkProjects, 5000));
  setTimeout(checkProjects, 5000);
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
    // A text match in a store artifact found by the reading checkout's path opens the store artifact, follows the scope filter, and names its scope.
    search: async (query) => (await fetchJson(`./api/search?q=${encodeURIComponent(query)}`)).results.flatMap((result) => {
      const ref = localTab(result.path);
      if (!isStoreRef(ref)) return [result];
      return scopeShown(refScopes.get(ref)) ? [{ ...result, path: ref, scope: refScopes.get(ref) ?? "workspace" }] : [];
    }),
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
    renderMarkdown: (path, content, links) => renderText(path, content, markdownOptions(path, links)),
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
    renderMarkdown: (path, content, links) => renderText(path, content, markdownOptions(path, links)),
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
    renderMarkdown: (path, content, links) => renderText(path, content, markdownOptions(path, links)),
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
    // A scope of the store tree opens and closes its list of artifacts rather than opening a page.
    if (ref?.startsWith(SCOPE_ITEM)) {
      const item = [...navRoot.querySelectorAll("prism-tree-item")].find((node) => node.getAttribute("value") === ref);
      treeToggles.set(ref, !(item?.hasAttribute("expanded") ?? false));
      renderNavigation();
      return;
    }
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
    const ref = localTab(event.state?.ref ?? new URLSearchParams(location.search).get("artifact"));
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
  // Each poll starts 1.5 s after the last one ended, never while it still runs, so a slow answer never piles up requests that hold the page's connections.
  const poll = async () => {
    // Shown action lists check their listing every few seconds, so a change an agent made shows without a reload.
    if (++polls % 3 === 0 && connection !== "stopped") document.dispatchEvent(new CustomEvent("prism:poll"));
    try {
      const refreshed = await fetch("./api/index", { cache: "no-store" }).catch(() => null);
      reportRefresh(Boolean(refreshed?.ok));
      if (refreshed?.ok) {
        const answered = await refreshed.json();
        const storeBefore = storeSignature;
        useStoreRefs(answered);
        const snapshot = localSession(answered);
        renderStoreSync(snapshot);
        prismRecords = new Set(snapshot.artifacts);
        availableArtifacts = new Set([...snapshot.artifacts, ...(snapshot.sources ?? [])]);
        updateMissingTabs(snapshot.missingTabs);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          navigation = snapshot.navigation;
          renderNavigation();
          void claimIndex.refresh().catch(() => {});
        } else if (storeSignature !== storeBefore) renderNavigation();
        if (!sessionConnected) {
          synchronizeSession(snapshot);
        }
        // A failed probe leaves the open view as it is rather than replacing it with an error.
        const panel = sidePanel.isOpen() ? sidePanel.refresh().catch(() => {}) : null;
        if (selectedPath) {
          await showArtifact(selectedPath);
        }
        await panel;
      }
    } catch {
    }
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1500);
}

initialize().catch((error) => {
  artifact.innerHTML = `<div class="document-sheet"><p class="error">${escapeHtml(error.message)}</p></div>`;
  setBusy(false);
});
