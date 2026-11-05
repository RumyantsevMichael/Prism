import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentOf, listsComponents, readComponents } from "../workflow/components.mjs";
import { NativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";
import { semanticError } from "./native-semantic-runtime.mjs";
import type { ComponentRuntime, ComponentState, Diagnostic, NativeSource, Preparation, SearchResult } from "./repository-unit-types.mjs";

// A repository that declares components has one native index per component. Each component's source scans only that component's files,
// and a call prepares and reads only the components that hold the paths it names, or every component that holds a file.

interface Component { name: string; identity: string; folder: string }
export interface Declaration { repository: string; root: Component; declared: Component[]; components: Component[] }
export interface ComponentSource { component: string; name: string; folder: string; source: NativeSource }
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
export function componentSources(root: string, declaration: Declaration, options: Record<string, unknown> = {}): ComponentSource[] {
  return declaration.components.map(component => ({ component: component.identity, name: component.name, folder: component.folder,
    source: new NativeRepositoryIntelligence(root, { ...options, filter: (file: string) => componentOf(declaration, file).identity === component.identity }) as unknown as NativeSource }));
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

/** Queues the selected components that are missing or out of date, waits at most the call's bound for them, and returns each one's preparation. */
export function prepareComponents(runtime: ComponentRuntime, selected: ComponentSource[], waitMs?: number): Promise<Preparation[]> {
  if (!selected.length) return Promise.resolve([]);
  return runtime.prepareComponents(selected.map(entry => ({ source: entry.source, component: { name: entry.name, identity: entry.component, folder: entry.folder } })), waitMs);
}

/** How each selected component took part: included when its up-to-date index is ready, otherwise waiting, preparing, or failed. */
export function componentStates(selected: ComponentSource[], preparations: Preparation[]): ComponentState[] {
  return selected.map((entry, index) => {
    const preparation = preparations[index];
    const status = preparation.status === "ready" && preparation.prepared ? "included" : preparation.status === "degraded" ? "failed" : preparation.status === "waiting" ? "waiting" : "preparing";
    const failure = status !== "failed" ? null : preparation.failure ?? { code: preparation.diagnostics[0]?.code ?? "preparation_failed", message: preparation.diagnostics[0]?.message ?? "The component's preparation failed." };
    return { component: entry.component, folder: entry.folder, status, indexRevision: status === "included" ? preparation.prepared!.revision : null, failure };
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

/** A component's search: null when its index did not answer, so it adds no result. */
export interface ComponentSearch { component: string; search(): Promise<SearchResult[] | null> }

/**
 * Searches each included component in component order and returns each one's answer and the results, each naming its component.
 * One component that answers keeps its index's order. Several merge by cosineSimilarity from highest to lowest, with ties in component order and
 * then in each index's order. A result without a similarity, such as a container that its index placed after its best member, sorts by the
 * similarity of the result it follows in its index, so it stays directly after that result; one that follows no such result comes after every
 * result that has one. The merged list keeps the first `limit` and numbers fusedRank from 1, while each result keeps the other scores its index computed.
 */
export async function searchComponents(included: ComponentSearch[], limit: number) {
  const answers: (SearchResult[] | null)[] = [];
  for (const entry of included) answers.push(await entry.search());
  const lists = included.flatMap((entry, index) => answers[index] ? [answers[index]!.map(result => ({ ...result, component: entry.component }))] : []);
  if (lists.length === 1) return { answers, results: lists[0].slice(0, limit) };
  const keyed = lists.flatMap(list => {
    let previous = -Infinity;
    return list.map(result => ({ result, key: previous = result.cosineSimilarity ?? previous }));
  });
  // Array sort is stable, so equal keys keep the order of the concatenation: component order, then each index's order.
  const merged = keyed.sort((left, right) => left.key === right.key ? 0 : right.key > left.key ? 1 : -1);
  return { answers, results: merged.slice(0, limit).map(({ result }, index) => ({ ...result, fusedRank: index + 1 })) };
}

/** Reads the declaration and the selected components of a call, and refuses an expected snapshot that differs from the selection's snapshot. */
export async function selectedComponents(projectRoot: string, declaration: Declaration, paths: string[] | undefined, expectedSnapshot?: string) {
  const root = await realpath(projectRoot);
  const selected = await selectComponents(declaration, componentSources(root, declaration), paths);
  const snapshot = await selectionSnapshot(selected);
  if (expectedSnapshot && expectedSnapshot !== snapshot) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
  return { root, selected, snapshot };
}
