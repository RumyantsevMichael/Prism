// Generated from src/server/workflow/design-view.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
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
class DesignViewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DesignViewError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new DesignViewError(code, message, details);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const slug = { type: "string", minLength: 1, maxLength: 120 };
const UPDATE_DESIGN_VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["projectRoot", "initiative", "slice", "examples"],
  properties: {
    projectRoot: { type: "string", minLength: 1, maxLength: 2e3 },
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
function plannedChanges(source, contractSource = source) {
  const text = section(source, "Changes");
  if (text === null) return { changes: [], problems: [] };
  const clauseCount = contractClauses(contractSource).length;
  const changes = [], problems = [];
  for (const [item, line] of items(text).entries()) {
    const parsed = /^(add|change|remove)\s+((?:`[^`]+`\s*,\s*)*`[^`]+`)\s*(?::\s*(.*))?$/i.exec(line);
    if (!parsed) {
      problems.push(`Changes line ${JSON.stringify(line)} must be add, change, or remove, then one or more comma-separated paths in backticks, then a colon and the note.`);
      continue;
    }
    let note = (parsed[3] ?? "").trim();
    const tag = /\s*\(\s*(§\s*\d+(?:\s*,\s*§\s*\d+)*)\s*\)\s*\.?\s*$/.exec(note);
    const clauses = tag ? [...new Set([...tag[1].matchAll(/\d+/g)].map((match) => Number(match[0])))] : [];
    if (tag) note = note.slice(0, tag.index).trim();
    const missing = clauses.filter((number) => number < 1 || number > clauseCount);
    if (missing.length) problems.push(`Changes line ${JSON.stringify(line)} cites ${missing.map((number) => `\xA7${number}`).join(", ")}, which the Contract does not have.`);
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
async function designSource(root, initiative, slice) {
  const folder = await sliceDocumentFolder(root, initiative, slice);
  if (folder === null) throw fail("validation_failed", "The workflow configuration has no Plans path, so the slice has no slice.md.");
  const relative = `${folder}/slice.md`;
  return { path: relative, source: await readArtifactText(root, relative) };
}
async function governingDesign(root, initiative, slice, own) {
  if (own.source !== null && contractClauses(own.source).length) return { slug: slice, design: own };
  let slices = {};
  try {
    slices = parseStoreJson((await readStoreFileBytes((await locateRecord(root, { kind: "initiative", initiative })).target, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null")?.slices ?? {};
  } catch {
    return { slug: slice, design: own };
  }
  const seen = /* @__PURE__ */ new Set([slice]);
  for (let parent = slices[slice]?.parent; parent && !seen.has(parent); parent = slices[parent]?.parent) {
    seen.add(parent);
    const design = await designSource(root, initiative, parent).catch(() => ({ source: null }));
    if (design.source !== null && contractClauses(design.source).length) return { slug: parent, design };
  }
  return { slug: slice, design: own };
}
function namesTest(content, name) {
  if (/^\w+$/.test(name)) return new RegExp(`(?<![\\w])${name}(?![\\w])`).test(content);
  return content.includes(name);
}
const contractDigest = (clauses) => sha256(clauses.join("\n"));
async function updateDesignView(input) {
  assertInput(UPDATE_DESIGN_VIEW_SCHEMA, input);
  const root = await realpath(input.projectRoot);
  const { initiative, slice } = input;
  await refuseShipped(root, initiative);
  const own = await designSource(root, initiative, slice);
  if (own.source === null) throw fail("validation_failed", `${own.path} does not exist, so there is no contract to cite.`);
  const { design } = await governingDesign(root, initiative, slice, own);
  const clauses = contractClauses(design.source);
  if (!clauses.length) throw fail("validation_failed", `${own.path} has no Contract section with list items to cite, and neither has a design it belongs to.`);
  const accepted = await acceptedDesign(root, initiative, slice);
  const frozen = accepted ? new Set(accepted.frozenTests.map((item) => item.path)) : null;
  const problems = [], files = /* @__PURE__ */ new Map();
  for (const file of new Set(input.examples.map((item) => item.file))) {
    if (frozen && !frozen.has(file)) {
      problems.push(`${file} is not a frozen test of the accepted design.`);
      continue;
    }
    try {
      const bytes = await readFrozenTestOf(root, initiative, file);
      if (bytes === null) problems.push(`${file} does not exist.`);
      else files.set(file, { sha256: sha256(bytes), content: bytes.toString("utf8") });
    } catch (error) {
      problems.push(error.message);
    }
  }
  input.examples.forEach((item, index) => {
    if (item.clause > clauses.length) problems.push(`examples[${index}] cites clause ${item.clause}, but the Contract has ${clauses.length}.`);
    const file = files.get(item.file);
    if (file && !namesTest(file.content, item.test)) problems.push(`examples[${index}] cites ${JSON.stringify(item.test)}, which ${item.file} does not contain.`);
    if (/[\r\n]/.test(item.example)) problems.push(`examples[${index}].example must be one line.`);
  });
  if (problems.length) throw fail("validation_failed", `The design view was not written: ${problems.slice(0, 5).join(" ")}${problems.length > 5 ? ` (${problems.length - 5} more)` : ""}`, { problems });
  const document = {
    schemaVersion: 1,
    writtenAt: (/* @__PURE__ */ new Date()).toISOString(),
    design: { path: design.path, contractSha256: contractDigest(clauses) },
    tests: [...files].map(([file, value]) => ({ path: file, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    examples: input.examples.map(({ clause, file, test, example }) => ({ clause, file, test, example: example.trim() }))
  };
  const key = { kind: "design-view", initiative, slice };
  await withRecordLock(root, key, async () => {
    await refuseShipped(root, initiative);
    await writeRecord(root, key, `${JSON.stringify(document, null, 2)}
`);
  }, fail);
  const cited = new Set(document.examples.map((item) => item.clause));
  const gaps = clauses.map((text, index) => ({ clause: index + 1, text })).filter((item) => !cited.has(item.clause));
  const folder = path.posix.dirname(own.path);
  const folders = [folder];
  if (initiativeDirectory(await readWorkflowConfig(root), initiative) === folder) {
    const stored = await listStoreArtifacts(root, folder);
    if (stored !== null) folders.push(...[...new Set(stored.map((entry) => entry.path.slice(folder.length + 1).split("/")).filter((parts) => parts.length > 1).map((parts) => `${folder}/${parts[0]}`))].sort());
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
    ...views.length ? { views } : {},
    ...refused.length ? { viewProblems: refused } : {}
  };
}
async function storedView(root, initiative, slice) {
  try {
    const { bytes } = await readRecord(root, { kind: "design-view", initiative, slice });
    return bytes === null ? null : parseStoreJson(bytes.toString("utf8"));
  } catch {
    return { invalid: true };
  }
}
const lastSegment = (name) => name.split(/::|\.|#|\//).filter(Boolean).at(-1) ?? name;
const ACTUAL = { ADD: "added", MODIFY: "changed", DELETE: "removed" };
function comparePlannedChanges(changes, concepts) {
  const actual = /* @__PURE__ */ new Map();
  for (const entry of concepts) {
    const file = (entry.after?.[0] ?? entry.before?.[0])?.path;
    if (!file) continue;
    if (!actual.has(file)) actual.set(file, []);
    actual.get(file).push({ action: entry.action, unit: entry.kind === "file" ? null : entry.label });
  }
  const matched = /* @__PURE__ */ new Set();
  const rows = changes.map((change) => {
    const files = [...actual.keys()].filter((file) => change.path.endsWith("/") ? file.startsWith(change.path) : file === change.path);
    files.forEach((file) => matched.add(file));
    const done = files.flatMap((file) => actual.get(file));
    if (!done.length) return { path: change.path, planned: change, actual: [], reading: "untouched" };
    const doneUnits = done.filter((item) => item.unit).map((item) => item.unit);
    const missing = change.units.filter((unit) => !doneUnits.some((name) => lastSegment(name) === lastSegment(unit)));
    const extra = doneUnits.filter((name) => !change.units.some((unit) => lastSegment(unit) === lastSegment(name)));
    return { path: change.path, planned: change, actual: done, reading: missing.length ? "partly" : "as-planned", missing, extra: change.units.length ? extra : [] };
  });
  for (const [file, done] of actual) if (!matched.has(file)) rows.push({ path: file, planned: null, actual: done, reading: "unplanned" });
  return rows;
}
function unitPlaces(index, change) {
  if (change.action === "add" || !change.units.length) return [];
  const inFile = (index.units ?? []).filter((unit) => unit.file === change.path);
  if (!inFile.length) return [];
  const places = [];
  for (const name of change.units) {
    const found = inFile.filter((unit) => unit.name === name || unit.qualifiedName === name || lastSegment(unit.qualifiedName ?? unit.name) === lastSegment(name));
    if (!found.length) places.push({ unit: name, kind: null, startLine: null, endLine: null });
    for (const unit of found) places.push({ unit: name, kind: unit.kind, startLine: unit.range.startLine, endLine: unit.range.endLine });
  }
  return places;
}
const describeActual = (item) => item.unit ? `${ACTUAL[item.action] ?? item.action} \`${item.unit}\`` : `${ACTUAL[item.action] ?? item.action} the file`;
async function loadDesignView(projectRoot, initiative, slice, { changeMap = null, units = null } = {}) {
  const root = await realpath(projectRoot);
  const design = await designSource(root, initiative, slice).catch(() => ({ source: null }));
  if (design.source === null) return null;
  const governing = await governingDesign(root, initiative, slice, design);
  const inherited = governing.slug !== slice;
  const clauses = contractClauses(governing.design.source);
  const planned = plannedChanges(design.source, governing.design.source);
  if (!clauses.length && !planned.changes.length) return null;
  const stored = await storedView(root, initiative, slice) ?? (inherited ? await storedView(root, initiative, governing.slug) : null);
  const stale = [];
  let examples = [];
  if (stored?.invalid || stored && !Array.isArray(stored.examples)) stale.push("The stored examples are not readable.");
  else if (stored) {
    examples = stored.examples;
    if (stored.design?.contractSha256 !== contractDigest(clauses)) stale.push("The contract changed after the examples were written.");
    for (const test of stored.tests ?? []) {
      const bytes = await readFrozenTestOf(root, initiative, test.path).catch(() => null);
      if (bytes === null) stale.push(`${test.path} no longer exists.`);
      else if (sha256(bytes) !== test.sha256) stale.push(`${test.path} changed after the examples were written.`);
    }
  }
  const allClauses = clauses.map((text, index) => ({ number: index + 1, text, examples: examples.filter((item) => item.clause === index + 1) }));
  const served = new Set(planned.changes.flatMap((change) => change.clauses));
  const byClause = inherited ? allClauses.filter((clause) => served.has(clause.number)) : allClauses;
  const changeProblems = [...planned.problems];
  const verified = Boolean(changeMap);
  if (!verified) {
    for (const change of planned.changes) {
      if (change.action === "add" || change.path.endsWith("/")) continue;
      const found = await inArtifactStore(root, change.path) ? await readArtifactBytes(root, change.path).then((bytes) => bytes !== null, () => false) : await stat(path.join(root, change.path)).then(() => true, () => false);
      const hint = change.action === "change" ? " Plan a new file as add, or correct the path." : " Correct the path.";
      if (!found) changeProblems.push(`${change.path} is planned to ${change.action} but does not exist.${hint}`);
    }
  }
  for (const change of planned.changes) {
    const cited = allClauses.filter((clause) => change.clauses.includes(clause.number)).flatMap((clause) => clause.examples.map((item) => ({ file: item.file, test: item.test })));
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
export {
  DesignViewError,
  UPDATE_DESIGN_VIEW_SCHEMA,
  comparePlannedChanges,
  contractClauses,
  describeActual,
  loadDesignView,
  plannedChanges,
  updateDesignView
};
