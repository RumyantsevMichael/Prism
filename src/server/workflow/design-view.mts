import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertInput } from "./artifact-schema.mjs";
import { inArtifactStore, listStoreArtifacts, locateRecord, readArtifactBytes, readArtifactText, readRecord, readStoreFileBytes, sliceDocumentFolder, STORE_FILE_BOUNDS, withRecordLock, writeRecord } from "./record-store.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
import { checkFolderViews, listedViews, viewProblems } from "./diagram-check.mjs";
import { contractClauses, listItems as items, section } from "./view-declarations.mjs";
import { acceptedDesign, readFrozenTestOf } from "./slice-design.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { refuseShipped } from "./shipped-history.mjs";

const MAX_EXAMPLES = 400;
const MAX_EXAMPLE_CHARS = 400;
const CHANGE_ACTIONS = Object.freeze(["add", "change", "remove"]);

export class DesignViewError extends Error {
  declare code: string;
  [detail: string]: unknown;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DesignViewError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: string, message: string, details?: Record<string, unknown>) => new DesignViewError(code, message, details);
const sha256 = (value: any) => createHash("sha256").update(value).digest("hex");
const slug = { type: "string", minLength: 1, maxLength: 120 };

export const UPDATE_DESIGN_VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["projectRoot", "initiative", "slice", "examples"],
  properties: {
    projectRoot: { type: "string", minLength: 1, maxLength: 2000 },
    initiative: slug,
    slice: slug,
    examples: {
      type: "array",
      minItems: 1,
      maxItems: MAX_EXAMPLES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clause", "file", "test", "example"],
        properties: {
          clause: { type: "integer", minimum: 1, description: "The 1-based number of the Contract bullet in slice.md that the test checks." },
          file: { type: "string", minLength: 1, maxLength: 500, description: "The project-relative frozen test file that holds the test." },
          test: { type: "string", minLength: 1, maxLength: 300, description: "The test or scenario name exactly as written in the file." },
          example: { type: "string", minLength: 1, maxLength: MAX_EXAMPLE_CHARS, description: "One line that restates what the test asserts: the input or action, then the observable result." }
        }
      }
    }
  }
};

export { contractClauses };

/**
 * The planned changes of a design's Changes section: `- <add|change|remove> \`path\`[, \`path\`]: units and why (§clause, …)`.
 * Each path becomes its own change with the shared note, and any other line shape is a problem rather than a guess.
 * A slice of a split scope cites the scope's Contract, so the caller passes that design as `contractSource`.
 */
