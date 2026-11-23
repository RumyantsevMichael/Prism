import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { renameWhenFree, writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, PATTERNS, corresponds, inspectArtifact } from "./artifact-formats.mjs";
import { artifactLocations, artifactTypeOf } from "./artifact-check.mjs";
import { artifactAddress } from "./artifact-paths.mjs";
import { newStatus } from "./artifact-status.mjs";
import { dropReportedFindings } from "./format-findings.mjs";
import { OPEN_STATUSES, allRuns, appliedMigrationIds, artifactName, requireOpen, scopeInputOf, settledRunLaunches, shownMigration, storedRun, withProposalLock, withRunLock, writeRun } from "./migration-runs.mjs";
import { commitStoreFiles, syncRecordStoreNow } from "./record-store-sync.mjs";
import { applyStoreRun, storeArtifactCopy, storeSyncBase } from "./store-artifacts.mjs";
import { normalizeStatement, splitStatements } from "./statements.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";

export { appliedMigrationIds };

// Format migrations: within a migration run that Prism started for a set of nonconforming artifacts, a proposal converts one artifact into its format,
// accounting for every statement of its source, and the run applies all its proposals together, without a person when nothing is lost or invented.
// They live in their run's record under format-migrations/, apart from the move of a checkout's files into a record store, which artifact-migration.mjs performs.

const run = promisify(execFile);
const CONTENT_MAX = 1024 * 1024;
const SUMMARY_MAX = 2000;
const HOME_MAX = 500;
const LEFTOVERS_MAX = 2000;
const CONFLICTS_MAX = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN = "unknown";
const LINK_LIST = /^\[[^\]]*\]\([^)\s]+\)(\s*,\s*\[[^\]]*\]\([^)\s]+\))*\.?$/;
// The store kind of each format type whose artifacts a record store holds; feature files stay in the checkout.
const STORE_KINDS: any = Object.freeze({ requirements: "requirements", adr: "adrs", glossary: "glossary" });
// The labels of each format's field lines, whose values are the statements of those lines.
const FIELDS: any = Object.freeze({
  requirements: ["Status", "Created", "Approved", "Pattern", "Disposition", "Requirement", "Rationale", "Related", "Supersedes"],
  adr: ["Status", "Created", "Accepted", "Supersedes"],
  glossary: ["Source", "Aliases", "Not to be confused with"],
  feature: []
});
// The fields that record a decision, which the decision checks compare rather than the statement checks.
const DECISION_FIELDS = new Set(["Status", "Created", "Approved", "Accepted"]);
const DATE_FIELDS = new Set(["Created", "Approved", "Accepted"]);

export class FormatMigrationError extends Error {
  declare code: any;
  // The details a refusal carries, such as its artifacts.
  [key: string]: any;
  constructor(code: any, message: any, details = {}) {
    super(message);
    this.name = "FormatMigrationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: any, message: any, details?: any) => new FormatMigrationError(code, message, details);
const storeRefusing = async (action: any) => {
  try { return await action(); }
  catch (error) {
    if (error?.name === "FormatMigrationError") throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError", "ArtifactCheckError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components", "artifacts"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
    }
    throw error;
  }
};
const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const formatOf: any = (type: any) => ARTIFACT_FORMATS.filter((entry) => entry.type === type).at(-1);
const label = (entry: any) => entry.scope === null ? entry.path : `${entry.path} in scope ${entry.scope.label}`;
const named = ({ path: file, scope }: any) => ({ path: file, scope });
const sameScope = (left: any, right: any) => (left?.label ?? null) === (right?.label ?? null);
const versionOf = (bytes: any) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// ---- Input ----

function relativePath(value: any, name: any) {
  if (typeof value !== "string" || value === "" || value.length > 1024) throw fail("invalid_input", `${name} must be a project-relative file path.`);
  const file = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file === "." || file === ".." || file.startsWith("../")) throw fail("invalid_input", `${name} ${value} must be relative to the project root and stay inside it.`, { path: value });
  return file;
}

// A source or target: a project-relative path, or { path, scope, component } with scope and component as get_artifact takes them.
function artifactInput(value: any, name: any) {
  if (typeof value === "string") return { path: relativePath(value, name) };
  if (!isRecord(value)) throw fail("invalid_input", `${name} must be a project-relative path or { path, scope, component }.`);
  const extra = Object.keys(value).filter((key) => !["path", "scope", "component"].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes only path, scope, and component, not ${extra.join(", ")}.`);
  if (value.scope !== undefined && typeof value.scope !== "string") throw fail("scope_invalid", `The scope of ${name} must be "workspace", "repository", or "component".`);
  if (value.component !== undefined && typeof value.component !== "string") throw fail("component_unknown", `The component of ${name} must name a component that ## Components in .prism/workflow.md declares.`);
  return { path: relativePath(value.path, name), ...(value.scope === undefined ? {} : { scope: value.scope }), ...(value.component === undefined ? {} : { component: value.component }) };
}

function proposalInput(input: any) {
  if (!isRecord(input)) throw fail("invalid_input", "propose_migration takes an object of arguments.");
  const allowed = ["projectRoot", "run", "type", "source", "target", "content", "summary", "leftovers", "conflicts", "settled", "asked"];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw fail("invalid_input", `propose_migration takes no ${extra.join(", ")}.`);
  if (typeof input.run !== "string" || !input.run) throw fail("invalid_input", "run must be the id of the format migration run that the proposal belongs to, run- and 16 hexadecimal digits.");
  if (!ARTIFACT_TYPES.includes(input.type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > CONTENT_MAX) throw fail("invalid_input", "content must be the whole migrated artifact as text of at most 1 MiB.");
  if (typeof input.summary !== "string" || input.summary.trim().length < 1 || input.summary.length > SUMMARY_MAX) throw fail("invalid_input", `summary must be plain text of 1 to ${SUMMARY_MAX} characters on what changes and why.`);
  if (!Array.isArray(input.leftovers) || input.leftovers.length > LEFTOVERS_MAX) throw fail("invalid_input", `leftovers must be a list of at most ${LEFTOVERS_MAX} { statement, home } entries.`);
  const leftovers = input.leftovers.map((entry: any, index: any) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["statement", "home"].includes(key))) throw fail("invalid_input", `leftovers[${index}] must be { statement, home }.`);
    if (typeof entry.statement !== "string" || !normalizeStatement(entry.statement)) throw fail("invalid_input", `leftovers[${index}].statement must be a statement of the source, verbatim.`);
    if (typeof entry.home !== "string" || entry.home.trim().length < 1 || entry.home.length > HOME_MAX) throw fail("invalid_input", `leftovers[${index}].home must be a proposed home of 1 to ${HOME_MAX} characters.`);
    return { statement: entry.statement, home: entry.home };
  });
  const given = input.conflicts ?? [];
  if (!Array.isArray(given) || given.length > CONFLICTS_MAX) throw fail("invalid_input", `conflicts must be a list of at most ${CONFLICTS_MAX} { entry, content } entries.`);
  const conflicts = given.map((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["entry", "content"].includes(key)) || typeof entry.entry !== "string" || !entry.entry || entry.entry.length > 200 || typeof entry.content !== "string" || Buffer.byteLength(entry.content, "utf8") > CONTENT_MAX) {
      throw fail("invalid_input", `conflicts[${index}] must be { entry, content }, naming an entry of the target and holding the source's version of it.`);
    }
    return { entry: entry.entry, content: entry.content };
  });
  if (new Set(conflicts.map((entry) => entry.entry)).size !== conflicts.length) throw fail("invalid_input", "Each entry may have at most one conflict.");
  return {
    run: input.run, type: input.type, source: artifactInput(input.source, "source"), target: artifactInput(input.target, "target"), content: input.content, summary: input.summary, leftovers, conflicts,
    settled: pointList(input.settled, "settled", "reason").map(({ point, text }: any) => ({ point, text })), asked: pointList(input.asked, "asked", "recommendation").map(({ point, text }: any) => ({ point, text }))
  };
}

// ---- Artifacts ----

