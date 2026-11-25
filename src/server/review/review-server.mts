import { createServer } from "node:http";
import { arrangeGroups, GROUP_LIMIT, groupNameOf, joinGroup, openerOf } from "./public/views/tab-groups.js";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { openBrowser } from "./browser-opener.mjs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT, pluginVersion } from "../plugin-root.mjs";
import { CHANGE_MAP_FILES, getChangeMap } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { listComponents } from "../workflow/components.mjs";
import { artifactKinds, parseWorkflowConfig, readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { RECORD_DIRECTORY, artifactPathTest, artifactsInCheckout, describeRecordStore, inArtifactStore, isStoreWithoutCheckout, outsideToolCall, keyOfPath, recordStoreOf, listRecordEntries, listRecordStoreConflicts, listStoreArtifacts, readRecordStoreConflict, recordPath, recordsUnavailable, recordSyncStatus, resolveRecordFile, withRecordReads } from "../workflow/record-store.mjs";
import { ANSWERED_APPROVAL_KEPT_MS, answeredApprovalGates, artifactStoreLocation, pendingApprovalGates, readStoreArtifact, readStoreArtifactAt, reviewStoreArtifact, reviewStoreArtifactAt, storeArtifactLocation, workspaceArtifacts } from "../workflow/store-artifacts.mjs";
import { codeRefOf, parseCodeRef, resolveLinks } from "./artifact-links.mjs";
import { checkoutsOnMachine, knownComponents, registeredRepositories } from "./workspaces.mjs";
import { withoutCredentials } from "../workflow/remote-url.mjs";
import { readRoadmap, readWorkspaceName } from "../workflow/roadmap.mjs";
import { readReviewRunTotals } from "../session/run-totals.mjs";
import { gitFingerprint } from "../repository-intelligence/index-progress.mjs";
import { readIndexingStatus } from "../repository-intelligence/index-status.mjs";
import { nativeSemanticRuntime } from "../repository-intelligence/native-semantic-runtime.mjs";
import { asWorkspaceView, entityContext, entityExists, forgetWorkspace, rememberView, viewVersion, viewWatching, loadAttention, loadClaims, loadDeclaredView, loadFormatMark, loadHeldClaims, loadEntity, loadNavigation, loadInitiativeView, loadRecordChanges, parseEntityRef, placedInitiatives, searchRecords, slicePresence, workGroups } from "./workspace-model.mjs";
import { isQuiet, placeAnswer } from "./code-place.mjs";
import { ReadFailed, keptAnswers } from "./byte-cache.mjs";
import { answerKey, fileDiff, fileVersions, listFiles, readSlot, scopeLines, stopping, withVerified } from "./code-versions.mjs";
import { shippedCommit, sliceFiles } from "./slice-files.mjs";
import { branchOwners, ownerKey } from "./code-owners.mjs";
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
import { validUntil } from "../workflow/view-validity.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
// A line of work is quiet after this many days without a commit, unless a Code request names another threshold.
const QUIET_DAYS = 30;

const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const VENDOR_DIR = path.join(PLUGIN_ROOT, "vendor", "plantuml");
const VIEWS_DIR = path.join(PUBLIC_DIR, "views");
const KIT_DIR = path.join(PUBLIC_DIR, "kit");
// The kit and the area stylesheets are served by extension, and any other file in their folders answers 404.
const ASSET_TYPES = new Map([[".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".html", "text/html; charset=utf-8"], [".txt", "text/plain; charset=utf-8"], [".woff2", "font/woff2"]]);
const TEXT_EXTENSIONS = new Set([".md", ".feature", ".puml", ".json"]);
const EVIDENCE_ARRAY_LIMIT = 200;
// Requests naming any other host are refused, so a DNS-rebinding page cannot reach the server.
const TRUSTED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const VIEWER_OPEN_RETRY_MS = 10 * 1000;
// The stale hint runs Git in the project, so its answer is reused for this long however often the page asks.
const FRESHNESS_CHECK_MS = 30 * 1000;
// How often the server checks, while a page is connected, whether the records its views read changed.
const RECORDS_CHECK_MS = 1000;
// The build code loads only when a page asks for the index state, so a review server starts without the native runtime's modules.
const backgroundPreparation = () => import("../repository-intelligence/background-preparation.mjs");
// An out-of-date index is rebuilt once the files stopped changing for this long, so a burst of edits causes one build, and at most once per gap.
const REBUILD_QUIET_MS = 60 * 1000;
const REBUILD_GAP_MS = 5 * 60 * 1000;

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// A resolved file is served only inside its root and never from a Git folder there, so a tracked symlink cannot show what the checkout's .git holds.
function servableFrom(root: string, resolved: any) {
  return isInside(root, resolved) && !path.relative(root, resolved).split(path.sep).some((segment) => segment.toLowerCase() === ".git");
}

async function resolveProjectFile(projectRoot: string, requestedPath: any) {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error("The artifact path must be relative to the project root.");
  }
  // A record path keeps its .prism address and is served from the record store; its containment is checked there.
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

function configuredRoots(config: any) {
  const roots = new Set(["docs"]);
  for (const value of Object.values<any>(config.paths)) {
    if (value) {
      roots.add(path.posix.extname(value) ? path.posix.dirname(value) : value);
    }
  }
  return [...roots].filter((value) => value && value !== ".");
}

async function walkArtifacts(projectRoot: string, relativeRoot: any, results: any) {
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

export const SOURCE_SIZE_LIMIT = 512 * 1024;
const SOURCE_CHECKS = 8;
const LISTING_MIN_MS = 5000;
const LISTING_FACTOR = 5;
const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$|\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i;
/** Whether review sources leave a path out as a secret by its file name, such as .env or a private key. */
export const secretPath = (file: string) => SECRET_NAME.test(path.posix.basename(String(file)));
/** Whether review sources leave a path out as a binary file by its extension. */
export const binaryPath = (file: string) => BINARY_EXTENSION.test(path.posix.basename(String(file)));
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|pyc|so|dylib|dll|exe|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|sqlite|db)$/i;

function gitListFiles(projectRoot: string) {
  return new Promise<any>((resolve) => {
    execFile("git", ["-C", projectRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : stdout.split("\0").filter(Boolean));
    });
  });
}

// Source files are shown read-only: tracked or unignored files only, without secrets, binaries, or very large files.
// A few file checks run at once, which shortens the listing on a file system where each check waits, such as a Windows drive under WSL.
export async function listSourceFiles(projectRoot: string) {
  const candidates = (await gitListFiles(projectRoot)).filter((file: string) => {
    const name = path.posix.basename(file);
    return !SECRET_NAME.test(name) && !BINARY_EXTENSION.test(name);
  });
  const files: any[] = [];
  const root = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  let next = 0;
  const check = async () => {
    while (next < candidates.length) {
      const file = candidates[next++];
      try {
        const absolute = path.join(projectRoot, file);
        // A symlink is listed only when it resolves to a file the review would serve, never into .git or out of the checkout.
        if ((await lstat(absolute)).isSymbolicLink() && !servableFrom(root, await realpath(absolute))) continue;
        const metadata = await stat(absolute);
        if (metadata.isFile() && metadata.size <= SOURCE_SIZE_LIMIT) files.push(file);
      } catch {
        // A file deleted after git listed it is skipped.
      }
    }
  };
  await Promise.all(Array.from({ length: SOURCE_CHECKS }, check));
  return files.sort();
}

// The review page polls the project's listing every few seconds, so the server answers from its last listing and renews it behind,
// at most as often as five times the time a listing took, so a project whose listing is slow is not listed again and again.
const listings = new Map();
function reviewListing(projectRoot: string) {
  let listing = listings.get(projectRoot);
  if (!listing) {
    listing = createCachedValue(async () => {
      const [artifacts, sources] = await Promise.all([listCheckoutArtifacts(projectRoot), listReviewSources(projectRoot)]);
      return { artifacts, sources };
    }, { ttlMs: (ms: number) => Math.max(LISTING_MIN_MS, LISTING_FACTOR * ms) });
    listings.set(projectRoot, listing);
  }
  return listing;
}

// A wanted file whose presence on disk disagrees with the kept listing, such as one an agent has just written, moved, or deleted, lists the project again,
// so a few checked files keep the listing honest without listing the whole project on every request.
// The listing keeps only what the checkout holds; a store's artifacts, which another process's tool call can change at any time, are reused only until a file of the store changes.
async function listedFiles(projectRoot: string, wanted: any[] = []) {
  const listing = reviewListing(projectRoot);
  let value = await listing.get();
  const isArtifact = await artifactPathTest(projectRoot);
  const files = wanted.filter((file) => typeof file === "string" && file !== "attention" && !parseEntityRef(file) && !isArtifact(file));
  const listed = (file: string) => value.artifacts.includes(file) || value.sources.includes(file);
  const present = await Promise.all(files.map((file) => stat(path.join(projectRoot, file)).then((info) => info.isFile(), () => false)));
  if (files.some((file, index) => listed(file) !== present[index])) {
    listing.invalidate();
    value = await listing.get();
  }
  return { artifacts: await withStoreArtifacts(projectRoot, value.artifacts), sources: value.sources };
}

// With a record store, the descriptive artifacts the checkout sees come from the store, by path, while the checkout's own files under those paths are not artifacts.
// An unavailable store or a refused repository name lists no artifact, and never the checkout's files in their place; null means the project names no store.
async function storeArtifactEntries(projectRoot: string) {
  return rememberView(projectRoot, "store-artifacts", () => listStoreArtifacts(projectRoot).catch((error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return [];
    throw error;
  }));
}

/** Why the record store cannot serve the checkout's artifacts, as describeRecordStore reports it with the store named as configured, or null when it can or the project names no store. */
async function artifactStoreRefusal(projectRoot: string) {
  return (await describeRecordStore(projectRoot).catch(() => null))?.unavailable ?? null;
}

// The checkout's tracked files under its artifact paths that an available store does not hold, which the browser shows beside the store's status; the browser itself never moves them:
// awaitingMove counts those that an agent's tool call still moves or reports, and keptInCheckout those that a move kept for a person to settle.
// Each shown action list reads its target again at every check and whenever the page draws it, and an approval card's listing reads every requirement and ADR and the roadmap,
// so a listing answers those reads as the views are reused; an answered gate leaves the list at the end of its kept week even when no file changes.
const actionListingReads = {
  roadmap: (root: string) => rememberView(root, "actions-roadmap", () => readRoadmap(root)),
  pendingApprovalGates: (root: string) => rememberView(root, "pending-approval-gates", () => pendingApprovalGates(root)),
  answeredApprovalGates: (root: string) => rememberView(root, "answered-approval-gates", async () => {
    const gates = await answeredApprovalGates(root);
    for (const gate of gates) validUntil((Date.parse(gate.answer?.answeredAt ?? "") || 0) + ANSWERED_APPROVAL_KEPT_MS);
    return gates;
  })
};

async function checkoutArtifactsOf(projectRoot: string, store: any) {
  if (store.kind === "project" || store.unavailable) return {};
  return artifactsInCheckout(projectRoot);
}

/** The source files the review shows, without a checkout file at an artifact path of a project with a store, which is never the artifact. */
async function listReviewSources(projectRoot: string) {
  const isArtifact = await artifactPathTest(projectRoot);
  return (await listSourceFiles(projectRoot)).filter((file) => !isArtifact(file));
}

/** The store ref, store:<location>, of each store artifact the checkout sees, by path; a path that several scopes hold names the first by label. */
async function storeArtifactRefs(projectRoot: string) {
  return rememberView(projectRoot, "store-artifact-refs", () => computeStoreArtifactRefs(projectRoot));
}

async function computeStoreArtifactRefs(projectRoot: string) {
  const refs: Record<string, any> = {};
  for (const entry of await storeArtifactEntries(projectRoot) ?? []) {
    if (Object.hasOwn(refs, entry.path)) continue;
    const location = await artifactStoreLocation(projectRoot, entry).catch(() => null);
    if (location) refs[entry.path] = `store:${location}`;
  }
  return refs;
}

/** An open tab of a workspace's review: a store artifact that the checkout names by its path becomes store:<location>, and every other tab stays as it is. */
export async function storeTabRef(projectRoot: string, tab: any) {
  if (typeof tab !== "string" || tab.startsWith("store:") || parseEntityRef(tab) || !(await inArtifactStore(projectRoot, tab).catch(() => false))) return tab;
  const found = await storeArtifactLocation(projectRoot, tab).catch(() => null);
  return found ? `store:${found.location}` : tab;
}

/** The scope label of each store artifact the checkout sees, by path, or an empty object without a store; a path that several scopes hold names the first by label. */
export async function listArtifactScopes(projectRoot: string) {
  const scopes: Record<string, any> = {};
  for (const entry of await storeArtifactEntries(projectRoot) ?? []) scopes[entry.path] ??= entry.scope.label;
  return scopes;
}

export async function listArtifacts(projectRoot: string) {
  return withStoreArtifacts(projectRoot, await listCheckoutArtifacts(projectRoot));
}

// The artifacts the checkout itself holds, without a checkout file at an artifact path of a project with a store, which is never the artifact.
async function listCheckoutArtifacts(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  const results = new Set();
  for (const root of configuredRoots(config)) {
    await walkArtifacts(projectRoot, root, results);
  }
  const isArtifact = await artifactPathTest(projectRoot);
  for (const file of [...results]) if (isArtifact((file as any))) results.delete(file);
  // Machine records live under .prism, which the walk above skips as a hidden folder.
  await walkArtifacts(projectRoot, `${RECORD_DIRECTORY}/initiatives`, results);
  const roadmap = recordPath({ kind: "roadmap" });
  if (await resolveRecordFile(projectRoot, roadmap).then(({ target }) => stat(target)).then((info) => info.isFile(), () => false)) results.add(roadmap);
  return [...results].sort();
}

// A workspace's page names each store artifact by its store location, store:<location>, never by a checkout's path, and lists the artifacts of every scope the store holds.
const STORE_REF = "store:";
const storeRefOf = (location: any) => `${STORE_REF}${location}`;

// Every scope's artifacts in the store that a workspace's page reads through, or null when the page reads no store or its store cannot serve them.
async function workspaceStoreArtifacts(projectRoot: string) {
  return rememberView(projectRoot, "workspace-store-artifacts", () => workspaceArtifacts(projectRoot).catch((error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }));
}

// Scopes listed workspace first and then by label.
// The folder of a scope below artifacts/ with its trailing slash, or "" for the workspace scope.
const scopePrefix = (scope: any) => scope.kind === "workspace" ? "" : scope.kind === "repository" ? `repositories/${scope.repository}/` : `repositories/${scope.repository}/components/${scope.component}/`;

const byScope = (left: any, right: any) => left.kind === "workspace" ? -1 : right.kind === "workspace" ? 1 : left.label < right.label ? -1 : left.label > right.label ? 1 : 0;

/**
 * The store part of a workspace page's index: refs, the store:<location> of each artifact the page shows, artifactScopes, each ref's scope label, scopes, the scopes that hold an artifact with their counts,
 * and, when filter names scope labels, scopeFilter, the labels it applied in the order given, and unknownScopes, the labels no scope of the store has, with refs narrowed to the applied scopes;
 * notes says when the store holds no artifacts/ folder yet, naming the repositories that keep their artifacts in their checkouts.
 */
async function workspaceIndex(projectRoot: string, stored: any, filter: any, repositories: any) {
  const listed = stored.entries.filter((entry: any) => TEXT_EXTENSIONS.has(path.posix.extname(entry.location).toLowerCase()));
  const counts = new Map();
  for (const entry of listed) counts.set(entry.scope.label, (counts.get(entry.scope.label) ?? 0) + 1);
  const scopes = stored.scopes.filter((scope: any) => counts.has(scope.label)).sort(byScope)
    .map((scope: any) => ({ kind: scope.kind, label: scope.label, repository: scope.repository ?? null, component: scope.component ?? null, artifacts: counts.get(scope.label) }));
  const result: any = { scopes, notes: [] };
  let shown = listed;
  if (filter !== null) {
    const known = new Set(stored.scopes.map((scope: any) => scope.label));
    const given = [...new Set(filter)];
    result.scopeFilter = given.filter((label) => known.has(label));
    result.unknownScopes = given.filter((label) => !known.has(label));
    const applied = new Set(result.scopeFilter);
    shown = listed.filter((entry: any) => applied.has(entry.scope.label));
  }
  result.every = listed.map((entry: any) => storeRefOf(entry.location));
  result.refs = shown.map((entry: any) => storeRefOf(entry.location));
  result.artifactScopes = Object.fromEntries(shown.map((entry: any) => [storeRefOf(entry.location), entry.scope.label]));
  if (!stored.held) {
    const names = await repositories();
    const named = names.length ? names.join(", ") : "Each repository";
    const one = names.length === 1;
    result.notes.push({ code: "store_without_artifacts", message: `The store holds no artifacts yet: ${named} ${one ? "keeps its" : "keep their"} artifacts in ${one ? "its" : "their"} checkouts until a Prism session there moves them into the store.` });
  }
  return result;
}

// The scope labels that an index request's scopes parameter names, or null when it names none.
function scopeFilterOf(url: any) {
  if (!url.searchParams.has("scopes")) return null;
  const labels = url.searchParams.get("scopes").split(",").map((label: string) => label.trim()).filter(Boolean);
  return labels.length ? labels : null;
}

// The checkout's artifacts with the text artifacts that the store's scopes hold, as the store lists them now.
async function withStoreArtifacts(projectRoot: string, local: any) {
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

function snippet(line: string, token: string) {
  const text = line.trim();
  if (text.length <= SEARCH_SNIPPET) return text;
  const start = Math.max(0, text.toLowerCase().indexOf(token) - 40);
  return `${start ? "…" : ""}${text.slice(start, start + SEARCH_SNIPPET)}…`;
}

// A search query's lowercase words, or null when they hold fewer than two characters in all.
function searchTokens(query: any) {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length && tokens.join("").length >= 2 ? tokens : null;
}

// How a text matches a query's words: null unless every word occurs in it, else its score, which ranks a name that holds every word and lines that hold them all together first,
// and its first matching lines, those with the most words first.
function matchText(content: any, tokens: any, name: string) {
  const lower = content.toLowerCase();
  if (!tokens.every((token: string) => lower.includes(token))) return null;
  const matches: any[] = [];
  let complete = 0;
  content.split(/\r?\n/).forEach((line: string, index: number) => {
    const lowerLine = line.toLowerCase();
    const hits = tokens.filter((token: string) => lowerLine.includes(token)).length;
    if (!hits) return;
    if (hits === tokens.length) complete += 1;
    matches.push({ line: index + 1, text: snippet(line, tokens.find((token: string) => lowerLine.includes(token))), hits });
  });
  matches.sort((left, right) => right.hits - left.hits || left.line - right.line);
  const nameHit = tokens.every((token: string) => name.toLowerCase().includes(token));
  return { score: (nameHit ? 1000 : 0) + complete * 10 + matches.length, matches: matches.slice(0, SEARCH_LINE_LIMIT).map(({ line, text }) => ({ line, text })) };
}

// Full-text search over the Prism artifacts the review lists, never over source files: every term must occur in a file,
// and files whose lines hold all terms together rank first.
export async function searchArtifacts(projectRoot: string, query: any) {
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

// Full-text search over a workspace's store artifacts of every scope, matched as a checkout's search matches its artifacts, each result { ref, scope, matches }.
async function searchStoreArtifacts(projectRoot: string, stored: any, tokens: any) {
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

// The shortest folders and files of a checkout's review sources that lie outside every declared component's folder and hold none of them,
// which select only the root component's index in a component search, or null when more are needed than one search takes.
function rootComponentPaths(sources: any, folders: any) {
  const inside = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);
  const paths = new Set();
  for (const file of sources) {
    if (folders.some((folder: string) => inside(file, folder))) continue;
    const parts = file.split("/");
    let prefix = parts[0];
    for (let depth = 1; depth < parts.length && folders.some((folder: string) => inside(folder, prefix)); depth += 1) prefix = `${prefix}/${parts[depth]}`;
    paths.add(prefix);
  }
  return paths.size <= SEARCH_PATH_LIMIT ? [...paths].sort() : null;
}

function linkedDiagramPaths(artifactPath: string, content: any) {
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

function isRecord(value: any) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function artifactKind(artifactPath: string, data: any) {
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

async function loadJsonArtifact(projectRoot: string, artifactPath: string, content: any) {
  let data;
  try {
    data = parseStoreJson(content);
  } catch (error) {
    return { kind: "json", parseError: error.message };
  }
  const kind = artifactKind(artifactPath, data);
  const result: any = { kind, data };
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
    result.runTotals = key?.kind === "review" ? await readReviewRunTotals(projectRoot, (key as any)) : null;
  }
  return result;
}

function truncateArrays(value: any, location: any, truncated: any): any {
  if (Array.isArray(value)) {
    if (value.length > EVIDENCE_ARRAY_LIMIT) {
      truncated[location || "/"] = value.length;
    }
    return value.slice(0, EVIDENCE_ARRAY_LIMIT).map((item, index) => truncateArrays(item, `${location}/${index}`, truncated));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries<any>(value).map(([key, item]) => [key, truncateArrays(item, `${location}/${key}`, truncated)]));
  }
  return value;
}

export async function loadEvidence(projectRoot: string, evidenceId: any, store = conservationStore) {
  if (typeof evidenceId !== "string" || !/^[a-f0-9]{64}$/.test(evidenceId)) {
    throw new Error("The evidence ID must be a 64-character lowercase hexadecimal digest.");
  }
  const truncated = {};
  const record = truncateArrays(await store.get(projectRoot, evidenceId), "", truncated);
  return { id: evidenceId, kind: record.kind, record, truncated, arrayLimit: EVIDENCE_ARRAY_LIMIT };
}

// A store artifact is read from the store, and every other file from the project or the record store as its path decides.
// An unavailable store or a refused repository name throws its refusal rather than read the checkout's file.
async function readReviewed(projectRoot: string, file: any) {
  if (await inArtifactStore(projectRoot, file)) {
    const stored = await readStoreArtifact(projectRoot, file);
    if (stored === null) throw Object.assign(new Error(`${file} is not in the record store.`), { code: "ENOENT" });
    return { content: stored.bytes.toString("utf8"), modifiedAt: stored.modifiedAt, scope: stored.scope };
  }
  const absolutePath = await resolveProjectFile(projectRoot, file);
  return { content: await readFile(absolutePath, "utf8"), modifiedAt: (await stat(absolutePath)).mtimeMs, absolutePath };
}

// What the review view shows of a store artifact beside its content: its scope, version, the version a person last accepted with its text, whether it changed since, and its comments.
// The comments come one page at a time, from the 1-based commentOffset, with their total and the offset of the next page.
async function reviewedStoreArtifact(projectRoot: string, file: string, options: any) {
  const stored = await reviewStoreArtifact(projectRoot, file, options);
  if (stored === null) throw Object.assign(new Error(`${file} is not in the record store.`), { code: "ENOENT" });
  const { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } = stored;
  return { content: stored.bytes.toString("utf8"), modifiedAt: stored.modifiedAt, artifact: { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } };
}

export async function loadArtifact(projectRoot: string, artifactPath: string, { commentOffset = 1 }: any = {}) {
  if (await inArtifactStore(projectRoot, artifactPath)) {
    const { content, modifiedAt, artifact } = await reviewedStoreArtifact(projectRoot, artifactPath, { commentOffset });
    if (path.extname(artifactPath).toLowerCase() === ".json") return { path: artifactPath, content, diagrams: [], modifiedAt, artifact, ...(await loadJsonArtifact(projectRoot, artifactPath, content)) };
    return { path: artifactPath, content, diagrams: await linkedDiagrams(projectRoot, artifactPath, content), modifiedAt, artifact };
  }
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
  const metadata = await stat(absolutePath);
  return { path: artifactPath, content, diagrams: await linkedDiagrams(projectRoot, artifactPath, content), modifiedAt: metadata.mtimeMs };
}

async function linkedDiagrams(projectRoot: string, artifactPath: string, content: any) {
  const diagrams = [];
  for (const diagramPath of linkedDiagramPaths(artifactPath, content)) {
    try {
      diagrams.push({ path: diagramPath, source: (await readReviewed(projectRoot, diagramPath)).content });
    } catch (error) {
      // A missing diagram, or a store diagram the checkout cannot read or reach, is left out.
      if (error.code !== "ENOENT" && error.name !== "ArtifactError" && !recordsUnavailable(error)) {
        throw error;
      }
    }
  }
  return diagrams;
}

export function isTrustedHost(host: any) {
  try {
    return TRUSTED_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function send(response: any, statusCode: any, body: any, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

async function serveFile(response: any, filePath: string, contentType: any) {
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

/** Whether a request is a browser loading a page, as opposed to a script, a stylesheet, or a call from the page. */
export function wantsPage(request: any) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const destination = request.headers["sec-fetch-dest"];
  if (destination) return destination === "document";
  return /\btext\/html\b/.test(request.headers.accept ?? "");
}

const UNAVAILABLE_REASONS = new Set(["expired", "empty"]);

/** The page for a link the review app cannot open: one without the current viewer credential ("expired") or an app with no project yet ("empty"). */
export async function sendUnavailable(response: any, reason: string) {
  const page = await readFile(path.join(PUBLIC_DIR, "unavailable.html"), "utf8");
  send(response, 404, page.replace("{{reason}}", UNAVAILABLE_REASONS.has(reason) ? reason : "expired"), "text/html; charset=utf-8");
}

/**
 * Answers a request that carries no current viewer credential. Only the kit's files and the marks, which hold no project data, are served,
 * and a page load gets the page that says the link no longer works, so a stale tab or a bare address shows the app's own page rather than a line of text.
 */
export async function serveOutsideSession(request: any, response: any, pathname: string) {
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
    // A call from a page loaded before the app restarted says that its link expired, so the page reloads into the page that tells the person so.
    response.setHeader(EXPIRED_LINK_HEADER, "expired");
    send(response, 404, "Not found");
  }
}

/** The header on a refusal of a call whose link carries no current viewer credential. */
export const EXPIRED_LINK_HEADER = "X-Prism-Link";

// The file and type of a route under kit/ or styles/, or null for a path that leaves its folder, is not a known type, or is not a styles/<name>.css.
export function publicAsset(route: string) {
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
  if (!ASSET_TYPES.has(extension) || (folder === "styles" && (parts.length !== 1 || extension !== ".css"))) return null;
  const root = path.join(PUBLIC_DIR, folder);
  const file = path.join(root, ...parts);
  return isInside(root, file) ? { file, type: ASSET_TYPES.get(extension) } : null;
}

export { openBrowser };

/** The open tabs whose file the review no longer lists, or whose entity no longer resolves, in tab order. */
export async function findMissingTabs(tabs: any, available: any, entityResolves: any) {
  const missing = [];
  for (const tab of tabs) {
    if (parseEntityRef(tab) ? !(await entityResolves(tab)) : !available.has(tab)) missing.push(tab);
  }
  return missing;
}

/** Each tab on a record that Prism moved from a legacy location, mapped to the record's current path by the record store's own mapping. */
export async function movedRecordTabs(projectRoot: string, tabs: any, available: any) {
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

export function normalizeTabs(value: any) {
  if (value === undefined) {
    return [];
  }
  const tabs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(tabs) || tabs.some((tab) => typeof tab !== "string" || !tab)) {
    throw new Error("The open tabs must be an array of project-relative artifact paths.");
  }
  return [...new Set(tabs)];
}

function copyGroups(groups: any) {
  return groups.map((group: any) => ({ name: group.name, tabs: [...group.tabs], collapsed: group.collapsed, ...(group.opener ? { opener: { ...group.opener } } : {}) }));
}

// A page's groups name open tabs, each tab in one group at most, with names that differ.
// Who opened a group is the review app's record, never the page's: a group keeps the opener the session has under its name.
function checkGroups(value: any, openTabs: any, follow = (tab: any) => tab, openers = new Map()) {
  if (!Array.isArray(value) || value.length > GROUP_LIMIT) {
    throw new Error(`The tab groups must be an array of at most ${GROUP_LIMIT} groups.`);
  }
  const names = new Set();
  const grouped = new Set();
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
    return { name, tabs, collapsed: group.collapsed === true, ...(opener ? { opener } : {}) };
  });
}

// Reads a request body of at most 64 KiB as text; the review app needs the exact text because control requests sign it.
export async function readBody(request: any) {
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
// An approval of an artifact that changed since it was asked, or that would leave it breaking its format, of an id that more than one pending gate holds, an approval or comment by a checkout whose Git names no user,
// or a comment on a file that already holds the comments a file may hold, conflicts with the store as it is,
// and a store that cannot be used answers an approval or comment target with its own refusal as unavailable, as an artifact read does.
const ACTION_STATUS: Record<string, any> = {
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
// A refusal of an approval that would break the format names each artifact with its findings, as update_artifact names them.
const ACTION_FIELDS = ["current", "reason", "field", "accepted", "artifacts"];
export const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";

export function sendJson(response: any, statusCode: any, body: any) {
  send(response, statusCode, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendActionError(response: any, error: any) {
  if (error?.name === "ActionError" && error.unavailable === true) {
    sendJson(response, 503, { code: error.code, message: withoutCredentials(error.message) });
    return;
  }
  const status = ACTION_STATUS[error.code];
  if (!status) throw error;
  sendJson(response, status, { code: error.code, message: error.message, ...Object.fromEntries(ACTION_FIELDS.filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) });
}

// A write comes from the review page itself: JSON, and an Origin, when the browser sends one, of the same host.
export function fromPage(request: any) {
  const origin = request.headers.origin;
  if (String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return false;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export async function readJson(request: any) {
  const text = await readBody(request);
  try {
    return parseStoreJson(text);
  } catch {
    throw new Error("The request body must be JSON.");
  }
}

/** Exchange the one-time grant of a tab that Prism opened, from its URL fragment, for the write session the tab keeps. */
export async function exchangeWriteGrant(request: any, response: any, writeSessions: any) {
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

// A change to the person's own settings comes from the review page as JSON, as a change of the preferences does, and is checked as the agents' tool checks it.
// writable says whether the request holds the page's write session, which a change needs as every other change of the review app does.
async function changePersonalSettings(request: any, response: any, writable: boolean) {
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
    change = undefined;
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

/**
 * Answer a route of the review page itself, its scripts, styles, kit, and the person's preferences, which every page of a server or app shares,
 * and resolve to whether the route was one of them.
 */
export async function servePageRoute(request: any, response: any, route: string) {
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

// One project's review context: its tab session, viewer streams, and routes, shared by the session server and the review app.
// onViewer(send) runs when a viewer stream opens, after its first session event, and send writes a named event to that viewer only.
// writeSessions is the write session store of the server or app that serves this page; without one, no request can write.
// onAction(event, { shared, comment }) receives each applied action's event, the history entry with its initiative, instead of this page's viewer streams;
// shared is false for an index target, whose history belongs to this checkout alone, and for a machine target, whose choice belongs to this computer, and comment is the id of a stored comment, which names its file, or null.
// Without it, the event reaches this page's viewer streams.
// workspace, for a review of the review app's workspace, is { id, describe(), sync?(), viewers?(count), checkouts?() }, describe answering { id, name, kind, url } for the index,
// sync the workspace's sync state that the index holds, or null when nothing syncs it, viewers receiving the number of connected pages whenever it changes,
// and checkouts listing its registered checkouts as { root, repository }, whose configured paths resolve the links of their repository's store artifacts:
// its open tabs then name each store artifact by its store location, store:<location>, never by a checkout path, and projectRoot is the checkout it reads through, which useCheckout(root) changes.
// hub holds the shared viewer streams of the origin that serves this page; the review app passes one hub to every workspace and closes it itself, and a session server keeps its own.
export function createProjectReview({ projectRoot, baseUrl, instance = null, appVersion = null, onViewer = null, onAction = null, evidenceStore = () => conservationStore, intelligenceDirectories = () => [nativeSemanticRuntime.directory], privateServer = null, writeSessions = null, workspace = null, hub: sharedHub = null,
  rebuildIndex = (root: string, component: any, options: any = {}) => backgroundPreparation().then((module) => module.startIndexRebuild(root, { ...(component ? { component: { identity: component.identity, folder: component.folder } } : {}), ...options })), autoRebuild = (root: string) => backgroundPreparation().then((module) => module.backgroundIndexingEnabled(root)), rebuildTiming = { quietMs: REBUILD_QUIET_MS, gapMs: REBUILD_GAP_MS, freshnessMs: FRESHNESS_CHECK_MS } }: { projectRoot: string; baseUrl: any; instance?: any; appVersion?: any; onViewer?: any; onAction?: any; evidenceStore?: any; intelligenceDirectories?: any; privateServer?: any; writeSessions?: any; workspace?: any; hub?: any; rebuildIndex?: any; autoRebuild?: any; rebuildTiming?: any }) {
  const hub = sharedHub ?? createViewerHub();
  let fingerprint: any = null;
  function currentFingerprint() {
    if (!fingerprint || Date.now() - fingerprint.at >= rebuildTiming.freshnessMs) fingerprint = { at: Date.now(), value: gitFingerprint(projectRoot).catch(() => null) };
    return fingerprint.value;
  }
  // The index chip polls while a page is open, so an out-of-date index is rebuilt only while someone looks at the project.
  const rebuild = { key: null, changedAt: Date.now(), startedAt: 0 };
  async function indexingStatus() {
    // A workspace read through its store's clone alone has no checkout and so no code to index.
    if (await isStoreWithoutCheckout(projectRoot)) return { state: "unavailable", diagnostics: [], autoRebuild: false };
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
      void rebuildIndex(projectRoot, null, { automatic: true });
    }
    return { ...status, autoRebuild: auto };
  }
  // The registry's indexer serves each component's own index: with declared components, a target shows its component's entry in the status, or none
  // while that component has neither an index nor a preparation, and without them the root target shows the checkout's one index.
  // A person's request rebuilds only its own component, starts at once, and ignores the background opt-out, because it is not in the background.
  // A workspace's page also lists the components of its other checkouts on this machine, whose status each one's own index storage holds.
  const indexer = {
    status: async (root: string, component: any) => componentIndexingStatus(root === projectRoot ? await indexingStatus() : await readIndexingStatus(root, intelligenceDirectories()), component),
    rebuild: async (root: string, component: any) => {
      if (await isStoreWithoutCheckout(root)) return;
      rebuild.startedAt = Date.now();
      Promise.resolve(rebuildIndex(root, component)).catch(() => {});
    }
  };
  // activeSource says who chose the active tab last: "agent" for a presentation, or the id of the review window that chose it, so each window
  // follows what an agent presents and its own choices, never another window's.
  // groups name sets of open tabs, such as the tabs an agent presented for one piece of work: each group's tabs stay side by side in openTabs,
  // in the order openTabs gives them, and a collapsed group shows only its name and its selected tab.
  let session: Record<string, any> = { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], groups: [], activeSource: null, revision: 0 };
  // Each viewer stream maps to its heartbeat and whether it carries a live write session; only writable streams count as connected tabs.
  // The review page joins the origin's shared stream instead, as a member of the hub under this page's path, and counts the same way.
  const viewers = new Map();
  const hubKey = `${new URL(baseUrl).pathname}/`;
  let viewerOpenLease: any = null;
  const canWrite = (token: string) => Boolean(writeSessions?.valid(token));
  const writableRequest = (request: any) => canWrite(request.headers["x-prism-write"]);

  // Archives one ended launched session, or every ended one the page lists, or unarchives one: behind the same page-origin and
  // write-session checks as an applied action, before anything is read or written. The mark stays on this machine and records no history.
  async function archiveRoute(request: any, response: any, archiving: boolean) {
    if (!fromPage(request)) {
      sendJson(response, 403, { code: "origin_refused", message: "A change must come from the review page as JSON." });
      return;
    }
    if (!writableRequest(request)) {
      sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
      return;
    }
    const invalid = () => sendJson(response, 400, { code: "invalid_request", message: archiving ? "The request must be a JSON object that names a launch, or sets ended to true." : "The request must be a JSON object that names a launch." });
    let body: any;
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
      const result = ended ? await archiveEndedLaunches({ projectRoot, env })
        : archiving ? await archiveLaunch({ projectRoot, id: body.launch, env })
          : await unarchiveLaunch({ projectRoot, id: body.launch, env });
      // Archiving resolves the session's no-result gate in the coordination state, so Attention reads it again.
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

  function removeViewer(response: any) {
    const viewer = viewers.get(response);
    if (!viewer) {
      return;
    }
    clearInterval(viewer.heartbeat);
    viewers.delete(response);
    reportViewers();
  }

  // A workspace's fetch timer runs while any page of it is connected, on its own stream or on the origin's shared one.
  function reportViewers() {
    workspace?.viewers?.(viewers.size + hub.count(hubKey));
  }

  function notify(event: any, data: any) {
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

  // While a page is connected, the server checks every second whether the files its views read changed, and tells every page with a records event,
  // so a page reads its index again when an agent or a sync changed the records instead of reading it on a short timer.
  let recordsWatch: any = null;
  let recordsVersion: number | null = null;
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

  function openViewerStream(response: any, writable: any) {
    const heartbeat = openEventStream(response, () => removeViewer(response));
    viewers.set(response, { heartbeat, writable });
    watchRecords();
    reportViewers();
    if (writable) clearViewerOpenLease();
    writeEvent(response, "session", sessionSnapshot());
    onViewer?.((event: any, data: any) => writeEvent(response, event, data));
  }

  // A tab joins the shared stream with its own write session, which decides whether it counts as a writable tab, exactly as its own stream would.
  // It starts from the session snapshot and the pending notices, sent on the shared stream for this page only.
  function joinHub(stream: any, tab: any, writable: any) {
    if (!hub.join(stream, tab, hubKey, writable)) return false;
    watchRecords();
    reportViewers();
    if (writable) clearViewerOpenLease();
    hub.send(stream, hubKey, "session", sessionSnapshot());
    onViewer?.((event: any, data: any) => hub.send(stream, hubKey, event, data));
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
    const refs = stored ? stored.entries.map((entry: any) => storeRefOf(entry.location)) : [];
    return new Set([...artifacts, ...sources, ...refs, ...await codeRefs()]);
  }

  // The review sources of each registered checkout of a workspace whose repository is known, by repository, holding a repository only while one of its checkouts lists its sources.
  async function codeSources() {
    const sources = new Map();
    for (const member of await workspace?.checkouts?.() ?? []) {
      if (!member.repository) continue;
      // The kept listing of each checkout, renewed behind as a checkout page's listing is, since listing a checkout checks every file.
      const files = await reviewListing(member.root).get().then((listing: any) => listing.sources, () => null);
      if (files === null) continue;
      const known = sources.get(member.repository) ?? new Set();
      for (const file of files) known.add(file);
      sources.set(member.repository, known);
    }
    return sources;
  }

  // A workspace page opens a code file that a store artifact links to by its ref, code:<repository>:<path>, as a tab like any other file,
  // whether a registered checkout lists it or the repository's code clone holds it at the remote's default branch.
  async function codeRefs() {
    const refs = [];
    for (const [repository, files] of await codeSources()) for (const file of files) refs.push(codeRefOf(repository, file));
    if (workspace?.code) {
      for (const repository of await storeRepositories()) for (const file of await workspace.code.defaultFiles(repository) ?? []) refs.push(codeRefOf(repository, file));
    }
    return refs;
  }

  // A workspace page's read of a code file by its ref, answered as a checkout's read of a review source is, from a registered checkout of that repository whose review sources list the path.
  async function serveCodeFile(response: any, ref: any, code: any) {
    for (const member of await workspace?.checkouts?.() ?? []) {
      if (member.repository !== code.repository) continue;
      if (!(await listReviewSources(member.root).catch((): any[] => [])).includes((code.path as any))) continue;
      let loaded;
      try { loaded = await loadArtifact(member.root, code.path); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const diagrams = (loaded.diagrams ?? []).map((diagram: any) => ({ ...diagram, path: codeRefOf(code.repository, diagram.path) }));
      send(response, 200, JSON.stringify({ ...loaded, diagrams, ref, path: ref, file: code.path, repository: code.repository }), "application/json; charset=utf-8");
      return;
    }
    // A path that no registered checkout lists is read from the repository's code clone at the remote's default branch, with the clone's own checks.
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

  // A code file that a clone holds but does not show answers 404 with why, so the page says the file is not shown rather than gone.
  // The quiet threshold and whether quiet branches show, as a Code request names them: { quietDays, showQuiet }, 30 days and hidden by default, or null for a value outside them.
  function codeShowing(url: any) {
    const days = url.searchParams.get("quietDays");
    const show = url.searchParams.get("showQuiet");
    if (days !== null && !/^[1-9][0-9]{0,2}$/.test(days)) return null;
    const quietDays = days === null ? QUIET_DAYS : Number(days);
    if (quietDays > 365 || (show !== null && show !== "true" && show !== "false")) return null;
    return { quietDays, showQuiet: show === "true" };
  }

  function withheldAnswer(read: any) {
    const why = read.withheld === "binary" ? "it is a binary file" : "it is over 512 KiB";
    return { code: "file_not_shown", reason: read.withheld, message: `${read.path} is not available here because ${why}, which the review app does not show.` };
  }

  // The owned branch names of one repository among the keys that branchOwners answers, which its branch model ranks as owned.
  const ownedIn = (owners: Map<string, any>, repository: string) => {
    const prefix = ownerKey(repository, "");
    return [...owners.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  };

  // How long the Code place's answer waits for a repository's branch read that it starts, so small repositories answer on the first request.
  const PLACE_READ_WAIT_MS = 5000;

  // The Code place's state of the work in progress and the other branches, read from every repository's branch model at once,
  // since a repository whose fetch is due holds its read for up to the fetch's wait: { answer, models, owners, slice }, or null while every repository with a clone is still read.
  async function codePlaceState(shown: { quietDays: number; showQuiet: boolean }) {
    const names = await storeRepositories();
    const owners = await branchOwners(projectRoot);
    const read = await Promise.all(names.map(async (name) => {
      const code = workspace?.code ? await workspace.code.state(name) : { state: "off" };
      const model = workspace?.code && code.state !== "off" ? await workspace.code.branches(name, ownedIn(owners, name), { waitMs: PLACE_READ_WAIT_MS }) : null;
      return { repository: { name, state: code.state, message: code.message ?? null }, model };
    }));
    const models = new Map<string, any>();
    const preparing: string[] = [];
    for (const { repository, model } of read) {
      if (model?.state === "preparing") preparing.push(repository.name);
      else if (model) models.set(repository.name, model);
    }
    if (preparing.length && !models.size) return null;
    const groups = await workGroups(projectRoot, await placedInitiatives(projectRoot));
    const progress = groups.groups.find((group: any) => group.key === "in-progress")?.initiatives ?? [];
    // Each slice's title and its agent, named as the Work sidebar names its claim's host: the host, or Agent, and then its model.
    const slices = new Map<string, { title: string; agent: string }>();
    const work = await Promise.all(progress.map(async ({ id, title }: any) => {
      const view = await loadInitiativeView(projectRoot, id).catch((): any => null);
      const records = view?.record?.slices ?? {};
      for (const [slug, slice] of Object.entries<any>(records)) {
        const claim = slice?.claim ?? slice?.expiredClaim ?? null;
        const host = typeof claim?.host === "string" && claim.host.trim() ? claim.host.trim() : "Agent";
        slices.set(ownerKey(id, slug), { title: slice?.title ?? slug, agent: typeof claim?.model === "string" && claim.model ? `${host} · ${claim.model}` : host });
      }
      return { initiative: id, title, root: view?.derived?.root ?? null, children: view?.derived?.children ?? {}, titles: Object.fromEntries(Object.entries<any>(records).map(([slug, slice]) => [slug, slice.title])) };
    }));
    const answer = placeAnswer({ repositories: read.map(({ repository }) => repository), models, preparing, owners, work, ...shown });
    return { answer, models, owners, slice: (owner: { initiative: string; slice: string }) => slices.get(ownerKey(owner.initiative, owner.slice)) ?? { title: owner.slice, agent: "Agent" } };
  }

  async function serveCodePlace(response: any, shown: { quietDays: number; showQuiet: boolean }) {
    const state = await codePlaceState(shown);
    // While every repository with a clone is still being read, the answer has nothing to show yet.
    if (!state) sendJson(response, 202, { state: "preparing" });
    else sendJson(response, 200, state.answer);
  }

  // The file paths, as `<path>\0<blob>`, that the passing verification runs of a slice recorded for a repository, read from its run records.
  async function verifiedFiles(repository: string, owner: { initiative: string; slice: string }) {
    const runs = await listRecordEntries(projectRoot, { kind: "runs", initiative: owner.initiative, slice: owner.slice }).catch((): any[] => []);
    const files = new Set<string>();
    for (const { entry } of runs) {
      if (entry?.kind !== "verification" || entry.passed !== true || entry.checkout?.repository !== repository || !Array.isArray(entry.files)) continue;
      for (const file of entry.files) if (typeof file?.path === "string") files.add(`${file.path}\0${typeof file.blob === "string" ? file.blob : ""}`);
    }
    return files;
  }

  // How long a request for a folder's entries or a file's versions waits for its reads, which go on in the background past it,
  // so a folder or file that many branches show answers 202 preparing until its reads are done rather than holding the request;
  // each finished answer is kept for its key, everything of the branch models that it reads, so the request after a 202 answers it without reading again,
  // with FILES_KEPT_BYTES of answers kept in all besides the latest one, and at most FILES_RUNS reads going on at once, each of at most PARALLEL Git processes,
  // with a read for a newer key of the same slot, its route, scope, quiet settings, and folder or path, as after tips move, stopping the earlier read at its next Git step;
  // a top-level listing that marks a repository's failed read is never kept, so a later request reads that repository again.
  const FILES_WAIT_MS = 5000;
  const FILES_KEPT_BYTES = 64 * 1024 * 1024;
  const FILES_RUNS = 8;
  const fileAnswers = keptAnswers({ waitMs: FILES_WAIT_MS, maxBytes: FILES_KEPT_BYTES, maxRuns: FILES_RUNS, keep: (answer) => !answer?.preparing && !answer?.entries?.some((entry: any) => entry.error) });
  // A kept answer's read, or its failed Git read's error, which is answered as stated and never kept, so a later request reads again.
  const readAnswer = async (key: string, work: (signal: AbortSignal) => Promise<any>, slot: string) => {
    try { return await fileAnswers.read(key, work, slot); }
    catch (error) {
      if (error instanceof ReadFailed) return { error };
      throw error;
    }
  };

  // The Code place's files tree, a file's versions, and a version's difference, for the lines of work of the scope that a request names.
  async function serveCodeFiles(response: any, route: string, url: any, shown: { quietDays: number; showQuiet: boolean }) {
    const state = await codePlaceState(shown);
    if (!state) {
      sendJson(response, 202, { state: "preparing" });
      return;
    }
    const fail = (error: any) => sendJson(response, error.status, { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) });
    const contentsOf = (repository: string) => workspace.code.contents(repository);
    if (route === "/api/code/diff") {
      const repository = url.searchParams.get("repository");
      const file = workspace.code.folder(url.searchParams.get("path") ?? "");
      if (!repository || !state.answer.repositories.some((each: any) => each.name === repository)) return fail({ status: 404, code: "repository_unknown", message: "The workspace has no repository of that name." });
      if (state.answer.preparing.includes(repository)) return sendJson(response, 202, { state: "preparing" });
      const contents = state.models.has(repository) ? await contentsOf(repository) : null;
      if (!contents) return fail({ status: 404, code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` });
      if (!file) return fail({ status: 404, code: "file_unavailable", message: "The path must name a file below the repository's root." });
      const answer: any = await fileDiff(state, repository, file, url.searchParams.get("branch") ?? "", contents).catch((error) => {
        if (error instanceof ReadFailed) return { error };
        throw error;
      });
      if (answer.error) fail(answer.error);
      else sendJson(response, 200, answer);
      return;
    }
    const scope = url.searchParams.get("scope") ?? "all";
    const lines = scopeLines(state, scope);
    if (!lines) return fail({ status: 404, code: "scope_unknown", message: "The Code place lists no work item, slice, or branch of that scope." });
    if (route === "/api/code/files") {
      const named = url.searchParams.get("folder");
      const folder = named === null || named === "" ? null : workspace.code.folder(named);
      if (named !== null && named !== "" && !folder) return fail({ status: 400, code: "invalid_request", message: "The folder must be a repository or a path below a repository's root." });
      const key = JSON.stringify(["files", folder, answerKey(state, lines), state.answer.repositories, state.answer.preparing]);
      const listed: any = await readAnswer(key, (signal) => listFiles(state, lines, folder, async (name) => {
        const contents = await contentsOf(name);
        return contents && stopping(contents, signal);
      }), readSlot("files", scope, shown, folder));
      if (listed === null) sendJson(response, 202, { state: "preparing" });
      else if (listed.error) fail(listed.error);
      else if (listed.preparing) sendJson(response, 202, { state: "preparing" });
      else sendJson(response, 200, { scope, folder: folder ?? null, entries: listed.entries });
      return;
    }
    const repository = url.searchParams.get("repository");
    const file = workspace.code.folder(url.searchParams.get("path") ?? "");
    if (!repository || !state.answer.repositories.some((each: any) => each.name === repository)) return fail({ status: 404, code: "repository_unknown", message: "The workspace has no repository of that name." });
    if (state.answer.preparing.includes(repository)) return sendJson(response, 202, { state: "preparing" });
    const contents = state.models.has(repository) ? await contentsOf(repository) : null;
    if (!contents) return fail({ status: 404, code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` });
    if (!file) return fail({ status: 404, code: "file_unavailable", message: "The path must name a file below the repository's root." });
    // One read at a time for each file and key of what it reads, which a later request joins.
    // The verified marks are read for each request, so a run that a store sync brings shows on an answer kept for unchanged tips.
    const key = JSON.stringify(["versions", repository, file, answerKey(state, lines)]);
    const answer: any = await readAnswer(key, (signal) => fileVersions(state, lines, repository, file, stopping(contents, signal)), readSlot("versions", scope, shown, repository, file));
    if (answer === null) sendJson(response, 202, { state: "preparing" });
    else if (answer.error) fail(answer.error);
    else sendJson(response, 200, await withVerified(answer, (owner: any) => verifiedFiles(repository, owner)));
  }

  // The code routes of a workspace's page, which read the code clones Prism keeps and never answer a URL of a Git host.
  async function serveCode(response: any, route: string, url: any) {
    const repository = url.searchParams.get("repository");
    const shown = codeShowing(url);
    if (!shown) {
      sendJson(response, 400, { code: "invalid_request", message: "quietDays must be a whole number of days from 1 to 365, and showQuiet must be true or false." });
      return;
    }
    if (route === "/api/code/place") {
      await serveCodePlace(response, shown);
      return;
    }
    if (route === "/api/code/files" || route === "/api/code/versions" || route === "/api/code/diff") {
      if (!workspace?.code) {
        sendJson(response, 404, { code: "repository_unknown", message: "The workspace has no repository of that name." });
        return;
      }
      await serveCodeFiles(response, route, url, shown);
      return;
    }
    if (!workspace?.code || !repository || !(await storeRepositories()).includes(repository)) {
      sendJson(response, 404, { code: "repository_unknown", message: "The workspace has no repository of that name." });
      return;
    }
    const off = () => sendJson(response, 404, { code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` });
    if (route === "/api/code/branches") {
      const owners = await branchOwners(projectRoot);
      const owned = (branch: string) => owners.get(ownerKey(repository, branch)) ?? [];
      const model = await workspace.code.branches(repository, ownedIn(owners, repository));
      if (model === null) off();
      else if (model.state === "preparing") sendJson(response, 202, { state: "preparing" });
      else {
        const now = Date.now();
        const branches = model.branches.map(({ commit, paths, blobs, ...branch }: any) => ({
          ...branch,
          // Days count whole, so a commit made a day ago is within a threshold of one day.
          quiet: isQuiet(branch, shown.quietDays, now),
          owners: branch.default ? [] : owned(branch.name).map(({ initiative, slice }) => ({ initiative, slice }))
        }));
        sendJson(response, 200, { repository, defaultBranch: model.defaultBranch, branches });
      }
    } else if (route === "/api/code/tree") {
      const folder = workspace.code.folder(url.searchParams.get("folder") ?? "");
      if (folder === null) {
        sendJson(response, 400, { code: "invalid_request", message: "The folder must be a path below the repository's root." });
        return;
      }
      const entries = await workspace.code.tree(repository, folder);
      if (entries === null) off();
      else sendJson(response, 200, { repository, folder, entries });
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

  // The roots of a workspace's checkouts on this machine, the checkout the page reads through first, or null for a checkout's own page,
  // so that a repository without a checkout here offers no action that needs one.
  async function machineCheckouts() {
    if (!workspace) return null;
    const own = await isStoreWithoutCheckout(projectRoot) ? [] : [{ root: projectRoot, repository: null }];
    const store = await recordStoreOf(projectRoot).catch(() => null);
    const folder = store?.external ? await realpath(store.base).catch(() => store.base) : null;
    return checkoutsOnMachine([...own, ...await workspace.checkouts?.() ?? []], (folder as any));
  }

  // The roots of the checkouts whose components a page offers as index targets, or null for a checkout's own page.
  async function checkoutRoots() {
    return (await machineCheckouts())?.map((checkout) => checkout.root) ?? null;
  }

  // A workspace's Knowledge search: the store artifacts of every scope that match, the code of each component whose checkout here has a ready index,
  // and every other component the workspace knows with why the search left it out.
  async function searchWorkspace(query: any) {
    const tokens = searchTokens(query);
    const stored = await workspaceStoreArtifacts(projectRoot);
    const checkouts = await machineCheckouts();
    const known = await knownComponents({ checkouts, repositories: (await storeRepositories() as any), scopes: stored?.scopes ?? [], clones: (workspace.code ? (repository: string) => workspace.code.components(repository) : null as any) });
    const checkedOut = new Set();
    for (const component of known) if (component.root !== null) checkedOut.add(component.repository);
    const leftOut = [];
    const searchable = new Map();
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
    leftOut.sort((left, right) => (left.component < right.component ? -1 : left.component > right.component ? 1 : 0));
    return { query: query ?? "", results: tokens ? await searchStoreArtifacts(projectRoot, stored, tokens) : [], code, leftOut };
  }

  // The code matches of one checkout's components whose index is ready, as search_repository_concepts answers them, each with its component,
  // and its other components, left out with no_index, or with search_failed when their search failed; a query of null searches nothing.
  async function searchCheckoutCode(root: string, components: any, query: any) {
    const status = await readIndexingStatus(root, intelligenceDirectories()).catch(() => null);
    const ready = components.filter((component: any) => componentIndexingStatus(status, component)?.state === "ready");
    const leftOut = components.filter((component: any) => !ready.includes(component)).map((component: any) => ({ component: component.identity, reason: "no_index" }));
    const code: any[] = [];
    if (query === null || !ready.length) return { code, leftOut };
    const { searchRepositoryConcepts } = await import("../repository-intelligence/semantic-native-provider.mjs");
    const listed = listComponents(await readWorkflowConfig(root).catch(() => null));
    const declared = Array.isArray(status?.components);
    const folders = listed.declared.filter((entry) => entry.folder !== "").map((entry) => entry.folder);
    for (const component of ready) {
      const folder = listed.declared.find((entry) => entry.component === component.identity)?.folder ?? "";
      // In a repository with components, the search names the component's own paths, so it reads only that component's index and starts no other build.
      const paths = !declared ? null : folder !== "" ? [folder] : rootComponentPaths(await listReviewSources(root).catch(() => []), folders);
      try {
        if (declared && (paths === null || !paths.length)) throw new Error("The root component's files cannot be named in one search.");
        const answer = await searchRepositoryConcepts(({ projectRoot: root, query, ...(paths ? { filters: { paths } } : {}) } as any));
        if (answer.status === "preparing") {
          leftOut.push({ component: component.identity, reason: "no_index" });
          continue;
        }
        for (const result of (answer.results ?? []) as any[]) if ((result.component ?? component.identity) === component.identity) code.push({ ...result, component: component.identity });
      } catch {
        leftOut.push({ component: component.identity, reason: "search_failed" });
      }
    }
    return { code, leftOut };
  }

  // The repositories a workspace's store registers, with those its registered checkouts name, by name.
  async function storeRepositories() {
    const store = await recordStoreOf(projectRoot).catch(() => null);
    const names = new Set(store?.external ? await registeredRepositories(store.base) : []);
    for (const member of await workspace?.checkouts?.() ?? []) if (member.repository) names.add(member.repository);
    if (store?.repository) names.add(store.repository);
    return [...names].sort();
  }

  // A workspace's code clones as a slice's files and presence read them, for the workspace's own repositories only, or null for a checkout's own page.
  async function sliceCode() {
    if (!workspace?.code) return null;
    const known = new Set(await storeRepositories());
    return {
      state: async (repository: string) => known.has(repository) ? workspace.code.state(repository) : { state: "off" },
      reachable: async (repository: string, commit: string) => known.has(repository) ? workspace.code.reachable(repository, commit) : null,
      branchesHolding: async (repository: string, commit: string) => known.has(repository) ? workspace.code.branchesHolding(repository, commit) : null,
      blobs: async (repository: string, commit: string, paths: string[]) => known.has(repository) ? workspace.code.blobs(repository, commit, paths) : null
    };
  }

  // Each repository of the workspace with its code content state.
  async function codeRepositories() {
    return Promise.all((await storeRepositories()).map(async (name) => ({ name, code: workspace?.code ? await workspace.code.state(name) : { state: "off" } })));
  }

  // What resolves the links of a scope's artifacts: the configured artifact kinds of a registered checkout of its repository, of the checkout the page reads through for the workspace scope, or else Prism's default paths,
  // the code repository its links to files name, that of the checkout the page reads through for the workspace scope or null without one, and the review sources registered checkouts of that repository list, or null with none.
  async function linkContext(scope: any) {
    const members = await workspace?.checkouts?.() ?? [];
    const reading = members.find((member: any) => member.root === projectRoot) ?? null;
    const repository = scope.repository ?? reading?.repository ?? null;
    const root = scope.repository ? members.find((member: any) => member.repository === scope.repository)?.root ?? null : projectRoot;
    const config = root ? await readWorkflowConfig(root).catch(() => null) : null;
    const sources = repository === null ? null : (await codeSources()).get(repository) ?? null;
    const cloned = repository === null || !workspace?.code ? null : await workspace.code.defaultFiles(repository);
    return { kinds: artifactKinds(config ?? parseWorkflowConfig("")), repository, sources, cloned };
  }

  // A workspace page's read of a store artifact by its ref, answered as a checkout's artifact read is, with its location, scope, links, and the count of links that resolve to nothing.
  async function serveStoreArtifact(response: any, ref: any, commentOffset: any) {
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
    const held = new Set((stored?.entries ?? []).map((entry: any) => entry.location));
    const content = read.bytes.toString("utf8");
    // Only a Markdown artifact's text is rendered with links, as the page renders it.
    const links = location.toLowerCase().endsWith(".md") ? resolveLinks({ content, location, ...await linkContext(read.scope), has: (candidate: any) => held.has(candidate) }) : [];
    const { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset } = read;
    const below = location.slice(scopePrefix(scope).length);
    const artifact = { scope, version, accepted, changed, acceptedFrom, comments, totalComments, nextCommentOffset, target: `artifact:${scope.label}:${below}` };
    const answer: any = { ref, path: ref, location, scope, content, modifiedAt: read.modifiedAt, artifact, links, unresolvedLinks: links.filter((link) => link.resolved === false).length };
    if (path.posix.extname(location).toLowerCase() === ".json") Object.assign(answer, { diagrams: [] }, await loadJsonArtifact(projectRoot, location, content));
    else answer.diagrams = await storeDiagrams(location, content, links, held);
    const view = read.path ? await loadDeclaredView(projectRoot, read.path).catch(() => null) : null;
    if (view) answer.view = view;
    send(response, 200, JSON.stringify(answer), "application/json; charset=utf-8");
  }

  // The PlantUML diagrams a store artifact shows: the files its links name, and the diagram beside it of the same name, or itself when it is one.
  async function storeDiagrams(location: any, content: any, links: any, held: any) {
    const wanted = new Set(links.filter((link: any) => link.resolved && link.target.startsWith(STORE_REF) && link.target.toLowerCase().endsWith(".puml")).map((link: any) => link.target.slice(STORE_REF.length)));
    if (location.toLowerCase().endsWith(".puml")) wanted.add(location);
    else if (held.has(location.replace(/\.[^./]+$/, ".puml"))) wanted.add(location.replace(/\.[^./]+$/, ".puml"));
    const diagrams = [];
    for (const at of wanted) {
      const found = at === location ? { bytes: Buffer.from(content, "utf8") } : await readStoreArtifactAt(projectRoot, at).catch(() => null);
      if (found) diagrams.push({ path: storeRefOf(at), source: found.bytes.toString("utf8") });
    }
    return diagrams;
  }

  // A workspace's tabs name store artifacts by their store location, so a tab stays the same artifact from every checkout of the workspace.
  async function storeTabs(tabs: any, from = projectRoot) {
    return workspace ? Promise.all(tabs.map((tab: any) => storeTabRef(from, tab))) : tabs;
  }

  async function storeRequest(request: any) {
    if (!workspace || !request || typeof request !== "object") return request;
    const named = { ...request };
    for (const key of ["openTabs", "agentTabs"]) if (Array.isArray(request[key])) named[key] = await storeTabs(request[key]);
    for (const key of ["activeTab", "previewTab"]) if (typeof request[key] === "string") named[key] = await storeTabRef(projectRoot, request[key]);
    return named;
  }

  async function assertAvailable(tabs: any, availableArtifacts: any) {
    for (const tab of tabs) {
      if (!availableArtifacts.has(tab) && !(parseEntityRef(tab) && await entityExists(projectRoot, tab))) {
        throw new Error(`The artifact is not available for review: ${tab}`);
      }
    }
  }

  // A tab on a record that Prism moved out of its legacy location follows the record to where it now lives.
  async function followMovedRecords(available: any) {
    const moves = await movedRecordTabs(projectRoot, session.openTabs, available);
    if (!moves.size) return sessionSnapshot();
    const follow = (tab: any) => moves.get(tab) ?? tab;
    const agentTabs = [...new Set(session.agentTabs.map(follow))];
    const previewTab = session.previewTab && follow(session.previewTab);
    const groups = session.groups.map((group: any) => ({ ...group, tabs: group.tabs.map(follow) }));
    return commitSession({ openTabs: [...new Set(session.openTabs.map(follow))], activeTab: session.activeTab && follow(session.activeTab), previewTab, agentTabs, groups, activeSource: session.activeSource });
  }

  // Reading the session first lets moved records' tabs follow them, so every reader sees the records where they now live.
  // Reads and changes of the session run in the order they arrive, so a page that reloads right after a change reads that change,
  // however long the file listing that each of them waits on takes, as it does on a slow disk.
  let sessionWork = Promise.resolve();
  function inSessionOrder(task: any) {
    const run = sessionWork.then(task);
    sessionWork = run.catch(() => {});
    return run;
  }

  async function currentSession() {
    return followMovedRecords(await reviewableFiles());
  }

  // Every change goes through here, so grouped tabs always sit side by side and neither an agent tab nor a grouped tab is ever the preview.
  function commitSession(proposed: any) {
    const arranged = arrangeGroups(proposed.openTabs, proposed.groups ?? session.groups);
    const grouped = new Set(arranged.groups.flatMap((group) => group.tabs));
    const previewTab = proposed.previewTab && !proposed.agentTabs.includes(proposed.previewTab) && !grouped.has(proposed.previewTab) ? proposed.previewTab : null;
    const next = { ...proposed, ...arranged, previewTab };
    const changed = ["openTabs", "agentTabs"].some((key) => next[key].length !== session[key].length || next[key].some((tab: any, index: number) => tab !== session[key][index]))
      || JSON.stringify(next.groups) !== JSON.stringify(session.groups)
      || next.activeTab !== session.activeTab || next.previewTab !== session.previewTab || next.activeSource !== session.activeSource;
    if (changed) {
      session = { ...next, revision: session.revision + 1 };
      notify("session", sessionSnapshot());
    }
    return sessionSnapshot();
  }

  // The browser owns the preview tab: one replaceable tab for browsing, while kept and agent tabs stay open.
  async function updateSession(given: any) {
    const request = await storeRequest(given);
    const available = await reviewableFiles();
    await followMovedRecords(available);
    // A page that has not yet seen a record move still names its old path, which follows the record the same way.
    const moves = await movedRecordTabs(projectRoot, normalizeTabs(request.openTabs), available);
    const follow = (tab: any) => typeof tab === "string" ? moves.get(tab) ?? tab : tab;
    const body = { ...request, openTabs: [...new Set(normalizeTabs(request.openTabs).map(follow))] };
    for (const key of ["activeTab", "previewTab"]) if (Object.hasOwn(request, key)) body[key] = follow(request[key]);
    if (Object.hasOwn(request, "agentTabs")) body.agentTabs = [...new Set(normalizeTabs(request.agentTabs).map(follow))];
    const requestedTabs = body.openTabs;
    // A tab that is already open may name a file that is gone, so the page can keep it open and offer to close it.
    const added = requestedTabs.filter((tab: any) => !session.openTabs.includes(tab));
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
    let agentTabs = session.agentTabs.filter((tab: any) => requestedTabs.includes(tab));
    if (Object.hasOwn(body, "agentTabs")) {
      const requestedAgentTabs = normalizeTabs(body.agentTabs);
      if (requestedAgentTabs.some((tab) => !requestedTabs.includes(tab))) {
        throw new Error("Agent tabs must be open tabs.");
      }
      agentTabs = requestedAgentTabs;
    }
    const groups = Object.hasOwn(body, "groups") ? checkGroups(body.groups, requestedTabs, follow, new Map(session.groups.filter((group: any) => group.opener).map((group: any) => [group.name, group.opener]))) : session.groups;
    if (requestedTabs.length === 0) {
      nextActiveTab = null;
    }
    // A window names itself with a short id; an active tab it did not choose keeps its source.
    const source = typeof body.source === "string" && /^[\w-]{1,64}$/.test(body.source) ? body.source : "page";
    const activeSource = nextActiveTab === session.activeTab ? session.activeSource : source;
    return commitSession({ openTabs: requestedTabs, activeTab: nextActiveTab, previewTab, agentTabs, groups, activeSource });
  }

  // get_review_url adds tabs the same way present_review does, so neither tool closes the human's tabs.
  async function setOpenTabs(tabs: any, options: any) {
    return (await presentTabs(tabs, options)).openTabs;
  }

  // present_review adds agent tabs beside the human's tabs and focuses the first one without replacing the preview.
  // A workspace's review takes the tabs as from, the presenting checkout, names them, and reads through that checkout once a tab is one that only it shows, such as one of its source files.
  // A group name gathers the presented tabs into that group, made when no group has the name yet, and shows the group expanded;
  // a tab already in another group moves into it, and tabs presented without a name keep the groups they are in.
  // by names the presenting agent as { holder, host, model }; the group records its harness, its model, and the slice of the live claim
  // that agent renewed last as the group's opener, and never the holder.
  async function presentTabs(tabs: any, { group, from = projectRoot, by = null }: any = {}) {
    const requestedTabs = [...new Set(await storeTabs(normalizeTabs(tabs), from))];
    const groupName = group === undefined || group === null ? null : groupNameOf(group);
    let available = await reviewableFiles((requestedTabs as any));
    if (workspace && from !== projectRoot && requestedTabs.some((tab) => !available.has(tab) && !parseEntityRef(tab))) {
      useCheckout(from);
      available = await reviewableFiles((requestedTabs as any));
    }
    await assertAvailable(requestedTabs, available);
    await followMovedRecords(available);
    if (requestedTabs.length === 0) {
      if (session.openTabs.includes("attention")) {
        return commitSession({ ...session, activeTab: "attention", activeSource: "agent" });
      }
      // Attention opens in the preview tab, replacing whatever the preview showed.
      const openTabs = [...session.openTabs.filter((tab: any) => tab !== session.previewTab), "attention"];
      return commitSession({ openTabs, activeTab: "attention", previewTab: "attention", agentTabs: session.agentTabs, activeSource: "agent" });
    }
    const openTabs = [...session.openTabs, ...requestedTabs.filter((tab) => !session.openTabs.includes(tab))];
    const agentTabs = [...session.agentTabs, ...requestedTabs.filter((tab) => !session.agentTabs.includes(tab))];
    const previewTab = requestedTabs.includes(session.previewTab) ? null : session.previewTab;
    const groups = groupName ? joinGroup(session.groups, groupName, requestedTabs, (by ? await openerFor(by) : null as any)) : session.groups;
    return commitSession({ openTabs, activeTab: requestedTabs[0], previewTab, agentTabs, groups, activeSource: "agent" });
  }

  // The opener of a group an agent presents: its harness and model, and the slice of its live claim renewed last, when it holds one.
  async function openerFor(by: any) {
    const holder = typeof by?.holder === "string" && by.holder ? by.holder : null;
    let claim: any = null;
    if (holder) {
      const read = () => withRecordReads(() => loadHeldClaims(projectRoot));
      const held = await (workspace ? asWorkspaceView(read) : read()).catch(() => ({ claims: [] }));
      const now = Date.now();
      claim = held.claims.filter((entry: any) => entry.holder === holder && !entry.expired && Date.parse(entry.expiresAt) > now)
        .sort((left: any, right: any) => Date.parse(right.renewedAt ?? right.claimedAt) - Date.parse(left.renewedAt ?? left.claimedAt))[0]?.ref ?? null;
    }
    return openerOf({ host: by?.host, model: by?.model, claim });
  }

  // A workspace's review reads through one checkout of the workspace, whose source files, index, and configured paths the page shows.
  function useCheckout(root: string) {
    if (root === projectRoot) return;
    projectRoot = root;
    fingerprint = null;
  }

  function closeViewerStreams() {
    clearViewerOpenLease();
    if (recordsWatch) clearInterval(recordsWatch);
    recordsWatch = null;
    // A shared hub serves other pages too, so only a hub of this page alone closes with its viewers.
    if (!sharedHub) hub.close();
    for (const response of viewers.keys()) {
      removeViewer(response);
      response.end();
    }
  }

  // A page's reads resolve the record store and its folders once per request; the event streams stay open for the page's life, so they read afresh.
  // A workspace's page reads every scope's store artifacts in its libraries, and a checkout's own page reads the checkout's paths.
  function handle(request: any, response: any, route: string, url: any) {
    const read = () => request.method !== "GET" || route.startsWith("/api/events") ? serve(request, response, route, url) : withRecordReads(() => serve(request, response, route, url));
    return workspace ? asWorkspaceView(read) : read();
  }

  async function serve(request: any, response: any, route: string, url: any) {
    if (await servePageRoute(request, response, route)) {
      // The page, its assets, and the preferences are the same for every page.
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
      // A workspace's page lists every scope's store artifacts by store location in place of the checkout's paths of its own.
      const stored = workspace ? await workspaceStoreArtifacts(projectRoot) : null;
      let storeIndex: any = null;
      if (stored) {
        const isArtifact = await artifactPathTest(projectRoot);
        storeIndex = await workspaceIndex(projectRoot, stored, scopeFilterOf(url), storeRepositories);
        artifacts = [...artifacts.filter((file: string) => !isArtifact(file)), ...storeIndex.refs];
      }
      const available = new Set([...artifacts, ...sources, ...(storeIndex?.every ?? []), ...(workspace ? await codeRefs() : [])]);
      const snapshot = await followMovedRecords(available);
      // A code file's tab is the Code place's file view, which says itself when no version of the file is shown, so it is never missing while its repository is registered.
      const repositories = workspace ? await storeRepositories() : [];
      for (const tab of snapshot.openTabs) {
        const repository = parseCodeRef(tab)?.repository;
        if (repository && repositories.includes(repository)) available.add(tab);
      }
      const missingTabs = await findMissingTabs(snapshot.openTabs, available, (ref: any) => entityExists(projectRoot, ref));
      // A workspace read through its store's clone alone has no checkout to name.
      const checkout = workspace && await isStoreWithoutCheckout(projectRoot) ? null : await readWorkspaceIdentity(projectRoot);
      const named = workspace ? { workspace: await workspace.describe(), checkout, storeRefs: await storeArtifactRefs(projectRoot), sync: await workspace.sync?.() ?? null, repositories: await codeRepositories() } : { workspace: checkout };
      const scoped = storeIndex ? { artifactScopes: storeIndex.artifactScopes, scopes: storeIndex.scopes, ...(storeIndex.scopeFilter ? { scopeFilter: storeIndex.scopeFilter, unknownScopes: storeIndex.unknownScopes } : {}), notes: storeIndex.notes } : { artifactScopes: await listArtifactScopes(projectRoot) };
      send(response, 200, JSON.stringify({ projectRoot, ...named, artifacts, ...scoped, sources, navigation: await loadNavigation(projectRoot), recordStore: await describeRecordStore(projectRoot).then(async (store) => ({ ...store, workspaceName: store.kind === "project" ? null : await readWorkspaceName(projectRoot), ...await checkoutArtifactsOf(projectRoot, store), watching: await viewWatching(projectRoot).catch(() => null) })).catch(() => null), storeSync: await recordSyncStatus(projectRoot), ...snapshot, missingTabs, version: appVersion ?? pluginVersion(), ...(privateServer ? { privateServer } : {}) }), "application/json; charset=utf-8");
    } else if (["/api/code/place", "/api/code/files", "/api/code/versions", "/api/code/diff", "/api/code/branches", "/api/code/tree", "/api/code/file", "/api/code/components"].includes(route) && request.method === "GET") {
      await serveCode(response, route, url);
    } else if (route === "/api/slice-files" && request.method === "GET") {
      const ref = `slice:${url.searchParams.get("initiative") ?? ""}/${url.searchParams.get("slice") ?? ""}`;
      const parsed = parseEntityRef(ref);
      if (parsed?.kind !== "slice" || !(await entityExists(projectRoot, ref))) {
        sendJson(response, 404, { code: "slice_unknown", message: "The project has no slice of that initiative and slug." });
        return;
      }
      sendJson(response, 200, await sliceFiles(projectRoot, parsed.id, parsed.slug, (await sliceCode() as any)));
    } else if ((route === "/api/frozen-test" || route === "/api/verification-log") && request.method === "GET") {
      // A slice's Verification tab opens one of its frozen tests, or one of its runs' logs, in the side panel.
      const ref = `slice:${url.searchParams.get("initiative") ?? ""}/${url.searchParams.get("slice") ?? ""}`;
      const parsed = parseEntityRef(ref);
      if (parsed?.kind !== "slice" || !(await entityExists(projectRoot, ref))) {
        send(response, 404, "The project has no slice of that initiative and slug.");
        return;
      }
      const found = route === "/api/frozen-test"
        ? await frozenTestFile(projectRoot, parsed.id, parsed.slug, url.searchParams.get("path") ?? "").catch(() => null)
        : await verificationLog(projectRoot, parsed.id, parsed.slug, url.searchParams.get("id") ?? "").catch(() => null);
      // A refusal is one sentence of text, which the side panel shows as it is.
      if (found) sendJson(response, 200, found);
      else send(response, 404, route === "/api/frozen-test" ? "The slice's accepted design freezes no test at that path, or no copy of it is left." : "The slice has no verification run with that id.");
    } else if (route === "/api/store/conflicts" && request.method === "GET") {
      // Saved local record versions are read-only here; a person redoes a lost change through an agent.
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
        const listed = await listActions({ projectRoot, target: url.searchParams.get("target"), indexer, checkouts: await checkoutRoots(), reads: actionListingReads });
        sendJson(response, 200, { target: listed.target, writable: writableRequest(request), actions: listed.actions });
      } catch (error) {
        sendActionError(response, error);
      }
    } else if (route === "/api/launches" && request.method === "GET") {
      // Every launched session of this machine that shares this checkout's record store; reading needs no write session.
      sendJson(response, 200, await listLaunches({ projectRoot, env: process.env }));
    } else if (route === "/api/run-options" && request.method === "GET") {
      // A read starts a host process, so only the page's write session may ask, and a refused query starts nothing.
      if (!writableRequest(request)) {
        sendJson(response, 403, { code: "write_forbidden", message: READ_ONLY_NOTICE });
        return;
      }
      try {
        sendJson(response, 200, await readRunOptions({ ...runOptionsQuery(url.searchParams, process.env), checkout: projectRoot, env: process.env }));
      } catch (error) {
        if (error?.name !== "RunOptionsError") throw error;
        sendJson(response, error.status, { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
      }
    } else if (route === "/api/coding-agents" && request.method === "GET") {
      // The registry state, the registry agents for this computer with their install and update marks, and the installed and declared
      // ACP agents with their launch availability, which stay listed while the registry is down; reading needs no write session.
      sendJson(response, 200, await listCodingAgents({ env: process.env }));
    } else if (route === "/api/agents" && request.method === "GET") {
      // Every agent once: this computer's launched sessions and the workspace's claims that none of them holds; reading needs no write session.
      sendJson(response, 200, await listAgents({ projectRoot, env: process.env }));
    } else if (route === "/api/personal-settings" && request.method === "GET") {
      // The person's own settings for this project, adopting each value the project still records; reading needs no write session.
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
        const result: any = await applyAction({ projectRoot, target: body.target, action: body.action, input: body.input, revision: body.revision, confirmed: body.confirmed, via: "review-app", indexer, checkouts: await checkoutRoots() });
        // A wake changes what the page shows even when its history entry could not be recorded.
        if (result.applied || result.wake !== undefined) forgetWorkspace();
        // A launch, stop, or resume also answers with the launched session it changed, and a wake with whether it arrived and any warning that its history entry was not recorded; an approval's or comment's artifact stays in the event alone.
        sendJson(response, 200, { applied: result.applied, actions: result.actions, ...(result.launch !== undefined ? { launch: result.launch } : {}), ...(result.wake !== undefined ? { wake: result.wake } : {}), ...(result.warnings !== undefined ? { warnings: result.warnings } : {}) });
        if (result.applied) {
          const target = parseTarget(result.applied.target);
          // An approval or a comment belongs to no initiative, so its event names its artifact, as Attention's recent changes list it.
          const event = { ...result.applied, initiative: target?.initiative ?? (target?.kind === "launch" ? result.launch?.initiative ?? null : null), ...(result.artifact ? { artifact: result.artifact } : {}) };
          if (onAction) await Promise.resolve(onAction(event, { shared: !["index", "machine", "agent"].includes(target?.kind), comment: result.comment ?? null })).catch(() => {});
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
      if (["initiative", "slice", "migration-run"].includes(parseEntityRef(ref)?.kind) && !(await entityExists(projectRoot, ref))) {
        send(response, 404, "The item no longer exists in this project.");
        return;
      }
      if ((parseEntityRef(ref)?.kind === "code" || parseCodeRef(ref)) && workspace) {
        // Every Code address, a code file's among them, answers the Code page, which reads its tree, versions, and differences from the Code routes itself;
        // the page names each repository's state alone, so a fetch that moves a branch tip does not draw the page the person is reading again.
        const repositories = (await codeRepositories()).map(({ name, code }) => ({ name, state: code.state, message: code.message ?? null }));
        sendJson(response, 200, { ref, kind: "code", data: { repositories, file: parseCodeRef(ref) } });
        return;
      }
      const entity: any = await loadEntity(projectRoot, ref, { intelligenceDirectories: intelligenceDirectories() });
      // A slice names work that exists only on the machine that holds it, unpushed or uncommitted, by its branch and host and never by its content.
      if (entity.kind === "slice") {
        const code = await sliceCode();
        entity.presence = await slicePresence(projectRoot, entity.data.id, entity.data.slug, { reachable: code ? code.reachable : undefined, shipped: await shippedCommit(projectRoot, entity.data.id, entity.data.slug) });
      }
      send(response, 200, JSON.stringify(entity), "application/json; charset=utf-8");
    } else if (route === "/api/attention" && request.method === "GET") {
      // The count of waiting questions alone, which a page in a background tab reads to raise its desktop notification.
      send(response, 200, JSON.stringify({ gates: (await loadAttention(projectRoot)).gateCount }), "application/json; charset=utf-8");
    } else if (route === "/api/claims" && request.method === "GET") {
      send(response, 200, JSON.stringify(await loadClaims(projectRoot)), "application/json; charset=utf-8");
    } else if (route === "/api/evidence") {
      send(response, 200, JSON.stringify(await loadEvidence(projectRoot, url.searchParams.get("id"), evidenceStore())), "application/json; charset=utf-8");
    } else if (route === "/api/indexing" && request.method === "GET") {
      send(response, 200, JSON.stringify(await indexingStatus()), "application/json; charset=utf-8");
    } else if (route === "/api/records/search" && request.method === "GET") {
      // The Knowledge search: requirements, decisions, glossary terms, and diagrams whose title or text holds every word.
      send(response, 200, JSON.stringify(await searchRecords(projectRoot, url.searchParams.get("q"))), "application/json; charset=utf-8");
    } else if (route === "/api/touched" && request.method === "GET") {
      // Touched by my work: the records behind one slice, what its contract cites and what its work changes.
      try {
        send(response, 200, JSON.stringify(await touchedRecords(projectRoot, url.searchParams.get("slice"))), "application/json; charset=utf-8");
      } catch (error) {
        if (!(error instanceof TouchedError)) throw error;
        send(response, error.status, JSON.stringify({ code: error.code, error: error.message }), "application/json; charset=utf-8");
      }
    } else if (route === "/api/changed" && request.method === "GET") {
      // Changed this week: the record files changed in the last 7 days, read from Git on each request.
      send(response, 200, JSON.stringify(await loadRecordChanges(projectRoot)), "application/json; charset=utf-8");
    } else if (route === "/api/search") {
      const query = url.searchParams.get("q");
      send(response, 200, JSON.stringify(workspace ? await searchWorkspace(query) : await searchArtifacts(projectRoot, query)), "application/json; charset=utf-8");
    } else if (route === "/api/artifact") {
      const artifactPath = url.searchParams.get("path");
      // A store artifact's comments come one page at a time from commentOffset, which names a whole number of at least 1 in ASCII digits.
      const commentOffset = url.searchParams.has("commentOffset") ? url.searchParams.get("commentOffset") : "1";
      if (!/^[0-9]+$/.test(commentOffset) || Number(commentOffset) < 1) {
        send(response, 400, "commentOffset names the 1-based position of the first comment to read, a whole number of at least 1 in ASCII digits.");
        return;
      }
      // A workspace's page reads a store artifact by its ref, store:<location>, which it also passes as the path of the page that shows it.
      // A code file that a store artifact links to is read the same way by its ref, code:<repository>:<path>.
      const ref = url.searchParams.get("ref") ?? (artifactPath?.startsWith(STORE_REF) || parseCodeRef(artifactPath) ? artifactPath : null);
      if (ref !== null) {
        const code = parseCodeRef(ref);
        if (!workspace) send(response, 404, "Only a workspace's page reads a store artifact or a code file by its ref.");
        else if (code) await serveCodeFile(response, ref, code);
        else await serveStoreArtifact(response, ref, Number(commentOffset));
        return;
      }
      // Only listed documents and filtered source files are served, never an arbitrary project path such as .env.
      // A path that leaves the project still fails here, while a moved or deleted file answers 404 below.
      await resolveProjectFile(projectRoot, artifactPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      // An artifact path whose store cannot be reached is refused with the store's reason, never answered with the checkout's bytes.
      const refusal = await inArtifactStore(projectRoot, artifactPath) ? await artifactStoreRefusal(projectRoot) : null;
      if (refusal !== null) {
        send(response, 503, refusal);
        return;
      }
      const { artifacts, sources } = await listedFiles(projectRoot, [(artifactPath as any)]);
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
        // A file deleted after the listing above answers the same as an unlisted one.
        if (error.code !== "ENOENT") throw error;
        send(response, 404, "The file is not available for review.");
        return;
      }
      // A requirement, decision, glossary, or feature file that breaks its format carries its mark, which the page shows above the document.
      loaded = { ...loaded, format: await loadFormatMark(projectRoot, artifactPath, loaded.artifact?.scope ?? null) };
      // A design view that its folder declares carries its kind, question, clauses, and governing contract.
      const view = await loadDeclaredView(projectRoot, artifactPath).catch(() => null);
      send(response, 200, JSON.stringify(view ? { ...loaded, view } : loaded), "application/json; charset=utf-8");
    } else if (wantsPage(request) && !/^\/(api|kit|styles|views|vendor)\//.test(route)) {
      // A page address the app no longer has, such as one from an earlier release, opens the project's start page instead of a line of text.
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
    reviewUrl(artifactPaths: any) {
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

export async function startReviewServer(options: any = {}) {
  const browserOpener = options.openBrowser ?? openBrowser;
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? process.cwd()));
  // The workspace cache is shared by the process, so a new server starts from the records as they are, not as an earlier server read them within the cache window.
  forgetWorkspace();
  const token = randomBytes(24).toString("base64url");
  const prefix = `/session/${token}`;
  let review: any;
  // A request answers a browser, never a tool call, so no store access in it moves a checkout's artifacts, even on a server that a tool call started.
  const server = createServer((request, response) => outsideToolCall(async () => {
    try {
      if (!isTrustedHost(request.headers.host)) {
        send(response, 403, "Unknown host");
        return;
      }
      const url = new URL((request.url as any), "http://127.0.0.1");
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${(address as any).port}${prefix}`;
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
    async open(artifactPaths: any, options?: any) {
      const tabs = normalizeTabs(artifactPaths);
      await review.presentTabs(tabs, options);
      const url = review.reviewUrl(tabs);
      if (!review.claimBrowserOpen()) {
        return { url, opened: false, ...review.getSession() };
      }
      // Only the browser Prism opens receives a grant, in the fragment; the URL this answers carries none.
      const opened = Boolean(await browserOpener(withWriteGrant(url, writeSessions.issueGrant())));
      if (!opened) {
        review.releaseBrowserOpen();
      }
      return { url, opened, ...(opened ? {} : { openFailed: true }), ...review.getSession() };
    },
    close() {
      review.closeViewers();
      // An open page reuses its keep-alive sockets to poll and to reopen its event stream, so a close that waited for them would last as long as the page.
      server.closeAllConnections?.();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
