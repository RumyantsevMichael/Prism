import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { artifactSources, artifactTypeOf, checkTargets } from "./artifact-check.mjs";
import { linkedPaths } from "./artifact-status.mjs";
import { inArtifactStore } from "./record-store.mjs";
import { readStoreArtifact } from "./store-artifacts.mjs";

// Work that cites an artifact that breaks its format is refused, whole, so that a nonconforming artifact is migrated before new work builds on it.

export class ArtifactCitationError extends Error {
  constructor(artifacts) {
    super(refusalMessage(artifacts));
    this.name = "ArtifactCitationError";
    this.code = "artifact_nonconforming";
    this.artifacts = artifacts;
  }
}

const labelOf = (scope) => scope === null || scope === undefined ? null : scope.label;
const named = (artifact) => labelOf(artifact.scope) === null ? artifact.path : `${artifact.path} in scope ${labelOf(artifact.scope)}`;

function refusalMessage(artifacts) {
  const lines = artifacts.map((artifact) => {
    const rules = [...new Set(artifact.findings.map((finding) => finding.rule))].join(", ");
    return `${named(artifact)} breaks ${rules}${artifact.legacy ? ", and is marked legacy, which does not let work cite it" : ""}. Ask for a migration of ${named(artifact)} in a session of its own.`;
  });
  return `The update cites ${artifacts.length === 1 ? "an artifact that breaks its format" : "artifacts that break their formats"}, so nothing changed: ${lines.join(" ")}`;
}

// A slice document's text and, for a store artifact, its scope; a document that does not exist, or that two seen scopes hold, gives its links no scope.
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
  try { return { text: await readFile(path.join(root, file), "utf8"), scope: null }; }
  catch (error) { if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null; throw error; }
}

/**
 * The existing artifacts that an operation cites, by path and scope, resolved among the scopes the checkout sees and checked against their formats:
 * `references` are project-relative requirement references such as docs/requirements/retries.md#1, each citing every seen copy at its path,
 * `documents` slice.md paths whose Markdown links cite the copy in the document's scope, else the only seen copy, else every copy,
 * and `files` paths cited as they are, such as frozen feature files. A path that no artifact type covers or that holds no file cites nothing.
 * Returns [{ path, scope, type, conforms, findings, legacy }] as check_artifacts lists them, legacy its mark or null.
 */
export async function citedArtifacts(projectRoot, { references = [], documents = [], files = [] } = {}) {
  if (!references.length && !documents.length && !files.length) return [];
  const root = await realpath(projectRoot);
  const { locations, store, storeType } = await artifactSources(root);
  const targets = new Map();
  const add = (target) => {
    const key = `${labelOf(target.scope) ?? ""}\0${target.path}`;
    if (!targets.has(key)) targets.set(key, target);
  };
  const cite = async (file, scope) => {
    const type = artifactTypeOf(locations, file);
    if (type === null) return;
    if (store !== null && storeType(file) === type) {
      const copies = store.artifacts.filter((artifact) => artifact.path === file);
      const own = scope === undefined ? undefined : copies.find((artifact) => artifact.scope.label === labelOf(scope));
      const chosen = own ? [own] : copies;
      for (const artifact of chosen) add({ path: file, type, scope: artifact.scope, stored: artifact });
      return;
    }
    const info = await stat(path.join(root, file)).catch(() => null);
    if (info?.isFile()) add({ path: file, type, scope: null });
  };
  for (const reference of references) await cite(reference.split("#")[0]);
  for (const file of files) await cite(file);
  for (const file of documents) {
    const document = await sliceDocument(root, file);
    if (document === null) continue;
    for (const linked of linkedPaths(document.text, file) ?? []) await cite(linked, document.scope ?? null);
  }
  return checkTargets(root, store, [...targets.values()]);
}

/** The artifact_nonconforming refusal of the cited artifacts that break their formats, legacy or not, or null when every one conforms. */
export function refuseNonconforming(artifacts) {
  const broken = artifacts.filter((artifact) => !artifact.conforms).map((artifact) => ({ path: artifact.path, scope: artifact.scope, type: artifact.type, findings: artifact.findings, legacy: artifact.legacy !== null }));
  return broken.length ? new ArtifactCitationError(broken) : null;
}

/** Refuses an operation whose citations name an artifact that breaks its format, before it changes anything. */
export async function checkCitations(projectRoot, citations) {
  const refusal = refuseNonconforming(await citedArtifacts(projectRoot, citations));
  if (refusal) throw refusal;
}
