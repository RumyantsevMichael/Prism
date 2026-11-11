import path from "node:path";
import { closeSync, fstatSync, ftruncateSync, fchmodSync, openSync, writeSync, constants } from "node:fs";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes } from "./native-files.mjs";
import { INDEX_BYTES } from "./index-files.mjs";
import type { Fragment } from "./repository-unit-types.mjs";

// The embedding store of a storage location keeps every embedding a build made, as it made it, so a build that stalls, pauses, fails, or ends
// with its process leaves its work for the next build of that location, in any session that shares the storage.
// Each record is the 32 bytes of an embedding key followed by its 384 values as little-endian 32-bit floats.

export const EMBEDDINGS_FILE = "embeddings.bin";
export const DIMENSIONS = 384;
export const RECORD_BYTES = 32 + DIMENSIONS * 4;
const KEY = /^[a-f\d]{64}$/;

export const embeddingsPath = (directory: string) => path.join(directory, EMBEDDINGS_FILE);
const validPair = (pair: unknown): pair is [string, number[]] => Array.isArray(pair) && typeof pair[0] === "string" && KEY.test(pair[0])
  && Array.isArray(pair[1]) && pair[1].length === DIMENSIONS && pair[1].every(Number.isFinite);

function encode(pairs: [string, number[]][]) {
  const bytes = Buffer.alloc(pairs.length * RECORD_BYTES);
  pairs.forEach(([key, vector], index) => {
    const offset = index * RECORD_BYTES;
    bytes.write(key, offset, "hex");
    vector.forEach((value, position) => bytes.writeFloatLE(value, offset + 32 + position * 4));
  });
  return bytes;
}

/**
 * Appends the valid pairs to the store before it returns, so a record is saved before the build's next message is handled.
 * A torn final record that an interrupted writer left is cut off first, so the new records stay aligned.
 */
export function appendEmbeddings(directory: string, pairs: unknown[]): number {
  const valid = pairs.filter(validPair);
  if (!valid.length) return 0;
  const descriptor = openSync(embeddingsPath(directory), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw Object.assign(new Error("The embedding store is not a regular file."), { code: "invalid_path" });
    if (info.mode & 0o077) fchmodSync(descriptor, 0o600);
    if (info.size % RECORD_BYTES) ftruncateSync(descriptor, info.size - (info.size % RECORD_BYTES));
    const bytes = encode(valid);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  } finally { closeSync(descriptor); }
  return valid.length;
}

/** Every whole record of the store whose values are all finite, the later of two records of one key winning; a store that cannot be read is empty. */
export async function readEmbeddings(directory: string): Promise<Record<string, number[]>> {
  let bytes: Buffer;
  try { bytes = await regularBytes(embeddingsPath(directory), INDEX_BYTES); } catch { return {}; }
  const embeddings: Record<string, number[]> = {};
  for (let offset = 0; offset + RECORD_BYTES <= bytes.length; offset += RECORD_BYTES) {
    const vector = Array.from({ length: DIMENSIONS }, (_, position) => bytes.readFloatLE(offset + 32 + position * 4));
    if (vector.every(Number.isFinite)) embeddings[bytes.toString("hex", offset, offset + 32)] = vector;
  }
  return embeddings;
}

/** Replaces the store atomically with one record for each distinct embedding key of a complete index's fragments. */
export async function replaceEmbeddings(directory: string, chunks: Pick<Fragment, "embeddingKey" | "embedding">[]) {
  const pairs = new Map<string, number[]>();
  for (const { embeddingKey, embedding } of chunks) if (embeddingKey && !pairs.has(embeddingKey) && validPair([embeddingKey, embedding])) pairs.set(embeddingKey, embedding!);
  await writeAtomically(embeddingsPath(directory), encode([...pairs]), { mode: 0o600 });
}
