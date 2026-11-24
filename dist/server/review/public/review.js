// Generated from src/server/review/public/review.ts by scripts/native-build/compile.mjs.
import { renderToString } from "./vendor/plantuml.js";
import { renderView } from "./views/registry.js";
import { closeEvidence, openEvidence } from "./views/evidence.js";
import { ENTITY_LABELS, entityLabel, KNOWLEDGE_PAGES, parseEntityRef, recordKind, recordLabel, renderEntity } from "./views/entities.js";
import { createPalette } from "./views/palette.js";
import { formatBadgeElement, formatBanner, migratedNote } from "./views/format-marks.js";
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
import { createAgentsMenu } from "./views/agents-menu.js";
import { DENSITIES, onPreferencesChange, preference, preferencesReady, savePreferences, setPreference, THEMES } from "./kit/preferences.js";
import { createActionList, readOnlyNotice, shownActionEntries } from "./views/actions.js";
import { createCodingAgents } from "./views/coding-agents.js";
import { artifactChangesView, artifactReviewHtml, focusAfterMore, mountArtifactReview, readListedComments } from "./views/artifact-review.js";
import { themeDiagram } from "./kit/diagram-theme.js";
import { createWorkspaceForms } from "./views/workspace-forms.js";
import { currentPhase } from "./views/slice.js";
import { messageHtml, shortDate } from "./views/util.js";
import { LANES, laneHeading } from "./views/roadmap.js";
import { createPoller, deadline, POLL_DEADLINE_MS } from "./views/poller.js";
import { createEventRelay } from "./views/event-relay.js";
import { shippedHistoryHtml } from "./views/shipped-history.js";
import { bindViewLinks, requestClause, viewKind, viewNoteHtml } from "./views/design-views.js";
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
const notices = /* @__PURE__ */ new Map();
let projectListing = "";
let selectedPath = new URLSearchParams(location.search).get("artifact");
if (new URLSearchParams(location.search).get("missing") === "project") {
  document.getElementById("missing-project").hidden = false;
  const kept = new URLSearchParams(location.search);
  kept.delete("missing");
  history.replaceState(history.state, "", `${location.pathname}${kept.size ? `?${kept}` : ""}${location.hash}`);
}
let openTabs = [];
let previewTab = null;
let agentTabs = [];
let tabGroups = [];
let sessionRevision = 0;
let sessionInstance = null;
let appVersion = null;
let sessionConnected = false;
let relay = null;
let refreshIndex = null;
const INDEX_CHECK_MS = 5e3;
const INDEX_UNJOINED_MS = 1500;
const ACTION_CHECK_MS = 4500;
let saveQueue = Promise.resolve();
const STORE_REF = "store:";
const isStoreRef = (path) => typeof path === "string" && path.startsWith(STORE_REF);
let pathRefs = /* @__PURE__ */ new Map();
const localTab = (tab) => typeof tab === "string" ? pathRefs.get(tab) ?? tab : tab;
const localTabs = (tabs) => Array.isArray(tabs) ? [...new Set(tabs.map(localTab))] : tabs;
let storeScopes = [];
let refScopes = /* @__PURE__ */ new Map();
let storeNotes = [];
let storeSignature = "";
let codeRepositories = [];
function useStoreRefs(data) {
  pathRefs = new Map(Object.entries(data.storeRefs ?? {}));
  storeScopes = Array.isArray(data.scopes) ? data.scopes : [];
  refScopes = new Map(Object.entries(data.artifactScopes ?? {}).filter(([ref]) => isStoreRef(ref)));
  storeNotes = Array.isArray(data.notes) ? data.notes : [];
  codeRepositories = Array.isArray(data.repositories) ? data.repositories.map((repository) => repository.name) : [];
  storeSignature = JSON.stringify([storeScopes, storeNotes, [...refScopes.keys()].join("\n"), codeRepositories]);
}
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
  if (["requirements", "decisions", "glossary", "knowledge"].includes(parseEntityRef(selectedPath ?? "")?.kind)) void showArtifact(selectedPath);
}
function localSession(snapshot) {
  const named = { ...snapshot };
  for (const key of ["openTabs", "agentTabs", "missingTabs"]) if (Object.hasOwn(snapshot, key)) named[key] = localTabs(snapshot[key]);
  for (const key of ["activeTab", "previewTab"]) if (Object.hasOwn(snapshot, key)) named[key] = localTab(snapshot[key]);
  return named;
}
let lastSnapshot = "";
let renderedPath = null;
let rebuilding = false;
const scrollPositions = /* @__PURE__ */ new Map();
let refreshHeld = false;
let heldBuild = null;
let probes = { failures: 0, failingSince: null };
let connection = "live";
let pendingAnchor = null;
let pendingFind = null;
let availableArtifacts = /* @__PURE__ */ new Set();
let prismRecords = /* @__PURE__ */ new Set();
let missingTabs = /* @__PURE__ */ new Set();
const ATTENTION_KINDS = [
  ["questions", "Questions", "gate"],
  ["findings", "Review findings", "eye"],
  ["failed", "Failed verifications", "flask"],
  ["blocked", "Blocked work", "warning"],
  ["ready", "Ready to ship", "check-circle"],
  ["problems", "Problems", "warning"],
  ["formats", "Format findings", "document"]
];
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
let agentsMenu;
const viewStates = /* @__PURE__ */ new Map();
const treeToggles = /* @__PURE__ */ new Map();
let expiredLink = false;
function appFetch(url, options = {}) {
  const { deadlineMs, ...rest } = options;
  return fetch(url, { signal: deadline(deadlineMs), ...rest }).then((response) => {
    if (response.status === 404 && response.headers.get("X-Prism-Link") === "expired" && !expiredLink) {
      expiredLink = true;
      location.reload();
    }
    return response;
  });
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
function emptyStateButton(text, onClick, variant = "primary") {
  const button = document.createElement("prism-button");
  button.setAttribute("variant", variant);
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}
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
    else setTimeout(check, 5e3);
  };
  setTimeout(check, 5e3);
}
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
const NOTICE_KEY = "prism-review-notice";
function openWithNotice(url, notice) {
  try {
    sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
  } catch {
  }
  if (new URL(url, location.href).href === location.href) location.reload();
  else location.href = url;
}
function showLeftNotice() {
  let notice = null;
  try {
    notice = JSON.parse(sessionStorage.getItem(NOTICE_KEY) ?? "null");
    sessionStorage.removeItem(NOTICE_KEY);
  } catch {
  }
  if (typeof notice?.message === "string" && notice.message) showToast(notice.message, { tone: notice.tone });
}
let listedWorkspaces = [];
const currentEntry = () => listedWorkspaces.find((entry) => entry.id === thisWorkspace?.id) ?? null;
async function removeCurrentWorkspace() {
  const entry = currentEntry();
  if (!entry?.added) return;
  const removed = await workspaceForms().remove(entry);
  if (!removed) return;
  const listed = await fetch(`${appRoot}api/workspaces`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null, () => null);
  const notice = { message: removed.message, tone: removed.clone === "kept" ? "warning" : "success" };
  openWithNotice(listed?.workspaces?.some((item) => item.id === entry.id) ? location.href : appRoot, notice);
}
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
const HISTORY_KEY = "prism.review.history";
const pages = { index: 0, top: 0, refs: [] };
function readHistoryTop() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "null");
    const refs = Array.isArray(stored?.refs) ? stored.refs.map((ref) => typeof ref === "string" ? ref : null) : [];
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
function forwardEntries() {
  const entries = window.navigation?.entries?.();
  const current = window.navigation?.currentEntry;
  if (!Array.isArray(entries) || !current || !Number.isInteger(current.index) || current.index < 0) return null;
  return entries.length - 1 - current.index;
}
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
function nextEntry(from, step) {
  for (let index = from + step; index >= 0 && index <= pages.top; index += step) {
    if (pages.refs[index] !== selectedPath) return index;
  }
  return null;
}
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
const WRITE_SESSION_KEY = "prism-write-session";
const RUN_OPTIONS_DEADLINE_MS = 75e3;
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
const actionApi = {
  async list(target) {
    if (connection === "stopped") throw new Error(STOPPED_MESSAGE);
    const response = await appFetch(`./api/actions?target=${encodeURIComponent(target)}`, { cache: "no-store", headers: writeHeaders() });
    const listing = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(listing.message ?? "The actions could not be read."), { code: listing.code });
    return listing;
  },
  // An action that waits on the person, such as an approval confirmed in a native dialog, passes a longer deadlineMs.
  async apply(request, { deadlineMs } = {}) {
    if (connection === "stopped") return { status: 0, json: { message: STOPPED_MESSAGE } };
    const response = await appFetch("./api/actions/apply", { method: "POST", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify(request), deadlineMs }).catch(() => null);
    if (!response) return { status: 0, json: { message: "The review app did not answer, so the change was not applied. Try again in a moment." } };
    return { status: response.status, json: await response.json().catch(() => ({ message: "The server returned an unreadable response." })) };
  },
  // A host's providers, models, and efforts for a run choice; the read can start the host, so it may take up to a minute.
  async runOptions(query) {
    if (connection === "stopped") return { status: 0, json: { message: STOPPED_MESSAGE } };
    const response = await appFetch(`./api/run-options?${new URLSearchParams(query)}`, { cache: "no-store", headers: writeHeaders(), deadlineMs: RUN_OPTIONS_DEADLINE_MS }).catch(() => null);
    if (!response) return { status: 0, json: { message: "The review app did not answer, so the host's models could not be read. Try again in a moment." } };
    return { status: response.status, json: await response.json().catch(() => ({ message: "The server returned an unreadable response." })) };
  },
  confirm: confirmAction,
  toast: (message) => showToast(message)
};
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
function setBusy(busy) {
  artifact.setAttribute("aria-busy", String(busy));
}
let held = null;
const LINK_KEY = "prism.review.link";
function noteLinkOpened(event) {
  if (!(event.button === 1 || event.button === 0 && event.shiftKey)) return;
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.href);
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  const ref = url.searchParams.get("artifact");
  if (!ref || url.origin !== location.origin || url.pathname !== location.pathname) return;
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch {
  }
}
function openedFromLink(ref) {
  try {
    const note = JSON.parse(localStorage.getItem(LINK_KEY) ?? "null");
    localStorage.removeItem(LINK_KEY);
    return Boolean(note && note.ref === ref && Date.now() - note.at < 15e3);
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
  saveQueue = queued.catch(() => {
  });
  return queued;
}
function newerSnapshot(snapshot, than) {
  return snapshot.instance !== than.instance || (snapshot.revision ?? 0) > (than.revision ?? 0);
}
const tabStrip = document.getElementById("open-tabs");
const PREVIEW_TIP = "Preview tab: the next link replaces it. Double-click to keep it open.";
function tabNames(path) {
  if (parseEntityRef(path)) return { title: pageLabel(path), full: pageLabel(path) };
  const named = describe(path);
  if (named.code) return { title: fileName(path), full: path, code: true };
  const title = named.label === named.kind && named.owner ? `${named.kind} \xB7 ${named.owner}` : named.label;
  return { title, full: title === named.kind ? title : `${named.kind} \xB7 ${title}` };
}
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
  }), { groups: tabGroups.map((group) => ({ name: group.name, collapsed: group.collapsed, opener: groupOpener(group) })) });
}
const openerAvatars = /* @__PURE__ */ new Map();
function groupOpener(group) {
  const by = group.opener;
  if (!by?.agent) return null;
  const claim = by.claim ? claimIndex?.claimFor(by.claim) ?? null : null;
  const kind = [by.host ?? claim?.host ?? "Agent", by.model ?? claim?.model].filter(Boolean).join(" \xB7 ");
  const text = claim ? `${kind}, ${claim.activity === "design" ? "designing" : "implementing"} ${claim.sliceTitle}` : kind;
  const key = JSON.stringify([kind, claim && [claim.ref, claim.label, claim.activity, claim.claimedAt, claim.renewedAt, claim.expiresAt]]);
  let held2 = openerAvatars.get(group.name);
  if (held2?.key !== key) {
    const element2 = claim ? claimElement(claim, "avatar") : document.createElement("prism-avatar");
    if (!claim) {
      element2.setAttribute("kind", "agent");
      element2.setAttribute("size", "sm");
      element2.setAttribute("name", kind);
      element2.setAttribute("tip", `Opened by ${kind}`);
    }
    held2 = { key, element: element2 };
    openerAvatars.set(group.name, held2);
  }
  for (const name of openerAvatars.keys()) if (!tabGroups.some((each) => each.name === name)) openerAvatars.delete(name);
  return { text, element: held2.element };
}
tabStrip.addEventListener("prism-select", (event) => openRef(event.detail?.value));
tabStrip.addEventListener("prism-tab-keep", (event) => keepTab(event.detail?.value));
tabStrip.addEventListener("prism-tab-close", (event) => closeTab(event.detail?.value));
tabStrip.addEventListener("prism-tab-move", (event) => moveTabs(event.detail?.order, event.detail?.groups));
tabStrip.addEventListener("prism-group-toggle", (event) => toggleGroup(event.detail?.group, event.detail?.collapsed));
tabStrip.addEventListener("prism-group-close", (event) => closeTabs(event.detail?.tabs ?? []));
function moveTabs(order, groups) {
  if (!Array.isArray(order) || !requireApp()) return;
  const known = order.filter((path) => openTabs.includes(path));
  openTabs = [...known, ...openTabs.filter((path) => !known.includes(path))];
  if (Array.isArray(groups)) {
    const collapsed = new Map(tabGroups.map((group) => [group.name, group.collapsed]));
    const openers = new Map(tabGroups.filter((group) => group.opener).map((group) => [group.name, group.opener]));
    tabGroups = groups.filter((group) => collapsed.has(group.name)).map((group) => ({ name: group.name, tabs: group.tabs.filter((path) => openTabs.includes(path)), collapsed: collapsed.get(group.name), ...openers.has(group.name) ? { opener: openers.get(group.name) } : {} }));
  }
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}
function toggleGroup(name, collapsed) {
  const group = tabGroups.find((each) => each.name === name);
  if (!group || !requireApp()) return;
  group.collapsed = Boolean(collapsed);
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}
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
  if (sidebarFlyoutOpen() && !keepDrawer) setSidebarFlyout(false);
  setBusy(true);
  renderTabs();
  renderNavigation();
  const shown = showArtifact(path);
  void saveSession().catch((error) => showToast(error.message));
  return shown;
}
function keepTab(path) {
  if (previewTab !== path || !requireApp()) {
    return;
  }
  previewTab = null;
  renderTabs();
  void saveSession().catch((error) => showToast(error.message));
}
function showNothing() {
  welcome();
  pageBar.setTrail([]);
  pageBar.setActions([]);
  currentContext = null;
  contextSnapshot = "";
  renderNavigation();
}
function closeTab(path) {
  if (path) closeTabs([path]);
}
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
  const presented = !first && snapshot.activeSource === "agent" && active !== null && (lastActive?.tab !== active || lastActive?.source !== "agent");
  lastActive = { tab: active, source: snapshot.activeSource ?? null };
  if (held && (presented || active !== held.sessionTab || !nextTabs.includes(held.page))) held = null;
  const nextPreview = nextTabs.includes(snapshot.previewTab) ? snapshot.previewTab : null;
  const nextAgentTabs = Array.isArray(snapshot.agentTabs) ? snapshot.agentTabs.filter((tab) => nextTabs.includes(tab)) : [];
  sessionRevision = nextRevision;
  openTabs = nextTabs;
  previewTab = nextPreview;
  agentTabs = nextAgentTabs;
  tabGroups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
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
function workspaceIdentity(entry) {
  return entry.workspace ?? { repository: folderName(entry.projectRoot), worktree: null, branch: null, detached: false };
}
function workspaceName(identity) {
  if (identity.branch) return identity.detached ? `detached ${identity.branch}` : identity.branch;
  return identity.worktree;
}
const projectName = (identity, projectRoot, workspace2 = null) => workspace2 ?? identity.repository ?? folderName(projectRoot);
function projectTitle(identity, projectRoot) {
  return [projectRoot, identity.branch ? `${identity.detached ? "Detached at" : "Branch:"} ${identity.branch}` : "", identity.worktree ? `Worktree: ${identity.worktree}` : ""].filter(Boolean).join("\n");
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
const collator = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
const appRoot = location.pathname.replace(/\/w\/[0-9a-f]{16}(?:\/.*)?$/, "/").replace(/[^/]*$/, "");
const countText = (count, one, many) => `${count} ${count === 1 ? one : many}`;
function stateHint(entry, { gates = true } = {}) {
  const states = [];
  if (entry.live) states.push("in use");
  if (entry.indexing === "preparing") states.push("indexing");
  if (entry.indexing === "failed") states.push("index failed");
  if (gates && entry.gates === null && entry.checkouts?.length !== 0) states.push("unreadable");
  else if (gates && entry.gates) states.push(countText(entry.gates, "gate", "gates"));
  if (!states.length) return null;
  const hint = element("span", "project-states", states.join(" \xB7 "));
  hint.slot = "hint";
  return hint;
}
function projectItem({ entry, identity }, current) {
  const item = document.createElement("prism-menu-item");
  item.setAttribute("type", "radio");
  item.setAttribute("value", entry.url);
  item.toggleAttribute("checked", entry.id === current);
  item.setAttribute("tip", projectTitle(identity, entry.projectRoot));
  item.append(workspaceName(identity) ?? folderName(entry.projectRoot));
  return item;
}
function workspaceDetail(entry) {
  const repositories = entry.repositories.map((repository) => repository.name);
  const held2 = repositories.length ? repositories.join(", ") : entry.kind === "project" ? "Records kept in the project" : "No repository yet";
  return `${held2} \xB7 ${countText(entry.checkouts.length, "checkout", "checkouts")}`;
}
function workspaceTip(entry) {
  const lines = [entry.name, ...entry.store ? [`Store: ${entry.store.label}`] : []];
  for (const repository of entry.repositories) lines.push(`${repository.name}: ${repository.checkouts.length ? repository.checkouts.join(", ") : "no checkout on this machine"}`);
  const named = new Set(entry.repositories.flatMap((repository) => repository.checkouts));
  for (const checkout of entry.checkouts) if (!named.has(checkout)) lines.push(checkout);
  return lines.join("\n");
}
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
  const text = JSON.stringify(entries);
  if (text === projectListing) return;
  projectListing = text;
  listedWorkspaces = entries;
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", "Workspaces");
  if (entries.length) group.append(...entries.map((entry) => workspaceItem(entry, current)));
  else group.append(noWorkspaceItem());
  const scrolled = projectMenu.scrollTop;
  projectMenu.replaceChildren(group, manageGroup(entries.find((entry) => entry.id === current) ?? null));
  if (projectMenu.isOpen) {
    projectMenu.place();
    projectMenu.scrollTop = scrolled;
  }
}
function manageGroup(entry) {
  const group = document.createElement("prism-menu-group");
  group.setAttribute("label", "Manage");
  const add = document.createElement("prism-menu-item");
  add.setAttribute("value", "workspace:add");
  add.append("Add workspace\u2026", detailLine("Clone a store from its address"));
  group.append(add);
  if (entry?.added) {
    const remove = document.createElement("prism-menu-item");
    remove.setAttribute("value", "workspace:remove");
    remove.append(`Remove ${entry.name}\u2026`, detailLine(entry.checkouts.length ? "Its checkouts keep it listed" : "Deletes its clone when nothing here uses it"));
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
function setProjectLabel(identity, projectRoot, workspace2 = null) {
  const name = projectName(identity, projectRoot, workspace2);
  project.replaceChildren(element("span", "project-label-text project-workspace", name));
  projectTile.setAttribute("name", name);
  const repository = workspace2 && identity.repository && identity.repository !== workspace2 ? `Repository: ${identity.repository}` : "";
  projectButton.setAttribute("tip", [workspace2 ? `Workspace: ${workspace2}` : "", repository, projectTitle(identity, projectRoot)].filter(Boolean).join("\n"));
  signals.project = name;
  document.title = signalTitle(baseTitle(), signals.count ?? 0);
}
function storeWorkspaceName(store) {
  if (!store || store.kind === "project") return null;
  if (store.workspaceName) return store.workspaceName;
  const place = store.kind === "folder" ? store.location : store.label;
  return String(place ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean).pop()?.replace(/\.git$/i, "") || store.label || null;
}
const baseTitle = () => signals.project ? `${signals.project} \xB7 Prism` : "Prism review";
const signals = { project: null, count: null, icon: document.querySelector('link[rel="icon"]'), plainIcon: null, badged: null };
signals.plainIcon = signals.icon?.getAttribute("href") ?? null;
const ATTENTION_WATCH_MS = 15e3;
async function updateAttentionSignals(count) {
  const previous = signals.count;
  signals.count = count;
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
  if (navigator.setAppBadge) void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {
  });
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
    document.dispatchEvent(new CustomEvent("prism:action", { detail: data }));
    if (data?.artifact?.path && data.artifact.path === selectedPath) void showArtifact(selectedPath);
  } else if (name === "records") {
    refreshIndex?.();
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
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function markdownOptions(basePath, links = null) {
  return { basePath, isKnown: (path) => availableArtifacts.has(path), links: linkTargets(links) };
}
const isCodeRef = (path) => typeof path === "string" && /^code:[^:/]+:./.test(path);
const artifactQuery = (path) => isStoreRef(path) || isCodeRef(path) ? `ref=${encodeURIComponent(path)}` : `path=${encodeURIComponent(path)}`;
function reportRefresh(ok) {
  probes = recordProbe(probes, ok, Date.now());
  const next = connectionState({ ...probes, now: Date.now(), streamOpen: Boolean(relay?.open) });
  if (next === connection) return;
  const recovered = connection === "stopped" && next === "live";
  connection = next;
  connectionBanner.hidden = next !== "retrying";
  appGoneBanner.hidden = next !== "stopped";
  if (!recovered) return;
  relay?.reconnect();
  lastSnapshot = "";
  void projectPoller?.now();
}
function showPrivateServer(privateServer) {
  if (!privateServer) return;
  document.getElementById("private-server-reason").textContent = privateServer.reason ? `Reason: ${privateServer.reason}` : "";
  privateServerBanner.hidden = false;
}
function requireApp() {
  if (connection !== "stopped") return true;
  showToast(STOPPED_MESSAGE);
  return false;
}
const settingsDialog = document.getElementById("settings-dialog");
const PHONE = matchMedia("(max-width: 720px)");
const PRISM_RUNS_TARGET = "machine:prism-runs";
let prismRunsList = null;
let prismRunsShown = false;
function showPrismRuns(shown) {
  if (prismRunsList) return prismRunsShown;
  const root = document.getElementById("settings-prism-runs-actions");
  prismRunsList = createActionList({
    root,
    targets: [PRISM_RUNS_TARGET],
    api: actionApi,
    drafts: {},
    heading: () => ({ label: "Host and model", detail: "" }),
    emptyText: "This computer has no choice for Prism's own runs.",
    onRender: () => {
      if (prismRunsShown || root.querySelector(".action-loading")) return;
      prismRunsShown = true;
      queueMicrotask(shown);
    }
  });
  return prismRunsShown;
}
let codingAgents = null;
const CODING_AGENTS_DEADLINE_MS = 45e3;
function showCodingAgents(shown) {
  if (!codingAgents) {
    codingAgents = createCodingAgents({
      root: document.getElementById("settings-agents-list"),
      read: () => appFetch("./api/coding-agents", { cache: "no-store", deadlineMs: CODING_AGENTS_DEADLINE_MS }),
      api: actionApi,
      canWrite: () => Boolean(writeSession()),
      shown: () => queueMicrotask(shown)
    });
  }
  const ready = codingAgents.ready();
  void codingAgents.refresh();
  return ready;
}
function startSettings() {
  const sections = document.getElementById("settings-sections");
  let current = "appearance";
  const showSection = (name) => {
    const chosen = current !== name;
    current = name;
    const ready = name === "prism-runs" ? showPrismRuns(() => {
      if (current === "prism-runs") showSection("prism-runs");
    }) : name === "agents" ? chosen ? showCodingAgents(() => {
      if (current === "agents") showSection("agents");
    }) : codingAgents?.ready() ?? false : true;
    for (const section2 of settingsDialog.querySelectorAll(".settings-section")) section2.hidden = section2.dataset.section !== name || !ready;
    for (const item of sections.querySelectorAll("prism-tree-item")) item.toggleAttribute("selected", item.getAttribute("value") === name);
  };
  const panes = settingsDialog.querySelector(".settings");
  const back = document.getElementById("settings-back");
  sections.addEventListener("prism-select", (event) => {
    const value = event.detail?.value;
    if (!value) return;
    showSection(value);
    panes.dataset.pane = "section";
    if (PHONE.matches) back.focus();
  });
  back.addEventListener("click", () => {
    panes.dataset.pane = "list";
    sections.querySelector("prism-tree-item[selected]")?.focus();
  });
  document.getElementById("settings-button").addEventListener("click", () => openSettings());
  const root = document.documentElement;
  const theme = document.getElementById("settings-theme");
  const density = document.getElementById("settings-density");
  const sidebarChoice = document.getElementById("settings-sidebar");
  const showChoices = () => {
    theme.setAttribute("value", root.dataset.themeChoice || "system");
    density.setAttribute("value", root.dataset.density || "compact");
    sidebarChoice.setAttribute("value", shell.classList.contains("sidebar-collapsed") ? "hidden" : "shown");
    const width = preference("sidebar.width");
    document.getElementById("settings-sidebar-width").textContent = width ? `${width} pixels wide; drag the sidebar's edge to change it.` : "The default width; drag the sidebar's edge to change it.";
  };
  showChoices();
  new MutationObserver(showChoices).observe(root, { attributes: true, attributeFilter: ["data-theme-choice", "data-density"] });
  new MutationObserver(showChoices).observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
  theme.addEventListener("change", (event) => {
    const value = event.detail?.value;
    if (THEMES.includes(value)) savePreferences({ theme: value }).catch(() => showToast("The appearance applies here, but the review app could not store it."));
  });
  density.addEventListener("change", (event) => {
    const value = event.detail?.value;
    if (DENSITIES.includes(value)) savePreferences({ density: value }).catch(() => showToast("The appearance applies here, but the review app could not store it."));
  });
  sidebarChoice.addEventListener("change", (event) => setSidebarCollapsed(event.detail?.value === "hidden"));
  document.getElementById("settings-sidebar-reset").addEventListener("click", () => setSidebarWidth(null, { remember: true }));
  for (const choice of settingsDialog.querySelectorAll("prism-segmented[data-setting]")) {
    choice.addEventListener("change", (event) => savePersonalSetting(choice.dataset.setting, event.detail?.value));
  }
  document.getElementById("settings-store-open").addEventListener("click", () => {
    settingsDialog.close();
    document.getElementById("store-status").click();
  });
  document.getElementById("about-catalog").addEventListener("click", () => {
    settingsDialog.close();
    openCatalog();
  });
}
function openSettings() {
  const store = document.getElementById("store-status");
  document.getElementById("settings-store-name").textContent = store.hidden ? "No record store" : store.getAttribute("data-name") || "Record store";
  document.getElementById("settings-store-state").textContent = store.hidden ? "This workspace keeps no records yet." : (store.getAttribute("tip") ?? "").split("\n")[0];
  document.getElementById("settings-store-open").hidden = store.hidden;
  if (settingsDialog.querySelector('.settings-section[data-section="agents"]:not([hidden])')) void codingAgents?.refresh();
  settingsDialog.querySelector(".settings").dataset.pane = "list";
  settingsDialog.show();
  showPersonalAccess();
  loadPersonalSettings();
}
function showPersonalAccess() {
  const writable = Boolean(writeSession());
  for (const choice of settingsDialog.querySelectorAll("prism-segmented[data-setting]")) choice.toggleAttribute("disabled", !writable);
  const notice = document.getElementById("settings-personal-read-only");
  if (!writable && !notice.firstElementChild) notice.innerHTML = readOnlyNotice();
  notice.hidden = writable;
}
const PERSONAL_SETTINGS_ROUTE = "./api/personal-settings";
const PERSONAL_SOURCES = {
  chosen: { label: "Your choice", tone: "accent" },
  adopted: { label: "Adopted from a repository's configuration", tone: "info" },
  repository: { label: "From this repository's configuration", tone: "neutral" },
  default: { label: "Default", tone: "neutral" }
};
let personalSettings = null;
let personalReads = 0;
function showPersonalSettings(answer) {
  personalSettings = answer;
  for (const choice of settingsDialog.querySelectorAll("prism-segmented[data-setting]")) {
    const value = answer?.settings?.[choice.dataset.setting];
    if (typeof value === "string") choice.setAttribute("value", value);
  }
  for (const holder of settingsDialog.querySelectorAll(".settings-source[data-source]")) {
    const source = PERSONAL_SOURCES[answer?.sources?.[holder.dataset.source]];
    holder.hidden = !source;
    if (!source) continue;
    const badge2 = holder.querySelector("prism-badge");
    badge2.setAttribute("tone", source.tone);
    badge2.textContent = source.label;
  }
  document.getElementById("settings-personal-problem").hidden = !answer?.problem;
}
async function loadPersonalSettings() {
  const read = ++personalReads;
  try {
    const answer = await fetchJson(PERSONAL_SETTINGS_ROUTE);
    if (read === personalReads) showPersonalSettings(answer);
  } catch {
  }
}
async function savePersonalSetting(name, value) {
  if (!name || typeof value !== "string") return;
  const read = ++personalReads;
  let message = null;
  try {
    const response = await appFetch(PERSONAL_SETTINGS_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ [name]: value }) });
    const text = await response.text();
    let answer = null;
    try {
      answer = JSON.parse(text);
    } catch {
    }
    if (response.ok && answer) {
      if (read === personalReads) showPersonalSettings(answer);
      showToast("Saved on this machine. This change reaches no one else.", { tone: "success" });
      return;
    }
    message = answer?.message || text || `the review app answered ${response.status}.`;
  } catch (error) {
    message = error?.message || "the review app did not answer.";
  }
  showToast(`Prism could not save this change: ${message}`, { tone: "danger" });
  if (personalSettings) showPersonalSettings(personalSettings);
  await loadPersonalSettings();
}
function openCatalog() {
  window.open(new URL("./kit/catalog", location.href).href, "_blank", "noopener");
}
function showAboutVersion(version) {
  const shown = document.getElementById("about-version");
  if (shown) shown.textContent = typeof version === "string" && version ? version : "not known";
}
function showToast(message, { tone = "neutral" } = {}) {
  toast.show?.(message, { tone });
}
function setDiagramScale(section2, scale) {
  const svg = section2.querySelector("svg");
  if (!svg) {
    return;
  }
  const nextScale = Math.min(2.5, Math.max(0.35, scale));
  section2.dataset.scale = String(nextScale);
  svg.style.width = `${Number(section2.dataset.naturalWidth) * nextScale}px`;
  svg.style.height = `${Number(section2.dataset.naturalHeight) * nextScale}px`;
  section2.querySelector("[data-scale-label]").textContent = `${Math.round(nextScale * 100)}%`;
  section2.querySelector(".diagram-output")?.setAttribute("scale", String(nextScale));
}
function configureDiagram(section2, source) {
  const svg = section2.querySelector("svg");
  if (!svg) {
    return;
  }
  const width = Number.parseFloat(svg.getAttribute("width")) || svg.getBoundingClientRect().width;
  const height = Number.parseFloat(svg.getAttribute("height")) || svg.getBoundingClientRect().height;
  section2.dataset.naturalWidth = String(width);
  section2.dataset.naturalHeight = String(height);
  section2.dataset.scale = "1";
  section2.addEventListener("click", async (event) => {
    const control = event.target.closest("[data-action]");
    const action = control?.dataset.action;
    if (!action) {
      return;
    }
    const currentScale = Number(section2.dataset.scale);
    if (action === "zoom-in") {
      setDiagramScale(section2, currentScale + 0.15);
    } else if (action === "zoom-out") {
      setDiagramScale(section2, currentScale - 0.15);
    } else if (action === "reset") {
      setDiagramScale(section2, 1);
    } else if (action === "source") {
      const sourcePanel = section2.querySelector(".diagram-source");
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
let plantUmlQueue = Promise.resolve();
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
  plantUmlQueue = drawn.catch(() => {
  });
  return drawn;
}
const shownDiagrams = /* @__PURE__ */ new Set();
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
function showDiagram(sheet, svgText, restore = null) {
  for (const shown of shownDiagrams) if (shown.sheet === sheet) shownDiagrams.delete(shown);
  placeDiagram(sheet, svgText);
  shownDiagrams.add({ sheet, svg: svgText, restore });
}
async function renderDiagram(source, target, section2, { fit = false } = {}) {
  const drawn = await drawPlantUml(source);
  if (drawn.error) {
    target.innerHTML = `<p class="error">${escapeHtml(drawn.error)}</p>`;
    return;
  }
  showDiagram(target, drawn.svg, () => setDiagramScale(section2, Number(section2.dataset.scale) || 1));
  configureDiagram(section2, source);
  if (fit) {
    const room = target.clientWidth - 2 * Number.parseFloat(getComputedStyle(target).paddingLeft || "0");
    const natural = Number(section2.dataset.naturalWidth);
    if (room > 0 && natural > room) setDiagramScale(section2, room / natural);
  }
}
function diagramName(path, source = "") {
  const title = /^\s*title\s+(.+?)\s*$/im.exec(source)?.[1];
  if (title) return title;
  const words = fileName(path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Diagram";
}
function diagramCard(diagram, { compact = false } = {}) {
  const section2 = document.createElement("prism-panel");
  section2.className = `diagram-view${compact ? " is-compact" : ""}`;
  section2.setAttribute("variant", compact ? "plain" : "card");
  if (!compact) {
    section2.setAttribute("heading", diagramName(diagram.path, diagram.source));
    section2.setAttribute("eyebrow", "Diagram");
  }
  section2.innerHTML = `
    <div slot="tools" class="diagram-tools" role="group" aria-label="Diagram controls">
      <prism-button variant="ghost" size="sm" data-action="zoom-out" label="Zoom out" tip="Zoom out">\u2212</prism-button>
      <prism-button variant="ghost" size="sm" data-action="reset" data-scale-label tip="Reset zoom">100%</prism-button>
      <prism-button variant="ghost" size="sm" data-action="zoom-in" label="Zoom in" tip="Zoom in">+</prism-button>
      <prism-button variant="ghost" size="sm" data-action="source" aria-expanded="false">Show source</prism-button>
      <prism-button variant="ghost" size="sm" data-action="copy" tip="Copy PlantUML source">Copy</prism-button>
    </div>
    <prism-canvas class="diagram-output" pannable><prism-spinner label="Rendering diagram"></prism-spinner></prism-canvas>
    <div class="diagram-source" hidden><prism-code language="plantuml"><pre><code>${highlight(diagram.source, "plantuml")}</code></pre></prism-code></div>`;
  return section2;
}
function fileName(path) {
  return path.split("/").pop();
}
function openClause(ref, number) {
  requestClause(ref, number);
  if (ref !== selectedPath) {
    openRef(ref);
    return;
  }
  lastSnapshot = "";
  void showArtifact(ref);
}
function fileType(path) {
  return path.split(".").pop().toUpperCase();
}
function titleIndex() {
  return new Map((navigation.index ?? []).filter((entry) => entry.kind === "initiative" || entry.kind === "slice").map((entry) => [entry.ref, entry.label]));
}
function describe(path) {
  const record = (prismRecords.has(path) || prismRecords.has(localTab(path)) || path.startsWith(".prism/")) && recordKind(path);
  if (!record) return { label: fileName(path), kind: "File", owner: null, code: true };
  return { ...recordLabel(path, titleIndex()), code: false };
}
const runTitles = /* @__PURE__ */ new Map();
function pageLabel(path) {
  const parsed = parseEntityRef(path);
  if (!parsed) {
    const named = describe(path);
    return named.code ? path : named.label === named.kind ? named.kind : `${named.kind} \xB7 ${named.label}`;
  }
  if (parsed.kind === "knowledge") return KNOWLEDGE_PAGES[parsed.page];
  if (parsed.kind === "agents") return ENTITY_LABELS.agents;
  if (parsed.page) return attentionPageLabel(path, parsed.page);
  if (ENTITY_LABELS[parsed.kind]) return ENTITY_LABELS[parsed.kind];
  const indexed = navigation.index?.find((entry) => entry.ref === path)?.label;
  if (indexed) return indexed;
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  if (parsed.kind === "migration-run") return runTitles.get(path) ?? "Format migration";
  return parsed.kind === "slice" ? parsed.slug : parsed.id;
}
function attentionPageLabel(path, page) {
  if (currentContext?.ref === path) return currentContext.value.trail.at(-1)?.label ?? path;
  const kind = [...ATTENTION_KINDS, ["answered", "Answered in the last 7 days"], ["roadmap-questions", "Roadmap questions"]].find(([name]) => name === page);
  if (kind) return kind[1];
  const id = page.replace(/^work\//, "");
  return navigation.places?.attention?.work?.find((entry) => entry.id === id)?.title ?? navigation.initiatives?.find((item) => item.id === id)?.title ?? id;
}
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
  for (const [name, value] of Object.entries(attributes)) if (value !== null && value !== void 0 && value !== false) node.setAttribute(name, value === true ? "" : String(value));
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
function isWorkingSlice(node, ref) {
  if (node.status === "in-progress") return true;
  const claim = claimIndex?.claimFor(ref);
  return Boolean(claim && !claim.expired);
}
function isBelow(bySlug, node, ancestor) {
  for (let slug = node.parent; slug; slug = bySlug.get(slug)?.parent) if (slug === ancestor) return true;
  return false;
}
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
    stateWord = `Split \xB7 ${STATE_WORDS[state]}`;
    start.push(kitElement("prism-status", { value: state, label: stateWord, "glyph-only": true }));
  } else {
    stateWord = [phase ? phase[1] : null, status].filter(Boolean).join(" \xB7 ");
    start.push(kitElement("prism-phase", { phase: phase?.[0] ?? null, label: stateWord }));
  }
  if (node.status === "blocked") end.push(element("span", "prism-tree-flag", "Blocked"));
  if (node.blocking) end.push(badge(String(node.blocking), "danger", `${node.blocking} blocking ${node.blocking === 1 ? "finding" : "findings"}`));
  const claim = claimIndex?.claimFor(ref);
  if (claim) end.push(claimElement(claim, "avatar"));
  const counts = node.hasChildren ? leafCounts(nodes.filter((other) => isBelow(bySlug, other, node.slug))) : null;
  const tip = [node.title, stateWord, counts && counts.total ? `${counts.done} of ${counts.total} shipped` : null, node.blocking ? `${node.blocking} blocking ${node.blocking === 1 ? "finding" : "findings"}` : null, claimLine(claim)].filter(Boolean).join(" \xB7 ");
  return treeItem(ref, node.title, { selected: selectedPath === ref, start, end, tip });
}
const WORK_SHORT_LIST = 5;
function workInitiativeItem(item, nodes, scope, query) {
  const ref = `initiative:${item.id}`;
  const inScope = scope.kind === "initiative" && scope.id === item.id;
  const leaves = nodes.filter((node) => node.depth > 0 && !node.hasChildren);
  const counts = leafCounts(nodes);
  const state = item.state;
  const stateWord = STATE_WORDS[item.state] ?? item.state;
  const end = counts.total ? [meta(`${counts.done}/${counts.total}`)] : [];
  const tip = [item.title, stateWord, counts.total ? `${counts.done} of ${counts.total} shipped` : null].filter(Boolean).join(" \xB7 ");
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
    const hasWorking = nodes.some((node) => node.depth > 0 && isWorkingSlice(node, sliceRef(node)));
    expanded = children.length > 0 && (treeToggles.get(ref) ?? (inScope || hasWorking));
  }
  return treeItem(ref, item.title, { selected: selectedPath === ref, expanded, start: [kitElement("prism-status", { value: state, label: stateWord, "glyph-only": true })], end, children, tip });
}
function scopeOfRef(ref) {
  const names = ref.slice(STORE_REF.length).split("/");
  if (names[0] !== "repositories" || names.length < 3) return "workspace";
  return names[2] === "components" && names.length > 4 ? `${names[1]}/${names[3]}` : names[1];
}
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
    all.setAttribute("tip", "Show every scope again");
    all.addEventListener("click", () => setScopeFilter(null));
    holder.append(all);
  }
  return holder;
}
function scopeNavigation() {
  const notes = storeNotes.map((note) => element("p", "nav-note", note.message ?? String(note)));
  if (storeScopes.length < 2) return notes;
  const chosen = storeScopes.filter((scope) => scopeFilter?.has(scope.label)).length;
  return [section(scopeFilter ? `Scopes \xB7 ${chosen} of ${storeScopes.length}` : "Scopes"), scopeFilterChips(), ...notes];
}
function scopedCount(kind, total) {
  const byScope = navigation.library?.byScope?.[kind];
  if (!scopeFilter || !byScope) return total;
  return Object.entries(byScope).reduce((sum, [label, count]) => sum + (scopeShown(label) ? count : 0), 0);
}
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
  }
}
let pendingLane = null;
{
  const address = new URLSearchParams(location.search);
  const lane = address.get("lane");
  if (address.get("artifact") === "roadmap" && LANES.some(([name]) => name === lane)) pendingLane = { path: "roadmap", lane };
}
const addressedPlace = new URLSearchParams(location.search).get("place");
const addressedRecord = /^(store|code):/.test(new URLSearchParams(location.search).get("artifact") ?? "");
let currentPlace = placeNamed(addressedPlace) ? addressedPlace : addressedRecord ? "knowledge" : readStoredPlace() ?? DEFAULT_PLACE;
if (placeNamed(addressedPlace)) storePlace(addressedPlace);
function showPlaceHead() {
  const place = placeNamed(currentPlace);
  placeHead.setAttribute("heading", place.label);
  placeHead.setAttribute("subtitle", place.subtitle);
  sidebar.setAttribute("aria-label", place.label);
}
showPlaceHead();
function choosePlace(name, { fromRail = false, keep = false } = {}) {
  if (!placeNamed(name)) return;
  if (wideWindow.matches && shell.classList.contains("sidebar-collapsed")) setSidebarFlyout(true);
  if (name === currentPlace) return;
  currentPlace = name;
  storePlace(name);
  renderNavigation();
  if (fromRail && name === "roadmap") {
    const drawn = navDrawer.isOpen;
    const shown = openRef("roadmap", { keep, keepDrawer: true });
    if (drawn) closeDrawerAfter(shown, "roadmap");
  }
}
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
const PLACE_NAVIGATION = {
  attention: attentionNavigation,
  work: workNavigation,
  roadmap: roadmapNavigation,
  knowledge: knowledgeNavigation,
  history: historyNavigation
};
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
    const workRow = (entry) => row(`attention:work/${entry.id}`, entry.title, "tree", entry.count, `${entry.title} \xB7 ${entry.count} ${entry.count === 1 ? "item" : "items"}`);
    const rows = work.slice(0, shown).map(workRow);
    const rest = work.slice(shown);
    if (rest.length) {
      const total = rest.reduce((sum, entry) => sum + entry.count, 0);
      const tip = `${attentionMoreOpen ? "Hide" : "Show"} ${rest.length} more ${rest.length === 1 ? "initiative" : "initiatives"}`;
      if (attentionMoreOpen) rows.push(...rest.map(workRow), treeItem(ATTENTION_MORE, "Show fewer", { start: [navIcon("more")], tip, href: null }));
      else rows.push(treeItem(ATTENTION_MORE, `${rest.length} more`, { start: [navIcon("more")], end: count(total), tip, href: null }));
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
const NAVIGATION_ACTIONS = {
  [ATTENTION_MORE]: () => {
    attentionMoreOpen = !attentionMoreOpen;
    renderNavigation();
  }
};
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
const LANE_VALUE = "roadmap-lane:";
function showLane(lane, { keep = false } = {}) {
  if (!LANES.some(([name]) => name === lane)) return;
  void setPreference("roadmap.view", "board").catch(() => {
  });
  void setPreference("roadmap.groupBy", "band").catch(() => {
  });
  pendingLane = { path: "roadmap", lane };
  openRef("roadmap", { keep });
}
function revealLane() {
  const heading = laneHeading(artifact, pendingLane.lane);
  pendingLane = null;
  if (!heading) return;
  workspace.scrollTop += heading.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 16;
}
function roadmapNavigation() {
  const open = (navigation.initiatives ?? []).filter((item) => item.band && item.state !== "shipped" && item.state !== "superseded" && item.state !== "unlisted");
  const lanes = LANES.map(([lane, band]) => {
    const count = open.filter((item) => item.band === band).length;
    return treeItem(`${LANE_VALUE}${lane}`, band, { start: [navIcon("roadmap")], end: [meta(String(count))], tip: `${band} \xB7 ${count} open ${count === 1 ? "initiative" : "initiatives"}`, href: `./review?artifact=roadmap&lane=${lane}` });
  });
  const whole = treeItem("roadmap", "Whole roadmap", { selected: selectedPath === "roadmap" && !pendingLane, start: [navIcon("roadmap")], end: [meta(String(open.length))], tip: `Whole roadmap \xB7 ${open.length} open ${open.length === 1 ? "initiative" : "initiatives"}` });
  return [tree("Roadmap", [whole]), section("Lanes"), tree("Lanes", lanes)];
}
let knowledgeSearchField = null;
let knowledgeResults = null;
let knowledgeAsked = "";
let knowledgeTimer = null;
const KNOWLEDGE_SEARCH_MINIMUM = 2;
const KNOWLEDGE_SEARCH_DELAY_MS = 150;
const KNOWLEDGE_GROUPS = [["requirement", "Requirements", "list"], ["decision", "Decisions", "scale"], ["glossary-term", "Glossary", "book"], ["diagram", "Diagrams", "diagram"]];
function knowledgeQuery() {
  return (knowledgeSearchField?.value ?? "").trim();
}
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
function knowledgeMatches(query) {
  if (!knowledgeResults || knowledgeResults.query !== query) return null;
  if (knowledgeResults.failed) return [element("p", "nav-note", "The search could not be run.")];
  if (!knowledgeResults.groups.length) return [element("p", "nav-note", `No record matches "${query}".`)];
  const parts = [];
  for (const [kind, label, icon] of KNOWLEDGE_GROUPS) {
    const group = knowledgeResults.groups.find((entry) => entry.kind === kind);
    if (!group?.results.length) continue;
    const results = group.results.filter((result) => !isStoreRef(result.ref) || scopeShown(scopeOfRef(result.ref)));
    if (!results.length) continue;
    const rows = results.map((result) => {
      const mark = kind === "glossary-term" ? null : formatBadgeElement(formatOf(result.ref));
      return treeItem(result.ref, result.title, { selected: kind !== "glossary-term" && selectedPath === result.ref, start: [navIcon(icon)], end: mark ? [mark] : [], tip: result.title });
    });
    parts.push(section(label), tree(label, rows));
  }
  return parts;
}
function knowledgeNavigation() {
  const glossary = navigation.glossary ?? {};
  const library = navigation.library ?? {};
  const entries = navigation.places?.knowledge ?? {};
  const count = (value) => Number.isInteger(value) ? [meta(String(value))] : [];
  const shown = (kind) => Number.isInteger(library[kind]) ? scopedCount(kind, library[kind]) : library[kind];
  const total = ["requirements", "decisions", "terms", "diagrams"].reduce((sum, kind) => sum + (Number.isInteger(shown(kind)) ? shown(kind) : 0), 0);
  const field = knowledgeSearch(total);
  const query = knowledgeQuery();
  const matches = query.length >= KNOWLEDGE_SEARCH_MINIMUM ? knowledgeMatches(query) : null;
  if (matches) return [field, ...matches];
  const row = (ref, label, icon, end) => treeItem(ref, label, { selected: selectedPath === ref, start: [navIcon(icon)], end });
  return [
    field,
    ...scopeNavigation(),
    section("Start from"),
    tree("Start from", [
      row("knowledge:touched", "Touched by my work", "branch", count(lastSlice ? touchedCount : 0)),
      row("knowledge:changed", "Changed this week", "clock", count(entries.changed))
    ]),
    section("Browse by kind"),
    tree("Browse by kind", [
      row("requirements", ENTITY_LABELS.requirements, "list", count(shown("requirements"))),
      row("decisions", ENTITY_LABELS.decisions, "scale", count(shown("decisions"))),
      row("glossary", "Glossary", "book", glossary.exists ? count(shown("terms")) : [element("span", "nav-state", "missing")]),
      row("knowledge:diagrams", "Diagrams", "diagram", count(shown("diagrams"))),
      ...codeRepositories.length ? [row("code", ENTITY_LABELS.code, "code", [])] : []
    ])
  ];
}
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
    const tip = `${entry.title} \xB7 ${superseded ? "Superseded" : "Shipped"}${date ? ` ${date}` : ""}${by}`;
    const glyph = kitElement("prism-status", { value: superseded ? "superseded" : "shipped", "glyph-only": true, "aria-hidden": superseded ? "true" : null });
    return treeItem(ref, entry.title, { selected: selectedPath === ref, start: [glyph], end, tip });
  }))];
}
let navigationKey = "";
function renderNavigation() {
  const scope = currentContext?.ref === selectedPath ? currentContext.value.scope : { kind: "global" };
  const attention = navigation.attention ?? {};
  void updateAttentionSignals(attention.gates ?? 0);
  for (const rail of [shellRail, drawerRail]) renderRail(rail, attention.gates ?? 0);
  const entity = Boolean(parseEntityRef(selectedPath ?? ""));
  const claims = claimIndex ? [...claimIndex.live(), ...claimIndex.expired()].map((claim) => [claim.ref, claim.expiresAt, claim.label, claim.host, claim.model]) : [];
  const key = JSON.stringify([currentPlace, selectedPath, scope, attention, navigation.initiatives, navigation.places, navigation.glossary, navigation.library, navigation.diagnostics, claims, [...treeToggles], workFilterField?.value ?? "", knowledgeQuery(), knowledgeResults, attentionMoreOpen, currentPlace === "knowledge" ? [lastSlice, touchedCount] : null, storeSignature, scopeFilter && [...scopeFilter]]);
  if (key === navigationKey) return;
  navigationKey = key;
  const focused = document.activeElement?.closest?.("prism-tree-item");
  const refocus = focused && navRoot.contains(focused) ? focused.getAttribute("value") : null;
  const place = placeNamed(currentPlace);
  showPlaceHead();
  const field = document.activeElement?.closest?.("prism-field");
  const typing = field && navRoot.contains(field) ? { field, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  navRoot.replaceChildren(...PLACE_NAVIGATION[place.name]({ scope, entity }));
  if (typing && navRoot.contains(typing.field) && typing.field.control) {
    typing.field.control.focus();
    try {
      typing.field.control.setSelectionRange(typing.start, typing.end);
    } catch {
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
  if (parseEntityRef(path)?.kind === "migration-run") runTitles.set(path, value.trail?.at(-1)?.label ?? "Format migration");
  renderNavigation();
  pageBar.setTrail(trailOf(path), path);
  const history2 = artifact.querySelector("[data-shipped-history]");
  if (history2) {
    history2.innerHTML = documentHistoryHtml(path);
  }
  renderTabs();
}
function documentHistoryHtml(path) {
  return shippedHistoryHtml(currentContext?.ref === path ? currentContext.value.shippedHistory : null);
}
function controlsOf(root) {
  return [...root.querySelectorAll("button, a[href], input, textarea, select, summary, [tabindex]")];
}
function captureView(memory) {
  memory.open = [...artifact.querySelectorAll("prism-disclosure")].map((disclosure) => [disclosure.getAttribute("summary") ?? "", disclosure.open]);
  memory.focus = artifact.contains(document.activeElement) ? controlsOf(artifact).indexOf(document.activeElement) : -1;
  memory.focusKey = artifact.contains(document.activeElement) ? document.activeElement.closest("[data-focus-key]")?.dataset.focusKey ?? null : null;
  memory.focused = artifact.contains(document.activeElement) ? document.activeElement : null;
  memory.selection = memory.focused && "selectionStart" in memory.focused ? [memory.focused.selectionStart, memory.focused.selectionEnd] : null;
  artifact.style.minHeight = `${artifact.offsetHeight}px`;
}
function beginRebuild(path) {
  const same = renderedPath === path;
  const memory = { path, top: same ? workspace.scrollTop : scrollPositions.get(path) ?? 0, open: null, focus: -1, focusKey: null };
  if (same) captureView(memory);
  else artifact.style.minHeight = "";
  rebuilding = true;
  linkPreview?.hide();
  dropStages();
  memory.generation = stageGeneration;
  memory.stage = element("div", "artifact-view artifact-stage");
  memory.stage.setAttribute("aria-hidden", "true");
  memory.stage.inert = true;
  workspace.append(memory.stage);
  return memory;
}
const OVERLAYS = "prism-dialog:not([modeless]), prism-popover, prism-menu[for]";
const overlayShowing = (overlay) => overlay.isOpen ?? overlay.hasAttribute("open");
function pageOverlayOpen() {
  return [...artifact.querySelectorAll(OVERLAYS)].some(overlayShowing);
}
function resumeHeld() {
  if (pageOverlayOpen()) return;
  const memory = heldBuild;
  heldBuild = null;
  if (memory && memory.generation === stageGeneration && memory.path === selectedPath && memory.stage.isConnected) {
    refreshHeld = false;
    captureView(memory);
    swapIn(memory);
    return;
  }
  if (refreshHeld && selectedPath) {
    refreshHeld = false;
    void showArtifact(selectedPath);
  }
}
let stageGeneration = 0;
function dropStages() {
  stageGeneration += 1;
  heldBuild = null;
  for (const stage of workspace.querySelectorAll(":scope > .artifact-stage")) stage.remove();
}
function writeArtifact(html) {
  dropStages();
  rebuilding = false;
  artifact.innerHTML = html;
}
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
function scrollToAnchor(anchor, { smooth = false } = {}) {
  const target = anchorTarget(artifact, anchor);
  if (!target) return false;
  revealInDocument(target);
  const range = anchor.match(LINE_RANGE);
  artifact.querySelectorAll(".source-lines li.in-range").forEach((line) => line.classList.remove("in-range"));
  if (range?.[2]) {
    for (let line = target; line && Number(line.id.slice(HEADING_PREFIX.length + 1)) <= Number(range[2]); line = line.nextElementSibling) line.classList.add("in-range");
  }
  const scroller = target.closest(".is-maximized") ?? workspace;
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  scroller.scrollTo({ top, behavior: smooth && !reducedMotion?.matches ? "smooth" : "instant" });
  target.classList.remove("is-target");
  void target.offsetWidth;
  target.classList.add("is-target");
  return true;
}
const MAXIMIZABLE = ".graph-view, .diagram-view:not(.is-compact), .document-sheet";
function decorateMaximize(path) {
  const state = viewState(path);
  let found = false;
  [...artifact.querySelectorAll(MAXIMIZABLE)].forEach((card, index) => {
    const key = `${card.className.split(" ")[0]}:${index}`;
    let button = card.querySelector(":scope [data-maximize]");
    if (!button) {
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
const CHIPS = ".status-pill, .meta-pill, .relation-chip, .link-chip, .claim-chip, .readiness-jump, .type-badge, .code-span-chip, .component-chip";
function markClippedChips(root) {
  for (const chip of root.querySelectorAll(CHIPS)) {
    const clipped = [chip, ...chip.querySelectorAll("*")].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible");
    chip.toggleAttribute("shortened", clipped);
  }
}
function endRebuild(memory) {
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
  if (renderedPath === memory.path && pageOverlayOpen()) {
    heldBuild = memory;
    setBusy(false);
    return;
  }
  swapIn(memory);
}
function swapIn(memory) {
  if (renderedPath === memory.path) memory.top = workspace.scrollTop;
  artifact.replaceChildren(...memory.stage.childNodes);
  memory.stage.remove();
  const state = viewState(memory.path);
  state.folds ??= /* @__PURE__ */ new Map();
  decorateDocuments(artifact, state.folds);
  decorateMaximize(memory.path);
  requestAnimationFrame(() => markClippedChips(artifact));
  if (memory.open) {
    const sections = artifact.querySelectorAll("prism-disclosure");
    memory.open.forEach(([summary, open], index) => {
      if (sections[index] && (sections[index].getAttribute("summary") ?? "") === summary) sections[index].open = open;
    });
  }
  const keyed = (key) => [...artifact.querySelectorAll("[data-focus-key]")].find((control) => control.dataset.focusKey === key);
  const comment = memory.focusKey?.startsWith("comment:") === true;
  const more = memory.focusKey === "more-comments";
  if (memory.focused?.isConnected && artifact.contains(memory.focused) && !artifact.contains(document.activeElement)) {
    memory.focused.focus({ preventScroll: true });
    if (memory.selection && "setSelectionRange" in memory.focused) try {
      memory.focused.setSelectionRange(...memory.selection);
    } catch {
    }
  }
  if (memory.focusKey && !artifact.contains(document.activeElement)) {
    const found = keyed(memory.focusKey) ?? (comment ? keyed("more-comments") : null);
    if (found?.dataset.commentId !== void 0) found.tabIndex = -1;
    if (found) {
      const control = found.control ?? found;
      control.focus({ preventScroll: true });
      if (memory.selection && "setSelectionRange" in control) try {
        control.setSelectionRange(...memory.selection);
      } catch {
      }
    } else if (more) {
      const list = artifact.querySelector("[data-comment-list]");
      const listed = [...list?.querySelectorAll("[data-comment-id]") ?? []];
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
async function showError(response) {
  pageBar.setActions([]);
  const message = await response.text();
  writeArtifact(`<div class="document-sheet"><p class="error">${escapeHtml(message)}</p></div>`);
  setBusy(false);
}
function documentSheet(data, state) {
  const options = markdownOptions(data.path, data.links);
  const changes = artifactChangesView(data, state, (content) => renderText(data.path, content, options));
  return `${changes.row}<section class="document-sheet">${changes.body ?? `<prism-doc class="document-content">${renderText(data.path, data.content, options)}</prism-doc>`}</section>`;
}
function bindChanges(root, state, path) {
  const redraw = () => {
    lastSnapshot = "";
    void showArtifact(path);
  };
  root.querySelector("[data-changes-toggle]")?.addEventListener("click", () => {
    state.changesShown = !state.changesShown;
    redraw();
  });
  root.querySelector("[data-changes-as]")?.addEventListener("change", (event) => {
    state.changesAs = event.detail?.value === "source" ? "source" : "rendered";
    redraw();
  });
}
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
  entity.scopeFilter = scopeFilter ? [...scopeFilter] : null;
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
  await renderEntity(container, entity, {
    ...viewContext(path, state),
    renderMarkdown: (source, basePath = null) => renderText("document.md", source, markdownOptions(basePath)),
    // The Code page turns a repository's code content on or off with the tab's write session, and then reads the page again.
    canWrite: () => Boolean(writeSession()),
    setCode: (repository, enabled) => setCodeContent(repository, enabled),
    refresh: () => {
      lastSnapshot = "";
      if (path === selectedPath) void showArtifact(path);
    }
  });
  endRebuild(memory);
}
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
let touchedKept = { slice: null, answer: null };
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
async function countTouched(slice) {
  const { answer } = await touchedAnswer(slice);
  noteTouched(slice, answer);
}
function noteTouched(slice, answer) {
  if (slice !== lastSlice) return;
  const count = answer ? answer.groups.reduce((sum, group) => sum + group.records.length, 0) : null;
  if (count === touchedCount) return;
  touchedCount = count;
  if (currentPlace === "knowledge") renderNavigation();
}
async function showArtifact(path) {
  rememberSlice(path);
  await refreshContext(path);
  if (path !== selectedPath) {
    return;
  }
  if (renderedPath === path && pageOverlayOpen()) {
    refreshHeld = true;
    return;
  }
  refreshHeld = false;
  if (parseEntityRef(path)) {
    await showEntity(path);
    return;
  }
  const response = await appFetch(`./api/artifact?${artifactQuery(path)}`, { cache: "no-store" });
  if (response.status === 404) {
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
  const readPage = (commentOffset) => fetchJson(`./api/artifact?${artifactQuery(data.path)}&commentOffset=${commentOffset}`);
  if (data.artifact && (state.commentReads ?? 1) > 1) {
    const listed = await readListedComments(data.artifact, state, readPage).catch(() => null);
    if (path !== selectedPath) return;
    if (listed) data.artifact = listed;
    else if (renderedPath === path) {
      setBusy(false);
      return;
    }
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
  const documentCard = source ? `<section class="document-sheet source-sheet" data-code-subject><ol class="source-lines">${highlightLines(data.content.replace(/\r\n/g, "\n").replace(/\n$/, ""), languageOf(data.path)).map((line, index) => `<li id="${HEADING_PREFIX}L${index + 1}"><code>${line || " "}</code></li>`).join("")}</ol></section>` : structured || data.path.toLowerCase().endsWith(".puml") ? "" : documentSheet(data, state);
  const memory = beginRebuild(path);
  const named = describe(data.path);
  const view = data.view ?? null;
  const heading = view ? view.question : named.code ? fileName(data.path) : named.label === named.kind ? named.kind : named.label;
  const kind = structured ? KIND_LABELS[data.kind] ?? "JSON" : named.code ? fileType(data.path) : named.kind;
  memory.stage.innerHTML = `
    <header class="artifact-header">
      <div>
        ${view ? `<p class="eyebrow">${escapeHtml(viewKind(view))}</p>` : named.code ? "" : `<p class="eyebrow">${escapeHtml(named.kind)}</p>`}
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
    ${formatBanner(data.format)}
    ${migratedNote(data.artifact)}
    ${view ? viewNoteHtml(view, "view-note view-header-note") : ""}
    ${artifactReviewHtml(data, state)}
    <div class="document-history" data-shipped-history>${documentHistoryHtml(path)}</div>
    ${documentCard}`;
  if (view) bindViewLinks(memory.stage, openClause);
  mountArtifactReview(memory.stage, data, { actionApi, state, readPage, onListed: (listed) => {
    if (listed.path === selectedPath) lastSnapshot = JSON.stringify(listed);
  } });
  bindChanges(memory.stage, state, path);
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
    const section2 = diagramCard(diagram);
    memory.stage.appendChild(section2);
    await renderDiagram(diagram.source, section2.querySelector(".diagram-output"), section2);
  }
  endRebuild(memory);
}
async function setCodeContent(repository, enabled) {
  if (!requireApp()) return null;
  const response = await fetch(`./api/code/${encodeURIComponent(repository)}`, { method: "PUT", headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify({ enabled }) });
  const answer = await response.json().catch(() => ({ message: "The review app returned an unreadable answer." }));
  if (!response.ok) return { message: answer.message ?? "The review app could not change the code content." };
  return answer.code?.state === "unreachable" ? { message: answer.code.message } : null;
}
function codeCloneRead(data) {
  if (!isCodeRef(data?.ref) || data.kind !== void 0 || typeof data.content !== "string") return data;
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
    // The view draws again over itself showing, rather than in place of another page or none, so it shows what it has at once and fills in the rest in place.
    redrawing: renderedPath === path,
    // The lane a lane link asks the Roadmap page to show.
    lane: pendingLane?.path === path ? pendingLane.lane : null,
    // Touched by my work reads the slice in the selected tab, or else the one selected last, and passes its answer back for the sidebar's count.
    touchedSlice: () => lastSlice,
    formatOf,
    fetchTouched: async (slice) => (await touchedAnswer(slice)).answer,
    onTouched: (slice, answer) => noteTouched(slice, answer),
    escapeHtml,
    showToast,
    fetchArtifact: (artifactPath) => fetchJson(`./api/artifact?${artifactQuery(localTab(artifactPath))}`),
    // A view's own read route, such as a slice's frozen test or run log, answers JSON, and a refusal throws its text.
    fetchJson: (url) => fetchJson(url),
    fetchEvidence: (id) => fetchJson(`./api/evidence?id=${encodeURIComponent(id)}`),
    hasArtifact: (artifactPath) => availableArtifacts.has(localTab(artifactPath)) || Boolean(parseEntityRef(artifactPath)),
    // A store artifact's scope label, which the record views show beside it, or null for any other file.
    scopeLabel: (artifactPath) => refScopes.get(localTab(artifactPath)) ?? null,
    // The scope filter of Knowledge: whether a scope label is shown, the chosen labels or null for every scope, the store's scopes by label, and a way back to every scope.
    scopeShown,
    scopeFilter: () => scopeFilter ? [...scopeFilter] : null,
    storeScopes: () => storeScopes.map((scope) => scope.label),
    showAllScopes: () => setScopeFilter(null),
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
    // The tab's write session header, which a view's own write routes, such as the Agents page's archive, send.
    writeHeaders,
    // Names one of Prism's records by title and kind, or a repository file by its path, as the page bar and the palette do.
    describe,
    recordTitle: (recordPath) => (navigation.index ?? []).find((entry) => entry.ref === recordPath)?.label ?? null,
    // A view's own actions sit at the end of the page bar while it shows.
    setPageActions: (nodes) => {
      if (path === selectedPath) pageBar.setActions(nodes);
    },
    sidePanel: {
      show: (ref, anchor = null, options = {}) => sidePanel.showFile(ref, anchor, options),
      showContent: (content) => sidePanel.showContent(content),
      current: () => sidePanel.current(),
      close: () => sidePanel.close(),
      isOpen: () => sidePanel.isOpen()
    },
    // A design view's card on a slice's Views tab draws its source as a diagram card does.
    async drawView(section2, source) {
      await renderDiagram(source, section2.querySelector(".diagram-output"), section2);
      if (path === selectedPath) decorateMaximize(path);
    },
    // A view embeds a PlantUML file as the same diagram card that opening the file shows.
    async mountDiagram(target, diagramPath) {
      const data = await fetchJson(`./api/artifact?${artifactQuery(localTab(diagramPath))}`);
      for (const diagram of data.diagrams ?? []) {
        const section2 = diagramCard(diagram);
        target.appendChild(section2);
        await renderDiagram(diagram.source, section2.querySelector(".diagram-output"), section2);
      }
      if (path === selectedPath) decorateMaximize(path);
    },
    rerender() {
      lastSnapshot = "";
      void showArtifact(path);
    }
  };
}
function formatOf(ref) {
  if (!ref) return null;
  const glossary = navigation.glossary ?? {};
  if (glossary.path === ref) return glossary.format ?? null;
  return (navigation.index ?? []).find((entry) => entry.ref === ref && (entry.kind === "requirement" || entry.kind === "decision"))?.format ?? null;
}
const unavailableLinks = (data) => Array.isArray(data.links) ? data.links.filter((item) => item.resolved === null).length : 0;
function paletteEntries() {
  const places = [
    { ref: "attention", label: "Attention", kind: "place", detail: "What needs you" },
    { ref: "roadmap", label: "Roadmap", kind: "place", detail: "Initiatives by band" },
    { ref: "requirements", label: "Requirements", kind: "place", detail: "Library" },
    { ref: "decisions", label: "Decisions", kind: "place", detail: "Library" },
    { ref: "glossary", label: "Glossary", kind: "place", detail: "Library" },
    { ref: "knowledge:diagrams", label: "Diagrams", kind: "place", detail: "Library" },
    { ref: "agents", label: "Agents", kind: "place", detail: "Every agent of this workspace and every session launched here" }
  ];
  const indexed = (navigation.index ?? []).flatMap((entry) => {
    const ref = localTab(entry.ref);
    if (!isStoreRef(ref)) return [entry];
    return scopeShown(refScopes.get(ref)) ? [{ ...entry, ref, scope: refScopes.get(ref) ?? "workspace" }] : [];
  });
  const known = new Set(indexed.map((entry) => entry.ref));
  const titles = titleIndex();
  const files = [...availableArtifacts].filter((file) => !known.has(file) && (!isStoreRef(file) || scopeShown(refScopes.get(file)))).map((file) => {
    if (describe(file).code) return { ref: file, label: fileName(file), kind: "file", detail: file };
    if (isStoreRef(file)) {
      const named2 = recordLabel(file, titles);
      return { ref: file, label: named2.owner ? named2.kind : named2.label, kind: "record", kindLabel: named2.kind, scope: refScopes.get(file) ?? "workspace", detail: `${refScopes.get(file) ?? "workspace"} \xB7 ${belowScope(file)}` };
    }
    const named = recordLabel(file, titles);
    if (named.owner) return { ref: file, label: named.kind, kind: "record", kindLabel: "Record", detail: named.owner, preview: { kind: named.kind, title: named.owner } };
    return { ref: file, label: named.label, kind: "record", kindLabel: named.kind };
  });
  return [...shownActionEntries(), ...places, ...indexed, ...files];
}
let recordStoreStatus = null;
function renderStoreSync(data) {
  recordStoreStatus?.update(data.recordStore, data.storeSync, data.sync);
}
startSettings();
watchDiagramTheme();
function focusPlaces(rail) {
  const selected = navRoot.querySelector("prism-tree-item[selected]");
  if (selected) return selected.focus();
  rail.querySelector(`prism-rail-item[data-place="${currentPlace}"]`)?.focus();
}
const LEGACY_SIDEBAR_KEY = "prism.review.sidebar";
const wideWindow = matchMedia("(min-width: 1101px)");
function readSidebarCollapsed() {
  try {
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_KEY);
    localStorage.removeItem(LEGACY_SIDEBAR_KEY);
    if (legacy === "collapsed") void setPreference("sidebar.collapsed", true).catch(() => {
    });
  } catch {
  }
  return preference("sidebar.collapsed");
}
function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  shell.classList.toggle("sidebar-collapsed", collapsed);
  setSidebarFlyout(false);
  if (remember) void setPreference("sidebar.collapsed", collapsed).catch(() => showToast("The sidebar changed here, but the review app could not store the choice."));
}
function setSidebarFlyout(open) {
  const flyout = open && shell.classList.contains("sidebar-collapsed") && wideWindow.matches;
  shell.classList.toggle("sidebar-flyout", flyout);
  const collapsed = shell.classList.contains("sidebar-collapsed");
  const action = collapsed ? "Keep the sidebar open" : "Hide the sidebar";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed || flyout));
  sidebarToggle.setAttribute("label", action);
  sidebarToggle.setAttribute("tip", `${action} ([)`);
  sidebarToggle.hidden = !wideWindow.matches;
  const resizer = document.getElementById("sidebar-resizer");
  if (resizer) resizer.hidden = collapsed;
}
const sidebarFlyoutOpen = () => shell.classList.contains("sidebar-flyout");
wideWindow.addEventListener("change", () => setSidebarFlyout(false));
document.addEventListener("pointerdown", (event) => {
  if (!sidebarFlyoutOpen()) return;
  const path = event.composedPath();
  if (path.includes(sidebar) || path.includes(railDock) || path.some((node) => node?.tagName === "PRISM-TOOLTIP")) return;
  setSidebarFlyout(false);
}, true);
const sidebarResizer = document.getElementById("sidebar-resizer");
function setSidebarWidth(width, { remember = false } = {}) {
  if (Number.isFinite(width)) shell.style.setProperty("--sidebar-width", `${width}px`);
  else shell.style.removeProperty("--sidebar-width");
  const shown = sidebar.getBoundingClientRect().width;
  const column = shown ? shown + parseFloat(getComputedStyle(sidebar).marginInlineEnd || "0") : width;
  sidebarResizer.setAttribute("value", String(Math.round(column || 0) || ""));
  if (remember) void setPreference("sidebar.width", Number.isFinite(width) ? width : null).catch(() => showToast("The sidebar's width changed here, but the review app could not store it."));
}
sidebarResizer.addEventListener("prism-resize", (event) => setSidebarWidth(event.detail.width, { remember: event.detail.done }));
sidebarResizer.addEventListener("prism-resize-reset", () => setSidebarWidth(null, { remember: true }));
setSidebarCollapsed(readSidebarCollapsed(), { remember: false });
setSidebarWidth(preference("sidebar.width"));
sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed")));
const DRAWER_LINGER_MS = 700;
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
function watchDrawerWidth() {
  const wide = matchMedia("(min-width: 1101px)");
  let navigationFocused = false;
  document.addEventListener("focusin", (event) => {
    navigationFocused = sidebar.contains(event.target) || shellRail.contains(event.target);
  });
  wide.addEventListener("change", () => {
    if (!wide.matches) {
      if (navDrawer.isOpen || !navigationFocused) return;
      requestAnimationFrame(() => {
        const active2 = document.activeElement;
        if (!active2 || active2 === document.body || sidebar.contains(active2) || shellRail.contains(active2)) document.getElementById("nav-button").focus();
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
  showAboutVersion(data.version ?? appVersion);
  const requestedPath = localTab(selectedPath);
  selectedPath = Object.hasOwn(data, "activeTab") ? data.activeTab : null;
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
  artifact.addEventListener("scroll", (event) => {
    if (event.target.classList?.contains("is-maximized")) followSections();
  }, { passive: true, capture: true });
  window.addEventListener("resize", followSections, { passive: true });
  projectPoller = createPoller({ run: refreshProjects, interval: 5e3 });
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
  availableArtifacts = /* @__PURE__ */ new Set([...data.artifacts, ...data.sources ?? []]);
  missingTabs = new Set(data.missingTabs ?? []);
  navigation = data.navigation;
  claimIndex = createClaimIndex({
    fetchJson,
    onChange: () => {
      navigationKey = "";
      renderNavigation();
      renderTabs();
      void agentsMenu?.refresh();
    }
  });
  await claimIndex.refresh().catch(() => {
  });
  agentsMenu = createAgentsMenu({
    button: document.getElementById("agents-button"),
    popover: document.getElementById("agents"),
    onOpen: (ref) => openRef(ref),
    // Answer selects the question the launch waits on, with its answer form, once Attention shows.
    onAnswer: async (gate) => {
      const { openQuestion } = await import("./views/attention.js");
      openQuestion({ openArtifact: (ref) => openRef(ref) }, gate);
    },
    // Open shows the Agents page with that session's details unfolded, and shows every group if the page's Show choice left the session out.
    onOpenAgent: (id) => {
      const state = viewState("agents");
      state.openAgents = [.../* @__PURE__ */ new Set([...state.openAgents ?? [], id])];
      if (state.show && !["all", "needs-you", "this-computer"].includes(state.show)) state.show = "all";
      openRef("agents");
    }
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
  const previewArtifact = (ref) => fetchJson(`./api/artifact?${artifactQuery(localTab(ref))}`);
  sidePanel = createSidePanel({
    shell: appShell,
    // A view's clause or contract opens on the contract's page, so the panel closes rather than show the view beside it.
    onOpenClause: (ref, number) => {
      sidePanel.close();
      openClause(ref, number);
    },
    sheet: document.getElementById("side-panel-sheet"),
    describe,
    // A page's Side panel button follows the panel, however it opens or closes.
    onChange: (open) => document.dispatchEvent(new CustomEvent("prism:side-panel", { detail: { open } })),
    fetchJson,
    fetchArtifact: previewArtifact,
    renderMarkdown: (path, content, links) => renderText(path, content, markdownOptions(path, links)),
    // The panel draws a diagram as the same card its page shows, without the name its header already gives, and fitted to the panel's width.
    mountDiagram: async (target, diagram) => {
      const section2 = diagramCard(diagram, { compact: true });
      target.appendChild(section2);
      await renderDiagram(diagram.source, section2.querySelector(".diagram-output"), section2, { fit: true });
    },
    onOpenTab: (ref, anchor) => {
      pendingAnchor = anchor ? { path: ref, anchor } : null;
      sidePanel.close();
      if (ref === selectedPath && anchor) scrollToAnchor(anchor);
      else openRef(ref, { keep: true });
    }
  });
  const showInPanel = (ref, anchor) => sidePanel.showFile(ref, anchor);
  linkPreview = createLinkPreview({
    root: workspace,
    fetchJson,
    fetchArtifact: previewArtifact,
    renderMarkdown: (path, content, links) => renderText(path, content, markdownOptions(path, links)),
    kindLabel: (kind) => KIND_LABELS[kind] ?? "Structured record",
    drawDiagram: drawPlantUml,
    describe,
    currentPath: () => selectedPath,
    onShowInPanel: showInPanel
  });
  panelPreview = createLinkPreview({
    root: sidePanel.body,
    fetchJson,
    fetchArtifact: previewArtifact,
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
  let navKeep = false;
  navRoot.addEventListener("click", (event) => {
    navKeep = event.ctrlKey || event.metaKey;
  }, { capture: true });
  navRoot.addEventListener("prism-select", (event) => {
    const ref = event.detail?.value;
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
    if (keys.includes("sidebar.width")) setSidebarWidth(preferences["sidebar.width"]);
  });
  navDrawer.addEventListener("prism-close", closeDrawer);
  watchDrawerWidth();
  document.getElementById("jump").addEventListener("click", () => palette.show());
  attentionButton.addEventListener("prism-select", () => openRef("attention"));
  watchSearchWidth();
  artifact.addEventListener("click", (event) => {
    const docLink = event.target.closest("a[data-doc-link], a[data-doc-anchor]");
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
        const contents = docLink.closest("prism-contents");
        const scroller = docLink.closest(".is-maximized") ?? workspace;
        const mark = () => contents.markCurrent?.(docLink);
        requestAnimationFrame(mark);
        if ("onscrollend" in scroller) {
          const waiting = new AbortController();
          scroller.addEventListener("scrollend", () => requestAnimationFrame(mark), { once: true, signal: waiting.signal });
          setTimeout(() => waiting.abort(), 2e3);
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
  const overlayOpen = () => [...document.querySelectorAll("prism-dialog:not([modeless]), prism-popover, prism-menu")].some(overlayShowing);
  artifact.addEventListener("prism-close", () => setTimeout(resumeHeld));
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || Boolean(document.activeElement?.closest?.("prism-field"));
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (palette.isOpen()) palette.hide();
      else palette.show();
    } else if (event.key === "," && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (settingsDialog.isOpen) settingsDialog.close();
      else openSettings();
    } else if (event.key === "[" && !typing && !overlayOpen() && wideWindow.matches && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed"));
    } else if (event.key === "/" && !typing && !palette.isOpen()) {
      event.preventDefault();
      palette.show();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !typing) {
      event.preventDefault();
      if (event.key === "ArrowLeft") goBack();
      else goForward();
    } else if (event.key === "Escape" && overlayOpen()) {
    } else if (event.key === "Escape" && sidebarFlyoutOpen()) {
      setSidebarFlyout(false);
      shellRail.querySelector('prism-rail-item[pressed="true"] button')?.focus();
    } else if (event.key === "Escape" && document.getElementById("evidence-drawer").isOpen) {
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
  void createPoller({ interval: ACTION_CHECK_MS, run: () => {
    if (connection !== "stopped") document.dispatchEvent(new CustomEvent("prism:poll"));
  } }).start();
  const indexPoller = createPoller({ interval: () => sessionConnected ? INDEX_CHECK_MS : INDEX_UNJOINED_MS, run: async () => {
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
        availableArtifacts = /* @__PURE__ */ new Set([...snapshot.artifacts, ...snapshot.sources ?? []]);
        updateMissingTabs(snapshot.missingTabs);
        if (JSON.stringify(snapshot.navigation) !== JSON.stringify(navigation)) {
          const initiatives = (list) => JSON.stringify((list ?? []).map((item) => item.id));
          const added = initiatives(snapshot.navigation?.initiatives) !== initiatives(navigation.initiatives);
          navigation = snapshot.navigation;
          renderNavigation();
          renderTabs();
          if (added) void claimIndex.refresh().catch(() => {
          });
        } else if (storeSignature !== storeBefore) renderNavigation();
        if (!sessionConnected) {
          synchronizeSession(snapshot);
        }
        const panel = sidePanel.isOpen() ? sidePanel.refresh().catch(() => {
        }) : null;
        if (selectedPath) {
          await showArtifact(selectedPath);
        }
        await panel;
        if (currentPlace === "knowledge" && lastSlice && selectedPath !== "knowledge:touched") await countTouched(lastSlice);
      }
    } catch {
    }
  } });
  setTimeout(() => void indexPoller.start(), INDEX_UNJOINED_MS);
  refreshIndex = () => indexPoller.now();
  void createPoller({ interval: ATTENTION_WATCH_MS, whileHidden: true, run: async () => {
    const response = await appFetch("./api/attention", { cache: "no-store", deadlineMs: POLL_DEADLINE_MS }).catch(() => null);
    const answer = response?.ok ? await response.json().catch(() => null) : null;
    if (Number.isInteger(answer?.gates)) await updateAttentionSignals(answer.gates);
  } }).start();
}
initialize().catch((error) => {
  writeArtifact(`<div class="document-sheet"><p class="error">${escapeHtml(error.message)}</p></div>`);
  setBusy(false);
});
