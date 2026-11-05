// Generated from src/server/repository-intelligence/component-indexes.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentOf, listsComponents, readComponents } from "../workflow/components.mjs";
import { NativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";
import { semanticError } from "./native-semantic-runtime.mjs";
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
function componentSources(root, declaration, options = {}) {
  return declaration.components.map((component) => ({
    component: component.identity,
    name: component.name,
    folder: component.folder,
    source: new NativeRepositoryIntelligence(root, { ...options, filter: (file) => componentOf(declaration, file).identity === component.identity })
  }));
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
function prepareComponents(runtime, selected, waitMs) {
  if (!selected.length) return Promise.resolve([]);
  return runtime.prepareComponents(selected.map((entry) => ({ source: entry.source, component: { name: entry.name, identity: entry.component, folder: entry.folder } })), waitMs);
}
function componentStates(selected, preparations) {
  return selected.map((entry, index) => {
    const preparation = preparations[index];
    const status = preparation.status === "ready" && preparation.prepared ? "included" : preparation.status === "degraded" ? "failed" : preparation.status === "waiting" ? "waiting" : "preparing";
    const failure = status !== "failed" ? null : preparation.failure ?? { code: preparation.diagnostics[0]?.code ?? "preparation_failed", message: preparation.diagnostics[0]?.message ?? "The component's preparation failed." };
    return { component: entry.component, folder: entry.folder, status, indexRevision: status === "included" ? preparation.prepared.revision : null, failure };
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
async function searchComponents(included, limit) {
  const answers = [];
  for (const entry of included) answers.push(await entry.search());
  const lists = included.flatMap((entry, index) => answers[index] ? [answers[index].map((result) => ({ ...result, component: entry.component }))] : []);
  if (lists.length === 1) return { answers, results: lists[0].slice(0, limit) };
  const keyed = lists.flatMap((list) => {
    let previous = -Infinity;
    return list.map((result) => ({ result, key: previous = result.cosineSimilarity ?? previous }));
  });
  const merged = keyed.sort((left, right) => left.key === right.key ? 0 : right.key > left.key ? 1 : -1);
  return { answers, results: merged.slice(0, limit).map(({ result }, index) => ({ ...result, fusedRank: index + 1 })) };
}
async function selectedComponents(projectRoot, declaration, paths, expectedSnapshot) {
  const root = await realpath(projectRoot);
  const selected = await selectComponents(declaration, componentSources(root, declaration), paths);
  const snapshot = await selectionSnapshot(selected);
  if (expectedSnapshot && expectedSnapshot !== snapshot) throw semanticError("stale_snapshot", "The expected repository snapshot has changed. Repeat the reuse search.");
  return { root, selected, snapshot };
}
export {
  componentResult,
  componentSources,
  componentStates,
  indexComponents,
  prepareComponents,
  searchComponents,
  selectComponents,
  selectedComponents,
  selectionSnapshot
};