// Whether a project-relative path is a store artifact of a project with a store: a path under the configured store artifact paths.
const storePath = (config: any, file: any) => artifactAddress(artifactKinds(config), file) !== null;

/**
 * Reads a source or target where Prism keeps it: { path, scope, store, text, bytes, version, status, component },
 * with scope null and status null for a checkout file, and text, bytes, and version null where no file is held.
 */
async function readArtifact(root: any, config: any, entry: any, { store, kind }: any) {
  if (!store) {
    if (entry.scope !== undefined || entry.component !== undefined) throw fail("scope_invalid", `${entry.path} is a checkout file, so it takes no scope.`, { path: entry.path });
    const bytes = await checkoutFile(root, entry.path) ? await readFile(path.join(root, entry.path)).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }) : null;
    return { path: entry.path, scope: null, store: false, bytes, text: bytes === null ? null : bytes.toString("utf8"), version: bytes === null ? null : versionOf(bytes), status: null };
  }
  const copy = await storeRefusing(() => storeArtifactCopy(root, entry.path, { ...(entry.scope === undefined ? {} : { scope: entry.scope }), ...(entry.component === undefined ? {} : { component: entry.component }) }));
  if (kind !== undefined && copy.kind !== kind) throw fail("invalid_input", `${entry.path} is no artifact of the kind ${kind}.`, { path: entry.path });
  const held = copy.held;
  return { path: copy.path, scope: copy.scope, store: true, bytes: held?.bytes ?? null, text: held === null ? null : Buffer.from(held.bytes).toString("utf8"), version: held?.version ?? null, status: held?.status ?? null };
}

/**
 * Whether a checkout path holds a regular file inside the project: true when it does, false when nothing is there.
 * A path through a symbolic link at any folder or at the file itself is refused with artifact_outside, and one that holds no regular file with invalid_path,
 * as the move of checkout files into the store refuses them, so a migration never reads, writes, or removes a file outside the project.
 */
async function checkoutFile(root: any, file: any) {
  const parts = file.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
    if (info === null) return false;
    if (info.isSymbolicLink()) throw fail("artifact_outside", `${file} passes through the symbolic link ${parts.slice(0, index + 1).join("/")}, so a format migration does not read, write, or remove it.`, { path: file });
    const last = index === parts.length - 1;
    if (!last && !info.isDirectory()) return false;
    if (last && !info.isFile()) throw fail("invalid_path", `${file} is no regular file, so a format migration does not read, write, or remove it.`, { path: file });
  }
  return true;
}

// The dates of a checkout path's Git history, as author and committer dates; a path Git does not know has none.
async function historyDates(root: any, file: any) {
  try {
    const { stdout } = await run("git", ["log", "--follow", "--format=%as%n%cs", "--", file], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return new Set(stdout.split("\n").map((line) => line.trim()).filter((line) => DATE.test(line)));
  } catch {
    return new Set();
  }
}

// ---- Structure ----

const headerValue = (text: any, name: any) => {
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) return null;
    const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return null;
};

// The identities an artifact holds: requirement section numbers, glossary term ids, or feature Rule titles.
function identities(type: any, text: any) {
  const found = new Set();
  const lines = text.split(/\r?\n/);
  if (type === "requirements") {
    for (const line of lines) {
      const anchor = /^<a id="(\d+)"><\/a>\s*$/.exec(line) ?? /^## (\d+)(?:\.|\s|$)/.exec(line);
      if (anchor) found.add(anchor[1]);
    }
  } else if (type === "glossary") {
    for (const line of lines) {
      const anchor = /^<a id="([^"]+)"><\/a>\s*$/.exec(line);
      if (anchor) found.add(anchor[1]);
    }
  } else if (type === "feature") {
    for (const line of lines) {
      const rule = /^\s*Rule:\s*(.*?)\s*$/.exec(line);
      if (rule) found.add(rule[1]);
    }
  }
  return found;
}

/**
 * The entries of an artifact by identity: a requirement section by number, a glossary term by id, or a feature Rule by title,
 * as [{ id, from, to, end }], where lines from to to - 1 hold the entry without its trailing blank lines and end is the line after them.
 */
function entriesOf(type: any, text: any) {
  const lines = text.split("\n");
  const starts: any[] = [];
  for (const [index, line] of lines.entries()) {
    if (type === "glossary") {
      const anchor = /^<a id="([^"]+)"><\/a>\s*$/.exec(line);
      if (anchor) starts.push({ id: anchor[1], from: index });
      else if (/^## /.test(line) && !/^<a id=/.test(lines[index - 1] ?? "")) starts.push({ id: null, from: index });
    } else if (type === "requirements") {
      const anchor = /^<a id="(\d+)"><\/a>\s*$/.exec(line);
      const heading = /^## (\d+)(?:\.|\s|$)/.exec(line);
      if (anchor) starts.push({ id: anchor[1], from: index });
      else if (heading && !/^<a id=/.test(lines[index - 1] ?? "")) starts.push({ id: heading[1], from: index });
      else if (/^## /.test(line) && !heading) starts.push({ id: null, from: index });
    } else if (type === "feature") {
      const rule = /^\s*Rule:\s*(.*?)\s*$/.exec(line);
      if (rule) starts.push({ id: rule[1], from: index });
    }
  }
  return starts.map((start, position) => {
    const end = starts[position + 1]?.from ?? lines.length;
    let to = end;
    while (to > start.from && lines[to - 1].trim() === "") to -= 1;
    return { id: start.id, from: start.from, to, end, text: lines.slice(start.from, to).join("\n") };
  }).filter((entry) => entry.id !== null);
}

const sameEntry = (left: any, right: any) => left.split("\n").map((line: any) => line.trimEnd()).join("\n").trim() === right.split("\n").map((line: any) => line.trimEnd()).join("\n").trim();

// The content with one entry's lines replaced by the given text, keeping the blank lines that followed it.
function replaceEntry(type: any, content: any, id: any, replacement: any) {
  const entry = entriesOf(type, content).find((item) => item.id === id);
  if (!entry) return null;
  const lines = content.split("\n");
  const own = replacement.replace(/\s+$/, "").split("\n");
  return [...lines.slice(0, entry.from), ...own, ...lines.slice(entry.to)].join("\n");
}

const findingsOf = (type: any, text: any) => inspectArtifact(type, text, { context: { proposal: true } });

// ---- Statements ----

const statementsOf = (type: any, text: any) => splitStatements(text, { gherkin: type === "feature", fields: FIELDS[type] });

/** The statements of a source that a migration must account for: field values that record a decision, unknown values, and format defaults are none. */
function sourceStatements(type: any, text: any) {
  const defaults = formatOf(type).defaults;
  return statementsOf(type, text).filter((statement) => {
    const value = normalizeStatement(statement.text);
    if (!value || value === UNKNOWN) return false;
    if (statement.field && DECISION_FIELDS.has(statement.field)) return false;
    if (statement.field && (value === "n/a" || defaults[statement.field] === value)) return false;
    return true;
  });
}

// Whether a content statement needs no source: the format's structure, a default, unknown, a link, a glossary source, the pattern of a split-out requirement section, or a date that the source or its Git history gives.
// A Status value needs no source when it is the type's new status or the status a source or target records or states; a date when the source's Git history gives it or a source or target states it in the same field.
function needsNoSource(type: any, statement: any, { dates, known, splitOut = false }: any) {
  const value = normalizeStatement(statement.text);
  const raw = statement.text.trim();
  if (!value || value === UNKNOWN || value === "n/a") return true;
  const defaults = formatOf(type).defaults;
  if (statement.field && defaults[statement.field] === value) return true;
  if (statement.field === "Status") return value === newStatus(STORE_KINDS[type]) || known.some((artifact: any) => artifact.status === value || headerValue(artifact.text, "Status") === value);
  if (statement.field && DATE_FIELDS.has(statement.field)) return DATE.test(value) && (dates.has(value) || known.some((artifact: any) => headerValue(artifact.text, statement.field) === value));
  if (statement.field && DECISION_FIELDS.has(statement.field)) return false;
  // A requirement split out into a new numbered section takes the Pattern of its own sentence, one of the format's patterns.
  if (type === "requirements" && splitOut && statement.field === "Pattern" && PATTERNS.includes(value)) return true;
  if (statement.field && LINK_LIST.test(raw)) return true;
  if (type === "glossary" && statement.field === "Source" && /^(?:migration(?:\s+migration-[0-9a-f]+)?|\[[^\]]*\]\([^)\s]+\))(\s*,\s*(?:migration(?:\s+migration-[0-9a-f]+)?|\[[^\]]*\]\([^)\s]+\)))*$/.test(raw)) return true;
  return false;
}

