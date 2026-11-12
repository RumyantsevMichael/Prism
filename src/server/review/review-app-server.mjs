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
import { readIndexingStatus } from "../repository-intelligence/index-status.mjs";
import { createProjectReview, exchangeWriteGrant, fromPage, isTrustedHost, normalizeTabs, READ_ONLY_NOTICE, readBody, readJson, send, sendJson, servePageRoute, storeTabRef } from "./review-server.mjs";
import { loadAttention } from "./workspace-model.mjs";
import { readWorkspaceIdentity, workspaceLabel } from "./workspace-identity.mjs";
import { createAddedWorkspaces, storeAddresses } from "./added-workspaces.mjs";
import { checkoutWorkspace, listWorkspaces, nameOfWorkspace, storeFolder, storeWorkspaceId } from "./workspaces.mjs";
import { listMachineCheckouts } from "../workflow/machine-checkouts.mjs";
import { createWriteSessions } from "./write-sessions.mjs";
import { watchWorkspace, WORKSPACE_FETCH_MAX_MS, WORKSPACE_FETCH_MS } from "./workspace-sync.mjs";
import { codeFolder, createCodeClones, registeredRemotes } from "./code-clones.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";

const LEASE_MS = 3 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 30 * 1000;
const NONCE_MS = 2 * 60 * 1000;
const LOCK_RENEW_MS = 5 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 1000;
const OPEN_LEASE_MS = 10 * 1000;
const STORAGE_DIRECTORY_LIMIT = 4;
const STORAGE_FIELDS = [["evidenceDirectory", "evidenceDirectories"], ["intelligenceDirectory", "intelligenceDirectories"], ["recordStoreDirectory", "recordStoreDirectories"]];
const NOTICE_MS = 60 * 1000;
const RECENT_LIMIT = 20;
// The empty folders that stand for no checkout, one per added workspace, through which the app reads and writes a store's clone when no checkout of it is registered.
const STORE_ROOTS = "store-roots";

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

// Takes the app lock and keeps it until `stopped` settles; `held` rejects when another app holds it, and `released` settles once the lock file is gone.
function holdLock(directory, stopped, onRenew) {
  let released;
  const held = new Promise((resolve, reject) => {
    released = withFileLock(lockBase(directory), () => {
      resolve();
      return stopped;
    }, undefined, { renew: true, abandonWhenUnrenewed: true, heartbeatMs: LOCK_RENEW_MS, staleMs: LOCK_STALE_MS, timeoutMs: LOCK_TIMEOUT_MS, onRenew });
    released.catch(reject);
  });
  return { held, released: () => released.catch(() => {}) };
}

// The review app serves every registered project of one user from one port, behind a lock that keeps it unique.
// Its record reads start no fetch, because its timed workspace watcher fetches for the pages it serves.
export function startReviewApp(options) {
  return withFetchlessReads(() => serveReviewApp(options));
}

