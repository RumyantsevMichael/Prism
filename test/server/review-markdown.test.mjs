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
  assert.match(html, /<span class="doc-link-missing" title="docs\/plans\/retry\/missing\.md is not a reviewable file in this project">gone<\/span>/);
  assert.match(html, /<span class="doc-link-missing"[^>]*>out<\/span>/);
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
