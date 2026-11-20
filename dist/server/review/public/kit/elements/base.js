// Generated from src/server/review/public/kit/elements/base.ts by scripts/native-build/compile.mjs.
const Base = globalThis.HTMLElement ?? class {
};
const ELEMENTS_URL = new URL("./", import.meta.url);
const SHARED_SHEET = "shadow.css";
const sheets = /* @__PURE__ */ new Map();
const adoptable = Boolean(globalThis.document?.adoptedStyleSheets && globalThis.CSSStyleSheet?.prototype?.replaceSync);
async function loadStyles(names) {
  if (!adoptable) return;
  const wanted = [.../* @__PURE__ */ new Set([SHARED_SHEET, ...names])].filter((name) => !sheets.has(name));
  await Promise.all(wanted.map(async (name) => {
    sheets.set(name, null);
    try {
      const response = await fetch(new URL(name, ELEMENTS_URL));
      if (!response.ok) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await response.text());
      sheets.set(name, sheet);
    } catch {
      sheets.delete(name);
    }
  }));
}
function applyStyles(root, names) {
  const all = [SHARED_SHEET, ...names];
  const adopted = [];
  for (const name of all) {
    const sheet = sheets.get(name);
    if (sheet) adopted.push(sheet);
    else {
      const link = root.ownerDocument.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL(name, ELEMENTS_URL).href;
      root.prepend(link);
    }
  }
  if (adopted.length) root.adoptedStyleSheets = adopted;
}
function shadow(host, names, markup, options = {}) {
  const root = host.attachShadow({ mode: "open", ...options });
  root.innerHTML = markup;
  applyStyles(root, names);
  return root;
}
let counter = 0;
function uniqueId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}
function emit(element, type, detail) {
  return element.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
}
function toggleAttribute(element, name, on) {
  if (on) {
    if (!element.hasAttribute(name)) element.setAttribute(name, "");
  } else if (element.hasAttribute(name)) element.removeAttribute(name);
}
function setAttribute(element, name, value) {
  if (value === null || value === void 0) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
}
function ownText(element, exceptSlots = []) {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.textContent;
    else if (node.nodeType === 1 && !exceptSlots.includes(node.getAttribute("slot"))) text += node.textContent;
  }
  return text.replace(/\s+/g, " ").trim();
}
function deepActiveElement(root = globalThis.document) {
  let element = root?.activeElement ?? null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function distribute(host, regions, own = []) {
  const keep = new Set(own);
  const place = () => {
    for (const node of [...host.childNodes]) {
      if (keep.has(node)) continue;
      const slot = node.nodeType === 1 ? node.getAttribute("slot") : null;
      const target = slot && regions[slot] || regions.default;
      if (target && target !== node) target.append(node);
    }
  };
  place();
  const observer = new MutationObserver(place);
  observer.observe(host, { childList: true });
  return observer;
}
function make(host, tag, className, attributes = {}) {
  const element = host.ownerDocument.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) setAttribute(element, name, value);
  return element;
}
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), prism-button:not([disabled]), prism-chip[href], prism-chip[interactive]";
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((element) => {
    if (element.closest("[hidden], [inert]") || element.getClientRects().length === 0) return false;
    return !element.parentElement?.closest("prism-button, prism-tab, prism-chip");
  });
}
export {
  Base,
  applyStyles,
  deepActiveElement,
  distribute,
  emit,
  escapeHtml,
  focusables,
  loadStyles,
  make,
  ownText,
  setAttribute,
  shadow,
  toggleAttribute,
  uniqueId
};