// ---- Diffs ----

const linesOf = (text: any) => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

// The line edits from one text to another: [{ op: " " | "-" | "+", line }], by the longest common subsequence of the lines between a common head and tail.
function lineEdits(before: any, after: any) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const middle = [];
  if (a.length * b.length <= 4_000_000) {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { middle.push({ op: " ", line: a[i] }); i += 1; j += 1; }
      else if (table[i + 1][j] >= table[i][j + 1]) middle.push({ op: "-", line: a[i++] });
      else middle.push({ op: "+", line: b[j++] });
    }
    while (i < a.length) middle.push({ op: "-", line: a[i++] });
    while (j < b.length) middle.push({ op: "+", line: b[j++] });
  } else {
    middle.push(...a.map((line: any) => ({ op: "-", line })), ...b.map((line: any) => ({ op: "+", line })));
  }
  return [...before.slice(0, head).map((line: any) => ({ op: " ", line })), ...middle, ...before.slice(before.length - tail).map((line: any) => ({ op: " ", line }))];
}

/** A unified diff from one text to another with three lines of context, or "" when they hold the same lines. */
export function unifiedDiff(before: any, after: any, { from = "a", to = "b", context = 3 }: any = {}) {
  const edits = lineEdits(linesOf(before), linesOf(after));
  if (!edits.some((edit) => edit.op !== " ")) return "";
  const out = [`--- ${from}`, `+++ ${to}`];
  let index = 0;
  while (index < edits.length) {
    if (edits[index].op === " ") { index += 1; continue; }
    let start = Math.max(0, index - context);
    let end = index;
    while (end < edits.length) {
      if (edits[end].op !== " ") { end += 1; continue; }
      let run = end;
      while (run < edits.length && edits[run].op === " ") run += 1;
      if (run === edits.length || run - end > 2 * context) { end = Math.min(edits.length, end + context); break; }
      end = run;
    }
    let oldStart = 1, newStart = 1;
    for (const edit of edits.slice(0, start)) { if (edit.op !== "+") oldStart += 1; if (edit.op !== "-") newStart += 1; }
    const hunk = edits.slice(start, end);
    const oldCount = hunk.filter((edit) => edit.op !== "+").length, newCount = hunk.filter((edit) => edit.op !== "-").length;
    out.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
    for (const edit of hunk) out.push(`${edit.op}${edit.line}`);
    index = end;
  }
  return `${out.join("\n")}\n`;
}

// ---- Points ----

const POINT_KINDS = new Set(["leftover", "entry", "unknown", "conflict", "remove-source"]);
// Derived points are Prism's own, from the content, the conflicts, and a separate source: each is asked, never settled.
const DERIVED = new Set(["unknown", "conflict", "remove-source"]);
const TEXT_MAX = 500;

// The identity of a point within one migration, by its kind and the detail that names it.
function pointKey(point: any) {
  if (point.kind === "leftover") return `leftover\0${normalizeStatement(point.statement ?? "")}`;
  if (point.kind === "entry" || point.kind === "conflict") return `${point.kind}\0${point.entry}`;
  if (point.kind === "unknown") return `unknown\0${point.line}\0${point.field}`;
  return point.kind;
}

