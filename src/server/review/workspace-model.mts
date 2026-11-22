import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readInitiativeRecordRunTotals } from "../session/run-totals.mjs";
import { storeLocation } from "../session/launch-records.mjs";
import { pendingRequests } from "../session/permission-requests.mjs";
import { readInitiative, readInitiativeWithClaims, sliceFolder } from "../workflow/initiative.mjs";
import { isLive, parseClaim } from "../workflow/slice-claims.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { DISPLAY_BANDS, readRoadmap } from "../workflow/roadmap.mjs";
import { historyOrder, readCoordinationState } from "../workflow/state.mjs";
import { readIndexHistory } from "../workflow/index-history.mjs";
import { inArtifactStore, isStoreWithoutCheckout, keyOfPath, listClaimRecords, listInitiatives, listSliceRecords, listStoreArtifacts, locateRecord, readArtifactText, recordPath, recordsUnavailable, resolveRecordFile } from "../workflow/record-store.mjs";
import { initiativeDirectory, readWorkflowConfig as readCheckoutConfig } from "../workflow/workflow-config.mjs";
import { latestVerification, verifiedCode } from "../workflow/slice-design.mjs";
import { lastChangeMapDerivation, startChangeMapDerivation } from "../conservation/derived-change-map.mjs";
import { contractClauses, loadDesignView } from "../workflow/design-view.mjs";
import { declaredView, governingContract, readViews, VIEW_KINDS } from "../workflow/view-declarations.mjs";
import { appliedArtifactActions, pendingApprovalGates, readStoreArtifactAt, storeArtifactStatuses, workspaceArtifacts } from "../workflow/store-artifacts.mjs";
import { servedWorkItem } from "../workflow/artifact-status.mjs";
import { readPublishedUnits } from "../repository-intelligence/index-status.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { checkArtifacts } from "../workflow/artifact-check.mjs";
import { ARTIFACT_FORMATS } from "../workflow/artifact-formats.mjs";
import { entriesFor, recommendedChoice, statementMap } from "../workflow/format-migrations.mjs";
import { RUN_ID, allRuns, followedRun, followingRun, readRun, shownRun } from "../workflow/migration-runs.mjs";
import { recordChanges } from "./record-changes.mjs";
import { relativeLinkTargets } from "./artifact-links.mjs";
import { shippedActionReason, shippedDecision, shippedHistory, shippedHistoryLabel } from "../workflow/shipped-history.mjs";
import { keptSession, sessionFields } from "../session/session-links.mjs";
import { failingTestLinks } from "./verification-view.mjs";

// A workspace read through its store's clone alone has no checkout and so no configuration of its own: its defaults are no setting to warn about.
async function readWorkflowConfig(projectRoot: string) {
  const config = await readCheckoutConfig(projectRoot);
  return await isStoreWithoutCheckout(projectRoot) ? { ...config, diagnostics: [] } : config;
}

const LIBRARY_LIMIT = 500;
const RECENT_CHANGES_LIMIT = 20;
const SLICE_FILE_LIMIT = 200;
const UNRESOLVED = new Set(["OPEN", "IN PROGRESS", "REOPENED"]);
// Each open page polls every 1.5 s, and one poll reads every record several times, so results are shared for a second.
// The review server clears the cache after its own writes; writes from agents show up within the window.
const MEMO_MS = 1000;
const memo = new Map();

// A workspace's page reads every scope's store artifacts; a checkout's own page reads its own paths, so the memo keeps the two apart.
const workspaceView = new AsyncLocalStorage();
const inWorkspaceView = () => workspaceView.getStore() === true;

/** Run reads as a workspace's page makes them, listing every scope's store artifacts by store location. */
export function asWorkspaceView(run: any): Promise<any> {
  return workspaceView.run(true, run);
}

