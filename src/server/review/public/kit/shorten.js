// The shared shortening observer: a kit element that shows one line of text ends text that does not fit with an ellipsis in CSS,
// and this observer marks it `shortened` while it does, so the tooltip can show the full text and a static element joins the Tab order to reach it.

const watched = new Map();
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
  // An element that is not focusable already joins the Tab order while shortened, so a keyboard user can reach its full text.
  const joins = shortened && !focusable();
  if (joins && !host.hasAttribute("tabindex")) {
    host.setAttribute("tabindex", "0");
    entry.added = true;
  } else if (!joins && entry.added) {
    host.removeAttribute("tabindex");
    entry.added = false;
  }
}

/**
 * Watches `text`, the element of `host`'s shadow root that holds its one line of text, and keeps `shortened` on `host` in step with it.
 * `focusable` tells whether the host already takes focus some other way.
 */
export function watchShortening(host, text, { focusable = () => false } = {}) {
  if (!globalThis.ResizeObserver || !globalThis.MutationObserver) return;
  resizes ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      for (const [host, item] of watched) if (item.text === entry.target || host === entry.target) measure(host);
    }
  });
  if (!mutations) globalThis.document?.fonts?.addEventListener?.("loadingdone", () => {
    for (const host of watched.keys()) measure(host);
  });
  mutations ??= new MutationObserver((records) => {
    const hosts = new Set();
    for (const record of records) {
      for (let node = record.target; node; node = node.parentNode ?? node.host) {
        if (watched.has(node)) hosts.add(node);
      }
    }
    for (const host of hosts) measure(host);
  });
  const previous = watched.get(host);
  if (previous) resizes.unobserve(previous.text);
  watched.set(host, { text, focusable, added: previous?.added ?? false });
  resizes.observe(text);
  resizes.observe(host);
  mutations.observe(host, { childList: true, characterData: true, subtree: true });
  requestAnimationFrame(() => measure(host));
}

/** Measures a watched host again, such as after its content or its mode changed. */
export function remeasure(host) {
  measure(host);
}

/** Stops watching a host that left the document. */
export function unwatchShortening(host) {
  const entry = watched.get(host);
  if (!entry) return;
  resizes?.unobserve(entry.text);
  resizes?.unobserve(host);
  if (entry.added) host.removeAttribute("tabindex");
  watched.delete(host);
}
