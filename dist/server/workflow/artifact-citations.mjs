// Generated from src/server/workflow/artifact-citations.mts by scripts/native-build/compile.mjs.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { artifactSources, checkTargets, listedArtifactType } from "./artifact-check.mjs";
import { linkedPaths } from "./artifact-status.mjs";
import { inArtifactStore } from "./record-store.mjs";
import { readStoreArtifact } from "./store-artifacts.mjs";
class ArtifactCitationError extends Error {
  constructor(artifacts) {
    super(refusalMessage(artifacts));
    this.name = "ArtifactCitationError";
    this.code = "artifact_nonconforming";
    this.artifacts = artifacts;
  }
}
const storeOwn = (action) => action();
const labelOf = (scope) => scope === null || scope === void 0 ? null : scope.label;
const named = (artifact) => labelOf(artifact.scope) === null ? artifact.path : `${artifact.path} in scope ${labelOf(artifact.scope)}`;
function migrationSentence(artifact) {
  const migration = artifact.migration;
  if (!migration) return artifact.type === "feature" ? "Prism does not migrate feature files, so bring it into its format in a change of its own." : "Prism has not started its format migration yet.";
  switch (migration.status) {
    case "asking":
      return `Its format migration ${migration.run} waits for your answers on Attention.`;
    case "waiting-for-host":
      return `Its format migration ${migration.run} waits for an available host.`;
    case "failed":
      return `Its format migration ${migration.run} failed: ${migration.reason ?? "no reason was recorded."} Run it again from Attention.`;
    default:
      return `Prism is migrating it into its format in the run ${migration.run}.`;
  }
}
function refusalMessage(artifacts) {
  const lines = artifacts.map((artifact) => {
    const rules = [...new Set(artifact.findings.map((finding) => finding.rule))].join(", ");
    return `${named(artifact)} breaks ${rules}. ${migrationSentence(artifact)}`;
  });
  return `The update cites ${artifacts.length === 1 ? "an artifact that breaks its format" : "artifacts that break their formats"}, so nothing changed: ${lines.join(" ")}`;
}
async function sliceDocument(root, file) {
  if (await inArtifactStore(root, file)) {
    try {
      const held = await readStoreArtifact(root, file);
      return held === null ? null : { text: Buffer.from(held.bytes ?? []).toString("utf8"), scope: held.scope };
    } catch (error) {
      if (error?.code === "artifact_ambiguous") return null;
      throw error;
    }
  }
  try {
    return { text: await readFile(path.join(root, file), "utf8"), scope: null };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
}
async function citedArtifacts(projectRoot, { references = [], documents = [], files = [] } = {}) {
  if (!references.length && !documents.length && !files.length) return [];
  const root = await realpath(projectRoot);
  const cited = [];
  for (const reference of references) cited.push({ file: reference.split("#")[0], scope: void 0 });
  for (const file of files) cited.push({ file, scope: void 0 });
  for (const file of documents) {
    const document = await sliceDocument(root, file);
    if (document === null) continue;
    for (const linked of linkedPaths(document.text, file) ?? []) cited.push({ file: linked, scope: document.scope ?? null });
  }
  if (!cited.length) return [];
  const { locations, store, storeType } = await artifactSources(root, { refusing: storeOwn, paths: cited.map((entry) => entry.file) });
  const targets = /* @__PURE__ */ new Map();
  const add = (target) => {
    const key = `${labelOf(target.scope) ?? ""}\0${target.path}`;
    if (!targets.has(key)) targets.set(key, target);
  };
  for (const { file, scope } of cited) {
    const type = listedArtifactType(locations, file);
    if (type === null) continue;
    if (store !== null && storeType(file) === type) {
      const copies = store.artifacts.filter((artifact) => artifact.path === file);
      const own = scope === void 0 ? void 0 : copies.find((artifact) => artifact.scope.label === labelOf(scope));
      const chosen = own ? [own] : copies;
      for (const artifact of chosen) add({ path: file, type, scope: artifact.scope, stored: artifact });
      continue;
    }
    const info = await stat(path.join(root, file)).catch(() => null);
    if (info?.isFile()) add({ path: file, type, scope: null });
  }
  return checkTargets(root, store, [...targets.values()], { refusing: storeOwn });
}
const citedBreak = (artifact) => !artifact.conforms || artifact.findings.length > 0;
function refuseNonconforming(artifacts) {
  const broken = artifacts.filter(citedBreak).map((artifact) => ({ path: artifact.path, scope: artifact.scope, type: artifact.type, findings: artifact.findings, migration: artifact.migration ?? null }));
  return broken.length ? new ArtifactCitationError(broken) : null;
}
async function checkCitations(projectRoot, citations) {
  const refusal = refuseNonconforming(await citedArtifacts(projectRoot, citations));
  if (refusal) throw refusal;
}
export {
  ArtifactCitationError,
  checkCitations,
  citedArtifacts,
  refuseNonconforming
};
