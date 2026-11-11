import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentOf, listsComponents, readComponents } from "../workflow/components.mjs";
import { NativeRepositoryIntelligence, RepositoryScan } from "./native-repository-intelligence.mjs";
import { semanticError } from "./native-semantic-runtime.mjs";
import { FUSION_OFFSET, fusionWeights } from "../../native-runtime/fusion.mjs";
import type { ComponentRuntime, ComponentState, Diagnostic, IndexMetadata, NativeSource, Preparation, PrepareOptions, PreparedIndex, SearchResult, SourceSnapshot } from "./repository-unit-types.mjs";

// A repository that declares components has one native index per component. Each component's source scans only that component's files,
// and a call prepares and reads only the components that hold the paths it names, or every component that holds a file; a scoped cross-file report
// also reads the sibling components beside them, which it prepares with structure only.

interface Component { name: string; identity: string; folder: string }
export interface Declaration { repository: string; root: Component; declared: Component[]; components: Component[] }
export interface ComponentSource { component: string; name: string; folder: string; source: NativeSource; scan?: RepositoryScan }
export interface ComponentResult { components: ComponentState[]; status: "ready" | "partial" | "preparing" | "degraded"; diagnostics: Diagnostic[]; snapshot: string; indexRevision: string | null }

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);

/** The project's declared components, or null when its configuration lists none or cannot be read; an invalid declaration throws its ComponentError. */
export async function indexComponents(projectRoot: string): Promise<Declaration | null> {
  let config;
  try { config = await readWorkflowConfig(projectRoot); } catch { return null; }
  if (!listsComponents(config)) return null;
  return readComponents(config) as Declaration;
}

/** One source per component in component order: the root component first, then the declared components in declaration order. */
// The sources share one Git listing of the repository, so a call over many components lists the repository once; verifyComponents lists it again.
export function componentSources(root: string, declaration: Declaration, options: Record<string, unknown> = {}): ComponentSource[] {
  const scan = new RepositoryScan();
  return declaration.components.map(component => ({ component: component.identity, name: component.name, folder: component.folder, scan,
    source: new NativeRepositoryIntelligence(root, { ...options, scan, filter: (file: string) => componentOf(declaration, file).identity === component.identity }) as unknown as NativeSource }));
}

/** Verifies that each component's files are unchanged since its snapshot, listing the repository once for all of them. */
export async function verifyComponents(entries: ComponentSource[], verify: (source: NativeSource) => Promise<unknown> = source => source.verifySnapshot()) {
  for (const scan of new Set(entries.map(entry => entry.scan))) scan?.refresh();
  for (const entry of entries) await verify(entry.source);
}

/** Opens a source of the files that a filter accepts, such as a retained baseline's files of one component. */
export type OpenSource = (filter: (file: string) => boolean) => Promise<NativeSource>;

/** One source per component of a retained baseline, splitting its source files by the current declaration, in component order. */
export async function baselineSources(declaration: Declaration, open: OpenSource): Promise<ComponentSource[]> {
  const sources = [];
  for (const component of declaration.components) sources.push({ component: component.identity, name: component.name, folder: component.folder,
    source: await open((file: string) => componentOf(declaration, file).identity === component.identity) });
  return sources;
}

/** The components that hold a scanned file equal to or inside one of the paths, or every component that holds a scanned file when no path is given. */
export async function selectComponents(declaration: Declaration, sources: ComponentSource[], paths: string[] = []): Promise<ComponentSource[]> {
  // A declared component can hold such a file only when its folder and a path contain one another, and the root component only for a path outside every declared folder.
  const candidates = paths.length ? sources.filter(entry => paths.some(item => entry.folder === ""
    ? !declaration.declared.some(component => inside(item, component.folder)) : inside(item, entry.folder) || inside(entry.folder, item))) : sources;
  const selected = [];
  for (const entry of candidates) {
    const { files } = await entry.source.snapshot();
    if (files.some(file => !paths.length || paths.some(item => inside(file.file, item)))) selected.push(entry);
  }
  return selected;
}

/** The SHA-256 of the lines `<identity> <content fingerprint>\n` of the selected components in component order. */
export async function selectionSnapshot(selected: ComponentSource[]) {
  const lines = [];
  for (const entry of selected) lines.push(`${entry.component} ${(await entry.source.snapshot()).sourceFingerprint}\n`);
  return sha(lines.join(""));
}

/**
 * Queues the selected components that are missing or out of date, waits at most the call's bound for them, and returns each one's preparation.
 * With `structure`, a component whose build published its structure answers from that structure-only index, as answeringPreparation describes.
 * Each of `siblings` is prepared with structure only and queued after the other components, while the preparations keep the order of `selected`.
 */