async function serveReviewApp({ directory, pluginVersion = null, idleMs = IDLE_MS, noticeMs = NOTICE_MS, workspaceFetchMs = WORKSPACE_FETCH_MS, workspaceFetchMaxMs = WORKSPACE_FETCH_MAX_MS } = {}) {
  await prepareDirectory(directory);
  let releaseLock;
  const stopped = new Promise((resolve) => { releaseLock = resolve; });
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
  const projects = new Map();
  // The workspaces of the registered checkouts, by workspace id, each with the one review that serves its page for every checkout of it.
  const workspaces = new Map();
  const nonces = new Map();
  // Presentations nobody could see yet, by presenting workspace id, handed to the next viewer of another workspace.
  const pendingNotices = new Map();
  const stores = new Map();
  // The workspaces a person added from a store URL, which stay listed until the person removes them, and when each one's own page was last opened.
  const added = await createAddedWorkspaces({ directory });
  // The repositories whose code content a person turned on, each with a blobless clone in the app folder's code/, which every workspace fetch also fetches.
  const code = await createCodeClones({ directory });
  const addedUsage = new Map();
  let openGrantedAt = -Infinity;
  // Recency is a counter rather than a clock, so projects touched within one millisecond keep their order.
  let sequence = 0;
  let persisted = null;
  let viewerToken = newCredential();
  let port = null;
  let published = null;
  let idleSince = Date.now();
  let closing = null;
  // One write session store serves every checkout's page, so a tab that switches checkouts keeps its write session.
  let writeSessions = null;

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

  // Keeps at most RECENT_LIMIT projects that are neither live nor watched, and saves the projects most recent first whenever that changes.
  async function rememberProjects() {
    const now = Date.now();
    const idle = byRecency().filter((project) => !live(project, now) && workspaceViewers(project) === 0);
    for (const project of idle.slice(RECENT_LIMIT)) projects.delete(project.id);
    pruneWorkspaces();
    const { roots, directories } = savedProjects();
    const text = JSON.stringify([roots, directories]);
    if (text === persisted) return;
    persisted = text;
    await writeProjectRoots(directory, roots, directories).catch(() => {});
  }

  function storeAt(evidenceDirectory) {
    let store = stores.get(evidenceDirectory);
    if (!store) stores.set(evidenceDirectory, store = new ConservationStore(evidenceDirectory));
    return store;
  }

  // A project's evidence lives in the stores of the sessions that write it, which need not be the store of the process that launched this app.
  // Evidence ids are digests of immutable records, so a read may try every reported store; writes go to the most recently reported one.
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

  // A remote record store resolves in the clone folder of the session that reported the project most recently, which need not be this app's host.
  function useReportedStores(project) {
    if (project.recordStoreDirectories.length) useManagedStores(project.root, project.recordStoreDirectories[0]);
  }

  // Sessions report where they keep evidence, index storage, and managed record-store clones, which depends on each host's plugin data directory.
  async function reportDirectories(project, body) {
    let changed = false;
    for (const [name, field] of STORAGE_FIELDS) {
      if (body[name] === undefined) continue;
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
      if (body[name] !== undefined && (typeof body[name] !== "string" || !path.isAbsolute(body[name]))) {
        throw statusError(400, `The ${name} must be an absolute path.`);
      }
    }
  }

  // The app's own default storage comes last, so a project no session has reported yet still shows an index this host built.
  function intelligenceDirectoriesOf(project) {
    return [...(project?.intelligenceDirectories ?? []), nativeSemanticRuntime.directory];
  }

  async function touch(project) {
    project.lastSeen = ++sequence;
    await rememberProjects();
  }

  // A workspace keeps its review while a checkout of it is registered, a page of it is open, or a person added it, and reads through its most recent checkout once the one it read through left,
  // or, for an added workspace with no checkout left, through its store's clone alone.
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

  // The store clone a workspace's page syncs: the managed clone of its network store when the checkout it reads through has Store sync on, or when it reads through no checkout; null otherwise.
  async function syncedClone(view) {
    if (view.kind !== "store" || view.identity.startsWith("file:")) return null;
    if (await isStoreWithoutCheckout(view.root)) return storeFolder(view.identity);
    const store = await recordStoreOf(view.root).catch(() => null);
    return store?.external && store.sync ? store.base : null;
  }

  // The one review of a workspace, read through root, with the fetch timer that its connected pages drive.
  function makeView({ id, kind, identity, urls, root }) {
    const view = { id, kind, identity, urls, usedAt: addedUsage.get(id) ?? 0, review: null, watch: null, storeRoot: null, get root() { return this.review.projectRoot; } };
    view.watch = watchWorkspace({ base: () => syncedClone(view), label: () => remoteLabel(view.urls[0]) ?? view.identity, intervalMs: workspaceFetchMs, maxMs: workspaceFetchMaxMs, fetchCode: () => code.fetchAll(view.id) });
    view.review = createProjectReview({ projectRoot: root, baseUrl: `http://127.0.0.1:${port}${viewerPrefix()}/w/${view.id}`, instance, appVersion: pluginVersion,
      onViewer: (sendNotice) => {
        view.usedAt = ++sequence;
        deliverPendingNotices(view.id, sendNotice);
      },
      // Every checkout of a workspace shows its page through this one review, so an applied action reaches every page of the workspace.
      onAction: (event) => view.review.notify("action", event),
      evidenceStore: () => evidenceStoreOf(currentProject(view)), intelligenceDirectories: () => intelligenceDirectoriesOf(currentProject(view)), writeSessions,
      workspace: { id: view.id, describe: () => describeWorkspace(view), sync: async () => await syncedClone(view) ? view.watch.state() : null, viewers: (count) => view.watch.viewers(count),
        checkouts: () => membersOf(view).map(({ root: member, repository }) => ({ root: member, repository: repository ?? null })),
        code: {
          folder: codeFolder,
          state: (repository) => code.state(view.id, repository),
          tree: (repository, folder) => code.tree(view.id, repository, folder),
          file: (repository, at) => code.file(view.id, repository, at),
          defaultFile: (repository, file) => code.defaultFile(view.id, repository, file),
          defaultFiles: (repository) => code.defaultFiles(view.id, repository),
          components: (repository) => code.components(view.id, repository)
        } } });
    workspaces.set(view.id, view);
    return view;
  }

  // The folder that stands for no checkout of an added workspace, which reads and writes its store's clone, with the store's sync on for a network store.
  async function prepareStoreRoot(view) {
    if (view.storeRoot) return view.storeRoot;
    const root = path.join(directory, STORE_ROOTS, view.id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const base = await storeFolder(view.identity);
    const network = !view.identity.startsWith("file:");
    if (network) markManagedStore(base);
    await useStoreWithoutCheckout(root, { base, label: remoteLabel(view.urls[0]) ?? view.identity, sync: network });
    view.storeRoot = await realpath(root);
    return view.storeRoot;
  }

  // The review of an added workspace, made on first use, which reads through its store's clone until a checkout of it is registered.
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

  // An added workspace stops reading through its store's clone once removed, and its page closes when no checkout of it is registered.
  async function forgetAddedView(id) {
    const view = workspaces.get(id);
    if (!view) return;
    const root = view.storeRoot;
    view.storeRoot = null;
    if (!membersOf(view).length) dropView(view);
    if (root) {
      await forgetStoreWithoutCheckout(root);
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  const currentProject = (view) => projects.get(projectId(view.root)) ?? membersOf(view)[0] ?? null;

  // The workspace a registered checkout belongs to, made with its review on first use; the store URL the checkout names joins the workspace's URLs in the order first seen.
  async function placeProject(project) {
    const found = await checkoutWorkspace(project.root);
    const previous = project.workspaceId;
    project.workspaceId = found.id;
    project.repository = found.repository;
    let view = workspaces.get(found.id);
    // A workspace that a person added keeps the URLs it was added by first, in the order first seen, and keeps its store's clone to read through once its checkouts leave.
    const addedEntry = added.list().find((entry) => entry.id === found.id);
    if (!view) view = makeView({ id: found.id, kind: found.kind, identity: found.identity, urls: [...(addedEntry?.urls ?? [])], root: project.root });
    if (addedEntry && !view.storeRoot) await prepareStoreRoot(view).catch(() => null);
    // A checkout's Store value can carry a token, which the workspace's URLs never list.
    if (found.url !== null) view.urls = storeAddresses([...view.urls, found.url]);
    if (previous && previous !== found.id) pruneWorkspaces();
    return view;
  }

  // Every workspace with a review, and each added workspace that no registered checkout serves, which reads its store's folder alone.
  function workspaceViews() {
    const now = Date.now();
    const addedEntries = added.list();
    const views = [...workspaces.values()].map((view) => {
      const members = membersOf(view);
      const entry = addedEntries.find((item) => item.id === view.id);
      view.urls = storeAddresses([...view.urls, ...(entry?.urls ?? [])]);
      return { id: view.id, kind: view.kind, identity: view.identity, urls: view.urls, root: view.root, members: members.map(({ root, repository }) => ({ root, repository })),
        live: members.some((project) => live(project, now)), lastSeen: Math.max(view.usedAt, ...members.map((project) => project.lastSeen)), added: Boolean(entry) };
    });
    for (const entry of addedEntries) {
      if (workspaces.has(entry.id)) continue;
      views.push({ id: entry.id, kind: "store", identity: entry.identity, urls: storeAddresses(entry.urls), root: null, members: [], live: false, lastSeen: addedUsage.get(entry.id) ?? 0, added: true });
    }
    return views;
  }

  // The review of a workspace id: a workspace with a review, or an added workspace, whose review is made on first use; null for an unknown id.
  async function viewOf(id) {
    const view = workspaces.get(id);
    if (view) return view;
    const entry = added.list().find((item) => item.id === id);
    return entry ? addedView(entry) : null;
  }

  // The checkouts on this machine that name a workspace's store, each as { path, url } with the store URL its configuration names:
  // its registered checkouts, then the machine's checkout list entries of its store folder.
  async function checkoutsNaming(identity) {
    const id = storeWorkspaceId(identity);
    const registered = [...projects.values()].filter((project) => project.workspaceId === id).map((project) => project.root);
    const folder = await storeFolder(identity);
    const listed = (await listMachineCheckouts().catch(() => [])).filter((entry) => entry.store === folder).map((entry) => entry.path);
    return Promise.all([...new Set([...registered, ...listed])].map(async (root) => {
      const found = await checkoutWorkspace(root).catch(() => null);
      return { path: root, url: found?.identity === identity ? found.url : null };
    }));
  }

  // The network stores this machine keeps for a workspace, which an added store joins when it shares their root commit.
  async function keptStores() {
    const kept = [];
    for (const view of workspaceViews()) {
      if (view.kind === "store" && !view.identity.startsWith("file:")) kept.push({ identity: view.identity, folder: await storeFolder(view.identity) });
    }
    return kept;
  }

  // A change to the app's own workspaces comes from the review page with its write session, as an action does.
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
    try { body = await readJson(request); } catch (error) { sendJson(response, 400, { code: "invalid_request", message: error.message }); return; }
    if (!body || typeof body !== "object" || Array.isArray(body) || (body.confirmEmpty !== undefined && typeof body.confirmEmpty !== "boolean")) {
      sendJson(response, 400, { code: "invalid_request", message: "The request must be a JSON object of url and, optionally, confirmEmpty true or false." });
      return;
    }
    try {
      const { identity, merged } = await added.add(body.url, { confirmEmpty: body.confirmEmpty === true, keptStores, seenUrls: (identity) => workspaces.get(storeWorkspaceId(identity))?.urls ?? [] });
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
      sendJson(response, known ? 409 : 404, known
        ? { code: "workspace_not_added", message: "This workspace was not added from its store URL; it is listed while a checkout of it is registered." }
        : { code: "workspace_unknown", message: "No workspace has that id on this machine." });
      return;
    }
    // The page stops syncing the store's clone before the removal decides whether to delete it.
    await forgetAddedView(id);
    const removed = await added.remove(id, { checkoutsNaming });
    addedUsage.delete(id);
    sendJson(response, 200, { removed: true, clone: removed.clone, message: removed.message });
  }

  const workspaceList = () => listWorkspaces(workspaceViews(), { urlOf: workspaceUrl });

  // The remotes that the store of a workspace registers for each repository, with an empty list for a repository that only a registered checkout names.
  async function repositoryRemotes(view) {
    const remotes = view.kind === "store" ? await registeredRemotes(await storeFolder(view.identity)) : new Map();
    for (const member of membersOf(view)) if (member.repository && !remotes.has(member.repository)) remotes.set(member.repository, []);
    return remotes;
  }

  // Turning a repository's code content on clones its first registered remote, and turning it off deletes the clone; both change only the app's own state on this machine.
  async function setCode(request, response, view, repository) {
    if (refuseChange(request, response)) return;
    let body;
    try { body = await readJson(request); } catch (error) { sendJson(response, 400, { code: "invalid_request", message: error.message }); return; }
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

  // The index names its workspace on every poll, so it reads only the name, never the gate counts and checkouts of the list.
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
    const root = await realpath(projectRoot).catch(() => { throw statusError(400, "The projectRoot does not exist."); });
    if (!(await stat(root)).isDirectory()) {
      throw statusError(400, "The projectRoot must be a directory.");
    }
    const id = projectId(root);
    let project = projects.get(id);
    if (!project) {
      // A new project starts as the most recent, so the recent limit never drops the project being registered.
      project = { id, root, leases: new Map(), lastSeen: ++sequence, workspaceId: null, repository: null, evidenceDirectories: [], intelligenceDirectories: [], recordStoreDirectories: [] };
      projects.set(id, project);
      if (persist) await rememberProjects();
    }
    return project;
  }

  // Grants one browser open while no writable tab of any project is connected and no other open was granted within the open lease.
  // A client that does not declare acceptsGrant opens a tab that can never take a write session, so for it every connected tab counts, as before write sessions.
  function grantOpen(acceptsGrant, now = Date.now()) {
    const connected = acceptsGrant ? writableViewerCount() : viewerCount();
    const open = connected === 0 && now - openGrantedAt >= OPEN_LEASE_MS;
    if (open) openGrantedAt = now;
    return open;
  }

  // Answers whether the presenting session should open a browser, and tells every other project's tabs about the presentation.
  // A browser opens only while no tab of any project is connected, once per lease, so one window serves every project.
  function announce(project, view, url, name, acceptsGrant) {
    const notice = { projectId: project.id, name, projectRoot: project.root, url, at: new Date().toISOString() };
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

  // A project folder that is gone or records that cannot be read give an unknown count rather than a misleading zero.
  async function gateCount(root) {
    if (!(await stat(root).then((info) => info.isDirectory(), () => false))) return null;
    return loadAttention(root).then((attention) => attention.gateCount, () => null);
  }

  async function projectList(current) {
    const now = Date.now();
    const entries = await Promise.all([...projects.values()].map(async (project) => ({
      id: project.id,
      name: path.basename(project.root),
      workspace: await readWorkspaceIdentity(project.root),
      projectRoot: project.root,
      live: live(project, now),
      gates: await gateCount(project.root),
      // Checkouts whose records resolve to one store share their records, so the switcher lists them as one project.
      store: await describeRecordStore(project.root).then(async ({ kind, label, location }) => ({ kind, label, location, workspaceName: kind === "project" ? null : await readWorkspaceName(project.root) })).catch(() => null),
      indexing: (await readIndexingStatus(project.root, intelligenceDirectoriesOf(project)).catch(() => null))?.state ?? null,
      url: workspaceUrl(project.workspaceId),
      lastSeen: project.lastSeen
    })));
    entries.sort((left, right) => Number(right.live) - Number(left.live) || right.lastSeen - left.lastSeen || left.name.localeCompare(right.name));
    return { current, projects: entries.map(({ lastSeen, ...entry }) => entry) };
  }


  // The app's root opens the live workspace used most recently, else the workspace used most recently, else the page without a workspace, which offers to add one.
  async function serveRoot(request, response, prefix) {
    const [chosen] = (await workspaceList()).sort((left, right) => Number(right.live) - Number(left.live));
    if (chosen) {
      response.writeHead(302, { Location: `${prefix}/w/${chosen.id}/`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    await servePageRoute(request, response, "/");
  }

  // An old checkout link opens the checkout's workspace at the same page, and an artifact that it names by the checkout's path keeps its place as its store location.
  async function checkoutRedirect(project, rest, query, prefix) {
    const view = await placeProject(project);
    const kept = new URLSearchParams(query);
    const artifact = kept.get("artifact");
    if (artifact && view.kind === "store") kept.set("artifact", await storeTabRef(project.root, artifact));
    const search = kept.toString();
    return `${prefix}/w/${view.id}${rest}${search ? `?${search}` : ""}`;
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

  // A present answer that tells a presenting process that declared acceptsGrant to open a browser carries the one-time grant that process adds to the URL it opens.
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
      // A present that names no checkout opens the app's root, which opens the workspace used most recently, from any folder.
      if (body.projectRoot === undefined) {
        return withGrant({ url: `http://127.0.0.1:${port}${viewerPrefix()}/`, open: body.open === true && grantOpen(acceptsGrant) }, acceptsGrant);
      }
      const project = await projectFor(body.projectRoot);
      await reportDirectories(project, body);
      const view = await placeProject(project);
      const review = view.review;
      // A session start asks only whether to open a window, and leaves tabs and other projects' notices alone.
      if (body.open === true && body.start === true) {
        await touch(project);
        return withGrant({ url: review.reviewUrl([]), open: grantOpen(acceptsGrant), session: review.getSession() }, acceptsGrant);
      }
      if (body.open === true) {
        const tabs = normalizeTabs(body.tabs);
        const presented = await review.presentTabs(tabs, project.root);
        await touch(project);
        // The link names the presented page as the workspace's session names it, so it opens the same artifact through any checkout.
        const url = review.reviewUrl(tabs.length ? [presented.activeTab] : []);
        return withGrant({ url, open: announce(project, view, url, workspaceLabel(await readWorkspaceIdentity(project.root)), acceptsGrant), session: review.getSession() }, acceptsGrant);
      }
      if (body.tabs !== undefined) {
        await review.setOpenTabs(body.tabs, project.root);
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

  // Control requests must be signed with the control credential and never come from a page, and every answer proves the app knows it.
  async function handleControl(request, response, route) {
    const text = await readBody(request);
    const nonce = request.headers.origin === undefined ? verifyRequest(controlToken, request.headers["x-prism-control"], request.method, request.url, text) : null;
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

  // A request answers a browser, never a tool call, so no store access in it moves a checkout's artifacts, even on a server that a tool call started.
  const server = createServer((request, response) => withFetchlessReads(() => outsideToolCall(async () => {
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
          send(response, 404, "No workspace has that id on this machine.");
          return;
        }
        // The page's own links are relative to its folder, so a workspace's page always ends in a slash.
        if (!inWorkspace[2]) {
          response.writeHead(308, { Location: `${prefix}${route}/${url.search}`, "Cache-Control": "no-store" });
          response.end();
          return;
        }
        const codeSwitch = /^\/api\/code\/([^/]+)$/.exec(inWorkspace[2]);
        if (codeSwitch && request.method === "PUT") {
          await setCode(request, response, view, decodeURIComponent(codeSwitch[1]));
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
          send(response, 404, "Not found");
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
      // The page without a workspace reads only that it has none, and the page's own files, which every page shares.
      if (route === "/api/index" && request.method === "GET") {
        send(response, 200, JSON.stringify({ workspace: null, workspaces: (await workspaceList()).length }), "application/json; charset=utf-8");
        return;
      }
      if (route !== "/review" && await servePageRoute(request, response, route)) return;
      send(response, 404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, error.status ?? 400, error.message);
      }
    }
  })));

  // A successor keeps the port and viewer credential only from a recent handed-off file and only on that same port, so a tab reconnects
  // after a replacement but a credential that a tab may have sent to another listener after a crash or long ago is never served again.
  // Bytes after a request that names no length, such as the body of a DELETE that Node's own client sends unframed, read as a malformed next request.
  // A response still being written for the request before them is finished first, and only then does the connection close, so that request keeps its answer.
  server.on("clientError", (error, socket) => {
    const pending = socket._httpMessage;
    if (pending && !pending.writableFinished && !pending.destroyed) {
      pending.once("close", () => socket.destroy());
      return;
    }
    const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
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
  // Only a successor that reuses the viewer credential accepts the write sessions its predecessor issued; any other start accepts none.
  writeSessions = await createWriteSessions({ directory, restore: bound });
  // A cold restart tries the last bound port, so the browser keeps the origin's permissions and storage, while the viewer credential is always new.
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
  await writeLastPort(directory, port).catch(() => {});

  // The file lists projects most recent first, so a restarted app takes recency from its order.
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
  // Every added workspace has its page from the start, read through a checkout of it or through its store's clone alone.
  for (const entry of added.list()) await addedView(entry).catch(() => null);
  pruneWorkspaces();
  sequence = restored.length;
  const saved = savedProjects();
  persisted = JSON.stringify([saved.roots, saved.directories]);

  published = { protocol: REVIEW_APP_PROTOCOL, port, controlToken, viewerToken, pid: process.pid, pluginVersion, startedAt: new Date().toISOString() };
  await writeDiscovery(directory, published);

  // A losing starter may have overwritten or removed the file, so the owner restores it at each lock renewal.
  async function republish() {
    if (closing || !published) return;
    const current = await readDiscovery(directory);
    if (current?.controlToken !== controlToken) await writeDiscovery(directory, published).catch(() => {});
  }

  const sweep = setInterval(() => {
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
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      // Only the lock holder touches the discovery file, so an app that lost its lock never removes the winner's.
      if (ownsLock) {
        if (handoff) await writeDiscovery(directory, { ...published, handoff: true, handedOffAt: new Date().toISOString() }).catch(() => {});
        else await removeDiscovery(directory, controlToken).catch(() => {});
      }
      releaseLock();
      await lock.released();
    })();
    return closing;
  };

  return { port, instance, viewerUrl: `http://127.0.0.1:${port}${viewerPrefix()}/`, closed: stopped.then(() => closing), close };
}
