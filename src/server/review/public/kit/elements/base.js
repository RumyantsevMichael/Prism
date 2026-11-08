// Shared pieces of the kit's elements: a base class that also loads without a DOM, shadow stylesheets that are fetched once and adopted by every shadow root,
// and small helpers for events, ids, and boolean attributes.

/** HTMLElement in a page, and an empty class where there is no DOM, so the kit's module imports in Node. */
export const Base = globalThis.HTMLElement ?? class {};

const ELEMENTS_URL = new URL("./", import.meta.url);
// The stylesheet every shadow root adopts first: box sizing, the hidden attribute, and the keyboard focus outline.
const SHARED_SHEET = "shadow.css";
const sheets = new Map();
const adoptable = Boolean(globalThis.document?.adoptedStyleSheets && globalThis.CSSStyleSheet?.prototype?.replaceSync);

/** Fetches each named stylesheet of the elements folder once and builds one constructed stylesheet from it, so shadow roots adopt it without a request of their own. */
export async function loadStyles(names) {
  if (!adoptable) return;
  const wanted = [...new Set([SHARED_SHEET, ...names])].filter((name) => !sheets.has(name));
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

/** Gives a shadow root the shared stylesheet and the named ones, adopting the loaded sheets and linking the files where a sheet is not loaded. */
export function applyStyles(root, names) {
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

/** Attaches an open shadow root with the element's stylesheets and markup. */
export function shadow(host, names, markup, options = {}) {
  const root = host.attachShadow({ mode: "open", ...options });
  root.innerHTML = markup;
  applyStyles(root, names);
  return root;
}

let counter = 0;
/** A document-unique id with a readable prefix. */
export function uniqueId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Sends a bubbling, composed custom event from an element. */
export function emit(element, type, detail) {
  return element.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
}

/** Sets or removes a boolean attribute. */
export function toggleAttribute(element, name, on) {
  if (on) {
    if (!element.hasAttribute(name)) element.setAttribute(name, "");
  } else if (element.hasAttribute(name)) element.removeAttribute(name);
}

/** Sets an attribute to a value, or removes it for null and undefined, writing only when the value changes. */
export function setAttribute(element, name, value) {
  if (value === null || value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
}

/** The element's text without the content of children assigned to a named slot. */
export function ownText(element, exceptSlots = []) {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.textContent;
    else if (node.nodeType === 1 && !exceptSlots.includes(node.getAttribute("slot"))) text += node.textContent;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** The element whose focus the keyboard would see: the deepest active element through open shadow roots. */
export function deepActiveElement(root = globalThis.document) {
  let element = root?.activeElement ?? null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** Escapes text for HTML markup. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
