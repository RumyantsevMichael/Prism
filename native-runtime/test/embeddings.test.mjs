import test from "node:test";
import assert from "node:assert/strict";
import { fragmentConcept } from "../concepts.mjs";
import { embedFragments } from "../embeddings.mjs";

function fragment(file, value = 1, name = "example", docstring) {
  const content = `function ${name}() { return ${value}; }`;
  return fragmentConcept({ id: file, file, kind: "function", name, docstring, range: { startLine: 1, endLine: 1 } },
    { file, content, hash: "verified" }, text => text.length)[0];
}
const vector = value => Array(384).fill(value);

test("cold builds share exact model inputs without merging source candidates", async () => {
  const chunks = Array.from({ length: 10 }, (_, index) => fragment(`src/${index}.mts`, index));
  chunks.push(...Array.from({ length: 10 }, (_, index) => fragment(`generated/${index}.mjs`, index)));
  const identities = chunks.map(({ id, file, text, sourceStart, sourceEnd }) => ({ id, file, text, sourceStart, sourceEnd }));
  const batches = [], progress = [];
  const counts = await embedFragments(chunks, "model-a", {}, async texts => {
    batches.push(texts);
    return texts.map(text => vector(Number(text.match(/return (\d+)/)[1])));
  }, value => progress.push(value));
  assert.deepEqual(batches.map(batch => batch.length), [8, 2]);
  assert.deepEqual(counts, { newEmbeddings: 10, reusedEmbeddings: 10 });
  assert.deepEqual(progress.at(-1), { phase: "embedding", current: 10, total: 10 });
  assert.deepEqual(chunks.map(({ id, file, text, sourceStart, sourceEnd }) => ({ id, file, text, sourceStart, sourceEnd })), identities);
  for (let index = 0; index < 10; index++) {
    assert.equal(chunks[index].embeddingKey, chunks[index + 10].embeddingKey);
    assert.equal(chunks[index].embedding, chunks[index + 10].embedding);
    assert.equal(chunks[index].embedding[0], index);
  }
});

test("warm builds reuse valid vectors across paths but keep model, source, and metadata distinctions", async () => {
  const first = [fragment("a.mts")];
  await embedFragments(first, "model-a", {}, async () => [vector(1)], () => {});
  const previous = { [first[0].embeddingKey]: first[0].embedding };
  const chunks = [fragment("a.mjs"), fragment("b.mjs", 2), fragment("c.mjs", 1, "different"), fragment("d.mjs", 1, "example", "Different obligation.")];
  let inputs;
  const counts = await embedFragments(chunks, "model-a", previous, async texts => {
    inputs = texts;
    return texts.map(() => vector(2));
  }, () => {});
  assert.equal(inputs.length, 3);
  assert.deepEqual(counts, { newEmbeddings: 3, reusedEmbeddings: 1 });
  assert.equal(chunks[0].embedding, first[0].embedding);
  assert.equal(new Set(chunks.map(chunk => chunk.embeddingKey)).size, 4);
  const changedModel = await embedFragments([fragment("a.mjs")], "model-b", previous, async () => [vector(3)], () => {});
  assert.equal(changedModel.newEmbeddings, 1);
});

test("invalid cached vectors are recomputed and failed inference publishes no partial fragment vectors", async () => {
  const first = [fragment("original.mts")];
  await embedFragments(first, "model", {}, async () => [vector(1)], () => {});
  for (const cached of [Array(383).fill(1), [...Array(383).fill(1), NaN]]) {
    let calls = 0;
    const counts = await embedFragments([fragment("copy.mjs")], "model", { [first[0].embeddingKey]: cached }, async () => {
      calls++;
      return [vector(2)];
    }, () => {});
    assert.equal(calls, 1);
    assert.equal(counts.newEmbeddings, 1);
  }
  const chunks = Array.from({ length: 9 }, (_, index) => fragment(`${index}.mjs`, index));
  let calls = 0;
  await assert.rejects(embedFragments(chunks, "model", {}, async texts => {
    if (++calls === 2) throw new Error("Inference failed.");
    return texts.map(() => vector(1));
  }, () => {}), /Inference failed/);
  assert.ok(chunks.every(chunk => !chunk.embedding && !chunk.embeddingKey));
  const recovered = await embedFragments(chunks, "model", {}, async texts => texts.map(() => vector(1)), () => {});
  assert.equal(recovered.newEmbeddings, 9);
  for (const values of [[], [Array(383).fill(1)], [[...Array(383).fill(1), Infinity]]]) {
    await assert.rejects(embedFragments([fragment("invalid.mjs")], "model", {}, async () => values, () => {}), /invalid embedding/);
  }
});