// A point as settled and asked name it: { kind, ...detail }, where only the detail that names it counts.
function pointReference(value: any, name: any) {
  if (!isRecord(value) || !POINT_KINDS.has(value.kind)) throw fail("invalid_input", `${name} must be a point { kind, ...detail } as a migration_unsettled refusal lists it, with kind leftover, entry, unknown, conflict, or remove-source.`);
  const extra = Object.keys(value).filter((key) => !["kind", "statement", "entry", "line", "field", "allowsUnknown", "id", "settled", "asked"].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes no ${extra.join(", ")}.`);
  if (value.kind === "leftover" && typeof value.statement !== "string") throw fail("invalid_input", `${name} is a leftover point, which names its statement.`);
  if ((value.kind === "entry" || value.kind === "conflict") && typeof value.entry !== "string") throw fail("invalid_input", `${name} is an ${value.kind} point, which names its entry.`);
  if (value.kind === "unknown" && (!Number.isInteger(value.line) || typeof value.field !== "string")) throw fail("invalid_input", `${name} is an unknown point, which names its line and field.`);
  return value;
}

function pointList(value: any, name: any, textName: any) {
  const given = value ?? [];
  if (!Array.isArray(given) || given.length > LEFTOVERS_MAX) throw fail("invalid_input", `${name} must be a list of at most ${LEFTOVERS_MAX} { point, ${textName} } entries.`);
  return given.map((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["point", textName].includes(key))) throw fail("invalid_input", `${name}[${index}] must be { point, ${textName} }.`);
    const text = entry[textName];
    if (typeof text !== "string" || text.trim().length < 1 || text.length > TEXT_MAX) throw fail("invalid_input", `${name}[${index}].${textName} must be text of 1 to ${TEXT_MAX} characters.`);
    return { point: pointReference(entry.point, `${name}[${index}].point`), text };
  });
}

const pointDetail = ({ id, settled, asked, ...detail }: any) => detail;

// ---- Sections ----

// The headings that hold each line of a text, by 1-based line: { h2, h3 }, each a heading's text without its # marks, or null before the first one.
function sectionsOf(text: any) {
  const lines = text.split(/\r?\n/);
  const held: any[] = [null];
  let h2: string | null = null, h3: string | null = null;
  for (const line of lines) {
    const heading = /^\s{0,3}(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (heading[1].length === 2) { h2 = heading[2]; h3 = null; } else h3 = heading[2];
    }
    held.push({ h2, h3, line });
  }
  return held;
}

// A table row's first cell, or a list item's leading name, which a glossary term heading also takes.
function leadingName(line: any) {
  if (/^\s*\|/.test(line)) return normalizeStatement(line.trim().replace(/^\|/, "").split("|")[0] ?? "");
  const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!item) return null;
  const name = /^(?:\*\*|__)?(.+?)(?:\*\*|__)?\s*(?::|\s[-–—]\s)/.exec(item[1]);
  return name ? normalizeStatement(name[1]) : null;
}

// ---- Splits of requirement sections ----

// A numbered heading's number and folded title, or null.
const numberedHeading = (heading: any) => {
  const match = heading === null || heading === undefined ? null : /^(\d+)\.\s+(\S.*?)\s*$/.exec(heading);
  return match ? { number: match[1], title: match[2].replace(/\s+/g, " ").toLowerCase() } : null;
};

// The numbered sections of a requirement text by number: { heading, title, first }, where first is the section's first requirement,
// its first Requirement sentence that says shall, else its first Requirement sentence, normalized, or null.
function numberedSections(text: any) {
  const held = sectionsOf(text);
  const result = new Map();
  for (const entry of held.slice(1)) {
    const heading = numberedHeading(entry?.h2);
    if (heading && !result.has(heading.number)) result.set(heading.number, { heading: entry.h2, title: heading.title, requirements: [] });
  }
  for (const statement of statementsOf("requirements", text)) {
    if (statement.field !== "Requirement") continue;
    const section = result.get(numberedHeading(held[statement.line]?.h2)?.number);
    if (section) section.requirements.push(normalizeStatement(statement.text));
  }
  for (const section of result.values()) section.first = section.requirements.find((text: any) => /\bshall\b/i.test(text)) ?? section.requirements[0] ?? null;
  return result;
}

/**
 * Whether the content heading `to` is a section split out of the source's numbered section `from`, given both texts' numbered sections:
 * a number the source does not use, section `from`'s title, and the content still holds section `from` under its number and title, beginning with its first requirement.
 */
function splitTarget(source: any, target: any, from: any, to: any) {
  const [left, right] = [numberedHeading(from), numberedHeading(to)];
  if (left === null || right === null || left.title !== right.title || source.has(right.number)) return false;
  const original = source.get(left.number), kept = target.get(left.number);
  return Boolean(original && kept && kept.title === original.title && kept.first === original.first);
}

// The numbered sections of a requirement source and its content, or null for another type.
const splitSides = (type: any, sourceText: any, content: any) => type === "requirements" ? { source: numberedSections(sourceText), target: numberedSections(content) } : null;

/** The content's split-out requirement sections, by heading text: each numbered section that splitTarget takes as split out of a source section. */
function splitOutSections(type: any, sourceText: any, content: any) {
  const found = new Set();
  const sides = splitSides(type, sourceText, content);
  if (!sides) return found;
  for (const section of sides.target.values()) {
    if ([...sides.source.values()].some((original: any) => splitTarget(sides.source, sides.target, original.heading, section.heading))) found.add(section.heading);
  }
  return found;
}

/**
 * The source statements that the content moves to a section that does not correspond to the one they came from, as [{ text, line, from, to }],
 * or to a section other than the one a person's answer named; statements the content does not hold are placed elsewhere and not compared here.
 */
function misplacedStatements(type: any, sourceText: any, content: any, statements: any, { named = new Map() }: any = {}) {
  const sourceSections = sectionsOf(sourceText);
  const contentSections: any = sectionsOf(content);
  const contentStatements = statementsOf(type, content).map((statement) => ({ ...statement, normalized: normalizeStatement(statement.text) }));
  const headings = contentSections.slice(1).map((entry: any, index: any) => ({ ...entry, number: index + 1 })).filter((entry: any) => /^\s{0,3}#{2,3}\s/.test(entry.line));
  const misplaced = [];
  // A requirement split out of a numbered section lands in a new numbered section under that section's title, while the section keeps its number and first requirement.
  const sides = splitSides(type, sourceText, content);
  const splitInto = (from: any, to: any) => sides !== null && splitTarget(sides.source, sides.target, from, to);
  for (const statement of statements) {
    const value = normalizeStatement(statement.text);
    let places = contentStatements.filter((item) => item.normalized === value).map((item) => contentSections[item.line]?.h2 ?? null);
    if (!places.length) places = contentStatements.filter((item) => item.normalized.includes(value)).map((item) => contentSections[item.line]?.h2 ?? null);
    if (!places.length) places = headings.filter((entry: any) => normalizeStatement(entry.line.replace(/^\s*#+\s*/, "")) === value).map((entry: any) => entry.line.replace(/^\s*#+\s*/, "").trim());
    if (!places.length) continue;
    const held = sourceSections[statement.line] ?? { h2: null, h3: null, line: "" };
    const from = [held.h2, held.h3, ...(type === "glossary" ? [leadingName(held.line)] : [])].filter((entry, index) => index === 0 || entry);
    const wanted = named.get(value);
    const fits = (to: any) => wanted !== undefined ? to !== null && normalizeStatement(to).toLowerCase() === normalizeStatement(wanted).toLowerCase() : from.some((section) => corresponds(type, section, to)) || splitInto(held.h2, to);
    if (places.some(fits)) continue;
    misplaced.push({ text: statement.text, line: statement.line, from: held.h2, to: places[0] });
  }
  return misplaced;
}

// ---- Proposing ----

/**
 * Propose a format migration of one artifact of a run's set: every source statement must occur in the content, a leftover, a conflict, or a source entry that means the same as the target's,
 * no content statement may be invented, a moved statement must land in a corresponding section, the content must conform apart from unknown values,
 * keep the decisions of an Approved or Accepted source or target and the entries of an existing target, and every point must be settled or asked.
 * A proposal of a source replaces the run's earlier proposal of it. Returns { migration } as get_migration_run lists it.
 */
export async function proposeMigration(input: any) {
  const given = proposalInput(input);
  const root = await realpath(input.projectRoot);
  // A session of the run that this process is launching starts before the run takes a proposal, as it would for the session's own call.
  await settledRunLaunches(root);
  const known = await storedRun(root, given.run);
  requireOpen(known);
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  const { type } = given;
  if (artifactTypeOf(locations, given.target.path) !== type) throw fail("invalid_input", `The target ${given.target.path} lies under no configured path of the type ${type}.`, { path: given.target.path });
  const hasStore = (config.workspace?.store ?? null) !== null;
  const targetInStore = hasStore && type !== "feature" && storePath(config, given.target.path);
  const sourceInStore = hasStore && storePath(config, given.source.path);
  const source = await readArtifact(root, config, given.source, { store: sourceInStore });
  if (!known.set.artifacts.some((artifact: any) => artifact.path === source.path && sameScope(artifact.scope, source.scope))) {
    throw fail("invalid_input", `The source ${label(source)} is no artifact of the format migration run ${known.id}, whose set holds ${known.set.artifacts.map(artifactName).join(", ")}.`, { path: source.path });
  }
  if (source.text === null) throw fail("artifact_missing", `The source ${label(source)} does not exist.`, { path: source.path });
  // Only a target named as the source is, by path, scope, and component, is the source itself; a target at the source's path in another named scope is read as a target of its own.
  const inPlace = given.source.path === given.target.path && given.source.scope === given.target.scope && given.source.component === given.target.component && sourceInStore === targetInStore;
  const read = inPlace ? source : await readArtifact(root, config, given.target, { store: targetInStore, kind: targetInStore ? STORE_KINDS[type] : undefined });
  const target = read.store === source.store && read.path === source.path && sameScope(read.scope, source.scope) ? source : read;
  const separateSource = !(target.path === source.path && sameScope(target.scope, source.scope));
  const existing = separateSource && target.text !== null ? target : null;
  const content = given.content;

  return storeRefusing(() => withProposalLock(root, () => withRunLock(root, known.id, async () => {
    const run = await storedRun(root, known.id);
    requireOpen(run);
    // Another open run's proposal of the target holds it, and so does another source's proposal of it in this run, since each proposal holds the whole target.
    const holds = (migration: any) => migration.target.path === target.path && sameScope(migration.target.scope, target.scope);
    const ownOther = run.migrations.find((migration: any) => holds(migration) && !(migration.source.path === source.path && sameScope(migration.source.scope, source.scope)));
    if (ownOther) throw fail("migration_pending", `The format migration ${ownOther.id} of ${label(ownOther.source)} in this run already writes ${label(target)}, so another source cannot be migrated into it in the same run.`, { id: ownOther.id, run: run.id });
    // A run applies its proposals together, so no proposal's target may be another proposal's separate source, which the run removes, and no separate source may be another proposal's target:
    // a chain such as X into Y and Y into Z would remove Y after X was written into it, and X's statements would reach no file.
    const isSource = (migration: any, artifact: any) => migration.source.path === artifact.path && sameScope(migration.source.scope, artifact.scope);
    const others = run.migrations.filter((migration: any) => !isSource(migration, source));
    const removed = others.find((migration: any) => migration.separateSource && isSource(migration, target));
    if (removed) throw fail("migration_pending", `The format migration ${removed.id} in this run migrates ${label(target)} into ${label(removed.target)} and removes it, so ${label(target)} cannot also be the target of another migration in the same run.`, { id: removed.id, run: run.id });
    const into = separateSource ? others.find((migration: any) => migration.target.path === source.path && sameScope(migration.target.scope, source.scope)) : null;
    if (into) throw fail("migration_pending", `The format migration ${into.id} of ${label(into.source)} in this run writes ${label(source)}, so ${label(source)} cannot also be migrated into another file and removed in the same run.`, { id: into.id, run: run.id });
    for (const other of await allRuns(root)) {
      if (other.id === run.id || !OPEN_STATUSES.has(other.status) && other.status !== "asking" && other.status !== "waiting-for-host") continue;
      const holding = other.migrations.find(holds);
      if (holding) throw fail("migration_pending", `The format migration ${holding.id} of the open run ${other.id} writes ${label(target)}, so this run cannot propose another one until that run ends.`, { id: holding.id, run: other.id });
    }

    // The content conforms to its format, unknown values aside.
    const checked = findingsOf(type, content);
    if (checked.findings.length) {
      const rules = [...new Set(checked.findings.map((finding: any) => finding.rule))].join(", ");
      throw fail("artifact_nonconforming", `The content breaks the ${type} format of ${label(target)} (${rules}), so it cannot be proposed: ${checked.findings.map((finding: any) => finding.message).join(" ")}`, { artifacts: [{ ...named(target), type, findings: checked.findings }] });
    }

    // A decided source or target keeps its status, dates, and identities.
    const changed: any[] = [];
    const note = (change: any) => { if (!changed.some((item) => item.field === change.field && item.before === change.before)) changed.push(change); };
    const decidedStatus = (artifact: any) => artifact.store ? artifact.status : headerValue(artifact.text, "Status");
    for (const before of [source, existing].filter(Boolean) as any[]) {
      const status = decidedStatus(before);
      if (status !== "Approved" && status !== "Accepted") continue;
      for (const field of ["Status", "Created", "Approved"]) {
        const was = field === "Status" ? status : headerValue(before.text, field);
        if (was === null) continue;
        const now = headerValue(content, field);
        if (now !== was) note({ field, before: was, after: now });
      }
      const kept = identities(type, content);
      for (const id of identities(type, before.text)) if (!kept.has(id)) note({ field: "identity", before: id, after: null });
    }
    // A store target's Status: line is its recorded status, which only a person's answer at a gate changes.
    let expectedStatus = null;
    if (targetInStore && (type === "requirements" || type === "adr")) {
      expectedStatus = target.text !== null ? target.status : source.store && source.text !== null && source.status !== null && storeKindOfPath(config, source.path) === STORE_KINDS[type] ? source.status : newStatus(STORE_KINDS[type]);
      const written = headerValue(content, "Status");
      if (expectedStatus !== null && written !== expectedStatus) note({ field: "Status", before: expectedStatus, after: written });
    }
    if (changed.length) {
      throw fail("migration_changes_decision", `The content changes what a person decided for ${label(source)}${existing ? ` or ${label(existing)}` : ""}: ${changed.map((change) => `${change.field} ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}`).join(", ")}. Keep the status, the Created and Approved dates, and every identity as recorded; only a person's answer at a gate changes them.`, { changed });
    }

    // The entries of an existing target stay unchanged, and the source's differing version of one goes under conflicts or is a point that says it means the same.
    const conflicts = [];
    const entryPoints: any[] = [];
    if (existing && entriesOf(type, existing.text).length) {
      const targetEntries = entriesOf(type, existing.text);
      const contentEntries = entriesOf(type, content);
      const rewritten = targetEntries.filter((entry) => {
        const kept = contentEntries.filter((item) => item.id === entry.id);
        return kept.length !== 1 || !sameEntry(kept[0].text, entry.text);
      }).map((entry) => entry.id);
      const wrong = [];
      for (const conflict of given.conflicts) {
        const entry = targetEntries.find((item) => item.id === conflict.entry);
        const own = entriesOf(type, conflict.content);
        const substituted = entry ? replaceEntry(type, content, conflict.entry, conflict.content) : null;
        if (!entry || own.length !== 1 || own[0].id !== conflict.entry || substituted === null || findingsOf(type, substituted).findings.length) wrong.push(conflict.entry);
        else conflicts.push({ entry: conflict.entry, target: entry.text, source: conflict.content });
      }
      if (rewritten.length || wrong.length) {
        const parts = [];
        if (rewritten.length) parts.push(`the content changes or drops the target's ${rewritten.length === 1 ? "entry" : "entries"} ${rewritten.join(", ")}, which must stay as the target holds ${rewritten.length === 1 ? "it" : "them"}, with the source's version under conflicts`);
        if (wrong.length) parts.push(`the ${wrong.length === 1 ? "conflict" : "conflicts"} ${wrong.join(", ")} ${wrong.length === 1 ? "names" : "name"} no entry of the target or ${wrong.length === 1 ? "does" : "do"} not hold one conforming entry of that identity`);
        throw fail("migration_conflict", `The proposal for ${label(target)} conflicts with the target's entries: ${parts.join("; ")}.`, { entries: [...new Set([...rewritten, ...wrong])] });
      }
      for (const entry of entriesOf(type, source.text)) {
        const held = targetEntries.find((item) => item.id === entry.id);
        if (held && !sameEntry(held.text, entry.text) && !conflicts.some((conflict) => conflict.entry === entry.id)) entryPoints.push(entry);
      }
    } else if (given.conflicts.length) {
      throw fail("migration_conflict", `The target ${label(target)} holds no entries, so the conflicts ${given.conflicts.map((conflict) => conflict.entry).join(", ")} name no entry of it.`, { entries: given.conflicts.map((conflict) => conflict.entry) });
    }

    // Every leftover is a statement of the source, verbatim.
    const normalizedSource = normalizeStatement(source.text);
    for (const [index, leftover] of given.leftovers.entries()) {
      if (!normalizedSource.includes(normalizeStatement(leftover.statement))) throw fail("invalid_input", `leftovers[${index}].statement is not a statement of the source ${label(source)}: ${JSON.stringify(leftover.statement)}.`);
    }

    // Every source statement occurs in the content, a leftover, a conflict, or a source entry that a point says means the same as the target's.
    const inEntryPoint = (statement: any) => entryPoints.some((entry) => statement.line - 1 >= entry.from && statement.line - 1 < entry.to);
    const statements = sourceStatements(type, source.text);
    const placed = [normalizeStatement(content), ...given.leftovers.map((leftover: any) => normalizeStatement(leftover.statement)), ...conflicts.map((conflict) => normalizeStatement(conflict.source))];
    const unaccounted = statements.filter((statement) => !inEntryPoint(statement) && !placed.some((text) => text.includes(normalizeStatement(statement.text))));
    if (unaccounted.length) {
      throw fail("migration_unaccounted", `${unaccounted.length === 1 ? "A statement" : `${unaccounted.length} statements`} of ${label(source)} ${unaccounted.length === 1 ? "occurs" : "occur"} in neither the content, a leftover, nor a conflict: ${unaccounted.map((statement) => `line ${statement.line}: ${JSON.stringify(statement.text)}`).join("; ")}. Place each one, or list it as a leftover with its proposed home.`, { statements: unaccounted.map(({ text, line }: any) => ({ text, line })) });
    }

    // No statement of the content or a conflict is invented: each is a statement of the source or an existing target, compared statement to statement,
    // and a field that records a decision passes only by the rules of needsNoSource.
    const knownArtifacts = [source, ...(existing ? [existing] : [])];
    const knownStatements = new Set(knownArtifacts.flatMap((artifact) => statementsOf(type, artifact.text)).map((statement) => normalizeStatement(statement.text)));
    const dates = await historyDates(root, source.path);
    const splitOut = splitOutSections(type, source.text, content);
    const contentHeadings = sectionsOf(content);
    const inSplitOut = (statement: any) => splitOut.has(contentHeadings[statement.line]?.h2);
    const invented = [
      ...statementsOf(type, content).map((statement) => ({ statement, splitOut: inSplitOut(statement) })),
      ...conflicts.flatMap((conflict) => statementsOf(type, conflict.source).map((statement) => ({ statement, splitOut: false })))
    ].filter(({ statement, splitOut: split }) => !needsNoSource(type, statement, { dates, known: knownArtifacts, splitOut: split }) && (DECISION_FIELDS.has(statement.field) || !knownStatements.has(normalizeStatement(statement.text))))
      .map(({ statement }) => statement);
    if (invented.length) {
      throw fail("migration_invented", `${invented.length === 1 ? "A statement" : `${invented.length} statements`} of the content ${invented.length === 1 ? "occurs" : "occur"} in neither ${label(source)} nor the target: ${invented.map((statement) => `line ${statement.line}: ${JSON.stringify(statement.text)}`).join("; ")}. Write only what the source says, and mark a value that neither the source nor its Git history gives as unknown.`, { statements: invented.map(({ text, line }: any) => ({ text, line })) });
    }

    // A statement the content moves lands in the section that corresponds to its source section.
    // A leftover that the person's answer placed in a named section must land there.
    const answered = new Map();
    const before = run.migrations.find((migration: any) => migration.source.path === source.path && sameScope(migration.source.scope, source.scope));
    for (const point of before?.points ?? []) {
      const answer = run.answers?.[point.id];
      if (point.kind === "leftover" && isRecord(answer) && typeof answer.value === "string" && answer.value.trim()) answered.set(normalizeStatement(point.statement), answer.value.replace(/^#+\s*/, ""));
    }
    const misplaced = misplacedStatements(type, source.text, content, statements.filter((statement) => !inEntryPoint(statement)), { named: answered });
    if (misplaced.length) {
      throw fail("migration_misplaced", `${misplaced.length === 1 ? "A statement" : `${misplaced.length} statements`} of ${label(source)} ${misplaced.length === 1 ? "moves" : "move"} to a section that does not correspond to the one ${misplaced.length === 1 ? "it comes" : "they come"} from: ${misplaced.map((statement) => `line ${statement.line}: ${JSON.stringify(statement.text)} from ${statement.from === null ? "the text before the first section" : statement.from} to ${statement.to === null ? "the text before the first section" : statement.to}`).join("; ")}. Keep each one in the section of the format that corresponds to its own, or list it as a leftover.`, { statements: misplaced });
    }

    // Every point is settled or asked: leftovers and source entries that mean the same may be either, and Prism's derived points are always asked.
    const allowsUnknown = (type === "requirements" && (expectedStatus ?? headerValue(content, "Status")) === "Draft") || (type === "adr" && (expectedStatus ?? headerValue(content, "Status")) === "Proposed");
    const points = [
      ...given.leftovers.map((leftover: any) => ({ kind: "leftover", statement: leftover.statement })),
      ...entryPoints.map((entry) => ({ kind: "entry", entry: entry.id })),
      ...checked.unknowns.map((unknown: any) => ({ kind: "unknown", line: unknown.line, field: unknown.field, allowsUnknown })),
      ...conflicts.map((conflict) => ({ kind: "conflict", entry: conflict.entry })),
      ...(separateSource ? [{ kind: "remove-source" }] : [])
    ];
    const keys = new Map(points.map((point) => [pointKey(point), point]));
    for (const [name, list] of [["settled", given.settled], ["asked", given.asked]] as [string, any[]][]) {
      for (const [index, item] of list.entries()) if (!keys.has(pointKey(item.point))) throw fail("invalid_input", `${name}[${index}].point names no point of this proposal; the points are ${points.map((point) => JSON.stringify(point)).join(", ") || "none"}.`);
    }
    const settledBy = new Map(given.settled.map((item) => [pointKey(item.point), item.text]));
    const askedBy = new Map(given.asked.map((item) => [pointKey(item.point), item.text]));
    const unsettled = points.filter((point) => {
      const key = pointKey(point);
      if (DERIVED.has(point.kind)) return !askedBy.has(key) || settledBy.has(key);
      return !askedBy.has(key) && !settledBy.has(key);
    });
    if (unsettled.length) {
      throw fail("migration_unsettled", `${unsettled.length === 1 ? "A point" : `${unsettled.length} points`} of the proposal for ${label(source)} ${unsettled.length === 1 ? "is" : "are"} neither settled nor asked: ${unsettled.map((point) => JSON.stringify(point)).join(", ")}. Settle a leftover or an entry under settled with the reason it loses nothing, or ask the person under asked with your recommendation; an unknown value, a conflict, and a separate source's removal are always asked.`, { points: unsettled });
    }

    // A replacing proposal of the source keeps its migration's id and each point's id, so a person's view of the run stays stable.
    const earlier = run.migrations.find((migration: any) => migration.source.path === source.path && sameScope(migration.source.scope, source.scope));
    let nextPoint = Number.isInteger(run.nextPoint) && run.nextPoint > 0 ? run.nextPoint : 1;
    const earlierIds = new Map((earlier?.points ?? []).map((point: any) => [pointKey(point), point.id]));
    const shownPoints = points.map((point) => {
      const key = pointKey(point);
      const id = earlierIds.get(key) ?? `p${nextPoint++}`;
      return { id, ...point, settled: settledBy.has(key) ? { reason: settledBy.get(key) } : null, asked: askedBy.has(key) ? { recommendation: askedBy.get(key) } : null };
    });
    const migration: any = {
      id: earlier?.id ?? `migration-${randomBytes(8).toString("hex")}`, run: run.id, type, source: named(source), target: named(target), separateSource, summary: given.summary,
      diff: unifiedDiff(source.text, content, { from: `a/${source.path}`, to: `b/${target.path}` }),
      targetDiff: existing ? unifiedDiff(existing.text, content, { from: `a/${target.path}`, to: `b/${target.path}` }) : null,
      leftovers: given.leftovers, unknowns: checked.unknowns, conflicts, points: shownPoints, status: "proposed", proposedAt: new Date().toISOString(),
      content, sourceText: source.text, versions: { source: source.version, target: target.version }, sourceStore: source.store, targetStore: target.store
    };
    migration.digest = proposedDigest(migration);
    const migrations = earlier ? run.migrations.map((item: any) => item === earlier ? migration : item) : [...run.migrations, migration];
    await writeRun(root, { ...run, migrations, nextPoint });
    return { migration: shownMigration(migration) };
  })));
}

