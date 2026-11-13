import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, KNOWLEDGE_PAGES, parseEntityRef, recordKind, recordLabel, renderEntity } from "./views/entities.js";
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
import { DEFAULT_PLACE, PLACES, placeNamed } from "./views/places.js";
import { claimElement, createClaimIndex } from "./views/claim-index.js";
import { createPresence } from "./views/presence.js";
import { DENSITIES, onPreferencesChange, preference, preferencesReady, savePreferences, setPreference, THEMES } from "./kit/preferences.js";
import { shownActionEntries } from "./views/actions.js";
import { artifactReviewHtml, focusAfterMore, mountArtifactReview, readListedComments } from "./views/artifact-review.js";
import { themeDiagram } from "./kit/diagram-theme.js";
import { createWorkspaceForms } from "./views/workspace-forms.js";
import { currentPhase } from "./views/slice.js";
import { messageHtml, shortDate } from "./views/util.js";
import { LANES, laneHeading, ROADMAP_VIEWS } from "./views/roadmap.js";
import { createPoller, deadline, POLL_DEADLINE_MS } from "./views/poller.js";
import { createEventRelay } from "./views/event-relay.js";
import { shippedHistoryHtml } from "./views/shipped-history.js";
import { arrangeGroups } from "./views/tab-groups.js";

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
// Named groups of open tabs, each { name, tabs, collapsed }, such as the tabs an agent presented for one piece of work.
let tabGroups = [];
let sessionRevision = 0;
// A replaced review app restarts revisions, so a snapshot from a new instance is accepted whatever its revision.
let sessionInstance = null;
// A page that reconnects to an app of another plugin version reloads, so it never runs old page code against a newer app.
let appVersion = null;
let sessionConnected = false;
// The origin's shared event stream, which one tab holds for every tab of the review app.
let relay = null;
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
let codeRepositories = [];

function useStoreRefs(data) {
  pathRefs = new Map(Object.entries(data.storeRefs ?? {}));
  storeScopes = Array.isArray(data.scopes) ? data.scopes : [];
  refScopes = new Map(Object.entries(data.artifactScopes ?? {}).filter(([ref]) => isStoreRef(ref)));
  storeNotes = Array.isArray(data.notes) ? data.notes : [];
  // A workspace's code repositories, which the Library's Code page lists while there is one.
  codeRepositories = Array.isArray(data.repositories) ? data.repositories.map((repository) => repository.name) : [];
  storeSignature = JSON.stringify([storeScopes, storeNotes, [...refScopes.keys()].join("\n"), codeRepositories]);
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
  writeArtifact("");
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
  writeArtifact("");
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
  projectButton.addEventListener("click", () => void (projectPoller ? projectPoller.now() : refreshProjects()));
  projectMenu.addEventListener("prism-select", (event) => {
    const url = event.detail?.value;
    if (url === "workspace:add") workspaceForms().openAdd();
    else if (url === "workspace:remove") void removeCurrentWorkspace();
    else if (url && url !== location.href) location.href = url;
  });
}

// The pages this browser tab visited sit in the browser's own history, each entry numbered, so Back and Forward know whether there is a page to go to.
// The tab also keeps which page each numbered entry showed, so Back and Forward pass over an entry that shows the page already open,
// such as the entry a closed tab leaves behind, and never take a click that changes nothing.
const HISTORY_KEY = "prism.review.history";
const pages = { index: 0, top: 0, refs: [] };

// The highest page the tab may move forward to is kept for this tab, with the page it was on when the tab last left the app and the page of each entry.
function readHistoryTop() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "null");
    const refs = Array.isArray(stored?.refs) ? stored.refs.map((ref) => (typeof ref === "string" ? ref : null)) : [];
    return { top: Number(stored?.top) || 0, left: Number.isInteger(stored?.left) ? stored.left : null, refs };
  } catch {
    return { top: 0, left: null, refs: [] };
  }
}