function remember(raw: any, compute: any) {
  const key = `${inWorkspaceView() ? "workspace" : "checkout"}|${raw}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = compute();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

export function forgetWorkspace() {
  memo.clear();
}

/** The format mark of a checked artifact: null while it conforms, else { rules, findings } with its sorted rule ids and its findings as check_artifacts reports them. */
export const formatMark = (artifact: any) => !artifact || artifact.conforms ? null : { rules: [...new Set(artifact.findings.map((finding: any) => finding.rule))].sort(), findings: artifact.findings };

const scopeKey = (scope: any): string => scope === null || scope === undefined ? "" : typeof scope === "string" ? scope : scope.label ?? "";

// A lookup of the format mark of each checked artifact by path and scope: markOf(path, scope) is its mark, or null for a conforming or unchecked file.
function markLookup(artifacts: any[]) {
  const marks = new Map(artifacts.map((artifact: any) => [`${scopeKey(artifact.scope)}\0${artifact.path}`, formatMark(artifact)]));
  return (file: string, scope: any = null) => marks.get(`${scopeKey(scope)}\0${file}`) ?? null;
}

const marksKey = (projectRoot: string) => `format-marks:${projectRoot}`;

/**
 * The format marks of the project's artifacts, shared for the cache window, so the lists of one request check each artifact once;
 * a project whose artifacts cannot be checked marks nothing.
 */
export function loadFormatMarks(projectRoot: string): Promise<(file: string, scope?: any) => any> {
  return remember(marksKey(projectRoot), async () => {
    try { return markLookup((await checkArtifacts({ projectRoot, startRuns: false })).artifacts); }
    catch { return () => null; }
  });
}

/** The format mark of one artifact by path and, for a store artifact, its scope, checked afresh: null while it conforms or is no artifact that check_artifacts lists. */
export async function loadFormatMark(projectRoot: string, file: string, scope: any = null) {
  try {
    const label = scopeKey(scope);
    const [artifact] = (await checkArtifacts({ projectRoot, paths: [label ? { path: file, scope: label } : file], startRuns: false })).artifacts;
    return formatMark(artifact);
  } catch {
    return null;
  }
}

export const SECTION_REFS = Object.freeze(["attention", "roadmap", "requirements", "decisions", "glossary", "code", "agents"]);
const SECTION_LABELS: Readonly<Record<string, any>> = Object.freeze({ attention: "Attention", roadmap: "Roadmap", requirements: "Requirements", decisions: "Decisions", glossary: "Glossary", code: "Code", agents: "Agents" });
// The Agents page's Show choices that an address can make: agents:<group>.
export const AGENT_GROUP_PAGES = Object.freeze(["needs-you", "this-computer", "other", "expired", "archived"]);

// A record is read where it lives: under .prism, or beside its Markdown until the first write moves it there.
async function recordFile(root: string, key: any) {
  const located: any = await locateRecord(root, key);
  // A record not yet moved is shown where it lies; any other keeps its .prism address, also when a record store holds its file.
  return located.legacy ?? located.path;
}

// With a record store, a descriptive artifact such as a requirement, an ADR, the glossary, or a plan file is read from the store, and a record where it lives.
async function readText(root: string, relative: string) {
  try {
    if (relative.startsWith(STORE_REF)) {
      const held = await readStoreArtifactAt(root, relative.slice(STORE_REF.length));
      return held ? textOf(held.bytes) : null;
    }
    // An unavailable store or a refused repository name shows the artifact as missing, never the checkout's file in its place.
    if (await inArtifactStore(root, relative)) return await readArtifactText(root, relative);
    return await readFile((await resolveRecordFile(root, relative)).target, "utf8");
  } catch (error) {
    // An unavailable store, or a store artifact that cannot be read, shows as missing.
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code) || recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }
}

// A workspace's pages name each store artifact by its store location, store:<location>, and read the artifacts of every scope the store holds.
const STORE_REF = "store:";
const storeRef = (location: any) => `${STORE_REF}${location}`;
const textOf = (bytes: any) => Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");

/**
 * Every scope's artifacts that the project's store holds, as workspaceArtifacts lists them, or null outside a workspace's page, when the project reads no store, its store cannot be read,
 * or the store holds no artifacts folder yet, so that the checkout's own files list as before.
 */
function workspaceListing(projectRoot: string) {
  if (!inWorkspaceView()) return Promise.resolve(null);
  return remember(`workspace-listing:${projectRoot}`, () => workspaceArtifacts(projectRoot).then((listed) => listed.held ? listed : null, (error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }));
}

/**
 * The artifacts of one store kind (requirements, adrs, plans, or glossary) of every scope whose file name passes accept, at most the library limit,
 * each as { ref, location, path, scope, label, rest, status }, with own, a test of whether a scope is the workspace or one of the checkout's repository; or null without a listing.
 */
async function scopedArtifacts(projectRoot: string, kind: any, accept: any) {
  const listed = await workspaceListing(projectRoot);
  if (!listed) return null;
  const entries = listed.entries.filter((entry: any) => entry.kind === kind && accept(path.posix.basename(entry.location)))
    .slice(0, LIBRARY_LIMIT)
    .map((entry: any) => ({ ...entry, ref: storeRef(entry.location), label: entry.scope.label }));
  const own = (scope: any) => scope.kind === "workspace" || (listed.repository !== null && scope.repository === listed.repository);
  return { entries, own };
}

// The store ref of the artifact at a checkout path, among entries: the one in the given scope, else in the checkout's own scopes, else the workspace's, else the first; or null.
function refAt(entries: any, own: any, file: string, label = null) {
  const holding = entries.filter((entry: any) => entry.path === file);
  if (!holding.length) return null;
  return (holding.find((entry: any) => entry.label === label) ?? holding.find((entry: any) => entry.scope.kind !== "workspace" && own(entry.scope)) ?? holding.find((entry: any) => entry.scope.kind === "workspace") ?? holding[0]).ref;
}

// Counts of entries by scope label.
function countByScope(entries: any, labelOf = (entry: any) => entry.scope ?? entry.label) {
  const counts: Record<string, any> = {};
  for (const entry of entries) {
    const label = labelOf(entry);
    if (label) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

// The store artifacts below a folder, up to depth folders down, in the order a walk of the folder lists them, or null when the project names no store.
async function storeWalk(root: string, relative: string, depth: number, accept: any, limit: number) {
  // An unavailable store or a refused repository name lists no artifact, and never the checkout's documents in their place.
  const stored = await listStoreArtifacts(root, relative).catch((error) => { if (recordsUnavailable(error) || error?.name === "ArtifactError") return []; throw error; });
  if (stored === null) return null;
  const prefix = relative ? `${relative}/` : "";
  const files = [...new Set<string>(stored.map((entry: any) => entry.path))].filter((file) => {
    const parts = file.slice(prefix.length).split("/");
    return parts.length <= depth + 1 && accept(parts.at(-1));
  });
  const order = (file: string) => file.slice(prefix.length).split("/").map((name: string) => name.toLowerCase());
  return files.sort((left, right) => {
    const a = order(left), b = order(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index].localeCompare(b[index]);
    return a.length - b.length;
  }).slice(0, limit);
}

async function walk(root: string, relative: string, depth: number, accept: any, results: any, limit: number) {
  if (await inArtifactStore(root, `${relative}/x`).catch(() => false)) {
    const stored = await storeWalk(root, relative, depth, accept, limit - results.length);
    if (stored !== null) { results.push(...stored); return; }
  }
  let entries;
  try {
    entries = await readdir((await resolveRecordFile(root, relative)).target, { withFileTypes: true });
  } catch (error) {
    // An unavailable record store or a refused repository name hides only the records, so human documents still list.
    if (["ENOENT", "ENOTDIR"].includes(error.code) || recordsUnavailable(error)) return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (results.length >= limit || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && depth > 0) await walk(root, child, depth - 1, accept, results, limit);
    else if (entry.isFile() && accept(entry.name)) results.push(child);
  }
}

function headerFields(source: any) {
  const title = source.match(/^#\s+(.+?)\s*$/m)?.[1] ?? null;
  const field = (name: string) => source.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;
  return { title, status: field("Status"), created: field("Created"), approved: field("Approved") };
}

function reviewSummary(review: any) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const unresolved = findings.filter((finding: any) => UNRESOLVED.has(finding.status));
  const deferred = findings.filter((finding: any) => finding.status === "DEFERRED");
  const waves = Array.isArray(review?.waves) ? review.waves : [];
  return {
    findings: findings.length,
    unresolved: unresolved.length,
    blocking: findings.filter((finding: any) => !["VERIFIED", "DEFERRED"].includes(finding.status) && ["blocker", "high"].includes(finding.severity)).length,
    byStatus: Object.fromEntries(["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED", "DEFERRED"].map((status) => [status, findings.filter((finding: any) => finding.status === status).length])),
    // A deferred finding is resolved by the user's decision gate, so it is counted apart and listed with its follow-up.
    deferred: deferred.length,
    deferredFindings: deferred.map((finding: any) => ({ id: finding.id, severity: finding.severity, title: finding.title, gate: finding.deferral?.gate ?? null, followUp: finding.deferral?.followUp ?? null })),
    waves: waves.length,
    currentWave: waves.at(-1) ? { id: waves.at(-1).id, mode: waves.at(-1).mode, accepted: Boolean(waves.at(-1).accepted) } : null
  };
}

const COORDINATION_FILES = new Set(["initiative.md"]);

// A slice's human documents sit in its plans folder; its review and change map are records under .prism.
async function sliceArtifacts(root: string, directory: string, slices: any, slug: string, id: string) {
  const folder = sliceFolder(directory, slices, slug);
  const files: any[] = [];
  // The root slice shares the initiative directory, so it lists only its own top-level files.
  if (folder === directory) await walk(root, folder, 0, (name: string) => !COORDINATION_FILES.has(name), files, SLICE_FILE_LIMIT);
  else await walk(root, folder, 3, () => true, files, SLICE_FILE_LIMIT);
  const reviewPath = await recordFile(root, { kind: "review", initiative: id, slice: slug });
  const reviewSource = await readText(root, reviewPath);
  let review = null;
  if (reviewSource !== null) {
    try {
      review = { path: reviewPath, ...reviewSummary(parseStoreJson(reviewSource)) };
    } catch {
      review = { path: reviewPath, invalid: true };
    }
  }
  const changeMap = await recordFile(root, { kind: "change-map", initiative: id, slice: slug });
  return {
    folder,
    files,
    narrative: files.includes(`${folder}/slice.md`) ? `${folder}/slice.md` : null,
    changeMap: (await isFile(root, changeMap)) ? changeMap : null,
    review
  };
}

// An unavailable record store or a refused repository name lists no initiatives, so the pages still show human documents; the roadmap view reports the store error.
function storedInitiatives(root: string) {
  return listInitiatives(root).catch((error) => { if (recordsUnavailable(error)) return []; throw error; });
}

async function initiativeFolders(root: string) {
  const ids = [];
  for (const id of await storedInitiatives(root)) if ((await readText(root, await recordFile(root, { kind: "initiative", initiative: id }))) !== null) ids.push(id);
  return ids;
}

async function initiativeFindings(root: string, config: any, id: string) {
  const totals = { unresolved: 0, blocking: 0 };
  const ledgers = await Promise.all((await listSliceRecords(root, id)).map((slice) => recordFile(root, { kind: "review", initiative: id, slice })));
  for (const ledger of ledgers) {
    const source = await readText(root, ledger);
    if (source === null) continue;
    try {
      const summary = reviewSummary(parseStoreJson(source));
      totals.unresolved += summary.unresolved;
      totals.blocking += summary.blocking;
    } catch {
      // An unreadable review ledger is reported on the slice page, not counted here.
    }
  }
  return totals;
}

export function loadRoadmapView(projectRoot: string) {
  return remember(`roadmap:${projectRoot}`, () => computeRoadmapView(projectRoot));
}

async function computeRoadmapView(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  let roadmap;
  try {
    roadmap = await readRoadmap(projectRoot);
  } catch (error) {
    return { config: { paths: config.paths, diagnostics: config.diagnostics }, error: error.message, bands: DISPLAY_BANDS, items: [], unlisted: await initiativeFolders(projectRoot) };
  }
  const { resolved, loaded, derived } = roadmap;
  const record = loaded.record;
  const items = [];
  if (loaded.valid && record) {
    for (const [index, item] of record.initiatives.entries()) {
      const facts = derived[index];
      items.push({
        id: item.id,
        title: item.title,
        intent: item.intent,
        pillar: item.pillar ?? null,
        storedBand: item.band,
        band: facts.band,
        state: facts.state,
        readyToShip: facts.readyToShip,
        progress: facts.progress,
        active: facts.active,
        diagnostics: facts.diagnostics,
        requirements: item.requirements,
        requires: item.requires,
        requiredBy: record.initiatives.filter((other: any) => other.requires.includes(item.id)).map((other: any) => other.id),
        rationale: item.rationale ?? null,
        decision: item.decision,
        findings: await initiativeFindings(projectRoot, config, item.id),
        ...sliceFacts(await claimedSlices(projectRoot, item.id))
      });
    }
  }
  const listed = new Set(items.map((item) => item.id));
  return {
    config: { paths: config.paths, diagnostics: config.diagnostics },
    recordPath: await recordFile(projectRoot, { kind: "roadmap" }),
    projectionPath: resolved.projectionPath,
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    revision: loaded.revision,
    serves: record?.serves ?? "",
    openQuestions: record?.openQuestions ?? [],
    bands: DISPLAY_BANDS,
    items,
    unlisted: (await initiativeFolders(projectRoot)).filter((id) => !listed.has(id))
  };
}

// Every live and lapsed claim of the roadmap's initiatives and of the unlisted ones, in one read, for the page's claim index, which names no holder.
export function loadClaims(projectRoot: string) {
  return remember(`claims:${projectRoot}`, async () => ({ claims: (await loadHeldClaims(projectRoot)).claims.map(({ holder, ...claim }: { holder: string; [key: string]: any }) => claim) }));
}

/** The same claims with each one's holder, for the agents list, which matches a launched session to the claims it holds and never shows the holder. */
export function loadHeldClaims(projectRoot: string) {
  return remember(`held-claims:${projectRoot}`, () => computeClaims(projectRoot));
}

async function computeClaims(projectRoot: string) {
  const roadmap = await loadRoadmapView(projectRoot);
  const listed = [...roadmap.items.map((item: any) => ({ id: item.id, title: item.title ?? item.id })), ...roadmap.unlisted.map((id: string) => ({ id, title: id }))];
  const initiatives = await Promise.all(listed.map(async ({ id, title }) => ({ id, title, claims: sliceClaims(await claimedSlices(projectRoot, id), { holders: true }) })));
  return { claims: initiatives.flatMap(({ id, title, claims }) => claims.map((claim) => ({ ref: `slice:${id}/${claim.slug}`, initiative: id, initiativeTitle: title, ...claim }))) };
}

export function loadInitiativeView(projectRoot: string, id: string) {
  return remember(`initiative:${id}:${projectRoot}`, () => computeInitiativeView(projectRoot, id));
}

// Only initiative and slice pages read run records; loadInitiativeView stays free of them for navigation polls.
function loadInitiativeRunTotals(projectRoot: string, initiative: any) {
  return remember(`run-totals:${initiative.id}:${projectRoot}`, () => readInitiativeRecordRunTotals(projectRoot, initiative.id, initiative));
}

// Initiative reads keep only live claims; the browser also shows a claim that lapsed without a release, as expiredClaim, until someone claims or releases the slice.
async function withExpiredClaims(projectRoot: string, id: string, read: any) {
  const slices = read.loaded.record?.slices;
  if (!slices || typeof slices !== "object") return read;
  const records = await listClaimRecords(projectRoot, id).catch(() => []);
  const now = Date.now();
  let copy: any = null;
  for (const { slice, bytes } of records) {
    const { claim }: any = parseClaim(slice, bytes);
    if (!claim || isLive(claim as any, now) || !Object.hasOwn(slices, slice) || slices[slice].claim) continue;
    copy ??= { ...slices };
    copy[slice] = { ...slices[slice], expiredClaim: { holder: claim.holder, label: claim.label, ...(claim.host ? { host: claim.host } : {}), ...(claim.model ? { model: claim.model } : {}), ...sessionFields(claim), activity: claim.activity, claimedAt: claim.claimedAt, expiresAt: claim.expiresAt } };
  }
  return copy ? { ...read, loaded: { ...read.loaded, record: { ...read.loaded.record, slices: copy } } } : read;
}

// The claims of an initiative's slices: each slice's live claim, or the claim that lapsed without a release, with the slice's title, and with holders each claim's holder.
function sliceClaims(slices: any, { holders = false }: any = {}) {
  const claims = [];
  for (const [slug, slice] of Object.entries<any>(slices ?? {})) {
    const claim = slice?.claim ?? slice?.expiredClaim;
    if (!claim || typeof claim.label !== "string") continue;
    claims.push({ slug, sliceTitle: slice.title ?? slug, ...(holders ? { holder: typeof claim.holder === "string" ? claim.holder : null } : {}), label: claim.label, host: typeof claim.host === "string" ? claim.host : null, model: typeof claim.model === "string" ? claim.model : null, ...keptSession(claim), activity: claim.activity === "design" ? "design" : "implementation", claimedAt: claim.claimedAt ?? null, renewedAt: claim.renewedAt ?? null, expiresAt: claim.expiresAt ?? null, expired: !slice.claim });
  }
  return claims;
}

// Where a slice stands for the lifecycle the review app draws: its status, whether it has an accepted design, and whether that design requires a review.
function slicePhase(slice: any): any {
  return { status: slice?.status ?? "not-started", designed: Boolean(slice?.design), review: slice?.design?.review ?? null };
}

// A roadmap card's claims and the phase facts of each leaf slice, in record order, for its per-slice progress bar.
function sliceFacts(slices: any) {
  const entries = Object.entries<any>(slices ?? {});
  const parents = new Set(entries.map(([, slice]) => slice?.parent).filter((parent) => typeof parent === "string"));
  return { claims: sliceClaims(slices), slices: entries.filter(([slug]) => !parents.has(slug)).map(([slug, slice]) => ({ slug, ...slicePhase(slice) })) };
}

// The slices of an initiative with their live and lapsed claims, or null when the record cannot be read.
async function claimedSlices(projectRoot: string, id: string) {
  try {
    return (await withExpiredClaims(projectRoot, id, await readInitiativeWithClaims(projectRoot, id))).loaded.record?.slices ?? null;
  } catch {
    return null;
  }
}

// The live claim whose holder resumes when a gate on a slice is answered: the slice's own, or a design claim on a scope above it.
function holdingClaim(slices: any, slug: string) {
  for (let owner = slug; owner !== null && owner !== undefined && slices && Object.hasOwn(slices, owner); owner = slices[owner].parent ?? null) {
    const claim = slices[owner].claim;
    if (claim && typeof claim.label === "string" && (owner === slug || claim.activity === "design")) return { label: claim.label, host: typeof claim.host === "string" ? claim.host : null, model: typeof claim.model === "string" ? claim.model : null, ...keptSession(claim), activity: claim.activity === "design" ? "design" : "implementation", claimedAt: claim.claimedAt ?? null, renewedAt: claim.renewedAt ?? null, expiresAt: claim.expiresAt ?? null };
  }
  return null;
}

async function computeInitiativeView(projectRoot: string, id: string) {
  if (!SLUG_PATTERN.test(id ?? "")) throw new Error("The initiative identifier is invalid.");
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  // Each claimed slice carries its live claim, so initiative and slice pages can show who works on it.
  const { resolved, loaded } = await withExpiredClaims(projectRoot, id, await readInitiativeWithClaims(projectRoot, id));
  let state = null;
  try {
    state = (await readCoordinationState({ projectRoot, initiative: id })).state;
  } catch {
    state = null;
  }
  const slices: Record<string, any> = {};
  if (loaded.record?.slices) {
    for (const slug of Object.keys(loaded.record.slices)) slices[slug] = await sliceArtifacts(projectRoot, resolved.directory, loaded.record.slices, slug, id);
  }
  const analysis = loaded.analysis;
  // A design waits at its gate until the orchestrator accepts it, while the record still says not-started, so the browser shows that wait instead.
  const designReview: Record<string, any> = {};
  for (const gate of state?.pending ?? []) {
    if (gate && typeof gate === "object" && gate.kind === "visual-review" && gate.slice && loaded.record?.slices?.[gate.slice]?.status === "not-started") designReview[gate.slice] = gate.answer ? "answered" : "waiting";
  }
  return {
    id,
    directory: resolved.directory,
    recordPath: await recordFile(projectRoot, { kind: "initiative", initiative: id }),
    statePath: await recordFile(projectRoot, { kind: "state", initiative: id }),
    roadmapItem: roadmap.items.find((item: any) => item.id === id) ?? null,
    // The initiative's priority within its band among the band's open initiatives, as the roadmap board numbers its cards.
    bandRank: bandRank(roadmap, id),
    // The titles of the initiatives it needs and unblocks, so its page names them rather than their ids.
    relatedTitles: relatedTitles(roadmap, id),
    // A superseded initiative's page names the initiative that superseded it by its title.
    supersededBy: supersedingItem(roadmap, id),
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    revision: loaded.revision,
    record: loaded.record,
    derived: analysis ? { root: analysis.root, children: analysis.children, leaves: analysis.leaves, counts: analysis.counts, effectiveDependencies: analysis.effectiveDependencies, complete: analysis.complete, designCandidates: analysis.designCandidates.filter((slug: string) => !designReview[slug]), dependenciesComplete: analysis.dependenciesComplete } : null,
    active: state?.active ?? [],
    designReview,
    slices,
    config: { paths: config.paths }
  };
}

function supersedingItem(roadmap: any, id: string) {
  const decision = roadmap.items.find((item: any) => item.id === id)?.decision;
  if (decision?.kind !== "superseded" || !decision.by) return null;
  const by = roadmap.items.find((item: any) => item.id === decision.by);
  return { id: decision.by, title: by?.title ?? decision.by };
}

// A designed slice's change map is derived from its verified result; opening the slice starts a derivation the server has not finished yet.
async function derivedChangeMapState(projectRoot: string, id: string, slug: string, design: any, verification: any) {
  if (!design?.baselineId || !verification?.passed || !verification.snapshotId || verification.designAcceptedAt !== design.acceptedAt) return null;
  const source = await readText(projectRoot, await recordFile(projectRoot, { kind: "change-map", initiative: id, slice: slug }));
  let document = null;
  try { document = source === null ? null : parseStoreJson(source); }
  catch { return { derived: false }; }
  if (document && !document.derived) return { derived: false };
  if (document?.derived?.runId === verification.id) return { derived: true, runId: verification.id, document };
  const key = { projectRoot, initiative: id, slice: slug };
  const last = lastChangeMapDerivation(key);
  if (last?.runId === verification.id && last.status === "empty") return { derived: true, empty: true, runId: verification.id };
  if (last && ["failed", "unavailable"].includes(last.status)) return { derived: true, failed: last.reason ?? last.status };
  startChangeMapDerivation(key);
  return { derived: true, pending: true, runId: verification.id };
}

// A design claim on a scope covers every slice below it, while only the scope carries the claim.
function coveringClaim(slices: any, slug: string) {
  for (let owner = slices[slug]?.parent ?? null; owner !== null && Object.hasOwn(slices, owner); owner = slices[owner].parent ?? null) {
    if (slices[owner].claim?.activity === "design") return { slug: owner, title: slices[owner].title, claim: slices[owner].claim };
  }
  return null;
}

// A view's source is shown in the page, so a source past this size is left out and the page says the view is too large to show.
const VIEW_SOURCE_LIMIT = 256 * 1024;

// A diagram's own title, from its first single-line PlantUML title, names a diagram that no Views line asks a question of.
function diagramTitle(source: string | null) {
  const title = source?.match(/^[ \t]*title[ \t]+(\S.*?)[ \t]*$/im)?.[1]?.replace(/^"(.*)"$/, "$1").trim();
  return title || null;
}

/**
 * The views of a slice folder: first those its slice.md declares, in their declared order, each as { path, file, kind, question, clauses, source, contract, declared: true },
 * where contract is { path, slice, title, ref } of the governing contract, the slice that holds it, and that slice's title, or null when no slice.md above the folder has a Contract.
 * A declaration of an unknown kind is left out, since the design check refuses it.
 * Then each PlantUML file directly in the folder that no Views line names, as { path, file, kind: "diagram", title, question: null, clauses: [], source, contract, declared: false },
 * so that a design written before Views sections existed still shows its diagrams.
 */
async function folderViews(projectRoot: string, initiative: any, slug: string, plans: any) {
  const artifacts = initiative.slices[slug];
  if (!artifacts) return [];
  const design = artifacts.narrative ? await readText(projectRoot, artifacts.narrative) : null;
  const read = readViews(design, artifacts.folder, { plans }).views;
  const declared = read.filter((view) => VIEW_KINDS.includes(view.kind));
  const named = new Set(read.map((view) => view.path));
  const others = (artifacts.files ?? []).filter((file: string) => file.endsWith(".puml") && path.posix.dirname(file) === artifacts.folder && !named.has(file));
  if (!declared.length && !others.length) return [];
  const governing = await governingContract(projectRoot, artifacts.folder, plans ?? initiative.directory).catch(() => null);
  const owner = governing ? Object.keys(initiative.slices).find((key) => initiative.slices[key].narrative === governing.path) ?? null : null;
  const contract = governing ? { path: governing.path, slice: owner, title: owner ? initiative.record.slices[owner]?.title ?? owner : null, ref: owner ? `slice:${initiative.id}/${owner}` : null } : null;
  const shown = (source: string | null) => source !== null && source.length <= VIEW_SOURCE_LIMIT ? source : null;
  const listed = await Promise.all(declared.map(async (view) => {
    const source = await readText(projectRoot, view.path);
    return {
      path: view.path,
      file: path.posix.basename(view.path),
      kind: view.kind,
      question: view.question,
      clauses: view.clauses,
      source: shown(source),
      missing: source === null,
      contract,
      declared: true
    };
  }));
  const unasked = await Promise.all(others.map(async (file: string) => {
    const source = await readText(projectRoot, file);
    const name = path.posix.basename(file);
    return { path: file, file: name, kind: "diagram", title: diagramTitle(source) ?? name, question: null, clauses: [], source: shown(source), missing: source === null, contract, declared: false };
  }));
  return [...listed, ...unasked];
}

/**
 * The Views tab of a slice: the views of its own folder, and for a scope whose design planned slices, each planned slice with its title and views;
 * a planned slice whose folder has no views and no diagrams is listed in without by its title.
 */
async function loadSliceViews(projectRoot: string, initiative: any, slug: string) {
  const plans = (await readCheckoutConfig(projectRoot).catch(() => null))?.paths?.plans?.replace(/\/+$/, "") ?? null;
  const own = await folderViews(projectRoot, initiative, slug, plans);
  const planned = initiative.derived?.children[slug] ?? [];
  const slices = [], without = [];
  for (const child of planned) {
    const title = initiative.record.slices[child]?.title ?? child;
    const views = await folderViews(projectRoot, initiative, child, plans);
    if (views.length) slices.push({ slug: child, title, views });
    else without.push({ slug: child, title });
  }
  return { own, slices, without };
}

/**
 * The view that a plan file's folder declares for it, as get_artifact returns it, with contract the governing contract as { path, slice, title, ref },
 * where ref is the page of the slice that holds the contract; or null for a file that its folder does not declare.
 */
export async function loadDeclaredView(projectRoot: string, file: string) {
  const plans = (await readCheckoutConfig(projectRoot).catch(() => null))?.paths?.plans?.replace(/\/+$/, "") ?? null;
  if (!plans || typeof file !== "string") return null;
  const view = await declaredView(projectRoot, file, { plans }).catch(() => null);
  if (!view) return null;
  const id = view.contract.slice(plans.length + 1).split("/")[0];
  const initiative = id ? await loadInitiativeView(projectRoot, id).catch(() => null) : null;
  const slice = initiative?.record ? Object.keys(initiative.slices).find((key) => initiative.slices[key].narrative === view.contract) ?? null : null;
  const title = slice ? initiative.record.slices[slice]?.title ?? slice : null;
  return { ...view, contract: { path: view.contract, slice, title, ref: slice ? `slice:${id}/${slice}` : null } };
}

// The published code index, when there is one, places each planned change in the code; the view never starts a build.
export async function loadSliceView(projectRoot: string, id: string, slug: string, { intelligenceDirectories }: any = {}) {
  const initiative = await loadInitiativeView(projectRoot, id);
  if (!initiative.record || !Object.hasOwn(initiative.record.slices, slug)) throw new Error(`The initiative ${id} has no slice ${slug}.`);
  const slice = initiative.record.slices[slug];
  const derived = initiative.derived;
  const latest = await latestVerification(projectRoot, id, slug).catch(() => null);
  // A failing name links to the frozen test that names it, where exactly one does.
  const verification = latest?.failing?.length ? { ...latest, failingLinks: await failingTestLinks(projectRoot, id, slug, latest.failing).catch(() => []) } : latest;
  const { document: changeMapDocument, ...changeMap } = await derivedChangeMapState(projectRoot, id, slug, slice.design, verification) ?? {};
  const totals = await loadInitiativeRunTotals(projectRoot, initiative);
  // A failed read has no slice entries, and its initiative total is every measure unavailable.
  const runTotals = totals === null ? null
    : totals.slices[slug] ?? { slice: totals.initiative, waves: [], designRuns: [], withDescendants: totals.initiative };
  return {
    id,
    initiativeTitle: initiative.roadmapItem?.title ?? initiative.record.slices[derived?.root]?.title ?? id,
    slug,
    slice,
    children: derived?.children[slug] ?? [],
    effectiveDependencies: derived?.effectiveDependencies[slug] ?? null,
    dependents: Object.entries<any>(initiative.record.slices).filter(([, other]) => other.dependencies.includes(slug)).map(([other]) => other),
    complete: derived?.complete[slug] ?? false,
    active: initiative.active.filter((entry: any) => entry.slice === slug),
    designReview: initiative.designReview[slug] ?? null,
    coveringClaim: coveringClaim(initiative.record.slices, slug),
    artifacts: initiative.slices[slug],
    verification,
    code: await verifiedCode(projectRoot, id, slug).catch(() => null),
    changeMap: Object.keys(changeMap).length ? changeMap : null,
    designView: await loadDesignView(projectRoot, id, slug, { changeMap: changeMapDocument ?? null, units: await readPublishedUnits(projectRoot, ...(intelligenceDirectories ? [intelligenceDirectories] : [])).catch(() => null) }).catch(() => null),
    titles: Object.fromEntries(Object.entries<any>(initiative.record.slices).map(([key, value]) => [key, value.title])),
    views: await loadSliceViews(projectRoot, initiative, slug).catch(() => ({ own: [], slices: [], without: [] })),
    runTotals
  };
}

// A slice's presence line, such as "in progress in feature-x on vm, not pushed", which names where work is without showing any of it.
function presenceText(where: any, branch: any, host: any, suffix: string) {
  return `in progress${branch ? ` in ${branch}` : ""}${where ?? (host ? ` on ${host}` : "")}${suffix}`;
}

/**
 * Work on a slice that exists only on the machine that holds it, as { source, branch, host, text } entries:
 * the latest verification run when no branch of the repository's code clone holds its verified commit or its checkout was dirty,
 * and the live implementation claim, which names its holder and host.
 * reachable(repository, commit) answers whether a branch of the repository's code clone holds a commit, or null where no clone says;
 * a run whose files the commit recorded at ship holds, which a branch holds, is pushed work and shows no presence.
 */
export async function slicePresence(projectRoot: string, id: string, slug: string, { reachable = async () => null, shipped = null }: any = {}) {
  const presence = [];
  const run = await latestVerification(projectRoot, id, slug).catch(() => null);
  const checkout = run?.checkout;
  if (checkout && typeof checkout.head === "string") {
    const repository = typeof checkout.repository === "string" ? checkout.repository : null;
    const held = repository ? await reachable(repository, checkout.head).catch(() => null) : null;
    const landed = repository && shipped ? await reachable(repository, shipped).catch(() => null) === true : false;
    const branch = typeof checkout.branch === "string" && checkout.branch ? checkout.branch : null;
    const host = typeof checkout.host === "string" && checkout.host ? checkout.host : null;
    if (!landed && (held === false || checkout.dirty === true)) presence.push({ source: "run", branch, host, text: presenceText(null, branch, host, held === false ? ", not pushed" : ", not committed") });
  }
  const initiative = await loadInitiativeView(projectRoot, id).catch(() => null);
  const claim = initiative?.record?.slices?.[slug]?.claim;
  if (claim && typeof claim.label === "string" && claim.activity !== "design") presence.push({ source: "claim", branch: null, host: null, text: presenceText(` on ${claim.label}`, null, null, "") });
  return presence;
}

// What the initiatives say about the library: the leaf slices that cite each requirements file, and the initiatives whose slice designs link each decision.
async function initiativeReferences(projectRoot: string, config: any) {
  const references = new Map();
  const decisions = new Map();
  const roadmap = await loadRoadmapView(projectRoot).catch(() => null);
  for (const id of await initiativeFolders(projectRoot)) {
    const { resolved, loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    const slices = loaded.record?.slices ?? {};
    const initiativeTitle = roadmap?.items.find((item: any) => item.id === id)?.title ?? slices[loaded.analysis?.root]?.title ?? id;
    // Split parents repeat their children's references, so only leaves count as assignments.
    const leaves = new Set(loaded.analysis?.leaves ?? []);
    for (const [slug, slice] of Object.entries<any>(slices)) {
      if (leaves.has(slug)) {
        for (const reference of slice.requirements ?? []) {
          const file = reference.split("#")[0];
          if (!references.has(file)) references.set(file, []);
          references.get(file).push({ initiative: id, initiativeTitle, slug, title: slice.title, anchor: reference.split("#")[1] ?? null });
        }
      }
      if (!config.paths.adrs || !resolved?.directory) continue;
      const design = `${sliceFolder(resolved.directory, slices, slug)}/slice.md`;
      for (const target of relativeLinkTargets(await readText(projectRoot, design), design)) {
        if (!target.startsWith(`${config.paths.adrs}/`)) continue;
        if (!decisions.has(target)) decisions.set(target, []);
        if (!decisions.get(target).some((use: any) => use.initiative === id)) decisions.get(target).push({ initiative: id, title: initiativeTitle });
      }
    }
  }
  return { references, decisions };
}

// The requirements files that a decision's Requirements section links, each with the sections it names, in the order the section names them.
function decisionRequirements(source: any, file: string, directory: any) {
  const section = /^## Requirements\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(source ?? "")?.[1] ?? "";
  const byFile = new Map();
  for (const match of section.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g)) {
    const [target] = relativeLinkTargets(`[x](${match[1]})`, file);
    if (!target || !directory || !target.startsWith(`${directory}/`)) continue;
    if (!byFile.has(target)) byFile.set(target, []);
    const anchor = match[1].split("#")[1];
    if (anchor && !byFile.get(target).includes(anchor)) byFile.get(target).push(anchor);
  }
  return [...byFile].map(([path, anchors]) => ({ path, anchors }));
}

export function loadLibrary(projectRoot: string, kind: any) {
  return remember(`library:${kind}:${projectRoot}`, () => computeLibrary(projectRoot, kind));
}

async function computeLibrary(projectRoot: string, kind: any) {
  const config = await readWorkflowConfig(projectRoot);
  const directory = kind === "requirements" ? config.paths.requirements : config.paths.adrs;
  const scoped = await scopedArtifacts(projectRoot, kind === "requirements" ? "requirements" : "adrs", (name: string) => name.endsWith(".md") && name.toLowerCase() !== "readme.md");
  if (scoped) return scopedLibrary(projectRoot, kind, directory, config, scoped);
  if (!directory) return { kind, directory: null, entries: [] };
  const files: any[] = [];
  await walk(projectRoot, directory, 4, (name: string) => name.endsWith(".md") && name.toLowerCase() !== "readme.md", files, LIBRARY_LIMIT);
  const { references, decisions } = await initiativeReferences(projectRoot, config);
  const recorded = await recordedStatuses(projectRoot, directory);
  const scopes = await storeScopes(projectRoot, directory);
  const markOf = await loadFormatMarks(projectRoot);
  const entries = [];
  for (const file of files) {
    const source = await readText(projectRoot, file);
    const fields = headerFields(source ?? "");
    const relative = file.slice(directory.length + 1);
    const entry: any = {
      path: file,
      title: fields.title ?? path.posix.basename(file, ".md"),
      // With a store, the status a gate recorded is the artifact's status, whatever its Status: line says.
      status: recorded?.has(file) ? recorded.get(file) : fields.status,
      created: fields.created,
      approved: fields.approved,
      topic: relative.includes("/") ? relative.split("/")[0] : null,
      format: markOf(file, scopes?.get(file) ?? null)
    };
    if (kind === "requirements") {
      // Each numbered section of a requirements file holds one requirement.
      entry.requirements = (source ?? "").match(/^## \d+\b/gm)?.length ?? 0;
      entry.assignedTo = references.get(file) ?? [];
    } else {
      const supersedes = /^Supersedes:\s*(.+)$/m.exec(source ?? "")?.[1] ?? "";
      entry.supersedes = relativeLinkTargets(supersedes, file).filter((target) => target.startsWith(`${directory}/`));
      entry.requirementLinks = decisionRequirements(source, file, config.paths.requirements);
      entry.initiatives = decisions.get(file) ?? [];
    }
    entries.push(entry);
  }
  // A decision that another one supersedes names it, so the list can say what replaced it.
  if (kind === "decisions") {
    for (const entry of entries) entry.supersededBy = entries.filter((other) => other.supersedes.includes(entry.path)).map((other) => other.path);
  }
  return { kind, directory, entries };
}

// The scope that holds each store artifact below a folder, the first by label where several do, or null when the project names no store or the store cannot be read.
async function storeScopes(projectRoot: string, directory: any) {
  const stored = await listStoreArtifacts(projectRoot, directory).catch(() => null);
  if (!stored) return null;
  const byPath = new Map();
  for (const entry of stored) if (!byPath.has(entry.path)) byPath.set(entry.path, entry.scope);
  return byPath;
}

/**
 * A workspace's library of every scope's requirements or decisions, each entry named by its store ref with its scope's label, and its links named by store refs:
 * an initiative's reference to a checkout path, and a decision's link to one, names the copy in the linking artifact's own scope, else the checkout's own scopes', else the workspace's.
 */
async function scopedLibrary(projectRoot: string, kind: any, directory: any, config: any, { entries: listed, own }: { entries: any; own: any }) {
  const { references, decisions } = await initiativeReferences(projectRoot, config);
  const requirements = kind === "decisions" ? (await scopedArtifacts(projectRoot, "requirements", (name: string) => name.endsWith(".md")))?.entries ?? [] : [];
  // An initiative names a checkout path, so of several scopes holding that path only the one a read of the path from this checkout finds takes its references.
  const markOf = await loadFormatMarks(projectRoot);
  const takes = (entry: any) => entry.path !== null && refAt(listed, own, entry.path) === entry.ref;
  const entries = [];
  for (const item of listed) {
    const source = await readText(projectRoot, item.ref);
    const fields = headerFields(source ?? "");
    const entry: any = {
      path: item.ref,
      scope: item.label,
      title: fields.title ?? path.posix.basename(item.location, ".md"),
      status: item.status ?? fields.status,
      created: fields.created,
      approved: fields.approved,
      topic: item.rest?.includes("/") ? item.rest.split("/")[0] : null,
      // A file that breaks its format carries its mark, by its checkout path and its scope.
      format: item.path ? markOf(item.path, item.label) : null
    };
    if (kind === "requirements") {
      entry.requirements = (source ?? "").match(/^## \d+\b/gm)?.length ?? 0;
      entry.assignedTo = takes(item) ? references.get(item.path) ?? [] : [];
    } else {
      const file = item.path ?? `${directory ?? "adrs"}/${item.rest}`;
      const supersedes = /^Supersedes:\s*(.+)$/m.exec(source ?? "")?.[1] ?? "";
      entry.supersedes = relativeLinkTargets(supersedes, file).map((target) => refAt(listed, own, target, item.label)).filter(Boolean);
      entry.requirementLinks = decisionRequirements(source, file, config.paths.requirements).map((link) => ({ ...link, path: refAt(requirements, own, link.path, item.label) })).filter((link) => link.path);
      entry.initiatives = takes(item) ? decisions.get(item.path) ?? [] : [];
    }
    entries.push(entry);
  }
  if (kind === "decisions") {
    for (const entry of entries) entry.supersededBy = entries.filter((other) => other.supersedes.includes(entry.path)).map((other) => other.path);
  }
  return { kind, directory, entries, byScope: countByScope(entries) };
}

// The recorded statuses of a store's requirements or ADRs by path, or null when the project names no store or the store cannot be read.
async function recordedStatuses(projectRoot: string, directory: string) {
  if (!(await inArtifactStore(projectRoot, `${directory}/x.md`).catch(() => false))) return null;
  const statuses = await storeArtifactStatuses(projectRoot, directory).catch(() => null);
  if (statuses === null) return null;
  const byPath = new Map();
  for (const entry of statuses) if (!byPath.has(entry.path)) byPath.set(entry.path, entry.status);
  return byPath;
}

/**
 * The glossary: path, the configured path; exists and content, of the glossary this checkout reads; and in a workspace, glossaries,
 * each scope's glossary as { ref, scope, terms }, terms being { term, text } in the order the file defines them.
 */
export async function loadGlossary(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  const glossaryPath = config.paths.glossary;
  const scoped = await scopedArtifacts(projectRoot, "glossary", () => true);
  if (scoped) {
    const glossaries = [];
    for (const item of scoped.entries) {
      const content = await readText(projectRoot, item.ref);
      if (content !== null) glossaries.push({ ref: item.ref, scope: item.label, terms: glossaryEntries(content).map(({ term, text }) => ({ term, text: text.replace(/\s+/g, " ").trim() })) });
    }
    const mine = glossaryPath ? await readText(projectRoot, glossaryPath) : null;
    return { path: glossaryPath, exists: glossaries.length > 0, content: mine, glossaries };
  }
  const content = glossaryPath ? await readText(projectRoot, glossaryPath) : null;
  const format = content === null || !glossaryPath ? null : (await loadFormatMarks(projectRoot))(glossaryPath, (await storeScopes(projectRoot, path.posix.dirname(glossaryPath)))?.get(glossaryPath) ?? null);
  return { path: glossaryPath, exists: content !== null, content, format };
}


async function isFile(root: string, relative: string) {
  try {
    if (await inArtifactStore(root, relative)) return (await readArtifactText(root, relative)) !== null;
    return (await stat((await resolveRecordFile(root, relative)).target)).isFile();
  } catch {
    return false;
  }
}

async function initiativeSnapshot(projectRoot: string, config: any, id: string, roadmapItem: any) {
  const directory = initiativeDirectory(config, id);
  const { loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: { exists: false, valid: false, errors: [] } }));
  let state = null;
  try {
    state = await readCoordinationState({ projectRoot, initiative: id });
  } catch {
    state = null;
  }
  const slices = loaded.record?.slices ?? {};
  return {
    id,
    directory,
    title: roadmapItem?.title ?? slices[loaded.analysis?.root]?.title ?? id,
    record: loaded,
    state,
    sliceTitle: (slug: string) => (slug && Object.hasOwn(slices, slug) ? slices[slug].title : slug ?? null)
  };
}

// The newest question comes first, so the one just asked is on top; an unreadable time sorts last.
function newestFirst(left: any, right: any) {
  const time = (value: any) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return time(right) - time(left) || 0;
}

function gateOrder(left: any, right: any) {
  return newestFirst(left.askedAt, right.askedAt);
}

/**
 * Attention: the records' items, shared for the cache window; the format findings, read at each request,
 * since the check of each artifact is kept until its content changes, so a changed file shows its new findings at once; and permissions,
 * the permission requests that wait in this machine's running launched sessions of the checkout's record store, read again at each
 * request from their private launch folders and never from a shared record. gateCount counts the waiting questions, each format
 * migration run's question, and each permission request.
 */
export async function loadAttention(projectRoot: string) {
  const [attention, formats, runs, permissions] = await Promise.all([remember(`attention:${projectRoot}`, () => computeAttention(projectRoot)), loadFormats(projectRoot), runItems(projectRoot), launchPermissions(projectRoot)]);
  const items = formats.filter((entry: any) => entry.count > 0).map((entry: any) => ({ type: "format-findings", artifactType: entry.type, label: entry.label, count: entry.count, earlier: entry.earlier, artifacts: entry.artifacts }));
  // A run's question waits on the person as a gate does, so it counts among the questions that the rail and a background tab's notification count.
  const questions = runs.needsYou.filter((item: any) => item.type === "migration-question").length;
  return { ...attention, needsYou: [...runs.needsYou, ...attention.needsYou, ...items], watch: [...attention.watch, ...runs.watch], formats, permissions, gateCount: attention.gateCount + questions + permissions.length };
}

/**
 * The format migration runs that Attention lists, read at each request since a run moves on its own: each run that asks its question and each failed run
 * that no later run follows need the person, and each run that waits for a host is a problem to watch. A project whose runs cannot be read lists none.
 */
async function runItems(projectRoot: string) {
  const runs = await allRuns(projectRoot).catch((): any[] => []);
  const needsYou: any[] = [];
  const watch: any[] = [];
  for (const run of [...runs].reverse()) {
    const base = { run: run.id, artifactType: run.set.type, label: FORMAT_LABELS[run.set.type] ?? run.set.type, scope: run.set.scope ?? null, files: run.set.artifacts.length };
    if (run.status === "asking") {
      const points = (run.question?.points ?? []).filter((point: any) => isRecord(point));
      const byFile = new Map();
      for (const point of points) {
        const key = JSON.stringify([point.artifact?.path, point.artifact?.scope?.label ?? null]);
        const entry = byFile.get(key) ?? { path: point.artifact?.path ?? null, scope: point.artifact?.scope ?? null, points: 0, kinds: [] };
        entry.points += 1;
        if (!entry.kinds.includes(point.kind)) entry.kinds.push(point.kind);
        byFile.set(key, entry);
      }
      needsYou.push({ type: "migration-question", ...base, points: points.length, asking: [...byFile.values()], askedAt: run.question?.askedAt ?? null });
    } else if (run.status === "failed" && !followedRun(runs, run)) {
      needsYou.push({ type: "migration-failed", ...base, reason: run.failure?.reason ?? null, at: run.failure?.at ?? run.endedAt ?? null, artifacts: run.set.artifacts.map(({ path: file, scope }: any) => ({ path: file, scope: scope ?? null })) });
    } else if (run.status === "waiting-for-host") {
      watch.push({ type: "migration-waiting", ...base, reason: typeof run.reason === "string" ? run.reason : null, at: run.startedAt ?? null });
    }
  }
  return { needsYou, watch };
}

// The format labels as Attention names each format.
const FORMAT_LABELS: Readonly<Record<string, string>> = Object.freeze({ requirements: "Requirements", adr: "Decisions", glossary: "Glossary", feature: "Feature files" });
const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---- Format migration runs ----

// The Attention page that lists a run in its state, which the run's trail passes through.
const RUN_ATTENTION_PAGES: Readonly<Record<string, string>> = Object.freeze({ asking: "questions", failed: "failed", "waiting-for-host": "problems" });

/** A run's name as its page, its tab, its Attention item, and its launched session read it: Format migration with the type's label. */
export const migrationRunTitle = (record: any) => `Format migration · ${FORMAT_LABELS[record.set.type] ?? record.set.type}`;

async function migrationRunContext(projectRoot: string, ref: string, id: string) {
  const record = await readRun(projectRoot, id).catch(() => null);
  const page = record ? RUN_ATTENTION_PAGES[record.status] : null;
  const trail = [placeCrumb("attention", "attention"), ...(page ? [{ ref: `attention:${page}`, label: PLACE_PAGE_LABELS.attention[page] }] : []), { ref, label: record ? migrationRunTitle(record) : "Format migration" }];
  return { trail, scope: { kind: "global" }, place: "attention" };
}

// A point as the run's page shows it: its kind and detail, its place in the question counted across the run, Prism's recommendation, the option it recommends, and how it was settled or answered.
function runPoint(point: any, { number, answers, conflicts, sourceEntries, contentEntries, sourceLines }: any) {
  const { id, kind, settled, asked, ...detail } = point;
  const recommendation = asked?.recommendation ?? null;
  const extra: any = {};
  if (kind === "leftover") extra.sourceLine = sourceLines?.get(id) ?? null;
  if (kind === "entry") {
    extra.sourceText = sourceEntries.find((entry: any) => entry.id === point.entry)?.text ?? null;
    extra.targetText = contentEntries.find((entry: any) => entry.id === point.entry)?.text ?? null;
  }
  if (kind === "conflict") {
    const conflict = conflicts.find((entry: any) => entry.entry === point.entry);
    extra.sourceText = conflict?.source ?? null;
    extra.targetText = conflict?.target ?? null;
  }
  return {
    id, kind, ...detail, ...extra, number: number ?? null,
    settled: settled ? { reason: settled.reason } : null,
    asked: asked ? { recommendation, recommended: recommendedChoice(kind, recommendation) } : null,
    answer: answers?.[id] ?? null
  };
}

/**
 * A format migration run as its page shows it: its status, cause, and times, each artifact of its set with its current findings, and for each migration
 * its source and target, its summary, its statement map, and its points numbered across the run, with each answer and whether a later run follows a failed one.
 * An id that names no run is refused as a missing item.
 */
async function loadMigrationRunView(projectRoot: string, id: string) {
  const record = await readRun(projectRoot, id);
  if (!record) throw Object.assign(new Error("The format migration run no longer exists in this project."), { code: "ENOENT" });
  const shown = await shownRun(projectRoot, record);
  const answers = record.answers ?? null;
  const asked = record.migrations.flatMap((migration: any) => (migration.points ?? []).filter((point: any) => point.asked));
  const numbers = new Map(asked.map((point: any, index: number) => [point.id, index + 1]));
  const migrations = record.migrations.map((migration: any) => {
    const sourceEntries = typeof migration.sourceText === "string" ? entriesFor(migration.type, migration.sourceText) : [];
    const contentEntries = typeof migration.content === "string" ? entriesFor(migration.type, migration.content) : [];
    const map = statementMap(migration, { answers: answers ?? {} });
    // A leftover point names its statement only, so its source line comes from the same split of the source that the statement map shows.
    const sourceLines = new Map((map?.statements ?? []).filter((statement: any) => statement.landed?.kind === "leftover" && statement.landed.point).map((statement: any) => [statement.landed.point, statement.line]));
    return {
      id: migration.id, type: migration.type, source: migration.source, target: migration.target, separateSource: migration.separateSource, summary: migration.summary,
      status: headerStatus(migration.content), proposedAt: migration.proposedAt ?? null,
      map,
      points: (migration.points ?? []).map((point: any) => runPoint(point, { number: numbers.get(point.id), answers, conflicts: migration.conflicts ?? [], sourceEntries, contentEntries, sourceLines }))
    };
  });
  const runs = record.status === "failed" ? await allRuns(projectRoot).catch((): any[] => []) : [];
  const answered = answers ? Object.values<any>(answers).find((answer) => answer?.by) ?? null : null;
  return {
    id: record.id, title: migrationRunTitle(record), type: record.set.type, typeLabel: FORMAT_LABELS[record.set.type] ?? record.set.type, scope: record.set.scope ?? null, formatVersion: record.set.formatVersion ?? null,
    cause: record.cause, status: record.status, startedAt: record.startedAt ?? null, endedAt: record.endedAt ?? null, reason: typeof record.reason === "string" ? record.reason : null,
    failure: record.failure ?? null, launch: record.launch ?? null, rerunOf: record.rerunOf ?? null, by: record.by ?? null,
    followedBy: record.status === "failed" ? followingRun(runs, record)?.id ?? null : null,
    artifacts: shown.set.artifacts.map(({ path: file, scope, version, findings }: any) => ({ path: file, scope: scope ?? null, version, findings })),
    askedAt: record.question?.askedAt ?? null, points: asked.length, answeredBy: answered ? { ...answered.by, at: answered.at ?? null } : null,
    migrations
  };
}

// The Status: line of a migrated file, or null.
const headerStatus = (text: any) => typeof text === "string" ? /^Status:\s*(\S.*?)\s*$/m.exec(text.split(/\n## /)[0] ?? "")?.[1] ?? null : null;

/**
 * Attention's format entries, one per format: every artifact that breaks it, and how many of them conform to an earlier format;
 * a project whose artifacts cannot be checked shows no findings.
 */
async function loadFormats(projectRoot: string) {
  let artifacts: any[] = [];
  try {
    artifacts = (await checkArtifacts({ projectRoot })).artifacts;
    // The lists of the same request mark artifacts from this check rather than checking them again.
    memo.set(marksKey(projectRoot), { at: Date.now(), value: Promise.resolve(markLookup(artifacts)) });
  } catch {
    artifacts = [];
  }
  return ARTIFACT_FORMATS.map((format: any) => {
    const broken = artifacts.filter((artifact: any) => artifact.type === format.type && !artifact.conforms);
    return {
      type: format.type,
      label: FORMAT_LABELS[format.type],
      version: format.version,
      reference: format.reference,
      count: broken.length,
      earlier: broken.filter((artifact: any) => artifact.earlierFormat !== null).length,
      artifacts: broken.map((artifact: any) => ({ path: artifact.path, scope: artifact.scope, findings: artifact.findings, earlierFormat: artifact.earlierFormat, migration: artifact.migration ?? null }))
    };
  });
}

// Each waiting permission request with its initiative's title, oldest first; none when the launches cannot be read.
async function launchPermissions(projectRoot: string) {
  const store = await storeLocation(await realpath(projectRoot)).catch(() => null);
  if (store === null) return [];
  const requests = await pendingRequests({ store }).catch(() => []);
  if (!requests.length) return [];
  const roadmap = await loadRoadmapView(projectRoot).catch(() => ({ items: [] }));
  const titles = new Map<string, string>(roadmap.items.map((item: any) => [item.id, item.title]));
  return requests.map((request) => ({ ...request, initiative: { id: request.initiative, title: titles.get(request.initiative) ?? request.initiative } }));
}

/**
 * Attention as its page shows it, with recentChanges: the shared Attention above, and the applied actions on store artifacts read again at each request,
 * because a store sync changes or removes their files at any time, so a file that a reader now leaves out never lingers in the list for the cache window.
 */
export async function loadAttentionView(projectRoot: string) {
  const { changes, ...attention } = await loadAttention(projectRoot);
  const recentChanges = [...changes, ...await artifactChanges(projectRoot)].sort((left, right) => historyOrder(right, left)).slice(0, RECENT_CHANGES_LIMIT);
  return { ...attention, recentChanges };
}

async function computeAttention(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const items = new Map(roadmap.items.map((item: any) => [item.id, item]));
  const ids = [...new Set([...roadmap.items.map((item: any) => item.id), ...(await storedInitiatives(projectRoot))])];
  const needsYou = [];
  // Open questions of a shipped initiative can no longer be answered, so they list apart and never wait on the person.
  const shippedGates: any[] = [];
  const answered: any[] = [];
  const earlier = [];
  const watch = [];
  const claims = [];
  // The person's applied actions: every initiative history of these records, this checkout's own index history, which no other checkout shares,
  // and the status records and comment files of the store artifacts the checkout sees, read below.
  const changes = (await readIndexHistory(projectRoot).catch(() => ({ history: [] }))).history.map((entry: any) => ({ ...entry, initiative: null }));
  const titles = new Map();
  for (const id of ids) {
    const snapshot = await initiativeSnapshot(projectRoot, config, id, items.get(id));
    const initiative = { id, title: snapshot.title };
    titles.set(id, snapshot.title);
    const state = snapshot.state;
    // A shipped initiative's state is history, so its open questions can no longer be answered and no longer wait on the person.
    const shipped = await shippedDecision(projectRoot, id).catch(() => null);
    // The Watch group lists every live and expired claim, read-only, beside the agent-side signals.
    const claimed = await claimedSlices(projectRoot, id);
    for (const claim of sliceClaims(claimed)) claims.push({ ...claim, initiative });
    if (state?.valid) {
      // An answer in Recent changes names the question it answered, so the list can be reviewed on its own.
      const questions = new Map([...(state.state?.pending ?? []), ...(state.state?.closed ?? [])].filter((gate) => gate && typeof gate === "object" && typeof gate.question === "string").map((gate) => [`gate:${id}/${gate.id}`, gate.question]));
      for (const entry of state.state?.history ?? []) changes.push({ ...entry, initiative: id, ...(entry.action === "gate.answer" && questions.has(entry.target) ? { question: questions.get(entry.target) } : {}) });
    }
    if (state?.exists && !state.valid) {
      watch.push({ type: "record-problem", initiative, path: await recordFile(projectRoot, { kind: "state", initiative: id }), message: state.errors.join(" ") });
    }
    for (const entry of state?.state?.pending ?? []) {
      if (entry && typeof entry === "object") {
        const artifacts = [];
        for (const artifact of entry.artifacts ?? []) {
          // A gate asked before the records moved to .prism names a record by its old path.
          const key = await keyOfPath(projectRoot, artifact).catch(() => null);
          const current = key ? await recordFile(projectRoot, key).catch(() => artifact) : artifact;
          const available = await isFile(projectRoot, current);
          artifacts.push({ path: current, available, ...(available ? { record: await describeRecord(projectRoot, config, current, key, snapshot) } : {}) });
        }
        const gate: any = { type: "gate", id: entry.id, kind: entry.kind, question: entry.question, context: entry.context ?? null, options: entry.options ?? null, recommended: entry.recommended ?? null, askedAt: entry.askedAt, answer: entry.answer ?? null, initiative, slice: entry.slice ? { slug: entry.slice, title: snapshot.sliceTitle(entry.slice) } : null, phase: entry.slice && claimed && Object.hasOwn(claimed, entry.slice) ? slicePhase(claimed[entry.slice]) : null, claim: entry.slice ? holdingClaim(claimed, entry.slice) : null, artifacts, unavailable: shipped ? shippedActionReason(shipped) : null };
        // A question whose every attached file is gone was likely overtaken by later work, so the page says it may no longer apply.
        if (!gate.answer && artifacts.length && artifacts.every((artifact) => !artifact.available)) gate.stale = true;
        (gate.answer ? answered : gate.unavailable ? shippedGates : needsYou).push(gate);
      } else if (typeof entry === "string") {
        needsYou.push({ type: "pending-note", text: entry, initiative });
      }
    }
    for (const entry of state?.valid ? state.state?.closed ?? [] : []) {
      earlier.push({ type: "closed-gate", id: entry.id, kind: entry.kind, question: entry.question, context: entry.context ?? null, options: entry.options ?? null, recommended: entry.recommended ?? null, askedAt: entry.askedAt, closedAt: entry.closedAt, answer: entry.answer ?? null, reason: entry.reason ?? null, initiative, slice: entry.slice ? { slug: entry.slice, title: snapshot.sliceTitle(entry.slice) } : null });
    }
    if (snapshot.record.exists && !snapshot.record.valid) {
      watch.push({ type: "record-problem", initiative, path: await recordFile(projectRoot, { kind: "initiative", initiative: id }), message: snapshot.record.errors.join(" ") });
    }
    const slices = snapshot.record.record?.slices ?? {};
    for (const [slug, slice] of Object.entries<any>(slices)) {
      if (slice.status === "blocked") watch.push({ type: "blocked", initiative, slice: { slug, title: slice.title } });
    }
    for (const [slug, slice] of Object.entries<any>(slices)) {
      if (slice.status === "done") continue;
      const failed = await failedVerification(projectRoot, id, slug);
      if (failed) watch.push({ type: "failed-verification", initiative, slice: { slug, title: slice.title }, ...failed });
    }
    for (const slug of Object.keys(slices)) {
      const ledger = await recordFile(projectRoot, { kind: "review", initiative: id, slice: slug });
      const source = await readText(projectRoot, ledger);
      if (source === null) continue;
      try {
        const summary = reviewSummary(parseStoreJson(source));
        if (summary.unresolved || summary.blocking) watch.push({ type: "findings", initiative, slice: { slug, title: slices[slug].title }, unresolved: summary.unresolved, blocking: summary.blocking, path: ledger });
      } catch {
        watch.push({ type: "record-problem", initiative, path: ledger, message: "The review ledger is not valid JSON." });
      }
    }
    for (const entry of state?.state?.active ?? []) {
      watch.push({ type: "active", initiative, slice: { slug: entry.slice, title: snapshot.sliceTitle(entry.slice) }, activity: entry.activity, label: entry.label ?? null, workers: entry.workers ?? [] });
    }
    const item: any = items.get(id);
    if (item?.readyToShip && item.state !== "shipped") watch.push({ type: "ready-to-ship", initiative });
  }
  needsYou.push(...await approvalGates(projectRoot));
  needsYou.sort((left, right) => (left.type === "gate") === (right.type === "gate") ? gateOrder(left, right) : left.type === "gate" ? -1 : 1);
  if (roadmap.error) needsYou.push({ type: "roadmap-problem", path: config.paths.roadmap, message: roadmap.error });
  else if (!roadmap.exists && config.paths.roadmap) needsYou.push({ type: "roadmap-missing", path: roadmap.recordPath });
  else if (roadmap.exists && !roadmap.valid) needsYou.push({ type: "roadmap-problem", path: roadmap.recordPath, message: roadmap.errors.join(" ") });
  for (const id of roadmap.unlisted) needsYou.push({ type: "unlisted", initiative: { id, title: titles.get(id) ?? id } });
  for (const question of roadmap.openQuestions ?? []) needsYou.push({ type: "open-question", text: question });
  for (const diagnostic of config.diagnostics) needsYou.push({ type: "config", code: diagnostic.code, message: diagnostic.message });
  const blockingOrder = (entry: any) => ({ "record-problem": 0, blocked: 1, "failed-verification": 2, findings: entry.blocking ? 3 : 4, "ready-to-ship": 5, active: 6 } as Record<string, number>)[entry.type] ?? 7;
  watch.sort((left, right) => blockingOrder(left) - blockingOrder(right));
  answered.sort((left, right) => newestFirst(left.answer.answeredAt, right.answer.answeredAt));
  // The newest closed questions come first, across initiatives, so the list stays short.
  earlier.sort((left, right) => newestFirst(left.closedAt, right.closedAt));
  const answeredThisWeek = recentlyAnswered(answered, earlier);
  // The shared part keeps the newest changes of initiatives and the index; loadAttentionView adds the store artifacts' applied actions to them.
  const recent = changes.sort((left: any, right: any) => historyOrder(right, left)).slice(0, RECENT_CHANGES_LIMIT);
  // Live claims lapse first first, then expired ones, the most recently lapsed first.
  const ends = (claim: any) => Date.parse(claim.expiresAt ?? "") || 0;
  claims.sort((left, right) => Number(left.expired) - Number(right.expired) || (left.expired ? ends(right) - ends(left) : ends(left) - ends(right)));
  shippedGates.sort(gateOrder);
  return { needsYou, shippedGates, answered, earlier: earlier.slice(0, 20), watch, claims, changes: recent, gateCount: needsYou.filter((item) => item.type === "gate").length, answeredThisWeek };
}

/**
 * The pending approval gates of the requirements and ADRs the checkout sees, as Attention items of kind approval with the artifact's path and scope,
 * or none when the project names no store or the store cannot be read.
 */
async function approvalGates(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await pendingApprovalGates(projectRoot).catch(() => []);
  // An id that another pending gate holds too names no single gate, so the card says why its answer is refused.
  const holders = new Map();
  for (const gate of gates) holders.set(gate.id, (holders.get(gate.id) ?? 0) + 1);
  const workItem = servedWorkItems(projectRoot);
  return Promise.all(gates.map(async (gate: any) => ({
    type: "gate", id: gate.id, kind: "approval", status: gate.status, recorded: gate.recorded, question: gate.question, context: gate.context ?? null, options: null, recommended: null,
    askedAt: gate.askedAt, answer: null, initiative: null, slice: null, artifacts: [], artifact: { path: gate.artifact.path, scope: gate.artifact.scope }, changed: gate.changed,
    workItem: await workItem(servedWorkItem(gate)),
    ...(holders.get(gate.id) > 1 ? { ambiguous: true } : {})
  })));
}

/**
 * The work item an approval gate serves as its card names it: { initiative: { id, title, known }, slice: { slug, title, known } or null }, or null when the gate names none.
 * An initiative is known once the roadmap lists it or its record exists, as requirements approved before their roadmap entry name the id it will take,
 * and a slice once the initiative's record holds it; the card links only what is known. Each initiative is read once per Attention load.
 */
function servedWorkItems(projectRoot: string) {
  let roadmap: Promise<any> | null = null;
  const records = new Map<string, Promise<any>>();
  return async (served: any) => {
    if (!served) return null;
    roadmap ??= loadRoadmapView(projectRoot).catch(() => ({ items: [] }));
    if (!records.has(served.initiative)) records.set(served.initiative, readInitiative(projectRoot, served.initiative).then(({ loaded }: any) => loaded, () => ({ exists: false })));
    const [view, loaded] = await Promise.all([roadmap, records.get(served.initiative)]);
    const item = (view.items ?? []).find((entry: any) => entry.id === served.initiative);
    const slices = loaded.record?.slices ?? {};
    const initiative = { id: served.initiative, title: item?.title ?? slices[loaded.analysis?.root]?.title ?? served.initiative, known: Boolean(item) || Boolean(loaded.exists) };
    if (served.slice === null) return { initiative, slice: null };
    const known = Object.hasOwn(slices, served.slice);
    return { initiative, slice: { slug: served.slice, title: known ? slices[served.slice].title ?? served.slice : served.slice, known } };
  };
}

// The applied actions on the store artifacts the checkout sees, approvals from their status records and comments from their own files, which belong to no initiative's history.
async function artifactChanges(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  return appliedArtifactActions(projectRoot, { latest: RECENT_CHANGES_LIMIT }).catch(() => []);
}

// A slice's latest verification run when it failed, so Attention lists it until a later run passes or the slice is done.
async function failedVerification(projectRoot: string, id: string, slug: string) {
  const run = await latestVerification(projectRoot, id, slug).catch(() => null);
  if (!run || run.passed !== false) return null;
  return { reason: run.reason ?? null, failingCount: Number.isInteger(run.failingCount) ? run.failingCount : null, finishedAt: run.finishedAt ?? null };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The questions answered or closed in the last 7 days that the records keep, newest first by the time of the answer or the closing.
function recentlyAnswered(answered: any, closed: any) {
  const since = Date.now() - WEEK_MS;
  const entries = [
    ...answered.map((gate: any) => ({ gate, at: gate.answer?.answeredAt ?? null })),
    ...closed.map((gate: any) => ({ gate, at: gate.closedAt ?? gate.answer?.answeredAt ?? null }))
  ].filter(({ at }) => Date.parse(at ?? "") >= since);
  entries.sort((left, right) => newestFirst(left.at, right.at));
  return entries.map(({ gate, at }) => ({ id: gate.id ?? null, kind: gate.kind ?? null, question: gate.question, initiative: gate.initiative, slice: gate.slice ?? null, answer: gate.answer ?? null, reason: gate.reason ?? null, at }));
}

// Attention's kinds in the sidebar's order, each item of the page under one kind; a claim, an agent at work, and an answered question are none of them.
export const ATTENTION_KINDS = Object.freeze(["questions", "findings", "failed", "blocked", "ready", "problems", "formats"]);
const ATTENTION_KIND_OF: Readonly<Record<string, any>> = Object.freeze({
  gate: "questions", "pending-note": "questions",
  findings: "findings", "failed-verification": "failed", blocked: "blocked", "ready-to-ship": "ready",
  "record-problem": "problems", "roadmap-problem": "problems", "roadmap-missing": "problems", unlisted: "problems", "open-question": "problems", config: "problems",
  "format-findings": "formats",
  "migration-question": "questions", "migration-failed": "failed", "migration-waiting": "problems"
});
// Attention's work entries listed before the row that shows the rest.
const ATTENTION_WORK_SHOWN = 3;

/** Every item of Attention with its kind, in the page's order: what needs the person, then what to watch. */
export function attentionItems(attention: any) {
  return [...attention.needsYou, ...attention.watch].flatMap((item) => ATTENTION_KIND_OF[item.type] ? [{ kind: ATTENTION_KIND_OF[item.type], item }] : []);
}

// Attention's sidebar: the count of every kind, the initiatives with items, most first and ties by title, and this week's answered questions.
function attentionPlace(attention: any) {
  const items = attentionItems(attention);
  const kinds = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, items.filter((entry) => entry.kind === kind).length]));
  const work = new Map();
  for (const { item } of items) {
    if (!item.initiative?.id) continue;
    const entry = work.get(item.initiative.id) ?? { id: item.initiative.id, title: item.initiative.title ?? item.initiative.id, count: 0 };
    entry.count += 1;
    work.set(entry.id, entry);
  }
  const ordered = [...work.values()].sort((left, right) => right.count - left.count || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { everything: items.length, questions: attention.gateCount, kinds, work: ordered, shown: ATTENTION_WORK_SHOWN, answered: attention.answeredThisWeek.length };
}

// A filtered page of Attention: the items of one kind, of one initiative, or the roadmap's open questions, with the filter's name and the total it is part of.
async function attentionPage(projectRoot: string, page: any) {
  const attention = await loadAttention(projectRoot);
  if (page === "answered") return { answered: attention.answeredThisWeek };
  const items = attentionItems(attention);
  const work = /^work\/(.+)$/.exec(page);
  // The roadmap's open questions are problems of the roadmap, which the Roadmap page's header counts and leads here.
  const shown = work
    ? items.filter(({ item }) => item.initiative?.id === work[1])
    : page === "roadmap-questions" ? items.filter(({ item }) => item.type === "open-question") : items.filter((entry) => entry.kind === page);
  let label = PLACE_PAGE_LABELS.attention[page];
  if (work) label = shown[0]?.item.initiative.title ?? (await loadRoadmapView(projectRoot).catch(() => ({ items: [] }))).items.find((item: any) => item.id === work[1])?.title ?? work[1];
  // The format findings page also carries every format's entry, with its artifacts.
  return { filter: { key: page, label, total: items.length, items: shown }, ...(page === "formats" ? { formats: attention.formats } : {}) };
}

// What a gate's attached record is, so the page names it by title and kind with the counts that matter for the answer.
async function describeRecord(projectRoot: string, config: any, artifactPath: string, key: any, snapshot: any) {
  const json = async () => {
    try { return parseStoreJson(await readText(projectRoot, artifactPath) ?? "null"); }
    catch { return null; }
  };
  if (key?.kind === "change-map") {
    const document = await json();
    return { kind: "change-map", plannedChanges: Array.isArray(document?.concepts) ? document.concepts.length : 0 };
  }
  if (key?.kind === "review") return { kind: "review-ledger", openFindings: reviewSummary(await json()).unresolved };
  if (key?.kind) return { kind: key.kind };
  const slices = snapshot.record.record?.slices ?? {};
  if (artifactPath.endsWith("/slice.md")) {
    const slug = Object.keys(slices).find((name) => `${sliceFolder(snapshot.directory, slices, name)}/slice.md` === artifactPath);
    if (slug) {
      // A slice of a split scope counts the scope's clauses its Changes serve, as its page lists them.
      const view = await loadDesignView(projectRoot, snapshot.id, slug).catch(() => null);
      const clauses = view ? view.clauses.length : contractClauses(await readText(projectRoot, artifactPath) ?? "").length;
      return { kind: "design", title: slices[slug].title, clauses, frozenTests: slices[slug].design?.frozenTests?.length ?? 0 };
    }
  }
  for (const [kind, directory] of [["decision", config.paths.adrs], ["requirements", config.paths.requirements]]) {
    if (!directory || !artifactPath.startsWith(`${directory}/`)) continue;
    const entry = (await loadLibrary(projectRoot, kind === "decision" ? "decisions" : "requirements")).entries.find((item: any) => item.path === artifactPath);
    if (entry) return { kind, title: entry.title, status: entry.status ?? null };
  }
  return null;
}

// The glossary's terms with the text that defines each: a heading's term owns the lines up to the next heading, a table row's term the row's other cells.
export function glossaryEntries(content: any) {
  const entries = new Map();
  let open = null;
  for (const line of (content ?? "").split("\n")) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      open = entries.get(heading[1]) ?? { term: heading[1], text: "" };
      entries.set(open.term, open);
      continue;
    }
    if (/^#\s/.test(line)) open = null;
    const row = /^\|\s*([^|]+?)\s*\|(.*)$/.exec(line);
    if (row && !/^-+$/.test(row[1].replace(/[:\s]/g, "")) && !["term", "name"].includes(row[1].toLowerCase())) {
      const term = row[1].replace(/\*\*/g, "");
      const entry = entries.get(term) ?? { term, text: "" };
      entry.text += ` ${row[2].replace(/\|/g, " ")}`;
      entries.set(term, entry);
    // A term's meaning is its definition: the fields of the glossary format after it and the anchor of the next term are not.
    } else if (open && !/^(Source|Aliases|Not to be confused with):/.test(line) && !/^\s*<a id="[^"]*"><\/a>\s*$/.test(line)) open.text += ` ${line}`;
  }
  return [...entries.values()].slice(0, LIBRARY_LIMIT);
}

function glossaryTerms(content: any) {
  return glossaryEntries(content).map((entry) => entry.term);
}

const DIAGRAM_DEPTH = 6;

// What a diagram draws, read from its source: Prism's code view of a slice, or the PlantUML kind that its opening line or its statements name.
const DIAGRAM_OPENINGS: Readonly<Record<string, any>> = Object.freeze({ mindmap: "Mind map", wbs: "Work breakdown", gantt: "Gantt chart", salt: "Wireframe", json: "Data", yaml: "Data" });
const DIAGRAM_STATEMENTS: readonly [string, RegExp][] = Object.freeze([
  ["C4", /^\s*(?:!include\S*\s+<?C4|(?:Person|System|Container|Component)(?:_Ext)?\s*\()/m],
  ["Class", /^\s*(?:abstract\s+)?(?:class|interface|enum)\s/m],
  ["State", /^\s*(?:\[\*\]|state\s)/m],
  ["Activity", /^\s*(?:start|stop|:[^\n]*;|if\s*\(|fork\b|repeat\b)/m],
  ["Component", /^\s*(?:component|node|package)\b|^\s*\[[^\]\n]+\]/m],
  // A diagram of named participants and arrows between them, with no statement of another kind, is a sequence, as PlantUML reads it.
  ["Sequence", /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\b|^\s*[\w"]+\s*<?-+>>?\s*[\w"]+/m]
]);
function diagramKind(file: string, source: any) {
  if (path.posix.basename(file) === "code.puml") return "Code view";
  const opening = /^\s*@start(\w+)/m.exec(source ?? "")?.[1]?.toLowerCase();
  if (opening && DIAGRAM_OPENINGS[opening]) return DIAGRAM_OPENINGS[opening];
  return DIAGRAM_STATEMENTS.find(([, pattern]) => pattern.test(source ?? ""))?.[0] ?? "Diagram";
}

// A diagram's name: the name after @startuml, or else its file name without .puml.
function diagramName(file: string, source: any) {
  const named = /^\s*@startuml[ \t]+([^\r\n]+?)\s*$/m.exec(source ?? "")?.[1]?.replace(/^"(.*)"$/, "$1").trim();
  return named && !named.startsWith("(") ? named : path.posix.basename(file, ".puml");
}

/**
 * Every PlantUML file of the plans folder and the decisions folder, by name and owner, ordered by owner and then name:
 * a slice's folder belongs to `<initiative> · <slice>`, an initiative's folder to the initiative, and a decisions folder file to the decision beside it.
 */
export function loadDiagrams(projectRoot: string) {
  return remember(`diagrams:${projectRoot}`, () => computeDiagrams(projectRoot));
}

async function computeDiagrams(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  const isDiagram = (name: string) => name.toLowerCase().endsWith(".puml");
  if (await workspaceListing(projectRoot)) return scopedDiagrams(projectRoot, config, isDiagram);
  const diagrams = [];
  const plans = config.paths.plans;
  if (plans) {
    const files: any[] = [];
    await walk(projectRoot, plans, DIAGRAM_DEPTH, isDiagram, files, LIBRARY_LIMIT);
    const owners = new Map();
    for (const file of files) {
      const [id, segment] = file.slice(plans.length + 1).split("/");
      const folder = path.posix.dirname(file);
      if (folder === plans) {
        diagrams.push({ file, owner: { kind: "initiative", title: plans }, ownerRef: null });
        continue;
      }
      if (!owners.has(id)) {
        const known = SLUG_PATTERN.test(id) && await knownInitiative(projectRoot, id).catch(() => false);
        owners.set(id, known ? await initiativeTree(projectRoot, id).then(({ scope, view }) => ({ title: scope.title, slices: view.record?.slices ?? {}, known: true })).catch(() => ({ title: id, slices: {} })) : { title: id, slices: {} });
      }
      const owner = owners.get(id);
      const slice = file.split("/").length > plans.split("/").length + 2 && owner.slices[segment] && owner.slices[segment].parent !== null ? owner.slices[segment] : null;
      const known = owner.known === true;
      diagrams.push({ file, owner: slice ? { kind: "slice", title: `${owner.title} · ${slice.title}` } : { kind: "initiative", title: owner.title }, ownerRef: known ? (slice ? `slice:${id}/${segment}` : `initiative:${id}`) : null });
    }
  }
  const adrs = config.paths.adrs;
  if (adrs) {
    const files: any[] = [];
    await walk(projectRoot, adrs, 4, isDiagram, files, LIBRARY_LIMIT);
    const decisions = new Map((await loadLibrary(projectRoot, "decisions")).entries.map((entry: any) => [entry.path, entry.title]));
    for (const file of files) {
      const decision = file.replace(/\.puml$/i, ".md");
      const title = decisions.get(decision) ?? path.posix.dirname(file);
      diagrams.push({ file, owner: { kind: "decision", title }, ownerRef: decisions.has(decision) ? decision : null });
    }
  }
  const named = await Promise.all(diagrams.map(async ({ file, owner, ownerRef }) => {
    const source = await readText(projectRoot, file);
    return { path: file, name: diagramName(file, source), owner, ownerRef, kind: diagramKind(file, source), text: source ?? "" };
  }));
  named.sort((left, right) => left.owner.title.localeCompare(right.owner.title) || left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return named;
}

/**
 * A workspace's diagrams of every scope's plans and decisions folders, each named by its store ref with its scope's label;
 * a plan's diagram belongs to its initiative or slice when this checkout knows the initiative, and a decision's to the decision beside it in its scope.
 */
async function scopedDiagrams(projectRoot: string, config: any, isDiagram: any) {
  const plans = (await scopedArtifacts(projectRoot, "plans", isDiagram))?.entries ?? [];
  const adrs = (await scopedArtifacts(projectRoot, "adrs", isDiagram))?.entries ?? [];
  const decisions = new Map((await loadLibrary(projectRoot, "decisions")).entries.map((entry: any) => [entry.path, entry.title]));
  const owners = new Map();
  const diagrams = [];
  for (const item of plans) {
    const [id, segment] = item.rest.split("/");
    if (!item.rest.includes("/")) {
      diagrams.push({ item, owner: { kind: "initiative", title: config.paths.plans ?? "plans" }, ownerRef: null });
      continue;
    }
    if (!owners.has(id)) {
      const known = SLUG_PATTERN.test(id) && await knownInitiative(projectRoot, id).catch(() => false);
      owners.set(id, known ? await initiativeTree(projectRoot, id).then(({ scope, view }) => ({ title: scope.title, slices: view.record?.slices ?? {}, known: true })).catch(() => ({ title: id, slices: {} })) : { title: id, slices: {} });
    }
    const owner = owners.get(id);
    const slice = item.rest.split("/").length > 2 && owner.slices[segment] && owner.slices[segment].parent !== null ? owner.slices[segment] : null;
    const known = owner.known === true;
    diagrams.push({ item, owner: slice ? { kind: "slice", title: `${owner.title} · ${slice.title}` } : { kind: "initiative", title: owner.title }, ownerRef: known ? (slice ? `slice:${id}/${segment}` : `initiative:${id}`) : null });
  }
  for (const item of adrs) {
    const decision = storeRef(item.location.replace(/\.puml$/i, ".md"));
    diagrams.push({ item, owner: { kind: "decision", title: decisions.get(decision) ?? path.posix.dirname(item.rest) }, ownerRef: decisions.has(decision) ? decision : null });
  }
  const named = await Promise.all(diagrams.map(async ({ item, owner, ownerRef }) => {
    const source = await readText(projectRoot, item.ref);
    return { path: item.ref, scope: item.label, name: diagramName(item.location, source), owner, ownerRef, kind: diagramKind(item.location, source), text: source ?? "" };
  }));
  named.sort((left, right) => left.owner.title.localeCompare(right.owner.title) || left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return named;
}

const SEARCH_KINDS = Object.freeze(["requirement", "decision", "glossary-term", "diagram"]);
const SEARCH_MINIMUM = 2;
const SEARCH_LIMIT = 20;

// Every record the Knowledge search reads, by kind, with the text it matches against.
async function searchableRecords(projectRoot: string) {
  const records: Record<string, any[]> = Object.fromEntries(SEARCH_KINDS.map((kind) => [kind, []]));
  for (const [kind, library] of [["requirement", "requirements"], ["decision", "decisions"]]) {
    for (const entry of (await loadLibrary(projectRoot, library)).entries) records[kind].push({ title: entry.title, ref: entry.path, text: await readText(projectRoot, entry.path) ?? "" });
  }
  const glossary = await loadGlossary(projectRoot);
  const terms = glossary.glossaries ? glossary.glossaries.flatMap((one) => one.terms) : glossaryEntries(glossary.content);
  for (const entry of terms) records["glossary-term"].push({ title: entry.term, ref: "glossary", text: entry.text });
  for (const diagram of await loadDiagrams(projectRoot)) records.diagram.push({ title: diagram.name, ref: diagram.path, text: diagram.text });
  return records;
}

/**
 * The Knowledge search: the records whose title or text holds every word of `query`, ignoring case, grouped by kind in a fixed order,
 * at most 20 per group with the titles that hold the whole text first, and no group for a kind without a match or for text shorter than two characters.
 */
export async function searchRecords(projectRoot: string, query: any) {
  const text = String(query ?? "").trim();
  if (text.length < SEARCH_MINIMUM) return { query: text, groups: [] };
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const whole = text.toLowerCase();
  const records = await searchableRecords(projectRoot);
  const groups = [];
  for (const kind of SEARCH_KINDS) {
    const matches = records[kind].filter((record) => {
      const haystack = `${record.title}\n${record.text}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    if (!matches.length) continue;
    const titled = (record: any) => record.title.toLowerCase().includes(whole) ? 0 : 1;
    const ordered = matches.map((record, index) => ({ record, index })).sort((left, right) => titled(left.record) - titled(right.record) || left.index - right.index);
    groups.push({ kind, results: ordered.slice(0, SEARCH_LIMIT).map(({ record }) => ({ title: record.title, ref: record.ref })) });
  }
  return { query: text, groups };
}

