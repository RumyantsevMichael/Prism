import assert from "node:assert/strict";
import test from "node:test";
import { highlight, highlightLines, languageOf } from "../../dist/server/review/public/views/highlight.js";
import { renderText } from "../../dist/server/review/public/views/markdown.js";

test("a path or fence info names its language, and an unknown one names none", () => {
  assert.equal(languageOf("src/app.ts"), "javascript");
  assert.equal(languageOf("ts title=\"x\""), "javascript");
  assert.equal(languageOf("crates/core/lib.rs"), "rust");
  assert.equal(languageOf("Dockerfile"), "shell");
  assert.equal(languageOf("docs/Features/retry.feature"), "gherkin");
  assert.equal(languageOf("notes.unknown"), null);
  assert.equal(languageOf(""), null);
});

test("tokens are escaped and marked by kind", () => {
  const html = highlight('const a = "<b>"; // done\nreturn foo(1);', "javascript");
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;&lt;b&gt;&quot;<\/span>/);
  assert.match(html, /<span class="tok-comment">\/\/ done<\/span>/);
  assert.match(html, /<span class="tok-function">foo<\/span>\(<span class="tok-number">1<\/span>\)/);
  assert.doesNotMatch(html, /<b>/);
});

test("an unknown language stays escaped plain text", () => {
  assert.equal(highlight("<x> & y", null), "&lt;x&gt; &amp; y");
});

test("a token across lines is split so each line stays balanced", () => {
  assert.deepEqual(highlightLines("a /* one\ntwo */ b", "javascript"), ["a <span class=\"tok-comment\">/* one</span>", "<span class=\"tok-comment\">two */</span> b"]);
  for (const line of highlightLines("x = `a\nb\nc`", "javascript")) {
    assert.equal((line.match(/<span/g) ?? []).length, (line.match(/<\/span>/g) ?? []).length);
  }
});

test("data formats mark keys and literals but not types or calls", () => {
  assert.match(highlight("name: Validate plugin\nok: true", "yaml"), /<span class="tok-attr">name<\/span>: Validate plugin/);
  assert.match(highlight('{"a": null}', "json"), /<span class="tok-attr">&quot;a&quot;<\/span>: <span class="tok-literal">null<\/span>/);
});

test("Markdown fences are highlighted by their info string and keep their text", () => {
  const html = renderText("doc.md", "```ts\nconst x = \"a & b\";\n```\n\n```\nplain <tag>\n```\n");
  assert.match(html, /<pre><code class="language-javascript"><span class="tok-keyword">const<\/span> x = <span class="tok-string">&quot;a &amp; b&quot;<\/span>;<\/code><\/pre>/);
  assert.match(html, /<pre><code>plain &lt;tag&gt;<\/code><\/pre>/);
});
