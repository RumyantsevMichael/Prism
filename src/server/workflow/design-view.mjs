import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertInput } from "./artifact-schema.mjs";
import { readRecord, sliceDocumentFolder, withRecordLock, writeRecord } from "./record-store.mjs";
import { checkFolderDiagrams, diagramProblems } from "./diagram-check.mjs";
import { acceptedDesign, readFrozenTestOf } from "./slice-design.mjs";

const MAX_EXAMPLES = 400;
const MAX_EXAMPLE_CHARS = 400;
const CHANGE_ACTIONS = Object.freeze(["add", "change", "remove"]);

export class DesignViewError extends Error {
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

// A level-two section of slice.md, without its heading, or null when the design has none.
function section(source, title) {
  const match = new RegExp(`^## ${title}[ \\t]*$`, "m").exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + match[0].length);
  const next = /^#{1,2} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// Top-level list items of a section; an indented or wrapped line belongs to the item above it.
function items(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) result.push(item[1].trim());
    else if (line.trim() && result.length && /^\s/.test(line)) result[result.length - 1] += ` ${line.trim()}`;
  }
  return result;
}

/** The numbered clauses of a design's Contract section. */
export function contractClauses(source) {
  const text = section(source, "Contract");
  return text === null ? [] : items(text);
}

/** The planned changes of a design's Changes section: `- <add|change|remove> \`path\`: units and why`. */
export function plannedChanges(source) {
  const text = section(source, "Changes");
  if (text === null) return { changes: [], problems: [] };
  const changes = [], problems = [];
  for (const line of items(text)) {
    const parsed = /^(add|change|remove)\s+`([^`]+)`\s*[:;,.-]?\s*(.*)$/i.exec(line);
    if (!parsed) { problems.push(`Changes line ${JSON.stringify(line)} does not start with add, change, or remove and a path in backticks.`); continue; }
    const target = parsed[2].trim();
    const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
    if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.replace(/\/$/, "") !== target.replace(/\/$/, "")) {
      problems.push(`Changes path ${JSON.stringify(target)} is not a normalized project-relative path.`);
      continue;
    }
    const note = parsed[3].trim();
    changes.push({ action: parsed[1].toLowerCase(), path: target, units: [...note.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean), note });
  }
  return { changes, problems };
}

async function designSource(root, initiative, slice) {
  const folder = await sliceDocumentFolder(root, initiative, slice);
  if (folder === null) throw fail("validation_failed", "The workflow configuration has no Plans path, so the slice has no slice.md.");
  const relative = `${folder}/slice.md`;
  try { return { path: relative, source: await readFile(path.join(root, relative), "utf8") }; }
  catch (error) {
    if (error.code === "ENOENT") return { path: relative, source: null };
    throw error;
  }
}

// A test is named in its file when the exact name occurs there, as a whole word when the name is one.
function namesTest(content, name) {
  if (/^\w+$/.test(name)) return new RegExp(`(?<![\\w])${name}(?![\\w])`).test(content);
  return content.includes(name);
}

const contractDigest = (clauses) => sha256(clauses.join("\n"));

/**
 * Replace a slice's design view: one plain-language example per acceptance test, each under the Contract clause it checks.
 * The server checks every citation against slice.md and the test files, and records digests so a revised design marks the view stale.
 */
export async function updateDesignView(input) {
  assertInput(UPDATE_DESIGN_VIEW_SCHEMA, input);
  const root = await realpath(input.projectRoot);
  const { initiative, slice } = input;
  const design = await designSource(root, initiative, slice);
  if (design.source === null) throw fail("validation_failed", `${design.path} does not exist, so there is no contract to cite.`);
  const clauses = contractClauses(design.source);
  if (!clauses.length) throw fail("validation_failed", `${design.path} has no Contract section with list items to cite.`);
  const accepted = await acceptedDesign(root, initiative, slice);
  const frozen = accepted ? new Set(accepted.frozenTests.map((item) => item.path)) : null;
  const problems = [], files = new Map();
  for (const file of new Set(input.examples.map((item) => item.file))) {
    if (frozen && !frozen.has(file)) { problems.push(`${file} is not a frozen test of the accepted design.`); continue; }
    try {
      const bytes = await readFrozenTestOf(root, initiative, file);
      if (bytes === null) problems.push(`${file} does not exist.`);
      else files.set(file, { sha256: sha256(bytes), content: bytes.toString("utf8") });
    } catch (error) { problems.push(error.message); }
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
    writtenAt: new Date().toISOString(),
    design: { path: design.path, contractSha256: contractDigest(clauses) },
    tests: [...files].map(([file, value]) => ({ path: file, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    examples: input.examples.map(({ clause, file, test, example }) => ({ clause, file, test, example: example.trim() }))
  };
  const key = { kind: "design-view", initiative, slice };
  await withRecordLock(root, key, () => writeRecord(root, key, `${JSON.stringify(document, null, 2)}\n`), fail);
  const cited = new Set(document.examples.map((item) => item.clause));
  const gaps = clauses.map((text, index) => ({ clause: index + 1, text })).filter((item) => !cited.has(item.clause));
  // The designer learns about a diagram the design gate would refuse here, before anyone accepts the design.
  const diagrams = await checkFolderDiagrams(root, path.posix.dirname(design.path));
  const refused = diagramProblems(diagrams);
  return {
    status: "written",
    clauses: clauses.length,
    examples: document.examples.length,
    gaps,
    ...(diagrams.length ? { diagrams: diagrams.filter((item) => item.checked && item.valid).map(({ path: file, elements, relations }) => ({ path: file, elements, relations })) } : {}),
    ...(refused.length ? { diagramProblems: refused } : {})
  };
}

async function storedView(root, initiative, slice) {
  try {
    const { bytes } = await readRecord(root, { kind: "design-view", initiative, slice }, { maxBytes: 4 * 1024 * 1024 });
    return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
  } catch { return { invalid: true }; }
}

const lastSegment = (name) => name.split(/::|\.|#|\//).filter(Boolean).at(-1) ?? name;
const ACTUAL = { ADD: "added", MODIFY: "changed", DELETE: "removed" };

/** Line up a design's planned changes with the change map derived from its verified result. */
export function comparePlannedChanges(changes, concepts) {
  const actual = new Map();
  for (const entry of concepts) {
    const file = (entry.after?.[0] ?? entry.before?.[0])?.path;
    if (!file) continue;
    if (!actual.has(file)) actual.set(file, []);
    actual.get(file).push({ action: entry.action, unit: entry.kind === "file" ? null : entry.label });
  }
  const matched = new Set();
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

export const describeActual = (item) => item.unit ? `${ACTUAL[item.action] ?? item.action} \`${item.unit}\`` : `${ACTUAL[item.action] ?? item.action} the file`;

