// Generated from src/native-runtime/embeddings.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { CHUNKER_VERSION } from "./concepts.mjs";
const validVector = (value) => Array.isArray(value) && value.length === 384 && value.every(Number.isFinite);
async function embedFragments(chunks, modelIdentity, previous, embed, progress) {
  const groups = /* @__PURE__ */ new Map();
  const vectors = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    const key = createHash("sha256").update(`${modelIdentity}\0${CHUNKER_VERSION}\0${chunk.embeddingText}`).digest("hex");
    const group = groups.get(key);
    if (group) group.chunks.push(chunk);
    else groups.set(key, { text: chunk.embeddingText, chunks: [chunk] });
    if (validVector(previous[key])) vectors.set(key, previous[key]);
  }
  const missing = [...groups].filter(([key]) => !vectors.has(key));
  progress({ phase: "embedding", current: 0, total: missing.length });
  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8);
    const embedded = await embed(batch.map(([, group]) => group.text));
    if (embedded.length !== batch.length || !embedded.every(validVector)) throw new Error("The model returned invalid embedding vectors.");
    batch.forEach(([key], index) => vectors.set(key, embedded[index]));
    progress({ phase: "embedding", current: Math.min(offset + 8, missing.length), total: missing.length });
  }
  for (const [key, group] of groups) for (const chunk of group.chunks) {
    chunk.embeddingKey = key;
    chunk.embedding = vectors.get(key);
  }
  return { reusedEmbeddings: chunks.length - missing.length, newEmbeddings: missing.length };
}
export {
  embedFragments
};
