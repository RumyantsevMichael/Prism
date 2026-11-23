import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { artifactSources, checkTargets, listedArtifactType } from "./artifact-check.mjs";
import { linkedPaths } from "./artifact-status.mjs";
import { inArtifactStore } from "./record-store.mjs";
import { readStoreArtifact } from "./store-artifacts.mjs";

// Work that cites an artifact that breaks its format is refused, whole, with the state of its format migration, so that new work builds only on conforming artifacts.

export class ArtifactCitationError extends Error {
  declare code: any;
  declare artifacts: any;
  constructor(artifacts: any) {
    super(refusalMessage(artifacts));
    this.name = "ArtifactCitationError";
    this.code = "artifact_nonconforming";
    this.artifacts = artifacts;
  }
}

const storeOwn = (action: any) => action();
const labelOf = (scope: any) => scope === null || scope === undefined ? null : scope.label;
const named = (artifact: any) => labelOf(artifact.scope) === null ? artifact.path : `${artifact.path} in scope ${labelOf(artifact.scope)}`;

// One sentence on the state of an artifact's format migration, which never offers or asks for one.
function migrationSentence(artifact: any) {
  const migration = artifact.migration;
  if (!migration) return artifact.type === "feature"
    ? "Prism does not migrate feature files, so bring it into its format in a change of its own."
    : "Prism has not started its format migration yet.";
  switch (migration.status) {
    case "asking": return `Its format migration ${migration.run} waits for your answers on Attention.`;
    case "waiting-for-host": return `Its format migration ${migration.run} waits for an available host.`;
    case "failed": return `Its format migration ${migration.run} failed: ${migration.reason ?? "no reason was recorded."} Run it again from Attention.`;
    default: return `Prism is migrating it into its format in the run ${migration.run}.`;
  }
}

function refusalMessage(artifacts: any) {
  const lines = artifacts.map((artifact: any) => {
    const rules = [...new Set(artifact.findings.map((finding: any) => finding.rule))].join(", ");
    return `${named(artifact)} breaks ${rules}. ${migrationSentence(artifact)}`;
  });
  return `The update cites ${artifacts.length === 1 ? "an artifact that breaks its format" : "artifacts that break their formats"}, so nothing changed: ${lines.join(" ")}`;
}

// A slice document's text and, for a store artifact, its scope; a document that does not exist, or that two seen scopes hold, gives its links no scope.
async function sliceDocument(root: any, file: any) {
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
 * and `files` paths cited as they are, such as frozen feature files. A path that check_artifacts would not list as an artifact, such as a README.md, a diagram, or a file too deep below its folder, or that holds no file, cites nothing.
 * Only the cited paths are read from the store, so the check costs what the operation cites, not what the store holds.
 * Returns [{ path, scope, type, conforms, findings, migration }] as check_artifacts lists them, after the check started a run for each new set.
 */
export async function citedArtifacts(projectRoot: any, { references = [], documents = [], files = [] }: any = {}) {
  if (!references.length && !documents.length && !files.length) return [];
  const root = await realpath(projectRoot);
  // Each cited path with the scope its citation prefers, undefined for none, so the store reads only the cited paths.
  const cited = [];
  for (const reference of references as any[]) cited.push({ file: reference.split("#")[0], scope: undefined });
  for (const file of files) cited.push({ file, scope: undefined });
  for (const file of documents) {
    const document = await sliceDocument(root, file);
    if (document === null) continue;
    for (const linked of linkedPaths(document.text, file) ?? []) cited.push({ file: linked, scope: document.scope ?? null });
  }
  if (!cited.length) return [];
  // The store's own refusals, such as store_unavailable or repository_name_missing, refuse the operation as they are.
  const { locations, store, storeType } = await artifactSources(root, { refusing: storeOwn, paths: cited.map((entry) => entry.file) });
  const targets = new Map();
  const add = (target: any) => {
    const key = `${labelOf(target.scope) ?? ""}\0${target.path}`;
    if (!targets.has(key)) targets.set(key, target);
  };
  for (const { file, scope } of cited) {
    const type = listedArtifactType(locations, file);
    if (type === null) continue;
    if (store !== null && storeType(file) === type) {
      const copies = store.artifacts.filter((artifact: any) => artifact.path === file);
      const own = scope === undefined ? undefined : copies.find((artifact: any) => artifact.scope.label === labelOf(scope));
      const chosen = own ? [own] : copies;
      for (const artifact of chosen) add({ path: file, type, scope: artifact.scope, stored: artifact });
      continue;
    }
    const info = await stat(path.join(root, file)).catch(() => null);
    if (info?.isFile()) add({ path: file, type, scope: null });
  }
  return checkTargets(root, store, [...targets.values()], { refusing: storeOwn });
}

// A <type>.unknown finding breaks a cited artifact like any other, while an unknown value that is no finding, as in a Draft requirement file or a Proposed ADR, breaks nothing.
const citedBreak = (artifact: any) => !artifact.conforms || artifact.findings.length > 0;

/** The artifact_nonconforming refusal of the cited artifacts that break their formats, each with the state of its migration, or null when every one conforms. */
export function refuseNonconforming(artifacts: any) {
  const broken = artifacts.filter(citedBreak).map((artifact: any) => ({ path: artifact.path, scope: artifact.scope, type: artifact.type, findings: artifact.findings, migration: artifact.migration ?? null }));
  return broken.length ? new ArtifactCitationError(broken) : null;
}

/** Refuses an operation whose citations name an artifact that breaks its format, before it changes anything. */
export async function checkCitations(projectRoot: any, citations: any) {
  const refusal = refuseNonconforming(await citedArtifacts(projectRoot, citations));
  if (refusal) throw refusal;
}
