import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT } from "../plugin-root.mjs";
import { CHANGE_MAP_FILES, getChangeMap } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { RECORD_DIRECTORY, describeRecordStore, keyOfPath, listRecordStoreConflicts, readRecordStoreConflict, recordPath, recordsUnavailable, recordSyncStatus, resolveRecordFile } from "../workflow/record-store.mjs";
import { readWorkspaceName } from "../workflow/roadmap.mjs";
import { readReviewRunTotals } from "../session/run-totals.mjs";
import { gitFingerprint } from "../repository-intelligence/index-progress.mjs";
import { readIndexingStatus } from "../repository-intelligence/index-status.mjs";
import { nativeSemanticRuntime } from "../repository-intelligence/native-semantic-runtime.mjs";
import { entityContext, entityExists, forgetWorkspace, loadEntity, loadNavigation, parseEntityRef } from "./workspace-model.mjs";
import { applyAction, componentIndexingStatus, listActions, listActionTargets } from "../workflow/actions.mjs";
import { readWorkspaceIdentity } from "./workspace-identity.mjs";
import { createWriteSessions, withWriteGrant } from "./write-sessions.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const VENDOR_DIR = path.join(PLUGIN_ROOT, "vendor", "plantuml");
const VIEWS_DIR = path.join(PUBLIC_DIR, "views");
const TEXT_EXTENSIONS = new Set([".md", ".feature", ".puml", ".json"]);
const EVIDENCE_ARRAY_LIMIT = 200;
// Requests naming any other host are refused, so a DNS-rebinding page cannot reach the server.
const TRUSTED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const VIEWER_HEARTBEAT_MS = 15 * 1000;
const VIEWER_OPEN_RETRY_MS = 10 * 1000;
// The stale hint runs Git in the project, so its answer is reused for this long however often the page asks.
const FRESHNESS_CHECK_MS = 30 * 1000;
// The build code loads only when a page asks for the index state, so a review server starts without the native runtime's modules.
const backgroundPreparation = () => import("../repository-intelligence/background-preparation.mjs");
// An out-of-date index is rebuilt once the files stopped changing for this long, so a burst of edits causes one build, and at most once per gap.
const REBUILD_QUIET_MS = 60 * 1000;
const REBUILD_GAP_MS = 5 * 60 * 1000;

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveProjectFile(projectRoot, requestedPath) {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error("The artifact path must be relative to the project root.");
  }
  // A record path keeps its .prism address and is served from the record store; its containment is checked there.
  const { root, target: candidate } = await resolveRecordFile(projectRoot, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("The artifact path leaves the project root.");
  }
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) {
    throw new Error("The artifact resolves outside the project root.");
  }
  return resolved;
}

function configuredRoots(config) {
  const roots = new Set(["docs"]);
  for (const value of Object.values(config.paths)) {
    if (value) {
      roots.add(path.posix.extname(value) ? path.posix.dirname(value) : value);
    }
  }
  return [...roots].filter((value) => value && value !== ".");
}

async function walkArtifacts(projectRoot, relativeRoot, results) {
  // An unavailable record store or a refused repository name hides only the records, so human documents still list.
  const located = await resolveRecordFile(projectRoot, relativeRoot).catch((error) => { if (recordsUnavailable(error)) return null; throw error; });
  if (!located) {
    return;
  }
  const { root, target: absoluteRoot } = located;
  if (!isInside(root, absoluteRoot)) {
    return;
  }
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) {
      await walkArtifacts(projectRoot, relativePath, results);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.add(relativePath);
    }
  }
}

const SOURCE_SIZE_LIMIT = 512 * 1024;
const SOURCE_CACHE_MS = 2000;
const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$|\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i;
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|pyc|so|dylib|dll|exe|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|sqlite|db)$/i;
const sourceCache = new Map();

function gitListFiles(projectRoot) {
  return new Promise((resolve) => {
    execFile("git", ["-C", projectRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : stdout.split("\0").filter(Boolean));
    });
  });
}

// Source files are shown read-only: tracked or unignored files only, without secrets, binaries, or very large files.
export async function listSourceFiles(projectRoot) {
  const hit = sourceCache.get(projectRoot);
  if (hit && Date.now() - hit.at < SOURCE_CACHE_MS) return hit.value;
  const value = (async () => {
    const files = [];
    for (const file of await gitListFiles(projectRoot)) {
      const name = path.posix.basename(file);
      if (SECRET_NAME.test(name) || BINARY_EXTENSION.test(name)) continue;
      try {
        const metadata = await stat(path.join(projectRoot, file));
        if (metadata.isFile() && metadata.size <= SOURCE_SIZE_LIMIT) files.push(file);
      } catch {
        // A file deleted after git listed it is skipped.
      }
    }
    return files.sort();
  })();
  sourceCache.set(projectRoot, { at: Date.now(), value });
  return value;
}