const storeKindOfPath = (config: any, file: any) => artifactAddress(artifactKinds(config), file)?.kind ?? null;

// What a proposal's checks passed: its type, artifacts, content, conflicts, leftovers, points, and the versions it was proposed from, so an apply refuses a record changed after them.
const proposedDigest = (migration: any) => versionOf(Buffer.from(JSON.stringify([migration.type, migration.source, migration.target, migration.separateSource, migration.content, migration.conflicts, migration.leftovers, migration.points.map(pointDetail), migration.versions]), "utf8"));

// ---- The run's page ----

/** The entries of an artifact's text by identity, as [{ id, from, to, end, text }]: a requirement section by number, a glossary term by id, or a feature Rule by title. */
export const entriesFor = (type: any, text: any) => entriesOf(type, text);

// The options of an asked entry or conflict point, in the order the page offers them.
export const POINT_CHOICES: any = Object.freeze({ entry: ["same", "target", "source"], conflict: ["target", "source"] });

/**
 * The option that an asked entry or conflict point's recommendation names, which the person's answer starts as: the recommendation itself when it is an option,
 * and otherwise the option whose word comes first in it, such as same in "They mean the same", or target when it names none.
 */
export function recommendedChoice(kind: any, recommendation: any) {
  const options = POINT_CHOICES[kind];
  if (!options) return null;
  const text = String(recommendation ?? "").trim().toLowerCase();
  if (options.includes(text)) return text;
  let best: any = null;
  for (const option of options) {
    const at = text.search(new RegExp(`\\b${option}\\b`));
    if (at >= 0 && (best === null || at < best.at)) best = { option, at };
  }
  return best?.option ?? "target";
}

