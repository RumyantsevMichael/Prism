import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pluginPath } from "../plugin-root.mjs";
import { listStoreArtifacts, readArtifactText } from "./record-store.mjs";
import { readFrozenTestOf } from "./slice-design.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { acceptsDrawn, drawnKind, governingContract, readViews, VIEW_KINDS } from "./view-declarations.mjs";
import { countApi, countWireframe, limitProblems } from "./view-limits.mjs";

const MAX_DIAGRAMS = 20;
const MAX_SOURCE_BYTES = 256 * 1024;
const CHECK_TIMEOUT_MS = 60000;

/** What the check found for one file of a folder: its declaration problems, and for a checked view whether it parses and what it counts. */
export interface ViewResult { path: string; kind?: string; problems?: string[]; checked?: boolean; valid?: boolean; line?: number | null; message?: string; elements?: number; relations?: number }
type ParsedView = Omit<ViewResult, "kind" | "problems">;

function parse(sources: { path: string; kind: string; source: string }[]) {
  return new Promise<ParsedView[]>((resolve) => {
    const worker = new Worker(new URL("./diagram-worker.mjs", import.meta.url), { workerData: { vendorDirectory: pluginPath("vendor", "plantuml"), sources }, execArgv: [], stdout: true, stderr: true });
    const finish = (results: ParsedView[]) => { clearTimeout(timer); worker.terminate().catch(() => {}); resolve(results); };
    const unchecked = (message: string) => finish(sources.map((item) => ({ path: item.path, checked: false, message })));
    const timer = setTimeout(() => unchecked("The diagram check timed out."), CHECK_TIMEOUT_MS);
    worker.once("message", finish);
    worker.once("error", (error) => unchecked(`The diagram check failed: ${error.message}`));
    worker.once("exit", (code) => unchecked(`The diagram check stopped with exit code ${code}.`));
  });
}

/** Problems a design gate must not pass: a declaration Prism cannot accept, a view that does not parse, or one beyond a readability limit of its kind. */
export function viewProblems(results: ViewResult[]) {
  return results.flatMap((item) => {
    const own = item.problems ?? [];
    if (own.length || !item.checked) return own;
    if (!item.valid) return [`${item.path}${item.line ? ` line ${item.line}` : ""} does not parse: ${item.message}`];
    return item.kind ? limitProblems(item.path, item.kind, item as { elements?: number; relations?: number }) : [];
  });
}

/** The checked views of a folder's results, as a result lists them: { path, kind, elements, relations }. */
export const listedViews = (results: ViewResult[]) => results.filter((item) => item.kind && item.checked && item.valid && !(item.problems ?? []).length).map(({ path: file, kind, elements, relations }) => ({ path: file, kind, elements, relations }));

/** The declared views whose check could not run, as `<path>: <message>`. */
export const uncheckedViews = (results: ViewResult[]) => results.filter((item) => item.kind && item.checked === false).map((item) => `${item.path}: ${item.message}`);

// The files directly in a folder: with a store, the ones the store holds there, and otherwise the checkout's.
async function folderNames(root: string, folder: string): Promise<string[]> {
  const stored = await listStoreArtifacts(root, folder);
  if (stored !== null) return [...new Set<string>(stored.map((entry: { path: string }) => entry.path).filter((file: string) => path.posix.dirname(file) === folder).map((file: string) => path.posix.basename(file)))].sort();
  try { return (await readdir(path.join(root, folder), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  return [];
}

// An api view outside the Plans folder is a checkout file, or a frozen test that the initiative staged.
async function checkoutSource(root: string, file: string, initiative: string | null) {
  const bytes = initiative ? await readFrozenTestOf(root, initiative, file).catch(() => null) : await readFile(path.join(root, file)).catch(() => null);
  return bytes === null ? null : bytes.toString("utf8");
}

/**
 * Check the views of a project folder against its slice.md's Views section: every PlantUML file there is declared, every declaration is well formed, cites clauses the governing contract holds,
 * names a file that exists, and draws its declared kind; then parse each declared PlantUML view and count its elements and relations, without drawing it for anyone.
 * top is the outermost folder whose slice.md may hold the governing contract, and initiative names whose staged frozen tests an api path may be.
 */
export async function checkFolderViews(projectRoot: string, folder: string | null, { top = folder, initiative = null, plans = null }: { top?: string | null; initiative?: string | null; plans?: string | null } = {}): Promise<ViewResult[]> {
  if (folder === null) return [];
  const root = await realpath(projectRoot);
  const names = await folderNames(root, folder);
  const design = names.includes("slice.md") ? await readArtifactText(root, `${folder}/slice.md`) ?? "" : "";
  const declared = readViews(design, folder, { plans });
  const results: ViewResult[] = [];
  if (declared.problems.length) {
    const lineProblems = declared.problems.filter((problem) => problem.startsWith(`${folder}/slice.md `));
    if (lineProblems.length) results.push({ path: `${folder}/slice.md`, problems: lineProblems });
  }
  const paths = new Set(declared.views.map((view) => view.path));
  for (const name of names.filter((item) => item.endsWith(".puml") && !paths.has(`${folder}/${item}`))) {
    results.push({ path: `${folder}/${name}`, problems: [`${folder}/${name} states no question: the Views section of ${folder}/slice.md does not declare it.`] });
  }
  const contract = declared.views.some((view) => view.clauses.length) ? await governingContract(root, folder, top) : null;
  const sources: { path: string; kind: string; source: string; text: string; result: ViewResult }[] = [];
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
    const result: ViewResult = { path: view.path, kind: view.kind, problems: own };
    results.push(result);
    if (own.length || source === null) continue;
    if (!view.path.endsWith(".puml")) {
      let document: unknown;
      try { document = parseStoreJson(source); }
      catch (error) { Object.assign(result, { checked: true, valid: false, line: null, message: error.message }); continue; }
      const operations = countApi(document);
      if (operations === null) own.push(`${view.path} is not an OpenAPI 3 or AsyncAPI 2 or 3 document: it holds an OpenAPI 3.0 or 3.1 document with info and paths, or an AsyncAPI 2 or 3 document with info and channels.`);
      else Object.assign(result, { checked: true, valid: true, elements: operations, relations: 0 });
      continue;
    }
    if (sources.length >= MAX_DIAGRAMS) { Object.assign(result, { checked: false, message: `Prism checks at most ${MAX_DIAGRAMS} views of one folder.` }); continue; }
    sources.push({ path: view.path, kind: drawnKind(view.path, source), source: source.length > MAX_SOURCE_BYTES ? source.slice(0, MAX_SOURCE_BYTES) : source, text: source, result });
  }
  if (sources.length) {
    const parsed = await parse(sources.map(({ path: file, kind, source }) => ({ path: file, kind, source })));
    for (const [index, item] of sources.entries()) {
      const { path: _file, ...outcome } = parsed[index] ?? { checked: false, message: "The diagram check returned no result." };
      Object.assign(item.result, outcome);
      // A wireframe's widgets are the non-empty cells of its Salt grids, which its source names one by one.
      if (item.kind === "wireframe" && outcome.checked && outcome.valid) Object.assign(item.result, { elements: countWireframe(item.text), relations: 0 });
    }
  }
  return results;
}