export async function prepareComponents(runtime: ComponentRuntime, selected: ComponentSource[], waitMs?: number, { siblings = [], ...options }: PrepareOptions & { siblings?: ComponentSource[] } = {}): Promise<Preparation[]> {
  if (!selected.length) return [];
  const ordered = [...selected.filter(entry => !siblings.includes(entry)), ...selected.filter(entry => siblings.includes(entry))];
  const prepared = await runtime.prepareComponents(ordered.map(entry => ({ source: entry.source, component: { name: entry.name, identity: entry.component, folder: entry.folder },
    ...(siblings.includes(entry) ? { structureOnly: true } : {}) })), waitMs, options);
  const preparations = selected.map(entry => prepared[ordered.indexOf(entry)]);
  return options.structure ? preparations.map(answeringPreparation) : preparations;
}

/**
 * A preparation without a complete index that waits, prepares, or failed after its build published a structure, as a ready preparation of that
 * structure-only index, which stays stored after a failure such as a native limit; any other preparation as it is.
 */
export function answeringPreparation(preparation: Preparation): Preparation {
  if (preparation.prepared || !preparation.structure || preparation.status === "ready") return preparation;
  return { ...preparation, status: "ready", prepared: preparation.structure };
}

/**
 * How each selected component took part: included when its up-to-date index is ready, otherwise waiting, preparing, or failed.
 * A component included from a structure-only index carries `embeddings: "pending"`, and no other component carries `embeddings`.
 */
export function componentStates(selected: ComponentSource[], preparations: Preparation[]): ComponentState[] {
  return selected.map((entry, index) => {
    const preparation = preparations[index];
    const status = preparation.status === "ready" && preparation.prepared ? "included" : preparation.status === "degraded" ? "failed" : preparation.status === "waiting" ? "waiting" : "preparing";
    const failure = status !== "failed" ? null : preparation.failure ?? { code: preparation.diagnostics[0]?.code ?? "preparation_failed", message: preparation.diagnostics[0]?.message ?? "The component's preparation failed." };
    return { component: entry.component, folder: entry.folder, status, indexRevision: status === "included" ? preparation.prepared!.revision : null, failure,
      ...(status === "included" && preparation.prepared!.stage === "structure" ? { embeddings: "pending" as const } : {}) };
  });
}

/** The fields that every result in a repository with components holds, from the states of its selected components and the selection's snapshot. */
export function componentResult(components: ComponentState[], snapshot: string): ComponentResult {
  const included = components.filter(entry => entry.status === "included"), missing = components.filter(entry => entry.status !== "included");
  const status = !missing.length ? "ready" : included.length ? "partial" : missing.some(entry => entry.status !== "failed") ? "preparing" : "degraded";
  const named = missing.map(entry => entry.status === "failed" ? `${entry.component} failed: ${entry.failure?.message}` : `${entry.component} is ${entry.status}`);
  const diagnostics = missing.length ? [{ code: "components_missing", message: `The result does not include every component it selected: ${named.join("; ")}.`, components: missing.map(entry => entry.component) }] : [];
  const indexRevision = included.length ? sha(included.map(entry => `${entry.component} ${entry.indexRevision}\n`).join("")) : null;
  return { components, status, diagnostics, snapshot, indexRevision };
}

/** The diagnostics of a result: the components_missing diagnostic first, then each selected component's own diagnostics, except a failed one's, whose failure that diagnostic names. */
export function componentDiagnostics(result: ComponentResult, preparations: Preparation[]): Diagnostic[] {
  return [...result.diagnostics, ...result.components.flatMap((state, index) => state.status === "failed" ? [] : preparations[index].diagnostics.map(item => ({ ...item, component: state.component })))];
}

/**
 * One index over the included components, as if one index held their units, edges, references, coverage, and diagnostics, so the structural reports
 * and graph expansion run over their union. Unit identifiers never repeat between component indexes, so the union needs no renaming; units keep
 * one index's file order, and the union's structure is complete only when every component's structure is. The union is never searched itself:
 * a semantic search asks each component's index and merges the answers.
 */