// What a line that the format added to the migrated file is, in words.
function addedLine(line: any) {
  const trimmed = line.trim();
  if (/^#{1,6}\s/.test(trimmed)) return "A section of the format";
  if (/^<a id="[^"]*"><\/a>$/.test(trimmed)) return "An anchor of an entry";
  if (trimmed === UNKNOWN || /^[A-Z][A-Za-z ]*:\s*unknown$/.test(trimmed)) return "A value the source never gave";
  if (/^[A-Z][A-Za-z ]*:\s/.test(trimmed)) return "A field of the format";
  return "A line of the format";
}

/**
 * A migration's statement map for the run's page: each statement of its source, word for word in source order with its line, and where it landed,
 * as { statements: [{ text, line, landed }], added: [{ line, text, what }] }, or null for a proposal recorded without its source.
 * landed is { kind: "section", heading } with heading null before the first section, { kind: "leftover", home, point }, or { kind: "entry" | "conflict", entry, point },
 * where point names the point that placed the statement, if any, and added lists each line of the migrated file that holds no source statement and that the source does not hold.
 * answers, the run's answers by point id, place the statements that a person's answer placed, as the applied file does.
 */
export function statementMap(migration: any, { answers = {} }: any = {}) {
  const { type, sourceText } = migration;
  if (typeof sourceText !== "string" || typeof migration.content !== "string") return null;
  const written = withAnsweredValues(migration.content, migration.points ?? [], answers ?? {});
  const sections = sectionsOf(written);
  const contentStatements = statementsOf(type, written).map((statement) => ({ ...statement, normalized: normalizeStatement(statement.text) }));
  const points = migration.points ?? [];
  const pointOf = (kind: any, accept: any) => points.find((point: any) => point.kind === kind && accept(point))?.id ?? null;
  const headingAt = (line: any) => {
    const heading = sections[line]?.h2 ?? null;
    return heading === null ? null : heading.replace(/\s*\{#[^}]*\}\s*$/, "");
  };
  const sourceEntries = entriesOf(type, sourceText);
  const statements = sourceStatements(type, sourceText);
  const sourceValues = statements.map((statement) => normalizeStatement(statement.text)).filter(Boolean);
  const mapped = statements.map((statement) => {
    const value = normalizeStatement(statement.text);
    const at = { text: statement.text, line: statement.line };
    const exact = contentStatements.find((item) => item.normalized === value);
    if (exact) return { ...at, landed: { kind: "section", heading: headingAt(exact.line), point: null } };
    const leftover = (migration.leftovers ?? []).find((item: any) => normalizeStatement(item.statement).includes(value));
    if (leftover) {
      const point = pointOf("leftover", (item: any) => normalizeStatement(item.statement) === normalizeStatement(leftover.statement));
      return { ...at, landed: { kind: "leftover", home: leftover.home, point } };
    }
    const entry = sourceEntries.find((item) => statement.line - 1 >= item.from && statement.line - 1 < item.to);
    const entryPoint = entry ? pointOf("entry", (item: any) => item.entry === entry.id) : null;
    if (entryPoint) return { ...at, landed: { kind: "entry", entry: entry!.id, point: entryPoint } };
    const conflict = (migration.conflicts ?? []).find((item: any) => normalizeStatement(item.source).includes(value));
    if (conflict) return { ...at, landed: { kind: "conflict", entry: conflict.entry, point: pointOf("conflict", (item: any) => item.entry === conflict.entry) } };
    const within = contentStatements.find((item) => item.normalized.includes(value));
    return { ...at, landed: { kind: "section", heading: within ? headingAt(within.line) : null, point: null, found: Boolean(within) } };
  });
  const sourceLines = new Set(sourceText.split(/\r?\n/).map((line: any) => line.trim()).filter(Boolean));
  const added = written.split(/\r?\n/).flatMap((line: any, index: any) => {
    const trimmed = line.trim();
    if (!trimmed || sourceLines.has(trimmed)) return [];
    const normalized = normalizeStatement(trimmed);
    if (sourceValues.some((value) => normalized.includes(value))) return [];
    return [{ line: index + 1, text: line, what: addedLine(line) }];
  });
  return { statements: mapped, added };
}

// ---- Applying ----

// Each glossary source written as migration alone names the migration it came from.
const withMigrationId = (type: any, text: any, id: any) => type !== "glossary" ? text : text.replace(/^(Source:.*)$/gm, (line: any) => line.replace(/(^Source:\s*|,\s*)migration(?![\w-]|\s+migration-)/g, `$1migration ${id}`));

// The content with each unknown value that a person answered with a value in its place, from the last line up so earlier lines keep their numbers.
function withAnsweredValues(content: any, points: any, answers: any) {
  const lines = content.split("\n");
  const answered = points.filter((point: any) => point.kind === "unknown" && answers[point.id]?.choice === "value" && typeof answers[point.id].value === "string").sort((left: any, right: any) => right.line - left.line);
  for (const point of answered) {
    const index = point.line - 1;
    const value = answers[point.id].value;
    const line = lines[index] ?? "";
    const field = /^([A-Z][A-Za-z ]*:\s*)unknown\s*$/.exec(line);
    if (field) lines.splice(index, 1, ...`${field[1]}${value}`.split("\n"));
    else if (line.trim() === UNKNOWN) lines.splice(index, 1, ...value.split("\n"));
  }
  return lines.join("\n");
}

const SCOPE_KINDS = new Set(["workspace", "repository", "component"]);

// A migration's source and target as a proposal would place them now, since a record is untrusted when it applies: another checkout or a store's remote may have written it.
function placed(config: any, migration: any) {
  if (!ARTIFACT_TYPES.includes(migration.type)) throw fail("record_invalid", `The format migration ${migration.id} names no artifact type.`, { id: migration.id });
  for (const [name, entry] of [["source", migration.source], ["target", migration.target]]) {
    if (!isRecord(entry) || relativePath(entry.path, `The record's ${name}`) !== entry.path) throw fail("invalid_input", `The ${name} of the format migration ${migration.id} is no project-relative path inside the project.`, { id: migration.id });
    if (entry.scope !== null && !(isRecord(entry.scope) && SCOPE_KINDS.has(entry.scope.kind))) throw fail("record_invalid", `The ${name} of the format migration ${migration.id} names no scope.`, { id: migration.id });
  }
  if (artifactTypeOf(artifactLocations(config), migration.target.path) !== migration.type) throw fail("invalid_input", `The target ${migration.target.path} of the format migration ${migration.id} lies under no configured path of the type ${migration.type}.`, { path: migration.target.path });
  const hasStore = (config.workspace?.store ?? null) !== null;
  const targetStore = hasStore && migration.type !== "feature" && storePath(config, migration.target.path);
  const sourceStore = hasStore && storePath(config, migration.source.path);
  for (const [name, entry, store] of [["source", migration.source, sourceStore], ["target", migration.target, targetStore]]) {
    if (store !== (entry.scope !== null)) throw fail("record_invalid", `The ${name} of the format migration ${migration.id} is placed where Prism does not keep ${entry.path}.`, { id: migration.id });
  }
  const separate = !(migration.source.path === migration.target.path && sameScope(migration.source.scope, migration.target.scope) && sourceStore === targetStore);
  if (migration.separateSource !== separate) throw fail("record_invalid", `The format migration ${migration.id} does not say whether its source is separate as its paths do.`, { id: migration.id });
  return { sourceStore, targetStore };
}

/**
 * Apply every migration of a run, or none: a source or target that changed since its proposal refuses with migration_stale naming the paths,
 * each checkout target passes the write check before it is written, every store target is written and each store source the person chose to remove is removed in one checked store update,
 * and a checkout target written before a later step failed is restored. A run that applied store artifacts syncs the store's earlier changes first and then commits exactly its files
 * with the message prism: format migration <run id>, while its checkout files stay uncommitted. Returns the run's result, one entry per migration.
 */
export async function applyRun(root: any, run: any, at: any) {
  const config = await readWorkflowConfig(root);
  const answers = run.answers ?? {};
  const own = new Set(run.migrations.map((migration: any) => migration.id));
  const applied = await appliedMigrationIds(root);
  const decided = (id: any) => own.has(id) || applied.has(id);
  const plans = [];
  const stale = [];
  for (const migration of run.migrations) {
    const { sourceStore, targetStore } = placed(config, migration);
    if (migration.digest !== proposedDigest(migration)) throw fail("record_invalid", `The format migration ${migration.id} of the run ${run.id} changed after its proposal was checked, so the run applies nothing; propose it again.`, { id: migration.id });
    const readOf = (entry: any, store: any) => readArtifact(root, config, { path: entry.path, ...(store ? scopeInputOf(entry.scope) : {}) }, { store });
    const source = await readOf(migration.source, sourceStore);
    const target = migration.separateSource ? await readOf(migration.target, targetStore) : source;
    if (source.version !== migration.versions.source) stale.push(source);
    if (migration.separateSource && target.version !== migration.versions.target) stale.push(target);
    let content = withAnsweredValues(migration.content, migration.points, answers);
    for (const conflict of migration.conflicts ?? []) {
      const point = migration.points.find((item: any) => item.kind === "conflict" && item.entry === conflict.entry);
      if (point && answers[point.id]?.choice === "source") content = replaceEntry(migration.type, content, conflict.entry, conflict.source) ?? content;
    }
    content = withMigrationId(migration.type, content, migration.id);
    const removal = migration.points.find((point: any) => point.kind === "remove-source");
    const removeSource = migration.separateSource && removal !== undefined && answers[removal.id]?.choice === "remove";
    plans.push({ migration, source, target, content, removeSource });
  }
  if (stale.length) throw fail("migration_stale", `${stale.map(label).join(" and ")} changed since ${stale.length === 1 ? "its" : "their"} format migration was proposed, so the run ${run.id} applied nothing.`, { paths: stale.map(named) });

  // Each checkout target passes the write check before anything is written, strictly: unknown only where the target will be a Draft requirement file or a Proposed ADR.
  const { checkArtifactContent, checkoutSourceLookup } = await import("./artifact-check.mjs");
  const refused = [];
  for (const plan of plans.filter((item) => !item.target.store)) {
    const result = await checkArtifactContent({
      path: plan.target.path, type: plan.migration.type, bytes: Buffer.from(plan.content, "utf8"), status: null,
      lookup: plan.migration.type === "glossary" ? checkoutSourceLookup(root) : null, appliedMigration: decided
    });
    if (!result.conforms) refused.push({ ...named(plan.target), type: plan.migration.type, findings: result.findings });
  }
  if (refused.length) throw nonconforming(run, refused);

  // Checkout targets are written first, each restorable, then the store's one checked update, and checkout sources are removed only once everything else applied.
  const restore = [];
  const storePlans = plans.filter((plan) => plan.target.store || (plan.removeSource && plan.source.store));
  const store = storePlans.length ? await storeSyncBase(root) : null;
  let files = [];
  try {
    for (const plan of plans.filter((item) => !item.target.store)) {
      restore.push({ path: plan.target.path, bytes: plan.target.bytes });
      await writeCheckoutTarget(root, run.id, plan.target.path, plan.content);
    }
    if (storePlans.length) {
      // The store's earlier changes are committed first, so the run's own commit holds its files alone.
      if (store?.sync) await syncRecordStoreNow(store.base);
      const writes = plans.filter((plan) => plan.target.store).map((plan) => ({
        path: plan.target.path, scope: plan.target.scope, content: plan.content, expectedVersion: plan.target.version,
        status: plan.migration.type === "requirements" || plan.migration.type === "adr" ? headerValue(plan.content, "Status") : null
      }));
      const removes = plans.filter((plan) => plan.removeSource && plan.source.store).map((plan) => ({ path: plan.source.path, scope: plan.source.scope, expectedVersion: plan.source.version }));
      try {
        ({ files } = await applyStoreRun(root, { writes, removes, appliedMigration: decided, acceptedFrom: { migration: run.id, at } }));
      } catch (error) {
        if (error?.code === "version_conflict") throw fail("migration_stale", `A store artifact of the run ${run.id} changed since its format migration was proposed, so the run applied nothing.`, { paths: [...writes, ...removes].map(({ path: file, scope }: any) => ({ path: file, scope })) });
        if (error?.code === "artifact_nonconforming") throw nonconforming(run, error.artifacts ?? [], error.message);
        throw error;
      }
    }
  } catch (error) {
    for (const item of restore.reverse()) await restoreCheckoutFile(root, item).catch(() => {});
    throw error;
  }
  for (const plan of plans.filter((item) => item.removeSource && !item.source.store)) {
    if (await checkoutFile(root, plan.source.path)) await rm(path.join(root, plan.source.path), { force: true });
  }
  // The run's store change is a commit of its own; the accepted copies, kept by their hash for every artifact alike, follow in the sync's usual commit.
  if (store && files.length) {
    const commit = { message: `prism: format migration ${run.id}`, files: files.filter((file: any) => !file.startsWith("artifact-accepted/")) };
    // A store whose sync is off is committed to only when it is a Git checkout, and nothing is pushed.
    if (store.sync) await syncRecordStoreNow(store.base, { commit });
    else await commitStoreFiles(store.base, commit).catch(() => false);
  }
  const written = plans.map((plan) => plan.target).concat(plans.filter((plan) => plan.removeSource).map((plan) => plan.source));
  await dropReportedFindings(root, written.map(named)).catch(() => {});
  return plans.map(({ migration }: any) => ({
    migration: migration.id, source: migration.source, target: migration.target, diff: migration.diff, summary: migration.summary,
    settled: migration.points.filter((point: any) => point.settled).map((point: any) => ({ point: point.id, reason: point.settled.reason })),
    answered: migration.points.filter((point: any) => point.asked && isRecord(answers[point.id])).map((point: any) => ({ point: point.id, choice: answers[point.id].choice ?? null, value: answers[point.id].value ?? null, by: answers[point.id].by ?? null, at: answers[point.id].at ?? null }))
  }));
}

function nonconforming(run: any, artifacts: any, message = null) {
  const lines = artifacts.map((artifact: any) => `${label(artifact)} breaks ${[...new Set(artifact.findings.map((finding: any) => finding.rule))].join(", ")}: ${artifact.findings.map((finding: any) => finding.message).join(" ")}`);
  return fail("artifact_nonconforming", `The write check refuses what the run ${run.id} would write, so it applied nothing: ${message ?? lines.join(" ")}`, { artifacts });
}

// A checkout file put back as it was before the run wrote it, or removed when the run created it.
async function restoreCheckoutFile(root: any, { path: file, bytes }: any) {
  if (bytes === null) await rm(path.join(root, file), { force: true });
  else await writeAtomically(path.join(root, file), bytes);
}

/**
 * Writes a checkout target through a temporary file beside it in its symlink-checked folder, so a failed write leaves the target as it was and removes the temporary file.
 * A filesystem failure is refused with target_unwritable rather than reaching the caller as a raw error.
 */
async function writeCheckoutTarget(root: any, id: any, file: any, content: any) {
  const unwritable = (error: any) => error instanceof FormatMigrationError || error?.name === "FormatMigrationError" ? error
    : typeof error?.code === "string" && error.syscall !== undefined
      ? fail("target_unwritable", `${file} cannot be written in the checkout (${error.code}), so the format migration run ${id} changed nothing; make its folder writable and run it again.`, { path: file })
      : error;
  const parts = file.split("/").slice(0, -1);
  try {
    // A part of the target's folder that exists as no folder is refused before any folder is created.
    for (let index = 1; index <= parts.length; index += 1) {
      const info = await lstat(path.join(root, ...parts.slice(0, index))).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info === null) break;
      if (info.isSymbolicLink()) throw fail("artifact_outside", `${file} passes through the symbolic link ${parts.slice(0, index).join("/")}, so a format migration does not read, write, or remove it.`, { path: file });
      if (!info.isDirectory()) throw fail("invalid_path", `${parts.slice(0, index).join("/")} is no folder, so the format migration run ${id} cannot write ${file} and changed nothing.`, { path: file });
    }
    await checkoutFile(root, file);
    await mkdir(path.join(root, ...parts), { recursive: true });
    await checkoutFile(root, file);
    await writeAtomically(path.join(root, file), content, {
      renameFile: async (from, to) => {
        await checkoutFile(root, file);
        await renameWhenFree(from, to);
      }
    });
  } catch (error) { throw unwritable(error); }
}
