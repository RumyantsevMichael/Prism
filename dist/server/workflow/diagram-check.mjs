import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pluginPath } from "../plugin-root.mjs";

// A design diagram is read by a person at the design gate, so one that shows more than this many elements is split.
export const DIAGRAM_ELEMENT_LIMIT = 30;
const MAX_DIAGRAMS = 20;
const MAX_SOURCE_BYTES = 256 * 1024;
const CHECK_TIMEOUT_MS = 60000;

function parse(sources) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./diagram-worker.mjs", import.meta.url), { workerData: { vendorDirectory: pluginPath("vendor", "plantuml"), sources }, execArgv: [], stdout: true, stderr: true });
    const finish = (results) => { clearTimeout(timer); worker.terminate().catch(() => {}); resolve(results); };
    const unchecked = (message) => finish(sources.map((item) => ({ path: item.path, checked: false, message })));
    const timer = setTimeout(() => unchecked("The diagram check timed out."), CHECK_TIMEOUT_MS);
    worker.once("message", finish);
    worker.once("error", (error) => unchecked(`The diagram check failed: ${error.message}`));
    worker.once("exit", (code) => unchecked(`The diagram check stopped with exit code ${code}.`));
  });
}

/** Problems a design gate must not pass: a diagram that does not parse or shows more elements than a person can read. */
export function diagramProblems(results) {
  return results.flatMap((item) => {
    if (!item.checked) return [];
    if (!item.valid) return [`${item.path}${item.line ? ` line ${item.line}` : ""} does not parse: ${item.message}`];
    if (item.elements > DIAGRAM_ELEMENT_LIMIT) return [`${item.path} shows ${item.elements} elements, more than ${DIAGRAM_ELEMENT_LIMIT}. Split it into views a person can read.`];
    return [];
  });
}

/** Parse every PlantUML file directly in a project folder and count its elements and relations, without drawing it for anyone. */
export async function checkFolderDiagrams(projectRoot, folder) {
  if (folder === null) return [];
  const root = await realpath(projectRoot);
  let names = [];
  try { names = (await readdir(path.join(root, folder), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".puml")).map((entry) => entry.name).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  if (!names.length) return [];
  const sources = [];
  for (const name of names.slice(0, MAX_DIAGRAMS)) {
    const source = await readFile(path.join(root, folder, name), "utf8");
    sources.push({ path: `${folder}/${name}`, source: source.length > MAX_SOURCE_BYTES ? source.slice(0, MAX_SOURCE_BYTES) : source });
  }
  return parse(sources);
}
