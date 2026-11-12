import { jsonTreeHtml } from "./json-tree.js";
import { bindLinks, card, escapeHtml, pathName } from "./util.js";

export function render(container, data, ctx) {
  if (data.parseError) {
    container.innerHTML = card("Invalid JSON", `<p class="error">${escapeHtml(data.parseError)}</p><prism-code language="json"><pre><code>${escapeHtml(data.content)}</code></pre></prism-code>`);
    return;
  }
  // The tree is named by the record it shows by title and kind; a repository file's tree is named by what it is, since the page already names its path.
  const named = pathName(ctx.path, ctx);
  const label = named.code ? "JSON document" : named.label;
  container.innerHTML = card("Document", jsonTreeHtml(data.data, { openDepth: 3, ctx, label }), { eyebrow: "JSON tree" });
  bindLinks(container, ctx);
}
