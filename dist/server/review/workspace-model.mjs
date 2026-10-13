import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readInitiative } from "../workflow/initiative.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { DISPLAY_BANDS, readRoadmap } from "../workflow/roadmap.mjs";
import { readCoordinationState } from "../workflow/state.mjs";
import { initiativeDirectory, readWorkflowConfig } from "../workflow/workflow-config.mjs";

const LIBRARY_LIMIT = 500;
const SLICE_FILE_LIMIT = 200;
const UNRESOLVED = new Set(["OPEN", "IN PROGRESS", "REOPENED"]);
export const SECTION_REFS = Object.freeze(["roadmap", "requirements", "decisions", "glossary"]);

async function readText(root, relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
}

async function walk(root, relative, depth, accept, results, limit) {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
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

async function sliceArtifacts(root, directory, slug) {
  const folder = `${directory}/${slug}`;
  const files = [];
  await walk(root, folder, 3, () => true, files, SLICE_FILE_LIMIT);
  const reviewSource = files.includes(`${folder}/review.json`) ? await readText(root, `${folder}/review.json`) : null;
  let review = null;
  if (reviewSource !== null) {
    try {
      review = { path: `${folder}/review.json`, ...reviewSummary(JSON.parse(reviewSource)) };
    } catch {
      review = { path: `${folder}/review.json`, invalid: true };
    }
  }
  return {
    folder,
    files,
    narrative: files.includes(`${folder}/slice.md`) ? `${folder}/slice.md` : null,
    conceptDelta: files.includes(`${folder}/concept-delta.json`) ? `${folder}/concept-delta.json` : null,
    review
  };
}

async function initiativeFolders(root, config) {
  if (!config.paths.plans) return [];
  try {
    const entries = await readdir(path.join(root, config.paths.plans), { withFileTypes: true });
    const ids = [];
    for (const entry of entries) {
      if (entry.isDirectory() && SLUG_PATTERN.test(entry.name) && (await readText(root, `${config.paths.plans}/${entry.name}/initiative.json`)) !== null) ids.push(entry.name);
    }
    return ids.sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function initiativeFindings(root, config, id) {
  const directory = initiativeDirectory(config, id);
  const totals = { unresolved: 0, blocking: 0 };
  if (!directory) return totals;
  let entries = [];
  try {
    entries = await readdir(path.join(root, directory), { withFileTypes: true });
  } catch {
    return totals;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = await readText(root, `${directory}/${entry.name}/review.json`);
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

export async function loadRoadmapView(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  let roadmap;
  try {
    roadmap = await readRoadmap(projectRoot);
  } catch (error) {
    return { config: { paths: config.paths, diagnostics: config.diagnostics }, error: error.message, bands: DISPLAY_BANDS, items: [], unlisted: await initiativeFolders(projectRoot, config) };
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
    recordPath: resolved.recordPath,
    projectionPath: resolved.projectionPath,
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    revision: loaded.revision,
    serves: record?.serves ?? "",
    openQuestions: record?.openQuestions ?? [],
    bands: DISPLAY_BANDS,
    items,
    unlisted: (await initiativeFolders(projectRoot, config)).filter((id) => !listed.has(id))
  };
}

export async function loadInitiativeView(projectRoot, id) {
  if (!SLUG_PATTERN.test(id ?? "")) throw new Error("The initiative identifier is invalid.");
  const config = await readWorkflowConfig(projectRoot);
  const roadmap = await loadRoadmapView(projectRoot);
  const { resolved, loaded } = await readInitiative(projectRoot, id);
  let state = null;
  try {
    state = (await readCoordinationState({ projectRoot, statePath: `${resolved.directory}/state.json` })).state;
  } catch {
    state = null;
  }
  const slices = {};
  if (loaded.record?.slices) {
    for (const slug of Object.keys(loaded.record.slices)) slices[slug] = await sliceArtifacts(projectRoot, resolved.directory, slug);
  }
  const analysis = loaded.analysis;
  return {
    id,
    directory: resolved.directory,
    recordPath: resolved.recordPath,
    statePath: `${resolved.directory}/state.json`,
    roadmapItem: roadmap.items.find((item) => item.id === id) ?? null,
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    revision: loaded.revision,
    record: loaded.record,
    derived: analysis ? { root: analysis.root, children: analysis.children, leaves: analysis.leaves, counts: analysis.counts, effectiveDependencies: analysis.effectiveDependencies, complete: analysis.complete, designCandidates: analysis.designCandidates, dependenciesComplete: analysis.dependenciesComplete } : null,
    active: state?.active ?? [],
    slices,
    config: { paths: config.paths }
  };
}

export async function loadSliceView(projectRoot, id, slug) {
  const initiative = await loadInitiativeView(projectRoot, id);
  if (!initiative.record || !Object.hasOwn(initiative.record.slices, slug)) throw new Error(`The initiative ${id} has no slice ${slug}.`);
  const slice = initiative.record.slices[slug];
  const derived = initiative.derived;
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
    artifacts: initiative.slices[slug],
    titles: Object.fromEntries(Object.entries(initiative.record.slices).map(([key, value]) => [key, value.title]))
  };
}

async function initiativeReferences(projectRoot, config) {
  const references = new Map();
  for (const id of await initiativeFolders(projectRoot, config)) {
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

export async function loadLibrary(projectRoot, kind) {
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

export async function loadNavigation(projectRoot) {
  const roadmap = await loadRoadmapView(projectRoot);
  const glossary = await loadGlossary(projectRoot);
  return {
    roadmap: { exists: roadmap.exists ?? false, error: roadmap.error ?? null, valid: roadmap.valid ?? false },
    initiatives: [
      ...roadmap.items.map((item) => ({ id: item.id, title: item.title, band: item.band, state: item.state })),
      ...roadmap.unlisted.map((id) => ({ id, title: id, band: null, state: "unlisted" }))
    ],
    glossary: { path: glossary.path, exists: glossary.exists },
    diagnostics: roadmap.config.diagnostics
  };
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

export async function loadEntity(projectRoot, ref) {
  const parsed = parseEntityRef(ref);
  if (!parsed) throw new Error(`Unknown entity reference: ${ref}`);
  if (parsed.kind === "roadmap") return { ref, kind: "roadmap", data: await loadRoadmapView(projectRoot) };
  if (parsed.kind === "requirements" || parsed.kind === "decisions") return { ref, kind: parsed.kind, data: await loadLibrary(projectRoot, parsed.kind) };
  if (parsed.kind === "glossary") return { ref, kind: "glossary", data: await loadGlossary(projectRoot) };
  if (parsed.kind === "initiative") return { ref, kind: "initiative", data: await loadInitiativeView(projectRoot, parsed.id) };
  return { ref, kind: "slice", data: await loadSliceView(projectRoot, parsed.id, parsed.slug) };
}
