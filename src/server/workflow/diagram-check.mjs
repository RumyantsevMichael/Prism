import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pluginPath } from "../plugin-root.mjs";
import { listStoreArtifacts, readArtifactText } from "./record-store.mjs";
import { readFrozenTestOf } from "./slice-design.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { acceptsDrawn, drawnKind, governingContract, readViews, VIEW_KINDS } from "./view-declarations.mjs";

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

/** Problems a design gate must not pass: a declaration Prism cannot accept, a view that does not parse, or one that shows more elements than a person can read. */
export function viewProblems(results) {
  return results.flatMap((item) => {
    const own = item.problems ?? [];
    if (own.length || !item.checked) return own;
    if (!item.valid) return [`${item.path}${item.line ? ` line ${item.line}` : ""} does not parse: ${item.message}`];
    if (item.elements > DIAGRAM_ELEMENT_LIMIT) return [`${item.path} shows ${item.elements} elements, more than ${DIAGRAM_ELEMENT_LIMIT}. Split it into views a person can read.`];
    return [];
  });
}

/** The checked views of a folder's results, as a result lists them: { path, kind, elements, relations }. */
export const listedViews = (results) => results.filter((item) => item.kind && item.checked && item.valid && !(item.problems ?? []).length).map(({ path: file, kind, elements, relations }) => ({ path: file, kind, elements, relations }));

/** The declared views whose check could not run, as `<path>: <message>`. */
export const uncheckedViews = (results) => results.filter((item) => item.kind && item.checked === false).map((item) => `${item.path}: ${item.message}`);

// The files directly in a folder: with a store, the ones the store holds there, and otherwise the checkout's.
async function folderNames(root, folder) {
  const stored = await listStoreArtifacts(root, folder);
  if (stored !== null) return [...new Set(stored.map((entry) => entry.path).filter((file) => path.posix.dirname(file) === folder).map((file) => path.posix.basename(file)))].sort();
  try { return (await readdir(path.join(root, folder), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  return [];
}

// An api view outside the Plans folder is a checkout file, or a frozen test that the initiative staged.
async function checkoutSource(root, file, initiative) {
  const bytes = initiative ? await readFrozenTestOf(root, initiative, file).catch(() => null) : await readFile(path.join(root, file)).catch(() => null);
  return bytes === null ? null : bytes.toString("utf8");
}

/**
 * Check the views of a project folder against its slice.md's Views section: every PlantUML file there is declared, every declaration is well formed, cites clauses the governing contract holds,
 * names a file that exists, and draws its declared kind; then parse each declared PlantUML view and count its elements and relations, without drawing it for anyone.
 * top is the outermost folder whose slice.md may hold the governing contract, and initiative names whose staged frozen tests an api path may be.
 */
export async function checkFolderViews(projectRoot, folder, { top = folder, initiative = null, plans = null } = {}) {
  if (folder === null) return [];
  const root = await realpath(projectRoot);
  const names = await folderNames(root, folder);
  const design = names.includes("slice.md") ? await readArtifactText(root, `${folder}/slice.md`) ?? "" : "";
  const declared = readViews(design, folder, { plans });
  const results = [];
  if (declared.problems.length) {
    const lineProblems = declared.problems.filter((problem) => problem.startsWith(`${folder}/slice.md `));
    if (lineProblems.length) results.push({ path: `${folder}/slice.md`, problems: lineProblems });
  }
  const paths = new Set(declared.views.map((view) => view.path));
  for (const name of names.filter((item) => item.endsWith(".puml") && !paths.has(`${folder}/${item}`))) {
    results.push({ path: `${folder}/${name}`, problems: [`${folder}/${name} states no question: the Views section of ${folder}/slice.md does not declare it.`] });
  }
  const contract = declared.views.some((view) => view.clauses.length) ? await governingContract(root, folder, top) : null;
  const sources = [];
  for (const view of declared.views) {
    const own = declared.problems.filter((problem) => problem.startsWith(`${view.path} `));
    const beyond = view.clauses.filter((number) => number < 1 || number > (contract?.clauses ?? 0));
    if (beyond.length) own.push(`${view.path} cites ${beyond.map((number) => `§${number}`).join(", ")}, but ${contract ? `the contract in ${contract.path} has ${contract.clauses} clause${contract.clauses === 1 ? "" : "s"}` : `no slice.md in ${folder} or above it has a Contract, so it has 0 clauses`}.`);
    const outside = view.file.includes("/");
    const source = outside ? await checkoutSource(root, view.path, initiative) : names.includes(view.file) ? await readArtifactText(root, view.path) : null;
    if (source === null) own.push(`${view.path} does not exist.`);
    else if (VIEW_KINDS.includes(view.kind)) {
      const drawn = drawnKind(view.path, source);
      if (!acceptsDrawn(view.kind, drawn)) own.push(`${view.path} declares ${view.kind} but draws ${drawn}.`);
    }
    const result = { path: view.path, kind: view.kind, problems: own };
    results.push(result);
    if (own.length || source === null) continue;
    if (!view.path.endsWith(".puml")) {
      try { parseStoreJson(source); Object.assign(result, { checked: true, valid: true, elements: 0, relations: 0 }); }
      catch (error) { Object.assign(result, { checked: true, valid: false, line: null, message: error.message }); }
      continue;
    }
    if (sources.length >= MAX_DIAGRAMS) { Object.assign(result, { checked: false, message: `Prism checks at most ${MAX_DIAGRAMS} views of one folder.` }); continue; }
    sources.push({ path: view.path, source: source.length > MAX_SOURCE_BYTES ? source.slice(0, MAX_SOURCE_BYTES) : source, result });
  }
  if (sources.length) {
    const parsed = await parse(sources.map(({ path: file, source }) => ({ path: file, source })));
    for (const [index, item] of sources.entries()) {
      const { path: _file, ...outcome } = parsed[index] ?? { checked: false, message: "The diagram check returned no result." };
      Object.assign(item.result, outcome);
    }
  }
  return results;
}
