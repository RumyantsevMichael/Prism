// Generated from src/server/repository-intelligence/component-indexes.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentOf, listComponents, listsComponents, readComponents } from "../workflow/components.mjs";
import { NativeRepositoryIntelligence, RepositoryScan } from "./native-repository-intelligence.mjs";
import { semanticError } from "./native-semantic-runtime.mjs";
import { FUSION_OFFSET, fusionWeights } from "../../native-runtime/fusion.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const inside = (file, folder) => file === folder || file.startsWith(`${folder}/`);
async function indexComponents(projectRoot) {
  let config;
  try {
    config = await readWorkflowConfig(projectRoot);
  } catch {
    return null;
  }
  if (!listsComponents(config)) return null;
  return readComponents(config);
}
async function rootIdentity(projectRoot) {
  let repository = null;
  try {
    repository = listComponents(await readWorkflowConfig(projectRoot)).repository;
  } catch {
  }
  repository ??= "root";
  return `${repository}/${repository}`;
}
function componentSources(root, declaration, options = {}) {
  const scan = new RepositoryScan();
  return declaration.components.map((component) => ({
    component: component.identity,
    name: component.name,
    folder: component.folder,
    scan,
    source: new NativeRepositoryIntelligence(root, { ...options, scan, filter: (file) => componentOf(declaration, file).identity === component.identity })
  }));
}
async function verifyComponents(entries, verify = (source) => source.verifySnapshot()) {
  for (const scan of new Set(entries.map((entry) => entry.scan))) scan?.refresh();
  for (const entry of entries) await verify(entry.source);
}
async function baselineSources(declaration, open) {
  const sources = [];
  for (const component of declaration.components) sources.push({
    component: component.identity,
    name: component.name,
    folder: component.folder,
    source: await open((file) => componentOf(declaration, file).identity === component.identity)
  });
  return sources;
}
async function selectComponents(declaration, sources, paths = []) {
  const candidates = paths.length ? sources.filter((entry) => paths.some((item) => entry.folder === "" ? !declaration.declared.some((component) => inside(item, component.folder)) : inside(item, entry.folder) || inside(entry.folder, item))) : sources;
  const selected = [];
  for (const entry of candidates) {
    const { files } = await entry.source.snapshot();
    if (files.some((file) => !paths.length || paths.some((item) => inside(file.file, item)))) selected.push(entry);
  }
  return selected;
}
async function selectionSnapshot(selected) {
  const lines = [];
  for (const entry of selected) lines.push(`${entry.component} ${(await entry.source.snapshot()).sourceFingerprint}
`);
  return sha(lines.join(""));
}
async function prepareComponents(runtime, selected, waitMs, { siblings = [], ...options } = {}) {
  if (!selected.length) return [];
  const ordered = [...selected.filter((entry) => !siblings.includes(entry)), ...selected.filter((entry) => siblings.includes(entry))];
  const prepared = await runtime.prepareComponents(ordered.map((entry) => ({
    source: entry.source,
    component: { name: entry.name, identity: entry.component, folder: entry.folder },
    ...siblings.includes(entry) ? { structureOnly: true } : {}
  })), waitMs, options);
  const preparations = selected.map((entry) => prepared[ordered.indexOf(entry)]);
  return options.structure ? preparations.map(answeringPreparation) : preparations;
}
function answeringPreparation(preparation) {
  if (preparation.prepared || !preparation.structure || preparation.status === "ready") return preparation;
  return { ...preparation, status: "ready", prepared: preparation.structure };
}
function componentStates(selected, preparations) {
  return selected.map((entry, index) => {
    const preparation = preparations[index];
    const status = preparation.status === "ready" && preparation.prepared ? "included" : preparation.status === "degraded" ? "failed" : preparation.status === "waiting" ? "waiting" : "preparing";
    const failure = status !== "failed" ? null : preparation.failure ?? { code: preparation.diagnostics[0]?.code ?? "preparation_failed", message: preparation.diagnostics[0]?.message ?? "The component's preparation failed." };
    return {
      component: entry.component,
      folder: entry.folder,
      status,
      indexRevision: status === "included" ? preparation.prepared.revision : null,
      failure,
      ...status === "included" && preparation.prepared.stage === "structure" ? { embeddings: "pending" } : {},
      ...(status === "waiting" || status === "preparing") && preparation.waitingFor ? { waitingFor: preparation.waitingFor } : {}
    };
  });
}
function componentResult(components, snapshot) {
  const included = components.filter((entry) => entry.status === "included"), missing = components.filter((entry) => entry.status !== "included");
  const status = !missing.length ? "ready" : included.length ? "partial" : missing.some((entry) => entry.status !== "failed") ? "preparing" : "degraded";
  const named = missing.map((entry) => entry.status === "failed" ? `${entry.component} failed: ${entry.failure?.message}` : `${entry.component} is ${entry.status}`);
  const diagnostics = missing.length ? [{ code: "components_missing", message: `The result does not include every component it selected: ${named.join("; ")}.`, components: missing.map((entry) => entry.component) }] : [];
  const indexRevision = included.length ? sha(included.map((entry) => `${entry.component} ${entry.indexRevision}
`).join("")) : null;
  return { components, status, diagnostics, snapshot, indexRevision };
}
function componentDiagnostics(result, preparations) {
  return [...result.diagnostics, ...result.components.flatMap((state, index) => state.status === "failed" ? [] : preparations[index].diagnostics.map((item) => ({ ...item, component: state.component })))];
}
function unionIndex(included, snapshot, revision) {
  const indexes = included.map((entry) => entry.prepared.index), [first] = included.map((entry) => entry.prepared);
  const merge = (key) => indexes.some((index2) => index2[key]) ? Object.assign({}, ...indexes.map((index2) => index2[key] ?? {})) : void 0;
  const sum = (key) => indexes.reduce((total, index2) => total + (index2.counts[key] ?? 0), 0);
  const index = {
    schemaVersion: 1,
    chunkerVersion: first.index.chunkerVersion,
    modelIdentity: first.index.modelIdentity,
    snapshot,
    // Array sort is stable, so units of one file keep their index's order.
    units: indexes.flatMap((item) => item.units).sort((left, right) => left.file === right.file ? 0 : left.file < right.file ? -1 : 1),
    edges: indexes.flatMap((item) => item.edges),
    // An index built before the graph recorded library call names has none, and the union has none only when no component has them.
    unresolvedReferences: indexes.some((item) => item.unresolvedReferences) ? indexes.flatMap((item) => item.unresolvedReferences ?? []) : void 0,
    fileCoverage: Object.assign({}, ...indexes.map((item) => item.fileCoverage)),
    syntaxCoverage: merge("syntaxCoverage"),
    diagnostics: included.flatMap((entry) => entry.prepared.index.diagnostics.map((item) => ({ ...item, component: entry.component }))),
    counts: { files: sum("files"), units: sum("units"), fragments: sum("fragments"), searchExcludedFiles: sum("searchExcludedFiles"), reusedEmbeddings: sum("reusedEmbeddings"), newEmbeddings: sum("newEmbeddings") },
    structureComplete: indexes.every((item) => item.structureComplete),
    assetIdentity: first.index.assetIdentity,
    tokenCounts: merge("tokenCounts"),
    structureCounts: merge("structureCounts"),
    resources: { rssBytes: Math.max(...indexes.map((item) => item.resources.rssBytes)), peakRssBytes: Math.max(...indexes.map((item) => item.resources.peakRssBytes)) }
  };
  return { runtime: first.runtime, modelDirectory: first.modelDirectory, modelIdentity: first.modelIdentity, assetIdentity: first.assetIdentity, index, indexPath: "", revision };
}
async function unionSnapshot(sources, snapshot) {
  const snapshots = [];
  for (const source of sources) snapshots.push(await source.snapshot());
  const files = snapshots.flatMap((item) => item.files).sort((left, right) => left.file === right.file ? 0 : left.file < right.file ? -1 : 1);
  return {
    root: snapshots[0]?.root ?? "",
    sourceFingerprint: snapshot,
    commit: snapshots[0]?.commit ?? `snapshot:${snapshot}`,
    files,
    filesByPath: new Map(files.map((file) => [file.file, file])),
    complete: snapshots.every((item) => item.complete)
  };
}
async function searchComponents(included, limit, query = "") {
  const answers = [];
  for (const entry of included) answers.push(await entry.search());
  const lists = included.flatMap((entry, index) => answers[index] ? [answers[index].map((result) => ({ ...result, component: entry.component }))] : []);
  if (lists.length === 1) return { answers, results: lists[0].slice(0, limit) };
  const scored = (result) => result.cosineSimilarity != null || result.lexicalScore != null;
  const entries = [];
  const orphans = [];
  for (const list of lists) {
    let last;
    for (const result of list) {
      if (scored(result)) entries.push(last = { result, order: entries.length, followers: [], fused: 0 });
      else if (last) last.followers.push(result);
      else orphans.push(result);
    }
  }
  const byScore = (score) => (left, right) => score(right.result) - score(left.result);
  for (const list of lists) {
    const own = entries.filter((entry) => list.includes(entry.result) && entry.result.lexicalScore != null).sort(byScore((result) => result.lexicalScore));
    const top = own.length ? own[0].result.lexicalScore : 0;
    own.forEach((entry, place) => {
      entry.lexical = [place, top > 0 ? entry.result.lexicalScore / top : 0];
    });
  }
  const weights = fusionWeights(query);
  const vector = entries.filter((entry) => entry.result.cosineSimilarity != null).sort(byScore((result) => result.cosineSimilarity));
  vector.forEach((entry, rank) => {
    entry.fused += weights.cosineSimilarity / (FUSION_OFFSET + rank + 1);
  });
  const lexical = entries.filter((entry) => entry.lexical).sort((left, right) => left.lexical[0] - right.lexical[0] || right.lexical[1] - left.lexical[1]);
  lexical.forEach((entry, rank) => {
    entry.fused += weights.lexicalScore / (FUSION_OFFSET + rank + 1);
  });
  const term = query.trim();
  const exact = (result) => [result.file, result.name, result.qualifiedName, result.selector].includes(term) ? 1 : 0;
  const ranked = entries.sort((left, right) => exact(right.result) - exact(left.result) || right.fused - left.fused || left.order - right.order);
  const merged = [...ranked.flatMap((entry) => [entry.result, ...entry.followers]), ...orphans];
  return { answers, results: merged.slice(0, limit).map((result, index) => ({ ...result, fusedRank: index + 1 })) };
}
async function selectedComponents(projectRoot, declaration, paths, expectedSnapshot, baseline, { siblings: withSiblings = false } = {}) {
  const root = await realpath(projectRoot);
  const sources = baseline ? await baselineSources(declaration, baseline) : componentSources(root, declaration);
  const selected = await selectComponents(declaration, sources, paths);
  const siblings = withSiblings && paths?.length ? (await selectComponents(declaration, sources)).filter((entry) => !selected.includes(entry)) : [];
  const read = siblings.length ? sources.filter((entry) => selected.includes(entry) || siblings.includes(entry)) : selected;
  const snapshot = await selectionSnapshot(read);
  if (expectedSnapshot && expectedSnapshot !== snapshot) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
  return { root, sources, selected, siblings, read, snapshot };
}
async function baselineIndex(selected, preparations, result) {
  const included = result.components.flatMap((state, index2) => state.status === "included" ? [{ component: state.component, prepared: preparations[index2].prepared }] : []);
  const union = unionIndex(included, result.snapshot, result.indexRevision), index = union.index;
  const uncovered = {};
  for (const [position, state] of result.components.entries()) if (state.status !== "included") for (const file of (await selected[position].source.snapshot()).files) uncovered[file.file] = false;
  return { ...union, index: {
    ...index,
    fileCoverage: { ...index.fileCoverage, ...uncovered },
    ...index.syntaxCoverage ? { syntaxCoverage: { ...index.syntaxCoverage, ...uncovered } } : {},
    structureComplete: index.structureComplete && !Object.keys(uncovered).length,
    diagnostics: [...result.diagnostics, ...index.diagnostics]
  } };
}
export {
  answeringPreparation,
  baselineIndex,
  baselineSources,
  componentDiagnostics,
  componentResult,
  componentSources,
  componentStates,
  indexComponents,
  prepareComponents,
  rootIdentity,
  searchComponents,
  selectComponents,
  selectedComponents,
  selectionSnapshot,
  unionIndex,
  unionSnapshot,
  verifyComponents
};