export async function listArtifacts(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const results = new Set();
  for (const root of configuredRoots(config)) {
    await walkArtifacts(projectRoot, root, results);
  }
  // Machine records live under .prism, which the walk above skips as a hidden folder.
  await walkArtifacts(projectRoot, `${RECORD_DIRECTORY}/initiatives`, results);
  const roadmap = recordPath({ kind: "roadmap" });
  if (await resolveRecordFile(projectRoot, roadmap).then(({ target }) => stat(target)).then((info) => info.isFile(), () => false)) results.add(roadmap);
  return [...results].sort();
}

const SEARCH_FILE_LIMIT = 30;
const SEARCH_LINE_LIMIT = 3;
const SEARCH_SNIPPET = 160;
const SEARCH_SIZE_LIMIT = 1024 * 1024;

function snippet(line, token) {
  const text = line.trim();
  if (text.length <= SEARCH_SNIPPET) return text;
  const start = Math.max(0, text.toLowerCase().indexOf(token) - 40);
  return `${start ? "…" : ""}${text.slice(start, start + SEARCH_SNIPPET)}…`;
}

// Full-text search over the Prism artifacts the review lists, never over source files: every term must occur in a file,
// and files whose lines hold all terms together rank first.
export async function searchArtifacts(projectRoot, query) {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.join("").length < 2) return { query: query ?? "", results: [] };
  const results = [];
  for (const artifactPath of await listArtifacts(projectRoot)) {
    let content;
    try {
      const absolutePath = await resolveProjectFile(projectRoot, artifactPath);
      if ((await stat(absolutePath)).size > SEARCH_SIZE_LIMIT) continue;
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    if (!tokens.every((token) => lower.includes(token))) continue;
    const lines = content.split(/\r?\n/);
    const matches = [];
    let complete = 0;
    lines.forEach((line, index) => {
      const lowerLine = line.toLowerCase();
      const hits = tokens.filter((token) => lowerLine.includes(token)).length;
      if (!hits) return;
      if (hits === tokens.length) complete += 1;
      matches.push({ line: index + 1, text: snippet(line, tokens.find((token) => lowerLine.includes(token))), hits });
    });
    matches.sort((left, right) => right.hits - left.hits || left.line - right.line);
    const pathHit = tokens.every((token) => artifactPath.toLowerCase().includes(token));
    results.push({ path: artifactPath, score: (pathHit ? 1000 : 0) + complete * 10 + matches.length, matches: matches.slice(0, SEARCH_LINE_LIMIT).map(({ line, text }) => ({ line, text })) });
  }
  results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { query, results: results.slice(0, SEARCH_FILE_LIMIT).map(({ score, ...result }) => result) };
}

function linkedDiagramPaths(artifactPath, content) {
  const directory = path.posix.dirname(artifactPath.split(path.sep).join("/"));
  const links = new Set();
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+\.puml)\)/gi)) {
    const target = decodeURIComponent(match[1].split("#")[0]);
    links.add(path.posix.normalize(path.posix.join(directory, target)));
  }
  if (path.extname(artifactPath).toLowerCase() === ".puml") {
    links.add(artifactPath.split(path.sep).join("/"));
  } else {
    links.add(artifactPath.replace(/\.[^.]+$/, ".puml").split(path.sep).join("/"));
  }
  return [...links];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function artifactKind(artifactPath, data) {
  const name = path.posix.basename(artifactPath.split(path.sep).join("/"));
  if (!isRecord(data)) {
    return "json";
  }
  if (CHANGE_MAP_FILES.includes(name) && Array.isArray(data.concepts)) {
    return "change-map";
  }
  if (name === "review.json" && Array.isArray(data.waves) && Array.isArray(data.findings)) {
    return "review-ledger";
  }
  if (name === "state.json" && Number.isInteger(data.schemaVersion) && (Array.isArray(data.active) || isRecord(data.settings))) {
    return "coordination-state";
  }
  return "json";
}

