// Generated from src/server/repository-intelligence/embedding-store.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { closeSync, fstatSync, ftruncateSync, fchmodSync, openSync, writeSync, constants } from "node:fs";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes } from "./native-files.mjs";
import { INDEX_BYTES } from "./index-files.mjs";
const EMBEDDINGS_FILE = "embeddings.bin";
const DIMENSIONS = 384;
const RECORD_BYTES = 32 + DIMENSIONS * 4;
const KEY = /^[a-f\d]{64}$/;
const embeddingsPath = (directory) => path.join(directory, EMBEDDINGS_FILE);
const validPair = (pair) => Array.isArray(pair) && typeof pair[0] === "string" && KEY.test(pair[0]) && Array.isArray(pair[1]) && pair[1].length === DIMENSIONS && pair[1].every(Number.isFinite);
function encode(pairs) {
  const bytes = Buffer.alloc(pairs.length * RECORD_BYTES);
  pairs.forEach(([key, vector], index) => {
    const offset = index * RECORD_BYTES;
    bytes.write(key, offset, "hex");
    vector.forEach((value, position) => bytes.writeFloatLE(value, offset + 32 + position * 4));
  });
  return bytes;
}
function appendEmbeddings(directory, pairs) {
  const valid = pairs.filter(validPair);
  if (!valid.length) return 0;
  const descriptor = openSync(embeddingsPath(directory), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 384);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw Object.assign(new Error("The embedding store is not a regular file."), { code: "invalid_path" });
    if (info.mode & 63) fchmodSync(descriptor, 384);
    if (info.size % RECORD_BYTES) ftruncateSync(descriptor, info.size - info.size % RECORD_BYTES);
    const bytes = encode(valid);
    for (let offset = 0; offset < bytes.length; ) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(descriptor);
  }
  return valid.length;
}
async function readEmbeddings(directory, { limit = Infinity, skip } = {}) {
  const embeddings = {};
  if (limit <= 0) return embeddings;
  let bytes;
  try {
    bytes = await regularBytes(embeddingsPath(directory), INDEX_BYTES);
  } catch {
    return embeddings;
  }
  let count = 0;
  for (let offset = (Math.floor(bytes.length / RECORD_BYTES) - 1) * RECORD_BYTES; offset >= 0 && count < limit; offset -= RECORD_BYTES) {
    const key = bytes.toString("hex", offset, offset + 32);
    if (key in embeddings || skip && Object.hasOwn(skip, key)) continue;
    const vector = Array.from({ length: DIMENSIONS }, (_, position) => bytes.readFloatLE(offset + 32 + position * 4));
    if (vector.every(Number.isFinite)) {
      embeddings[key] = vector;
      count += 1;
    }
  }
  return embeddings;
}
async function replaceEmbeddings(directory, chunks) {
  const pairs = /* @__PURE__ */ new Map();
  for (const { embeddingKey, embedding } of chunks) if (embeddingKey && !pairs.has(embeddingKey) && validPair([embeddingKey, embedding])) pairs.set(embeddingKey, embedding);
  await writeAtomically(embeddingsPath(directory), encode([...pairs]), { mode: 384 });
}
export {
  DIMENSIONS,
  EMBEDDINGS_FILE,
  RECORD_BYTES,
  appendEmbeddings,
  embeddingsPath,
  readEmbeddings,
  replaceEmbeddings
};