export function unionIndex(included: { component: string; prepared: PreparedIndex }[], snapshot: string, revision: string): PreparedIndex {
  const indexes = included.map(entry => entry.prepared.index), [first] = included.map(entry => entry.prepared);
  const merge = (key: "syntaxCoverage" | "tokenCounts" | "structureCounts") => indexes.some(index => index[key]) ? Object.assign({}, ...indexes.map(index => index[key] ?? {})) : undefined;
  const sum = (key: keyof IndexMetadata["counts"]) => indexes.reduce((total, index) => total + (index.counts[key] ?? 0), 0);
  const index: IndexMetadata = {
    schemaVersion: 1, chunkerVersion: first.index.chunkerVersion, modelIdentity: first.index.modelIdentity, snapshot,
    // Array sort is stable, so units of one file keep their index's order.
    units: indexes.flatMap(item => item.units).sort((left, right) => left.file === right.file ? 0 : left.file < right.file ? -1 : 1),
    edges: indexes.flatMap(item => item.edges),
    // An index built before the graph recorded library call names has none, and the union has none only when no component has them.
    unresolvedReferences: indexes.some(item => item.unresolvedReferences) ? indexes.flatMap(item => item.unresolvedReferences ?? []) : undefined,
    fileCoverage: Object.assign({}, ...indexes.map(item => item.fileCoverage)), syntaxCoverage: merge("syntaxCoverage"),
    diagnostics: included.flatMap(entry => entry.prepared.index.diagnostics.map(item => ({ ...item, component: entry.component }))),
    counts: { files: sum("files"), units: sum("units"), fragments: sum("fragments"), searchExcludedFiles: sum("searchExcludedFiles"), reusedEmbeddings: sum("reusedEmbeddings"), newEmbeddings: sum("newEmbeddings") },
    structureComplete: indexes.every(item => item.structureComplete), assetIdentity: first.index.assetIdentity, tokenCounts: merge("tokenCounts"), structureCounts: merge("structureCounts"),
    resources: { rssBytes: Math.max(...indexes.map(item => item.resources.rssBytes)), peakRssBytes: Math.max(...indexes.map(item => item.resources.peakRssBytes)) }
  };
  return { runtime: first.runtime, modelDirectory: first.modelDirectory, modelIdentity: first.modelIdentity, assetIdentity: first.assetIdentity, index, indexPath: "", revision };
}

/** The source files of the given components as one snapshot in path order, identified by the selection's snapshot. */
export async function unionSnapshot(sources: NativeSource[], snapshot: string): Promise<SourceSnapshot> {
  const snapshots = [];
  for (const source of sources) snapshots.push(await source.snapshot());
  const files = snapshots.flatMap(item => item.files).sort((left, right) => left.file === right.file ? 0 : left.file < right.file ? -1 : 1);
  return { root: snapshots[0]?.root ?? "", sourceFingerprint: snapshot, commit: snapshots[0]?.commit ?? `snapshot:${snapshot}`, files,
    filesByPath: new Map(files.map(file => [file.file, file])), complete: snapshots.every(item => item.complete) };
}

/** A component's search: null when its index did not answer, so it adds no result. */
export interface ComponentSearch { component: string; search(): Promise<SearchResult[] | null> }

/**
 * Searches each included component in component order and returns each one's answer and the results, each naming its component.
 * One component that answers keeps its index's order. Several rank together by reciprocal rank fusion, because only cosine similarity compares across indexes:
 * a result's vector rank is its place among every result with a cosineSimilarity, from highest to lowest, ties in component order and then in index order;
 * its lexical rank is its place among every result with a lexicalScore, by its lexical place inside its own index, then by its score's share of that index's
 * highest score, then in component order. Its fused score adds `w / (60 + lexical rank)` and `1 / (60 + vector rank)` for the ranks it has, with the weights
 * that rank one index. Results whose file, name, qualified name, or selector equals the trimmed query come first, then the rest by fused score, ties in
 * component order and then in index order. A result with neither score, such as a container that its index placed after its best member, stays directly
 * after the result it follows in its index; one that follows no such result comes after every other result. The merged list keeps the first `limit`
 * and numbers fusedRank from 1, while each result keeps the other scores its index computed.
 */