async function loadJsonArtifact(projectRoot, artifactPath, content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return { kind: "json", parseError: error.message };
  }
  const kind = artifactKind(artifactPath, data);
  const result = { kind, data };
  if (kind === "change-map") {
    try {
      const key = await keyOfPath(projectRoot, artifactPath);
      if (key?.kind !== "change-map") throw new Error("Only a slice change map record has a readiness summary.");
      const { concepts, selectedCount, nextOffset, ...summary } = await getChangeMap({ projectRoot, initiative: key.initiative, slice: key.slice, limit: 1 });
      result.summary = summary;
    } catch (error) {
      result.summaryError = error.message;
    }
  }
  if (kind === "review-ledger") {
    const key = await keyOfPath(projectRoot, artifactPath).catch(() => null);
    result.runTotals = key?.kind === "review" ? await readReviewRunTotals(projectRoot, key) : null;
  }
  return result;
}

function truncateArrays(value, location, truncated) {
  if (Array.isArray(value)) {
    if (value.length > EVIDENCE_ARRAY_LIMIT) {
      truncated[location || "/"] = value.length;
    }
    return value.slice(0, EVIDENCE_ARRAY_LIMIT).map((item, index) => truncateArrays(item, `${location}/${index}`, truncated));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateArrays(item, `${location}/${key}`, truncated)]));
  }
  return value;
}

export async function loadEvidence(projectRoot, evidenceId, store = conservationStore) {
  if (typeof evidenceId !== "string" || !/^[a-f0-9]{64}$/.test(evidenceId)) {
    throw new Error("The evidence ID must be a 64-character lowercase hexadecimal digest.");
  }
  const truncated = {};
  const record = truncateArrays(await store.get(projectRoot, evidenceId), "", truncated);
  return { id: evidenceId, kind: record.kind, record, truncated, arrayLimit: EVIDENCE_ARRAY_LIMIT };
}

