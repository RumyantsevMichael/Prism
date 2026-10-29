// Parses PlantUML sources with the vendored browser runtime in a worker thread, so its browser globals never reach the server.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
globalThis.__filename = `${vendor}/viz-global.js`;
globalThis.window = globalThis;
globalThis.self = globalThis;
vm.runInThisContext(readFileSync(`${vendor}/viz-global.js`, "utf8"));
// The runtime loads a standard library such as C4 on its first include, which a browser does with a script tag.
globalThis.PLANTUML_STDLIB_LOADER = (name, ok, fail) => {
  const file = `${vendor}/${String(name).split("/").at(-1)}`;
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
const { renderToString } = await import(new URL(`file://${vendor}/plantuml.js`).href);

const RENDER_TIMEOUT_MS = 20000;
const render = (source) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: "The diagram did not finish parsing." }), RENDER_TIMEOUT_MS);
  const settle = (value) => { clearTimeout(timer); resolve(value); };
  try { renderToString(source.split(/\r?\n/), (svg) => settle({ svg }), (error) => settle({ error: String(error) })); }
  catch (error) { settle({ error: String(error) }); }
});

const texts = (svg, pattern) => [...svg.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean);

function summarize(svg) {
  if (/Syntax Error\?/.test(svg)) {
    const line = Number(/\[From [^\]]*\(line (\d+)\)/.exec(svg)?.[1]) || null;
    const errors = texts(svg, /<text[^>]*fill="#FF0000"[^>]*>([^<]*)/g);
    return { valid: false, line, message: errors.join(" ") || "Syntax Error?" };
  }
  const entities = (svg.match(/<g class="(?:entity|cluster)"/g) ?? []).length;
  const participants = (svg.match(/<g><title>/g) ?? []).length;
  return { valid: true, elements: entities || participants, relations: (svg.match(/<g class="link"/g) ?? []).length };
}

const results = [];
for (const item of workerData.sources) {
  const outcome = await render(item.source);
  results.push({ path: item.path, ...(outcome.error ? { checked: false, message: outcome.error.slice(0, 300) } : { checked: true, ...summarize(outcome.svg) }) });
}
parentPort.postMessage(results);
