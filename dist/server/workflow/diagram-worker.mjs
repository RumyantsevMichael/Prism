// Generated from src/server/workflow/diagram-worker.mts by scripts/native-build/compile.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
const vendor = workerData.vendorDirectory;
class Element {
  constructor(tagName) {
    Object.assign(this, { tagName, attributes: /* @__PURE__ */ new Map(), children: [], text: "", style: {}, parentNode: null });
  }
  get ownerDocument() {
    return globalThis.document;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child) {
    return this.appendChild(child);
  }
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    return child;
  }
  getBBox() {
    return { width: this.textContent.length * 7, height: 16, x: 0, y: -12 };
  }
  getContext() {
    return { font: "", measureText: (value) => ({ width: String(value).length * 7 }), createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {
    } };
  }
  toDataURL() {
    return "data:,";
  }
}
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const serialize = (element) => `<${element.tagName}${[...element.attributes].map(([name, value]) => ` ${name}="${escape(value)}"`).join("")}>${escape(element.text)}${element.children.map(serialize).join("")}</${element.tagName}>`;
globalThis.require = createRequire(import.meta.url);
globalThis.__filename = path.join(vendor, "viz-global.js");
globalThis.window = globalThis;
globalThis.self = globalThis;
vm.runInThisContext(readFileSync(path.join(vendor, "viz-global.js"), "utf8"));
globalThis.PLANTUML_STDLIB_LOADER = (name, ok, fail) => {
  const file = path.join(vendor, path.basename(String(name)));
  try {
    vm.runInThisContext(readFileSync(file, "utf8"));
    ok();
  } catch {
    fail(`The standard library ${name} is not available.`);
  }
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
globalThis.XMLSerializer = class {
  serializeToString(element) {
    return serialize(element);
  }
};
console.log = () => {
};
const { renderToString } = await import(pathToFileURL(path.join(vendor, "plantuml.js")).href);
const RENDER_TIMEOUT_MS = 2e4;
const render = (source) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ error: "The diagram did not finish parsing." }), RENDER_TIMEOUT_MS);
  const settle = (value) => {
    clearTimeout(timer);
    resolve(value);
  };
  try {
    renderToString(source.split(/\r?\n/), (svg) => settle({ svg }), (error) => settle({ error: String(error) }));
  } catch (error) {
    settle({ error: String(error) });
  }
});
const unescape = (value) => value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const texts = (svg, pattern) => [...svg.matchAll(pattern)].map((match) => unescape(match[1]).trim()).filter(Boolean);
const UNRECOGNIZED = "PlantUML does not recognize the diagram; it needs @startuml and a supported diagram type.";
const count = (svg, pattern) => (svg.match(pattern) ?? []).length;
function activityCounts(svg) {
  const actions = [...svg.matchAll(/<rect [^>]*>/g)].filter(([tag]) => / rx="/.test(tag) && /fill="([^"]*)"/.exec(tag)?.[1] !== /stroke="([^"]*)"/.exec(tag)?.[1]).length;
  const decisions = [...svg.matchAll(/<polygon points="([^"]*)" fill="([^"]*)" stroke="([^"]*)"/g)].filter(([, points, fill, stroke]) => {
    const corners = points.trim().split(/\s+/);
    return fill !== stroke && corners.length === 7 && new Set(corners.slice(0, 6)).size === 6;
  }).length;
  return { elements: actions + decisions, relations: 0 };
}
function counts(svg, kind) {
  if (kind === "sequence") return { elements: count(svg, /<g class="participant participant-head"/g), relations: new Set(svg.match(/<g class="message"[^>]*\bid="[^"]*"/g)?.map((tag) => /\bid="([^"]*)"/.exec(tag)[1]) ?? []).size };
  if (kind === "activity") return activityCounts(svg);
  if (kind === "state") return { elements: count(svg, /<g class="entity"/g), relations: count(svg, /<g class="link"/g) };
  const entities = count(svg, /<g class="(?:entity|cluster)"/g);
  const participants = count(svg, /<g><title>/g);
  const boxes = count(svg, /<rect /g);
  return { elements: entities || participants || boxes, relations: count(svg, /<g class="link"/g) };
}
function summarize(svg, kind) {
  const located = /\[From [^\]]*\(line (\d+)\)/.exec(svg);
  if (located || /Diagram not supported/.test(svg)) {
    const errors = texts(svg, /<text[^>]*fill="#FF0000"[^>]*>([^<]*)/g);
    const fallback = located ? "PlantUML reported an error." : UNRECOGNIZED;
    return { valid: false, line: Number(located?.[1]) || null, message: errors.join(" ") || fallback };
  }
  return { valid: true, ...counts(svg, kind) };
}
function check(source, kind, outcome) {
  if (!/^\s*@start[a-z]+/im.test(source)) return { checked: true, valid: false, line: null, message: UNRECOGNIZED };
  if (!outcome.error) return { checked: true, ...summarize(outcome.svg, kind) };
  if (/Unsupported diagram type/.test(outcome.error)) return { checked: true, valid: false, line: null, message: UNRECOGNIZED };
  const thrown = /^java\.[\w.]*?(\w+(?:Exception|Error))(?::\s*(.*))?/.exec(outcome.error);
  if (thrown) return { checked: true, valid: false, line: null, message: `PlantUML could not read it (${thrown[1]}${thrown[2] ? `: ${thrown[2]}` : ""}).`.slice(0, 300) };
  return { checked: false, message: outcome.error.slice(0, 300) };
}
const results = [];
for (const item of workerData.sources) results.push({ path: item.path, ...check(item.source, item.kind, await render(item.source)) });
parentPort.postMessage(results);
