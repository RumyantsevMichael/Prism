// Generated from src/server/review/review-app-server.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ConservationStore, conservationStore } from "../conservation/conservation-store.mjs";
import { withFileLock } from "../workflow/artifact-store.mjs";
import { useManagedStores } from "../workflow/record-store-remote.mjs";
import { markManagedStore } from "../workflow/record-store-sync.mjs";
import { remoteLabel } from "../workflow/remote-url.mjs";
import { describeRecordStore, forgetStoreWithoutCheckout, isStoreWithoutCheckout, outsideToolCall, recordStoreOf, useStoreWithoutCheckout, withFetchlessReads } from "../workflow/record-store.mjs";
import { readWorkspaceName } from "../workflow/roadmap.mjs";
import {
  APP_LOCK_STALE_MS,
  REVIEW_APP_PROTOCOL,
  lockBase,
  newCredential,
  prepareDirectory,
  projectId,
  proveResponse,
  readDiscovery,
  readLastPort,
  readProjectDirectories,
  readProjectRoots,
  removeDiscovery,
  verifyRequest,
  writeDiscovery,
  writeLastPort,
  writeProjectRoots
} from "./review-app-discovery.mjs";
import { nativeSemanticRuntime } from "../repository-intelligence/native-semantic-runtime.mjs";
import { errorFields, log } from "../log.mjs";
import { readIndexingStatus } from "../repository-intelligence/index-status.mjs";
import { createProjectReview, exchangeWriteGrant, fromPage, isTrustedHost, normalizeTabs, READ_ONLY_NOTICE, readBody, readJson, send, sendJson, serveOutsideSession, servePageRoute, storeTabRef, wantsPage } from "./review-server.mjs";
import { loadAttention, recheckViews } from "./workspace-model.mjs";
import { readWorkspaceIdentity, workspaceLabel } from "./workspace-identity.mjs";
import { createAddedWorkspaces, storeAddresses } from "./added-workspaces.mjs";
import { checkoutWorkspace, listWorkspaces, nameOfWorkspace, storeFolder, storeWorkspaceId } from "./workspaces.mjs";
import { listMachineCheckouts } from "../workflow/machine-checkouts.mjs";
import { createWriteSessions } from "./write-sessions.mjs";
import { watchWorkspace, WORKSPACE_FETCH_MAX_MS, WORKSPACE_FETCH_MS } from "./workspace-sync.mjs";
import { codeFolder, createCodeClones, registeredRemotes } from "./code-clones.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { createViewerHub, isEventStream } from "./viewer-hub.mjs";
import { createCachedValue } from "./cached-value.mjs";
import { sweepUnusedVersions } from "../session/agent-installs.mjs";
const LEASE_MS = 3 * 60 * 1e3;
const IDLE_MS = 30 * 60 * 1e3;
const SWEEP_MS = 30 * 1e3;
const NONCE_MS = 2 * 60 * 1e3;
const LOCK_RENEW_MS = 5 * 1e3;
const LOCK_STALE_MS = APP_LOCK_STALE_MS;
const LOCK_TIMEOUT_MS = 1e3;
const OPEN_LEASE_MS = 10 * 1e3;
const STORAGE_DIRECTORY_LIMIT = 4;
const STORAGE_FIELDS = [["evidenceDirectory", "evidenceDirectories"], ["intelligenceDirectory", "intelligenceDirectories"], ["recordStoreDirectory", "recordStoreDirectories"]];
const NOTICE_MS = 60 * 1e3;
const RECENT_LIMIT = 20;
const STORE_ROOTS = "store-roots";
const PROJECT_SUMMARY_MS = { gates: 10 * 1e3, indexing: 10 * 1e3, store: 60 * 1e3 };
function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}
function parseBody(text) {
  if (!text) return {};
  try {
    return parseStoreJson(text);
  } catch {
    throw statusError(400, "The request body must be JSON.");
  }
}
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
function holdLock(directory, stopped, onRenew) {
  let released;
  const held = new Promise((resolve, reject) => {
    released = withFileLock(lockBase(directory), () => {
      resolve();
      return stopped;
    }, void 0, { renew: true, abandonWhenUnrenewed: true, heartbeatMs: LOCK_RENEW_MS, staleMs: LOCK_STALE_MS, timeoutMs: LOCK_TIMEOUT_MS, onRenew });
    released.catch(reject);
  });
  return { held, released: () => released.catch(() => {
  }) };
}
function startReviewApp(options) {
  return withFetchlessReads(() => serveReviewApp(options));
}
async function serveReviewApp({ directory, pluginVersion = null, idleMs = IDLE_MS, noticeMs = NOTICE_MS, workspaceFetchMs = WORKSPACE_FETCH_MS, workspaceFetchMaxMs = WORKSPACE_FETCH_MAX_MS } = {}) {
  await prepareDirectory(directory);
  let releaseLock;
  const stopped = new Promise((resolve) => {
    releaseLock = resolve;
  });
  let close = () => Promise.resolve();
  let ownsLock = true;
  const lock = holdLock(directory, stopped, (held) => {
    if (!held) {
      ownsLock = false;
      void close({ handoff: false });
    } else {
      void republish();
    }
  });
  await lock.held;
  const previous = await readDiscovery(directory);
  const controlToken = newCredential();
  const instance = randomBytes(8).toString("hex");
  const projects = /* @__PURE__ */ new Map();
  const workspaces = /* @__PURE__ */ new Map();
  const nonces = /* @__PURE__ */ new Map();
  const pendingNotices = /* @__PURE__ */ new Map();
  const stores = /* @__PURE__ */ new Map();
  const added = await createAddedWorkspaces({ directory });
  const code = await createCodeClones({ directory });
  const addedUsage = /* @__PURE__ */ new Map();
  let openGrantedAt = -Infinity;
  let sequence = 0;
  let persisted = null;
  let viewerToken = newCredential();
  let port = null;
  let published = null;
  let idleSince = Date.now();
  let closing = null;
  let writeSessions = null;
  const hub = createViewerHub({ onChange: () => {
    for (const view of workspaces.values()) view.review.reportViewers();
  } });
  const viewerPrefix = () => `/session/${viewerToken}`;
  function viewerCount() {
    let count = 0;
    for (const view of workspaces.values()) count += view.review.viewerCount();
    return count;
  }
  function writableViewerCount() {
    let count = 0;
    for (const view of workspaces.values()) count += view.review.writableViewerCount();
    return count;
  }
  const membersOf = (view) => [...projects.values()].filter((project) => project.workspaceId === view.id);
  const workspaceViewers = (project) => workspaces.get(project.workspaceId)?.review.viewerCount() ?? 0;
  const workspaceUrl = (id) => `http://127.0.0.1:${port}${viewerPrefix()}/w/${id}/`;
  function live(project, now = Date.now()) {
    for (const [lease, expiresAt] of project.leases) {
      if (expiresAt <= now) project.leases.delete(lease);
    }
    return project.leases.size > 0;
  }
  function byRecency() {
    return [...projects.values()].sort((left, right) => right.lastSeen - left.lastSeen);
  }
  function savedProjects() {
    const ordered = byRecency();
    const reported = (field) => Object.fromEntries(ordered.filter((project) => project[field].length).map((project) => [project.root, project[field]]));
    return { roots: ordered.map(({ root }) => root), directories: { evidence: reported("evidenceDirectories"), intelligence: reported("intelligenceDirectories"), records: reported("recordStoreDirectories") } };
  }
  async function rememberProjects() {
    const now = Date.now();
    const idle = byRecency().filter((project) => !live(project, now) && workspaceViewers(project) === 0);
    for (const project of idle.slice(RECENT_LIMIT)) projects.delete(project.id);
    pruneWorkspaces();
    const { roots, directories } = savedProjects();
    const text = JSON.stringify([roots, directories]);
    if (text === persisted) return;
    persisted = text;
    await writeProjectRoots(directory, roots, directories).catch(() => {
    });
  }
  function storeAt(evidenceDirectory) {
    let store = stores.get(evidenceDirectory);
    if (!store) stores.set(evidenceDirectory, store = new ConservationStore(evidenceDirectory));
    return store;
  }
  function evidenceStoreOf(project) {
    if (!project?.evidenceDirectories.length) return conservationStore;
    const reported = project.evidenceDirectories.map(storeAt);
    return {
      async get(...request) {
        let missing;
        for (const store of reported) {
          try {
            return await store.get(...request);
          } catch (error) {
            if (error.code !== "evidence_missing") throw error;
            missing = error;
          }
        }
        throw missing;
      },
      registerCoordinationOutputs: (...request) => reported[0].registerCoordinationOutputs(...request),
      writeManaged: (...request) => reported[0].writeManaged(...request)
    };
  }
  function useReportedStores(project) {
    if (project.recordStoreDirectories.length) useManagedStores(project.root, project.recordStoreDirectories[0]);
  }
  async function reportDirectories(project, body) {
    let changed = false;
    for (const [name, field] of STORAGE_FIELDS) {
      if (body[name] === void 0) continue;
      const resolved = path.resolve(body[name]);
      if (project[field][0] === resolved) continue;
      project[field] = [resolved, ...project[field].filter((known) => known !== resolved)].slice(0, STORAGE_DIRECTORY_LIMIT);
      changed = true;
    }
    useReportedStores(project);
    if (changed) await rememberProjects();
  }
  function checkDirectories(body) {
    for (const [name] of STORAGE_FIELDS) {
      if (body[name] !== void 0 && (typeof body[name] !== "string" || !path.isAbsolute(body[name]))) {
        throw statusError(400, `The ${name} must be an absolute path.`);
      }
    }
  }
  function intelligenceDirectoriesOf(project) {
    return [...project?.intelligenceDirectories ?? [], nativeSemanticRuntime.directory];
  }
  async function touch(project) {
    project.lastSeen = ++sequence;
    await rememberProjects();
  }
  function pruneWorkspaces() {
    for (const view of workspaces.values()) {
      const members = membersOf(view);
      if (!members.length) {
        if (view.storeRoot) {
          view.review.useCheckout(view.storeRoot);
          continue;
        }
        if (view.review.viewerCount() > 0) continue;
        dropView(view);
        continue;
      }
      if (!members.some((project) => project.root === view.root)) useCheckout(view, members.sort((left, right) => right.lastSeen - left.lastSeen)[0]);
    }
  }
  function useCheckout(view, project) {
    view.review.useCheckout(project.root);
  }
  function dropView(view) {
    view.review.closeViewers();
    view.watch.stop();
    workspaces.delete(view.id);
    pendingNotices.delete(view.id);
  }
  async function syncedClone(view) {
    if (view.kind !== "store" || view.identity.startsWith("file:")) return null;
    if (await isStoreWithoutCheckout(view.root)) return storeFolder(view.identity);
    const store = await recordStoreOf(view.root).catch(() => null);
    return store?.external && store.sync ? store.base : null;
  }
  function makeView({ id, kind, identity, urls, root }) {
    const view = { id, kind, identity, urls, usedAt: addedUsage.get(id) ?? 0, review: null, watch: null, storeRoot: null, get root() {
      return this.review.projectRoot;
    } };
    view.watch = watchWorkspace({ base: () => syncedClone(view), label: () => remoteLabel(view.urls[0]) ?? view.identity, intervalMs: workspaceFetchMs, maxMs: workspaceFetchMaxMs, fetchCode: () => code.fetchAll(view.id) });
    view.review = createProjectReview({
      projectRoot: root,
      baseUrl: `http://127.0.0.1:${port}${viewerPrefix()}/w/${view.id}`,
      instance,
      appVersion: pluginVersion,
      onViewer: (sendNotice) => {
        view.usedAt = ++sequence;
        deliverPendingNotices(view.id, sendNotice);
      },
      // Every checkout of a workspace shows its page through this one review, so an applied action reaches every page of the workspace,
      // and an answered gate or a rebuild changes what the project list shows for each of its checkouts.
      onAction: (event) => {
        view.review.notify("action", event);
        for (const member of membersOf(view)) {
          member.summary.gates.invalidate();
          member.summary.indexing.invalidate();
        }
      },
      evidenceStore: () => evidenceStoreOf(currentProject(view)),
      intelligenceDirectories: () => intelligenceDirectoriesOf(currentProject(view)),
      writeSessions,
      hub,
      workspace: {
        id: view.id,
        describe: () => describeWorkspace(view),
        sync: async () => await syncedClone(view) ? view.watch.state() : null,
        viewers: (count) => view.watch.viewers(count),
        checkouts: () => membersOf(view).map(({ root: member, repository }) => ({ root: member, repository: repository ?? null })),
        code: {
          folder: codeFolder,
          state: (repository) => code.state(view.id, repository),
          tree: (repository, folder) => code.tree(view.id, repository, folder),
          compare: (repository, base) => code.compare(view.id, repository, base),
          file: (repository, at) => code.file(view.id, repository, at),
          defaultFile: (repository, file) => code.defaultFile(view.id, repository, file),
          defaultFiles: (repository) => code.defaultFiles(view.id, repository),
          reachable: (repository, commit) => code.reachable(view.id, repository, commit),
          branchesHolding: (repository, commit) => code.branchesHolding(view.id, repository, commit),
          blobs: (repository, commit, paths) => code.blobs(view.id, repository, commit, paths),
          components: (repository) => code.components(view.id, repository)
        }
      }
    });
    workspaces.set(view.id, view);
    return view;
  }
  async function prepareStoreRoot(view) {
    if (view.storeRoot) return view.storeRoot;
    const root = path.join(directory, STORE_ROOTS, view.id);
    await mkdir(root, { recursive: true, mode: 448 });
    const base = await storeFolder(view.identity);
    const network = !view.identity.startsWith("file:");
    if (network) markManagedStore(base);
    await useStoreWithoutCheckout(root, { base, label: remoteLabel(view.urls[0]) ?? view.identity, sync: network });
    view.storeRoot = await realpath(root);
    return view.storeRoot;
  }
  async function addedView(entry) {
    let view = workspaces.get(entry.id);
    if (!view) {
      const root = await prepareStoreRoot({ id: entry.id, identity: entry.identity, urls: storeAddresses(entry.urls), storeRoot: null });
      view = workspaces.get(entry.id) ?? makeView({ id: entry.id, kind: "store", identity: entry.identity, urls: storeAddresses(entry.urls), root });
      view.storeRoot ??= root;
    }
    if (!view.storeRoot) await prepareStoreRoot(view);
    if (!membersOf(view).length) view.review.useCheckout(view.storeRoot);
    return view;
  }
  async function forgetAddedView(id) {
    const view = workspaces.get(id);
    if (!view) return;
    const root = view.storeRoot;
    view.storeRoot = null;
    if (!membersOf(view).length) dropView(view);
    if (root) {
      await forgetStoreWithoutCheckout(root);
      await rm(root, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  const currentProject = (view) => projects.get(projectId(view.root)) ?? membersOf(view)[0] ?? null;
  async function placeProject(project) {
    const found = await checkoutWorkspace(project.root);
    const previous2 = project.workspaceId;
    project.workspaceId = found.id;
    project.repository = found.repository;
    let view = workspaces.get(found.id);
    const addedEntry = added.list().find((entry) => entry.id === found.id);
    if (!view) view = makeView({ id: found.id, kind: found.kind, identity: found.identity, urls: [...addedEntry?.urls ?? []], root: project.root });
    if (addedEntry && !view.storeRoot) await prepareStoreRoot(view).catch(() => null);
    if (found.url !== null) view.urls = storeAddresses([...view.urls, found.url]);
    if (previous2 && previous2 !== found.id) pruneWorkspaces();
    return view;
  }
  function workspaceViews() {
    const now = Date.now();
    const addedEntries = added.list();
    const views = [...workspaces.values()].map((view) => {
      const members = membersOf(view);
      const entry = addedEntries.find((item) => item.id === view.id);
      view.urls = storeAddresses([...view.urls, ...entry?.urls ?? []]);
      return {
        id: view.id,
        kind: view.kind,
        identity: view.identity,
        urls: view.urls,
        root: view.root,
        members: members.map(({ root, repository }) => ({ root, repository })),
        live: members.some((project) => live(project, now)),
        lastSeen: Math.max(view.usedAt, ...members.map((project) => project.lastSeen)),
        added: Boolean(entry)
      };
    });
    for (const entry of addedEntries) {
      if (workspaces.has(entry.id)) continue;
      views.push({ id: entry.id, kind: "store", identity: entry.identity, urls: storeAddresses(entry.urls), root: null, members: [], live: false, lastSeen: addedUsage.get(entry.id) ?? 0, added: true });
    }
    return views;
  }
  async function viewOf(id) {
    const view = workspaces.get(id);
    if (view) return view;
    const entry = added.list().find((item) => item.id === id);
    return entry ? addedView(entry) : null;
  }
  async function checkoutsNaming(identity) {
    const id = storeWorkspaceId(identity);
    const registered = [...projects.values()].filter((project) => project.workspaceId === id).map((project) => project.root);
    const folder = await storeFolder(identity);
    const listed = (await listMachineCheckouts().catch(() => [])).filter((entry) => entry.store === folder).map((entry) => entry.path);
    return Promise.all([.../* @__PURE__ */ new Set([...registered, ...listed])].map(async (root) => {
      const found = await checkoutWorkspace(root).catch(() => null);
      return { path: root, url: found?.identity === identity ? found.url : null };
    }));
  }
  async function keptStores() {
    const kept = [];
    for (const view of workspaceViews()) {
      if (view.kind === "store" && !view.identity.startsWith("file:")) kept.push({ identity: view.identity, folder: await storeFolder(view.identity) });
    }
    return kept;
  }
  function refuseChange(request, response) {
    if (!fromPage(request)) {
      sendJson(response, 403, { code: "origin_refused", message: "A change must come from the review page as JSON." });
      return true;
    }
    if (!writeSessions?.valid(request.headers["x-prism-write"])) {
      sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
      return true;
    }
    return false;
  }
  async function addWorkspace(request, response) {
    if (refuseChange(request, response)) return;
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { code: "invalid_request", message: error.message });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmEmpty !== void 0 && typeof body.confirmEmpty !== "boolean") {
      sendJson(response, 400, { code: "invalid_request", message: "The request must be a JSON object of url and, optionally, confirmEmpty true or false." });
      return;
    }
    try {
      const { identity, merged } = await added.add(body.url, { confirmEmpty: body.confirmEmpty === true, keptStores, seenUrls: (identity2) => workspaces.get(storeWorkspaceId(identity2))?.urls ?? [] });
      const id = storeWorkspaceId(identity);
      addedUsage.set(id, ++sequence);
      const view = await addedView(added.list().find((entry) => entry.id === id)).catch(() => workspaces.get(id) ?? null);
      if (view) view.usedAt = addedUsage.get(id);
      const workspace = (await workspaceList()).find((entry) => entry.id === id);
      sendJson(response, 200, { workspace, merged });
    } catch (error) {
      if (!error.status || !error.code) throw error;
      sendJson(response, error.status, { code: error.code, message: error.message });
    }
  }
  async function removeWorkspace(request, response, id) {
    if (refuseChange(request, response)) return;
    await readBody(request);
    if (!added.has(id)) {
      const known = (await workspaceList()).some((entry) => entry.id === id);
      sendJson(response, known ? 409 : 404, known ? { code: "workspace_not_added", message: "This workspace was not added from its store URL; it is listed while a checkout of it is registered." } : { code: "workspace_unknown", message: "No workspace has that id on this machine." });
      return;
    }
    await forgetAddedView(id);
    const removed = await added.remove(id, { checkoutsNaming });
    addedUsage.delete(id);
    if (!(await workspaceList()).some((entry) => entry.id === id)) await code.disableWorkspace(id);
    sendJson(response, 200, { removed: true, clone: removed.clone, message: removed.message });
  }
  const workspaceList = () => listWorkspaces(workspaceViews(), { urlOf: workspaceUrl });
  async function repositoryRemotes(view) {
    const remotes = view.kind === "store" ? await registeredRemotes(await storeFolder(view.identity)) : /* @__PURE__ */ new Map();
    for (const member of membersOf(view)) if (member.repository && !remotes.has(member.repository)) remotes.set(member.repository, []);
    return remotes;
  }
  async function setCode(request, response, view, encodedRepository) {
    if (refuseChange(request, response)) return;
    let repository;
    try {
      repository = decodeURIComponent(encodedRepository);
    } catch {
      await readBody(request);
      sendJson(response, 400, { code: "invalid_request", message: "The repository name in the address is not a valid percent-encoded name." });
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { code: "invalid_request", message: error.message });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      sendJson(response, 400, { code: "invalid_request", message: "The request must be a JSON object of enabled true or false." });
      return;
    }
    const remotes = (await repositoryRemotes(view)).get(repository);
    if (!remotes) {
      sendJson(response, 404, { code: "repository_unknown", message: "The workspace has no repository of that name." });
      return;
    }
    if (!body.enabled) {
      sendJson(response, 200, { repository, code: await code.disable(view.id, repository) });
      return;
    }
    if (!remotes.length) {
      sendJson(response, 409, { code: "no_remote", message: `The store's registration of ${repository} lists no remote, so Prism has nothing to clone its code from.` });
      return;
    }
    try {
      sendJson(response, 200, { repository, code: await code.enable(view.id, repository, remotes[0]) });
    } catch (error) {
      if (!error.status || !error.code) throw error;
      sendJson(response, error.status, { code: error.code, message: error.message });
    }
  }
  async function describeWorkspace(view) {
    return { id: view.id, name: await nameOfWorkspace(view), kind: view.kind, url: workspaceUrl(view.id) };
  }
  function deliverPendingNotices(viewedId, sendNotice) {
    const now = Date.now();
    for (const [id, pending] of pendingNotices) {
      if (pending.expiresAt <= now || id === viewedId) {
        pendingNotices.delete(id);
      } else {
        sendNotice("notice", pending.notice);
        pendingNotices.delete(id);
      }
    }
  }
  async function projectFor(projectRoot, { persist = true } = {}) {
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      throw statusError(400, "The projectRoot must be an absolute path.");
    }
    const root = await realpath(projectRoot).catch(() => {
      throw statusError(400, "The projectRoot does not exist.");
    });
    if (!(await stat(root)).isDirectory()) {
      throw statusError(400, "The projectRoot must be a directory.");
    }
    const id = projectId(root);
    let project = projects.get(id);
    if (!project) {
      project = { id, root, leases: /* @__PURE__ */ new Map(), lastSeen: ++sequence, workspaceId: null, repository: null, evidenceDirectories: [], intelligenceDirectories: [], recordStoreDirectories: [] };
      project.summary = projectSummary(project);
      projects.set(id, project);
      if (persist) await rememberProjects();
    }
    return project;
  }
  function grantOpen(acceptsGrant, now = Date.now()) {
    const connected = acceptsGrant ? writableViewerCount() : viewerCount();
    const open = connected === 0 && now - openGrantedAt >= OPEN_LEASE_MS;
    if (open) openGrantedAt = now;
    return open;
  }
  function announce(project, view, url, name, acceptsGrant) {
    const notice = { projectId: project.id, name, projectRoot: project.root, url, at: (/* @__PURE__ */ new Date()).toISOString() };
    for (const other of workspaces.values()) {
      if (other !== view) other.review.notify("notice", notice);
    }
    const now = Date.now();
    const watched = viewerCount() > 0;
    const open = grantOpen(acceptsGrant, now);
    if (open || view.review.viewerCount() > 0) pendingNotices.delete(view.id);
    else if (!watched) pendingNotices.set(view.id, { notice, expiresAt: now + noticeMs });
    return open;
  }
  async function gateCount(root) {
    if (!await stat(root).then((info) => info.isDirectory(), () => false)) return null;
    return loadAttention(root).then((attention) => attention.gateCount, () => null);
  }
  function projectSummary(project) {
    return {
      workspace: createCachedValue(() => readWorkspaceIdentity(project.root), { ttlMs: PROJECT_SUMMARY_MS.store }),
      // Checkouts whose records resolve to one store share their records, so the switcher lists them as one project.
      store: createCachedValue(() => describeRecordStore(project.root).then(async ({ kind, label, location }) => ({ kind, label, location, workspaceName: kind === "project" ? null : await readWorkspaceName(project.root) })).catch(() => null), { ttlMs: PROJECT_SUMMARY_MS.store }),
      gates: createCachedValue(() => gateCount(project.root), { ttlMs: PROJECT_SUMMARY_MS.gates }),
      indexing: createCachedValue(async () => (await readIndexingStatus(project.root, intelligenceDirectoriesOf(project)).catch(() => null))?.state ?? null, { ttlMs: PROJECT_SUMMARY_MS.indexing })
    };
  }
  function forgetSummary(project) {
    for (const value of Object.values(project.summary)) value.invalidate();
    recheckViews(project.root);
  }
  async function projectList(current) {
    const now = Date.now();
    const entries = await Promise.all([...projects.values()].map(async (project) => ({
      id: project.id,
      name: path.basename(project.root),
      workspace: await project.summary.workspace.get(),
      projectRoot: project.root,
      live: live(project, now),
      gates: await project.summary.gates.get().catch(() => null),
      store: await project.summary.store.get().catch(() => null),
      indexing: await project.summary.indexing.get().catch(() => null),
      url: workspaceUrl(project.workspaceId),
      lastSeen: project.lastSeen
    })));
    entries.sort((left, right) => Number(right.live) - Number(left.live) || right.lastSeen - left.lastSeen || left.name.localeCompare(right.name));
    return { current, projects: entries.map(({ lastSeen, ...entry }) => entry) };
  }
  async function mostRecentWorkspace() {
    const [chosen] = (await workspaceList()).sort((left, right) => Number(right.live) - Number(left.live));
    return chosen ?? null;
  }
  async function serveRoot(request, response, prefix) {
    const chosen = await mostRecentWorkspace();
    if (chosen) {
      response.writeHead(302, { Location: `${prefix}/w/${chosen.id}/`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    await servePageRoute(request, response, "/");
  }
  async function checkoutRedirect(project, rest, query, prefix) {
    const view = await placeProject(project);
    const kept = new URLSearchParams(query);
    const artifact = kept.get("artifact");
    if (artifact && view.kind === "store") kept.set("artifact", await storeTabRef(project.root, artifact));
    const search = kept.toString();
    return `${prefix}/w/${view.id}${rest}${search ? `?${search}` : ""}`;
  }
  async function serveMissing(request, response, prefix, message) {
    if (!wantsPage(request)) {
      send(response, 404, message);
      return;
    }
    const chosen = await mostRecentWorkspace();
    response.writeHead(302, { Location: chosen ? `${prefix}/w/${chosen.id}/?missing=project` : `${prefix}/`, "Cache-Control": "no-store" });
    response.end();
  }
  function freshNonce(nonce) {
    const now = Date.now();
    for (const [seen, at] of nonces) {
      if (now - at > NONCE_MS) nonces.delete(seen);
    }
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, now);
    return true;
  }
  function withGrant(answer, acceptsGrant) {
    return answer.open && acceptsGrant ? { ...answer, writeGrant: writeSessions.issueGrant() } : answer;
  }
  async function controlAnswer(request, route, text) {
    const lease = /^\/control\/projects\/([A-Za-z0-9_-]{1,64})$/.exec(route)?.[1];
    if (route === "/control/health" && request.method === "GET") {
      return { protocol: REVIEW_APP_PROTOCOL, pluginVersion, pid: process.pid };
    }
    if (route === "/control/projects" && request.method === "GET") {
      return { projects: [...projects.values()].map((project) => ({ id: project.id, projectRoot: project.root, live: live(project) })) };
    }
    if (lease && request.method === "PUT") {
      const body = parseBody(text);
      checkDirectories(body);
      const project = await projectFor(body.projectRoot);
      await reportDirectories(project, body);
      forgetSummary(project);
      project.leases.set(lease, Date.now() + LEASE_MS);
      const view = await placeProject(project);
      await touch(project);
      return { projectId: project.id, workspaceId: view.id, url: view.review.reviewUrl([]) };
    }
    if (lease && request.method === "DELETE") {
      for (const project of projects.values()) project.leases.delete(lease);
      await rememberProjects();
      return {};
    }
    if (route === "/control/present" && request.method === "POST") {
      const body = parseBody(text);
      checkDirectories(body);
      const acceptsGrant = body.acceptsGrant === true;
      if (body.projectRoot === void 0) {
        return withGrant({ url: `http://127.0.0.1:${port}${viewerPrefix()}/`, open: body.open === true && grantOpen(acceptsGrant) }, acceptsGrant);
      }
      const project = await projectFor(body.projectRoot);
      await reportDirectories(project, body);
      forgetSummary(project);
      const view = await placeProject(project);
      const review = view.review;
      if (body.open === true && body.start === true) {
        await touch(project);
        return withGrant({ url: review.reviewUrl([]), open: grantOpen(acceptsGrant), session: review.getSession() }, acceptsGrant);
      }
      if (body.open === true) {
        const tabs = normalizeTabs(body.tabs);
        const presented = await review.presentTabs(tabs, { from: project.root, ...Object.hasOwn(body, "group") ? { group: body.group } : {}, ...body.by && typeof body.by === "object" ? { by: body.by } : {} });
        await touch(project);
        const url = review.reviewUrl(tabs.length ? [presented.activeTab] : []);
        return withGrant({ url, open: announce(project, view, url, workspaceLabel(await readWorkspaceIdentity(project.root)), acceptsGrant), session: review.getSession() }, acceptsGrant);
      }
      if (body.tabs !== void 0) {
        await review.setOpenTabs(body.tabs, { from: project.root });
        await touch(project);
      }
      return { url: review.reviewUrl([]), open: false, session: await review.currentSession() };
    }
    if (route === "/control/shutdown" && request.method === "POST") {
      const handoff = parseBody(text).handoff === true;
      setImmediate(() => void close({ handoff }));
      return {};
    }
    throw statusError(404, "Not found");
  }
  async function handleControl(request, response, route) {
    const text = await readBody(request);
    const nonce = request.headers.origin === void 0 ? verifyRequest(controlToken, request.headers["x-prism-control"], request.method, request.url, text) : null;
    if (!nonce || !freshNonce(nonce)) {
      send(response, 403, "Forbidden");
      return;
    }
    let status = 200;
    let body;
    try {
      body = JSON.stringify(await controlAnswer(request, route, text));
    } catch (error) {
      status = error.status ?? 400;
      body = JSON.stringify({ message: error.message });
    }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Prism-Proof": proveResponse(controlToken, nonce, body)
    });
    response.end(body);
  }
  const SLOW_REQUEST_MS = 2e3;
  const routeOf = (request) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://127.0.0.1").pathname;
    } catch {
      return "<invalid>";
    }
    return pathname.startsWith(viewerPrefix()) ? `<viewer>${pathname.slice(viewerPrefix().length)}` : pathname.startsWith("/control/") ? pathname : "<other>";
  };
  const server = createServer((request, response) => withFetchlessReads(() => outsideToolCall(async () => {
    const started = performance.now();
    response.once("finish", () => {
      const ms = performance.now() - started;
      if (ms >= SLOW_REQUEST_MS && !isEventStream(response)) log.warn("slow_request", { method: request.method, route: routeOf(request), status: response.statusCode, ms: Math.round(ms) });
    });
    try {
      if (!isTrustedHost(request.headers.host)) {
        send(response, 403, "Unknown host");
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/control/")) {
        await handleControl(request, response, url.pathname);
        return;
      }
      const prefix = viewerPrefix();
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        await serveOutsideSession(request, response, url.pathname);
        return;
      }
      if (url.pathname === prefix || url.pathname === `${prefix}/`) {
        await serveRoot(request, response, prefix);
        return;
      }
      if (!url.pathname.startsWith(`${prefix}/`)) {
        send(response, 404, "Not found");
        return;
      }
      const route = url.pathname.slice(prefix.length);
      const inWorkspace = /^\/w\/([0-9a-f]{16})(\/.*)?$/.exec(route);
      if (inWorkspace) {
        const view = await viewOf(inWorkspace[1]);
        if (!view) {
          await serveMissing(request, response, prefix, "No workspace has that id on this machine.");
          return;
        }
        if (!inWorkspace[2]) {
          response.writeHead(308, { Location: `${prefix}${route}/${url.search}`, "Cache-Control": "no-store" });
          response.end();
          return;
        }
        const codeSwitch = /^\/api\/code\/([^/]+)$/.exec(inWorkspace[2]);
        if (codeSwitch && request.method === "PUT") {
          await setCode(request, response, view, codeSwitch[1]);
          return;
        }
        if (inWorkspace[2] === "/api/projects" && request.method === "GET") {
          send(response, 200, JSON.stringify(await projectList(currentProject(view)?.id ?? null)), "application/json; charset=utf-8");
          return;
        }
        await view.review.handle(request, response, inWorkspace[2], url);
        return;
      }
      const inCheckout = /^\/p\/([0-9a-f]{16})(\/.*)?$/.exec(route);
      if (inCheckout) {
        const project = projects.get(inCheckout[1]);
        if (!project) {
          await serveMissing(request, response, prefix, "Not found");
          return;
        }
        response.writeHead(308, { Location: await checkoutRedirect(project, inCheckout[2] || "/", url.searchParams, prefix), "Cache-Control": "no-store" });
        response.end();
        return;
      }
      if (route === "/api/workspaces" && request.method === "GET") {
        send(response, 200, JSON.stringify({ workspaces: await workspaceList() }), "application/json; charset=utf-8");
        return;
      }
      if (route === "/api/workspaces" && request.method === "POST") {
        await addWorkspace(request, response);
        return;
      }
      const removing = /^\/api\/workspaces\/([^/]+)$/.exec(route);
      if (removing && request.method === "DELETE") {
        await removeWorkspace(request, response, removing[1]);
        return;
      }
      if (route === "/api/write-session" && request.method === "POST") {
        await exchangeWriteGrant(request, response, writeSessions);
        return;
      }
      if (route === "/api/index" && request.method === "GET") {
        send(response, 200, JSON.stringify({ workspace: null, workspaces: (await workspaceList()).length }), "application/json; charset=utf-8");
        return;
      }
      if (route !== "/review" && await servePageRoute(request, response, route)) return;
      send(response, 404, "Not found");
    } catch (error) {
      log.warn("request_failed", { method: request.method, route: routeOf(request), status: error.status ?? 400, ...errorFields(error) });
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, error.status ?? 400, error.message);
      }
    }
  })));
  server.on("clientError", (error, socket) => {
    const pending = socket._httpMessage;
    if (pending && !pending.writableFinished && !pending.destroyed) {
      pending.once("close", () => socket.destroy());
      return;
    }
    const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r
Connection: close\r
\r
`);
    socket.destroy();
  });
  let bound = false;
  const handedOffAt = Date.parse(previous?.handedOffAt);
  if (previous?.handoff === true && Date.now() - handedOffAt <= LOCK_STALE_MS) {
    try {
      await listen(server, previous.port);
      viewerToken = previous.viewerToken;
      bound = true;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  writeSessions = await createWriteSessions({ directory, restore: bound });
  const last = bound ? null : await readLastPort(directory);
  if (last) {
    try {
      await listen(server, last);
      bound = true;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  if (!bound) await listen(server, 0);
  port = server.address().port;
  await writeLastPort(directory, port).catch(() => {
  });
  const restored = await readProjectRoots(directory);
  const restoredEvidence = await readProjectDirectories(directory, "evidence");
  const restoredIntelligence = await readProjectDirectories(directory, "intelligence");
  const restoredRecords = await readProjectDirectories(directory, "records");
  for (const [index, root] of restored.entries()) {
    const project = await projectFor(root, { persist: false }).catch(() => null);
    if (project) {
      project.lastSeen = restored.length - index;
      project.evidenceDirectories = restoredEvidence[root] ?? [];
      project.intelligenceDirectories = restoredIntelligence[root] ?? [];
      project.recordStoreDirectories = restoredRecords[root] ?? [];
      useReportedStores(project);
      await placeProject(project).catch(() => null);
    }
  }
  for (const entry of added.list()) await addedView(entry).catch(() => null);
  pruneWorkspaces();
  sequence = restored.length;
  const saved = savedProjects();
  persisted = JSON.stringify([saved.roots, saved.directories]);
  published = { protocol: REVIEW_APP_PROTOCOL, port, controlToken, viewerToken, pid: process.pid, pluginVersion, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await writeDiscovery(directory, published);
  async function republish() {
    if (closing || !published) return;
    const current = await readDiscovery(directory);
    if (current?.controlToken !== controlToken) await writeDiscovery(directory, published).catch(() => {
    });
  }
  const agentEnv = { ...process.env, PRISM_REVIEW_APP_DIR: directory };
  void sweepUnusedVersions(agentEnv);
  const sweep = setInterval(() => {
    void sweepUnusedVersions(agentEnv);
    const now = Date.now();
    const busy = viewerCount() > 0 || [...projects.values()].some((project) => live(project, now));
    if (busy) idleSince = now;
    else if (now - idleSince >= idleMs) void close({ handoff: false });
  }, SWEEP_MS);
  sweep.unref();
  close = ({ handoff = false } = {}) => {
    closing ??= (async () => {
      clearInterval(sweep);
      for (const view of workspaces.values()) {
        view.watch.stop();
        view.review.closeViewers();
      }
      hub.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      if (ownsLock) {
        if (handoff) await writeDiscovery(directory, { ...published, handoff: true, handedOffAt: (/* @__PURE__ */ new Date()).toISOString() }).catch(() => {
        });
        else await removeDiscovery(directory, controlToken).catch(() => {
        });
      }
      releaseLock();
      await lock.released();
    })();
    return closing;
  };
  return { port, instance, viewerUrl: `http://127.0.0.1:${port}${viewerPrefix()}/`, closed: stopped.then(() => closing), close };
}
export {
  startReviewApp
};