export async function loadArtifact(projectRoot, artifactPath) {
  const absolutePath = await resolveProjectFile(projectRoot, artifactPath);
  if (!TEXT_EXTENSIONS.has(path.extname(artifactPath).toLowerCase())) {
    const bytes = await readFile(absolutePath);
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("The file is binary and cannot be shown.");
    const metadata = await stat(absolutePath);
    return { path: artifactPath, kind: "source", content: bytes.toString("utf8"), diagrams: [], modifiedAt: metadata.mtimeMs };
  }
  const content = await readFile(absolutePath, "utf8");
  if (path.extname(artifactPath).toLowerCase() === ".json") {
    const metadata = await stat(absolutePath);
    return { path: artifactPath, content, diagrams: [], modifiedAt: metadata.mtimeMs, ...(await loadJsonArtifact(projectRoot, artifactPath, content)) };
  }
  const diagrams = [];
  for (const diagramPath of linkedDiagramPaths(artifactPath, content)) {
    try {
      const diagramFile = await resolveProjectFile(projectRoot, diagramPath);
      diagrams.push({ path: diagramPath, source: await readFile(diagramFile, "utf8") });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const metadata = await stat(absolutePath);
  return { path: artifactPath, content, diagrams, modifiedAt: metadata.mtimeMs };
}

export function isTrustedHost(host) {
  try {
    return TRUSTED_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function send(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

async function serveFile(response, filePath, contentType) {
  try {
    send(response, 200, await readFile(filePath), contentType);
  } catch (error) {
    if (error.code === "ENOENT") {
      send(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

export function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The open tabs whose file the review no longer lists, or whose entity no longer resolves, in tab order. */
export async function findMissingTabs(tabs, available, entityResolves) {
  const missing = [];
  for (const tab of tabs) {
    if (parseEntityRef(tab) ? !(await entityResolves(tab)) : !available.has(tab)) missing.push(tab);
  }
  return missing;
}

/** Each tab on a record that Prism moved from a legacy location, mapped to the record's current path by the record store's own mapping. */
export async function movedRecordTabs(projectRoot, tabs, available) {
  const moves = new Map();
  for (const tab of tabs) {
    if (available.has(tab) || parseEntityRef(tab)) continue;
    const key = await keyOfPath(projectRoot, tab).catch(() => null);
    if (!key || key.kind === "runs") continue;
    const target = recordPath(key);
    if (target !== tab && available.has(target)) moves.set(tab, target);
  }
  return moves;
}

export function normalizeTabs(value) {
  if (value === undefined) {
    return [];
  }
  const tabs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(tabs) || tabs.some((tab) => typeof tab !== "string" || !tab)) {
    throw new Error("The open tabs must be an array of project-relative artifact paths.");
  }
  return [...new Set(tabs)];
}

// Reads a request body of at most 64 KiB as text; the review app needs the exact text because control requests sign it.
export async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("The request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A refusal of the action registry answers with its status and a JSON body of its code, message, and the fields that refusal carries.
const ACTION_STATUS = { unknown_target: 404, unknown_action: 404, stale_revision: 409, action_unavailable: 409, confirmation_required: 409, invalid_input: 400 };
const ACTION_FIELDS = ["current", "reason", "field", "accepted"];
export const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";

function sendJson(response, statusCode, body) {
  send(response, statusCode, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendActionError(response, error) {
  const status = ACTION_STATUS[error.code];
  if (!status) throw error;
  sendJson(response, status, { code: error.code, message: error.message, ...Object.fromEntries(ACTION_FIELDS.filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) });
}

// A write comes from the review page itself: JSON, and an Origin, when the browser sends one, of the same host.
function fromPage(request) {
  const origin = request.headers.origin;
  if (String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return false;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const text = await readBody(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The request body must be JSON.");
  }
}

// One project's review context: its tab session, viewer streams, and routes, shared by the session server and the review app.
// onViewer(send) runs when a viewer stream opens, after its first session event, and send writes a named event to that viewer only.
// writeSessions is the write session store of the server or app that serves this page; without one, no request can write.
export function createProjectReview({ projectRoot, baseUrl, instance = null, appVersion = null, onViewer = null, evidenceStore = () => conservationStore, intelligenceDirectories = () => [nativeSemanticRuntime.directory], privateServer = null, writeSessions = null,
  rebuildIndex = (root, component) => backgroundPreparation().then((module) => module.startIndexRebuild(root, component ? { component: { identity: component.identity, folder: component.folder } } : {})), autoRebuild = (root) => backgroundPreparation().then((module) => module.backgroundIndexingEnabled(root)), rebuildTiming = { quietMs: REBUILD_QUIET_MS, gapMs: REBUILD_GAP_MS, freshnessMs: FRESHNESS_CHECK_MS } }) {
  let fingerprint = null;
  function currentFingerprint() {
    if (!fingerprint || Date.now() - fingerprint.at >= rebuildTiming.freshnessMs) fingerprint = { at: Date.now(), value: gitFingerprint(projectRoot).catch(() => null) };
    return fingerprint.value;
  }
  // The index chip polls while a page is open, so an out-of-date index is rebuilt only while someone looks at the project.
  const rebuild = { key: null, changedAt: Date.now(), startedAt: 0 };
  async function indexingStatus() {
    const status = await readIndexingStatus(projectRoot, intelligenceDirectories(), { fingerprint: currentFingerprint });
    const auto = await autoRebuild(projectRoot).catch(() => false);
    const print = await currentFingerprint();
    const key = print ? `${print.head}\0${print.worktree}` : null;
    if (key !== rebuild.key) Object.assign(rebuild, { key, changedAt: Date.now() });
    // With components, any component's stale index starts the rebuild, which also retries the components whose latest preparation failed.
    const outOfDate = (status.stale === true && (status.state === "ready" || (status.components !== undefined && status.state !== "preparing")))
      || (status.state === "failed" && status.diagnostics.some((item) => item.code === "stale_snapshot"));
    const now = Date.now();
    if (auto && outOfDate && now - rebuild.changedAt >= rebuildTiming.quietMs && now - rebuild.startedAt >= rebuildTiming.gapMs) {
      rebuild.startedAt = now;
      void rebuildIndex(projectRoot);
    }
    return { ...status, autoRebuild: auto };
  }
  // The registry's indexer serves each component's own index: with declared components, a target shows its component's entry in the status, or none
  // while that component has neither an index nor a preparation, and without them the root target shows the checkout's one index.
  // A person's request rebuilds only its own component, starts at once, and ignores the background opt-out, because it is not in the background.
  const indexer = {
    status: async (_root, component) => componentIndexingStatus(await indexingStatus(), component),
    rebuild: (root, component) => {
      rebuild.startedAt = Date.now();
      Promise.resolve(rebuildIndex(root, component)).catch(() => {});
    }
  };
  let session = { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], revision: 0 };
  // Each viewer stream maps to its heartbeat and whether it carries a live write session; only writable streams count as connected tabs.
  const viewers = new Map();
  let viewerOpenLease = null;
  const canWrite = (token) => Boolean(writeSessions?.valid(token));
  const writableRequest = (request) => canWrite(request.headers["x-prism-write"]);

  function sessionSnapshot() {
    const snapshot = { openTabs: [...session.openTabs], activeTab: session.activeTab, previewTab: session.previewTab, agentTabs: [...session.agentTabs], revision: session.revision };
    return instance ? { ...snapshot, instance, ...(appVersion ? { appVersion } : {}) } : snapshot;
  }

  function clearViewerOpenLease() {
    if (viewerOpenLease) {
      clearTimeout(viewerOpenLease);
      viewerOpenLease = null;
    }
  }

  function armViewerOpenLease() {
    clearViewerOpenLease();
    viewerOpenLease = setTimeout(() => {
      viewerOpenLease = null;
    }, VIEWER_OPEN_RETRY_MS);
    viewerOpenLease.unref();
  }

  function writeEvent(response, event, data) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function removeViewer(response) {
    const viewer = viewers.get(response);
    if (!viewer) {
      return;
    }
    clearInterval(viewer.heartbeat);
    viewers.delete(response);
  }

  function notify(event, data) {
    for (const response of viewers.keys()) {
      try {
        writeEvent(response, event, data);
      } catch {
        removeViewer(response);
        response.destroy();
      }
    }
  }

  function openViewerStream(response, writable) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.flushHeaders();
    const heartbeat = setInterval(() => {
      try {
        response.write(": keep-alive\n\n");
      } catch {
        removeViewer(response);
        response.destroy();
      }
    }, VIEWER_HEARTBEAT_MS);
    heartbeat.unref();
    viewers.set(response, { heartbeat, writable });
    response.once("close", () => removeViewer(response));
    if (writable) clearViewerOpenLease();
    writeEvent(response, "session", sessionSnapshot());
    onViewer?.((event, data) => writeEvent(response, event, data));
  }

  function writableViewerCount() {
    let count = 0;
    for (const viewer of viewers.values()) if (viewer.writable) count += 1;
    return count;
  }

  async function reviewableFiles() {
    return new Set([...await listArtifacts(projectRoot), ...await listSourceFiles(projectRoot)]);
  }

  async function assertAvailable(tabs, availableArtifacts) {
    for (const tab of tabs) {
      if (!availableArtifacts.has(tab) && !(parseEntityRef(tab) && await entityExists(projectRoot, tab))) {
        throw new Error(`The artifact is not available for review: ${tab}`);
      }
    }
  }

  // A tab on a record that Prism moved out of its legacy location follows the record to where it now lives.
  async function followMovedRecords(available) {
    const moves = await movedRecordTabs(projectRoot, session.openTabs, available);
    if (!moves.size) return sessionSnapshot();
    const follow = (tab) => moves.get(tab) ?? tab;
    const agentTabs = [...new Set(session.agentTabs.map(follow))];
    const previewTab = session.previewTab && follow(session.previewTab);
    return commitSession({ openTabs: [...new Set(session.openTabs.map(follow))], activeTab: session.activeTab && follow(session.activeTab), previewTab: agentTabs.includes(previewTab) ? null : previewTab, agentTabs });
  }

  // Reading the session first lets moved records' tabs follow them, so every reader sees the records where they now live.
  async function currentSession() {
    return followMovedRecords(await reviewableFiles());
  }

  function commitSession(next) {
    const changed = ["openTabs", "agentTabs"].some((key) => next[key].length !== session[key].length || next[key].some((tab, index) => tab !== session[key][index]))
      || next.activeTab !== session.activeTab || next.previewTab !== session.previewTab;
    if (changed) {
      session = { ...next, revision: session.revision + 1 };
      notify("session", sessionSnapshot());
    }
    return sessionSnapshot();
  }

  // The browser owns the preview tab: one replaceable tab for browsing, while kept and agent tabs stay open.
  async function updateSession(request) {
    const available = await reviewableFiles();
    await followMovedRecords(available);
    // A page that has not yet seen a record move still names its old path, which follows the record the same way.
    const moves = await movedRecordTabs(projectRoot, normalizeTabs(request.openTabs), available);
    const follow = (tab) => typeof tab === "string" ? moves.get(tab) ?? tab : tab;
    const body = { ...request, openTabs: [...new Set(normalizeTabs(request.openTabs).map(follow))] };
    for (const key of ["activeTab", "previewTab"]) if (Object.hasOwn(request, key)) body[key] = follow(request[key]);
    if (Object.hasOwn(request, "agentTabs")) body.agentTabs = [...new Set(normalizeTabs(request.agentTabs).map(follow))];
    const requestedTabs = body.openTabs;
    // A tab that is already open may name a file that is gone, so the page can keep it open and offer to close it.
    await assertAvailable(requestedTabs.filter((tab) => !session.openTabs.includes(tab)), available);
    let nextActiveTab;
    if (Object.hasOwn(body, "activeTab")) {
      if (body.activeTab !== null && (typeof body.activeTab !== "string" || !requestedTabs.includes(body.activeTab))) {
        throw new Error("The active tab must be null or one of the open tabs.");
      }
      nextActiveTab = body.activeTab;
    } else {
      nextActiveTab = session.activeTab && requestedTabs.includes(session.activeTab) ? session.activeTab : requestedTabs[0] ?? null;
    }
    let previewTab = session.previewTab && requestedTabs.includes(session.previewTab) ? session.previewTab : null;
    if (Object.hasOwn(body, "previewTab")) {
      if (body.previewTab !== null && (typeof body.previewTab !== "string" || !requestedTabs.includes(body.previewTab))) {
        throw new Error("The preview tab must be null or one of the open tabs.");
      }
      previewTab = body.previewTab;
    }
    let agentTabs = session.agentTabs.filter((tab) => requestedTabs.includes(tab));
    if (Object.hasOwn(body, "agentTabs")) {
      const requestedAgentTabs = normalizeTabs(body.agentTabs);
      if (requestedAgentTabs.some((tab) => !requestedTabs.includes(tab))) {
        throw new Error("Agent tabs must be open tabs.");
      }
      agentTabs = requestedAgentTabs;
    }
    if (requestedTabs.length === 0) {
      nextActiveTab = null;
    }
    return commitSession({ openTabs: requestedTabs, activeTab: nextActiveTab, previewTab: agentTabs.includes(previewTab) ? null : previewTab, agentTabs });
  }

  // get_review_url adds tabs the same way present_review does, so neither tool closes the human's tabs.
  async function setOpenTabs(tabs) {
    return (await presentTabs(tabs)).openTabs;
  }

  // present_review adds agent tabs beside the human's tabs and focuses the first one without replacing the preview.
  async function presentTabs(tabs) {
    const requestedTabs = normalizeTabs(tabs);
    const available = await reviewableFiles();
    await assertAvailable(requestedTabs, available);
    await followMovedRecords(available);
    if (requestedTabs.length === 0) {
      if (session.openTabs.includes("attention")) {
        return commitSession({ ...session, activeTab: "attention" });
      }
      // Attention opens in the preview tab, replacing whatever the preview showed.
      const openTabs = [...session.openTabs.filter((tab) => tab !== session.previewTab), "attention"];
      return commitSession({ openTabs, activeTab: "attention", previewTab: "attention", agentTabs: session.agentTabs });
    }
    const openTabs = [...session.openTabs, ...requestedTabs.filter((tab) => !session.openTabs.includes(tab))];
    const agentTabs = [...session.agentTabs, ...requestedTabs.filter((tab) => !session.agentTabs.includes(tab))];
    const previewTab = requestedTabs.includes(session.previewTab) ? null : session.previewTab;
    return commitSession({ openTabs, activeTab: requestedTabs[0], previewTab, agentTabs });
  }

  function closeViewerStreams() {
    clearViewerOpenLease();
    for (const response of viewers.keys()) {
      removeViewer(response);
      response.end();
    }
  }

  async function handle(request, response, route, url) {
    if (route === "/" || route === "/review") {
      await serveFile(response, path.join(PUBLIC_DIR, "review.html"), "text/html; charset=utf-8");
    } else if (route === "/review.js") {
      await serveFile(response, path.join(PUBLIC_DIR, "review.js"), "text/javascript; charset=utf-8");
    } else if (route === "/review.css") {
      await serveFile(response, path.join(PUBLIC_DIR, "review.css"), "text/css; charset=utf-8");
    } else if (route === "/favicon.svg" || route === "/prism-mark.svg") {
      await serveFile(response, path.join(PUBLIC_DIR, route.slice(1)), "image/svg+xml");
    } else if (route === "/vendor/plantuml.js") {
      await serveFile(response, path.join(VENDOR_DIR, "plantuml.js"), "text/javascript; charset=utf-8");
    } else if (route === "/vendor/viz-global.js") {
      await serveFile(response, path.join(VENDOR_DIR, "viz-global.js"), "text/javascript; charset=utf-8");
    } else if (route === "/c4.min.js" || route === "/vendor/c4.min.js") {
      await serveFile(response, path.join(VENDOR_DIR, "c4.min.js"), "text/javascript; charset=utf-8");
    } else if (/^\/views\/[a-z][a-z-]*\.js$/.test(route)) {
      await serveFile(response, path.join(VIEWS_DIR, route.slice("/views/".length)), "text/javascript; charset=utf-8");
    } else if (route === "/api/events" && request.method === "GET") {
      openViewerStream(response, canWrite(url.searchParams.get("write")));
    } else if (route === "/api/index") {
      const artifacts = await listArtifacts(projectRoot), sources = await listSourceFiles(projectRoot);
      const available = new Set([...artifacts, ...sources]);
      const snapshot = await followMovedRecords(available);
      const missingTabs = await findMissingTabs(snapshot.openTabs, available, (ref) => entityExists(projectRoot, ref));
      send(response, 200, JSON.stringify({ projectRoot, workspace: await readWorkspaceIdentity(projectRoot), artifacts, sources, navigation: await loadNavigation(projectRoot), recordStore: await describeRecordStore(projectRoot).then(async (store) => ({ ...store, workspaceName: store.kind === "project" ? null : await readWorkspaceName(projectRoot) })).catch(() => null), storeSync: await recordSyncStatus(projectRoot), ...snapshot, missingTabs, ...(privateServer ? { privateServer } : {}) }), "application/json; charset=utf-8");
    } else if (route === "/api/store/conflicts" && request.method === "GET") {
      // Saved local record versions are read-only here; a person redoes a lost change through an agent.
      send(response, 200, JSON.stringify({ conflicts: await listRecordStoreConflicts(projectRoot).catch(() => []) }), "application/json; charset=utf-8");
    } else if (route === "/api/store/conflict" && request.method === "GET") {
      const conflict = await readRecordStoreConflict(projectRoot, url.searchParams.get("savedAs")).catch(() => null);
      if (conflict) send(response, 200, JSON.stringify(conflict), "application/json; charset=utf-8");
      else send(response, 404, "No saved conflict has that name.");
    } else if (route === "/api/session" && request.method === "GET") {
      send(response, 200, JSON.stringify(await currentSession()), "application/json; charset=utf-8");
    } else if (route === "/api/session" && request.method === "PUT") {
      const body = await readJson(request);
      send(response, 200, JSON.stringify(await updateSession(body)), "application/json; charset=utf-8");
    } else if (route === "/api/actions" && request.method === "GET") {
      try {
        const listed = await listActions({ projectRoot, target: url.searchParams.get("target"), indexer });
        sendJson(response, 200, { target: listed.target, writable: writableRequest(request), actions: listed.actions });
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/actions/targets" && request.method === "GET") {
      try {
        sendJson(response, 200, await listActionTargets({ projectRoot, kind: url.searchParams.get("kind") }));
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/actions/apply" && request.method === "POST") {
      if (!fromPage(request)) {
        sendJson(response, 403, { code: "origin_refused", message: "A change must come from the review page as JSON." });
        return;
      }
      if (!writableRequest(request)) {
        sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
        return;
      }
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(response, 400, { code: "invalid_request", message: "The request must be a JSON object of action, target, input, and revision." });
        return;
      }
      try {
        const result = await applyAction({ projectRoot, target: body.target, action: body.action, input: body.input, revision: body.revision, confirmed: body.confirmed, via: "review-app", indexer });
        if (result.applied) forgetWorkspace();
        sendJson(response, 200, result);
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/write-session" && request.method === "POST") {
      // A tab that Prism opened exchanges the one-time grant of its URL fragment for the write session it keeps.
      if (!fromPage(request)) {
        sendJson(response, 403, { code: "origin_refused", message: "A write session must be requested by the review page as JSON." });
        return;
      }
      const body = await readJson(request);
      const token = await writeSessions?.exchange(body?.grant) ?? null;
      if (!token) {
        sendJson(response, 403, { code: "grant_refused", message: "The grant was already used, has expired, or was not issued here. Ask the agent to present the review, or run prism review." });
        return;
      }
      sendJson(response, 200, { token });
    } else if (route === "/api/context") {
      send(response, 200, JSON.stringify(await entityContext(projectRoot, url.searchParams.get("ref"))), "application/json; charset=utf-8");
    } else if (route === "/api/entity") {
      const ref = url.searchParams.get("ref");
      if (["initiative", "slice"].includes(parseEntityRef(ref)?.kind) && !(await entityExists(projectRoot, ref))) {
        send(response, 404, "The item no longer exists in this project.");
        return;
      }
      send(response, 200, JSON.stringify(await loadEntity(projectRoot, ref, { intelligenceDirectories: intelligenceDirectories() })), "application/json; charset=utf-8");
    } else if (route === "/api/evidence") {
      send(response, 200, JSON.stringify(await loadEvidence(projectRoot, url.searchParams.get("id"), evidenceStore())), "application/json; charset=utf-8");
    } else if (route === "/api/indexing" && request.method === "GET") {
      send(response, 200, JSON.stringify(await indexingStatus()), "application/json; charset=utf-8");
    } else if (route === "/api/search") {
      send(response, 200, JSON.stringify(await searchArtifacts(projectRoot, url.searchParams.get("q"))), "application/json; charset=utf-8");
    } else if (route === "/api/artifact") {
      const artifactPath = url.searchParams.get("path");
      // Only listed documents and filtered source files are served, never an arbitrary project path such as .env.
      // A path that leaves the project still fails here, while a moved or deleted file answers 404 below.
      await resolveProjectFile(projectRoot, artifactPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!(await listArtifacts(projectRoot)).includes(artifactPath) && !(await listSourceFiles(projectRoot)).includes(artifactPath)) {
        send(response, 404, "The file is not available for review.");
        return;
      }
      let loaded;
      try {
        loaded = await loadArtifact(projectRoot, artifactPath);
      } catch (error) {
        // A file deleted after the listing above answers the same as an unlisted one.
        if (error.code !== "ENOENT") throw error;
        send(response, 404, "The file is not available for review.");
        return;
      }
      send(response, 200, JSON.stringify(loaded), "application/json; charset=utf-8");
    } else {
      send(response, 404, "Not found");
    }
  }

  return {
    baseUrl,
    projectRoot,
    handle,
    getOpenTabs() {
      return [...session.openTabs];
    },
    getSession() {
      return sessionSnapshot();
    },
    currentSession,
    viewerCount() {
      return viewers.size;
    },
    writableViewerCount,
    notify,
    setOpenTabs,
    presentTabs,
    reviewUrl(artifactPaths) {
      const [activeTab] = normalizeTabs(artifactPaths);
      return activeTab ? `${baseUrl}/review?artifact=${encodeURIComponent(activeTab)}` : `${baseUrl}/`;
    },
    // A browser opens only while no writable tab watches this project, and once per lease so a slow first load does not open a second tab.
    claimBrowserOpen() {
      if (writableViewerCount() > 0 || viewerOpenLease) {
        return false;
      }
      armViewerOpenLease();
      return true;
    },
    releaseBrowserOpen: clearViewerOpenLease,
    closeViewers: closeViewerStreams
  };
}

export async function startReviewServer(options = {}) {
  const browserOpener = options.openBrowser ?? openBrowser;
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? process.cwd()));
  // The workspace cache is shared by the process, so a new server starts from the records as they are, not as an earlier server read them within the cache window.
  forgetWorkspace();
  const token = randomBytes(24).toString("base64url");
  const prefix = `/session/${token}`;
  let review;
  const server = createServer(async (request, response) => {
    try {
      if (!isTrustedHost(request.headers.host)) {
        send(response, 403, "Unknown host");
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) {
        send(response, 404, "Not found");
        return;
      }
      await review.handle(request, response, url.pathname.slice(prefix.length) || "/", url);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, 400, error.message);
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}${prefix}`;
  const writeSessions = await createWriteSessions();
  review = createProjectReview({ projectRoot, baseUrl, writeSessions, ...(options.privateServer ? { privateServer: options.privateServer } : {}), ...(options.rebuildIndex ? { rebuildIndex: options.rebuildIndex } : {}) });
  return {
    baseUrl,
    projectRoot,
    getOpenTabs: review.getOpenTabs,
    getSession: review.getSession,
    viewerCount: review.viewerCount,
    setOpenTabs: review.setOpenTabs,
    reviewUrl: review.reviewUrl,
    async open(artifactPaths) {
      const tabs = normalizeTabs(artifactPaths);
      await review.presentTabs(tabs);
      const url = review.reviewUrl(tabs);
      if (!review.claimBrowserOpen()) {
        return { url, opened: false, ...review.getSession() };
      }
      // Only the browser Prism opens receives a grant, in the fragment; the URL this answers carries none.
      const opened = Boolean(await browserOpener(withWriteGrant(url, writeSessions.issueGrant())));
      if (!opened) {
        review.releaseBrowserOpen();
      }
      return { url, opened, ...review.getSession() };
    },
    close() {
      review.closeViewers();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
