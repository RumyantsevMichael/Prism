// Parses PlantUML sources with the vendored browser runtime in a worker thread, so its browser globals never reach the server.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

const vendor = workerData.vendorDirectory;

// Just enough of a DOM for the runtime to draw an SVG string: text is measured by length, which counts and errors do not depend on.
class Element {
  constructor(tagName) { Object.assign(this, { tagName, attributes: new Map(), children: [], text: "", style: {}, parentNode: null }); }
  get ownerDocument() { return globalThis.document; }
  get firstChild() { return this.children[0] ?? null; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child) { return this.appendChild(child); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); return child; }
  getBBox() { return { width: this.textContent.length * 7, height: 16, x: 0, y: -12 }; }
  getContext() { return { font: "", measureText: (value) => ({ width: String(value).length * 7 }), createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} }; }
  toDataURL() { return "data:,"; }
}

const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const serialize = (element) => `<${element.tagName}${[...element.attributes].map(([name, value]) => ` ${name}="${escape(value)}"`).join("")}>${escape(element.text)}${element.children.map(serialize).join("")}</${element.tagName}>`;

globalThis.require = createRequire(import.meta.url);
globalThis.__filename = path.join(vendor, "viz-global.js");
globalThis.window = globalThis;
globalThis.self = globalThis;
vm.runInThisContext(readFileSync(path.join(vendor, "viz-global.js"), "utf8"));
// The runtime loads a standard library such as C4 on its first include, which a browser does with a script tag.
globalThis.PLANTUML_STDLIB_LOADER = (name, ok, fail) => {
  const file = path.join(vendor, path.basename(String(name)));
  try { vm.runInThisContext(readFileSync(file, "utf8")); ok(); }
  catch { fail(`The standard library ${name} is not available.`); }
  return true;
};
globalThis.document = {
  createElementNS: (_namespace, tagName) => new Element(tagName),
  createElement: (tagName) => new Element(tagName),
  createProcessingInstruction: (target, data) => Object.assign(new Element(`?${target}`), { text: data }),
  createTextNode: (value) => Object.assign(new Element("#text"), { text: value }),
  body: new Element("body"),
  head: new Element("head")
};
globalThis.XMLSerializer = class { serializeToString(element) { return serialize(element); } };
console.log = () => {};
const { renderToString } = await import(pathToFileURL(path.join(vendor, "plantuml.js")).href);

const RENDER_TIMEOUT_MS = 20000;
const render = (source) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: "The diagram did not finish parsing." }), RENDER_TIMEOUT_MS);
  const settle = (value) => { clearTimeout(timer); resolve(value); };
  try { renderToString(source.split(/\r?\n/), (svg) => settle({ svg }), (error) => settle({ error: String(error) })); }
  catch (error) { settle({ error: String(error) }); }
});

const unescape = (value) => value.replace(/&lt;/g, "<").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const texts = (svg, pattern) => [...svg.matchAll(pattern)].map((match) => unescape(match[1]).trim()).filter(Boolean);

// PlantUML draws every failure as a diagram: a syntax or include error names its source line, and an unknown diagram type says so.
function summarize(svg) {
  const located = /\[From [^\]]*\(line (\d+)\)/.exec(svg);
  if (located || /Diagram not supported/.test(svg)) {
    const errors = texts(svg, /<text[^>]*fill="#FF0000"[^>]*>([^<]*)/g);
    const fallback = located ? "PlantUML reported an error." : "PlantUML does not recognize the diagram; it needs @startuml and a supported diagram type.";
    return { valid: false, line: Number(located?.[1]) || null, message: errors.join(" ") || fallback };
  }
  const entities = (svg.match(/<g class="(?:entity|cluster)"/g) ?? []).length;
  const participants = (svg.match(/<g><title>/g) ?? []).length;
  // Activity diagrams mark no elements, so their boxes stand in for them.
  const boxes = (svg.match(/<rect /g) ?? []).length;
  return { valid: true, elements: entities || participants || boxes, relations: (svg.match(/<g class="link"/g) ?? []).length };
}

const results = [];
for (const item of workerData.sources) {
  const outcome = await render(item.source);
  results.push({ path: item.path, ...(outcome.error ? { checked: false, message: outcome.error.slice(0, 300) } : { checked: true, ...summarize(outcome.svg) }) });
}
parentPort.postMessage(results);
