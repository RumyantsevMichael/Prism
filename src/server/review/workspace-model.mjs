import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readInitiativeRecordRunTotals } from "../session/run-totals.mjs";
import { readInitiative, readInitiativeWithClaims, sliceFolder } from "../workflow/initiative.mjs";
import { isLive, parseClaim } from "../workflow/slice-claims.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { DISPLAY_BANDS, readRoadmap } from "../workflow/roadmap.mjs";
import { historyOrder, readCoordinationState } from "../workflow/state.mjs";
import { readIndexHistory } from "../workflow/index-history.mjs";
import { keyOfPath, listClaimRecords, listInitiatives, listSliceRecords, locateRecord, recordPath, recordsUnavailable, resolveRecordFile } from "../workflow/record-store.mjs";
import { initiativeDirectory, readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { latestVerification, verifiedCode } from "../workflow/slice-design.mjs";
import { lastChangeMapDerivation, startChangeMapDerivation } from "../conservation/derived-change-map.mjs";
import { loadDesignView } from "../workflow/design-view.mjs";
import { readPublishedUnits } from "../repository-intelligence/index-status.mjs";
import { shippedActionReason, shippedDecision, shippedHistory, shippedHistoryLabel } from "../workflow/shipped-history.mjs";

const LIBRARY_LIMIT = 500;
const RECENT_CHANGES_LIMIT = 20;
const SLICE_FILE_LIMIT = 200;
const UNRESOLVED = new Set(["OPEN", "IN PROGRESS", "REOPENED"]);
// Each open page polls every 1.5 s, and one poll reads every record several times, so results are shared for a second.
// The review server clears the cache after its own writes; writes from agents show up within the window.
const MEMO_MS = 1000;
const memo = new Map();

function remember(key, compute) {
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

export const SECTION_REFS = Object.freeze(["attention", "roadmap", "requirements", "decisions", "glossary"]);
const SECTION_LABELS = Object.freeze({ attention: "Attention", roadmap: "Roadmap", requirements: "Requirements", decisions: "Decisions", glossary: "Glossary" });

// A record is read where it lives: under .prism, or beside its Markdown until the first write moves it there.
async function recordFile(root, key) {
  const located = await locateRecord(root, key);
  // A record not yet moved is shown where it lies; any other keeps its .prism address, also when a record store holds its file.
  return located.legacy ?? located.path;
}

async function readText(root, relative) {
  try {
    return await readFile((await resolveRecordFile(root, relative)).target, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
}

async function walk(root, relative, depth, accept, results, limit) {
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

function headerFields(source) {
  const title = source.match(/^#\s+(.+?)\s*$/m)?.[1] ?? null;
  const field = (name) => source.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;
  return { title, status: field("Status"), created: field("Created"), approved: field("Approved") };
}

function reviewSummary(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const unresolved = findings.filter((finding) => UNRESOLVED.has(finding.status));
  const waves = Array.isArray(review?.waves) ? review.waves : [];
  return {
    findings: findings.length,
    unresolved: unresolved.length,
    blocking: findings.filter((finding) => finding.status !== "VERIFIED" && ["blocker", "high"].includes(finding.severity)).length,
    byStatus: Object.fromEntries(["OPEN", "IN PROGRESS", "REOPENED", "FIXED", "VERIFIED"].map((status) => [status, findings.filter((finding) => finding.status === status).length])),
    waves: waves.length,
    currentWave: waves.at(-1) ? { id: waves.at(-1).id, mode: waves.at(-1).mode, accepted: Boolean(waves.at(-1).accepted) } : null
  };
}

const COORDINATION_FILES = new Set(["initiative.md"]);

// A slice's human documents sit in its plans folder; its review and change map are records under .prism.
async function sliceArtifacts(root, directory, slices, slug, id) {
  const folder = sliceFolder(directory, slices, slug);
  const files = [];
  // The root slice shares the initiative directory, so it lists only its own top-level files.
  if (folder === directory) await walk(root, folder, 0, (name) => !COORDINATION_FILES.has(name), files, SLICE_FILE_LIMIT);
  else await walk(root, folder, 3, () => true, files, SLICE_FILE_LIMIT);
  const reviewPath = await recordFile(root, { kind: "review", initiative: id, slice: slug });
  const reviewSource = await readText(root, reviewPath);
  let review = null;
  if (reviewSource !== null) {
    try {
      review = { path: reviewPath, ...reviewSummary(JSON.parse(reviewSource)) };
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
function storedInitiatives(root) {
  return listInitiatives(root).catch((error) => { if (recordsUnavailable(error)) return []; throw error; });
}

async function initiativeFolders(root) {
  const ids = [];
  for (const id of await storedInitiatives(root)) if ((await readText(root, await recordFile(root, { kind: "initiative", initiative: id }))) !== null) ids.push(id);
  return ids;
}

async function initiativeFindings(root, config, id) {
  const totals = { unresolved: 0, blocking: 0 };
  const ledgers = await Promise.all((await listSliceRecords(root, id)).map((slice) => recordFile(root, { kind: "review", initiative: id, slice })));
  for (const ledger of ledgers) {
    const source = await readText(root, ledger);
    if (source === null) continue;
    try {
      const summary = reviewSummary(JSON.parse(source));
      totals.unresolved += summary.unresolved;
      totals.blocking += summary.blocking;
    } catch {
      // An unreadable review ledger is reported on the slice page, not counted here.
    }
  }
  return totals;
}

export function loadRoadmapView(projectRoot) {
  return remember(`roadmap:${projectRoot}`, () => computeRoadmapView(projectRoot));
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
        findings: await initiativeFindings(projectRoot, config, item.id)
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

export function loadInitiativeView(projectRoot, id) {
  return remember(`initiative:${id}:${projectRoot}`, () => computeInitiativeView(projectRoot, id));
}

// Only initiative and slice pages read run records; loadInitiativeView stays free of them for navigation polls.
function loadInitiativeRunTotals(projectRoot, initiative) {
  return remember(`run-totals:${initiative.id}:${projectRoot}`, () => readInitiativeRecordRunTotals(projectRoot, initiative.id, initiative));
}

// Initiative reads keep only live claims; the browser also shows a claim that lapsed without a release, as expiredClaim, until someone claims or releases the slice.
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
    copy[slice] = { ...slices[slice], expiredClaim: { label: claim.label, activity: claim.activity, claimedAt: claim.claimedAt, expiresAt: claim.expiresAt } };
  }
  return copy ? { ...read, loaded: { ...read.loaded, record: { ...read.loaded.record, slices: copy } } } : read;
}

async function computeInitiativeView(projectRoot, id) {
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
  const slices = {};
  if (loaded.record?.slices) {
    for (const slug of Object.keys(loaded.record.slices)) slices[slug] = await sliceArtifacts(projectRoot, resolved.directory, loaded.record.slices, slug, id);
  }
  const analysis = loaded.analysis;
  // A design waits at its gate until the orchestrator accepts it, while the record still says not-started, so the browser shows that wait instead.
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

// A designed slice's change map is derived from its verified result; opening the slice starts a derivation the server has not finished yet.
async function derivedChangeMapState(projectRoot, id, slug, design, verification) {
  if (!design?.baselineId || !verification?.passed || !verification.snapshotId || verification.designAcceptedAt !== design.acceptedAt) return null;
  const source = await readText(projectRoot, await recordFile(projectRoot, { kind: "change-map", initiative: id, slice: slug }));
  let document = null;
  try { document = source === null ? null : JSON.parse(source); }
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
function coveringClaim(slices, slug) {
  for (let owner = slices[slug]?.parent ?? null; owner !== null && Object.hasOwn(slices, owner); owner = slices[owner].parent ?? null) {
    if (slices[owner].claim?.activity === "design") return { slug: owner, title: slices[owner].title, claim: slices[owner].claim };
  }
  return null;
}

// The published code index, when there is one, places each planned change in the code; the view never starts a build.
export async function loadSliceView(projectRoot, id, slug, { intelligenceDirectories } = {}) {
  const initiative = await loadInitiativeView(projectRoot, id);
  if (!initiative.record || !Object.hasOwn(initiative.record.slices, slug)) throw new Error(`The initiative ${id} has no slice ${slug}.`);
  const slice = initiative.record.slices[slug];
  const derived = initiative.derived;
  const verification = await latestVerification(projectRoot, id, slug).catch(() => null);
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
    dependents: Object.entries(initiative.record.slices).filter(([, other]) => other.dependencies.includes(slug)).map(([other]) => other),
    complete: derived?.complete[slug] ?? false,
    active: initiative.active.filter((entry) => entry.slice === slug),
    designReview: initiative.designReview[slug] ?? null,
    coveringClaim: coveringClaim(initiative.record.slices, slug),
    artifacts: initiative.slices[slug],
    verification,
    code: await verifiedCode(projectRoot, id, slug).catch(() => null),
    changeMap: Object.keys(changeMap).length ? changeMap : null,
    designView: await loadDesignView(projectRoot, id, slug, { changeMap: changeMapDocument ?? null, units: await readPublishedUnits(projectRoot, ...(intelligenceDirectories ? [intelligenceDirectories] : [])).catch(() => null) }).catch(() => null),
    titles: Object.fromEntries(Object.entries(initiative.record.slices).map(([key, value]) => [key, value.title])),
    runTotals
  };
}

async function initiativeReferences(projectRoot, config) {
  const references = new Map();
  for (const id of await initiativeFolders(projectRoot)) {
    const { loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    // Split parents repeat their children's references, so only leaves count as assignments.
    const leaves = new Set(loaded.analysis?.leaves ?? []);
    for (const [slug, slice] of Object.entries(loaded.record?.slices ?? {})) {
      if (!leaves.has(slug)) continue;
      for (const reference of slice.requirements ?? []) {
        const file = reference.split("#")[0];
        if (!references.has(file)) references.set(file, []);
        references.get(file).push({ initiative: id, slug, title: slice.title, anchor: reference.split("#")[1] ?? null });
      }
    }
  }
  return references;
}

export function loadLibrary(projectRoot, kind) {
  return remember(`library:${kind}:${projectRoot}`, () => computeLibrary(projectRoot, kind));
}

async function computeLibrary(projectRoot, kind) {
  const config = await readWorkflowConfig(projectRoot);
  const directory = kind === "requirements" ? config.paths.requirements : config.paths.adrs;
  if (!directory) return { kind, directory: null, entries: [] };
  const files = [];
  await walk(projectRoot, directory, 4, (name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md", files, LIBRARY_LIMIT);
  const references = kind === "requirements" ? await initiativeReferences(projectRoot, config) : new Map();
  const entries = [];
  for (const file of files) {
    const source = await readText(projectRoot, file);
    const fields = headerFields(source ?? "");
    const relative = file.slice(directory.length + 1);
    entries.push({
      path: file,
      title: fields.title ?? path.posix.basename(file, ".md"),
      status: fields.status,
      created: fields.created,
      approved: fields.approved,
      topic: relative.includes("/") ? relative.split("/")[0] : null,
      ...(kind === "requirements" ? { assignedTo: references.get(file) ?? [] } : {})
    });
  }
  return { kind, directory, entries };
}

export async function loadGlossary(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const glossaryPath = config.paths.glossary;
  const content = glossaryPath ? await readText(projectRoot, glossaryPath) : null;
  return { path: glossaryPath, exists: content !== null, content };
}


async function isFile(root, relative) {
  try {
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
    sliceTitle: (slug) => (slug && Object.hasOwn(slices, slug) ? slices[slug].title : slug ?? null)
  };
}

// The newest question comes first, so the one just asked is on top; an unreadable time sorts last.
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

export function loadAttention(projectRoot) {
  return remember(`attention:${projectRoot}`, () => computeAttention(projectRoot));
}

async function computeAttention(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const items = new Map(roadmap.items.map((item) => [item.id, item]));
  const ids = [...new Set([...roadmap.items.map((item) => item.id), ...(await storedInitiatives(projectRoot))])];
  const needsYou = [];
  // Open questions of a shipped initiative can no longer be answered, so they list apart and never wait on the person.
  const shippedGates = [];
  const answered = [];
  const earlier = [];
  const watch = [];
  // The person's applied actions: every initiative history of these records, and this checkout's own index history, which no other checkout shares.
  const changes = (await readIndexHistory(projectRoot).catch(() => ({ history: [] }))).history.map((entry) => ({ ...entry, initiative: null }));
  for (const id of ids) {
    const snapshot = await initiativeSnapshot(projectRoot, config, id, items.get(id));
    const initiative = { id, title: snapshot.title };
    const state = snapshot.state;
    // A shipped initiative's state is history, so its open questions can no longer be answered and no longer wait on the person.
    const shipped = await shippedDecision(projectRoot, id).catch(() => null);
    if (state?.valid) for (const entry of state.state?.history ?? []) changes.push({ ...entry, initiative: id });
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
          artifacts.push({ path: current, available: await isFile(projectRoot, current) });
        }
        const gate = { type: "gate", id: entry.id, kind: entry.kind, question: entry.question, context: entry.context ?? null, options: entry.options ?? null, recommended: entry.recommended ?? null, askedAt: entry.askedAt, answer: entry.answer ?? null, initiative, slice: entry.slice ? { slug: entry.slice, title: snapshot.sliceTitle(entry.slice) } : null, artifacts, unavailable: shipped ? shippedActionReason(shipped) : null };
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
    for (const [slug, slice] of Object.entries(slices)) {
      if (slice.status === "blocked") watch.push({ type: "blocked", initiative, slice: { slug, title: slice.title } });
    }
    for (const slug of Object.keys(slices)) {
      const ledger = await recordFile(projectRoot, { kind: "review", initiative: id, slice: slug });
      const source = await readText(projectRoot, ledger);
      if (source === null) continue;
      try {
        const summary = reviewSummary(JSON.parse(source));
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
  needsYou.sort((left, right) => (left.type === "gate") === (right.type === "gate") ? gateOrder(left, right) : left.type === "gate" ? -1 : 1);
  if (roadmap.error) needsYou.push({ type: "roadmap-problem", path: config.paths.roadmap, message: roadmap.error });
  else if (!roadmap.exists && config.paths.roadmap) needsYou.push({ type: "roadmap-missing", path: roadmap.recordPath });
  else if (roadmap.exists && !roadmap.valid) needsYou.push({ type: "roadmap-problem", path: roadmap.recordPath, message: roadmap.errors.join(" ") });
  for (const id of roadmap.unlisted) needsYou.push({ type: "unlisted", initiative: { id, title: id } });
  for (const question of roadmap.openQuestions ?? []) needsYou.push({ type: "open-question", text: question });
  for (const diagnostic of config.diagnostics) needsYou.push({ type: "config", code: diagnostic.code, message: diagnostic.message });
  const blockingOrder = (entry) => ({ "record-problem": 0, blocked: 1, findings: entry.blocking ? 2 : 3, "ready-to-ship": 4, active: 5 })[entry.type] ?? 6;
  watch.sort((left, right) => blockingOrder(left) - blockingOrder(right));
  answered.sort((left, right) => newestFirst(left.answer.answeredAt, right.answer.answeredAt));
  // The newest closed questions come first, across initiatives, so the list stays short.
  earlier.sort((left, right) => newestFirst(left.closedAt, right.closedAt));
  const recentChanges = changes.sort((left, right) => historyOrder(right, left)).slice(0, RECENT_CHANGES_LIMIT);
  shippedGates.sort(gateOrder);
  return { needsYou, shippedGates, answered, earlier: earlier.slice(0, 20), watch, recentChanges, gateCount: needsYou.filter((item) => item.type === "gate").length };
}

function glossaryTerms(content) {
  const terms = [];
  for (const line of (content ?? "").split("\n")) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) terms.push(heading[1]);
    const row = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (row && !/^-+$/.test(row[1].replace(/[:\s]/g, "")) && !["term", "name"].includes(row[1].toLowerCase())) terms.push(row[1].replace(/\*\*/g, ""));
  }
  return [...new Set(terms)].slice(0, LIBRARY_LIMIT);
}

async function searchIndex(projectRoot, config, roadmap, glossary) {
  const entries = [];
  const titles = new Map(roadmap.items.map((item) => [item.id, item.title]));
  for (const item of roadmap.items) entries.push({ ref: `initiative:${item.id}`, label: item.title, kind: "initiative", detail: `${item.band} · ${item.state}` });
  for (const id of await initiativeFolders(projectRoot)) {
    if (!titles.has(id)) entries.push({ ref: `initiative:${id}`, label: id, kind: "initiative", detail: "not on the roadmap" });
    const { loaded } = await readInitiative(projectRoot, id).catch(() => ({ loaded: {} }));
    for (const [slug, slice] of Object.entries(loaded.record?.slices ?? {})) entries.push({ ref: `slice:${id}/${slug}`, label: slice.title, kind: "slice", detail: `${titles.get(id) ?? id} · ${slice.status}` });
  }
  for (const kind of ["requirements", "decisions"]) {
    for (const entry of (await loadLibrary(projectRoot, kind)).entries) entries.push({ ref: entry.path, label: entry.title, kind: kind === "requirements" ? "requirement" : "decision", detail: entry.status ?? entry.path });
  }
  for (const term of glossaryTerms(glossary.content)) entries.push({ ref: "glossary", label: term, kind: "term", detail: "Glossary" });
  return entries;
}

export function loadNavigation(projectRoot) {
  return remember(`navigation:${projectRoot}`, () => computeNavigation(projectRoot));
}

async function computeNavigation(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const glossary = await loadGlossary(projectRoot);
  const attention = await loadAttention(projectRoot);
  return {
    roadmap: { exists: roadmap.exists ?? false, error: roadmap.error ?? null, valid: roadmap.valid ?? false },
    attention: { needsYou: attention.needsYou.length, gates: attention.gateCount, answered: attention.answered.length, watch: attention.watch.length },
    initiatives: [
      ...roadmap.items.map((item) => ({ id: item.id, title: item.title, band: item.band, state: item.state })),
      ...roadmap.unlisted.map((id) => ({ id, title: id, band: null, state: "unlisted" }))
    ],
    glossary: { path: glossary.path, exists: glossary.exists },
    diagnostics: config.diagnostics,
    index: await searchIndex(projectRoot, config, roadmap, glossary)
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
    scope.tree.push({ slug, title: slice.title, status: slice.status, depth, parent: slice.parent, hasChildren: children.length > 0, complete: Boolean(view.derived.complete[slug]), blocking: review && !review.invalid ? review.blocking : 0 });
    for (const child of children) visit(child, depth + 1);
  };
  visit(view.derived.root, 0);
  return { scope, view };
}

function sliceTrail(view, slug, id) {
  const trail = [];
  // The root slice is the initiative itself, so the initiative crumb already stands for it.
  for (let owner = view.record.slices[slug]?.parent ?? null; owner !== null && owner !== view.derived?.root; owner = view.record.slices[owner].parent) trail.unshift({ ref: `slice:${id}/${owner}`, label: view.record.slices[owner].title });
  trail.push({ ref: `slice:${id}/${slug}`, label: view.record.slices[slug].title });
  return trail;
}

async function libraryScope(projectRoot, section) {
  const library = await loadLibrary(projectRoot, section);
  return { kind: "library", section, entries: library.entries.map((entry) => ({ path: entry.path, title: entry.title, status: entry.status, topic: entry.topic })) };
}

// A page of a shipped initiative carries its shipped history with the label the page shows, or null when the initiative has not shipped.
async function pageHistory(projectRoot, initiative) {
  const history = await shippedHistory(projectRoot, initiative).catch(() => null);
  return history ? { ...history, label: shippedHistoryLabel(initiative, { at: history.shippedAt }) } : null;
}

// A slice document of a shipped initiative carries the page's shipped history, with changedAfterShip saying whether this document changed after ship.
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

// Context gives every tab, including plain files, a breadcrumb trail and the sidebar scope it belongs to.
export async function entityContext(projectRoot, ref) {
  const parsed = parseEntityRef(ref);
  const roadmapCrumb = { ref: "roadmap", label: "Roadmap" };
  const libraryCrumb = { ref: null, label: "Library" };
  if (parsed?.kind === "attention" || parsed?.kind === "roadmap") return { trail: [{ ref, label: SECTION_LABELS[parsed.kind] }], scope: { kind: "global" } };
  if (parsed?.kind === "requirements" || parsed?.kind === "decisions") return { trail: [libraryCrumb, { ref, label: SECTION_LABELS[parsed.kind] }], scope: await libraryScope(projectRoot, parsed.kind) };
  if (parsed?.kind === "glossary") return { trail: [libraryCrumb, { ref, label: "Glossary" }], scope: { kind: "global" } };
  if (parsed?.kind === "initiative" || parsed?.kind === "slice") {
    const { scope, view } = await initiativeTree(projectRoot, parsed.id);
    const trail = [roadmapCrumb, { ref: `initiative:${parsed.id}`, label: scope.title }];
    if (parsed.kind === "slice" && view.record && Object.hasOwn(view.record.slices, parsed.slug)) trail.push(...sliceTrail(view, parsed.slug, parsed.id));
    return { trail, scope: { ...scope, current: parsed.kind === "slice" ? parsed.slug : null } };
  }
  if (typeof ref !== "string" || !ref) throw new Error("A tab reference is required.");
  const config = await readWorkflowConfig(projectRoot);
  const history = await documentHistory(projectRoot, config.paths.plans, ref);
  if (history) return { ...(await fileContext(projectRoot, config, ref)), shippedHistory: history };
  return fileContext(projectRoot, config, ref);
}

// The trail and scope of a file tab.
async function fileContext(projectRoot, config, ref) {
  const roadmapCrumb = { ref: "roadmap", label: "Roadmap" };
  const libraryCrumb = { ref: null, label: "Library" };
  const fileCrumb = { ref, label: path.posix.basename(ref) };
  const plans = config.paths.plans;
  const record = await keyOfPath(projectRoot, ref).catch(() => null);
  if (record?.initiative && ref.startsWith(".prism/")) {
    const { scope, view } = await initiativeTree(projectRoot, record.initiative);
    const trail = [roadmapCrumb, { ref: `initiative:${record.initiative}`, label: scope.title }];
    const slug = record.slice && view.record && Object.hasOwn(view.record.slices, record.slice) ? record.slice : null;
    if (slug) trail.push(...sliceTrail(view, slug, record.initiative));
    return { trail: [...trail, fileCrumb], scope: { ...scope, current: slug } };
  }
  if (under(plans, ref)) {
    const [id, segment] = ref.slice(plans.length + 1).split("/");
    if (SLUG_PATTERN.test(id ?? "") && (await readText(projectRoot, await recordFile(projectRoot, { kind: "initiative", initiative: id }))) !== null) {
      const { scope, view } = await initiativeTree(projectRoot, id);
      const trail = [roadmapCrumb, { ref: `initiative:${id}`, label: scope.title }];
      const slug = view.record && segment && Object.hasOwn(view.record.slices, segment) && ref !== `${plans}/${id}/${segment}` ? segment : null;
      if (slug) trail.push(...sliceTrail(view, slug, id));
      return { trail: [...trail, fileCrumb], scope: { ...scope, current: slug } };
    }
  }
  for (const section of ["requirements", "decisions"]) {
    const directory = section === "requirements" ? config.paths.requirements : config.paths.adrs;
    if (under(directory, ref)) {
      const scope = await libraryScope(projectRoot, section);
      const entry = scope.entries.find((item) => item.path === ref);
      return { trail: [libraryCrumb, { ref: section, label: SECTION_LABELS[section] }, { ref, label: entry?.title ?? path.posix.basename(ref) }], scope: { ...scope, current: ref } };
    }
  }
  if (ref === config.paths.glossary) return { trail: [libraryCrumb, { ref: "glossary", label: "Glossary" }, fileCrumb], scope: { kind: "global" } };
  const roadmapPaths = await readRoadmap(projectRoot).then(({ resolved }) => [resolved.recordPath, resolved.projectionPath]).catch(() => []);
  if (roadmapPaths.includes(ref)) return { trail: [roadmapCrumb, fileCrumb], scope: { kind: "global" } };
  return { trail: [{ ref: null, label: "Files" }, { ref, label: ref }], scope: { kind: "global" } };
}

// Entity tabs name Prism concepts rather than files, so they never collide with artifact paths, which always carry an extension.
export function parseEntityRef(ref) {
  if (SECTION_REFS.includes(ref)) return { kind: ref };
  let match = /^initiative:([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "initiative", id: match[1] };
  match = /^slice:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref ?? "");
  if (match) return { kind: "slice", id: match[1], slug: match[2] };
  return null;
}

export async function entityExists(projectRoot, ref) {
  const parsed = parseEntityRef(ref);
  if (!parsed) return false;
  if (SECTION_REFS.includes(parsed.kind)) return true;
  if (parsed.kind === "initiative") {
    const roadmap = await loadRoadmapView(projectRoot);
    if (roadmap.items.some((item) => item.id === parsed.id) || roadmap.unlisted.includes(parsed.id)) return true;
    return (await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: { exists: false } }))).loaded.exists;
  }
  const { loaded } = await readInitiative(projectRoot, parsed.id).catch(() => ({ loaded: {} }));
  return Boolean(loaded.record?.slices && Object.hasOwn(loaded.record.slices, parsed.slug));
}

// The code location of each slice's latest passing verification run, by slice; only the initiative page reads run records for it.
async function initiativeCode(projectRoot, view) {
  const code = {};
  for (const slug of Object.keys(view.record?.slices ?? {})) {
    const checkout = await verifiedCode(projectRoot, view.id, slug).catch(() => null);
    if (checkout) code[slug] = checkout;
  }
  return code;
}

export async function loadEntity(projectRoot, ref, options = {}) {
  const parsed = parseEntityRef(ref);
  if (!parsed) throw new Error(`Unknown entity reference: ${ref}`);
  if (parsed.kind === "attention") return { ref, kind: "attention", data: await loadAttention(projectRoot) };
  if (parsed.kind === "roadmap") return { ref, kind: "roadmap", data: await loadRoadmapView(projectRoot) };
  if (parsed.kind === "requirements" || parsed.kind === "decisions") return { ref, kind: parsed.kind, data: await loadLibrary(projectRoot, parsed.kind) };
  if (parsed.kind === "glossary") return { ref, kind: "glossary", data: await loadGlossary(projectRoot) };
  if (parsed.kind === "initiative") {
    const view = await loadInitiativeView(projectRoot, parsed.id);
    const history = await pageHistory(projectRoot, parsed.id);
    return { ref, kind: "initiative", data: { ...view, runTotals: await loadInitiativeRunTotals(projectRoot, view), code: await initiativeCode(projectRoot, view), ...(history ? { shippedHistory: history } : {}) } };
  }
  const history = await pageHistory(projectRoot, parsed.id);
  const slice = await loadSliceView(projectRoot, parsed.id, parsed.slug, options);
  return { ref, kind: "slice", data: history ? { ...slice, shippedHistory: history } : slice };
}