export async function searchComponents(included: ComponentSearch[], limit: number, query = "") {
  const answers: (SearchResult[] | null)[] = [];
  for (const entry of included) answers.push(await entry.search());
  const lists = included.flatMap((entry, index) => answers[index] ? [answers[index]!.map(result => ({ ...result, component: entry.component }))] : []);
  if (lists.length === 1) return { answers, results: lists[0].slice(0, limit) };
  type Result = typeof lists[number][number];
  const scored = (result: Result) => result.cosineSimilarity != null || result.lexicalScore != null;
  // Each scored result in component order, then index order, with the unscored results that follow it in its index.
  const entries: { result: Result; order: number; followers: Result[]; lexical?: [number, number]; fused: number }[] = [];
  const orphans: Result[] = [];
  for (const list of lists) {
    let last: typeof entries[number] | undefined;
    for (const result of list) {
      if (scored(result)) entries.push(last = { result, order: entries.length, followers: [], fused: 0 });
      else if (last) last.followers.push(result);
      else orphans.push(result);
    }
  }
  const byScore = (score: (result: Result) => number) => (left: typeof entries[number], right: typeof entries[number]) => score(right.result) - score(left.result);
  // Lexical places inside each index: by score from highest to lowest, ties in index order, with each score's share of that index's highest score.
  for (const list of lists) {
    const own = entries.filter(entry => list.includes(entry.result) && entry.result.lexicalScore != null).sort(byScore(result => result.lexicalScore!));
    const top = own.length ? own[0].result.lexicalScore! : 0;
    own.forEach((entry, place) => { entry.lexical = [place, top > 0 ? entry.result.lexicalScore! / top : 0]; });
  }
  const weights = fusionWeights(query);
  // Array sort is stable, so equal keys keep the order of the concatenation: component order, then each index's order.
  const vector = entries.filter(entry => entry.result.cosineSimilarity != null).sort(byScore(result => result.cosineSimilarity!));
  vector.forEach((entry, rank) => { entry.fused += weights.cosineSimilarity / (FUSION_OFFSET + rank + 1); });
  const lexical = entries.filter(entry => entry.lexical).sort((left, right) => left.lexical![0] - right.lexical![0] || right.lexical![1] - left.lexical![1]);
  lexical.forEach((entry, rank) => { entry.fused += weights.lexicalScore / (FUSION_OFFSET + rank + 1); });
  const term = query.trim();
  const exact = (result: Result) => [result.file, result.name, result.qualifiedName, result.selector].includes(term) ? 1 : 0;
  const ranked = entries.sort((left, right) => exact(right.result) - exact(left.result) || right.fused - left.fused || left.order - right.order);
  const merged = [...ranked.flatMap(entry => [entry.result, ...entry.followers]), ...orphans];
  return { answers, results: merged.slice(0, limit).map((result, index) => ({ ...result, fusedRank: index + 1 })) };
}

/**
 * Reads the declaration and the selected components of a call, of the live project or, with `baseline`, of a retained baseline split into components,
 * and refuses an expected snapshot that differs from the selection's snapshot. `sources` holds every component's source, selected or not.
 * With `siblings` and paths, `siblings` holds every other component that holds a file, `read` holds the selected and sibling components in component
 * order, and the snapshot is `read`'s; otherwise `siblings` is empty and `read` is the selection.
 */
export async function selectedComponents(projectRoot: string, declaration: Declaration, paths: string[] | undefined, expectedSnapshot?: string, baseline?: OpenSource, { siblings: withSiblings = false } = {}) {
  const root = await realpath(projectRoot);
  const sources = baseline ? await baselineSources(declaration, baseline) : componentSources(root, declaration);
  const selected = await selectComponents(declaration, sources, paths);
  const siblings = withSiblings && paths?.length ? (await selectComponents(declaration, sources)).filter(entry => !selected.includes(entry)) : [];
  const read = siblings.length ? sources.filter(entry => selected.includes(entry) || siblings.includes(entry)) : selected;
  const snapshot = await selectionSnapshot(read);
  if (expectedSnapshot && expectedSnapshot !== snapshot) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
  return { root, sources, selected, siblings, read, snapshot };
}

/**
 * The analysis index of a retained baseline: the union of its included components' indexes, in which each file of a failed component is held
 * without units and as not covered, and whose diagnostics start with the components_missing diagnostic that names each failed component.
 * Call it only when no selected component is waiting or preparing and at least one is included.
 */
export async function baselineIndex(selected: ComponentSource[], preparations: Preparation[], result: ComponentResult): Promise<PreparedIndex> {
  const included = result.components.flatMap((state, index) => state.status === "included" ? [{ component: state.component, prepared: preparations[index].prepared! }] : []);
  const union = unionIndex(included, result.snapshot, result.indexRevision!), index = union.index;
  const uncovered: Record<string, boolean> = {};
  for (const [position, state] of result.components.entries()) if (state.status !== "included") for (const file of (await selected[position].source.snapshot()).files) uncovered[file.file] = false;
  return { ...union, index: { ...index, fileCoverage: { ...index.fileCoverage, ...uncovered }, ...(index.syntaxCoverage ? { syntaxCoverage: { ...index.syntaxCoverage, ...uncovered } } : {}),
    structureComplete: index.structureComplete && !Object.keys(uncovered).length, diagnostics: [...result.diagnostics, ...index.diagnostics] } };
}
