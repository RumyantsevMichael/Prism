// Generated from src/server/review/public/views/json-view.ts by scripts/native-build/compile.mjs.
import { jsonTreeHtml } from "./json-tree.js";
import { bindLinks, card, escapeHtml, pathName } from "./util.js";
function render(container, data, ctx) {
  if (data.parseError) {
    container.innerHTML = card("Invalid JSON", `<p class="error">${escapeHtml(data.parseError)}</p><prism-code language="json"><pre><code>${escapeHtml(data.content)}</code></pre></prism-code>`);
    return;
  }
  const named = pathName(ctx.path, ctx);
  const label = named.code ? "JSON document" : named.label;
  container.innerHTML = card("Document", jsonTreeHtml(data.data, { openDepth: 3, ctx, label }), { eyebrow: "JSON tree" });
  bindLinks(container, ctx);
}
export {
  render
};
