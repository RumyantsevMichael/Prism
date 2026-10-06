import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../dist/native-runtime/worker.mjs", import.meta.url));
const { Tokenizer } = require("@huggingface/tokenizers");
import { bgeSourceBoundaries, fragmentConcept } from "../../dist/native-runtime/concepts.mjs";

const configuration = {
  added_tokens: [{ id: 1, content: "[MASK]", single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
  normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
  pre_tokenizer: { type: "BertPreTokenizer" },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  post_processor: null,
  model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100,
    vocab: Object.fromEntries(["[UNK]", "[MASK]", "ab", "abc", "##d", "cd", "a", "##a", "hello", "world", ".", "(", ")", "!", "中", "文", "cafe"].map((value, i) => [value, i])) }
};
const tokenizer = new Tokenizer(configuration, {});
const ids = text => tokenizer.encode(text, { add_special_tokens: false }).ids;
const boundaries = bgeSourceBoundaries(tokenizer, configuration);
for (const source of ["hello.world();", "café\r\nworld", "中文hello", "[MASK]hello", "a".repeat(100), "a".repeat(101), "ab\vcd ab\fcd ab\uFEFFcd", "Ελλάδα🙂 hello"]) {
  test(`token boundaries preserve normalized tokens and raw source: ${JSON.stringify(source.slice(0, 24))}`, () => {
    const content = (source + " ").repeat(30), file = { file: "x.md", content, hash: "h" };
    const concept = { id: "x", file: "x.md", kind: "paragraph", name: "notes", range: { startLine: 1, endLine: content.split("\n").length } };
    const pieces = fragmentConcept(concept, file, text => ids(text).length + 2, 128, boundaries);
    assert.ok(pieces.every(piece => ids(piece.text).length + 2 <= 128));
    const raw = pieces.map(piece => content.slice(piece.sourceStart, piece.sourceEnd));
    assert.equal(raw.join(""), content);
    assert.deepEqual(raw.flatMap(ids), ids(content));
  });
}