/**
 * What the review browser shows for a designed slice: the contract's clauses with their examples and gaps,
 * the planned changes, and, once the verified result has a derived change map, planned versus actual.
 */
export async function loadDesignView(projectRoot, initiative, slice, { changeMap = null } = {}) {
  const root = await realpath(projectRoot);
  const design = await designSource(root, initiative, slice).catch(() => ({ source: null }));
  if (design.source === null) return null;
  const clauses = contractClauses(design.source);
  const planned = plannedChanges(design.source);
  if (!clauses.length && !planned.changes.length) return null;
  const stored = await storedView(root, initiative, slice);
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
  const byClause = clauses.map((text, index) => ({ number: index + 1, text, examples: examples.filter((item) => item.clause === index + 1) }));
  const changeProblems = [...planned.problems];
  const verified = Boolean(changeMap);
  if (!verified) {
    for (const change of planned.changes) {
      if (change.action === "add" || change.path.endsWith("/")) continue;
      const found = await stat(path.join(root, change.path)).then(() => true, () => false);
      if (!found) changeProblems.push(`${change.path} is planned to ${change.action} but does not exist.`);
    }
  }
  return {
    path: design.path,
    clauses: byClause,
    examplesWritten: stored && !stored.invalid ? stored.writtenAt ?? null : null,
    gaps: stored && !stale.length ? byClause.filter((clause) => !clause.examples.length).map((clause) => clause.number) : [],
    stale,
    changes: planned.changes,
    changeProblems,
    comparison: verified ? comparePlannedChanges(planned.changes, changeMap.concepts ?? []) : null
  };
}
