import test from "node:test";
import assert from "node:assert/strict";
import { fragmentUnit } from "../../dist/native-runtime/fragments.mjs";
import { embedFragments } from "../../dist/native-runtime/embeddings.mjs";

// Each embedding progress value after the first carries the vectors of the batch it reports, so Prism can save them before the build goes on.
const fragment = (file, value) => fragmentUnit({ id: file, file, kind: "function", name: "example", range: { startLine: 1, endLine: 1 } },
  { file, content: `function example() { return ${value}; }`, hash: "verified" }, text => text.length)[0];
const vector = value => Array(384).fill(value);

test("each embedded batch reports its vectors with its progress, and reused fragments report none", async () => {
  const warm = [fragment("warm.mjs", 100)];
  await embedFragments(warm, "model", {}, async texts => texts.map(() => vector(0.5)), () => {});
  const chunks = [...Array.from({ length: 10 }, (_, index) => fragment(`${index}.mjs`, index)), fragment("copy.mjs", 100)];
  const progress = [];
  await embedFragments(chunks, "model", { [warm[0].embeddingKey]: warm[0].embedding },
    async texts => texts.map(text => vector(Number(text.match(/return (\d+)/)[1]))), value => progress.push(structuredClone(value)));
  assert.deepEqual(progress[0], { phase: "embedding", current: 0, total: 10 });
  assert.deepEqual(progress.slice(1).map(value => [value.current, value.vectors.length]), [[8, 8], [10, 2]]);
  const reported = new Map(progress.slice(1).flatMap(value => value.vectors));
  assert.equal(reported.size, 10);
  assert.ok(!reported.has(warm[0].embeddingKey), "a reused embedding is not reported again");
  for (const chunk of chunks.slice(0, 10)) {
    assert.match(chunk.embeddingKey, /^[a-f\d]{64}$/);
    assert.deepEqual(reported.get(chunk.embeddingKey), chunk.embedding);
  }
});
