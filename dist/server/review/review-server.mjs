// Generated from src/server/review/review-server.mts by scripts/native-build/compile.mjs.
import { createServer } from "node:http";
import { arrangeGroups, GROUP_LIMIT, groupNameOf, joinGroup, openerOf } from "./public/views/tab-groups.js";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT, pluginVersion } from "../plugin-root.mjs";
import { CHANGE_MAP_FILES, getChangeMap } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { listComponents } from "../workflow/components.mjs";
import { artifactKinds, parseWorkflowConfig, readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { RECORD_DIRECTORY, artifactPathTest, artifactsInCheckout, describeRecordStore, inArtifactStore, isStoreWithoutCheckout, outsideToolCall, keyOfPath, recordStoreOf, listRecordStoreConflicts, listStoreArtifacts, readRecordStoreConflict, recordPath, recordsUnavailable, recordSyncStatus, resolveRecordFile, withRecordReads } from "../workflow/record-store.mjs";
import { artifactStoreLocation, readStoreArtifact, readStoreArtifactAt, reviewStoreArtifact, reviewStoreArtifactAt, storeArtifactLocation, workspaceArtifacts } from "../workflow/store-artifacts.mjs";
import { codeRefOf, parseCodeRef, resolveLinks } from "./artifact-links.mjs";
import { checkoutsOnMachine, knownComponents, registeredRepositories } from "./workspaces.mjs";
import { withoutCredentials } from "../workflow/remote-url.mjs";
import { readWorkspaceName } from "../workflow/roadmap.mjs";
import { readReviewRunTotals } from "../session/run-totals.mjs";
import { gitFingerprint } from "../repository-intelligence/index-progress.mjs";
import { readIndexingStatus } from "../repository-intelligence/index-status.mjs";
import { nativeSemanticRuntime } from "../repository-intelligence/native-semantic-runtime.mjs";
import { asWorkspaceView, entityContext, entityExists, forgetWorkspace, rememberView, viewVersion, viewWatching, loadAttention, loadClaims, loadDeclaredView, loadFormatMark, loadHeldClaims, loadEntity, loadNavigation, loadRecordChanges, parseEntityRef, searchRecords, slicePresence } from "./workspace-model.mjs";
import { shippedCommit, sliceFiles } from "./slice-files.mjs";
import { frozenTestFile, verificationLog } from "./verification-view.mjs";
import { TouchedError, touchedRecords } from "./touched-records.mjs";
import { applyAction, componentIndexingStatus, listActions, listActionTargets, parseTarget } from "../workflow/actions.mjs";
import { archiveEndedLaunches, archiveLaunch, listLaunches, unarchiveLaunch } from "../session/launched-sessions.mjs";
import { readRunOptions, runOptionsQuery } from "../session/run-options.mjs";
import { listAgents } from "./agents.mjs";
import { listCodingAgents } from "../session/coding-agents.mjs";
import { readWorkspaceIdentity } from "./workspace-identity.mjs";
import { readStoredPreferences, writePreferences } from "./review-preferences.mjs";
import { PersonalSettingsError, readPersonalSettings, updatePersonalSettings } from "../workflow/personal-settings.mjs";
import { createWriteSessions, withWriteGrant } from "./write-sessions.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { createViewerHub, openEventStream, writeEvent } from "./viewer-hub.mjs";
import { createCachedValue } from "./cached-value.mjs";
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const VENDOR_DIR = path.join(PLUGIN_ROOT, "vendor", "plantuml");
const VIEWS_DIR = path.join(PUBLIC_DIR, "views");
const KIT_DIR = path.join(PUBLIC_DIR, "kit");
const ASSET_TYPES = /* @__PURE__ */ new Map([[".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".html", "text/html; charset=utf-8"], [".txt", "text/plain; charset=utf-8"], [".woff2", "font/woff2"]]);
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".feature", ".puml", ".json"]);
const EVIDENCE_ARRAY_LIMIT = 200;
const TRUSTED_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
const VIEWER_OPEN_RETRY_MS = 10 * 1e3;
const FRESHNESS_CHECK_MS = 30 * 1e3;
const RECORDS_CHECK_MS = 1e3;
const backgroundPreparation = () => import("../repository-intelligence/background-preparation.mjs");
const REBUILD_QUIET_MS = 60 * 1e3;
const REBUILD_GAP_MS = 5 * 60 * 1e3;
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function servableFrom(root, resolved) {
  return isInside(root, resolved) && !path.relative(root, resolved).split(path.sep).some((segment) => segment.toLowerCase() === ".git");
}
async function resolveProjectFile(projectRoot, requestedPath) {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error("The artifact path must be relative to the project root.");
  }
  const { root, target: candidate } = await resolveRecordFile(projectRoot, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("The artifact path leaves the project root.");
  }
  const resolved = await realpath(candidate);
  if (!servableFrom(root, resolved)) {
    throw new Error("The artifact resolves outside the project root or into its Git folder.");
  }
  return resolved;
}
function configuredRoots(config) {
  const roots = /* @__PURE__ */ new Set(["docs"]);
  for (const value of Object.values(config.paths)) {
    if (value) {
      roots.add(path.posix.extname(value) ? path.posix.dirname(value) : value);
    }
  }
  return [...roots].filter((value) => value && value !== ".");
}
async function walkArtifacts(projectRoot, relativeRoot, results) {
  const located = await resolveRecordFile(projectRoot, relativeRoot).catch((error) => {
    if (recordsUnavailable(error)) return null;
    throw error;
  });
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
const SOURCE_CHECKS = 8;
const LISTING_MIN_MS = 5e3;
const LISTING_FACTOR = 5;
const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$|\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i;
const secretPath = (file) => SECRET_NAME.test(path.posix.basename(String(file)));
const binaryPath = (file) => BINARY_EXTENSION.test(path.posix.basename(String(file)));
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|pyc|so|dylib|dll|exe|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|sqlite|db)$/i;
function gitListFiles(projectRoot) {
  return new Promise((resolve) => {
    execFile("git", ["-C", projectRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : stdout.split("\0").filter(Boolean));
    });
  });
}
async function listSourceFiles(projectRoot) {
  const candidates = (await gitListFiles(projectRoot)).filter((file) => {
    const name = path.posix.basename(file);
    return !SECRET_NAME.test(name) && !BINARY_EXTENSION.test(name);
  });
  const files = [];
  const root = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  let next = 0;
  const check = async () => {
    while (next < candidates.length) {
      const file = candidates[next++];
      try {
        const absolute = path.join(projectRoot, file);
        if ((await lstat(absolute)).isSymbolicLink() && !servableFrom(root, await realpath(absolute))) continue;
        const metadata = await stat(absolute);
        if (metadata.isFile() && metadata.size <= SOURCE_SIZE_LIMIT) files.push(file);
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: SOURCE_CHECKS }, check));
  return files.sort();
}
const listings = /* @__PURE__ */ new Map();
function reviewListing(projectRoot) {
  let listing = listings.get(projectRoot);
  if (!listing) {
    listing = createCachedValue(async () => {
      const [artifacts, sources] = await Promise.all([listCheckoutArtifacts(projectRoot), listReviewSources(projectRoot)]);
      return { artifacts, sources };
    }, { ttlMs: (ms) => Math.max(LISTING_MIN_MS, LISTING_FACTOR * ms) });
    listings.set(projectRoot, listing);
  }
  return listing;
}
async function listedFiles(projectRoot, wanted = []) {
  const listing = reviewListing(projectRoot);
  let value = await listing.get();
  const isArtifact = await artifactPathTest(projectRoot);
  const files = wanted.filter((file) => typeof file === "string" && file !== "attention" && !parseEntityRef(file) && !isArtifact(file));
  const listed = (file) => value.artifacts.includes(file) || value.sources.includes(file);
  const present = await Promise.all(files.map((file) => stat(path.join(projectRoot, file)).then((info) => info.isFile(), () => false)));
  if (files.some((file, index) => listed(file) !== present[index])) {
    listing.invalidate();
    value = await listing.get();
  }
  return { artifacts: await withStoreArtifacts(projectRoot, value.artifacts), sources: value.sources };
}
async function storeArtifactEntries(projectRoot) {
  return rememberView(projectRoot, "store-artifacts", () => listStoreArtifacts(projectRoot).catch((error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return [];
    throw error;
  }));
}
async function artifactStoreRefusal(projectRoot) {
  return (await describeRecordStore(projectRoot).catch(() => null))?.unavailable ?? null;
}
async function checkoutArtifactsOf(projectRoot, store) {
  if (store.kind === "project" || store.unavailable) return {};
  return artifactsInCheckout(projectRoot);
}
async function listReviewSources(projectRoot) {
  const isArtifact = await artifactPathTest(projectRoot);
  return (await listSourceFiles(projectRoot)).filter((file) => !isArtifact(file));
}
async function storeArtifactRefs(projectRoot) {
  return rememberView(projectRoot, "store-artifact-refs", () => computeStoreArtifactRefs(projectRoot));
}
async function computeStoreArtifactRefs(projectRoot) {
  const refs = {};
  for (const entry of await storeArtifactEntries(projectRoot) ?? []) {
    if (Object.hasOwn(refs, entry.path)) continue;
    const location = await artifactStoreLocation(projectRoot, entry).catch(() => null);
    if (location) refs[entry.path] = `store:${location}`;
  }
  return refs;
}
async function storeTabRef(projectRoot, tab) {
  if (typeof tab !== "string" || tab.startsWith("store:") || parseEntityRef(tab) || !await inArtifactStore(projectRoot, tab).catch(() => false)) return tab;
  const found = await storeArtifactLocation(projectRoot, tab).catch(() => null);
  return found ? `store:${found.location}` : tab;
}
async function listArtifactScopes(projectRoot) {
  const scopes = {};
  for (const entry of await storeArtifactEntries(projectRoot) ?? []) scopes[entry.path] ??= entry.scope.label;
  return scopes;
}
async function listArtifacts(projectRoot) {
  return withStoreArtifacts(projectRoot, await listCheckoutArtifacts(projectRoot));
}
async function listCheckoutArtifacts(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const results = /* @__PURE__ */ new Set();
  for (const root of configuredRoots(config)) {
    await walkArtifacts(projectRoot, root, results);
  }
  const isArtifact = await artifactPathTest(projectRoot);
  for (const file of [...results]) if (isArtifact(file)) results.delete(file);
  await walkArtifacts(projectRoot, `${RECORD_DIRECTORY}/initiatives`, results);
  const roadmap = recordPath({ kind: "roadmap" });
  if (await resolveRecordFile(projectRoot, roadmap).then(({ target }) => stat(target)).then((info) => info.isFile(), () => false)) results.add(roadmap);
  return [...results].sort();
}
const STORE_REF = "store:";
const storeRefOf = (location) => `${STORE_REF}${location}`;
async function workspaceStoreArtifacts(projectRoot) {
  return rememberView(projectRoot, "workspace-store-artifacts", () => workspaceArtifacts(projectRoot).catch((error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }));
}
const scopePrefix = (scope) => scope.kind === "workspace" ? "" : scope.kind === "repository" ? `repositories/${scope.repository}/` : `repositories/${scope.repository}/components/${scope.component}/`;
const byScope = (left, right) => left.kind === "workspace" ? -1 : right.kind === "workspace" ? 1 : left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
async function workspaceIndex(projectRoot, stored, filter, repositories) {
  const listed = stored.entries.filter((entry) => TEXT_EXTENSIONS.has(path.posix.extname(entry.location).toLowerCase()));
  const counts = /* @__PURE__ */ new Map();
  for (const entry of listed) counts.set(entry.scope.label, (counts.get(entry.scope.label) ?? 0) + 1);
  const scopes = stored.scopes.filter((scope) => counts.has(scope.label)).sort(byScope).map((scope) => ({ kind: scope.kind, label: scope.label, repository: scope.repository ?? null, component: scope.component ?? null, artifacts: counts.get(scope.label) }));
  const result = { scopes, notes: [] };
  let shown = listed;
  if (filter !== null) {
    const known = new Set(stored.scopes.map((scope) => scope.label));
    const given = [...new Set(filter)];
    result.scopeFilter = given.filter((label) => known.has(label));
    result.unknownScopes = given.filter((label) => !known.has(label));
    const applied = new Set(result.scopeFilter);
    shown = listed.filter((entry) => applied.has(entry.scope.label));
  }
  result.every = listed.map((entry) => storeRefOf(entry.location));
  result.refs = shown.map((entry) => storeRefOf(entry.location));
  result.artifactScopes = Object.fromEntries(shown.map((entry) => [storeRefOf(entry.location), entry.scope.label]));
  if (!stored.held) {
    const names = await repositories();
    const named = names.length ? names.join(", ") : "Each repository";
    const one = names.length === 1;
    result.notes.push({ code: "store_without_artifacts", message: `The store holds no artifacts yet: ${named} ${one ? "keeps its" : "keep their"} artifacts in ${one ? "its" : "their"} checkouts until a Prism session there moves them into the store.` });
  }
  return result;
}
function scopeFilterOf(url) {
  if (!url.searchParams.has("scopes")) return null;
  const labels = url.searchParams.get("scopes").split(",").map((label) => label.trim()).filter(Boolean);
  return labels.length ? labels : null;
}
async function withStoreArtifacts(projectRoot, local) {
  const stored = await storeArtifactEntries(projectRoot);
  if (stored === null) return local;
  const results = new Set(local);
  for (const entry of stored) if (TEXT_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase())) results.add(entry.path);
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
  return `${start ? "\u2026" : ""}${text.slice(start, start + SEARCH_SNIPPET)}\u2026`;
}
function searchTokens(query) {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length && tokens.join("").length >= 2 ? tokens : null;
}
function matchText(content, tokens, name) {
  const lower = content.toLowerCase();
  if (!tokens.every((token) => lower.includes(token))) return null;
  const matches = [];
  let complete = 0;
  content.split(/\r?\n/).forEach((line, index) => {
    const lowerLine = line.toLowerCase();
    const hits = tokens.filter((token) => lowerLine.includes(token)).length;
    if (!hits) return;
    if (hits === tokens.length) complete += 1;
    matches.push({ line: index + 1, text: snippet(line, tokens.find((token) => lowerLine.includes(token))), hits });
  });
  matches.sort((left, right) => right.hits - left.hits || left.line - right.line);
  const nameHit = tokens.every((token) => name.toLowerCase().includes(token));
  return { score: (nameHit ? 1e3 : 0) + complete * 10 + matches.length, matches: matches.slice(0, SEARCH_LINE_LIMIT).map(({ line, text }) => ({ line, text })) };
}
async function searchArtifacts(projectRoot, query) {
  const tokens = searchTokens(query);
  if (!tokens) return { query: query ?? "", results: [] };
  const results = [];
  for (const artifactPath of await listArtifacts(projectRoot)) {
    let content;
    try {
      if (await inArtifactStore(projectRoot, artifactPath)) ({ content } = await readReviewed(projectRoot, artifactPath));
      else {
        const absolutePath = await resolveProjectFile(projectRoot, artifactPath);
        if ((await stat(absolutePath)).size > SEARCH_SIZE_LIMIT) continue;
        content = await readFile(absolutePath, "utf8");
      }
      if (Buffer.byteLength(content) > SEARCH_SIZE_LIMIT) continue;
    } catch {
      continue;
    }
    const matched = matchText(content, tokens, artifactPath);
    if (matched) results.push({ path: artifactPath, ...matched });
  }
  results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { query, results: results.slice(0, SEARCH_FILE_LIMIT).map(({ score, ...result }) => result) };
}
async function searchStoreArtifacts(projectRoot, stored, tokens) {
  const results = [];
  for (const entry of stored?.entries ?? []) {
    if (!TEXT_EXTENSIONS.has(path.posix.extname(entry.location).toLowerCase())) continue;
    const read = await readStoreArtifactAt(projectRoot, entry.location).catch(() => null);
    if (!read || read.bytes.length > SEARCH_SIZE_LIMIT) continue;
    const matched = matchText(read.bytes.toString("utf8"), tokens, entry.location);
    if (matched) results.push({ ref: storeRefOf(entry.location), scope: entry.scope, ...matched });
  }
  results.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref) || left.scope.label.localeCompare(right.scope.label));
  return results.slice(0, SEARCH_FILE_LIMIT).map(({ score, ...result }) => result);
}
const SEARCH_PATH_LIMIT = 50;
function rootComponentPaths(sources, folders) {
  const inside = (file, folder) => file === folder || file.startsWith(`${folder}/`);
  const paths = /* @__PURE__ */ new Set();
  for (const file of sources) {
    if (folders.some((folder) => inside(file, folder))) continue;
    const parts = file.split("/");
    let prefix = parts[0];
    for (let depth = 1; depth < parts.length && folders.some((folder) => inside(folder, prefix)); depth += 1) prefix = `${prefix}/${parts[depth]}`;
    paths.add(prefix);
  }
  return paths.size <= SEARCH_PATH_LIMIT ? [...paths].sort() : null;
}
function linkedDiagramPaths(artifactPath, content) {
  const directory = path.posix.dirname(artifactPath.split(path.sep).join("/"));
  const links = /* @__PURE__ */ new Set();
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
function artifactKind(artifactPath, data) {
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
    data = parseStoreJson(content);
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
async function loadEvidence(projectRoot, evidenceId, store = conservationStore) {
  if (typeof evidenceId !== "string" || !/^[a-f0-9]{64}$/.test(evidenceId)) {
    throw new Error("The evidence ID must be a 64-character lowercase hexadecimal digest.");
  }
  const truncated = {};
  const record = truncateArrays(await store.get(projectRoot, evidenceId), "", truncated);
  return { id: evidenceId, kind: record.kind, record, truncated, arrayLimit: EVIDENCE_ARRAY_LIMIT };
}
async function readReviewed(projectRoot, file) {
  if (await inArtifactStore(projectRoot, file)) {
    const stored = await readStoreArtifact(projectRoot, file);
    if (stored === null) throw Object.assign(new Error(`${file} is not in the record store.`), { code: "ENOENT" });
    return { content: stored.bytes.toString("utf8"), modifiedAt: stored.modifiedAt, scope: stored.scope };
  }
  const absolutePath = await resolveProjectFile(projectRoot, file);
  return { content: await readFile(absolutePath, "utf8"), modifiedAt: (await stat(absolutePath)).mtimeMs, absolutePath };
}
async function reviewedStoreArtifact(projectRoot, file, options) {
  const stored = await reviewStoreArtifact(projectRoot, file, options);
  if (stored === null) throw Object.assign(new Error(`${file} is not in the record store.`), { code: "ENOENT" });
  const { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } = stored;
  return { content: stored.bytes.toString("utf8"), modifiedAt: stored.modifiedAt, artifact: { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } };
}
async function loadArtifact(projectRoot, artifactPath, { commentOffset = 1 } = {}) {
  if (await inArtifactStore(projectRoot, artifactPath)) {
    const { content: content2, modifiedAt, artifact } = await reviewedStoreArtifact(projectRoot, artifactPath, { commentOffset });
    if (path.extname(artifactPath).toLowerCase() === ".json") return { path: artifactPath, content: content2, diagrams: [], modifiedAt, artifact, ...await loadJsonArtifact(projectRoot, artifactPath, content2) };
    return { path: artifactPath, content: content2, diagrams: await linkedDiagrams(projectRoot, artifactPath, content2), modifiedAt, artifact };
  }
  const absolutePath = await resolveProjectFile(projectRoot, artifactPath);
  if (!TEXT_EXTENSIONS.has(path.extname(artifactPath).toLowerCase())) {
    const bytes = await readFile(absolutePath);
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("The file is binary and cannot be shown.");
    const metadata2 = await stat(absolutePath);
    return { path: artifactPath, kind: "source", content: bytes.toString("utf8"), diagrams: [], modifiedAt: metadata2.mtimeMs };
  }
  const content = await readFile(absolutePath, "utf8");
  if (path.extname(artifactPath).toLowerCase() === ".json") {
    const metadata2 = await stat(absolutePath);
    return { path: artifactPath, content, diagrams: [], modifiedAt: metadata2.mtimeMs, ...await loadJsonArtifact(projectRoot, artifactPath, content) };
  }
  const metadata = await stat(absolutePath);
  return { path: artifactPath, content, diagrams: await linkedDiagrams(projectRoot, artifactPath, content), modifiedAt: metadata.mtimeMs };
}
async function linkedDiagrams(projectRoot, artifactPath, content) {
  const diagrams = [];
  for (const diagramPath of linkedDiagramPaths(artifactPath, content)) {
    try {
      diagrams.push({ path: diagramPath, source: (await readReviewed(projectRoot, diagramPath)).content });
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "ArtifactError" && !recordsUnavailable(error)) {
        throw error;
      }
    }
  }
  return diagrams;
}
function isTrustedHost(host) {
  try {
    return TRUSTED_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}
function send(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
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
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) {
      send(response, 404, "Not found");
      return;
    }
    throw error;
  }
}
function wantsPage(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const destination = request.headers["sec-fetch-dest"];
  if (destination) return destination === "document";
  return /\btext\/html\b/.test(request.headers.accept ?? "");
}
const UNAVAILABLE_REASONS = /* @__PURE__ */ new Set(["expired", "empty"]);
async function sendUnavailable(response, reason) {
  const page = await readFile(path.join(PUBLIC_DIR, "unavailable.html"), "utf8");
  send(response, 404, page.replace("{{reason}}", UNAVAILABLE_REASONS.has(reason) ? reason : "expired"), "text/html; charset=utf-8");
}
async function serveOutsideSession(request, response, pathname) {
  if (pathname === "/favicon.svg" || pathname === "/prism-mark.svg") {
    await serveFile(response, path.join(PUBLIC_DIR, pathname.slice(1)), "image/svg+xml");
    return;
  }
  if (pathname === "/unavailable.js") {
    await serveFile(response, path.join(PUBLIC_DIR, "unavailable.js"), "text/javascript; charset=utf-8");
    return;
  }
  const asset = request.method === "GET" || request.method === "HEAD" ? publicAsset(pathname) : null;
  if (asset) await serveFile(response, asset.file, asset.type);
  else if (wantsPage(request)) await sendUnavailable(response, "expired");
  else {
    response.setHeader(EXPIRED_LINK_HEADER, "expired");
    send(response, 404, "Not found");
  }
}
const EXPIRED_LINK_HEADER = "X-Prism-Link";
function publicAsset(route) {
  const folder = route.startsWith("/kit/") ? "kit" : route.startsWith("/styles/") ? "styles" : null;
  if (!folder) return null;
  let relative;
  try {
    relative = decodeURIComponent(route.slice(folder.length + 2));
  } catch {
    return null;
  }
  const parts = relative.split("/");
  if (!relative || /[\0\\]/.test(relative) || parts.some((part) => !part || part === "." || part === "..")) return null;
  const extension = path.extname(relative);
  if (!ASSET_TYPES.has(extension) || folder === "styles" && (parts.length !== 1 || extension !== ".css")) return null;
  const root = path.join(PUBLIC_DIR, folder);
  const file = path.join(root, ...parts);
  return isInside(root, file) ? { file, type: ASSET_TYPES.get(extension) } : null;
}
function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { cwd: homedir(), detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
async function findMissingTabs(tabs, available, entityResolves) {
  const missing = [];
  for (const tab of tabs) {
    if (parseEntityRef(tab) ? !await entityResolves(tab) : !available.has(tab)) missing.push(tab);
  }
  return missing;
}
async function movedRecordTabs(projectRoot, tabs, available) {
  const moves = /* @__PURE__ */ new Map();
  for (const tab of tabs) {
    if (available.has(tab) || parseEntityRef(tab)) continue;
    const key = await keyOfPath(projectRoot, tab).catch(() => null);
    if (!key || key.kind === "runs") continue;
    const target = recordPath(key);
    if (target !== tab && available.has(target)) moves.set(tab, target);
  }
  return moves;
}
function normalizeTabs(value) {
  if (value === void 0) {
    return [];
  }
  const tabs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(tabs) || tabs.some((tab) => typeof tab !== "string" || !tab)) {
    throw new Error("The open tabs must be an array of project-relative artifact paths.");
  }
  return [...new Set(tabs)];
}
function copyGroups(groups) {
  return groups.map((group) => ({ name: group.name, tabs: [...group.tabs], collapsed: group.collapsed, ...group.opener ? { opener: { ...group.opener } } : {} }));
}
function checkGroups(value, openTabs, follow = (tab) => tab, openers = /* @__PURE__ */ new Map()) {
  if (!Array.isArray(value) || value.length > GROUP_LIMIT) {
    throw new Error(`The tab groups must be an array of at most ${GROUP_LIMIT} groups.`);
  }
  const names = /* @__PURE__ */ new Set();
  const grouped = /* @__PURE__ */ new Set();
  return value.map((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("Each tab group must be an object with a name and its tabs.");
    const name = groupNameOf(group.name);
    if (names.has(name)) throw new Error(`Two tab groups are named ${name}.`);
    names.add(name);
    const tabs = normalizeTabs(group.tabs).map(follow);
    if (!tabs.length) throw new Error(`The tab group ${name} has no tabs.`);
    for (const tab of tabs) {
      if (!openTabs.includes(tab)) throw new Error("Grouped tabs must be open tabs.");
      if (grouped.has(tab)) throw new Error("A tab can be in one tab group only.");
      grouped.add(tab);
    }
    if (Object.hasOwn(group, "collapsed") && typeof group.collapsed !== "boolean") throw new Error("A tab group's collapsed must be true or false.");
    const opener = openers.get(name);
    return { name, tabs, collapsed: group.collapsed === true, ...opener ? { opener } : {} };
  });
}
async function readBody(request) {
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
const ACTION_STATUS = {
  unknown_target: 404,
  unknown_action: 404,
  stale_revision: 409,
  action_unavailable: 409,
  confirmation_required: 409,
  artifact_changed: 409,
  approval_ambiguous: 409,
  artifact_nonconforming: 409,
  author_unknown: 409,
  comment_limit: 409,
  already_answered: 409,
  // A format migration run's answer and rerun are refused by the run's state.
  run_not_asking: 409,
  run_not_failed: 409,
  migration_run_conforming: 409,
  migration_run_closed: 409,
  invalid_input: 400,
  // The refusals of a launch, a stop, and a resume, and of the confirmation outside the page that comes before a start.
  confirmation_pending: 409,
  confirmation_cooldown: 409,
  confirmation_unavailable: 409,
  confirmation_declined: 409,
  confirmation_timeout: 409,
  unknown_host: 409,
  unknown_initiative: 409,
  unknown_launch: 409,
  host_unavailable: 409,
  launch_running: 409,
  launch_not_running: 409,
  no_host_session: 409,
  choice_not_offered: 409,
  invalid_choice: 409,
  supervision_lost: 409,
  stop_timeout: 409,
  // The refusals of an answer to a launched session's permission request.
  unknown_request: 404,
  approval_unavailable: 409,
  approval_too_long: 409,
  launch_failed: 500,
  // The refusals of an install, update, or removal of a registry agent.
  install_mismatch: 409,
  install_running: 409,
  install_refused: 409,
  install_failed: 500,
  agent_running: 409
};
const ACTION_FIELDS = ["current", "reason", "field", "accepted", "artifacts"];
const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";
function sendJson(response, statusCode, body) {
  send(response, statusCode, JSON.stringify(body), "application/json; charset=utf-8");
}
function sendActionError(response, error) {
  if (error?.name === "ActionError" && error.unavailable === true) {
    sendJson(response, 503, { code: error.code, message: withoutCredentials(error.message) });
    return;
  }
  const status = ACTION_STATUS[error.code];
  if (!status) throw error;
  sendJson(response, status, { code: error.code, message: error.message, ...Object.fromEntries(ACTION_FIELDS.filter((key) => error[key] !== void 0).map((key) => [key, error[key]])) });
}
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
    return parseStoreJson(text);
  } catch {
    throw new Error("The request body must be JSON.");
  }
}
async function exchangeWriteGrant(request, response, writeSessions) {
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
}
async function changePersonalSettings(request, response, writable) {
  if (!fromPage(request)) {
    sendJson(response, 403, { code: "origin_refused", message: "Personal settings must come from the review page as JSON." });
    return;
  }
  if (!writable) {
    sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
    return;
  }
  let change;
  try {
    change = parseStoreJson(await readBody(request));
  } catch {
    change = void 0;
  }
  if (change === null || typeof change !== "object" || Array.isArray(change)) {
    sendJson(response, 400, { code: "invalid_setting", message: "The change must be a JSON object that names one or more personal settings and their values.", setting: null });
    return;
  }
  try {
    sendJson(response, 200, await updatePersonalSettings(change));
  } catch (error) {
    if (!(error instanceof PersonalSettingsError)) throw error;
    if (error.code === "invalid_setting") sendJson(response, 400, { code: error.code, message: error.message, setting: error.setting ?? null });
    else sendJson(response, 409, { code: error.code, message: error.message });
  }
}
async function servePageRoute(request, response, route) {
  if (route === "/" || route === "/review") {
    await serveFile(response, path.join(PUBLIC_DIR, "review.html"), "text/html; charset=utf-8");
  } else if (route === "/review.js") {
    await serveFile(response, path.join(PUBLIC_DIR, "review.js"), "text/javascript; charset=utf-8");
  } else if (route === "/favicon.svg" || route === "/prism-mark.svg") {
    await serveFile(response, path.join(PUBLIC_DIR, route.slice(1)), "image/svg+xml");
  } else if (route === "/vendor/plantuml.js") {
    await serveFile(response, path.join(VENDOR_DIR, "plantuml.js"), "text/javascript; charset=utf-8");
  } else if (route === "/vendor/viz-global.js") {
    await serveFile(response, path.join(VENDOR_DIR, "viz-global.js"), "text/javascript; charset=utf-8");
  } else if (route === "/c4.min.js" || route === "/vendor/c4.min.js") {
    await serveFile(response, path.join(VENDOR_DIR, "c4.min.js"), "text/javascript; charset=utf-8");
  } else if (route === "/kit/catalog") {
    await serveFile(response, path.join(KIT_DIR, "catalog.html"), "text/html; charset=utf-8");
  } else if (route.startsWith("/kit/") || route.startsWith("/styles/")) {
    const asset = publicAsset(route);
    if (asset) await serveFile(response, asset.file, asset.type);
    else send(response, 404, "Not found");
  } else if (route === "/api/preferences" && request.method === "GET") {
    send(response, 200, JSON.stringify(await readStoredPreferences()), "application/json; charset=utf-8");
  } else if (route === "/api/preferences" && request.method === "PUT") {
    if (!fromPage(request)) {
      send(response, 403, "Preferences must come from the review page as JSON.");
      return true;
    }
    try {
      let change;
      try {
        change = parseStoreJson(await readBody(request));
      } catch {
        throw Object.assign(new Error("The preferences must be a JSON object that gives one or more preferences."), { code: "invalid_preference" });
      }
      send(response, 200, JSON.stringify(await writePreferences(change)), "application/json; charset=utf-8");
    } catch (error) {
      if (error.code !== "invalid_preference") throw error;
      send(response, 400, JSON.stringify({ code: error.code, message: error.message }), "application/json; charset=utf-8");
    }
  } else if (/^\/views\/[a-z][a-z-]*\.js$/.test(route)) {
    await serveFile(response, path.join(VIEWS_DIR, route.slice("/views/".length)), "text/javascript; charset=utf-8");
  } else {
    return false;
  }
  return true;
}
function createProjectReview({
  projectRoot,
  baseUrl,
  instance = null,
  appVersion = null,
  onViewer = null,
  onAction = null,
  evidenceStore = () => conservationStore,
  intelligenceDirectories = () => [nativeSemanticRuntime.directory],
  privateServer = null,
  writeSessions = null,
  workspace = null,
  hub: sharedHub = null,
  rebuildIndex = (root, component, options = {}) => backgroundPreparation().then((module) => module.startIndexRebuild(root, { ...component ? { component: { identity: component.identity, folder: component.folder } } : {}, ...options })),
  autoRebuild = (root) => backgroundPreparation().then((module) => module.backgroundIndexingEnabled(root)),
  rebuildTiming = { quietMs: REBUILD_QUIET_MS, gapMs: REBUILD_GAP_MS, freshnessMs: FRESHNESS_CHECK_MS }
}) {
  const hub = sharedHub ?? createViewerHub();
  let fingerprint = null;
  function currentFingerprint() {
    if (!fingerprint || Date.now() - fingerprint.at >= rebuildTiming.freshnessMs) fingerprint = { at: Date.now(), value: gitFingerprint(projectRoot).catch(() => null) };
    return fingerprint.value;
  }
  const rebuild = { key: null, changedAt: Date.now(), startedAt: 0 };
  async function indexingStatus() {
    if (await isStoreWithoutCheckout(projectRoot)) return { state: "unavailable", diagnostics: [], autoRebuild: false };
    const status = await readIndexingStatus(projectRoot, intelligenceDirectories(), { fingerprint: currentFingerprint });
    const auto = await autoRebuild(projectRoot).catch(() => false);
    const print = await currentFingerprint();
    const key = print ? `${print.head}\0${print.worktree}` : null;
    if (key !== rebuild.key) Object.assign(rebuild, { key, changedAt: Date.now() });
    const outOfDate = status.stale === true && (status.state === "ready" || status.components !== void 0 && status.state !== "preparing") || status.state === "failed" && status.diagnostics.some((item) => item.code === "stale_snapshot");
    const now = Date.now();
    if (auto && outOfDate && now - rebuild.changedAt >= rebuildTiming.quietMs && now - rebuild.startedAt >= rebuildTiming.gapMs) {
      rebuild.startedAt = now;
      void rebuildIndex(projectRoot, null, { automatic: true });
    }
    return { ...status, autoRebuild: auto };
  }
  const indexer = {
    status: async (root, component) => componentIndexingStatus(root === projectRoot ? await indexingStatus() : await readIndexingStatus(root, intelligenceDirectories()), component),
    rebuild: async (root, component) => {
      if (await isStoreWithoutCheckout(root)) return;
      rebuild.startedAt = Date.now();
      Promise.resolve(rebuildIndex(root, component)).catch(() => {
      });
    }
  };
  let session = { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], groups: [], activeSource: null, revision: 0 };
  const viewers = /* @__PURE__ */ new Map();
  const hubKey = `${new URL(baseUrl).pathname}/`;
  let viewerOpenLease = null;
  const canWrite = (token) => Boolean(writeSessions?.valid(token));
  const writableRequest = (request) => canWrite(request.headers["x-prism-write"]);
  async function archiveRoute(request, response, archiving) {
    if (!fromPage(request)) {
      sendJson(response, 403, { code: "origin_refused", message: "A change must come from the review page as JSON." });
      return;
    }
    if (!writableRequest(request)) {
      sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
      return;
    }
    const invalid = () => sendJson(response, 400, { code: "invalid_request", message: archiving ? "The request must be a JSON object that names a launch, or sets ended to true." : "The request must be a JSON object that names a launch." });
    let body;
    try {
      body = await readJson(request);
    } catch {
      invalid();
      return;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    const names = keys?.length === 1 && keys[0] === "launch" && typeof body.launch === "string";
    const ended = archiving && keys?.length === 1 && keys[0] === "ended" && body.ended === true;
    if (!names && !ended) {
      invalid();
      return;
    }
    try {
      const env = process.env;
      const result = ended ? await archiveEndedLaunches({ projectRoot, env }) : archiving ? await archiveLaunch({ projectRoot, id: body.launch, env }) : await unarchiveLaunch({ projectRoot, id: body.launch, env });
      forgetWorkspace();
      sendJson(response, 200, result);
    } catch (error) {
      if (error?.code === "unknown_launch") sendJson(response, 404, { code: error.code, message: error.message });
      else if (error?.code === "launch_not_ended") sendJson(response, 409, { code: error.code, message: error.message });
      else throw error;
    }
  }
  function sessionSnapshot() {
    const snapshot = { openTabs: [...session.openTabs], activeTab: session.activeTab, previewTab: session.previewTab, agentTabs: [...session.agentTabs], groups: copyGroups(session.groups), activeSource: session.activeSource, revision: session.revision };
    return instance ? { ...snapshot, instance, ...appVersion ? { appVersion } : {} } : snapshot;
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
  function removeViewer(response) {
    const viewer = viewers.get(response);
    if (!viewer) {
      return;
    }
    clearInterval(viewer.heartbeat);
    viewers.delete(response);
    reportViewers();
  }
  function reportViewers() {
    workspace?.viewers?.(viewers.size + hub.count(hubKey));
  }
  function notify(event, data) {
    hub.notify(hubKey, event, data);
    for (const response of viewers.keys()) {
      try {
        writeEvent(response, event, data);
      } catch {
        removeViewer(response);
        response.destroy();
      }
    }
  }
  let recordsWatch = null;
  let recordsVersion = null;
  function watchRecords() {
    if (recordsWatch) return;
    let checking = false;
    recordsWatch = setInterval(async () => {
      if (viewers.size + hub.count(hubKey) === 0) {
        clearInterval(recordsWatch);
        recordsWatch = null;
        recordsVersion = null;
        return;
      }
      if (checking) return;
      checking = true;
      try {
        const version = await viewVersion(projectRoot).catch(() => null);
        if (version !== null && recordsVersion !== null && version !== recordsVersion) notify("records", {});
        if (version !== null) recordsVersion = version;
      } finally {
        checking = false;
      }
    }, RECORDS_CHECK_MS);
    recordsWatch.unref?.();
  }
  function openViewerStream(response, writable) {
    const heartbeat = openEventStream(response, () => removeViewer(response));
    viewers.set(response, { heartbeat, writable });
    watchRecords();
    reportViewers();
    if (writable) clearViewerOpenLease();
    writeEvent(response, "session", sessionSnapshot());
    onViewer?.((event, data) => writeEvent(response, event, data));
  }
  function joinHub(stream, tab, writable) {
    if (!hub.join(stream, tab, hubKey, writable)) return false;
    watchRecords();
    reportViewers();
    if (writable) clearViewerOpenLease();
    hub.send(stream, hubKey, "session", sessionSnapshot());
    onViewer?.((event, data) => hub.send(stream, hubKey, event, data));
    return true;
  }
  function writableViewerCount() {
    let count = hub.count(hubKey, { writable: true });
    for (const viewer of viewers.values()) if (viewer.writable) count += 1;
    return count;
  }
  async function reviewableFiles(wanted = []) {
    const { artifacts, sources } = await listedFiles(projectRoot, wanted);
    const stored = workspace ? await workspaceStoreArtifacts(projectRoot) : null;
    const refs = stored ? stored.entries.map((entry) => storeRefOf(entry.location)) : [];
    return /* @__PURE__ */ new Set([...artifacts, ...sources, ...refs, ...await codeRefs()]);
  }
  async function codeSources() {
    const sources = /* @__PURE__ */ new Map();
    for (const member of await workspace?.checkouts?.() ?? []) {
      if (!member.repository) continue;
      const files = await listReviewSources(member.root).catch(() => null);
      if (files === null) continue;
      const known = sources.get(member.repository) ?? /* @__PURE__ */ new Set();
      for (const file of files) known.add(file);
      sources.set(member.repository, known);
    }
    return sources;
  }
  async function codeRefs() {
    const refs = [];
    for (const [repository, files] of await codeSources()) for (const file of files) refs.push(codeRefOf(repository, file));
    if (workspace?.code) {
      for (const repository of await storeRepositories()) for (const file of await workspace.code.defaultFiles(repository) ?? []) refs.push(codeRefOf(repository, file));
    }
    return refs;
  }
  async function serveCodeFile(response, ref, code) {
    for (const member of await workspace?.checkouts?.() ?? []) {
      if (member.repository !== code.repository) continue;
      if (!(await listReviewSources(member.root).catch(() => [])).includes(code.path)) continue;
      let loaded;
      try {
        loaded = await loadArtifact(member.root, code.path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const diagrams = (loaded.diagrams ?? []).map((diagram) => ({ ...diagram, path: codeRefOf(code.repository, diagram.path) }));
      send(response, 200, JSON.stringify({ ...loaded, diagrams, ref, path: ref, file: code.path, repository: code.repository }), "application/json; charset=utf-8");
      return;
    }
    const cloned = workspace?.code && (await storeRepositories()).includes(code.repository) ? await workspace.code.defaultFile(code.repository, code.path) : null;
    if (cloned?.withheld) {
      sendJson(response, 404, withheldAnswer(cloned));
      return;
    }
    if (cloned) {
      send(response, 200, JSON.stringify({ ref, ...cloned }), "application/json; charset=utf-8");
      return;
    }
    send(response, 404, "No registered checkout of that repository and no code clone of it on this machine holds the file for review.");
  }
  function withheldAnswer(read) {
    const why = read.withheld === "binary" ? "it is a binary file" : "it is over 512 KiB";
    return { code: "file_not_shown", reason: read.withheld, message: `${read.path} is not available here because ${why}, which the review app does not show.` };
  }
  async function serveCode(response, route, url) {
    const repository = url.searchParams.get("repository");
    if (!workspace?.code || !repository || !(await storeRepositories()).includes(repository)) {
      sendJson(response, 404, { code: "repository_unknown", message: "The workspace has no repository of that name." });
      return;
    }
    const off = () => sendJson(response, 404, { code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` });
    if (route === "/api/code/tree") {
      const folder = workspace.code.folder(url.searchParams.get("folder") ?? "");
      if (folder === null) {
        sendJson(response, 400, { code: "invalid_request", message: "The folder must be a path below the repository's root." });
        return;
      }
      const entries = await workspace.code.tree(repository, folder);
      if (entries === null) off();
      else sendJson(response, 200, { repository, folder, entries });
    } else if (route === "/api/code/compare") {
      const compared = await workspace.code.compare(repository, url.searchParams.get("base") || null);
      if (compared === null) sendJson(response, 404, { code: "branch_unknown", message: "The clone of that repository holds no such branch, or its code content is off." });
      else sendJson(response, 200, { repository, ...compared });
    } else if (route === "/api/code/file") {
      const read = await workspace.code.file(repository, { branch: url.searchParams.get("branch"), commit: url.searchParams.get("commit"), path: url.searchParams.get("path") });
      if (read?.withheld) sendJson(response, 404, withheldAnswer(read));
      else if (read) sendJson(response, 200, read);
      else sendJson(response, 404, { code: "file_unavailable", message: "The clone holds no such file to show: the branch or commit is unknown, the path is no file there, or the file is a secret, binary, or over 512 KiB." });
    } else {
      const components = await workspace.code.components(repository);
      if (components === null) off();
      else sendJson(response, 200, { repository, ...components });
    }
  }
  async function machineCheckouts() {
    if (!workspace) return null;
    const own = await isStoreWithoutCheckout(projectRoot) ? [] : [{ root: projectRoot, repository: null }];
    const store = await recordStoreOf(projectRoot).catch(() => null);
    const folder = store?.external ? await realpath(store.base).catch(() => store.base) : null;
    return checkoutsOnMachine([...own, ...await workspace.checkouts?.() ?? []], folder);
  }
  async function checkoutRoots() {
    return (await machineCheckouts())?.map((checkout) => checkout.root) ?? null;
  }
  async function searchWorkspace(query) {
    const tokens = searchTokens(query);
    const stored = await workspaceStoreArtifacts(projectRoot);
    const checkouts = await machineCheckouts();
    const known = await knownComponents({ checkouts, repositories: await storeRepositories(), scopes: stored?.scopes ?? [], clones: workspace.code ? (repository) => workspace.code.components(repository) : null });
    const checkedOut = /* @__PURE__ */ new Set();
    for (const component of known) if (component.root !== null) checkedOut.add(component.repository);
    const leftOut = [];
    const searchable = /* @__PURE__ */ new Map();
    for (const component of known) {
      if (!checkedOut.has(component.repository)) leftOut.push({ component: component.identity, reason: "no_checkout" });
      else if (component.root === null) leftOut.push({ component: component.identity, reason: "no_index" });
      else searchable.set(component.root, [...searchable.get(component.root) ?? [], component]);
    }
    const code = [];
    for (const [root, components] of searchable) {
      const searched = await searchCheckoutCode(root, components, tokens ? query : null);
      code.push(...searched.code);
      leftOut.push(...searched.leftOut);
    }
    leftOut.sort((left, right) => left.component < right.component ? -1 : left.component > right.component ? 1 : 0);
    return { query: query ?? "", results: tokens ? await searchStoreArtifacts(projectRoot, stored, tokens) : [], code, leftOut };
  }
  async function searchCheckoutCode(root, components, query) {
    const status = await readIndexingStatus(root, intelligenceDirectories()).catch(() => null);
    const ready = components.filter((component) => componentIndexingStatus(status, component)?.state === "ready");
    const leftOut = components.filter((component) => !ready.includes(component)).map((component) => ({ component: component.identity, reason: "no_index" }));
    const code = [];
    if (query === null || !ready.length) return { code, leftOut };
    const { searchRepositoryConcepts } = await import("../repository-intelligence/semantic-native-provider.mjs");
    const listed = listComponents(await readWorkflowConfig(root).catch(() => null));
    const declared = Array.isArray(status?.components);
    const folders = listed.declared.filter((entry) => entry.folder !== "").map((entry) => entry.folder);
    for (const component of ready) {
      const folder = listed.declared.find((entry) => entry.component === component.identity)?.folder ?? "";
      const paths = !declared ? null : folder !== "" ? [folder] : rootComponentPaths(await listReviewSources(root).catch(() => []), folders);
      try {
        if (declared && (paths === null || !paths.length)) throw new Error("The root component's files cannot be named in one search.");
        const answer = await searchRepositoryConcepts({ projectRoot: root, query, ...paths ? { filters: { paths } } : {} });
        if (answer.status === "preparing") {
          leftOut.push({ component: component.identity, reason: "no_index" });
          continue;
        }
        for (const result of answer.results ?? []) if ((result.component ?? component.identity) === component.identity) code.push({ ...result, component: component.identity });
      } catch {
        leftOut.push({ component: component.identity, reason: "search_failed" });
      }
    }
    return { code, leftOut };
  }
  async function storeRepositories() {
    const store = await recordStoreOf(projectRoot).catch(() => null);
    const names = new Set(store?.external ? await registeredRepositories(store.base) : []);
    for (const member of await workspace?.checkouts?.() ?? []) if (member.repository) names.add(member.repository);
    if (store?.repository) names.add(store.repository);
    return [...names].sort();
  }
  async function sliceCode() {
    if (!workspace?.code) return null;
    const known = new Set(await storeRepositories());
    return {
      state: async (repository) => known.has(repository) ? workspace.code.state(repository) : { state: "off" },
      reachable: async (repository, commit) => known.has(repository) ? workspace.code.reachable(repository, commit) : null,
      branchesHolding: async (repository, commit) => known.has(repository) ? workspace.code.branchesHolding(repository, commit) : null,
      blobs: async (repository, commit, paths) => known.has(repository) ? workspace.code.blobs(repository, commit, paths) : null
    };
  }
  async function codeRepositories() {
    return Promise.all((await storeRepositories()).map(async (name) => ({ name, code: workspace?.code ? await workspace.code.state(name) : { state: "off" } })));
  }
  async function linkContext(scope) {
    const members = await workspace?.checkouts?.() ?? [];
    const reading = members.find((member) => member.root === projectRoot) ?? null;
    const repository = scope.repository ?? reading?.repository ?? null;
    const root = scope.repository ? members.find((member) => member.repository === scope.repository)?.root ?? null : projectRoot;
    const config = root ? await readWorkflowConfig(root).catch(() => null) : null;
    const sources = repository === null ? null : (await codeSources()).get(repository) ?? null;
    const cloned = repository === null || !workspace?.code ? null : await workspace.code.defaultFiles(repository);
    return { kinds: artifactKinds(config ?? parseWorkflowConfig("")), repository, sources, cloned };
  }
  async function serveStoreArtifact(response, ref, commentOffset) {
    const location = ref.startsWith(STORE_REF) ? ref.slice(STORE_REF.length) : null;
    let read = null;
    try {
      read = location ? await reviewStoreArtifactAt(projectRoot, location, { commentOffset }) : null;
    } catch (error) {
      if (recordsUnavailable(error) || error?.code === "store_unavailable") {
        send(response, 503, await artifactStoreRefusal(projectRoot) ?? withoutCredentials(error.message));
        return;
      }
      if (error?.name !== "ArtifactError") throw error;
    }
    if (!read) {
      send(response, 404, "The record store holds no artifact at that location.");
      return;
    }
    const stored = await workspaceStoreArtifacts(projectRoot);
    const held = new Set((stored?.entries ?? []).map((entry) => entry.location));
    const content = read.bytes.toString("utf8");
    const links = location.toLowerCase().endsWith(".md") ? resolveLinks({ content, location, ...await linkContext(read.scope), has: (candidate) => held.has(candidate) }) : [];
    const { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } = read;
    const below = location.slice(scopePrefix(scope).length);
    const artifact = { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset, target: `artifact:${scope.label}:${below}` };
    const answer = { ref, path: ref, location, scope, content, modifiedAt: read.modifiedAt, artifact, links, unresolvedLinks: links.filter((link) => link.resolved === false).length };
    if (path.posix.extname(location).toLowerCase() === ".json") Object.assign(answer, { diagrams: [] }, await loadJsonArtifact(projectRoot, location, content));
    else answer.diagrams = await storeDiagrams(location, content, links, held);
    const view = read.path ? await loadDeclaredView(projectRoot, read.path).catch(() => null) : null;
    if (view) answer.view = view;
    send(response, 200, JSON.stringify(answer), "application/json; charset=utf-8");
  }
  async function storeDiagrams(location, content, links, held) {
    const wanted = new Set(links.filter((link) => link.resolved && link.target.startsWith(STORE_REF) && link.target.toLowerCase().endsWith(".puml")).map((link) => link.target.slice(STORE_REF.length)));
    if (location.toLowerCase().endsWith(".puml")) wanted.add(location);
    else if (held.has(location.replace(/\.[^./]+$/, ".puml"))) wanted.add(location.replace(/\.[^./]+$/, ".puml"));
    const diagrams = [];
    for (const at of wanted) {
      const found = at === location ? { bytes: Buffer.from(content, "utf8") } : await readStoreArtifactAt(projectRoot, at).catch(() => null);
      if (found) diagrams.push({ path: storeRefOf(at), source: found.bytes.toString("utf8") });
    }
    return diagrams;
  }
  async function storeTabs(tabs, from = projectRoot) {
    return workspace ? Promise.all(tabs.map((tab) => storeTabRef(from, tab))) : tabs;
  }
  async function storeRequest(request) {
    if (!workspace || !request || typeof request !== "object") return request;
    const named = { ...request };
    for (const key of ["openTabs", "agentTabs"]) if (Array.isArray(request[key])) named[key] = await storeTabs(request[key]);
    for (const key of ["activeTab", "previewTab"]) if (typeof request[key] === "string") named[key] = await storeTabRef(projectRoot, request[key]);
    return named;
  }
  async function assertAvailable(tabs, availableArtifacts) {
    for (const tab of tabs) {
      if (!availableArtifacts.has(tab) && !(parseEntityRef(tab) && await entityExists(projectRoot, tab))) {
        throw new Error(`The artifact is not available for review: ${tab}`);
      }
    }
  }
  async function followMovedRecords(available) {
    const moves = await movedRecordTabs(projectRoot, session.openTabs, available);
    if (!moves.size) return sessionSnapshot();
    const follow = (tab) => moves.get(tab) ?? tab;
    const agentTabs = [...new Set(session.agentTabs.map(follow))];
    const previewTab = session.previewTab && follow(session.previewTab);
    const groups = session.groups.map((group) => ({ ...group, tabs: group.tabs.map(follow) }));
    return commitSession({ openTabs: [...new Set(session.openTabs.map(follow))], activeTab: session.activeTab && follow(session.activeTab), previewTab, agentTabs, groups, activeSource: session.activeSource });
  }
  let sessionWork = Promise.resolve();
  function inSessionOrder(task) {
    const run = sessionWork.then(task);
    sessionWork = run.catch(() => {
    });
    return run;
  }
  async function currentSession() {
    return followMovedRecords(await reviewableFiles());
  }
  function commitSession(proposed) {
    const arranged = arrangeGroups(proposed.openTabs, proposed.groups ?? session.groups);
    const grouped = new Set(arranged.groups.flatMap((group) => group.tabs));
    const previewTab = proposed.previewTab && !proposed.agentTabs.includes(proposed.previewTab) && !grouped.has(proposed.previewTab) ? proposed.previewTab : null;
    const next = { ...proposed, ...arranged, previewTab };
    const changed = ["openTabs", "agentTabs"].some((key) => next[key].length !== session[key].length || next[key].some((tab, index) => tab !== session[key][index])) || JSON.stringify(next.groups) !== JSON.stringify(session.groups) || next.activeTab !== session.activeTab || next.previewTab !== session.previewTab || next.activeSource !== session.activeSource;
    if (changed) {
      session = { ...next, revision: session.revision + 1 };
      notify("session", sessionSnapshot());
    }
    return sessionSnapshot();
  }
  async function updateSession(given) {
    const request = await storeRequest(given);
    const available = await reviewableFiles();
    await followMovedRecords(available);
    const moves = await movedRecordTabs(projectRoot, normalizeTabs(request.openTabs), available);
    const follow = (tab) => typeof tab === "string" ? moves.get(tab) ?? tab : tab;
    const body = { ...request, openTabs: [...new Set(normalizeTabs(request.openTabs).map(follow))] };
    for (const key of ["activeTab", "previewTab"]) if (Object.hasOwn(request, key)) body[key] = follow(request[key]);
    if (Object.hasOwn(request, "agentTabs")) body.agentTabs = [...new Set(normalizeTabs(request.agentTabs).map(follow))];
    const requestedTabs = body.openTabs;
    const added = requestedTabs.filter((tab) => !session.openTabs.includes(tab));
    await assertAvailable(added, added.length ? await reviewableFiles(added) : available);
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
    const groups = Object.hasOwn(body, "groups") ? checkGroups(body.groups, requestedTabs, follow, new Map(session.groups.filter((group) => group.opener).map((group) => [group.name, group.opener]))) : session.groups;
    if (requestedTabs.length === 0) {
      nextActiveTab = null;
    }
    const source = typeof body.source === "string" && /^[\w-]{1,64}$/.test(body.source) ? body.source : "page";
    const activeSource = nextActiveTab === session.activeTab ? session.activeSource : source;
    return commitSession({ openTabs: requestedTabs, activeTab: nextActiveTab, previewTab, agentTabs, groups, activeSource });
  }
  async function setOpenTabs(tabs, options) {
    return (await presentTabs(tabs, options)).openTabs;
  }
  async function presentTabs(tabs, { group, from = projectRoot, by = null } = {}) {
    const requestedTabs = [...new Set(await storeTabs(normalizeTabs(tabs), from))];
    const groupName = group === void 0 || group === null ? null : groupNameOf(group);
    let available = await reviewableFiles(requestedTabs);
    if (workspace && from !== projectRoot && requestedTabs.some((tab) => !available.has(tab) && !parseEntityRef(tab))) {
      useCheckout(from);
      available = await reviewableFiles(requestedTabs);
    }
    await assertAvailable(requestedTabs, available);
    await followMovedRecords(available);
    if (requestedTabs.length === 0) {
      if (session.openTabs.includes("attention")) {
        return commitSession({ ...session, activeTab: "attention", activeSource: "agent" });
      }
      const openTabs2 = [...session.openTabs.filter((tab) => tab !== session.previewTab), "attention"];
      return commitSession({ openTabs: openTabs2, activeTab: "attention", previewTab: "attention", agentTabs: session.agentTabs, activeSource: "agent" });
    }
    const openTabs = [...session.openTabs, ...requestedTabs.filter((tab) => !session.openTabs.includes(tab))];
    const agentTabs = [...session.agentTabs, ...requestedTabs.filter((tab) => !session.agentTabs.includes(tab))];
    const previewTab = requestedTabs.includes(session.previewTab) ? null : session.previewTab;
    const groups = groupName ? joinGroup(session.groups, groupName, requestedTabs, by ? await openerFor(by) : null) : session.groups;
    return commitSession({ openTabs, activeTab: requestedTabs[0], previewTab, agentTabs, groups, activeSource: "agent" });
  }
  async function openerFor(by) {
    const holder = typeof by?.holder === "string" && by.holder ? by.holder : null;
    let claim = null;
    if (holder) {
      const read = () => withRecordReads(() => loadHeldClaims(projectRoot));
      const held = await (workspace ? asWorkspaceView(read) : read()).catch(() => ({ claims: [] }));
      const now = Date.now();
      claim = held.claims.filter((entry) => entry.holder === holder && !entry.expired && Date.parse(entry.expiresAt) > now).sort((left, right) => Date.parse(right.renewedAt ?? right.claimedAt) - Date.parse(left.renewedAt ?? left.claimedAt))[0]?.ref ?? null;
    }
    return openerOf({ host: by?.host, model: by?.model, claim });
  }
  function useCheckout(root) {
    if (root === projectRoot) return;
    projectRoot = root;
    fingerprint = null;
  }
  function closeViewerStreams() {
    clearViewerOpenLease();
    if (recordsWatch) clearInterval(recordsWatch);
    recordsWatch = null;
    if (!sharedHub) hub.close();
    for (const response of viewers.keys()) {
      removeViewer(response);
      response.end();
    }
  }
  function handle(request, response, route, url) {
    const read = () => request.method !== "GET" || route.startsWith("/api/events") ? serve(request, response, route, url) : withRecordReads(() => serve(request, response, route, url));
    return workspace ? asWorkspaceView(read) : read();
  }
  async function serve(request, response, route, url) {
    if (await servePageRoute(request, response, route)) {
    } else if (route === "/api/events" && request.method === "GET") {
      openViewerStream(response, canWrite(url.searchParams.get("write")));
    } else if (route === "/api/events/shared" && request.method === "GET") {
      hub.open(response);
    } else if ((route === "/api/events/join" || route === "/api/events/leave") && request.method === "POST") {
      if (!fromPage(request)) {
        sendJson(response, 403, { code: "origin_refused", message: "A tab joins the event stream from the review page as JSON." });
        return;
      }
      const body = await readJson(request);
      if (route === "/api/events/leave") {
        hub.leave(body?.stream, body?.tab);
        reportViewers();
        sendJson(response, 200, {});
      } else if (joinHub(body?.stream, body?.tab, writableRequest(request))) {
        sendJson(response, 200, { project: hubKey });
      } else {
        sendJson(response, 404, { code: "stream_gone", message: "The event stream closed; join the stream that replaced it." });
      }
    } else if (route === "/api/index") {
      let { artifacts, sources } = await listedFiles(projectRoot, session.openTabs);
      const stored = workspace ? await workspaceStoreArtifacts(projectRoot) : null;
      let storeIndex = null;
      if (stored) {
        const isArtifact = await artifactPathTest(projectRoot);
        storeIndex = await workspaceIndex(projectRoot, stored, scopeFilterOf(url), storeRepositories);
        artifacts = [...artifacts.filter((file) => !isArtifact(file)), ...storeIndex.refs];
      }
      const available = /* @__PURE__ */ new Set([...artifacts, ...sources, ...storeIndex?.every ?? [], ...workspace ? await codeRefs() : []]);
      const snapshot = await followMovedRecords(available);
      const missingTabs = await findMissingTabs(snapshot.openTabs, available, (ref) => entityExists(projectRoot, ref));
      const checkout = workspace && await isStoreWithoutCheckout(projectRoot) ? null : await readWorkspaceIdentity(projectRoot);
      const named = workspace ? { workspace: await workspace.describe(), checkout, storeRefs: await storeArtifactRefs(projectRoot), sync: await workspace.sync?.() ?? null, repositories: await codeRepositories() } : { workspace: checkout };
      const scoped = storeIndex ? { artifactScopes: storeIndex.artifactScopes, scopes: storeIndex.scopes, ...storeIndex.scopeFilter ? { scopeFilter: storeIndex.scopeFilter, unknownScopes: storeIndex.unknownScopes } : {}, notes: storeIndex.notes } : { artifactScopes: await listArtifactScopes(projectRoot) };
      send(response, 200, JSON.stringify({ projectRoot, ...named, artifacts, ...scoped, sources, navigation: await loadNavigation(projectRoot), recordStore: await describeRecordStore(projectRoot).then(async (store) => ({ ...store, workspaceName: store.kind === "project" ? null : await readWorkspaceName(projectRoot), ...await checkoutArtifactsOf(projectRoot, store), watching: await viewWatching(projectRoot).catch(() => null) })).catch(() => null), storeSync: await recordSyncStatus(projectRoot), ...snapshot, missingTabs, version: appVersion ?? pluginVersion(), ...privateServer ? { privateServer } : {} }), "application/json; charset=utf-8");
    } else if (["/api/code/tree", "/api/code/compare", "/api/code/file", "/api/code/components"].includes(route) && request.method === "GET") {
      await serveCode(response, route, url);
    } else if (route === "/api/slice-files" && request.method === "GET") {
      const ref = `slice:${url.searchParams.get("initiative") ?? ""}/${url.searchParams.get("slice") ?? ""}`;
      const parsed = parseEntityRef(ref);
      if (parsed?.kind !== "slice" || !await entityExists(projectRoot, ref)) {
        sendJson(response, 404, { code: "slice_unknown", message: "The project has no slice of that initiative and slug." });
        return;
      }
      sendJson(response, 200, await sliceFiles(projectRoot, parsed.id, parsed.slug, await sliceCode()));
    } else if ((route === "/api/frozen-test" || route === "/api/verification-log") && request.method === "GET") {
      const ref = `slice:${url.searchParams.get("initiative") ?? ""}/${url.searchParams.get("slice") ?? ""}`;
      const parsed = parseEntityRef(ref);
      if (parsed?.kind !== "slice" || !await entityExists(projectRoot, ref)) {
        send(response, 404, "The project has no slice of that initiative and slug.");
        return;
      }
      const found = route === "/api/frozen-test" ? await frozenTestFile(projectRoot, parsed.id, parsed.slug, url.searchParams.get("path") ?? "").catch(() => null) : await verificationLog(projectRoot, parsed.id, parsed.slug, url.searchParams.get("id") ?? "").catch(() => null);
      if (found) sendJson(response, 200, found);
      else send(response, 404, route === "/api/frozen-test" ? "The slice's accepted design freezes no test at that path, or no copy of it is left." : "The slice has no verification run with that id.");
    } else if (route === "/api/store/conflicts" && request.method === "GET") {
      send(response, 200, JSON.stringify({ conflicts: await listRecordStoreConflicts(projectRoot).catch(() => []) }), "application/json; charset=utf-8");
    } else if (route === "/api/store/conflict" && request.method === "GET") {
      const conflict = await readRecordStoreConflict(projectRoot, url.searchParams.get("savedAs")).catch(() => null);
      if (conflict) send(response, 200, JSON.stringify(conflict), "application/json; charset=utf-8");
      else send(response, 404, "No saved conflict has that name.");
    } else if (route === "/api/session" && request.method === "GET") {
      send(response, 200, JSON.stringify(await inSessionOrder(currentSession)), "application/json; charset=utf-8");
    } else if (route === "/api/session" && request.method === "PUT") {
      const body = await readJson(request);
      send(response, 200, JSON.stringify(await inSessionOrder(() => updateSession(body))), "application/json; charset=utf-8");
    } else if (route === "/api/actions" && request.method === "GET") {
      try {
        const listed = await listActions({ projectRoot, target: url.searchParams.get("target"), indexer, checkouts: await checkoutRoots() });
        sendJson(response, 200, { target: listed.target, writable: writableRequest(request), actions: listed.actions });
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/launches" && request.method === "GET") {
      sendJson(response, 200, await listLaunches({ projectRoot, env: process.env }));
    } else if (route === "/api/run-options" && request.method === "GET") {
      if (!writableRequest(request)) {
        sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
        return;
      }
      try {
        sendJson(response, 200, await readRunOptions({ ...runOptionsQuery(url.searchParams, process.env), checkout: projectRoot, env: process.env }));
      } catch (error) {
        if (error?.name !== "RunOptionsError") throw error;
        sendJson(response, error.status, { code: error.code, message: error.message, ...error.field ? { field: error.field } : {} });
      }
    } else if (route === "/api/coding-agents" && request.method === "GET") {
      sendJson(response, 200, await listCodingAgents({ env: process.env }));
    } else if (route === "/api/agents" && request.method === "GET") {
      sendJson(response, 200, await listAgents({ projectRoot, env: process.env }));
    } else if (route === "/api/personal-settings" && request.method === "GET") {
      sendJson(response, 200, await readPersonalSettings({ projectRoot }));
    } else if (route === "/api/personal-settings" && request.method === "PUT") {
      await changePersonalSettings(request, response, writableRequest(request));
    } else if ((route === "/api/agents/archive" || route === "/api/agents/unarchive") && request.method === "POST") {
      await archiveRoute(request, response, route === "/api/agents/archive");
    } else if (route === "/api/actions/targets" && request.method === "GET") {
      try {
        sendJson(response, 200, await listActionTargets({ projectRoot, kind: url.searchParams.get("kind"), checkouts: await checkoutRoots() }));
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
        const result = await applyAction({ projectRoot, target: body.target, action: body.action, input: body.input, revision: body.revision, confirmed: body.confirmed, via: "review-app", indexer, checkouts: await checkoutRoots() });
        if (result.applied) forgetWorkspace();
        sendJson(response, 200, { applied: result.applied, actions: result.actions, ...result.launch !== void 0 ? { launch: result.launch } : {} });
        if (result.applied) {
          const target = parseTarget(result.applied.target);
          const event = { ...result.applied, initiative: target?.initiative ?? (target?.kind === "launch" ? result.launch?.initiative ?? null : null), ...result.artifact ? { artifact: result.artifact } : {} };
          if (onAction) await Promise.resolve(onAction(event, { shared: !["index", "machine", "agent"].includes(target?.kind), comment: result.comment ?? null })).catch(() => {
          });
          else notify("action", event);
        }
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/write-session" && request.method === "POST") {
      await exchangeWriteGrant(request, response, writeSessions);
    } else if (route === "/api/context") {
      send(response, 200, JSON.stringify(await entityContext(projectRoot, url.searchParams.get("ref"))), "application/json; charset=utf-8");
    } else if (route === "/api/entity") {
      const ref = url.searchParams.get("ref");
      if (["initiative", "slice", "migration-run"].includes(parseEntityRef(ref)?.kind) && !await entityExists(projectRoot, ref)) {
        send(response, 404, "The item no longer exists in this project.");
        return;
      }
      if (ref === "code" && workspace) {
        const repositories = (await codeRepositories()).map(({ name, code: { fetchedAt, ...code } }) => ({ name, code }));
        sendJson(response, 200, { ref, kind: "code", data: { repositories } });
        return;
      }
      const entity = await loadEntity(projectRoot, ref, { intelligenceDirectories: intelligenceDirectories() });
      if (entity.kind === "slice") {
        const code = await sliceCode();
        entity.presence = await slicePresence(projectRoot, entity.data.id, entity.data.slug, { reachable: code ? code.reachable : void 0, shipped: await shippedCommit(projectRoot, entity.data.id, entity.data.slug) });
      }
      send(response, 200, JSON.stringify(entity), "application/json; charset=utf-8");
    } else if (route === "/api/attention" && request.method === "GET") {
      send(response, 200, JSON.stringify({ gates: (await loadAttention(projectRoot)).gateCount }), "application/json; charset=utf-8");
    } else if (route === "/api/claims" && request.method === "GET") {
      send(response, 200, JSON.stringify(await loadClaims(projectRoot)), "application/json; charset=utf-8");
    } else if (route === "/api/evidence") {
      send(response, 200, JSON.stringify(await loadEvidence(projectRoot, url.searchParams.get("id"), evidenceStore())), "application/json; charset=utf-8");
    } else if (route === "/api/indexing" && request.method === "GET") {
      send(response, 200, JSON.stringify(await indexingStatus()), "application/json; charset=utf-8");
    } else if (route === "/api/records/search" && request.method === "GET") {
      send(response, 200, JSON.stringify(await searchRecords(projectRoot, url.searchParams.get("q"))), "application/json; charset=utf-8");
    } else if (route === "/api/touched" && request.method === "GET") {
      try {
        send(response, 200, JSON.stringify(await touchedRecords(projectRoot, url.searchParams.get("slice"))), "application/json; charset=utf-8");
      } catch (error) {
        if (!(error instanceof TouchedError)) throw error;
        send(response, error.status, JSON.stringify({ code: error.code, error: error.message }), "application/json; charset=utf-8");
      }
    } else if (route === "/api/changed" && request.method === "GET") {
      send(response, 200, JSON.stringify(await loadRecordChanges(projectRoot)), "application/json; charset=utf-8");
    } else if (route === "/api/search") {
      const query = url.searchParams.get("q");
      send(response, 200, JSON.stringify(workspace ? await searchWorkspace(query) : await searchArtifacts(projectRoot, query)), "application/json; charset=utf-8");
    } else if (route === "/api/artifact") {
      const artifactPath = url.searchParams.get("path");
      const commentOffset = url.searchParams.has("commentOffset") ? url.searchParams.get("commentOffset") : "1";
      if (!/^[0-9]+$/.test(commentOffset) || Number(commentOffset) < 1) {
        send(response, 400, "commentOffset names the 1-based position of the first comment to read, a whole number of at least 1 in ASCII digits.");
        return;
      }
      const ref = url.searchParams.get("ref") ?? (artifactPath?.startsWith(STORE_REF) || parseCodeRef(artifactPath) ? artifactPath : null);
      if (ref !== null) {
        const code = parseCodeRef(ref);
        if (!workspace) send(response, 404, "Only a workspace's page reads a store artifact or a code file by its ref.");
        else if (code) await serveCodeFile(response, ref, code);
        else await serveStoreArtifact(response, ref, Number(commentOffset));
        return;
      }
      await resolveProjectFile(projectRoot, artifactPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      const refusal = await inArtifactStore(projectRoot, artifactPath) ? await artifactStoreRefusal(projectRoot) : null;
      if (refusal !== null) {
        send(response, 503, refusal);
        return;
      }
      const { artifacts, sources } = await listedFiles(projectRoot, [artifactPath]);
      if (!artifacts.includes(artifactPath) && !sources.includes(artifactPath)) {
        send(response, 404, "The file is not available for review.");
        return;
      }
      let loaded;
      try {
        loaded = await loadArtifact(projectRoot, artifactPath, { commentOffset: Number(commentOffset) });
      } catch (error) {
        if (recordsUnavailable(error)) {
          send(response, 503, await artifactStoreRefusal(projectRoot) ?? withoutCredentials(error.message));
          return;
        }
        if (error.code !== "ENOENT") throw error;
        send(response, 404, "The file is not available for review.");
        return;
      }
      loaded = { ...loaded, format: await loadFormatMark(projectRoot, artifactPath, loaded.artifact?.scope ?? null) };
      const view = await loadDeclaredView(projectRoot, artifactPath).catch(() => null);
      send(response, 200, JSON.stringify(view ? { ...loaded, view } : loaded), "application/json; charset=utf-8");
    } else if (wantsPage(request) && !/^\/(api|kit|styles|views|vendor)\//.test(route)) {
      response.writeHead(302, { Location: `${baseUrl}/`, "Cache-Control": "no-store" });
      response.end();
    } else {
      send(response, 404, "Not found");
    }
  }
  return {
    baseUrl,
    get projectRoot() {
      return projectRoot;
    },
    handle,
    getOpenTabs() {
      return [...session.openTabs];
    },
    getSession() {
      return sessionSnapshot();
    },
    currentSession,
    viewerCount() {
      return viewers.size + hub.count(hubKey);
    },
    reportViewers,
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
    closeViewers: closeViewerStreams,
    useCheckout
  };
}
async function startReviewServer(options = {}) {
  const browserOpener = options.openBrowser ?? openBrowser;
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? process.cwd()));
  forgetWorkspace();
  const token = randomBytes(24).toString("base64url");
  const prefix = `/session/${token}`;
  let review;
  const server = createServer((request, response) => outsideToolCall(async () => {
    try {
      if (!isTrustedHost(request.headers.host)) {
        send(response, 403, "Unknown host");
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) {
        await serveOutsideSession(request, response, url.pathname);
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
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}${prefix}`;
  const writeSessions = await createWriteSessions();
  review = createProjectReview({ projectRoot, baseUrl, writeSessions, ...options.privateServer ? { privateServer: options.privateServer } : {}, ...options.rebuildIndex ? { rebuildIndex: options.rebuildIndex } : {} });
  return {
    baseUrl,
    projectRoot,
    getOpenTabs: review.getOpenTabs,
    getSession: review.getSession,
    viewerCount: review.viewerCount,
    setOpenTabs: review.setOpenTabs,
    reviewUrl: review.reviewUrl,
    async open(artifactPaths, options2) {
      const tabs = normalizeTabs(artifactPaths);
      await review.presentTabs(tabs, options2);
      const url = review.reviewUrl(tabs);
      if (!review.claimBrowserOpen()) {
        return { url, opened: false, ...review.getSession() };
      }
      const opened = Boolean(await browserOpener(withWriteGrant(url, writeSessions.issueGrant())));
      if (!opened) {
        review.releaseBrowserOpen();
      }
      return { url, opened, ...review.getSession() };
    },
    close() {
      review.closeViewers();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
export {
  EXPIRED_LINK_HEADER,
  READ_ONLY_NOTICE,
  SOURCE_SIZE_LIMIT,
  artifactKind,
  binaryPath,
  createProjectReview,
  exchangeWriteGrant,
  findMissingTabs,
  fromPage,
  isTrustedHost,
  listArtifactScopes,
  listArtifacts,
  listSourceFiles,
  loadArtifact,
  loadEvidence,
  movedRecordTabs,
  normalizeTabs,
  openBrowser,
  publicAsset,
  readBody,
  readJson,
  searchArtifacts,
  secretPath,
  send,
  sendJson,
  sendUnavailable,
  serveOutsideSession,
  servePageRoute,
  startReviewServer,
  storeTabRef,
  wantsPage
};
