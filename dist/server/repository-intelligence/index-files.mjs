// Generated from src/server/repository-intelligence/index-files.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes, semanticError } from "./native-files.mjs";
const INDEX_BYTES = 512 * 1024 * 1024;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const unitsFile = (revision) => `units-${revision}.json`;
const indexMetadata = ({ chunks: _chunks, ...metadata }) => metadata;
function publishedUnits(index, revision) {
  const edges = /* @__PURE__ */ new Map();
  for (const edge of index.edges) if (edge.kind === "calls" || edge.kind === "references") edges.set(`${edge.source}\0${edge.target}`, [edge.source, edge.target]);
  return {
    schemaVersion: 1,
    snapshot: index.snapshot,
    revision,
    units: index.units.map(({ id, file, kind, name, qualifiedName, range, sourceHash }) => ({
      id,
      file,
      kind,
      name,
      ...qualifiedName === void 0 ? {} : { qualifiedName },
      range: { startLine: range.startLine, endLine: range.endLine },
      ...sourceHash === void 0 ? {} : { sourceHash }
    })),
    edges: [...edges.values()]
  };
}
async function readIndex(indexPath, revision) {
  const bytes = await regularBytes(indexPath, INDEX_BYTES);
  if (sha(bytes) !== revision) throw semanticError("corrupt_asset", "The semantic index failed its integrity check.");
  return JSON.parse(bytes.toString("utf8"));
}
function storedEmbeddings(index) {
  return Object.fromEntries(index.chunks.filter((chunk) => chunk.embeddingKey && chunk.embedding).map((chunk) => [chunk.embeddingKey, chunk.embedding]));
}
async function writeIndex(directory, index) {
  const contents = JSON.stringify(index), revision = sha(contents), indexPath = path.join(directory, `${revision}.json`);
  if (Buffer.byteLength(contents) > INDEX_BYTES) throw semanticError("resource_limit", "The semantic index exceeds 512 MiB.");
  await writeAtomically(indexPath, contents, { mode: 384 });
  await writeAtomically(path.join(directory, unitsFile(revision)), JSON.stringify(publishedUnits(index, revision)), { mode: 384 });
  return { revision, indexPath, bytes: Buffer.byteLength(contents) };
}
export {
  INDEX_BYTES,
  indexMetadata,
  publishedUnits,
  readIndex,
  sha,
  storedEmbeddings,
  unitsFile,
  writeIndex
};
