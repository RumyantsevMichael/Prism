import assert from "node:assert/strict";
import test from "node:test";
import { headingSlug, renderText } from "../../dist/server/review/public/views/markdown.js";

const known = new Set(["docs/requirements/retries.md", "docs/plans/retry/review.md"]);
const options = { basePath: "docs/plans/retry/slice.md", isKnown: (path) => known.has(path) };

test("headings get prefixed GitHub-style ids, deduplicated in document order", () => {
  const html = renderText("doc.md", "# Retry deadline\n## Tabs & panes\n## Tabs & panes\n```\n# not a heading\n```\n");
  assert.match(html, /<h1 id="md-retry-deadline">/);
  assert.match(html, /<h2 id="md-tabs--panes">/);
  assert.match(html, /<h2 id="md-tabs--panes-1">/);
  assert.doesNotMatch(html, /id="md-not-a-heading"/);
  assert.equal(headingSlug("Ready to ship?"), "ready-to-ship");
});

test("relative links resolve against the document and open known files in the review", () => {
  const html = renderText("doc.md", "See [rule](../../requirements/retries.md#2), [review](./review.md), [here](#context), [gone](missing.md), [out](../../../../etc/passwd), [site](https://example.com), [js](javascript:alert(1)) and `[code](x.md)`.", options);
  assert.match(html, /<a href="\.\/review\?artifact=docs%2Frequirements%2Fretries\.md" data-doc-link="docs\/requirements\/retries\.md" data-doc-anchor="2">rule<\/a>/);
  assert.match(html, /data-doc-link="docs\/plans\/retry\/review\.md">review<\/a>/);
  assert.match(html, /<a href="#context" data-doc-anchor="context">here<\/a>/);
  assert.match(html, /<prism-chip class="doc-link-missing" tip="docs\/plans\/retry\/missing\.md is not a reviewable file in this project">gone<\/prism-chip>/);
  assert.match(html, /<prism-chip class="doc-link-missing"[^>]*>out<\/prism-chip>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<code>\[code\]\(x\.md\)<\/code>/);
});

test("an explicit anchor line names the section below it instead of rendering as text", () => {
  const html = renderText("doc.md", '# Retries\n\n<a id="2"></a>\n## 2. Connection drops\n\nInline <a id="x"></a> stays text.\n');
  assert.match(html, /<span class="md-anchor" id="md-2"><\/span>\n<h2 id="md-2-connection-drops">/);
  assert.doesNotMatch(html, /&lt;a id=&quot;2&quot;/);
  assert.match(html, /Inline &lt;a id=&quot;x&quot;&gt;&lt;\/a&gt; stays text\./);
});

test("a source anchor names one line or a line range", async () => {
  const { LINE_RANGE } = await import("../../dist/server/review/public/views/markdown.js");
  assert.deepEqual([..."L12".match(LINE_RANGE)].slice(1), ["12", undefined]);
  assert.deepEqual([..."L12-39".match(LINE_RANGE)].slice(1), ["12", "39"]);
  assert.equal("context".match(LINE_RANGE), null);
});

test("ordered lists keep counting across blank lines and start at their first number", () => {
  const html = renderText("doc.md", "1. one\n2. two\n\n3. three\n   continued\n\nBetween.\n\n7. seven\n8. eight\n");
  assert.equal(html.match(/<ol/g).length, 2);
  assert.match(html, /<ol>\n<li>one\n<\/li>\n<li>two\n<\/li>\n<li>three\ncontinued/);
  assert.match(html, /<ol start="7">\n<li>seven/);
  assert.doesNotMatch(html, /<ol start="1">/);
});

test("indented list items nest inside the item above them", () => {
  const html = renderText("doc.md", "- a\n  - a.1\n    1. deep\n- b\n").replace(/\n/g, "");
  assert.equal(html, "<ul><li>a<ul><li>a.1<ol><li>deep</li></ol></li></ul></li><li>b</li></ul>");
});

test("consecutive text lines form one paragraph and a single line break is a space", () => {
  const html = renderText("doc.md", "One sentence.\nTwo **bold\nacross** lines.\nHard break  \nand a backslash\\\nend.\n\nNext paragraph.\n- item\n");
  assert.equal(html.match(/<p>/g).length, 2);
  assert.match(html, /<p>One sentence\.\nTwo <strong>bold\nacross<\/strong> lines\.\nHard break<br>\nand a backslash<br>\nend\.<\/p>/);
  assert.match(html, /<p>Next paragraph\.<\/p>\n<ul>/);
});

test("a heading, fence, table, quote, or list item ends a paragraph, and a list that does not start at 1 does not", () => {
  const html = renderText("doc.md", "Text\n2. not a list\n# Heading\nText\n```\ncode\n```\nText\n| a |\n|---|\nText\n> quote\n");
  assert.match(html, /<p>Text\n2\. not a list<\/p>\n<h1/);
  assert.equal(html.match(/<p>/g).length, 5);
  assert.doesNotMatch(html, /<ol/);
});

test("consecutive quoted lines form one quote whose blank quoted lines separate paragraphs", () => {
  const html = renderText("doc.md", "> one\n> two\nlazy\n>\n> second\n\nafter\n");
  assert.equal(html.match(/<blockquote>/g).length, 1);
  assert.match(html, /<blockquote><p>one\ntwo\nlazy<\/p>\n<p>second<\/p><\/blockquote>\n<p>after<\/p>/);
});