export function plannedChanges(source: any, contractSource = source) {
  const text = section(source, "Changes");
  if (text === null) return { changes: [], problems: [] };
  const clauseCount = contractClauses(contractSource).length;
  const changes: any[] = [], problems: string[] = [];
  for (const [item, line] of items(text).entries()) {
    const parsed = /^(add|change|remove)\s+((?:`[^`]+`\s*,\s*)*`[^`]+`)\s*(?::\s*(.*))?$/i.exec(line);
    if (!parsed) { problems.push(`Changes line ${JSON.stringify(line)} must be add, change, or remove, then one or more comma-separated paths in backticks, then a colon and the note.`); continue; }
    // A note may end with the Contract clauses the change serves, such as `(§1, §3)`; a change without them supports the slice as a whole.
    let note = (parsed[3] ?? "").trim();
    const tag = /\s*\(\s*(§\s*\d+(?:\s*,\s*§\s*\d+)*)\s*\)\s*\.?\s*$/.exec(note);
    const clauses = tag ? [...new Set([...tag[1].matchAll(/\d+/g)].map((match) => Number(match[0])))] : [];
    if (tag) note = note.slice(0, tag.index).trim();
    const missing = clauses.filter((number) => number < 1 || number > clauseCount);
    if (missing.length) problems.push(`Changes line ${JSON.stringify(line)} cites ${missing.map((number) => `§${number}`).join(", ")}, which the Contract does not have.`);
    // The units are the code names the note starts with, such as "`get`, `put` and `List`: why"; code later in the reason is not a unit.
    const lead = /^`[^`]+`(?:\s*(?:,\s*(?:and\s+)?|and\s+)`[^`]+`)*/.exec(note)?.[0] ?? "";
    const units = [...lead.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
    for (const [, raw] of parsed[2].matchAll(/`([^`]+)`/g)) {
      const target = raw.trim();
      const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
      if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.replace(/\/$/, "") !== target.replace(/\/$/, "")) {
        problems.push(`Changes path ${JSON.stringify(target)} is not a normalized project-relative path.`);
        continue;
      }
      changes.push({ action: parsed[1].toLowerCase(), path: target, units, note, clauses, item });
    }
  }
  return { changes, problems };
}

async function designSource(root: string, initiative: string, slice: string) {
  const folder = await sliceDocumentFolder(root, initiative, slice);
  if (folder === null) throw fail("validation_failed", "The workflow configuration has no Plans path, so the slice has no slice.md.");
  const relative = `${folder}/slice.md`;
  // With a store, slice.md is read there and never from the checkout.
  return { path: relative, source: await readArtifactText(root, relative) };
}

// A slice of a split scope has only its Changes; its Contract is the nearest ancestor design that has one.
async function governingDesign(root: string, initiative: string, slice: string, own: any) {
  if (own.source !== null && contractClauses(own.source).length) return { slug: slice, design: own };
  let slices: Record<string, any> = {};
  try { slices = parseStoreJson((await readStoreFileBytes((await locateRecord(root, { kind: "initiative", initiative })).target, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null")?.slices ?? {}; }
  catch { return { slug: slice, design: own }; }
  const seen = new Set([slice]);
  for (let parent = slices[slice]?.parent; parent && !seen.has(parent); parent = slices[parent]?.parent) {
    seen.add(parent);
    const design = await designSource(root, initiative, parent).catch(() => ({ source: null }));
    if (design.source !== null && contractClauses(design.source).length) return { slug: parent, design };
  }
  return { slug: slice, design: own };
}

// A test is named in its file when the exact name occurs there, as a whole word when the name is one.
function namesTest(content: string, name: string) {
  if (/^\w+$/.test(name)) return new RegExp(`(?<![\\w])${name}(?![\\w])`).test(content);
  return content.includes(name);
}

const contractDigest = (clauses: any) => sha256(clauses.join("\n"));

/**
 * Replace a slice's design view: one plain-language example per acceptance test, each under the Contract clause it checks.
 * The server checks every citation against slice.md and the test files, and records digests so a revised design marks the view stale.
 */
export async function updateDesignView(input: any) {
  assertInput(UPDATE_DESIGN_VIEW_SCHEMA, input);
  const root = await realpath(input.projectRoot);
  const { initiative, slice } = input;
  // A shipped initiative's design views are history, so a change to one is refused after argument validation and before any other check.
  await refuseShipped(root, initiative);
  const own = await designSource(root, initiative, slice);
  if (own.source === null) throw fail("validation_failed", `${own.path} does not exist, so there is no contract to cite.`);
  const { design } = await governingDesign(root, initiative, slice, own);
  const clauses = contractClauses(design.source);
  if (!clauses.length) throw fail("validation_failed", `${own.path} has no Contract section with list items to cite, and neither has a design it belongs to.`);
  const accepted = await acceptedDesign(root, initiative, slice);
  const frozen = accepted ? new Set(accepted.frozenTests.map((item: any) => item.path)) : null;
  const problems: string[] = [], files = new Map();
  for (const file of new Set<string>(input.examples.map((item: any) => item.file))) {
    if (frozen && !frozen.has(file)) { problems.push(`${file} is not a frozen test of the accepted design.`); continue; }
    try {
      const bytes = await readFrozenTestOf(root, initiative, file);
      if (bytes === null) problems.push(`${file} does not exist.`);
      else files.set(file, { sha256: sha256(bytes), content: bytes.toString("utf8") });
    } catch (error) { problems.push(error.message); }
  }
  input.examples.forEach((item: any, index: number) => {
    if (item.clause > clauses.length) problems.push(`examples[${index}] cites clause ${item.clause}, but the Contract has ${clauses.length}.`);
    const file = files.get(item.file);
    if (file && !namesTest(file.content, item.test)) problems.push(`examples[${index}] cites ${JSON.stringify(item.test)}, which ${item.file} does not contain.`);
    if (/[\r\n]/.test(item.example)) problems.push(`examples[${index}].example must be one line.`);
  });
  if (problems.length) throw fail("validation_failed", `The design view was not written: ${problems.slice(0, 5).join(" ")}${problems.length > 5 ? ` (${problems.length - 5} more)` : ""}`, { problems });
  const document = {
    schemaVersion: 1,
    writtenAt: new Date().toISOString(),
    design: { path: design.path, contractSha256: contractDigest(clauses) },
    tests: [...files].map(([file, value]) => ({ path: file, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    examples: input.examples.map(({ clause, file, test, example }: { clause: any; file: string; test: any; example: any }) => ({ clause, file, test, example: example.trim() }))
  };
  const key = { kind: "design-view", initiative, slice };
  // A ship that landed after the first check refuses the write too, so the design view never changes after the initiative shipped.
  await withRecordLock(root, key, async () => {
    await refuseShipped(root, initiative);
    await writeRecord(root, key, `${JSON.stringify(document, null, 2)}\n`);
  }, fail);
  const cited = new Set(document.examples.map((item: any) => item.clause));
  const gaps = clauses.map((text, index) => ({ clause: index + 1, text })).filter((item) => !cited.has(item.clause));
  // The designer learns about a view the design gate would refuse here, before anyone accepts the design.
  // The root scope's folder holds every slice folder, so its slices' views are checked with it.
  const folder = path.posix.dirname(own.path);
  const folders = [folder];
  if (initiativeDirectory(await readWorkflowConfig(root), initiative) === folder) {
    const stored = await listStoreArtifacts(root, folder);
    if (stored !== null) folders.push(...[...new Set<string>(stored.map((entry: any) => entry.path.slice(folder.length + 1).split("/")).filter((parts: any) => parts.length > 1).map((parts: any) => `${folder}/${parts[0]}`))].sort());
    else {
      const entries = await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
      folders.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => `${folder}/${entry.name}`).sort());
    }
  }
  const config = await readWorkflowConfig(root);
  const scope = { top: initiativeDirectory(config, initiative) ?? folder, initiative, plans: config.paths?.plans ?? null };
  const results = [];
  for (const item of folders) results.push(...await checkFolderViews(root, item, scope));
  const refused = viewProblems(results);
  const views = listedViews(results);
  return {
    status: "written",
    clauses: clauses.length,
    examples: document.examples.length,
    gaps,
    ...(views.length ? { views } : {}),
    ...(refused.length ? { viewProblems: refused } : {})
  };
}

async function storedView(root: string, initiative: string, slice: string) {
  try {
    const { bytes } = await readRecord(root, { kind: "design-view", initiative, slice });
    return bytes === null ? null : parseStoreJson(bytes.toString("utf8"));
  } catch { return { invalid: true }; }
}

const lastSegment = (name: string) => name.split(/::|\.|#|\//).filter(Boolean).at(-1) ?? name;
const ACTUAL: Record<string, string> = { ADD: "added", MODIFY: "changed", DELETE: "removed" };

/** Line up a design's planned changes with the change map derived from its verified result. */
export function comparePlannedChanges(changes: any, concepts: any) {
  const actual = new Map();
  for (const entry of concepts) {
    const file = (entry.after?.[0] ?? entry.before?.[0])?.path;
    if (!file) continue;
    if (!actual.has(file)) actual.set(file, []);
    actual.get(file).push({ action: entry.action, unit: entry.kind === "file" ? null : entry.label });
  }
  const matched = new Set();
  const rows = changes.map((change: any) => {
    const files = [...actual.keys()].filter((file) => change.path.endsWith("/") ? file.startsWith(change.path) : file === change.path);
    files.forEach((file) => matched.add(file));
    const done = files.flatMap((file) => actual.get(file));
    if (!done.length) return { path: change.path, planned: change, actual: [], reading: "untouched" };
    const doneUnits = done.filter((item) => item.unit).map((item) => item.unit);
    const missing = change.units.filter((unit: any) => !doneUnits.some((name) => lastSegment(name) === lastSegment(unit)));
    const extra = doneUnits.filter((name) => !change.units.some((unit: any) => lastSegment(unit) === lastSegment(name)));
    return { path: change.path, planned: change, actual: done, reading: missing.length ? "partly" : "as-planned", missing, extra: change.units.length ? extra : [] };
  });
  for (const [file, done] of actual) if (!matched.has(file)) rows.push({ path: file, planned: null, actual: done, reading: "unplanned" });
  return rows;
}

// Where each named unit of a change lives in the published code index; an added unit has no place yet.
function unitPlaces(index: any, change: any) {
  if (change.action === "add" || !change.units.length) return [];
  const inFile = (index.units ?? []).filter((unit: any) => unit.file === change.path);
  if (!inFile.length) return [];
  const places = [];
  for (const name of change.units) {
    const found = inFile.filter((unit: any) => unit.name === name || unit.qualifiedName === name || lastSegment(unit.qualifiedName ?? unit.name) === lastSegment(name));
    // A name the index does not have is a unit the change adds to the file.
    if (!found.length) places.push({ unit: name, kind: null, startLine: null, endLine: null });
    for (const unit of found) places.push({ unit: name, kind: unit.kind, startLine: unit.range.startLine, endLine: unit.range.endLine });
  }
  return places;
}

export const describeActual = (item: any) => item.unit ? `${ACTUAL[item.action] ?? item.action} \`${item.unit}\`` : `${ACTUAL[item.action] ?? item.action} the file`;

/**
 * What the review browser shows for a designed slice: the contract's clauses with their examples and gaps,
 * the planned changes, and, once the verified result has a derived change map, planned versus actual.
 */
export async function loadDesignView(projectRoot: string, initiative: string, slice: string, { changeMap = null, units = null }: { changeMap?: any; units?: any } = {}) {
  const root = await realpath(projectRoot);
  const design: any = await designSource(root, initiative, slice).catch(() => ({ source: null }));
  if (design.source === null) return null;
  const governing = await governingDesign(root, initiative, slice, design);
  const inherited = governing.slug !== slice;
  const clauses = contractClauses(governing.design.source);
  const planned = plannedChanges(design.source, governing.design.source);
  if (!clauses.length && !planned.changes.length) return null;
  // A slice of a split scope reads the scope's examples, unless it has its own.
  const stored = await storedView(root, initiative, slice) ?? (inherited ? await storedView(root, initiative, governing.slug) : null);
  const stale = [];
  let examples = [];
  if (stored?.invalid || (stored && !Array.isArray(stored.examples))) stale.push("The stored examples are not readable.");
  else if (stored) {
    examples = stored.examples;
    if (stored.design?.contractSha256 !== contractDigest(clauses)) stale.push("The contract changed after the examples were written.");
    for (const test of stored.tests ?? []) {
      const bytes = await readFrozenTestOf(root, initiative, test.path).catch(() => null);
      if (bytes === null) stale.push(`${test.path} no longer exists.`);
      else if (sha256(bytes) !== test.sha256) stale.push(`${test.path} changed after the examples were written.`);
    }
  }
  const allClauses = clauses.map((text, index) => ({ number: index + 1, text, examples: examples.filter((item: any) => item.clause === index + 1) }));
  // A slice of a split scope shows only the clauses its Changes say it serves.
  const served = new Set(planned.changes.flatMap((change) => change.clauses));
  const byClause = inherited ? allClauses.filter((clause) => served.has(clause.number)) : allClauses;
  const changeProblems = [...planned.problems];
  const verified = Boolean(changeMap);
  if (!verified) {
    for (const change of planned.changes) {
      if (change.action === "add" || change.path.endsWith("/")) continue;
      // With a store, a planned change to a descriptive artifact, such as a requirement, names a file the store holds.
      const found = await inArtifactStore(root, change.path)
        ? await readArtifactBytes(root, change.path).then((bytes) => bytes !== null, () => false)
        : await stat(path.join(root, change.path)).then(() => true, () => false);
      // A new file is planned as add, so a missing path to change is usually a wrong action, unless the path is mistyped.
      const hint = change.action === "change" ? " Plan a new file as add, or correct the path." : " Correct the path.";
      if (!found) changeProblems.push(`${change.path} is planned to ${change.action} but does not exist.${hint}`);
    }
  }
  // A change's tests are those cited for the clauses it serves, which is design's claim until coverage confirms it.
  for (const change of planned.changes) {
    const cited = allClauses.filter((clause) => change.clauses.includes(clause.number)).flatMap((clause) => clause.examples.map((item: any) => ({ file: item.file, test: item.test })));
    change.tests = [...new Map(cited.map((item) => [`${item.file}\0${item.test}`, item])).values()];
    change.places = units ? unitPlaces(units, change) : null;
  }
  return {
    path: design.path,
    contract: inherited ? { path: governing.design.path, slice: governing.slug } : null,
    indexed: units ? { snapshot: units.snapshot ?? null } : null,
    clauses: byClause,
    examplesWritten: stored && !stored.invalid ? stored.writtenAt ?? null : null,
    gaps: stored && !stale.length ? byClause.filter((clause) => !clause.examples.length).map((clause) => clause.number) : [],
    stale,
    changes: planned.changes,
    changeProblems,
    comparison: verified ? comparePlannedChanges(planned.changes, changeMap.concepts ?? []) : null
  };
}
