// Generated from src/server/review/workspace-model.mts by scripts/native-build/compile.mjs.
import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readInitiativeRecordRunTotals } from "../session/run-totals.mjs";
import { storeLocation } from "../session/launch-records.mjs";
import { pendingRequests } from "../session/permission-requests.mjs";
import { listLaunches } from "../session/launched-sessions.mjs";
import { hostDefinition } from "../session/launch-hosts.mjs";
import { readInitiative, readInitiativeWithClaims, sliceFolder } from "../workflow/initiative.mjs";
import { isLive, parseClaim } from "../workflow/slice-claims.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { DISPLAY_BANDS, readRoadmap } from "../workflow/roadmap.mjs";
import { historyOrder, readCoordinationState } from "../workflow/state.mjs";
import { readIndexHistory } from "../workflow/index-history.mjs";
import { RECORD_DIRECTORY, inArtifactStore, isStoreWithoutCheckout, keyOfPath, listClaimRecords, listInitiatives, listSliceRecords, listStoreArtifacts, locateRecord, readArtifactText, recordStoreOf, recordsUnavailable, resolveRecordFile } from "../workflow/record-store.mjs";
import { initiativeDirectory, readWorkflowConfig as readCheckoutConfig } from "../workflow/workflow-config.mjs";
import { latestVerification, verifiedCode } from "../workflow/slice-design.mjs";
import { lastChangeMapDerivation, startChangeMapDerivation } from "../conservation/derived-change-map.mjs";
import { contractClauses, loadDesignView } from "../workflow/design-view.mjs";
import { declaredView, governingContract, readViews, VIEW_KINDS } from "../workflow/view-declarations.mjs";
import { answeredApprovalGates, appliedArtifactActions, pendingApprovalGates, readStoreArtifactAt, storeArtifactLocation, storeArtifactStatuses, workspaceArtifacts } from "../workflow/store-artifacts.mjs";
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
import { createViewVersions } from "./view-versions.mjs";
import { collectValidity, validUntil } from "../workflow/view-validity.mjs";
async function readWorkflowConfig(projectRoot) {
  const config = await readCheckoutConfig(projectRoot);
  return await isStoreWithoutCheckout(projectRoot) ? { ...config, diagnostics: [] } : config;
}
const LIBRARY_LIMIT = 500;
const RECENT_CHANGES_LIMIT = 20;
const SLICE_FILE_LIMIT = 200;
const UNRESOLVED = /* @__PURE__ */ new Set(["OPEN", "IN PROGRESS", "REOPENED"]);
const MAX_AGE_MS = 10 * 60 * 1e3;
const memo = /* @__PURE__ */ new Map();
const versions = createViewVersions({ targetsOf: viewTargets });
async function viewTargets(projectRoot) {
  const root = await realpath(projectRoot);
  const store = await recordStoreOf(root);
  const folders = /* @__PURE__ */ new Set([store.base]);
  const files = /* @__PURE__ */ new Set();
  if (!store.checkoutless) {
    folders.add(path.join(root, RECORD_DIRECTORY));
    const config = await readCheckoutConfig(root).catch(() => null);
    for (const value of Object.values(config?.paths ?? {})) {
      if (typeof value !== "string" || value === "" || value === ".") continue;
      const target = path.join(root, value);
      const info = await stat(target).catch(() => null);
      (info?.isDirectory() ? folders : files).add(target);
    }
  }
  const nested = [...folders].filter((folder) => [...folders].some((other) => other !== folder && folder.startsWith(`${other}${path.sep}`)));
  return { folders: [...folders].filter((folder) => !nested.includes(folder)).sort(), files: [...files].sort(), gitRoots: store.checkoutless ? [] : [root] };
}
const workspaceView = new AsyncLocalStorage();
const inWorkspaceView = () => workspaceView.getStore() === true;
function asWorkspaceView(run) {
  return workspaceView.run(true, run);
}
async function remember(projectRoot, raw, compute) {
  const key = `${inWorkspaceView() ? "workspace" : "checkout"}|${raw}`;
  const version = await versions.current(projectRoot);
  const now = Date.now();
  let hit = memo.get(key);
  if (!hit || hit.version !== version || now >= hit.until) {
    const entry = { version, until: now + MAX_AGE_MS, value: null };
    entry.value = collectValidity(compute).then(({ value: value2, until }) => {
      entry.until = Math.min(entry.until, until);
      return value2;
    });
    entry.value.catch(() => {
      if (memo.get(key) === entry) memo.delete(key);
    });
    memo.set(key, entry);
    hit = entry;
  }
  const value = await hit.value;
  validUntil(hit.until);
  return value;
}
async function prime(projectRoot, raw, value) {
  const key = `${inWorkspaceView() ? "workspace" : "checkout"}|${raw}`;
  memo.set(key, { version: await versions.current(projectRoot), until: Date.now() + MAX_AGE_MS, value: Promise.resolve(value) });
}
function rememberView(projectRoot, name, compute) {
  return remember(projectRoot, `${name}:${projectRoot}`, compute);
}
function viewWatching(projectRoot) {
  return versions.watching(projectRoot);
}
function viewVersion(projectRoot) {
  return versions.current(projectRoot);
}
function recheckViews(projectRoot) {
  versions.recheck(projectRoot);
}
function forgetWorkspace() {
  memo.clear();
  versions.bump();
}
const formatMark = (artifact) => !artifact || artifact.conforms ? null : { rules: [...new Set(artifact.findings.map((finding) => finding.rule))].sort(), findings: artifact.findings };
const scopeKey = (scope) => scope === null || scope === void 0 ? "" : typeof scope === "string" ? scope : scope.label ?? "";
function markLookup(artifacts) {
  const marks = new Map(artifacts.map((artifact) => [`${scopeKey(artifact.scope)}\0${artifact.path}`, formatMark(artifact)]));
  return (file, scope = null) => marks.get(`${scopeKey(scope)}\0${file}`) ?? null;
}
const marksKey = (projectRoot) => `format-marks:${projectRoot}`;
function loadFormatMarks(projectRoot) {
  return remember(projectRoot, marksKey(projectRoot), async () => {
    try {
      return markLookup((await checkArtifacts({ projectRoot, startRuns: false })).artifacts);
    } catch {
      return () => null;
    }
  });
}
async function loadFormatMark(projectRoot, file, scope = null) {
  try {
    const label = scopeKey(scope);
    const [artifact] = (await checkArtifacts({ projectRoot, paths: [label ? { path: file, scope: label } : file], startRuns: false })).artifacts;
    return formatMark(artifact);
  } catch {
    return null;
  }
}
const SECTION_REFS = Object.freeze(["attention", "roadmap", "requirements", "decisions", "glossary", "code", "agents"]);
const SECTION_LABELS = Object.freeze({ attention: "Attention", roadmap: "Roadmap", requirements: "Requirements", decisions: "Decisions", glossary: "Glossary", code: "Code", agents: "Agents" });
const AGENT_GROUP_PAGES = Object.freeze(["needs-you", "this-computer", "other", "expired", "archived"]);
async function recordFile(root, key) {
  const located = await locateRecord(root, key);
  return located.legacy ?? located.path;
}
async function readText(root, relative) {
  try {
    if (relative.startsWith(STORE_REF)) {
      const held = await readStoreArtifactAt(root, relative.slice(STORE_REF.length));
      return held ? textOf(held.bytes) : null;
    }
    if (await inArtifactStore(root, relative)) return await readArtifactText(root, relative);
    return await readFile((await resolveRecordFile(root, relative)).target, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code) || recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }
}
const STORE_REF = "store:";
const storeRef = (location) => `${STORE_REF}${location}`;
const textOf = (bytes) => Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");
function workspaceListing(projectRoot) {
  if (!inWorkspaceView()) return Promise.resolve(null);
  return remember(projectRoot, `workspace-listing:${projectRoot}`, () => workspaceArtifacts(projectRoot).then((listed) => listed.held ? listed : null, (error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return null;
    throw error;
  }));
}
async function scopedArtifacts(projectRoot, kind, accept) {
  const listed = await workspaceListing(projectRoot);
  if (!listed) return null;
  const entries = listed.entries.filter((entry) => entry.kind === kind && accept(path.posix.basename(entry.location))).slice(0, LIBRARY_LIMIT).map((entry) => ({ ...entry, ref: storeRef(entry.location), label: entry.scope.label }));
  const own = (scope) => scope.kind === "workspace" || listed.repository !== null && scope.repository === listed.repository;
  return { entries, own };
}
function refAt(entries, own, file, label = null) {
  const holding = entries.filter((entry) => entry.path === file);
  if (!holding.length) return null;
  return (holding.find((entry) => entry.label === label) ?? holding.find((entry) => entry.scope.kind !== "workspace" && own(entry.scope)) ?? holding.find((entry) => entry.scope.kind === "workspace") ?? holding[0]).ref;
}
function countByScope(entries, labelOf = (entry) => entry.scope ?? entry.label) {
  const counts = {};
  for (const entry of entries) {
    const label = labelOf(entry);
    if (label) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
async function storeWalk(root, relative, depth, accept, limit) {
  const stored = await listStoreArtifacts(root, relative).catch((error) => {
    if (recordsUnavailable(error) || error?.name === "ArtifactError") return [];
    throw error;
  });
  if (stored === null) return null;
  const prefix = relative ? `${relative}/` : "";
  const files = [...new Set(stored.map((entry) => entry.path))].filter((file) => {
    const parts = file.slice(prefix.length).split("/");
    return parts.length <= depth + 1 && accept(parts.at(-1));
  });
  const order = (file) => file.slice(prefix.length).split("/").map((name) => name.toLowerCase());
  return files.sort((left, right) => {
    const a = order(left), b = order(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index].localeCompare(b[index]);
    return a.length - b.length;
  }).slice(0, limit);
}
async function walk(root, relative, depth, accept, results, limit) {
  if (await inArtifactStore(root, `${relative}/x`).catch(() => false)) {
    const stored = await storeWalk(root, relative, depth, accept, limit - results.length);
    if (stored !== null) {
      results.push(...stored);
      return;
    }
  }
  let entries;
  try {
    entries = await readdir((await resolveRecordFile(root, relative)).target, { withFileTypes: true });
  } catch (error) {
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
function headerFields(source) {
  const title = source.match(/^#\s+(.+?)\s*$/m)?.[1] ?? null;
  const field = (name) => source.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;
  return { title, status: field("Status"), created: field("Created"), approved: field("Approved") };
}
function reviewSummary(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const unresolved = findings.filter((finding) => UNRESOLVED.has(finding.status));
  const deferred = findings.filter((finding) => finding.status === "DEFERRED");
  const waves = Array.isArray(review?.waves) ? review.waves : [];
  return {
    findings: findings.length,
    unresolved: unresolved.length,
    blocking: findings.filter((finding) => !["VERIFIED", "DEFERRED"].includes(finding.status) && ["blocker", "high"].includes(finding.severity)).length,
    byStatus: Object.fromEntries(["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED", "DEFERRED"].map((status) => [status, findings.filter((finding) => finding.status === status).length])),
    // A deferred finding is resolved by the user's decision gate, so it is counted apart and listed with its follow-up.
    deferred: deferred.length,
    deferredFindings: deferred.map((finding) => ({ id: finding.id, severity: finding.severity, title: finding.title, gate: finding.deferral?.gate ?? null, followUp: finding.deferral?.followUp ?? null })),
    waves: waves.length,
    currentWave: waves.at(-1) ? { id: waves.at(-1).id, mode: waves.at(-1).mode, accepted: Boolean(waves.at(-1).accepted) } : null
  };
}
const COORDINATION_FILES = /* @__PURE__ */ new Set(["initiative.md"]);
async function sliceArtifacts(root, directory, slices, slug, id) {
  const folder = sliceFolder(directory, slices, slug);
  const files = [];
  if (folder === directory) await walk(root, folder, 0, (name) => !COORDINATION_FILES.has(name), files, SLICE_FILE_LIMIT);
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
    changeMap: await isFile(root, changeMap) ? changeMap : null,
    review
  };
}
function storedInitiatives(root) {
  return listInitiatives(root).catch((error) => {
    if (recordsUnavailable(error)) return [];
    throw error;
  });
}
async function initiativeFolders(root) {
  const ids = [];
  for (const id of await storedInitiatives(root)) if (await readText(root, await recordFile(root, { kind: "initiative", initiative: id })) !== null) ids.push(id);
  return ids;
}
async function initiativeFindings(root, config, id) {
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
    }
  }
  return totals;
}
function loadRoadmapView(projectRoot) {
  return remember(projectRoot, `roadmap:${projectRoot}`, () => computeRoadmapView(projectRoot));
}
async function computeRoadmapView(projectRoot) {
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
        requiredBy: record.initiatives.filter((other) => other.requires.includes(item.id)).map((other) => other.id),
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
function loadClaims(projectRoot) {
  return remember(projectRoot, `claims:${projectRoot}`, async () => ({ claims: (await loadHeldClaims(projectRoot)).claims.map(({ holder, ...claim }) => claim) }));
}
function loadHeldClaims(projectRoot) {
  return remember(projectRoot, `held-claims:${projectRoot}`, () => computeClaims(projectRoot));
}
async function computeClaims(projectRoot) {
  const roadmap = await loadRoadmapView(projectRoot);
  const listed = [...roadmap.items.map((item) => ({ id: item.id, title: item.title ?? item.id })), ...roadmap.unlisted.map((id) => ({ id, title: id }))];
  const initiatives = await Promise.all(listed.map(async ({ id, title }) => ({ id, title, claims: sliceClaims(await claimedSlices(projectRoot, id), { holders: true }) })));
  return { claims: initiatives.flatMap(({ id, title, claims }) => claims.map((claim) => ({ ref: `slice:${id}/${claim.slug}`, initiative: id, initiativeTitle: title, ...claim }))) };
}
function loadInitiativeView(projectRoot, id) {
  return remember(projectRoot, `initiative:${id}:${projectRoot}`, () => computeInitiativeView(projectRoot, id));
}
function loadInitiativeRunTotals(projectRoot, initiative) {
  return remember(projectRoot, `run-totals:${initiative.id}:${projectRoot}`, () => readInitiativeRecordRunTotals(projectRoot, initiative.id, initiative));
}
async function withExpiredClaims(projectRoot, id, read) {
  const slices = read.loaded.record?.slices;
  if (!slices || typeof slices !== "object") return read;
  const records = await listClaimRecords(projectRoot, id).catch(() => []);
  const now = Date.now();
  let copy = null;
  for (const { slice, bytes } of records) {
    const { claim } = parseClaim(slice, bytes);
    if (!claim || isLive(claim, now) || !Object.hasOwn(slices, slice) || slices[slice].claim) continue;
    copy ??= { ...slices };
    copy[slice] = { ...slices[slice], expiredClaim: { holder: claim.holder, label: claim.label, ...claim.host ? { host: claim.host } : {}, ...claim.model ? { model: claim.model } : {}, ...sessionFields(claim), activity: claim.activity, claimedAt: claim.claimedAt, expiresAt: claim.expiresAt } };
  }
  return copy ? { ...read, loaded: { ...read.loaded, record: { ...read.loaded.record, slices: copy } } } : read;
}
function sliceClaims(slices, { holders = false } = {}) {
  const claims = [];
  for (const [slug, slice] of Object.entries(slices ?? {})) {
    const claim = slice?.claim ?? slice?.expiredClaim;
    if (!claim || typeof claim.label !== "string") continue;
    claims.push({ slug, sliceTitle: slice.title ?? slug, ...holders ? { holder: typeof claim.holder === "string" ? claim.holder : null } : {}, label: claim.label, host: typeof claim.host === "string" ? claim.host : null, model: typeof claim.model === "string" ? claim.model : null, ...keptSession(claim), activity: claim.activity === "design" ? "design" : "implementation", claimedAt: claim.claimedAt ?? null, renewedAt: claim.renewedAt ?? null, expiresAt: claim.expiresAt ?? null, expired: !slice.claim });
  }
  return claims;
}
function slicePhase(slice) {
  return { status: slice?.status ?? "not-started", designed: Boolean(slice?.design), review: slice?.design?.review ?? null };
}
function sliceFacts(slices) {
  const entries = Object.entries(slices ?? {});
  const parents = new Set(entries.map(([, slice]) => slice?.parent).filter((parent) => typeof parent === "string"));
  return { claims: sliceClaims(slices), slices: entries.filter(([slug]) => !parents.has(slug)).map(([slug, slice]) => ({ slug, ...slicePhase(slice) })) };
}
async function claimedSlices(projectRoot, id) {
  try {
    return (await withExpiredClaims(projectRoot, id, await readInitiativeWithClaims(projectRoot, id))).loaded.record?.slices ?? null;
  } catch {
    return null;
  }
}
function holdingClaim(slices, slug) {
  for (let owner = slug; owner !== null && owner !== void 0 && slices && Object.hasOwn(slices, owner); owner = slices[owner].parent ?? null) {
    const claim = slices[owner].claim;
    if (claim && typeof claim.label === "string" && (owner === slug || claim.activity === "design")) return { label: claim.label, host: typeof claim.host === "string" ? claim.host : null, model: typeof claim.model === "string" ? claim.model : null, ...keptSession(claim), activity: claim.activity === "design" ? "design" : "implementation", claimedAt: claim.claimedAt ?? null, renewedAt: claim.renewedAt ?? null, expiresAt: claim.expiresAt ?? null };
  }
  return null;
}
async function computeInitiativeView(projectRoot, id) {
  if (!SLUG_PATTERN.test(id ?? "")) throw new Error("The initiative identifier is invalid.");
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const { resolved, loaded } = await withExpiredClaims(projectRoot, id, await readInitiativeWithClaims(projectRoot, id));
  let state = null;
  try {
    state = (await readCoordinationState({ projectRoot, initiative: id })).state;
  } catch {
    state = null;
  }
  const slices = {};
  if (loaded.record?.slices) {
    for (const slug of Object.keys(loaded.record.slices)) slices[slug] = await sliceArtifacts(projectRoot, resolved.directory, loaded.record.slices, slug, id);
  }
  const analysis = loaded.analysis;
  const designReview = {};
  for (const gate of state?.pending ?? []) {
    if (gate && typeof gate === "object" && gate.kind === "visual-review" && gate.slice && loaded.record?.slices?.[gate.slice]?.status === "not-started") designReview[gate.slice] = gate.answer ? "answered" : "waiting";
  }
  return {
    id,
    directory: resolved.directory,
    recordPath: await recordFile(projectRoot, { kind: "initiative", initiative: id }),
    statePath: await recordFile(projectRoot, { kind: "state", initiative: id }),
    roadmapItem: roadmap.items.find((item) => item.id === id) ?? null,
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
    derived: analysis ? { root: analysis.root, children: analysis.children, leaves: analysis.leaves, counts: analysis.counts, effectiveDependencies: analysis.effectiveDependencies, complete: analysis.complete, designCandidates: analysis.designCandidates.filter((slug) => !designReview[slug]), dependenciesComplete: analysis.dependenciesComplete } : null,
    active: state?.active ?? [],
    designReview,
    slices,
    config: { paths: config.paths }
  };
}
function supersedingItem(roadmap, id) {
  const decision = roadmap.items.find((item) => item.id === id)?.decision;
  if (decision?.kind !== "superseded" || !decision.by) return null;
  const by = roadmap.items.find((item) => item.id === decision.by);
  return { id: decision.by, title: by?.title ?? decision.by };
}
async function derivedChangeMapState(projectRoot, id, slug, design, verification) {
  if (!design?.baselineId || !verification?.passed || !verification.snapshotId || verification.designAcceptedAt !== design.acceptedAt) return null;
  const source = await readText(projectRoot, await recordFile(projectRoot, { kind: "change-map", initiative: id, slice: slug }));
  let document = null;
  try {
    document = source === null ? null : parseStoreJson(source);
  } catch {
    return { derived: false };
  }
  if (document && !document.derived) return { derived: false };
  if (document?.derived?.runId === verification.id) return { derived: true, runId: verification.id, document };
  const key = { projectRoot, initiative: id, slice: slug };
  const last = lastChangeMapDerivation(key);
  if (last?.runId === verification.id && last.status === "empty") return { derived: true, empty: true, runId: verification.id };
  if (last && ["failed", "unavailable"].includes(last.status)) return { derived: true, failed: last.reason ?? last.status };
  startChangeMapDerivation(key);
  return { derived: true, pending: true, runId: verification.id };
}
function coveringClaim(slices, slug) {
  for (let owner = slices[slug]?.parent ?? null; owner !== null && Object.hasOwn(slices, owner); owner = slices[owner].parent ?? null) {
    if (slices[owner].claim?.activity === "design") return { slug: owner, title: slices[owner].title, claim: slices[owner].claim };
  }
  return null;
}
const VIEW_SOURCE_LIMIT = 256 * 1024;
function diagramTitle(source) {
  const title = source?.match(/^[ \t]*title[ \t]+(\S.*?)[ \t]*$/im)?.[1]?.replace(/^"(.*)"$/, "$1").trim();
  return title || null;
}
async function folderViews(projectRoot, initiative, slug, plans) {
  const artifacts = initiative.slices[slug];
  if (!artifacts) return [];
  const design = artifacts.narrative ? await readText(projectRoot, artifacts.narrative) : null;
  const read = readViews(design, artifacts.folder, { plans }).views;
  const declared = read.filter((view) => VIEW_KINDS.includes(view.kind));
  const named = new Set(read.map((view) => view.path));
  const others = (artifacts.files ?? []).filter((file) => file.endsWith(".puml") && path.posix.dirname(file) === artifacts.folder && !named.has(file));
  if (!declared.length && !others.length) return [];
  const governing = await governingContract(projectRoot, artifacts.folder, plans ?? initiative.directory).catch(() => null);
  const owner = governing ? Object.keys(initiative.slices).find((key) => initiative.slices[key].narrative === governing.path) ?? null : null;
  const contract = governing ? { path: governing.path, slice: owner, title: owner ? initiative.record.slices[owner]?.title ?? owner : null, ref: owner ? `slice:${initiative.id}/${owner}` : null } : null;
  const shown = (source) => source !== null && source.length <= VIEW_SOURCE_LIMIT ? source : null;
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
  const unasked = await Promise.all(others.map(async (file) => {
    const source = await readText(projectRoot, file);
    const name = path.posix.basename(file);
    return { path: file, file: name, kind: "diagram", title: diagramTitle(source) ?? name, question: null, clauses: [], source: shown(source), missing: source === null, contract, declared: false };
  }));
  return [...listed, ...unasked];
}
async function loadSliceViews(projectRoot, initiative, slug) {
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
async function loadDeclaredView(projectRoot, file) {
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
async function loadSliceView(projectRoot, id, slug, { intelligenceDirectories } = {}) {
  const initiative = await loadInitiativeView(projectRoot, id);
  if (!initiative.record || !Object.hasOwn(initiative.record.slices, slug)) throw new Error(`The initiative ${id} has no slice ${slug}.`);
  const slice = initiative.record.slices[slug];
  const derived = initiative.derived;
  const latest = await latestVerification(projectRoot, id, slug).catch(() => null);
  const verification = latest?.failing?.length ? { ...latest, failingLinks: await failingTestLinks(projectRoot, id, slug, latest.failing).catch(() => []) } : latest;
  const { document: changeMapDocument, ...changeMap } = await derivedChangeMapState(projectRoot, id, slug, slice.design, verification) ?? {};
  const totals = await loadInitiativeRunTotals(projectRoot, initiative);
  const runTotals = totals === null ? null : totals.slices[slug] ?? { slice: totals.initiative, waves: [], designRuns: [], withDescendants: totals.initiative };
  return {
    id,
    initiativeTitle: initiative.roadmapItem?.title ?? initiative.record.slices[derived?.root]?.title ?? id,
    slug,
    slice,
    children: derived?.children[slug] ?? [],
    effectiveDependencies: derived?.effectiveDependencies[slug] ?? null,
    dependents: Object.entries(initiative.record.slices).filter(([, other]) => other.dependencies.includes(slug)).map(([other]) => other),
    complete: derived?.complete[slug] ?? false,
    active: initiative.active.filter((entry) => entry.slice === slug),
    designReview: initiative.designReview[slug] ?? null,
    coveringClaim: coveringClaim(initiative.record.slices, slug),
    artifacts: initiative.slices[slug],
    verification,
    code: await verifiedCode(projectRoot, id, slug).catch(() => null),
    changeMap: Object.keys(changeMap).length ? changeMap : null,
    designView: await loadDesignView(projectRoot, id, slug, { changeMap: changeMapDocument ?? null, units: await readPublishedUnits(projectRoot, ...intelligenceDirectories ? [intelligenceDirectories] : []).catch(() => null) }).catch(() => null),
    titles: Object.fromEntries(Object.entries(initiative.record.slices).map(([key, value]) => [key, value.title])),
    views: await loadSliceViews(projectRoot, initiative, slug).catch(() => ({ own: [], slices: [], without: [] })),
    runTotals
  };
}
function presenceText(where, branch, host, suffix) {
  return `in progress${branch ? ` in ${branch}` : ""}${where ?? (host ? ` on ${host}` : "")}${suffix}`;
}
async function slicePresence(projectRoot, id, slug, { reachable = async () => null, shipped = null } = {}) {
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
async function initiativeReferences(projectRoot, config) {
  const references = /* @__PURE__ */ new Map();
  const decisions = /* @__PURE__ */ new Map();
  const roadmap = await loadRoadmapView(projectRoot).catch(() => null);
  for (const id of await initiativeFolders(projectRoot)) {
    const { resolved, loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    const slices = loaded.record?.slices ?? {};
    const initiativeTitle = roadmap?.items.find((item) => item.id === id)?.title ?? slices[loaded.analysis?.root]?.title ?? id;
    const leaves = new Set(loaded.analysis?.leaves ?? []);
    for (const [slug, slice] of Object.entries(slices)) {
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
        if (!decisions.get(target).some((use) => use.initiative === id)) decisions.get(target).push({ initiative: id, title: initiativeTitle });
      }
    }
  }
  return { references, decisions };
}
function decisionRequirements(source, file, directory) {
  const section = /^## Requirements\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(source ?? "")?.[1] ?? "";
  const byFile = /* @__PURE__ */ new Map();
  for (const match of section.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g)) {
    const [target] = relativeLinkTargets(`[x](${match[1]})`, file);
    if (!target || !directory || !target.startsWith(`${directory}/`)) continue;
    if (!byFile.has(target)) byFile.set(target, []);
    const anchor = match[1].split("#")[1];
    if (anchor && !byFile.get(target).includes(anchor)) byFile.get(target).push(anchor);
  }
  return [...byFile].map(([path2, anchors]) => ({ path: path2, anchors }));
}
function loadLibrary(projectRoot, kind) {
  return remember(projectRoot, `library:${kind}:${projectRoot}`, () => computeLibrary(projectRoot, kind));
}
async function computeLibrary(projectRoot, kind) {
  const config = await readWorkflowConfig(projectRoot);
  const directory = kind === "requirements" ? config.paths.requirements : config.paths.adrs;
  const scoped = await scopedArtifacts(projectRoot, kind === "requirements" ? "requirements" : "adrs", (name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md");
  if (scoped) return scopedLibrary(projectRoot, kind, directory, config, scoped);
  if (!directory) return { kind, directory: null, entries: [] };
  const files = [];
  await walk(projectRoot, directory, 4, (name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md", files, LIBRARY_LIMIT);
  const { references, decisions } = await initiativeReferences(projectRoot, config);
  const recorded = await recordedStatuses(projectRoot, directory);
  const scopes = await storeScopes(projectRoot, directory);
  const markOf = await loadFormatMarks(projectRoot);
  const entries = [];
  for (const file of files) {
    const source = await readText(projectRoot, file);
    const fields = headerFields(source ?? "");
    const relative = file.slice(directory.length + 1);
    const entry = {
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
  if (kind === "decisions") {
    for (const entry of entries) entry.supersededBy = entries.filter((other) => other.supersedes.includes(entry.path)).map((other) => other.path);
  }
  return { kind, directory, entries };
}
async function storeScopes(projectRoot, directory) {
  const stored = await listStoreArtifacts(projectRoot, directory).catch(() => null);
  if (!stored) return null;
  const byPath = /* @__PURE__ */ new Map();
  for (const entry of stored) if (!byPath.has(entry.path)) byPath.set(entry.path, entry.scope);
  return byPath;
}
async function scopedLibrary(projectRoot, kind, directory, config, { entries: listed, own }) {
  const { references, decisions } = await initiativeReferences(projectRoot, config);
  const requirements = kind === "decisions" ? (await scopedArtifacts(projectRoot, "requirements", (name) => name.endsWith(".md")))?.entries ?? [] : [];
  const markOf = await loadFormatMarks(projectRoot);
  const takes = (entry) => entry.path !== null && refAt(listed, own, entry.path) === entry.ref;
  const entries = [];
  for (const item of listed) {
    const source = await readText(projectRoot, item.ref);
    const fields = headerFields(source ?? "");
    const entry = {
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
async function recordedStatuses(projectRoot, directory) {
  if (!await inArtifactStore(projectRoot, `${directory}/x.md`).catch(() => false)) return null;
  const statuses = await storeArtifactStatuses(projectRoot, directory).catch(() => null);
  if (statuses === null) return null;
  const byPath = /* @__PURE__ */ new Map();
  for (const entry of statuses) if (!byPath.has(entry.path)) byPath.set(entry.path, entry.status);
  return byPath;
}
async function loadGlossary(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const glossaryPath = config.paths.glossary;
  const scoped = await scopedArtifacts(projectRoot, "glossary", () => true);
  if (scoped) {
    const glossaries = [];
    const markOf = await loadFormatMarks(projectRoot);
    for (const item of scoped.entries) {
      const content2 = await readText(projectRoot, item.ref);
      if (content2 !== null) glossaries.push({ ref: item.ref, scope: item.label, terms: glossaryEntries(content2).map(({ term, text }) => ({ term, text: text.replace(/\s+/g, " ").trim() })), format: item.path ? markOf(item.path, item.label) : null });
    }
    const mine = glossaryPath ? await readText(projectRoot, glossaryPath) : null;
    return { path: glossaryPath, exists: glossaries.length > 0, content: mine, glossaries };
  }
  const content = glossaryPath ? await readText(projectRoot, glossaryPath) : null;
  const format = content === null || !glossaryPath ? null : (await loadFormatMarks(projectRoot))(glossaryPath, (await storeScopes(projectRoot, path.posix.dirname(glossaryPath)))?.get(glossaryPath) ?? null);
  return { path: glossaryPath, exists: content !== null, content, format };
}
async function isFile(root, relative) {
  try {
    if (await inArtifactStore(root, relative)) return await readArtifactText(root, relative) !== null;
    return (await stat((await resolveRecordFile(root, relative)).target)).isFile();
  } catch {
    return false;
  }
}
async function initiativeSnapshot(projectRoot, config, id, roadmapItem) {
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
    sliceTitle: (slug) => slug && Object.hasOwn(slices, slug) ? slices[slug].title : slug ?? null
  };
}
function newestFirst(left, right) {
  const time = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return time(right) - time(left) || 0;
}
function gateOrder(left, right) {
  return newestFirst(left.askedAt, right.askedAt);
}
async function loadAttention(projectRoot) {
  const [attention, formats, runs, permissions] = await Promise.all([remember(projectRoot, `attention:${projectRoot}`, () => computeAttention(projectRoot)), loadFormats(projectRoot), runItems(projectRoot), launchPermissions(projectRoot)]);
  const items = formats.filter((entry) => entry.count > 0).map((entry) => ({ type: "format-findings", artifactType: entry.type, label: entry.label, count: entry.count, earlier: entry.earlier, artifacts: entry.artifacts }));
  const questions = runs.needsYou.filter((item) => item.type === "migration-question").length;
  const [launched, answered] = await Promise.all([withLaunchQuestions(projectRoot, attention.needsYou).then((listed) => withAskers(projectRoot, listed)), withAskers(projectRoot, attention.answered)]);
  return { ...attention, needsYou: [...runs.needsYou, ...launched, ...items], answered, watch: [...attention.watch, ...runs.watch], formats, permissions, gateCount: attention.gateCount + questions + permissions.length };
}
async function withLaunchQuestions(projectRoot, needsYou) {
  if (!needsYou.some((item) => item.type === "gate" && item.kind === "assistance")) return needsYou;
  const { launches } = await listLaunches({ projectRoot }).catch(() => ({ launches: [] }));
  const asked = /* @__PURE__ */ new Map();
  for (const launch of launches) {
    if (typeof launch.questionGate !== "string") continue;
    const label = hostDefinition(launch.host)?.label ?? launch.hostLabel ?? launch.host;
    asked.set(`${launch.initiative}/${launch.questionGate}`, { id: launch.id, host: { id: launch.host, label }, launchedAt: launch.launchedAt, endedAt: launch.endedAt, state: launch.state });
  }
  if (!asked.size) return needsYou;
  return needsYou.map((item) => {
    const launch = item.type === "gate" && item.kind === "assistance" ? asked.get(`${item.initiative?.id}/${item.id}`) : void 0;
    return launch ? { ...item, launch } : item;
  });
}
async function withAskers(projectRoot, items) {
  if (!items.some((item) => item?.type === "gate")) return items;
  const { readGateAsker } = await import("../workflow/gate-askers.mjs");
  const { askerReach, askerState, readAskerSessions } = await import("../session/asker-sessions.mjs");
  const { readGateWakes } = await import("../session/cloud-wakes.mjs");
  const kept = await readAskerSessions().catch(() => ({}));
  const wakes = await readGateWakes().catch(() => ({}));
  return Promise.all(items.map(async (item) => {
    if (item?.type !== "gate") return item;
    const key = item.kind === "approval" ? { gate: item.id } : typeof item.initiative?.id === "string" ? { initiative: item.initiative.id, gate: item.id } : null;
    if (!key) return item;
    const target = key.initiative === void 0 ? `approval:${key.gate}` : `gate:${key.initiative}/${key.gate}`;
    const read = await readGateAsker(projectRoot, key);
    const own = Object.hasOwn(kept, target) ? kept[target] : null;
    const thisMachine = read.known && own !== null;
    const { state, reason } = await askerState(read, thisMachine ? own : null).catch(() => ({ state: "unknown", reason: "Prism cannot tell whether this session is open." }));
    const asker = { known: read.known, harness: read.harness, machine: read.machine, checkout: read.checkout, cloud: read.cloud, launched: read.launched, thisMachine, state, reason, reach: askerReach(state, read), wake: Object.hasOwn(wakes, target) ? wakes[target] : null };
    return { ...item, asker };
  }));
}
async function runItems(projectRoot) {
  const runs = await allRuns(projectRoot).catch(() => []);
  const needsYou = [];
  const watch = [];
  for (const run of [...runs].reverse()) {
    const base = { run: run.id, artifactType: run.set.type, label: FORMAT_LABELS[run.set.type] ?? run.set.type, scope: run.set.scope ?? null, files: run.set.artifacts.length };
    if (run.status === "asking") {
      const points = (run.question?.points ?? []).filter((point) => isRecord(point));
      const byFile = /* @__PURE__ */ new Map();
      for (const point of points) {
        const key = JSON.stringify([point.artifact?.path, point.artifact?.scope?.label ?? null]);
        const entry = byFile.get(key) ?? { path: point.artifact?.path ?? null, scope: point.artifact?.scope ?? null, points: 0, kinds: [] };
        entry.points += 1;
        if (!entry.kinds.includes(point.kind)) entry.kinds.push(point.kind);
        byFile.set(key, entry);
      }
      needsYou.push({ type: "migration-question", ...base, points: points.length, asking: [...byFile.values()], askedAt: run.question?.askedAt ?? null });
    } else if (run.status === "failed" && !followedRun(runs, run)) {
      needsYou.push({ type: "migration-failed", ...base, reason: run.failure?.reason ?? null, at: run.failure?.at ?? run.endedAt ?? null, artifacts: run.set.artifacts.map(({ path: file, scope }) => ({ path: file, scope: scope ?? null })) });
    } else if (run.status === "waiting-for-host") {
      watch.push({ type: "migration-waiting", ...base, reason: typeof run.reason === "string" ? run.reason : null, at: run.startedAt ?? null });
    }
  }
  return { needsYou, watch };
}
const FORMAT_LABELS = Object.freeze({ requirements: "Requirements", adr: "Decisions", glossary: "Glossary", feature: "Feature files" });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const RUN_ATTENTION_PAGES = Object.freeze({ asking: "questions", failed: "failed", "waiting-for-host": "problems" });
const migrationRunTitle = (record) => `Format migration \xB7 ${FORMAT_LABELS[record.set.type] ?? record.set.type}`;
async function migrationRunContext(projectRoot, ref, id) {
  const record = await readRun(projectRoot, id).catch(() => null);
  const page = record ? RUN_ATTENTION_PAGES[record.status] : null;
  const trail = [placeCrumb("attention", "attention"), ...page ? [{ ref: `attention:${page}`, label: PLACE_PAGE_LABELS.attention[page] }] : [], { ref, label: record ? migrationRunTitle(record) : "Format migration" }];
  return { trail, scope: { kind: "global" }, place: "attention" };
}
function runPoint(point, { number, answers, conflicts, sourceEntries, contentEntries, sourceLines }) {
  const { id, kind, settled, asked, ...detail } = point;
  const recommendation = asked?.recommendation ?? null;
  const extra = {};
  if (kind === "leftover") extra.sourceLine = sourceLines?.get(id) ?? null;
  if (kind === "entry") {
    extra.sourceText = sourceEntries.find((entry) => entry.id === point.entry)?.text ?? null;
    extra.targetText = contentEntries.find((entry) => entry.id === point.entry)?.text ?? null;
  }
  if (kind === "conflict") {
    const conflict = conflicts.find((entry) => entry.entry === point.entry);
    extra.sourceText = conflict?.source ?? null;
    extra.targetText = conflict?.target ?? null;
  }
  return {
    id,
    kind,
    ...detail,
    ...extra,
    number: number ?? null,
    settled: settled ? { reason: settled.reason } : null,
    asked: asked ? { recommendation, recommended: recommendedChoice(kind, recommendation) } : null,
    answer: answers?.[id] ?? null
  };
}
async function loadMigrationRunView(projectRoot, id) {
  const record = await readRun(projectRoot, id);
  if (!record) throw Object.assign(new Error("The format migration run no longer exists in this project."), { code: "ENOENT" });
  const shown = await shownRun(projectRoot, record);
  const answers = record.answers ?? null;
  const asked = record.migrations.flatMap((migration) => (migration.points ?? []).filter((point) => point.asked));
  const numbers = new Map(asked.map((point, index) => [point.id, index + 1]));
  const migrations = record.migrations.map((migration) => {
    const sourceEntries = typeof migration.sourceText === "string" ? entriesFor(migration.type, migration.sourceText) : [];
    const contentEntries = typeof migration.content === "string" ? entriesFor(migration.type, migration.content) : [];
    const map = statementMap(migration, { answers: answers ?? {} });
    const sourceLines = /* @__PURE__ */ new Map();
    for (const statement of map?.statements ?? []) if (statement.landed?.kind === "leftover" && statement.landed.point && !sourceLines.has(statement.landed.point)) sourceLines.set(statement.landed.point, statement.line);
    return {
      id: migration.id,
      type: migration.type,
      source: migration.source,
      target: migration.target,
      separateSource: migration.separateSource,
      summary: migration.summary,
      status: headerStatus(migration.content),
      proposedAt: migration.proposedAt ?? null,
      map,
      points: (migration.points ?? []).map((point) => runPoint(point, { number: numbers.get(point.id), answers, conflicts: migration.conflicts ?? [], sourceEntries, contentEntries, sourceLines }))
    };
  });
  const runs = record.status === "failed" ? await allRuns(projectRoot).catch(() => []) : [];
  const answered = answers ? Object.values(answers).find((answer) => answer?.by) ?? null : null;
  return {
    id: record.id,
    title: migrationRunTitle(record),
    type: record.set.type,
    typeLabel: FORMAT_LABELS[record.set.type] ?? record.set.type,
    scope: record.set.scope ?? null,
    formatVersion: record.set.formatVersion ?? null,
    cause: record.cause,
    status: record.status,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    reason: typeof record.reason === "string" ? record.reason : null,
    failure: record.failure ?? null,
    launch: record.launch ?? null,
    rerunOf: record.rerunOf ?? null,
    by: record.by ?? null,
    followedBy: record.status === "failed" ? followingRun(runs, record)?.id ?? null : null,
    artifacts: shown.set.artifacts.map(({ path: file, scope, version, findings }) => ({ path: file, scope: scope ?? null, version, findings })),
    askedAt: record.question?.askedAt ?? null,
    points: asked.length,
    answeredBy: answered ? { ...answered.by, at: answered.at ?? null } : null,
    migrations
  };
}
const headerStatus = (text) => typeof text === "string" ? /^Status:\s*(\S.*?)\s*$/m.exec(text.split(/\n## /)[0] ?? "")?.[1] ?? null : null;
async function loadFormats(projectRoot) {
  let artifacts = [];
  try {
    artifacts = await remember(projectRoot, `format-check:${projectRoot}`, async () => (await checkArtifacts({ projectRoot })).artifacts);
    await prime(projectRoot, marksKey(projectRoot), markLookup(artifacts));
  } catch {
    artifacts = [];
  }
  return ARTIFACT_FORMATS.map((format) => {
    const broken = artifacts.filter((artifact) => artifact.type === format.type && !artifact.conforms);
    return {
      type: format.type,
      label: FORMAT_LABELS[format.type],
      version: format.version,
      reference: format.reference,
      count: broken.length,
      earlier: broken.filter((artifact) => artifact.earlierFormat !== null).length,
      artifacts: broken.map((artifact) => ({ path: artifact.path, scope: artifact.scope, findings: artifact.findings, earlierFormat: artifact.earlierFormat, migration: artifact.migration ?? null }))
    };
  });
}
async function launchPermissions(projectRoot) {
  const store = await storeLocation(await realpath(projectRoot)).catch(() => null);
  if (store === null) return [];
  const requests = await pendingRequests({ store }).catch(() => []);
  if (!requests.length) return [];
  const roadmap = await loadRoadmapView(projectRoot).catch(() => ({ items: [] }));
  const titles = new Map(roadmap.items.map((item) => [item.id, item.title]));
  return requests.map((request) => ({ ...request, initiative: { id: request.initiative, title: titles.get(request.initiative) ?? request.initiative } }));
}
async function loadAttentionView(projectRoot) {
  const { changes, ...attention } = await loadAttention(projectRoot);
  const recentChanges = [...changes, ...await remember(projectRoot, `artifact-changes:${projectRoot}`, () => artifactChanges(projectRoot))].sort((left, right) => historyOrder(right, left)).slice(0, RECENT_CHANGES_LIMIT);
  return { ...attention, recentChanges };
}
async function computeAttention(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const items = new Map(roadmap.items.map((item) => [item.id, item]));
  const ids = [.../* @__PURE__ */ new Set([...roadmap.items.map((item) => item.id), ...await storedInitiatives(projectRoot)])];
  const needsYou = [];
  const shippedGates = [];
  const answered = [];
  const earlier = [];
  const watch = [];
  const claims = [];
  const changes = (await readIndexHistory(projectRoot).catch(() => ({ history: [] }))).history.map((entry) => ({ ...entry, initiative: null }));
  const titles = /* @__PURE__ */ new Map();
  for (const id of ids) {
    const snapshot = await initiativeSnapshot(projectRoot, config, id, items.get(id));
    const initiative = { id, title: snapshot.title };
    titles.set(id, snapshot.title);
    const state = snapshot.state;
    const shipped = await shippedDecision(projectRoot, id).catch(() => null);
    const claimed = await claimedSlices(projectRoot, id);
    for (const claim of sliceClaims(claimed)) claims.push({ ...claim, initiative });
    if (state?.valid) {
      const questions = new Map([...state.state?.pending ?? [], ...state.state?.closed ?? []].filter((gate) => gate && typeof gate === "object" && typeof gate.question === "string").map((gate) => [`gate:${id}/${gate.id}`, gate.question]));
      for (const entry of state.state?.history ?? []) changes.push({ ...entry, initiative: id, ...entry.action === "gate.answer" && questions.has(entry.target) ? { question: questions.get(entry.target) } : {} });
    }
    if (state?.exists && !state.valid) {
      watch.push({ type: "record-problem", initiative, path: await recordFile(projectRoot, { kind: "state", initiative: id }), message: state.errors.join(" ") });
    }
    for (const entry of state?.state?.pending ?? []) {
      if (entry && typeof entry === "object") {
        const artifacts = [];
        for (const artifact of entry.artifacts ?? []) {
          const key = await keyOfPath(projectRoot, artifact).catch(() => null);
          const current = key ? await recordFile(projectRoot, key).catch(() => artifact) : artifact;
          const available = await isFile(projectRoot, current);
          artifacts.push({ path: current, available, ...available ? { record: await describeRecord(projectRoot, config, current, key, snapshot) } : {} });
        }
        const gate = { type: "gate", id: entry.id, kind: entry.kind, question: entry.question, context: entry.context ?? null, options: entry.options ?? null, recommended: entry.recommended ?? null, askedAt: entry.askedAt, answer: entry.answer ?? null, initiative, slice: entry.slice ? { slug: entry.slice, title: snapshot.sliceTitle(entry.slice) } : null, phase: entry.slice && claimed && Object.hasOwn(claimed, entry.slice) ? slicePhase(claimed[entry.slice]) : null, claim: entry.slice ? holdingClaim(claimed, entry.slice) : null, artifacts, unavailable: shipped ? shippedActionReason(shipped) : null };
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
    for (const [slug, slice] of Object.entries(slices)) {
      if (slice.status === "blocked") watch.push({ type: "blocked", initiative, slice: { slug, title: slice.title } });
    }
    for (const [slug, slice] of Object.entries(slices)) {
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
    const item = items.get(id);
    if (item?.readyToShip && item.state !== "shipped") watch.push({ type: "ready-to-ship", initiative });
  }
  needsYou.push(...await approvalGates(projectRoot));
  answered.push(...await answeredApprovals(projectRoot));
  needsYou.sort((left, right) => left.type === "gate" === (right.type === "gate") ? gateOrder(left, right) : left.type === "gate" ? -1 : 1);
  if (roadmap.error) needsYou.push({ type: "roadmap-problem", path: config.paths.roadmap, message: roadmap.error });
  else if (!roadmap.exists && config.paths.roadmap) needsYou.push({ type: "roadmap-missing", path: roadmap.recordPath });
  else if (roadmap.exists && !roadmap.valid) needsYou.push({ type: "roadmap-problem", path: roadmap.recordPath, message: roadmap.errors.join(" ") });
  for (const id of roadmap.unlisted) needsYou.push({ type: "unlisted", initiative: { id, title: titles.get(id) ?? id } });
  for (const question of roadmap.openQuestions ?? []) needsYou.push({ type: "open-question", text: question });
  for (const diagnostic of config.diagnostics) needsYou.push({ type: "config", code: diagnostic.code, message: diagnostic.message });
  const blockingOrder = (entry) => ({ "record-problem": 0, blocked: 1, "failed-verification": 2, findings: entry.blocking ? 3 : 4, "ready-to-ship": 5, active: 6 })[entry.type] ?? 7;
  watch.sort((left, right) => blockingOrder(left) - blockingOrder(right));
  answered.sort((left, right) => newestFirst(left.answer.answeredAt, right.answer.answeredAt));
  earlier.sort((left, right) => newestFirst(left.closedAt, right.closedAt));
  const answeredThisWeek = recentlyAnswered(answered, earlier);
  const recent = changes.sort((left, right) => historyOrder(right, left)).slice(0, RECENT_CHANGES_LIMIT);
  const ends = (claim) => Date.parse(claim.expiresAt ?? "") || 0;
  claims.sort((left, right) => Number(left.expired) - Number(right.expired) || (left.expired ? ends(right) - ends(left) : ends(left) - ends(right)));
  shippedGates.sort(gateOrder);
  return { needsYou, shippedGates, answered, earlier: earlier.slice(0, 20), watch, claims, changes: recent, gateCount: needsYou.filter((item) => item.type === "gate").length, answeredThisWeek };
}
async function approvalGates(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await pendingApprovalGates(projectRoot).catch(() => []);
  const holders = /* @__PURE__ */ new Map();
  for (const gate of gates) holders.set(gate.id, (holders.get(gate.id) ?? 0) + 1);
  const workItem = servedWorkItems(projectRoot);
  return Promise.all(gates.map(async (gate) => ({
    type: "gate",
    id: gate.id,
    kind: "approval",
    status: gate.status,
    recorded: gate.recorded,
    question: gate.question,
    context: gate.context ?? null,
    options: null,
    recommended: null,
    askedAt: gate.askedAt,
    answer: null,
    initiative: null,
    slice: null,
    artifacts: [],
    artifact: { path: gate.artifact.path, scope: gate.artifact.scope, kind: gate.artifact.kind ?? null, title: gate.artifact.title ?? null },
    changed: gate.changed,
    workItem: await workItem(servedWorkItem(gate)),
    ...holders.get(gate.id) > 1 ? { ambiguous: true } : {}
  })));
}
async function answeredApprovals(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await answeredApprovalGates(projectRoot).catch(() => []);
  if (!gates.length) return [];
  const { readGateAsker } = await import("../workflow/gate-askers.mjs");
  const workItem = servedWorkItems(projectRoot);
  const items = await Promise.all(gates.map(async (gate) => {
    if (!(await readGateAsker(projectRoot, { gate: gate.id })).known) return null;
    return {
      type: "gate",
      id: gate.id,
      kind: "approval",
      status: gate.status,
      recorded: gate.recorded,
      question: gate.question,
      context: gate.context ?? null,
      options: null,
      recommended: null,
      askedAt: gate.askedAt,
      answer: { choice: gate.answer.choice, note: gate.answer.note ?? null, answeredAt: gate.answer.answeredAt },
      initiative: null,
      slice: null,
      artifacts: [],
      artifact: { path: gate.artifact.path, scope: gate.artifact.scope, kind: gate.artifact.kind ?? null, title: gate.artifact.title ?? null },
      workItem: await workItem(servedWorkItem(gate))
    };
  }));
  return items.filter(Boolean);
}
function servedWorkItems(projectRoot) {
  let roadmap = null;
  const records = /* @__PURE__ */ new Map();
  return async (served) => {
    if (!served) return null;
    roadmap ??= loadRoadmapView(projectRoot).catch(() => ({ items: [] }));
    if (!records.has(served.initiative)) records.set(served.initiative, readInitiative(projectRoot, served.initiative).then(({ loaded: loaded2 }) => loaded2, () => ({ exists: false })));
    const [view, loaded] = await Promise.all([roadmap, records.get(served.initiative)]);
    const item = (view.items ?? []).find((entry) => entry.id === served.initiative);
    const slices = loaded.record?.slices ?? {};
    const initiative = { id: served.initiative, title: item?.title ?? slices[loaded.analysis?.root]?.title ?? served.initiative, known: Boolean(item) || Boolean(loaded.exists) };
    if (served.slice === null) return { initiative, slice: null };
    const known = Object.hasOwn(slices, served.slice);
    return { initiative, slice: { slug: served.slice, title: known ? slices[served.slice].title ?? served.slice : served.slice, known } };
  };
}
async function artifactChanges(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  return appliedArtifactActions(projectRoot, { latest: RECENT_CHANGES_LIMIT }).catch(() => []);
}
async function failedVerification(projectRoot, id, slug) {
  const run = await latestVerification(projectRoot, id, slug).catch(() => null);
  if (!run || run.passed !== false) return null;
  return { reason: run.reason ?? null, failingCount: Number.isInteger(run.failingCount) ? run.failingCount : null, finishedAt: run.finishedAt ?? null };
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
function recentlyAnswered(answered, closed) {
  const since = Date.now() - WEEK_MS;
  const entries = [
    ...answered.map((gate) => ({ gate, at: gate.answer?.answeredAt ?? null })),
    ...closed.map((gate) => ({ gate, at: gate.closedAt ?? gate.answer?.answeredAt ?? null }))
  ].filter(({ at }) => Date.parse(at ?? "") >= since);
  for (const { at } of entries) validUntil(Date.parse(at) + WEEK_MS);
  entries.sort((left, right) => newestFirst(left.at, right.at));
  return entries.map(({ gate, at }) => ({ id: gate.id ?? null, kind: gate.kind ?? null, question: gate.question, initiative: gate.initiative, slice: gate.slice ?? null, answer: gate.answer ?? null, reason: gate.reason ?? null, at }));
}
const ATTENTION_KINDS = Object.freeze(["questions", "findings", "failed", "blocked", "ready", "problems", "formats"]);
const ATTENTION_KIND_OF = Object.freeze({
  gate: "questions",
  "pending-note": "questions",
  findings: "findings",
  "failed-verification": "failed",
  blocked: "blocked",
  "ready-to-ship": "ready",
  "record-problem": "problems",
  "roadmap-problem": "problems",
  "roadmap-missing": "problems",
  unlisted: "problems",
  "open-question": "problems",
  config: "problems",
  "format-findings": "formats",
  "migration-question": "questions",
  "migration-failed": "failed",
  "migration-waiting": "problems"
});
const ATTENTION_WORK_SHOWN = 3;
function attentionItems(attention) {
  return [...attention.needsYou, ...attention.watch].flatMap((item) => ATTENTION_KIND_OF[item.type] ? [{ kind: ATTENTION_KIND_OF[item.type], item }] : []);
}
function attentionPlace(attention) {
  const items = attentionItems(attention);
  const kinds = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, items.filter((entry) => entry.kind === kind).length]));
  const work = /* @__PURE__ */ new Map();
  for (const { item } of items) {
    if (!item.initiative?.id) continue;
    const entry = work.get(item.initiative.id) ?? { id: item.initiative.id, title: item.initiative.title ?? item.initiative.id, count: 0 };
    entry.count += 1;
    work.set(entry.id, entry);
  }
  const ordered = [...work.values()].sort((left, right) => right.count - left.count || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { everything: items.length, questions: attention.gateCount, kinds, work: ordered, shown: ATTENTION_WORK_SHOWN, answered: attention.answeredThisWeek.length };
}
async function attentionPage(projectRoot, page) {
  const attention = await loadAttention(projectRoot);
  if (page === "answered") return { answered: attention.answeredThisWeek };
  const items = attentionItems(attention);
  const work = /^work\/(.+)$/.exec(page);
  const shown = work ? items.filter(({ item }) => item.initiative?.id === work[1]) : page === "roadmap-questions" ? items.filter(({ item }) => item.type === "open-question") : items.filter((entry) => entry.kind === page);
  let label = PLACE_PAGE_LABELS.attention[page];
  if (work) label = shown[0]?.item.initiative.title ?? (await loadRoadmapView(projectRoot).catch(() => ({ items: [] }))).items.find((item) => item.id === work[1])?.title ?? work[1];
  return { filter: { key: page, label, total: items.length, items: shown }, ...page === "formats" ? { formats: attention.formats } : {} };
}
async function describeRecord(projectRoot, config, artifactPath, key, snapshot) {
  const json = async () => {
    try {
      return parseStoreJson(await readText(projectRoot, artifactPath) ?? "null");
    } catch {
      return null;
    }
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
      const view = await loadDesignView(projectRoot, snapshot.id, slug).catch(() => null);
      const clauses = view ? view.clauses.length : contractClauses(await readText(projectRoot, artifactPath) ?? "").length;
      return { kind: "design", title: slices[slug].title, clauses, frozenTests: slices[slug].design?.frozenTests?.length ?? 0 };
    }
  }
  for (const [kind, directory] of [["decision", config.paths.adrs], ["requirements", config.paths.requirements]]) {
    if (!directory || !artifactPath.startsWith(`${directory}/`)) continue;
    const stored = await storeArtifactLocation(projectRoot, artifactPath).catch(() => null);
    const ref = stored ? `store:${stored.location}` : null;
    const entry = (await loadLibrary(projectRoot, kind === "decision" ? "decisions" : "requirements")).entries.find((item) => item.path === artifactPath || ref !== null && item.path === ref);
    if (entry) return { kind, title: entry.title, status: entry.status ?? null };
  }
  return null;
}
function glossaryEntries(content) {
  const entries = /* @__PURE__ */ new Map();
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
    } else if (open && !/^(Source|Aliases|Not to be confused with):/.test(line) && !/^\s*<a id="[^"]*"><\/a>\s*$/.test(line)) open.text += ` ${line}`;
  }
  return [...entries.values()].slice(0, LIBRARY_LIMIT);
}
function glossaryTerms(content) {
  return glossaryEntries(content).map((entry) => entry.term);
}
const DIAGRAM_DEPTH = 6;
const DIAGRAM_OPENINGS = Object.freeze({ mindmap: "Mind map", wbs: "Work breakdown", gantt: "Gantt chart", salt: "Wireframe", json: "Data", yaml: "Data" });
const DIAGRAM_STATEMENTS = Object.freeze([
  ["C4", /^\s*(?:!include\S*\s+<?C4|(?:Person|System|Container|Component)(?:_Ext)?\s*\()/m],
  ["Class", /^\s*(?:abstract\s+)?(?:class|interface|enum)\s/m],
  ["State", /^\s*(?:\[\*\]|state\s)/m],
  ["Activity", /^\s*(?:start|stop|:[^\n]*;|if\s*\(|fork\b|repeat\b)/m],
  ["Component", /^\s*(?:component|node|package)\b|^\s*\[[^\]\n]+\]/m],
  // A diagram of named participants and arrows between them, with no statement of another kind, is a sequence, as PlantUML reads it.
  ["Sequence", /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\b|^\s*[\w"]+\s*<?-+>>?\s*[\w"]+/m]
]);
function diagramKind(file, source) {
  if (path.posix.basename(file) === "code.puml") return "Code view";
  const opening = /^\s*@start(\w+)/m.exec(source ?? "")?.[1]?.toLowerCase();
  if (opening && DIAGRAM_OPENINGS[opening]) return DIAGRAM_OPENINGS[opening];
  return DIAGRAM_STATEMENTS.find(([, pattern]) => pattern.test(source ?? ""))?.[0] ?? "Diagram";
}
function diagramName(file, source) {
  const named = /^\s*@startuml[ \t]+([^\r\n]+?)\s*$/m.exec(source ?? "")?.[1]?.replace(/^"(.*)"$/, "$1").trim();
  return named && !named.startsWith("(") ? named : path.posix.basename(file, ".puml");
}
function loadDiagrams(projectRoot) {
  return remember(projectRoot, `diagrams:${projectRoot}`, () => computeDiagrams(projectRoot));
}
async function computeDiagrams(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const isDiagram = (name) => name.toLowerCase().endsWith(".puml");
  if (await workspaceListing(projectRoot)) return scopedDiagrams(projectRoot, config, isDiagram);
  const diagrams = [];
  const plans = config.paths.plans;
  if (plans) {
    const files = [];
    await walk(projectRoot, plans, DIAGRAM_DEPTH, isDiagram, files, LIBRARY_LIMIT);
    const owners = /* @__PURE__ */ new Map();
    for (const file of files) {
      const [id, segment] = file.slice(plans.length + 1).split("/");
      const folder = path.posix.dirname(file);
      if (folder === plans) {
        diagrams.push({ file, owner: { kind: "initiative", title: plans }, ownerRef: null });
        continue;
      }
      if (!owners.has(id)) {
        const known2 = SLUG_PATTERN.test(id) && await knownInitiative(projectRoot, id).catch(() => false);
        owners.set(id, known2 ? await initiativeTree(projectRoot, id).then(({ scope, view }) => ({ title: scope.title, slices: view.record?.slices ?? {}, known: true })).catch(() => ({ title: id, slices: {} })) : { title: id, slices: {} });
      }
      const owner = owners.get(id);
      const slice = file.split("/").length > plans.split("/").length + 2 && owner.slices[segment] && owner.slices[segment].parent !== null ? owner.slices[segment] : null;
      const known = owner.known === true;
      diagrams.push({ file, owner: slice ? { kind: "slice", title: `${owner.title} \xB7 ${slice.title}` } : { kind: "initiative", title: owner.title }, ownerRef: known ? slice ? `slice:${id}/${segment}` : `initiative:${id}` : null });
    }
  }
  const adrs = config.paths.adrs;
  if (adrs) {
    const files = [];
    await walk(projectRoot, adrs, 4, isDiagram, files, LIBRARY_LIMIT);
    const decisions = new Map((await loadLibrary(projectRoot, "decisions")).entries.map((entry) => [entry.path, entry.title]));
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
async function scopedDiagrams(projectRoot, config, isDiagram) {
  const plans = (await scopedArtifacts(projectRoot, "plans", isDiagram))?.entries ?? [];
  const adrs = (await scopedArtifacts(projectRoot, "adrs", isDiagram))?.entries ?? [];
  const decisions = new Map((await loadLibrary(projectRoot, "decisions")).entries.map((entry) => [entry.path, entry.title]));
  const owners = /* @__PURE__ */ new Map();
  const diagrams = [];
  for (const item of plans) {
    const [id, segment] = item.rest.split("/");
    if (!item.rest.includes("/")) {
      diagrams.push({ item, owner: { kind: "initiative", title: config.paths.plans ?? "plans" }, ownerRef: null });
      continue;
    }
    if (!owners.has(id)) {
      const known2 = SLUG_PATTERN.test(id) && await knownInitiative(projectRoot, id).catch(() => false);
      owners.set(id, known2 ? await initiativeTree(projectRoot, id).then(({ scope, view }) => ({ title: scope.title, slices: view.record?.slices ?? {}, known: true })).catch(() => ({ title: id, slices: {} })) : { title: id, slices: {} });
    }
    const owner = owners.get(id);
    const slice = item.rest.split("/").length > 2 && owner.slices[segment] && owner.slices[segment].parent !== null ? owner.slices[segment] : null;
    const known = owner.known === true;
    diagrams.push({ item, owner: slice ? { kind: "slice", title: `${owner.title} \xB7 ${slice.title}` } : { kind: "initiative", title: owner.title }, ownerRef: known ? slice ? `slice:${id}/${segment}` : `initiative:${id}` : null });
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
async function searchableRecords(projectRoot) {
  const records = Object.fromEntries(SEARCH_KINDS.map((kind) => [kind, []]));
  for (const [kind, library] of [["requirement", "requirements"], ["decision", "decisions"]]) {
    for (const entry of (await loadLibrary(projectRoot, library)).entries) records[kind].push({ title: entry.title, ref: entry.path, text: await readText(projectRoot, entry.path) ?? "" });
  }
  const glossary = await loadGlossary(projectRoot);
  const terms = glossary.glossaries ? glossary.glossaries.flatMap((one) => one.terms) : glossaryEntries(glossary.content);
  for (const entry of terms) records["glossary-term"].push({ title: entry.term, ref: "glossary", text: entry.text });
  for (const diagram of await loadDiagrams(projectRoot)) records.diagram.push({ title: diagram.name, ref: diagram.path, text: diagram.text });
  return records;
}
async function searchRecords(projectRoot, query) {
  const text = String(query ?? "").trim();
  if (text.length < SEARCH_MINIMUM) return { query: text, groups: [] };
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const whole = text.toLowerCase();
  const records = await searchableRecords(projectRoot);
  const groups = [];
  for (const kind of SEARCH_KINDS) {
    const matches = records[kind].filter((record) => {
      const haystack = `${record.title}
${record.text}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    if (!matches.length) continue;
    const titled = (record) => record.title.toLowerCase().includes(whole) ? 0 : 1;
    const ordered = matches.map((record, index) => ({ record, index })).sort((left, right) => titled(left.record) - titled(right.record) || left.index - right.index);
    groups.push({ kind, results: ordered.slice(0, SEARCH_LIMIT).map(({ record }) => ({ title: record.title, ref: record.ref })) });
  }
  return { query: text, groups };
}
async function searchIndex(projectRoot, config, roadmap, glossary, libraries = {}) {
  const entries = [];
  const titles = new Map(roadmap.items.map((item) => [item.id, item.title]));
  for (const item of roadmap.items) entries.push({ ref: `initiative:${item.id}`, label: item.title, kind: "initiative", detail: `${item.band} \xB7 ${item.state}` });
  for (const id of await initiativeFolders(projectRoot)) {
    if (!titles.has(id)) entries.push({ ref: `initiative:${id}`, label: id, kind: "initiative", detail: "not on the roadmap" });
    const { loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    for (const [slug, slice] of Object.entries(loaded.record?.slices ?? {})) entries.push({ ref: `slice:${id}/${slug}`, label: slice.title, kind: "slice", detail: `${titles.get(id) ?? id} \xB7 ${slice.status}` });
  }
  for (const kind of ["requirements", "decisions"]) {
    const library = libraries[kind];
    if (library?.error) throw library.error;
    for (const entry of (library ? library.value : await loadLibrary(projectRoot, kind)).entries) entries.push({ ref: entry.path, label: entry.title, kind: kind === "requirements" ? "requirement" : "decision", detail: entry.status ?? entry.path, format: entry.format ?? null });
  }
  for (const term of glossaryTerms(glossary.content)) entries.push({ ref: "glossary", label: term, kind: "term", detail: "Glossary" });
  return entries;
}
async function recordFiles(projectRoot, loaded = {}) {
  const config = loaded.config ?? await readWorkflowConfig(projectRoot);
  const records = [];
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
async function loadRecordChanges(projectRoot, loaded = {}) {
  const { records, pathspecs } = await recordFiles(projectRoot, loaded);
  return recordChanges(projectRoot, records.map(({ kind, title, ref }) => ({ kind, title, ref })), pathspecs);
}
async function knowledgeEntries(projectRoot, loaded) {
  const changes = await loadRecordChanges(projectRoot, loaded).catch(() => null);
  return changes?.available ? { changed: changes.records.length } : {};
}
async function slicesInProgress(projectRoot) {
  const roadmap = await loadRoadmapView(projectRoot);
  const ids = [...roadmap.items.map((item) => item.id), ...roadmap.unlisted];
  const slices = [];
  for (const id of [...new Set(ids)]) {
    const view = await loadInitiativeView(projectRoot, id).catch(() => null);
    if (!view?.record) continue;
    const title = view.roadmapItem?.title ?? view.record.slices?.[view.derived?.root]?.title ?? id;
    for (const [slug, slice] of Object.entries(view.record.slices ?? {})) {
      if (slice.status !== "in-progress" || (view.derived?.children?.[slug] ?? []).length) continue;
      slices.push({ initiative: { id, title }, slice: { slug, title: slice.title } });
    }
  }
  return slices;
}
function loadNavigation(projectRoot) {
  return remember(projectRoot, `navigation:${projectRoot}`, () => computeNavigation(projectRoot));
}
async function computeNavigation(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const glossary = await loadGlossary(projectRoot);
  const attention = await loadAttention(projectRoot);
  const placed = await Promise.all([
    ...roadmap.items.map((item) => ({ id: item.id, title: item.title, band: item.band, state: item.state })),
    ...roadmap.unlisted.map((id) => ({ id, title: id, band: null, state: "unlisted" }))
  ].map(async (item) => ({ ...item, place: await initiativePlace(projectRoot, item.id) })));
  const listedInitiatives = await Promise.all(placed.map(withSliceTree(projectRoot)));
  const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  const read = Object.fromEntries(await Promise.all(["requirements", "decisions"].map(async (kind) => [kind, await settled(loadLibrary(projectRoot, kind))])));
  const readable = Object.fromEntries(Object.entries(read).map(([kind, result]) => [kind, result.value ?? { entries: [] }]));
  const diagrams = await loadDiagrams(projectRoot).catch(() => []);
  return {
    roadmap: { exists: roadmap.exists ?? false, error: roadmap.error ?? null, valid: roadmap.valid ?? false },
    attention: { needsYou: attention.needsYou.length, gates: attention.gateCount, answered: attention.answered.length, watch: attention.watch.length },
    initiatives: listedInitiatives,
    // The glossary's entry carries its format mark, as each requirement and decision of the index does, so every list marks a record by its ref.
    glossary: { path: glossary.path, exists: glossary.exists, format: glossary.format ?? null },
    library: {
      ...Object.fromEntries(Object.entries(readable).map(([kind, library]) => [kind, library.entries.length])),
      terms: glossary.glossaries ? glossary.glossaries.reduce((sum, one) => sum + one.terms.length, 0) : glossaryTerms(glossary.content).length,
      diagrams: diagrams.length,
      // In a workspace, each kind's count by scope label, which the scope filter sums.
      ...glossary.glossaries ? { byScope: {
        requirements: readable.requirements.byScope ?? {},
        decisions: readable.decisions.byScope ?? {},
        terms: Object.fromEntries(glossary.glossaries.map((one) => [one.scope, one.terms.length])),
        diagrams: countByScope(diagrams)
      } } : {}
    },
    diagnostics: config.diagnostics,
    index: await searchIndex(projectRoot, config, roadmap, glossary, read),
    // Each place's own navigation data, by the place's name, for the places that need more than the lists above.
    places: { attention: attentionPlace(attention), work: await workGroups(projectRoot, listedInitiatives), history: historyEntries(roadmap), knowledge: await knowledgeEntries(projectRoot, { config, glossary, diagrams, ...readable }) }
  };
}
function historyEntries(roadmap) {
  const settled = (roadmap.items ?? []).filter((item) => item.decision?.kind === "shipped" || item.decision?.kind === "superseded");
  const time = (item) => {
    const value = Date.parse(item.decision.at ?? "");
    return Number.isFinite(value) ? value : -Infinity;
  };
  return settled.map((item, order) => ({ item, order })).sort((left, right) => time(right.item) - time(left.item) || left.order - right.order).map(({ item }) => ({ id: item.id, title: item.title, decision: item.decision.kind, at: item.decision.at ?? null, by: item.decision.kind === "superseded" ? item.decision.by ?? null : null }));
}
const WORK_GROUPS = Object.freeze([
  { key: "in-progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "designed", label: "Designed, not started" },
  { key: "unlisted", label: "Not on the roadmap" }
]);
async function workGroups(projectRoot, initiatives) {
  const live = new Set((await loadClaims(projectRoot).catch(() => ({ claims: [] }))).claims.filter((claim) => !claim.expired).map((claim) => claim.ref));
  const members = new Map(WORK_GROUPS.map((group) => [group.key, []]));
  for (const item of initiatives) {
    if (item.place !== "work") continue;
    const view = await loadInitiativeView(projectRoot, item.id).catch(() => null);
    const slices = Object.entries(view?.record?.slices ?? {});
    const working = slices.some(([slug, slice]) => slice?.status === "in-progress" || live.has(`slice:${item.id}/${slug}`));
    const blocked = slices.some(([, slice]) => slice?.status === "blocked");
    const key = item.state === "unlisted" ? "unlisted" : blocked && !working ? "blocked" : item.state === "in-progress" ? "in-progress" : "designed";
    members.get(key).push({ id: item.id, title: item.title });
  }
  members.get("unlisted").sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { groups: WORK_GROUPS.filter((group) => members.get(group.key).length).map((group) => ({ ...group, initiatives: members.get(group.key) })) };
}
async function initiativePlace(projectRoot, id) {
  const view = await loadInitiativeView(projectRoot, id).catch(() => null);
  const roadmap = view ? null : await loadRoadmapView(projectRoot);
  const decision = (view?.roadmapItem ?? roadmap?.items.find((item) => item.id === id))?.decision?.kind;
  if (decision === "shipped" || decision === "superseded") return "history";
  return view?.exists ? "work" : "roadmap";
}
const NAVIGATION_TREE_STATES = /* @__PURE__ */ new Set(["planned", "in-progress", "unlisted"]);
function withSliceTree(projectRoot) {
  return async (item) => {
    if (!NAVIGATION_TREE_STATES.has(item.state) && item.place !== "work") return item;
    const { scope } = await initiativeTree(projectRoot, item.id).catch(() => ({ scope: null }));
    return scope ? { ...item, title: item.state === "unlisted" ? scope.title : item.title, tree: scope.tree } : item;
  };
}
function under(directory, file) {
  return Boolean(directory) && file.startsWith(`${directory}/`);
}
async function initiativeTree(projectRoot, id) {
  const view = await loadInitiativeView(projectRoot, id);
  const title = view.roadmapItem?.title ?? view.record?.slices?.[view.derived?.root]?.title ?? id;
  const scope = { kind: "initiative", id, title, state: view.roadmapItem?.state ?? (view.exists ? "unlisted" : "envisioned"), valid: view.valid, tree: [] };
  if (!view.derived) return { scope, view };
  const visit = (slug, depth) => {
    const slice = view.record.slices[slug];
    const children = view.derived.children[slug] ?? [];
    const review = view.slices[slug]?.review;
    scope.tree.push({ slug, title: slice.title, status: slice.status, depth, parent: slice.parent, hasChildren: children.length > 0, complete: Boolean(view.derived.complete[slug]), blocking: review && !review.invalid ? review.blocking : 0, ...slicePhase(slice) });
    for (const child of children) visit(child, depth + 1);
  };
  visit(view.derived.root, 0);
  return { scope, view };
}
function sliceTrail(view, slug, id) {
  const trail = [];
  for (let owner = view.record.slices[slug]?.parent ?? null; owner !== null && owner !== view.derived?.root; owner = view.record.slices[owner].parent) trail.unshift({ ref: `slice:${id}/${owner}`, label: view.record.slices[owner].title });
  trail.push({ ref: `slice:${id}/${slug}`, label: view.record.slices[slug].title });
  return trail;
}
async function libraryScope(projectRoot, section) {
  const library = await loadLibrary(projectRoot, section);
  return { kind: "library", section, entries: library.entries.map((entry) => ({ path: entry.path, title: entry.title, status: entry.status, topic: entry.topic, ...entry.scope ? { scope: entry.scope } : {} })) };
}
const PLACE_LABELS = Object.freeze({ attention: "Attention", work: "Work", roadmap: "Roadmap", knowledge: "Knowledge", history: "History" });
const PLACE_PAGE_LABELS = Object.freeze({
  attention: { questions: "Questions", findings: "Review findings", failed: "Failed verifications", blocked: "Blocked work", ready: "Ready to ship", problems: "Problems", formats: "Format findings", answered: "Answered in the last 7 days", "roadmap-questions": "Roadmap questions" },
  knowledge: { touched: "Touched by my work", changed: "Changed this week", diagrams: "Diagrams" }
});
function placeCrumb(place, ref = null) {
  return { ref, label: PLACE_LABELS[place], place };
}
async function initiativeContext(projectRoot, id, { slug = null, file = null } = {}) {
  const { scope, view } = await initiativeTree(projectRoot, id);
  const place = await initiativePlace(projectRoot, id);
  const trail = [placeCrumb(place), { ref: `initiative:${id}`, label: scope.title }];
  const known = slug && view.record && Object.hasOwn(view.record.slices, slug) ? slug : null;
  if (known) trail.push(...sliceTrail(view, known, id));
  if (file) trail.push(file);
  return { trail, scope: { ...scope, current: known }, place };
}
async function knownInitiative(projectRoot, id) {
  if (await readText(projectRoot, await recordFile(projectRoot, { kind: "initiative", initiative: id })) !== null) return true;
  const roadmap = await loadRoadmapView(projectRoot).catch(() => null);
  return Boolean(roadmap?.items?.some((item) => item.id === id));
}
async function pageHistory(projectRoot, initiative) {
  const history = await shippedHistory(projectRoot, initiative).catch(() => null);
  return history ? { ...history, label: shippedHistoryLabel(initiative, { at: history.shippedAt }) } : null;
}
async function documentHistory(projectRoot, plans, ref) {
  if (!under(plans, ref) || path.posix.basename(ref) !== "slice.md") return null;
  const id = ref.slice(plans.length + 1).split("/")[0];
  if (!SLUG_PATTERN.test(id ?? "")) return null;
  const history = await pageHistory(projectRoot, id);
  if (!history) return null;
  const changed = history.changedAfterShip.some((item) => item.path === ref);
  if (!changed && !history.documents.includes(ref)) return null;
  return { ...history, changedAfterShip: changed };
}
async function entityContext(projectRoot, ref) {
  const parsed = parseEntityRef(ref);
  if (ref === "attention" || ref === "roadmap") return { trail: [placeCrumb(ref, ref)], scope: { kind: "global" }, place: ref };
  if (parsed?.kind === "requirements" || parsed?.kind === "decisions") return { trail: [placeCrumb("knowledge"), { ref, label: SECTION_LABELS[parsed.kind] }], scope: await libraryScope(projectRoot, parsed.kind), place: "knowledge" };
  if (parsed?.kind === "glossary") return { trail: [placeCrumb("knowledge"), { ref, label: "Glossary" }], scope: { kind: "global" }, place: "knowledge" };
  if (parsed?.kind === "code") return { trail: [placeCrumb("knowledge"), { ref, label: "Code" }], scope: { kind: "global" }, place: "knowledge" };
  if (parsed?.kind === "agents") return { trail: [{ ref, label: SECTION_LABELS.agents }], scope: { kind: "global" }, place: null };
  if (parsed?.kind === "initiative" || parsed?.kind === "slice") return initiativeContext(projectRoot, parsed.id, { slug: parsed.kind === "slice" ? parsed.slug : null });
  if (parsed?.kind === "migration-run") return migrationRunContext(projectRoot, ref, parsed.id);
  if (typeof ref !== "string" || !ref) throw new Error("A tab reference is required.");
  const prefixed = /^(attention|knowledge):(.+)$/.exec(ref);
  if (prefixed) {
    const [, place, page] = prefixed;
    const entry = place === "attention" ? placeCrumb("attention", "attention") : placeCrumb("knowledge");
    const label = place === "attention" && page.startsWith("work/") ? (await attentionPage(projectRoot, page)).filter.label : PLACE_PAGE_LABELS[place][page] ?? page;
    return { trail: [entry, { ref, label }], scope: { kind: "global" }, place };
  }
  const config = await readWorkflowConfig(projectRoot);
  const history = await documentHistory(projectRoot, config.paths.plans, ref);
  if (history) return { ...await fileContext(projectRoot, config, ref), shippedHistory: history };
  return fileContext(projectRoot, config, ref);
}
async function fileContext(projectRoot, config, ref) {
  const roadmapCrumb = { ref: "roadmap", label: "Roadmap" };
  const libraryCrumb = { ref: null, label: "Library" };
  const fileCrumb = { ref, label: path.posix.basename(ref) };
  const plans = config.paths.plans;
  const record = await keyOfPath(projectRoot, ref).catch(() => null);
  if (record?.initiative && ref.startsWith(".prism/")) return initiativeContext(projectRoot, record.initiative, { slug: record.slice ?? null, file: fileCrumb });
  if (under(plans, ref)) {
    const [id, segment] = ref.slice(plans.length + 1).split("/");
    if (SLUG_PATTERN.test(id ?? "") && await knownInitiative(projectRoot, id)) {
      return initiativeContext(projectRoot, id, { slug: segment && ref !== `${plans}/${id}/${segment}` ? segment : null, file: fileCrumb });
    }
  }
  for (const section of ["requirements", "decisions"]) {
    const directory = section === "requirements" ? config.paths.requirements : config.paths.adrs;
    if (under(directory, ref)) {
      const scope = await libraryScope(projectRoot, section);
      const entry = scope.entries.find((item) => item.path === ref);
      return { trail: [placeCrumb("knowledge"), { ref: section, label: SECTION_LABELS[section] }, { ref, label: entry?.title ?? path.posix.basename(ref) }], scope: { ...scope, current: ref }, place: "knowledge" };
    }
  }
  if (ref === config.paths.glossary) return { trail: [placeCrumb("knowledge"), { ref: "glossary", label: "Glossary" }, fileCrumb], scope: { kind: "global" }, place: "knowledge" };
  const roadmapPaths = await readRoadmap(projectRoot).then(({ resolved }) => [resolved.recordPath, resolved.projectionPath]).catch(() => []);
  if (roadmapPaths.includes(ref)) return { trail: [placeCrumb("roadmap"), fileCrumb], scope: { kind: "global" }, place: "roadmap" };
  return { trail: [{ ref: null, label: "Files" }, { ref, label: ref }], scope: { kind: "global" }, place: null };
}
function relatedTitles(roadmap, id) {
  const item = roadmap.items.find((entry) => entry.id === id);
  const related = /* @__PURE__ */ new Set([...item?.requires ?? [], ...item?.requiredBy ?? []]);
  return Object.fromEntries(roadmap.items.filter((entry) => related.has(entry.id)).map((entry) => [entry.id, entry.title]));
}
function bandRank(roadmap, id) {
  const item = roadmap.items.find((entry) => entry.id === id);
  if (!item || item.state === "shipped" || item.state === "superseded") return null;
  const rank = roadmap.items.filter((entry) => entry.band === item.band && entry.state !== "shipped" && entry.state !== "superseded").findIndex((entry) => entry.id === id);
  return rank < 0 ? null : rank + 1;
}
function parseEntityRef(ref) {
  if (SECTION_REFS.includes(ref)) return { kind: ref };
  if (ref === "launches") return { kind: "agents" };
  const group = /^agents:([a-z-]+)$/.exec(ref ?? "");
  if (group && AGENT_GROUP_PAGES.includes(group[1])) return { kind: "agents", page: group[1] };
  let match = /^attention:(questions|findings|failed|blocked|ready|problems|formats|answered|roadmap-questions|work\/[A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "attention", page: match[1] };
  match = /^knowledge:(diagrams|touched|changed)$/.exec(ref ?? "");
  if (match) return { kind: "knowledge", page: match[1] };
  match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  match = /^migration-run:(.+)$/.exec(ref ?? "");
  if (match && RUN_ID.test(match[1])) return { kind: "migration-run", id: match[1] };
  return null;
}
async function entityExists(projectRoot, ref) {
  const parsed = parseEntityRef(ref);
  if (!parsed) return false;
  if (SECTION_REFS.includes(parsed.kind) || parsed.kind === "knowledge") return true;
  if (parsed.kind === "migration-run") return await readRun(projectRoot, parsed.id).catch(() => null) !== null;
  if (parsed.kind === "initiative") {
    const roadmap = await loadRoadmapView(projectRoot);
    if (roadmap.items.some((item) => item.id === parsed.id) || roadmap.unlisted.includes(parsed.id)) return true;
    return (await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: { exists: false } }))).loaded.exists;
  }
  const { loaded } = await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: {} }));
  return Boolean(loaded.record?.slices && Object.hasOwn(loaded.record.slices, parsed.slug));
}
async function initiativeCode(projectRoot, view) {
  const code = {};
  for (const slug of Object.keys(view.record?.slices ?? {})) {
    const checkout = await verifiedCode(projectRoot, view.id, slug).catch(() => null);
    if (checkout) code[slug] = checkout;
  }
  return code;
}
async function loadEntity(projectRoot, ref, options = {}) {
  const parsed = parseEntityRef(ref);
  if (!parsed) throw new Error(`Unknown entity reference: ${ref}`);
  if (parsed.kind === "migration-run") return { ref, kind: "migration-run", data: await loadMigrationRunView(projectRoot, parsed.id) };
  if (parsed.kind === "attention") return { ref, kind: "attention", data: parsed.page ? await attentionPage(projectRoot, parsed.page) : await loadAttentionView(projectRoot) };
  if (parsed.kind === "roadmap") return { ref, kind: "roadmap", data: await loadRoadmapView(projectRoot) };
  if (parsed.kind === "requirements" || parsed.kind === "decisions") return { ref, kind: parsed.kind, data: await loadLibrary(projectRoot, parsed.kind) };
  if (parsed.kind === "glossary") return { ref, kind: "glossary", data: await loadGlossary(projectRoot) };
  if (parsed.kind === "code") return { ref, kind: "code", data: { repositories: [] } };
  if (parsed.kind === "agents") return { ref, kind: "agents", data: { show: parsed.page ?? "all" } };
  if (parsed.kind === "knowledge" && parsed.page === "diagrams") {
    const diagrams = await loadDiagrams(projectRoot);
    const about = Object.fromEntries(diagrams.map(({ path: file, kind, ownerRef }) => [file, { kind, owner: ownerRef }]));
    return { ref, kind: "diagrams", data: { diagrams: diagrams.map(({ path: file, name, owner }) => ({ path: file, name, owner })), about } };
  }
  if (parsed.kind === "knowledge" && parsed.page === "touched") return { ref, kind: "touched", data: { inProgress: await slicesInProgress(projectRoot) } };
  if (parsed.kind === "knowledge") return { ref, kind: "changed", data: await loadRecordChanges(projectRoot) };
  if (parsed.kind === "initiative") {
    const view = await loadInitiativeView(projectRoot, parsed.id);
    const history2 = await pageHistory(projectRoot, parsed.id);
    return { ref, kind: "initiative", data: { ...view, runTotals: await loadInitiativeRunTotals(projectRoot, view), code: await initiativeCode(projectRoot, view), ...history2 ? { shippedHistory: history2 } : {} } };
  }
  const history = await pageHistory(projectRoot, parsed.id);
  const slice = await loadSliceView(projectRoot, parsed.id, parsed.slug, options);
  return { ref, kind: "slice", data: history ? { ...slice, shippedHistory: history } : slice };
}
export {
  AGENT_GROUP_PAGES,
  ATTENTION_KINDS,
  SECTION_REFS,
  asWorkspaceView,
  attentionItems,
  entityContext,
  entityExists,
  forgetWorkspace,
  formatMark,
  glossaryEntries,
  loadAttention,
  loadAttentionView,
  loadClaims,
  loadDeclaredView,
  loadDiagrams,
  loadEntity,
  loadFormatMark,
  loadFormatMarks,
  loadGlossary,
  loadHeldClaims,
  loadInitiativeView,
  loadLibrary,
  loadNavigation,
  loadRecordChanges,
  loadRoadmapView,
  loadSliceView,
  migrationRunTitle,
  parseEntityRef,
  recheckViews,
  recordFiles,
  rememberView,
  searchRecords,
  slicePresence,
  viewVersion,
  viewWatching
};
