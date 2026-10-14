import { jsonTreeHtml } from "./json-tree.js";
import { bindLinks, card, escapeHtml } from "./util.js";

export function render(container, data, ctx) {
  if (data.parseError) {
    container.innerHTML = card("Invalid JSON", `<p class="error">${escapeHtml(data.parseError)}</p><pre><code>${escapeHtml(data.content)}</code></pre>`);
    return;
  }
  container.innerHTML = card("Document", jsonTreeHtml(data.data, { openDepth: 3, ctx }), { eyebrow: "JSON tree" });
  bindLinks(container, ctx);
}
