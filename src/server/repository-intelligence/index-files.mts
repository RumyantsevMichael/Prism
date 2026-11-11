import path from "node:path";
import { createHash } from "node:crypto";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes, semanticError } from "./native-files.mjs";
import type { IndexMetadata, PublishedUnits, UnitIndex } from "./repository-unit-types.mjs";

// Reading, checking, and writing stored index files. An index of a large component holds a vector per fragment and can be hundreds of
// megabytes of JSON, so these run in the index store's thread, away from the event loop that answers pages and agents.

export const INDEX_BYTES = 512 * 1024 * 1024;
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const unitsFile = (revision: string) => `units-${revision}.json`;
export const indexMetadata = ({ chunks: _chunks, ...metadata }: UnitIndex): IndexMetadata => metadata;

// The units sidecar holds only what a viewer needs to locate code, so the review browser can read it without the full index and its embeddings.
export function publishedUnits(index: IndexMetadata, revision: string): PublishedUnits {
  const edges = new Map<string, [string, string]>();
  for (const edge of index.edges) if (edge.kind === "calls" || edge.kind === "references") edges.set(`${edge.source}\0${edge.target}`, [edge.source, edge.target]);
  return { schemaVersion: 1, snapshot: index.snapshot, revision,
    units: index.units.map(({ id, file, kind, name, qualifiedName, range, sourceHash }) => ({ id, file, kind, name, ...(qualifiedName === undefined ? {} : { qualifiedName }),
      range: { startLine: range.startLine, endLine: range.endLine }, ...(sourceHash === undefined ? {} : { sourceHash }) })),
    edges: [...edges.values()] };
}

/** The stored index of a revision, after its bytes match the revision. */
export async function readIndex(indexPath: string, revision: string): Promise<UnitIndex> {
  const bytes = await regularBytes(indexPath, INDEX_BYTES);
  if (sha(bytes) !== revision) throw semanticError("corrupt_asset", "The semantic index failed its integrity check.");
  return JSON.parse(bytes.toString("utf8")) as UnitIndex;
}

/** The embeddings of a stored index by embedding key, which a new build of changed content reuses. */
export function storedEmbeddings(index: UnitIndex): Record<string, number[]> {
  return Object.fromEntries(index.chunks.filter(chunk => chunk.embeddingKey && chunk.embedding).map(chunk => [chunk.embeddingKey!, chunk.embedding!]));
}

/** Writes an index under its content revision with its units sidecar, and returns the revision. */
export async function writeIndex(directory: string, index: UnitIndex) {
  const contents = JSON.stringify(index), revision = sha(contents), indexPath = path.join(directory, `${revision}.json`);
  if (Buffer.byteLength(contents) > INDEX_BYTES) throw semanticError("resource_limit", "The semantic index exceeds 512 MiB.");
  await writeAtomically(indexPath, contents, { mode: 0o600 });
  await writeAtomically(path.join(directory, unitsFile(revision)), JSON.stringify(publishedUnits(index, revision)), { mode: 0o600 });
  return { revision, indexPath, bytes: Buffer.byteLength(contents) };
}
