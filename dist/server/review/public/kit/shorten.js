// Generated from src/server/review/public/kit/shorten.ts by scripts/native-build/compile.mjs.
const watched = /* @__PURE__ */ new Map();
let resizes = null;
let mutations = null;
function measure(host) {
  const entry = watched.get(host);
  if (!entry) return;
  const { text, focusable } = entry;
  const shortened = text.isConnected && text.clientWidth > 0 && text.scrollWidth > text.clientWidth;
  if (shortened !== host.hasAttribute("shortened")) {
    if (shortened) host.setAttribute("shortened", "");
    else host.removeAttribute("shortened");
  }
  const joins = shortened && !focusable();
  if (joins && !host.hasAttribute("tabindex")) {
    host.setAttribute("tabindex", "0");
    entry.added = true;
  } else if (!joins && entry.added) {
    host.removeAttribute("tabindex");
    entry.added = false;
  }
}
function watchShortening(host, text, { focusable = () => false } = {}) {
  if (!globalThis.ResizeObserver || !globalThis.MutationObserver) return;
  resizes ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      for (const [host2, item] of watched) if (item.text === entry.target || host2 === entry.target) measure(host2);
    }
  });
  if (!mutations) globalThis.document?.fonts?.addEventListener?.("loadingdone", () => {
    for (const host2 of watched.keys()) measure(host2);
  });
  mutations ??= new MutationObserver((records) => {
    const hosts = /* @__PURE__ */ new Set();
    for (const record of records) {
      for (let node = record.target; node; node = node.parentNode ?? node.host) {
        if (watched.has(node)) hosts.add(node);
      }
    }
    for (const host2 of hosts) measure(host2);
  });
  const previous = watched.get(host);
  if (previous) resizes.unobserve(previous.text);
  watched.set(host, { text, focusable, added: previous?.added ?? false });
  resizes.observe(text);
  resizes.observe(host);
  mutations.observe(host, { childList: true, characterData: true, subtree: true });
  requestAnimationFrame(() => measure(host));
}
function remeasure(host) {
  measure(host);
}
function unwatchShortening(host) {
  const entry = watched.get(host);
  if (!entry) return;
  resizes?.unobserve(entry.text);
  resizes?.unobserve(host);
  if (entry.added) host.removeAttribute("tabindex");
  watched.delete(host);
}
export {
  remeasure,
  unwatchShortening,
  watchShortening
};