// `libraries` may hold the requirements and decisions libraries already read, each as { value } or the { error } reading it failed with.
async function searchIndex(projectRoot: string, config: any, roadmap: any, glossary: any, libraries: any = {}) {
  const entries = [];
  const titles = new Map(roadmap.items.map((item: any) => [item.id, item.title]));
  for (const item of roadmap.items) entries.push({ ref: `initiative:${item.id}`, label: item.title, kind: "initiative", detail: `${item.band} · ${item.state}` });
  for (const id of await initiativeFolders(projectRoot)) {
    if (!titles.has(id)) entries.push({ ref: `initiative:${id}`, label: id, kind: "initiative", detail: "not on the roadmap" });
    const { loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    for (const [slug, slice] of Object.entries<any>(loaded.record?.slices ?? {})) entries.push({ ref: `slice:${id}/${slug}`, label: slice.title, kind: "slice", detail: `${titles.get(id) ?? id} · ${slice.status}` });
  }
  for (const kind of ["requirements", "decisions"]) {
    const library = libraries[kind];
    if (library?.error) throw library.error;
    for (const entry of (library ? library.value : await loadLibrary(projectRoot, kind)).entries) entries.push({ ref: entry.path, label: entry.title, kind: kind === "requirements" ? "requirement" : "decision", detail: entry.status ?? entry.path, format: entry.format ?? null });
  }
  for (const term of glossaryTerms(glossary.content)) entries.push({ ref: "glossary", label: term, kind: "term", detail: "Glossary" });
  return entries;
}

/**
 * Every record file by kind, title, and project-relative path: each requirements file, each decision, the glossary file when it exists, and each diagram,
 * with the folders and files that hold them for reading their history.
 * `loaded` may hold the workflow config, the glossary, the diagrams, and the requirements and decisions libraries a caller already read, which are not read again.
 */
export async function recordFiles(projectRoot: string, loaded: any = {}) {
  const config = loaded.config ?? await readWorkflowConfig(projectRoot);
  const records: any[] = [];
  for (const [kind, library] of [["requirement", "requirements"], ["decision", "decisions"]]) {
    const entries = loaded[library] ?? await loadLibrary(projectRoot, library).catch(() => ({ entries: [] }));
    for (const entry of entries.entries) records.push({ kind, title: entry.title, ref: entry.path, status: entry.status ?? null });
  }
  const glossary = loaded.glossary ?? await loadGlossary(projectRoot);
  if (glossary.exists) records.push({ kind: "glossary", title: "Glossary", ref: glossary.path, status: null });
  for (const diagram of loaded.diagrams ?? await loadDiagrams(projectRoot).catch(() => [])) records.push({ kind: "diagram", title: diagram.name, ref: diagram.path, status: null });
  const pathspecs = [...new Set([config.paths.requirements, config.paths.adrs, config.paths.glossary, config.paths.plans].filter(Boolean))];
  return { records, pathspecs };
}

/** Changed this week: the record files changed in the last 7 days, read from Git on each call, or why Git cannot tell. */
export async function loadRecordChanges(projectRoot: string, loaded: any = {}) {
  const { records, pathspecs } = await recordFiles(projectRoot, loaded);
  return recordChanges(projectRoot, records.map(({ kind, title, ref }) => ({ kind, title, ref })), pathspecs);
}

// Knowledge's entry points: the count of Changed this week only while Git can date the records; Touched by my work depends on the slice the page has open.
async function knowledgeEntries(projectRoot: string, loaded: any) {
  const changes = await loadRecordChanges(projectRoot, loaded).catch(() => null);
  return changes?.available ? { changed: changes.records.length } : {};
}

// Every leaf slice in progress, by initiative, for Touched by my work when no slice is open.
async function slicesInProgress(projectRoot: string) {
  const roadmap = await loadRoadmapView(projectRoot);
  const ids = [...roadmap.items.map((item: any) => item.id), ...roadmap.unlisted];
  const slices = [];
  for (const id of [...new Set(ids)]) {
    const view = await loadInitiativeView(projectRoot, id).catch(() => null);
    if (!view?.record) continue;
    const title = view.roadmapItem?.title ?? view.record.slices?.[view.derived?.root]?.title ?? id;
    for (const [slug, slice] of Object.entries<any>(view.record.slices ?? {})) {
      if (slice.status !== "in-progress" || (view.derived?.children?.[slug] ?? []).length) continue;
      slices.push({ initiative: { id, title }, slice: { slug, title: slice.title } });
    }
  }
  return slices;
}

export function loadNavigation(projectRoot: string) {
  return remember(`navigation:${projectRoot}`, () => computeNavigation(projectRoot));
}

async function computeNavigation(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const glossary = await loadGlossary(projectRoot);
  const attention = await loadAttention(projectRoot);
  const placed = await Promise.all([
    ...roadmap.items.map((item: any) => ({ id: item.id, title: item.title, band: item.band, state: item.state })),
    ...roadmap.unlisted.map((id: string) => ({ id, title: id, band: null, state: "unlisted" }))
  ].map(async (item) => ({ ...item, place: await initiativePlace(projectRoot, item.id) })));
  const listedInitiatives = await Promise.all(placed.map(withSliceTree(projectRoot)));
  // The libraries and diagrams are read once for their counts, the search index, and Changed this week; a library that cannot be read still fails the search index.
  const settled = (promise: any) => promise.then((value: any) => ({ value }), (error: any) => ({ error }));
  const read = Object.fromEntries(await Promise.all(["requirements", "decisions"].map(async (kind) => [kind, await settled(loadLibrary(projectRoot, kind))])));
  const readable = Object.fromEntries(Object.entries<any>(read).map(([kind, result]) => [kind, result.value ?? { entries: [] }]));
  const diagrams = await loadDiagrams(projectRoot).catch(() => []);
  return {
    roadmap: { exists: roadmap.exists ?? false, error: roadmap.error ?? null, valid: roadmap.valid ?? false },
    attention: { needsYou: attention.needsYou.length, gates: attention.gateCount, answered: attention.answered.length, watch: attention.watch.length },
    initiatives: listedInitiatives,
    // The glossary's entry carries its format mark, as each requirement and decision of the index does, so every list marks a record by its ref.
    glossary: { path: glossary.path, exists: glossary.exists, format: glossary.format ?? null },
    library: {
      ...Object.fromEntries(Object.entries<any>(readable).map(([kind, library]) => [kind, library.entries.length])),
      terms: glossary.glossaries ? glossary.glossaries.reduce((sum, one) => sum + one.terms.length, 0) : glossaryTerms(glossary.content).length,
      diagrams: diagrams.length,
      // In a workspace, each kind's count by scope label, which the scope filter sums.
      ...(glossary.glossaries ? { byScope: {
        requirements: readable.requirements.byScope ?? {},
        decisions: readable.decisions.byScope ?? {},
        terms: Object.fromEntries(glossary.glossaries.map((one) => [one.scope, one.terms.length])),
        diagrams: countByScope(diagrams)
      } } : {})
    },
    diagnostics: config.diagnostics,
    index: await searchIndex(projectRoot, config, roadmap, glossary, read),
    // Each place's own navigation data, by the place's name, for the places that need more than the lists above.
    places: { attention: attentionPlace(attention), work: await workGroups(projectRoot, listedInitiatives), history: historyEntries(roadmap), knowledge: await knowledgeEntries(projectRoot, { config, glossary, diagrams, ...readable }) }
  };
}

// History's entries: every initiative with a shipped or superseded decision, newest decision first, with what superseded it when the decision names it.
function historyEntries(roadmap: any) {
  const settled = (roadmap.items ?? []).filter((item: any) => item.decision?.kind === "shipped" || item.decision?.kind === "superseded");
  const time = (item: any) => {
    const value = Date.parse(item.decision.at ?? "");
    return Number.isFinite(value) ? value : -Infinity;
  };
  return settled
    .map((item: any, order: any) => ({ item, order }))
    .sort((left: any, right: any) => time(right.item) - time(left.item) || left.order - right.order)
    .map(({ item }: { item: any }) => ({ id: item.id, title: item.title, decision: item.decision.kind, at: item.decision.at ?? null, by: item.decision.kind === "superseded" ? item.decision.by ?? null : null }));
}

// Work's groups in their order, each initiative once and an empty group left out: work not on the roadmap, then blocked work that nobody is
// working on, then the roadmap's in-progress work, and every other designed, unshipped initiative; groups keep the roadmap's order, and
// initiatives not on the roadmap go by title.
const WORK_GROUPS = Object.freeze([
  { key: "in-progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "designed", label: "Designed, not started" },
  { key: "unlisted", label: "Not on the roadmap" }
]);

async function workGroups(projectRoot: string, initiatives: any) {
  const live = new Set((await loadClaims(projectRoot).catch(() => ({ claims: [] }))).claims.filter((claim: any) => !claim.expired).map((claim: any) => claim.ref));
  const members = new Map<any, any[]>(WORK_GROUPS.map((group) => [group.key, []]));
  for (const item of initiatives) {
    if (item.place !== "work") continue;
    const view = await loadInitiativeView(projectRoot, item.id).catch(() => null);
    const slices = Object.entries<any>(view?.record?.slices ?? {});
    const working = slices.some(([slug, slice]) => slice?.status === "in-progress" || live.has(`slice:${item.id}/${slug}`));
    const blocked = slices.some(([, slice]) => slice?.status === "blocked");
    const key = item.state === "unlisted" ? "unlisted" : blocked && !working ? "blocked" : item.state === "in-progress" ? "in-progress" : "designed";
    members.get(key)!.push({ id: item.id, title: item.title });
  }
  members.get("unlisted")!.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { groups: WORK_GROUPS.filter((group) => members.get(group.key)!.length).map((group) => ({ ...group, initiatives: members.get(group.key) })) };
}

// The place an initiative's pages belong to: History once it has a shipped or superseded decision, Work while it has an initiative record,
// and the Roadmap while it has neither.
async function initiativePlace(projectRoot: string, id: string) {
  const view = await loadInitiativeView(projectRoot, id).catch(() => null);
  const roadmap = view ? null : await loadRoadmapView(projectRoot);
  const decision = (view?.roadmapItem ?? roadmap?.items.find((item: any) => item.id === id))?.decision?.kind;
  if (decision === "shipped" || decision === "superseded") return "history";
  return view?.exists ? "work" : "roadmap";
}

// The sidebar nests the slices of each initiative that is being worked on, so a planned, in-progress, or unlisted initiative and every initiative of Work carries its slice tree.
const NAVIGATION_TREE_STATES = new Set(["planned", "in-progress", "unlisted"]);

function withSliceTree(projectRoot: string) {
  return async (item: any) => {
    if (!NAVIGATION_TREE_STATES.has(item.state) && item.place !== "work") return item;
    const { scope } = await initiativeTree(projectRoot, item.id).catch(() => ({ scope: null }));
    return scope ? { ...item, title: item.state === "unlisted" ? scope.title : item.title, tree: scope.tree } : item;
  };
}

function under(directory: string, file: string) {
  return Boolean(directory) && file.startsWith(`${directory}/`);
}

async function initiativeTree(projectRoot: string, id: string) {
  const view = await loadInitiativeView(projectRoot, id);
  const title = view.roadmapItem?.title ?? view.record?.slices?.[view.derived?.root]?.title ?? id;
  const scope = { kind: "initiative", id, title, state: view.roadmapItem?.state ?? (view.exists ? "unlisted" : "envisioned"), valid: view.valid, tree: [] as any[] };
  if (!view.derived) return { scope, view };
  const visit = (slug: string, depth: number) => {
    const slice = view.record.slices[slug];
    const children = view.derived.children[slug] ?? [];
    const review = view.slices[slug]?.review;
    scope.tree.push({ slug, title: slice.title, status: slice.status, depth, parent: slice.parent, hasChildren: children.length > 0, complete: Boolean(view.derived.complete[slug]), blocking: review && !review.invalid ? review.blocking : 0, ...slicePhase(slice) });
    for (const child of children) visit(child, depth + 1);
  };
  visit(view.derived.root, 0);
  return { scope, view };
}

function sliceTrail(view: any, slug: string, id: string) {
  const trail = [];
  // The root slice is the initiative itself, so the initiative crumb already stands for it.
  for (let owner = view.record.slices[slug]?.parent ?? null; owner !== null && owner !== view.derived?.root; owner = view.record.slices[owner].parent) trail.unshift({ ref: `slice:${id}/${owner}`, label: view.record.slices[owner].title });
  trail.push({ ref: `slice:${id}/${slug}`, label: view.record.slices[slug].title });
  return trail;
}

async function libraryScope(projectRoot: string, section: string) {
  const library = await loadLibrary(projectRoot, section);
  return { kind: "library", section, entries: library.entries.map((entry: any) => ({ path: entry.path, title: entry.title, status: entry.status, topic: entry.topic, ...(entry.scope ? { scope: entry.scope } : {}) })) };
}

const PLACE_LABELS: Readonly<Record<string, any>> = Object.freeze({ attention: "Attention", work: "Work", roadmap: "Roadmap", knowledge: "Knowledge", history: "History" });
// The pages of Attention's and Knowledge's own addresses, by the part after their place's prefix.
const PLACE_PAGE_LABELS: Readonly<Record<string, any>> = Object.freeze({
  attention: { questions: "Questions", findings: "Review findings", failed: "Failed verifications", blocked: "Blocked work", ready: "Ready to ship", problems: "Problems", formats: "Format findings", answered: "Answered in the last 7 days", "roadmap-questions": "Roadmap questions" },
  knowledge: { touched: "Touched by my work", changed: "Changed this week", diagrams: "Diagrams" }
});

// The crumb that starts the trail of a page of a place: the place's name, carrying the place, and the page itself for the place's own entry page.
function placeCrumb(place: any, ref: any = null) {
  return { ref, label: PLACE_LABELS[place], place };
}

// The page of an initiative or a slice, a file of its plans folder, or one of its Prism records, with the trail from its place through its slices.
async function initiativeContext(projectRoot: string, id: string, { slug = null, file = null }: any = {}) {
  const { scope, view } = await initiativeTree(projectRoot, id);
  const place = await initiativePlace(projectRoot, id);
  const trail = [placeCrumb(place), { ref: `initiative:${id}`, label: scope.title }];
  const known = slug && view.record && Object.hasOwn(view.record.slices, slug) ? slug : null;
  if (known) trail.push(...sliceTrail(view, known, id));
  if (file) trail.push(file);
  return { trail, scope: { ...scope, current: known }, place };
}

async function knownInitiative(projectRoot: string, id: string) {
  if ((await readText(projectRoot, await recordFile(projectRoot, { kind: "initiative", initiative: id }))) !== null) return true;
  const roadmap = await loadRoadmapView(projectRoot).catch(() => null);
  return Boolean(roadmap?.items?.some((item: any) => item.id === id));
}

// A page of a shipped initiative carries its shipped history with the label the page shows, or null when the initiative has not shipped.
async function pageHistory(projectRoot: string, initiative: any) {
  const history = await shippedHistory(projectRoot, initiative).catch(() => null);
  return history ? { ...history, label: shippedHistoryLabel(initiative, { at: history.shippedAt }) } : null;
}

// A slice document of a shipped initiative carries the page's shipped history, with changedAfterShip saying whether this document changed after ship.
async function documentHistory(projectRoot: string, plans: any, ref: any) {
  if (!under(plans, ref) || path.posix.basename(ref) !== "slice.md") return null;
  const id = ref.slice(plans.length + 1).split("/")[0];
  if (!SLUG_PATTERN.test(id ?? "")) return null;
  const history = await pageHistory(projectRoot, id);
  if (!history) return null;
  const changed = history.changedAfterShip.some((item) => item.path === ref);
  if (!changed && !history.documents.includes(ref)) return null;
  return { ...history, changedAfterShip: changed };
}

// Context gives every tab, including plain files, a breadcrumb trail, the sidebar scope it belongs to, and the place it belongs to:
// the trail of a page of a place starts with the place's crumb, and a page of no place keeps its trail from Files.
export async function entityContext(projectRoot: string, ref: any) {
  const parsed = parseEntityRef(ref);
  if (ref === "attention" || ref === "roadmap") return { trail: [placeCrumb(ref, ref)], scope: { kind: "global" }, place: ref };
  if (parsed?.kind === "requirements" || parsed?.kind === "decisions") return { trail: [placeCrumb("knowledge"), { ref, label: SECTION_LABELS[parsed.kind] }], scope: await libraryScope(projectRoot, parsed.kind), place: "knowledge" };
  if (parsed?.kind === "glossary") return { trail: [placeCrumb("knowledge"), { ref, label: "Glossary" }], scope: { kind: "global" }, place: "knowledge" };
  // A workspace's code content belongs with its records in Knowledge.
  if (parsed?.kind === "code") return { trail: [placeCrumb("knowledge"), { ref, label: "Code" }], scope: { kind: "global" }, place: "knowledge" };
  // The Agents page belongs to no place of the rail, so its trail is its own name, whichever group its address shows.
  if (parsed?.kind === "agents") return { trail: [{ ref, label: SECTION_LABELS.agents }], scope: { kind: "global" }, place: null };
  if (parsed?.kind === "initiative" || parsed?.kind === "slice") return initiativeContext(projectRoot, parsed.id, { slug: parsed.kind === "slice" ? parsed.slug : null });
  if (parsed?.kind === "migration-run") return migrationRunContext(projectRoot, ref, parsed.id);
  if (typeof ref !== "string" || !ref) throw new Error("A tab reference is required.");
  const prefixed = /^(attention|knowledge):(.+)$/.exec(ref);
  if (prefixed) {
    const [, place, page] = prefixed;
    const entry = place === "attention" ? placeCrumb("attention", "attention") : placeCrumb("knowledge");
    const label = place === "attention" && page.startsWith("work/") ? (await attentionPage(projectRoot, page) as any).filter!.label : PLACE_PAGE_LABELS[place][page] ?? page;
    return { trail: [entry, { ref, label }], scope: { kind: "global" }, place };
  }
  const config = await readWorkflowConfig(projectRoot);
  const history = await documentHistory(projectRoot, config.paths.plans, ref);
  if (history) return { ...(await fileContext(projectRoot, config, ref)), shippedHistory: history };
  return fileContext(projectRoot, config, ref);
}

// The trail and scope of a file tab.
async function fileContext(projectRoot: string, config: any, ref: any) {
  const roadmapCrumb = { ref: "roadmap", label: "Roadmap" };
  const libraryCrumb = { ref: null, label: "Library" };
  const fileCrumb = { ref, label: path.posix.basename(ref) };
  const plans = config.paths.plans;
  const record = await keyOfPath(projectRoot, ref).catch(() => null);
  if (record?.initiative && ref.startsWith(".prism/")) return initiativeContext(projectRoot, record.initiative, { slug: record.slice ?? null, file: fileCrumb });
  if (under(plans, ref)) {
    const [id, segment] = ref.slice(plans.length + 1).split("/");
    // A plans folder is an initiative's when the initiative has a record or stands on the roadmap; its record and decision then choose the place.
    if (SLUG_PATTERN.test(id ?? "") && await knownInitiative(projectRoot, id)) {
      return initiativeContext(projectRoot, id, { slug: segment && ref !== `${plans}/${id}/${segment}` ? segment : null, file: fileCrumb });
    }
  }
  for (const section of ["requirements", "decisions"]) {
    const directory = section === "requirements" ? config.paths.requirements : config.paths.adrs;
    if (under(directory, ref)) {
      const scope = await libraryScope(projectRoot, section);
      const entry = scope.entries.find((item: any) => item.path === ref);
      return { trail: [placeCrumb("knowledge"), { ref: section, label: SECTION_LABELS[section] }, { ref, label: entry?.title ?? path.posix.basename(ref) }], scope: { ...scope, current: ref }, place: "knowledge" };
    }
  }
  if (ref === config.paths.glossary) return { trail: [placeCrumb("knowledge"), { ref: "glossary", label: "Glossary" }, fileCrumb], scope: { kind: "global" }, place: "knowledge" };
  const roadmapPaths = await readRoadmap(projectRoot).then(({ resolved }) => [resolved.recordPath, resolved.projectionPath]).catch((): any[] => []);
  if (roadmapPaths.includes(ref)) return { trail: [placeCrumb("roadmap"), fileCrumb], scope: { kind: "global" }, place: "roadmap" };
  return { trail: [{ ref: null, label: "Files" }, { ref, label: ref }], scope: { kind: "global" }, place: null };
}

function relatedTitles(roadmap: any, id: string) {
  const item = roadmap.items.find((entry: any) => entry.id === id);
  const related = new Set([...(item?.requires ?? []), ...(item?.requiredBy ?? [])]);
  return Object.fromEntries(roadmap.items.filter((entry: any) => related.has(entry.id)).map((entry: any) => [entry.id, entry.title]));
}

function bandRank(roadmap: any, id: string) {
  const item = roadmap.items.find((entry: any) => entry.id === id);
  if (!item || item.state === "shipped" || item.state === "superseded") return null;
  const rank = roadmap.items.filter((entry: any) => entry.band === item.band && entry.state !== "shipped" && entry.state !== "superseded").findIndex((entry: any) => entry.id === id);
  return rank < 0 ? null : rank + 1;
}

// Entity tabs name Prism concepts rather than files, so they never collide with artifact paths, which always carry an extension.
export function parseEntityRef(ref: any): any {
  if (SECTION_REFS.includes(ref)) return { kind: ref };
  // The Launched sessions address, as a restored tab or an old link, opens the Agents page that replaced it.
  if (ref === "launches") return { kind: "agents" };
  // The Agents page with one Show choice made.
  const group = /^agents:([a-z-]+)$/.exec(ref ?? "");
  if (group && AGENT_GROUP_PAGES.includes(group[1])) return { kind: "agents", page: group[1] };
  // Attention's filtered pages: one kind, one initiative's items, the roadmap's open questions, or the questions answered this week.
  let match = /^attention:(questions|findings|failed|blocked|ready|problems|formats|answered|roadmap-questions|work\/[A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "attention", page: match[1] };
  // Knowledge's own pages: the diagrams, the records behind the open slice, and this week's record changes.
  match = /^knowledge:(diagrams|touched|changed)$/.exec(ref ?? "");
  if (match) return { kind: "knowledge", page: match[1] };
  match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  // A format migration run's page, which Attention, the Agents page, and a migrated document's note open.
  match = /^migration-run:(.+)$/.exec(ref ?? "");
  if (match && RUN_ID.test(match[1])) return { kind: "migration-run", id: match[1] };
  return null;
}

export async function entityExists(projectRoot: string, ref: any) {
  const parsed = parseEntityRef(ref);
  if (!parsed) return false;
  if (SECTION_REFS.includes(parsed.kind) || parsed.kind === "knowledge") return true;
  if (parsed.kind === "migration-run") return (await readRun(projectRoot, parsed.id).catch(() => null)) !== null;
  if (parsed.kind === "initiative") {
    const roadmap = await loadRoadmapView(projectRoot);
    if (roadmap.items.some((item: any) => item.id === parsed.id) || roadmap.unlisted.includes(parsed.id)) return true;
    return (await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: { exists: false } }))).loaded.exists;
  }
  const { loaded } = await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: {} }));
  return Boolean(loaded.record?.slices && Object.hasOwn(loaded.record.slices, parsed.slug));
}

