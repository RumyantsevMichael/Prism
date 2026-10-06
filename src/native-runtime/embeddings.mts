import { createHash } from "node:crypto";
import { CHUNKER_VERSION } from "./concepts.mjs";
import type { Fragment, Progress } from "../server/repository-concept-types.mjs";

const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 384 && value.every(Number.isFinite);

export async function embedFragments(chunks: Fragment[], modelIdentity: string, previous: Record<string, number[]>,
  embed: (texts: string[]) => Promise<number[][]>, progress: (value: Progress) => void) {
  const groups = new Map<string, { text: string; chunks: Fragment[] }>();
  const vectors = new Map<string, number[]>();
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
    chunk.embedding = vectors.get(key)!;
  }
  return { reusedEmbeddings: chunks.length - missing.length, newEmbeddings: missing.length };
}