function storeHistoryTop(left = null) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify({ top: pages.top, left, refs: pages.refs.slice(0, pages.top + 1) }));
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
  const stored = readHistoryTop();
  if (Number.isInteger(index)) {
    pages.index = index;
    pages.top = settleHistoryTop(index, stored);
    pages.refs = stored.refs.slice(0, pages.top + 1);
  } else {
    pages.index = 0;
    pages.top = 0;
    pages.refs = [];
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

// The nearest entry from `from` in direction `step` that shows another page than the open one, or null; an entry whose page is not known counts as another page.
function nextEntry(from, step) {
  for (let index = from + step; index >= 0 && index <= pages.top; index += step) {
    if (pages.refs[index] !== selectedPath) return index;
  }
  return null;
}

// Back and Forward, and Alt+arrows, move only through the pages visited in this tab, so they never leave the review app.
function goBack() {
  const target = nextEntry(pages.index, -1);
  if (target !== null) history.go(target - pages.index);
}

function goForward() {
  const target = nextEntry(pages.index, 1);
  if (target !== null) history.go(target - pages.index);
}

function showHistory() {
  pageBar?.setHistory({ back: nextEntry(pages.index, -1) !== null, forward: nextEntry(pages.index, 1) !== null });
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
  const url = withScopeFilter(new URL(location.href));
  if (path) {
    url.searchParams.set("artifact", path);
  } else {
    url.searchParams.delete("artifact");
  }
  // A place= address chose the place when the page loaded; the place is stored, so the address leaves it out from then on, as it does a lane= address once its lane showed.
  url.searchParams.delete("place");
  url.searchParams.delete("lane");
  if (push) {
    pages.index += 1;
    pages.top = pages.index;
    pages.refs.length = pages.index;
    history.pushState({ ref: path, index: pages.index }, "", `${url.pathname}${url.search}`);
  } else {
    history.replaceState({ ref: path, index: pages.index }, "", `${url.pathname}${url.search}`);
  }
  pages.refs[pages.index] = path ?? null;
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

// This window's id in the session, so the session can say which window chose the active tab; a reload keeps it.
const WINDOW_KEY = "prism.review.window";
const windowId = (() => {
  try {
    const kept = sessionStorage.getItem(WINDOW_KEY);
    if (kept) return kept;
    const id = `w-${crypto.randomUUID()}`;
    sessionStorage.setItem(WINDOW_KEY, id);
    return id;
  } catch {
    return `w-${crypto.randomUUID()}`;
  }
})();

// While this window's own saves are on their way, an answer or event that predates the last of them would undo what the window shows,
// so the newest snapshot waits and applies once every save has answered.
let pendingSaves = 0;
let waitingSnapshot = null;

function saveSession() {
  arrangeTabs();
  const payload = { openTabs: [...openTabs], activeTab: held ? held.sessionTab : selectedPath, previewTab, agentTabs: agentTabs.filter((tab) => openTabs.includes(tab)), groups: tabGroups, source: windowId };
  pendingSaves += 1;
  const request = async () => {
    const response = await appFetch("./api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json();
  };
  const settle = (snapshot) => {
    pendingSaves -= 1;
    if (snapshot && (!waitingSnapshot || newerSnapshot(snapshot, waitingSnapshot))) waitingSnapshot = snapshot;
    if (pendingSaves > 0 || !waitingSnapshot) return;
    const latest = waitingSnapshot;
    waitingSnapshot = null;
    synchronizeSession(latest);
  };
  const queued = saveQueue.then(request, request).then((snapshot) => settle(snapshot), (error) => {
    settle(null);
    throw error;
  });
  saveQueue = queued.catch(() => {});
  return queued;
}

function newerSnapshot(snapshot, than) {
  return snapshot.instance !== than.instance || (snapshot.revision ?? 0) > (than.revision ?? 0);
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

// Grouped tabs sit side by side, as the review app keeps them, so the strip shows each group whole before the app answers.
function arrangeTabs() {
  ({ openTabs, groups: tabGroups } = arrangeGroups(openTabs, tabGroups));
  const grouped = new Set(tabGroups.flatMap((group) => group.tabs));
  if (grouped.has(previewTab)) previewTab = null;
}

function renderTabs() {
  if (typeof tabStrip.setTabs !== "function") {
    void customElements.whenDefined("prism-doc-tabs").then(renderTabs);
    return;
  }
  arrangeTabs();
  const groupOf = new Map(tabGroups.flatMap((group) => group.tabs.map((tab) => [tab, group.name])));
  tabStrip.setTabs(openTabs.map((path) => {
    const entity = Boolean(parseEntityRef(path));
    const { title, full, code = false } = tabNames(path);
    const missing = missingTabs.has(path);
    const preview = path === previewTab;
    const agent = agentTabs.includes(path);
    const tip = [missing ? missingNotice(path, { entity, label: title }).tooltip : full, preview ? PREVIEW_TIP : "", agent ? "Presented by the agent." : ""].filter(Boolean).join(" ");
    return { value: path, label: title, tip, selected: path === selectedPath, preview, agent, missing, code, group: groupOf.get(path) ?? null };
  }), { groups: tabGroups });
}

tabStrip.addEventListener("prism-select", (event) => openRef(event.detail?.value));
tabStrip.addEventListener("prism-tab-keep", (event) => keepTab(event.detail?.value));
tabStrip.addEventListener("prism-tab-close", (event) => closeTab(event.detail?.value));
tabStrip.addEventListener("prism-tab-move", (event) => moveTabs(event.detail?.order, event.detail?.groups));
tabStrip.addEventListener("prism-group-toggle", (event) => toggleGroup(event.detail?.group, event.detail?.collapsed));
tabStrip.addEventListener("prism-group-close", (event) => closeTabs(event.detail?.tabs ?? []));

// Moving a tab or a group gives the open tabs a new order, and a tab moved into or out of a group a new group, which every window of the session then shows.
function moveTabs(order, groups) {
  if (!Array.isArray(order) || !requireApp()) return;
  const known = order.filter((path) => openTabs.includes(path));
  openTabs = [...known, ...openTabs.filter((path) => !known.includes(path))];
  if (Array.isArray(groups)) {
    const collapsed = new Map(tabGroups.map((group) => [group.name, group.collapsed]));
    tabGroups = groups.filter((group) => collapsed.has(group.name)).map((group) => ({ name: group.name, tabs: group.tabs.filter((path) => openTabs.includes(path)), collapsed: collapsed.get(group.name) }));
  }
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}

// A collapsed group shows only its head and its selected tab, in every window of the session.
function toggleGroup(name, collapsed) {
  const group = tabGroups.find((each) => each.name === name);
  if (!group || !requireApp()) return;
  group.collapsed = Boolean(collapsed);
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}

// Opening a page shows it in a tab and pushes it onto the browser history, so Back, Forward, and the browser's own buttons move through the same pages.
// An ordinary open replaces the preview tab; `keep` opens a kept tab instead, or keeps the preview, and a new tab goes right after the selected one.
function openRef(given, { keep = false, fromHistory = false, keepDrawer = false } = {}) {
  const path = localTab(given);
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
  const shown = showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
  return shown;
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
  if (path) closeTabs([path]);
}

// Closing a group closes its tabs; the selected page, when it closes too, gives way to the last tab still open.
function closeTabs(paths) {
  const closing = new Set(paths.filter((path) => openTabs.includes(path)));
  if (!closing.size || !requireApp()) return;
  held = null;
  for (const path of closing) scrollPositions.delete(path);
  openTabs = openTabs.filter((tab) => !closing.has(tab));
  agentTabs = agentTabs.filter((tab) => !closing.has(tab));
  if (closing.has(previewTab)) {
    previewTab = null;
  }
  if (closing.has(selectedPath)) {
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

// Every window of the session shows the same tabs. A page an agent presents becomes the next page of every window's history,
// while a window keeps its own page when another window picks a tab, so a window's history holds only the pages it showed.
let lastActive = null;

function synchronizeSession(given) {
  const snapshot = localSession(given);
  if (pendingSaves > 0) {
    if (!waitingSnapshot || newerSnapshot(snapshot, waitingSnapshot)) waitingSnapshot = snapshot;
    return;
  }
  const nextRevision = Number.isInteger(snapshot.revision) ? snapshot.revision : sessionRevision;
  const nextInstance = typeof snapshot.instance === "string" ? snapshot.instance : sessionInstance;
  if (typeof snapshot.appVersion === "string" && appVersion !== null && snapshot.appVersion !== appVersion) {
    location.reload();
    return;
  }
  if (nextRevision <= sessionRevision && nextInstance === sessionInstance) {
    return;
  }
  const first = sessionInstance === null && lastActive === null;
  sessionInstance = nextInstance;
  const nextTabs = Array.isArray(snapshot.openTabs) ? [...snapshot.openTabs] : [];
  const active = Object.hasOwn(snapshot, "activeTab") && nextTabs.includes(snapshot.activeTab) ? snapshot.activeTab : null;
  // An agent's presentation is new when the active tab or its source changed since the last snapshot this window saw; the first snapshot is the session as it was.
  const presented = !first && snapshot.activeSource === "agent" && active !== null && (lastActive?.tab !== active || lastActive?.source !== "agent");
  lastActive = { tab: active, source: snapshot.activeSource ?? null };
  // A held page stays shown while the session still selects the tab it held it beside and no agent presents a page; any other selection ends the hold.
  if (held && (presented || active !== held.sessionTab || !nextTabs.includes(held.page))) held = null;
  const nextPreview = nextTabs.includes(snapshot.previewTab) ? snapshot.previewTab : null;
  const nextAgentTabs = Array.isArray(snapshot.agentTabs) ? snapshot.agentTabs.filter((tab) => nextTabs.includes(tab)) : [];
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  previewTab = nextPreview;
  agentTabs = nextAgentTabs;
  tabGroups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  // The window follows a presentation; otherwise it keeps its page while that page's tab stays open, and takes the session's active tab, or the last tab, when it closed.
  const next = presented ? active : nextTabs.includes(selectedPath) ? selectedPath : active ?? nextTabs.at(-1) ?? null;
  if (next === selectedPath) {
    renderTabs();
    showHistory();
    return;
  }
  const hadPage = selectedPath !== null;
  selectedPath = next;
  lastSnapshot = "";
  renderTabs();
  if (!next) {
    updateLocation(null);
    showNothing();
    return;
  }
  updateLocation(selectedPath, presented && hadPage);
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

// A menu item's second line, held in its detail slot.
function detailLine(text) {
  const line = element("span", "project-folder", text);
  line.slot = "detail";
  return line;
}

function workspaceItem(entry, current) {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("type", "radio");
  item.setAttribute("value", entry.url);
  item.toggleAttribute("checked", entry.id === current);
  item.setAttribute("tip", workspaceTip(entry));
  item.append(entry.name);
  const hint = stateHint(entry);
  if (hint) item.append(hint);
  item.append(detailLine(workspaceDetail(entry)));
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

// The review app lists its workspaces: each one store with its repositories and this machine's checkouts as information, or a project without a store;
// a session server has no list, so its page stops asking.
let projectPoller = null;

async function refreshProjects() {
  let listing;
  try {
    const response = await appFetch(`${appRoot}api/workspaces`, { cache: "no-store", deadlineMs: POLL_DEADLINE_MS });
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
  // A list that changes while the menu is open keeps the menu's scroll position and its place under the button.
  const scrolled = projectMenu.scrollTop;
  projectMenu.replaceChildren(group, manageGroup(entries.find((entry) => entry.id === current) ?? null));
  if (projectMenu.isOpen) {
    projectMenu.place();
    projectMenu.scrollTop = scrolled;
  }
}

// Adding a workspace is offered on every page of the app, and removing one on the page of a workspace that a person added.
function manageGroup(entry) {
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", "Manage");
  const add = document.createElement("prism-menu-item");
  add.setAttribute("value", "workspace:add");
  add.append("Add workspace…", detailLine("Clone a store from its address"));
  group.append(add);
  if (entry?.added) {
    const remove = document.createElement("prism-menu-item");
    remove.setAttribute("value", "workspace:remove");
    remove.append(`Remove ${entry.name}…`, detailLine(entry.checkouts.length ? "Its checkouts keep it listed" : "Deletes its clone when nothing here uses it"));
    group.append(remove);
  }
  return group;
}

function noWorkspaceItem() {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("disabled", "");
  item.append("No workspace yet", detailLine("Add one from its store address, or start a Prism session in a project"));
  return item;
}

// A checkout of a workspace leads with the workspace's name, because the records it shows belong to the whole workspace.
function setProjectLabel(identity, projectRoot, workspace = null) {
  project.replaceChildren(projectLabel(identity, workspace));
  projectTile.setAttribute("name", workspace ?? identity.repository ?? folderName(projectRoot));
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
    // An applied action of this page or of another checkout's page on the same records: views that show it update without a reload,
    // and a comment on the open file shows at once rather than at the next check.
    document.dispatchEvent(new CustomEvent("prism:action", { detail: data }));
    if (data?.artifact?.path && data.artifact.path === selectedPath) void showArtifact(selectedPath);
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
  // The canvas's dotted grid scales with the diagram.
  section.querySelector(".diagram-output")?.setAttribute("scale", String(nextScale));
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
    <prism-canvas class="diagram-output"><prism-spinner label="Rendering diagram"></prism-spinner></prism-canvas>
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
  if (parsed.kind === "knowledge") return KNOWLEDGE_PAGES[parsed.page];
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

function tree(label, items, { branching = false } = {}) {
  const holder = document.createElement("prism-tree");
  holder.setAttribute("label", label);
  holder.toggleAttribute("branching", branching);
  holder.append(...items);
  return holder;
}

// A group of a place's sidebar starts with its name as a level 3 heading, and its count when it has one.
function section(label, count = null) {
  const heading = element("h3", "prism-group-heading");
  heading.append(element("span", "", label));
  if (count !== null) heading.append(element("span", "prism-group-count", String(count)));
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

// The view the Roadmap page shows, which only the Roadmap place's sidebar switches, is the person's preference, so every roadmap opens in the view
// they last chose; a lane whose heading the next drawn board scrolls into view.
const roadmapView = () => preference("roadmap.view");
let pendingLane = null;
{
  const address = new URLSearchParams(location.search);
  const lane = address.get("lane");
  if (address.get("artifact") === "roadmap" && LANES.some(([name]) => name === lane)) pendingLane = { path: "roadmap", lane };
}

const addressedPlace = new URLSearchParams(location.search).get("place");
// An address that names a store artifact or a code file and no place opens Knowledge, whose sidebar holds the store's scopes and the scope filter.
const addressedRecord = /^(store|code):/.test(new URLSearchParams(location.search).get("artifact") ?? "");
let currentPlace = placeNamed(addressedPlace) ? addressedPlace : addressedRecord ? "knowledge" : readStoredPlace() ?? DEFAULT_PLACE;
if (placeNamed(addressedPlace)) storePlace(addressedPlace);

// The page names no place until it knows the current one, and names it at once, before the workspace loads, so a person whose place is History never sees Attention first.
function showPlaceHead() {
  const place = placeNamed(currentPlace);
  placeHead.setAttribute("heading", place.label);
  placeHead.setAttribute("subtitle", place.subtitle);
  sidebar.setAttribute("aria-label", place.label);
}
showPlaceHead();

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
  // Roadmap opens its page as a sidebar link would, in a kept tab from a Ctrl or Cmd click; in the drawer the place shows first,
  // and the drawer closes once the page has opened and the person has seen the place switch, as it does after any page chosen in it.
  if (fromRail && name === "roadmap") {
    const drawn = navDrawer.isOpen;
    const shown = openRef("roadmap", { keep, keepDrawer: true });
    if (drawn) closeDrawerAfter(shown, "roadmap");
  }
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
    // Initiatives with one slice and with several line up across the groups, so none reads as another's parent.
    parts.push(section(group.label, rows.length), tree(group.label, rows, { branching: true }));
  }
  if (!shown) parts.push(element("p", "nav-note", typed ? `No work matches "${typed}".` : "Nothing is designed and unshipped."));
  if (scope.kind === "initiative" && scope.valid === false && (navigation.places?.work?.groups ?? []).some((group) => group.initiatives.some((entry) => entry.id === scope.id))) parts.push(element("p", "nav-note", "The initiative record is invalid."));
  const foot = element("p", "prism-foot-note");
  const glyph = element("span", "prism-foot-note-glyph");
  glyph.append(kitElement("prism-icon", { name: "clock", size: "xs" }));
  foot.append(glyph, element("span", "", "Shipped work moves to History. Emerging and unplanned items stay on the Roadmap."));
  parts.push(foot);
  return parts;
}

// The Roadmap place's view switch stays one element across renders, so the arrow keys keep their focus on it while the sidebar redraws.
let roadmapViewSwitch = null;
const LANE_VALUE = "roadmap-lane:";

function roadmapViews() {
  if (!roadmapViewSwitch) {
    roadmapViewSwitch = kitElement("prism-segmented", { label: "View", class: "nav-views" });
    roadmapViewSwitch.append(...ROADMAP_VIEWS.map(([value, label]) => kitElement("span", { value }, label)));
    roadmapViewSwitch.addEventListener("change", (event) => {
      event.stopPropagation();
      showRoadmapView(event.detail?.value);
    });
  }
  roadmapViewSwitch.setAttribute("value", roadmapView());
  return roadmapViewSwitch;
}

// Switching the view redraws the Roadmap page in it, and opens the page when another one shows, keeping the drawer open as a place's choice does.
function showRoadmapView(view) {
  if (!ROADMAP_VIEWS.some(([name]) => name === view)) return;
  void setPreference("roadmap.view", view).catch(() => showToast("The view changed here, but the review app could not store the choice."));
  renderNavigation();
  openRef("roadmap", { keepDrawer: true });
}

// A lane link opens the Roadmap's board with that lane's heading in view, and scrolls to it again while the board shows.
function showLane(lane, { keep = false } = {}) {
  if (!LANES.some(([name]) => name === lane)) return;
  void setPreference("roadmap.view", "board").catch(() => {});
  pendingLane = { path: "roadmap", lane };
  openRef("roadmap", { keep });
}

function revealLane() {
  const heading = laneHeading(artifact, pendingLane.lane);
  pendingLane = null;
  if (!heading) return;
  workspace.scrollTop += heading.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 16;
}

/**
 * Roadmap: the choice of the page's view, Board, List, or Graph, marked with the view the page shows, then one entry per lane with its open initiatives;
 * a lane entry is a link to the board at that lane.
 */
function roadmapNavigation() {
  const open = (navigation.initiatives ?? []).filter((item) => item.band && item.state !== "shipped" && item.state !== "superseded" && item.state !== "unlisted");
  const lanes = LANES.map(([lane, band]) => {
    const count = open.filter((item) => item.band === band).length;
    return treeItem(`${LANE_VALUE}${lane}`, band, { start: [navIcon("roadmap")], end: [meta(String(count))], tip: `${band} · ${count} open ${count === 1 ? "initiative" : "initiatives"}`, href: `./review?artifact=roadmap&lane=${lane}` });
  });
  return [section("View"), roadmapViews(), section("Lanes"), tree("Lanes", lanes)];
}

// Knowledge's search field stays one element across renders, so typing in it keeps its focus and its text while the results below it change.
let knowledgeSearchField = null;
// The last answer of the records search, by the text it answered, and the text the field asked for last.
let knowledgeResults = null;
let knowledgeAsked = "";
let knowledgeTimer = null;
const KNOWLEDGE_SEARCH_MINIMUM = 2;
const KNOWLEDGE_SEARCH_DELAY_MS = 150;
const KNOWLEDGE_GROUPS = [["requirement", "Requirements", "list"], ["decision", "Decisions", "scale"], ["glossary-term", "Glossary", "book"], ["diagram", "Diagrams", "diagram"]];

function knowledgeQuery() {
  return (knowledgeSearchField?.value ?? "").trim();
}

// The search asks the server once the person stops typing for a moment, and draws the answer only while the field still holds its text.
function askKnowledgeSearch() {
  clearTimeout(knowledgeTimer);
  const query = knowledgeQuery();
  if (query.length < KNOWLEDGE_SEARCH_MINIMUM) {
    knowledgeAsked = "";
    renderNavigation();
    return;
  }
  knowledgeTimer = setTimeout(async () => {
    knowledgeAsked = query;
    let answer;
    try {
      answer = await fetchJson(`./api/records/search?q=${encodeURIComponent(query)}`);
    } catch {
      answer = { query, groups: [], failed: true };
    }
    if (knowledgeQuery() !== query) return;
    knowledgeResults = { ...answer, query };
    renderNavigation();
  }, KNOWLEDGE_SEARCH_DELAY_MS);
}

function knowledgeSearch(total) {
  if (!knowledgeSearchField) {
    knowledgeSearchField = kitElement("prism-field", { type: "search", variant: "filter", class: "nav-filter nav-search" });
    const icon = navIcon("search");
    icon.slot = "start";
    icon.setAttribute("size", "sm");
    knowledgeSearchField.append(icon);
    knowledgeSearchField.addEventListener("input", () => askKnowledgeSearch());
    knowledgeSearchField.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !knowledgeSearchField.value) return;
      event.preventDefault();
      event.stopPropagation();
      knowledgeSearchField.value = "";
      askKnowledgeSearch();
    });
  }
  const label = `Search ${total} ${total === 1 ? "record" : "records"}`;
  knowledgeSearchField.setAttribute("label", label);
  knowledgeSearchField.setAttribute("placeholder", label);
  return knowledgeSearchField;
}

// The matching records grouped by kind, each opening its page, or a note when nothing matches; until the first answer arrives the groups stay.
function knowledgeMatches(query) {
  if (!knowledgeResults || knowledgeResults.query !== query) return null;
  if (knowledgeResults.failed) return [element("p", "nav-note", "The search could not be run.")];
  if (!knowledgeResults.groups.length) return [element("p", "nav-note", `No record matches "${query}".`)];
  const parts = [];
  for (const [kind, label, icon] of KNOWLEDGE_GROUPS) {
    const group = knowledgeResults.groups.find((entry) => entry.kind === kind);
    if (!group?.results.length) continue;
    // A glossary term opens the Glossary, so it is never marked as the open page.
    const rows = group.results.map((result) => treeItem(result.ref, result.title, { selected: kind !== "glossary-term" && selectedPath === result.ref, start: [navIcon(icon)], tip: result.title }));
    parts.push(section(label), tree(label, rows));
  }
  return parts;
}

/**
 * Knowledge: the records search, then Start from, the entry points into the records behind the person's work, then Browse by kind,
 * each kind's list with its count; while the search holds two or more characters, its matches replace the groups.
 */
function knowledgeNavigation() {
  const glossary = navigation.glossary ?? {};
  const library = navigation.library ?? {};
  const entries = navigation.places?.knowledge ?? {};
  const count = (value) => Number.isInteger(value) ? [meta(String(value))] : [];
  const total = ["requirements", "decisions", "terms", "diagrams"].reduce((sum, kind) => sum + (Number.isInteger(library[kind]) ? library[kind] : 0), 0);
  const field = knowledgeSearch(total);
  const query = knowledgeQuery();
  const matches = query.length >= KNOWLEDGE_SEARCH_MINIMUM ? knowledgeMatches(query) : null;
  if (matches) return [field, ...matches];
  const row = (ref, label, icon, end) => treeItem(ref, label, { selected: selectedPath === ref, start: [navIcon(icon)], end });
  return [
    field,
    section("Start from"),
    tree("Start from", [
      row("knowledge:touched", "Touched by my work", "branch", count(lastSlice ? touchedCount : 0)),
      row("knowledge:changed", "Changed this week", "clock", count(entries.changed))
    ]),
    section("Browse by kind"),
    tree("Browse by kind", [
      row("requirements", ENTITY_LABELS.requirements, "list", count(library.requirements)),
      row("decisions", ENTITY_LABELS.decisions, "scale", count(library.decisions)),
      row("glossary", "Glossary", "book", glossary.exists ? count(library.terms) : [element("span", "nav-state", "missing")]),
      row("knowledge:diagrams", "Diagrams", "diagram", count(library.diagrams)),
      ...(codeRepositories.length ? [row("code", ENTITY_LABELS.code, "code", [])] : [])
    ]),
    ...storeNavigation()
  ];
}

/**
 * History: every initiative with a shipped or superseded decision, newest decision first, each leading to its page with the decision's date;
 * a superseded one carries a muted mark, and its tooltip names what superseded it.
 */
function historyNavigation() {
  const settled = navigation.places?.history ?? [];
  if (!settled.length) return [element("p", "nav-note", "Nothing has shipped yet.")];
  const titles = new Map((navigation.initiatives ?? []).map((item) => [item.id, item.title]));
  return [tree("History", settled.map((entry) => {
    const ref = `initiative:${entry.id}`;
    const date = shortDate(entry.at);
    const superseded = entry.decision === "superseded";
    const end = [];
    if (superseded) end.push(element("span", "prism-tree-flag is-muted", "Superseded"));
    if (date) end.push(meta(date));
    const by = superseded && entry.by ? ` by ${titles.get(entry.by) ?? entry.by}` : "";
    const tip = `${entry.title} · ${superseded ? "Superseded" : "Shipped"}${date ? ` ${date}` : ""}${by}`;
    // The glyph names the state only for shipped work, since the Superseded mark already says it.
    const glyph = kitElement("prism-state", { state: superseded ? "superseded" : "shipped", label: superseded ? null : "Shipped", "aria-hidden": superseded ? "true" : null });
    return treeItem(ref, entry.title, { selected: selectedPath === ref, start: [glyph], end, tip });
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
  const key = JSON.stringify([currentPlace, selectedPath, scope, attention, navigation.initiatives, navigation.places, navigation.glossary, navigation.library, navigation.diagnostics, claims, [...treeToggles], workFilterField?.value ?? "", knowledgeQuery(), knowledgeResults, attentionMoreOpen, roadmapView(), currentPlace === "knowledge" ? [lastSlice, touchedCount] : null, storeSignature, scopeFilter && [...scopeFilter]]);
  if (key === navigationKey) return;
  navigationKey = key;
  const focused = document.activeElement?.closest?.("prism-tree-item");
  const refocus = focused && navRoot.contains(focused) ? focused.getAttribute("value") : null;
  const place = placeNamed(currentPlace);
  showPlaceHead();
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
  const history = artifact.querySelector("[data-shipped-history]");
  if (history) {
    history.innerHTML = documentHistoryHtml(path);
  }
  // A slice's or initiative's tab takes the title its context names.
  renderTabs();
}

// A slice document of a shipped initiative carries the shipped history label from its context.
function documentHistoryHtml(path) {
  return shippedHistoryHtml(currentContext?.ref === path ? currentContext.value.shippedHistory : null);
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
  // The new view is built out of sight beside the one showing and replaces it whole once it is drawn, graphs and diagrams included,
  // so a refresh changes the page without showing it empty or half drawn.
  dropStages();
  memory.generation = stageGeneration;
  memory.stage = element("div", "artifact-view artifact-stage");
  memory.stage.setAttribute("aria-hidden", "true");
  memory.stage.inert = true;
  workspace.append(memory.stage);
  return memory;
}

// Each rebuild, and each page written straight into the artifact area, starts a new generation, so a slower build that an earlier one began is dropped rather than shown over it.
let stageGeneration = 0;

function dropStages() {
  stageGeneration += 1;
  for (const stage of workspace.querySelectorAll(":scope > .artifact-stage")) stage.remove();
}

// A page written straight into the artifact area, such as an error or a missing page, ends any build in progress.
function writeArtifact(html) {
  dropStages();
  rebuilding = false;
  artifact.innerHTML = html;
}

// A reader who asks for less motion gets the jump; everyone else sees the page travel to the section, so they keep track of where they went.
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

function scrollToAnchor(anchor, { smooth = false } = {}) {
  const target = anchorTarget(artifact, anchor);
  if (!target) return false;
  revealInDocument(target);
  // A line range stays marked in the source view, so the reader sees which lines a link meant.
  const range = anchor.match(LINE_RANGE);
  artifact.querySelectorAll(".source-lines li.in-range").forEach((line) => line.classList.remove("in-range"));
  if (range?.[2]) {
    for (let line = target; line && Number(line.id.slice(HEADING_PREFIX.length + 1)) <= Number(range[2]); line = line.nextElementSibling) line.classList.add("in-range");
  }
  // A maximized document scrolls itself; any other page scrolls the workspace.
  const scroller = target.closest(".is-maximized") ?? workspace;
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  scroller.scrollTo({ top, behavior: smooth && !reducedMotion?.matches ? "smooth" : "instant" });
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
      // The kit's maximize button; a document with contents carries it in the contents header, which stays in view while the document scrolls.
      button = document.createElement("prism-maximize");
      button.dataset.maximize = key;
      const contents = card.querySelector(":scope > prism-contents");
      const tools = card.querySelector(":scope .diagram-tools");
      if (contents) {
        button.slot = "tools";
        contents.append(button);
      } else if (tools) {
        tools.appendChild(button);
      } else {
        button.toggleAttribute("floating", true);
        card.prepend(button);
      }
      button.addEventListener("prism-maximize-request", (event) => setMaximized(path, event.detail.maximized ? key : null));
    }
    const maximized = state.maximized === key;
    found ||= maximized;
    card.classList.toggle("is-maximized", maximized);
    button.toggleAttribute("maximized", maximized);
    // A maximized document keeps its contents header at the top even when the contents sit above it.
    card.querySelector(":scope > prism-contents")?.toggleAttribute("pinned", maximized);
  });
  if (!found) state.maximized = null;
  document.body.classList.toggle("has-maximized", found);
  markCurrentSection(artifact, workspace.getBoundingClientRect().top);
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
    acceptNode: (node) => node.parentElement?.closest("prism-contents, [data-maximize], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
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
  // A build that a later one replaced leaves the page to the later one.
  if (memory.generation !== stageGeneration) {
    memory.stage.remove();
    return;
  }
  rebuilding = false;
  if (memory.path !== selectedPath) {
    memory.stage.remove();
    artifact.style.minHeight = "";
    return;
  }
  // The reader may have scrolled the page while the new view was built, so a refresh of the same page keeps where they are now.
  if (renderedPath === memory.path) memory.top = workspace.scrollTop;
  artifact.replaceChildren(...memory.stage.childNodes);
  memory.stage.remove();
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
  if (pendingLane?.path === memory.path) revealLane();
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
    writeArtifact("");
    renderMissing(artifact, path, { entity: Boolean(parseEntityRef(path)), label: pageLabel(path), onClose: () => closeTab(path) });
  }
  setBusy(false);
}

// A file that exists but is not shown, such as a binary file or one over 512 KiB, keeps its tab and says why.
function showNotShown(path, message) {
  if (path !== selectedPath) return;
  if (lastSnapshot !== `not-shown:${path}`) {
    lastSnapshot = `not-shown:${path}`;
    renderedPath = null;
    pageBar.setActions([]);
    const state = document.createElement("prism-empty-state");
    state.setAttribute("heading", "This file is not shown");
    state.dataset.notShown = "";
    const where = document.createElement("p");
    where.dataset.codeSubject = "";
    where.textContent = path;
    const detail = document.createElement("p");
    detail.textContent = message;
    state.append(where, detail);
    writeArtifact("");
    artifact.replaceChildren(state);
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
  const message = await response.text();
  writeArtifact(`<div class="document-sheet"><p class="error">${escapeHtml(message)}</p></div>`);
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
  // Touched by my work's records come from the remembered slice rather than from the page's address, so they join the snapshot and a change to them redraws the page.
  if (entity.kind === "touched") entity.touched = await touchedAnswer(lastSlice);
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
  memory.stage.innerHTML = `
    <header class="artifact-header">
      <div>
        <h1>${escapeHtml(label.title)}</h1>
        ${label.lead ? `<div class="artifact-lead${state.leadExpanded ? " is-expanded" : ""}"><p>${escapeHtml(label.lead)}</p><prism-button variant="ghost" size="sm" data-lead-toggle hidden>${state.leadExpanded ? "Less" : "More"}</prism-button></div>` : ""}
      </div>
    </header>`;
  const lead = memory.stage.querySelector(".artifact-lead");
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
  memory.stage.appendChild(container);
  await renderEntity(container, entity, { ...viewContext(path, state), renderMarkdown: (source, basePath = null) => renderText("document.md", source, markdownOptions(basePath)),
    // The Code page turns a repository's code content on or off with the tab's write session, and then reads the page again.
    canWrite: () => Boolean(writeSession()),
    setCode: (repository, enabled) => setCodeContent(repository, enabled),
    refresh: () => {
      lastSnapshot = "";
      if (path === selectedPath) void showArtifact(path);
    } });
  endRebuild(memory);
}

// The slice whose page the person selected last since the page loaded, as `<initiative>/<slug>`, which Touched by my work lists the records of,
// and the number of those records for the sidebar's count once the server answered for that slice.
let lastSlice = null;
let touchedCount = null;

function rememberSlice(path) {
  const parsed = parseEntityRef(path ?? "");
  if (parsed?.kind !== "slice") return;
  const slice = `${parsed.id}/${parsed.slug}`;
  if (slice === lastSlice) return;
  lastSlice = slice;
  void countTouched(slice);
}

// The server's last answer for Touched by my work, kept so that one request that fails while the page polls leaves the page and its count as they were.
let touchedKept = { slice: null, answer: null };

// The server's answer for Touched by my work of one slice, as { slice, answer }, with a null answer when there is no slice
// or the server says the slice does not exist or is not named right (a 4xx answer such as 404 unknown_slice),
// and the slice's last answer, or null before it had one, when no answer came (a network error, a stopped connection, or a 5xx).
async function touchedAnswer(slice) {
  if (!slice) return { slice: null, answer: null };
  try {
    const answer = await fetchJson(`./api/touched?slice=${encodeURIComponent(slice)}`);
    touchedKept = { slice, answer };
    return { slice, answer };
  } catch (error) {
    if (error?.status >= 400 && error.status < 500) {
      if (touchedKept.slice === slice) touchedKept = { slice: null, answer: null };
      return { slice, answer: null };
    }
    return { slice, answer: touchedKept.slice === slice ? touchedKept.answer : null };
  }
}

// Touched by my work's count is its records behind the remembered slice, and 0 while no slice was selected.
async function countTouched(slice) {
  const { answer } = await touchedAnswer(slice);
  noteTouched(slice, answer);
}

function noteTouched(slice, answer) {
  if (slice !== lastSlice) return;
  const count = answer ? answer.groups.reduce((sum, group) => sum + group.records.length, 0) : null;
  if (count === touchedCount) return;
  touchedCount = count;
  // Only Knowledge shows the count, so another place's sidebar is not rebuilt for it.
  if (currentPlace === "knowledge") renderNavigation();
}

async function showArtifact(path) {
  rememberSlice(path);
  await refreshContext(path);
  if (path !== selectedPath) {
    return;
  }
  if (parseEntityRef(path)) {
    await showEntity(path);
    return;
  }
  const response = await appFetch(`./api/artifact?${artifactQuery(path)}`, { cache: "no-store" });
  if (response.status === 404) {
    // A code file that is held but not shown, such as a binary or large file, says so rather than that it was moved or deleted.
    const refused = isCodeRef(path) ? await response.json().catch(() => null) : null;
    if (refused?.code === "file_not_shown") showNotShown(path, refused.message);
    else showMissing(path);
    return;
  }
  if (!response.ok) {
    await showError(response);
    return;
  }
  const data = codeCloneRead(await response.json());
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
  memory.stage.innerHTML = `
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
        ${data.branch ? `<prism-chip data-branch-label tip="The branch of the repository's code clone that this file is read from">${escapeHtml(data.branch)}</prism-chip>` : ""}
        ${named.code || structured ? `<prism-chip>${escapeHtml(kind)}</prism-chip>` : ""}
        ${source ? "<prism-chip>Read-only</prism-chip>" : structured ? "" : `<prism-chip>${diagramLabel}</prism-chip>`}
      </div>
    </header>
    ${artifactReviewHtml(data, state)}
    <div class="document-history" data-shipped-history>${documentHistoryHtml(path)}</div>
    ${documentCard}`;
  // A store artifact shows its review view above its content, and its comment form keeps an unsent comment across the page's live updates.
  // More comments lists further comments in place, so the page takes what the card now lists as what it shows and redraws only when that changes.
  mountArtifactReview(memory.stage, data, { actionApi, state, readPage, onListed: (listed) => { if (listed.path === selectedPath) lastSnapshot = JSON.stringify(listed); } });
  pageBar.setActions(structured ? modeButtons(state, path) : []);
  if (structured) {
    const container = document.createElement("div");
    container.className = "structured-view";
    memory.stage.appendChild(container);
    await renderView(container, data, viewContext(data.path, state));
    endRebuild(memory);
    return;
  }
  for (const diagram of data.diagrams) {
    const section = diagramCard(diagram);
    memory.stage.appendChild(section);
    await renderDiagram(diagram.source, section.querySelector(".diagram-output"), section);
  }
  endRebuild(memory);
}

// Turn a repository's code content on or off, answering { message } when the app refused it.
async function setCodeContent(repository, enabled) {
  if (!requireApp()) return null;
  const response = await fetch(`./api/code/${encodeURIComponent(repository)}`, { method: "PUT", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ enabled }) });
  const answer = await response.json().catch(() => ({ message: "The review app returned an unreadable answer." }));
  if (!response.ok) return { message: answer.message ?? "The review app could not change the code content." };
  return answer.code?.state === "unreachable" ? { message: answer.code.message } : null;
}

// A code file read from a repository's code clone names its path below the repository and its branch, so the page shows it as a read-only source file by its ref.
function codeCloneRead(data) {
  if (!isCodeRef(data?.ref) || data.kind !== undefined || typeof data.content !== "string") return data;
  return { ...data, path: data.ref, file: data.path, kind: "source", diagrams: [] };
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
    const error = new Error(await response.text());
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function viewContext(path, state) {
  return {
    path,
    state,
    // The Roadmap page's view as its place's sidebar chose it, and the lane a lane link asks it to show.
    roadmapView: roadmapView(),
    lane: pendingLane?.path === path ? pendingLane.lane : null,
    // Touched by my work reads the slice in the selected tab, or else the one selected last, and passes its answer back for the sidebar's count.
    touchedSlice: () => lastSlice,
    fetchTouched: async (slice) => (await touchedAnswer(slice)).answer,
    onTouched: (slice, answer) => noteTouched(slice, answer),
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
      // A diagram mounted after the page drew, such as on a slice's Diagram tab, gets its Maximize control too.
      if (path === selectedPath) decorateMaximize(path);
    },
    // A gate answer is the gate's answer action, applied against the revision its listing shows.
    // An approval gate of a requirement or ADR is the target approval:<id>, since the artifact's status record in the store holds it, and its revision is the artifact's version.
    async answerGate({ initiative, approval, id, choice, note }) {
      if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
      const target = approval ? `approval:${id}` : `gate:${initiative}/${id}`;
      const unanswered = () => {
        throw new Error("The review app did not answer, so the answer was not recorded. Try again in a moment.");
      };
      const listed = await appFetch(`./api/actions?target=${encodeURIComponent(target)}`, { headers: writeHeaders() }).catch(unanswered);
      const listing = await listed.json().catch(() => ({}));
      if (!listed.ok) throw Object.assign(new Error(listing.message ?? "The answer was not recorded."), { code: listing.code === "unknown_target" ? "unknown_gate" : listing.code });
      const action = (listing.actions ?? []).find((item) => item.id === "gate.answer");
      // A question the server no longer takes an answer to, such as one of a shipped initiative, is refused with the server's own reason.
      if (action && !action.available) throw Object.assign(new Error(action.reason ?? "The answer was not recorded."), { code: "action_unavailable" });
      const names = new Set((action?.fields ?? []).map((field) => field.name));
      const input = Object.fromEntries([["choice", choice], ["note", note]].filter(([name, value]) => names.has(name) && value !== null && value !== undefined && value !== ""));
      const response = await appFetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ action: "gate.answer", target, input, revision: action?.revision ?? null }) }).catch(unanswered);
      const result = await response.json().catch(() => ({ message: "The server returned an unreadable response." }));
      if (!response.ok) {
        // A withdrawn question reads as one, and any other refusal carries the server's reason.
        const code = result.code === "unknown_target" ? "unknown_gate" : result.code;
        throw Object.assign(new Error(result.reason ?? result.message ?? "The answer was not recorded."), { code });
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
    { ref: "glossary", label: "Glossary", kind: "place", detail: "Library" },
    { ref: "knowledge:diagrams", label: "Diagrams", kind: "place", detail: "Library" },
    { ref: "launches", label: "Launched sessions", kind: "place", detail: "Headless sessions on this computer" }
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

// The drawer holds a rail of its own beside the sidebar, which moves into the drawer while the drawer is open, so one set of trees serves both.
// Focus goes to the sidebar's selected item, or else to the current place's button of the rail beside it.
function focusPlaces(rail) {
  const selected = navRoot.querySelector("prism-tree-item[selected]");
  if (selected) return selected.focus();
  rail.querySelector(`prism-rail-item[data-place="${currentPlace}"]`)?.focus();
}

// Above 1100px the sidebar can hide and leave the rail, and narrower windows ignore the choice; the choice is the person's preference,
// kept by the review app for every port, and a choice an older page kept in this browser moves there once.
const LEGACY_SIDEBAR_KEY = "prism.review.sidebar";
const wideWindow = matchMedia("(min-width: 1101px)");

function readSidebarCollapsed() {
  try {
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_KEY);
    localStorage.removeItem(LEGACY_SIDEBAR_KEY);
    if (legacy === "collapsed") void setPreference("sidebar.collapsed", true).catch(() => {});
  } catch {
    // A browser without storage has no older choice to move.
  }
  return preference("sidebar.collapsed");
}

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  shell.classList.toggle("sidebar-collapsed", collapsed);
  const action = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("label", action);
  sidebarToggle.setAttribute("tip", `${action} ([)`);
  if (remember) void setPreference("sidebar.collapsed", collapsed).catch(() => showToast("The sidebar changed here, but the review app could not store the choice."));
}
// The sidebar shows as this browser last left it as soon as the page runs, and the review app's stored choice applies once the workspace loads.
setSidebarCollapsed(readSidebarCollapsed(), { remember: false });
// The rail's sidebar button works from the first moment too, so a click while the workspace loads is not lost.
sidebarToggle.addEventListener("prism-select", () => setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed")));

// The drawer places its children in its body a microtask after they arrive, so focus moves once the sidebar sits inside the open drawer.
// How long the drawer keeps showing a place whose choice also opened a page, so the switch is seen before the drawer closes.
const DRAWER_LINGER_MS = 700;
// The pending close of the drawer after such a choice; opening or closing the drawer meanwhile cancels it.
let drawerCloseTicket = null;

function closeDrawerAfter(shown, path) {
  const ticket = {};
  drawerCloseTicket = ticket;
  void Promise.allSettled([shown, new Promise((resolve) => setTimeout(resolve, DRAWER_LINGER_MS))]).then(() => {
    if (drawerCloseTicket !== ticket) return;
    drawerCloseTicket = null;
    if (navDrawer.isOpen && selectedPath === path) navDrawer.close();
  });
}

async function openDrawer() {
  drawerCloseTicket = null;
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
  drawerCloseTicket = null;
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
  showLeftNotice();
  // The views start from the person's stored preferences, such as the roadmap's view, so they wait for them alongside the index.
  const [index] = await Promise.all([fetchJson("./api/index"), preferencesReady()]);
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
    onOpen: (ref, event) => openRef(ref, { keep: Boolean(event?.ctrlKey || event?.metaKey) }),
    onPlace: (name) => choosePlace(name)
  });
  showHistory();
  recordStoreStatus = createRecordStoreStatus({
    storeButton: document.getElementById("store-status"),
    storeLabel: document.getElementById("store-status-label"),
    syncPart: document.getElementById("store-sync"),
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
  tabGroups = Array.isArray(data.groups) ? data.groups : [];
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
  const followSections = () => {
    cancelAnimationFrame(sectionFrame);
    sectionFrame = requestAnimationFrame(() => markCurrentSection(artifact, workspace.getBoundingClientRect().top));
  };
  workspace.addEventListener("scroll", () => {
    if (!rebuilding && renderedPath && renderedPath === selectedPath) scrollPositions.set(renderedPath, workspace.scrollTop);
    followSections();
  }, { passive: true });
  // A maximized document scrolls inside its own card, and the window size sets how much of the contents fits, so both follow the current section too.
  artifact.addEventListener("scroll", (event) => {
    if (event.target.classList?.contains("is-maximized")) followSections();
  }, { passive: true, capture: true });
  window.addEventListener("resize", followSections, { passive: true });
  // Choosing another project opens its review page; opening the menu refreshes the list first.
  projectPoller = createPoller({ run: refreshProjects, interval: 5000 });
  watchWorkspaceMenu();
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
    // A checkout's text match in a store artifact found by its path opens the store artifact, follows the scope filter, and names its scope.
    // A workspace's search names each store artifact by its ref and scope, and adds the code matches of its indexed components, each opened from its repository,
    // and the components it left out.
    search: async (query) => {
      const answer = await fetchJson(`./api/search?q=${encodeURIComponent(query)}`);
      const results = answer.results.flatMap((result) => {
        const ref = result.ref ?? localTab(result.path);
        if (!isStoreRef(ref)) return [result];
        const scope = result.scope?.label ?? refScopes.get(ref) ?? "workspace";
        return scopeShown(scope) ? [{ ...result, path: ref, scope }] : [];
      });
      if (!Array.isArray(answer.code)) return results;
      const code = answer.code.map((match) => ({ ...match, ref: `code:${match.component.split("/")[0]}:${match.file}` }));
      return { results, code, leftOut: answer.leftOut ?? [] };
    },
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
  // Ctrl-click or Cmd-click on a sidebar item opens it as a kept tab, and a double click keeps the tab it opened.
  let navKeep = false;
  navRoot.addEventListener("click", (event) => {
    navKeep = event.ctrlKey || event.metaKey;
  }, { capture: true });
  navRoot.addEventListener("prism-select", (event) => {
    const ref = event.detail?.value;
    // A scope of the store tree opens and closes its list of artifacts rather than opening a page.
    if (ref?.startsWith(SCOPE_ITEM)) {
      const item = [...navRoot.querySelectorAll("prism-tree-item")].find((node) => node.getAttribute("value") === ref);
      treeToggles.set(ref, !(item?.hasAttribute("expanded") ?? false));
      renderNavigation();
      navKeep = false;
      return;
    }
    if (ref && Object.hasOwn(NAVIGATION_ACTIONS, ref)) NAVIGATION_ACTIONS[ref]();
    else if (ref?.startsWith(LANE_VALUE)) showLane(ref.slice(LANE_VALUE.length), { keep: navKeep });
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
  onPreferencesChange((keys, preferences) => {
    if (keys.includes("sidebar.collapsed") && preferences["sidebar.collapsed"] !== shell.classList.contains("sidebar-collapsed")) setSidebarCollapsed(preferences["sidebar.collapsed"], { remember: false });
  });
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
      if (!scrollToAnchor(anchor, { smooth: true })) showToast(`No heading #${anchor} in this document.`);
      else if (docLink.closest("prism-contents")) {
        // The contents follow the scroll on their way to the section, so the chosen link is marked again once the scroll ends,
        // for a last section too short to reach the top of the page.
        const contents = docLink.closest("prism-contents");
        const scroller = docLink.closest(".is-maximized") ?? workspace;
        const mark = () => contents.markCurrent?.(docLink);
        requestAnimationFrame(mark);
        if ("onscrollend" in scroller) {
          // A scroll that had no distance to go never ends, so the wait gives up rather than mark the link after a later scroll of the reader's.
          const waiting = new AbortController();
          scroller.addEventListener("scrollend", () => requestAnimationFrame(mark), { once: true, signal: waiting.signal });
          setTimeout(() => waiting.abort(), 2000);
        }
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
    const from = pages.index;
    if (Number.isInteger(event.state?.index)) pages.index = event.state.index;
    const ref = localTab(event.state?.ref ?? new URLSearchParams(location.search).get("artifact"));
    if (ref) pages.refs[pages.index] = ref;
    // The browser's own buttons can land on an entry that shows the open page; the move goes on to the next entry in the same direction.
    if (ref === selectedPath && pages.index !== from) {
      const target = nextEntry(pages.index, pages.index < from ? -1 : 1);
      if (target !== null) {
        history.go(target - pages.index);
        return;
      }
    }
    storeHistoryTop();
    showHistory();
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
      const answered = refreshed?.ok ? await refreshed.json().catch(() => null) : null;
      reportRefresh(Boolean(answered));
      const storeBefore = storeSignature;
      if (answered) useStoreRefs(answered);
      const snapshot = answered && localSession(answered);
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
        // Knowledge's sidebar counts the remembered slice's records, which can change without the navigation changing; the Touched page counts them as it draws.
        if (currentPlace === "knowledge" && lastSlice && selectedPath !== "knowledge:touched") await countTouched(lastSlice);
      }
    } catch {
    }
  } });
  // The first check waits one interval, since the page has just drawn from a fresh index.
  setTimeout(() => void indexPoller.start(), 1500);
}

initialize().catch((error) => {
  writeArtifact(`<div class="document-sheet"><p class="error">${escapeHtml(error.message)}</p></div>`);
  setBusy(false);
});
