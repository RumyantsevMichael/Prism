import { escapeHtml } from "./util.js";

const VIEWS = {
  "change-map": () => import("./change-map.js"),
  "review-ledger": () => import("./review-ledger.js"),
  "coordination-state": () => import("./coordination-state.js"),
  json: () => import("./json-view.js")
};

export async function renderView(container, data, ctx) {
  const load = ctx.state.raw || data.parseError ? VIEWS.json : VIEWS[data.kind] ?? VIEWS.json;
  try {
    const view = await load();
    await view.render(container, data, ctx);
  } catch (error) {
    container.innerHTML = `<section class="view-card"><p class="error">The structured view failed: ${escapeHtml(error.message)}</p></section>`;
    const fallback = document.createElement("div");
    container.appendChild(fallback);
    (await VIEWS.json()).render(fallback, data, ctx);
  }
}