// The code location of each slice's latest passing verification run, by slice; only the initiative page reads run records for it.
async function initiativeCode(projectRoot: string, view: any) {
  const code: Record<string, any> = {};
  for (const slug of Object.keys(view.record?.slices ?? {})) {
    const checkout = await verifiedCode(projectRoot, view.id, slug).catch(() => null);
    if (checkout) code[slug] = checkout;
  }
  return code;
}

export async function loadEntity(projectRoot: string, ref: any, options: any = {}) {
  const parsed = parseEntityRef(ref);
  if (!parsed) throw new Error(`Unknown entity reference: ${ref}`);
  if (parsed.kind === "migration-run") return { ref, kind: "migration-run", data: await loadMigrationRunView(projectRoot, parsed.id) };
  if (parsed.kind === "attention") return { ref, kind: "attention", data: parsed.page ? await attentionPage(projectRoot, parsed.page) : await loadAttentionView(projectRoot) };
  if (parsed.kind === "roadmap") return { ref, kind: "roadmap", data: await loadRoadmapView(projectRoot) };
  if (parsed.kind === "requirements" || parsed.kind === "decisions") return { ref, kind: parsed.kind, data: await loadLibrary(projectRoot, parsed.kind) };
  if (parsed.kind === "glossary") return { ref, kind: "glossary", data: await loadGlossary(projectRoot) };
  // A workspace's page lists its code repositories itself; a checkout's own page has none.
  if (parsed.kind === "code") return { ref, kind: "code", data: { repositories: [] } };
  // The page reads its agents from api/agents itself and carries only the group its address shows, so a running time never redraws it.
  if (parsed.kind === "agents") return { ref, kind: "agents", data: { show: parsed.page ?? "all" } };
  if (parsed.kind === "knowledge" && parsed.page === "diagrams") {
    const diagrams = await loadDiagrams(projectRoot);
    // Each diagram's kind and the page of what it belongs to, by path, beside the list that clause 51 of the places contract fixes.
    const about = Object.fromEntries(diagrams.map(({ path: file, kind, ownerRef }: { path: any; kind: any; ownerRef: any }) => [file, { kind, owner: ownerRef }]));
    return { ref, kind: "diagrams", data: { diagrams: diagrams.map(({ path: file, name, owner }: { path: any; name: string; owner: any }) => ({ path: file, name, owner })), about } };
  }
  if (parsed.kind === "knowledge" && parsed.page === "touched") return { ref, kind: "touched", data: { inProgress: await slicesInProgress(projectRoot) } };
  if (parsed.kind === "knowledge") return { ref, kind: "changed", data: await loadRecordChanges(projectRoot) };
  if (parsed.kind === "initiative") {
    const view = await loadInitiativeView(projectRoot, parsed.id);
    const history = await pageHistory(projectRoot, parsed.id);
    return { ref, kind: "initiative", data: { ...view, runTotals: await loadInitiativeRunTotals(projectRoot, view), code: await initiativeCode(projectRoot, view), ...(history ? { shippedHistory: history } : {}) } };
  }
  const history = await pageHistory(projectRoot, parsed.id);
  const slice = await loadSliceView(projectRoot, parsed.id, parsed.slug, options);
  return { ref, kind: "slice", data: history ? { ...slice, shippedHistory: history } : slice };
}
