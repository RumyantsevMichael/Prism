import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, inspectArtifact } from "./artifact-formats.mjs";
import { artifactLocations, artifactTypeOf } from "./artifact-check.mjs";
import { artifactAddress } from "./artifact-paths.mjs";
import { newStatus } from "./artifact-status.mjs";
import { listFormatMigrationRecords, readRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { applyStoreMigration, storeArtifactCopy } from "./store-artifacts.mjs";
import { normalizeStatement, splitStatements } from "./statements.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";

// Format migrations: a proposal converts one artifact into its format, accounting for every statement of its source, and applies only after a person accepts it at its gate.
// They are records of their own under format-migrations/, apart from the move of a checkout's files into a record store, which artifact-migration.mjs performs.

const run = promisify(execFile);
const CONTENT_MAX = 1024 * 1024;
const SUMMARY_MAX = 2000;
const HOME_MAX = 500;
const LEFTOVERS_MAX = 2000;
const CONFLICTS_MAX = 500;
const ID = /^migration-[0-9a-f]{8,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN = "unknown";
const LINK_LIST = /^\[[^\]]*\]\([^)\s]+\)(\s*,\s*\[[^\]]*\]\([^)\s]+\))*\.?$/;
// The store kind of each format type whose artifacts a record store holds; feature files stay in the checkout.
const STORE_KINDS = Object.freeze({ requirements: "requirements", adr: "adrs", glossary: "glossary" });
// The labels of each format's field lines, whose values are the statements of those lines.
const FIELDS = Object.freeze({
  requirements: ["Status", "Created", "Approved", "Pattern", "Disposition", "Requirement", "Rationale", "Related", "Supersedes"],
  adr: ["Status", "Created", "Accepted", "Supersedes"],
  glossary: ["Source", "Aliases", "Not to be confused with"],
  feature: []
});
// The fields that record a decision, which the decision checks compare rather than the statement checks.
const DECISION_FIELDS = new Set(["Status", "Created", "Approved", "Accepted"]);
const DATE_FIELDS = new Set(["Created", "Approved", "Accepted"]);

export class FormatMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FormatMigrationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new FormatMigrationError(code, message, details);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const formatOf = (type) => ARTIFACT_FORMATS.filter((entry) => entry.type === type).at(-1);
const label = (entry) => entry.scope === null ? entry.path : `${entry.path} in scope ${entry.scope.label}`;
const named = ({ path: file, scope }) => ({ path: file, scope });
const sameScope = (left, right) => (left?.label ?? null) === (right?.label ?? null);
const versionOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The store's and the store artifacts' own refusals reach the caller as migration refusals with the same code, message, and details.
async function storeRefusing(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof FormatMigrationError) throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError", "ArtifactCheckError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
    }
    throw error;
  }
}

// ---- Input ----

function relativePath(value, name) {
  if (typeof value !== "string" || value === "" || value.length > 1024) throw fail("invalid_input", `${name} must be a project-relative file path.`);
  const file = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file === "." || file === ".." || file.startsWith("../")) throw fail("invalid_input", `${name} ${value} must be relative to the project root and stay inside it.`, { path: value });
  return file;
}

// A source or target: a project-relative path, or { path, scope, component } with scope and component as get_artifact takes them.
function artifactInput(value, name) {
  if (typeof value === "string") return { path: relativePath(value, name) };
  if (!isRecord(value)) throw fail("invalid_input", `${name} must be a project-relative path or { path, scope, component }.`);
  const extra = Object.keys(value).filter((key) => !["path", "scope", "component"].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes only path, scope, and component, not ${extra.join(", ")}.`);
  if (value.scope !== undefined && typeof value.scope !== "string") throw fail("scope_invalid", `The scope of ${name} must be "workspace", "repository", or "component".`);
  if (value.component !== undefined && typeof value.component !== "string") throw fail("component_unknown", `The component of ${name} must name a component that ## Components in .prism/workflow.md declares.`);
  return { path: relativePath(value.path, name), ...(value.scope === undefined ? {} : { scope: value.scope }), ...(value.component === undefined ? {} : { component: value.component }) };
}

function proposalInput(input) {
  if (!isRecord(input)) throw fail("invalid_input", "propose_migration takes an object of arguments.");
  const allowed = ["projectRoot", "type", "source", "target", "content", "summary", "leftovers", "conflicts"];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw fail("invalid_input", `propose_migration takes no ${extra.join(", ")}.`);
  if (!ARTIFACT_TYPES.includes(input.type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > CONTENT_MAX) throw fail("invalid_input", "content must be the whole migrated artifact as text of at most 1 MiB.");
  if (typeof input.summary !== "string" || input.summary.trim().length < 1 || input.summary.length > SUMMARY_MAX) throw fail("invalid_input", `summary must be plain text of 1 to ${SUMMARY_MAX} characters on what changes and why.`);
  if (!Array.isArray(input.leftovers) || input.leftovers.length > LEFTOVERS_MAX) throw fail("invalid_input", `leftovers must be a list of at most ${LEFTOVERS_MAX} { statement, home } entries.`);
  const leftovers = input.leftovers.map((entry, index) => {
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
  return { type: input.type, source: artifactInput(input.source, "source"), target: artifactInput(input.target, "target"), content: input.content, summary: input.summary, leftovers, conflicts };
}

// ---- Artifacts ----

// Whether a project-relative path is a store artifact of a project with a store: a path under the configured store artifact paths.
const storePath = (config, file) => artifactAddress(artifactKinds(config), file) !== null;

/**
 * Reads a source or target where Prism keeps it: { path, scope, store, text, bytes, version, status, component },
 * with scope null and status null for a checkout file, and text, bytes, and version null where no file is held.
 */
async function readArtifact(root, config, entry, { store, kind }) {
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
async function checkoutFile(root, file) {
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
async function historyDates(root, file) {
  try {
    const { stdout } = await run("git", ["log", "--follow", "--format=%as%n%cs", "--", file], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return new Set(stdout.split("\n").map((line) => line.trim()).filter((line) => DATE.test(line)));
  } catch {
    return new Set();
  }
}

// ---- Structure ----

const headerValue = (text, name) => {
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) return null;
    const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return null;
};

// The identities an artifact holds: requirement section numbers, glossary term ids, or feature Rule titles.
function identities(type, text) {
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
function entriesOf(type, text) {
  const lines = text.split("\n");
  const starts = [];
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

const sameEntry = (left, right) => left.split("\n").map((line) => line.trimEnd()).join("\n").trim() === right.split("\n").map((line) => line.trimEnd()).join("\n").trim();

// The content with one entry's lines replaced by the given text, keeping the blank lines that followed it.
function replaceEntry(type, content, id, replacement) {
  const entry = entriesOf(type, content).find((item) => item.id === id);
  if (!entry) return null;
  const lines = content.split("\n");
  const own = replacement.replace(/\s+$/, "").split("\n");
  return [...lines.slice(0, entry.from), ...own, ...lines.slice(entry.to)].join("\n");
}

const findingsOf = (type, text) => inspectArtifact(type, text, { context: { proposal: true } });

// ---- Statements ----

const statementsOf = (type, text) => splitStatements(text, { gherkin: type === "feature", fields: FIELDS[type] });

/** The statements of a source that a migration must account for: field values that record a decision, unknown values, and format defaults are none. */
function sourceStatements(type, text) {
  const defaults = formatOf(type).defaults;
  return statementsOf(type, text).filter((statement) => {
    const value = normalizeStatement(statement.text);
    if (!value || value === UNKNOWN) return false;
    if (statement.field && DECISION_FIELDS.has(statement.field)) return false;
    if (statement.field && (value === "n/a" || defaults[statement.field] === value)) return false;
    return true;
  });
}

// Whether a content statement needs no source: the format's structure, a default, unknown, a link, a glossary source, or a date that the source or its Git history gives.
// A Status value needs no source when it is the type's new status or the status a source or target records or states; a date when the source's Git history gives it or a source or target states it in the same field.
function needsNoSource(type, statement, { dates, known }) {
  const value = normalizeStatement(statement.text);
  const raw = statement.text.trim();
  if (!value || value === UNKNOWN || value === "n/a") return true;
  const defaults = formatOf(type).defaults;
  if (statement.field && defaults[statement.field] === value) return true;
  if (statement.field === "Status") return value === newStatus(STORE_KINDS[type]) || known.some((artifact) => artifact.status === value || headerValue(artifact.text, "Status") === value);
  if (statement.field && DATE_FIELDS.has(statement.field)) return DATE.test(value) && (dates.has(value) || known.some((artifact) => headerValue(artifact.text, statement.field) === value));
  if (statement.field && DECISION_FIELDS.has(statement.field)) return false;
  if (statement.field && LINK_LIST.test(raw)) return true;
  if (type === "glossary" && statement.field === "Source" && /^(?:migration(?:\s+migration-[0-9a-f]+)?|\[[^\]]*\]\([^)\s]+\))(\s*,\s*(?:migration(?:\s+migration-[0-9a-f]+)?|\[[^\]]*\]\([^)\s]+\)))*$/.test(raw)) return true;
  return false;
}

// ---- Diffs ----

const linesOf = (text) => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

// The line edits from one text to another: [{ op: " " | "-" | "+", line }], by the longest common subsequence of the lines between a common head and tail.
function lineEdits(before, after) {
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
    middle.push(...a.map((line) => ({ op: "-", line })), ...b.map((line) => ({ op: "+", line })));
  }
  return [...before.slice(0, head).map((line) => ({ op: " ", line })), ...middle, ...before.slice(before.length - tail).map((line) => ({ op: " ", line }))];
}

/** A unified diff from one text to another with three lines of context, or "" when they hold the same lines. */
export function unifiedDiff(before, after, { from = "a", to = "b", context = 3 } = {}) {
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

// ---- Records ----

const recordKey = (id) => ({ kind: "format-migration", id });

async function readMigrationRecord(root, id) {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const read = await readRecord(root, recordKey(id));
  if (read.bytes === null) return null;
  return { record: parseStoreJson(read.bytes.toString("utf8")), revision: versionOf(read.bytes) };
}

async function storedMigration(root, id) {
  const read = await storeRefusing(() => readMigrationRecord(root, id));
  if (!read) throw fail("migration_unknown", `No format migration has the id ${JSON.stringify(String(id ?? ""))}.`, { id });
  return read;
}

const serialize = (record) => `${JSON.stringify(record, null, 2)}\n`;

async function allMigrations(root) {
  const found = [];
  for (const { bytes } of await listFormatMigrationRecords(root)) {
    try {
      const record = parseStoreJson(bytes.toString("utf8"));
      if (isRecord(record) && typeof record.id === "string") found.push(record);
    } catch {
      // A damaged record names no migration.
    }
  }
  return found;
}

/** The ids of the applied format migrations that the project's records hold, in the record store when one is configured, whichever checkout applied them. */
export async function appliedMigrationIds(projectRoot) {
  return new Set((await allMigrations(projectRoot)).filter((record) => typeof record.appliedAt === "string").map((record) => record.id));
}

const statusOf = (record) => typeof record.appliedAt === "string" ? "applied" : record.answer ? record.answer.decision === "accept" ? "accepted" : "declined" : "pending";

// A migration as a reader gets it, without the content and versions that only applying it needs.
function shown(record, { full = true } = {}) {
  const { content, versions, sourceInput, targetInput, ...rest } = record;
  const value = { ...rest, status: statusOf(record) };
  if (!full) { delete value.answer; delete value.appliedAt; }
  return value;
}

// ---- Proposing ----

/**
 * Propose a format migration of one artifact: every source statement must occur in the content, a leftover, or a conflict, no content statement may be invented,
 * the content must conform, keep the decisions of an Approved or Accepted source or target and the entries of an existing target, and no migration of the target may be pending.
 * Returns { migration } with the pending migration as get_migration returns it, without its answer.
 */
export async function proposeMigration(input) {
  const given = proposalInput(input);
  const root = await realpath(input.projectRoot);
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  const { type } = given;
  if (artifactTypeOf(locations, given.target.path) !== type) throw fail("invalid_input", `The target ${given.target.path} lies under no configured path of the type ${type}.`, { path: given.target.path });
  const hasStore = (config.workspace?.store ?? null) !== null;
  const targetInStore = hasStore && type !== "feature" && storePath(config, given.target.path);
  const sourceInStore = hasStore && storePath(config, given.source.path);
  const source = await readArtifact(root, config, given.source, { store: sourceInStore });
  if (source.text === null) throw fail("artifact_missing", `The source ${label(source)} does not exist.`, { path: source.path });
  // Only a target named as the source is, by path, scope, and component, is the source itself; a target at the source's path in another named scope is read as a target of its own.
  const inPlace = given.source.path === given.target.path && given.source.scope === given.target.scope && given.source.component === given.target.component && sourceInStore === targetInStore;
  const read = inPlace ? source : await readArtifact(root, config, given.target, { store: targetInStore, kind: targetInStore ? STORE_KINDS[type] : undefined });
  const target = read.store === source.store && read.path === source.path && sameScope(read.scope, source.scope) ? source : read;
  const separateSource = !(target.path === source.path && sameScope(target.scope, source.scope));
  const existing = separateSource && target.text !== null ? target : null;
  const content = given.content;

  // A pending or accepted migration of the same target that is not applied yet holds it.
  const holding = (await storeRefusing(() => allMigrations(root))).find((record) => record.target?.path === target.path && sameScope(record.target?.scope, target.scope) && ["pending", "accepted"].includes(statusOf(record)));
  if (holding) throw fail("migration_pending", `The format migration ${holding.id} of ${label(target)} is still ${statusOf(holding)}, so another one cannot be proposed until it is answered${statusOf(holding) === "accepted" ? " and applied" : ""}.`, { id: holding.id });

  // The content conforms to its format, unknown values aside.
  const checked = findingsOf(type, content);
  if (checked.findings.length) {
    const rules = [...new Set(checked.findings.map((finding) => finding.rule))].join(", ");
    throw fail("artifact_nonconforming", `The content breaks the ${type} format of ${label(target)} (${rules}), so it cannot be proposed: ${checked.findings.map((finding) => finding.message).join(" ")}`, { artifacts: [{ ...named(target), type, findings: checked.findings, legacy: null }] });
  }

  // A decided source or target keeps its status, dates, and identities.
  const changed = [];
  const note = (change) => { if (!changed.some((item) => item.field === change.field && item.before === change.before)) changed.push(change); };
  const decidedStatus = (artifact) => artifact.store ? artifact.status : headerValue(artifact.text, "Status");
  for (const before of [source, existing].filter(Boolean)) {
    if (!["requirements", "adr", "glossary", "feature"].includes(type)) continue;
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
  if (targetInStore && (type === "requirements" || type === "adr")) {
    const expected = target.text !== null ? target.status : source.store && source.text !== null && source.status !== null && storeKindOfPath(config, source.path) === STORE_KINDS[type] ? source.status : newStatus(STORE_KINDS[type]);
    const written = headerValue(content, "Status");
    if (expected !== null && written !== expected) note({ field: "Status", before: expected, after: written });
  }
  if (changed.length) {
    throw fail("migration_changes_decision", `The content changes what a person decided for ${label(source)}${existing ? ` or ${label(existing)}` : ""}: ${changed.map((change) => `${change.field} ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}`).join(", ")}. Keep the status, the Created and Approved dates, and every identity as recorded; only a person's answer at a gate changes them.`, { changed });
  }

  // The entries of an existing target stay unchanged, and the source's differing version of one goes under conflicts.
  const conflicts = [];
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
  } else if (given.conflicts.length) {
    throw fail("migration_conflict", `The target ${label(target)} holds no entries, so the conflicts ${given.conflicts.map((conflict) => conflict.entry).join(", ")} name no entry of it.`, { entries: given.conflicts.map((conflict) => conflict.entry) });
  }

  // Every leftover is a statement of the source, verbatim.
  const normalizedSource = normalizeStatement(source.text);
  for (const [index, leftover] of given.leftovers.entries()) {
    if (!normalizedSource.includes(normalizeStatement(leftover.statement))) throw fail("invalid_input", `leftovers[${index}].statement is not a statement of the source ${label(source)}: ${JSON.stringify(leftover.statement)}.`);
  }

  // Every source statement occurs in the content, a leftover, or a conflict.
  const placed = [normalizeStatement(content), ...given.leftovers.map((leftover) => normalizeStatement(leftover.statement)), ...conflicts.map((conflict) => normalizeStatement(conflict.source))];
  const unaccounted = sourceStatements(type, source.text).filter((statement) => !placed.some((text) => text.includes(normalizeStatement(statement.text))));
  if (unaccounted.length) {
    throw fail("migration_unaccounted", `${unaccounted.length === 1 ? "A statement" : `${unaccounted.length} statements`} of ${label(source)} ${unaccounted.length === 1 ? "occurs" : "occur"} in neither the content, a leftover, nor a conflict: ${unaccounted.map((statement) => `line ${statement.line}: ${JSON.stringify(statement.text)}`).join("; ")}. Place each one, or list it as a leftover with its proposed home.`, { statements: unaccounted.map(({ text, line }) => ({ text, line })) });
  }

  // No statement of the content or a conflict is invented: each is a statement of the source or an existing target, compared statement to statement,
  // and a field that records a decision passes only by the rules of needsNoSource.
  const knownArtifacts = [source, ...(existing ? [existing] : [])];
  const knownStatements = new Set(knownArtifacts.flatMap((artifact) => statementsOf(type, artifact.text)).map((statement) => normalizeStatement(statement.text)));
  const dates = await historyDates(root, source.path);
  const invented = [content, ...conflicts.map((conflict) => conflict.source)].flatMap((text) => statementsOf(type, text))
    .filter((statement) => !needsNoSource(type, statement, { dates, known: knownArtifacts }) && (DECISION_FIELDS.has(statement.field) || !knownStatements.has(normalizeStatement(statement.text))));
  if (invented.length) {
    throw fail("migration_invented", `${invented.length === 1 ? "A statement" : `${invented.length} statements`} of the content ${invented.length === 1 ? "occurs" : "occur"} in neither ${label(source)} nor the target: ${invented.map((statement) => `line ${statement.line}: ${JSON.stringify(statement.text)}`).join("; ")}. Write only what the source says, and mark a value that neither the source nor its Git history gives as unknown.`, { statements: invented.map(({ text, line }) => ({ text, line })) });
  }

  const id = `migration-${randomBytes(8).toString("hex")}`;
  const record = {
    id, type, source: named(source), target: named(target), separateSource, summary: given.summary,
    diff: unifiedDiff(source.text, content, { from: `a/${source.path}`, to: `b/${target.path}` }),
    targetDiff: existing ? unifiedDiff(existing.text, content, { from: `a/${target.path}`, to: `b/${target.path}` }) : null,
    leftovers: given.leftovers, unknowns: checked.unknowns, conflicts, proposedAt: new Date().toISOString(), answer: null, appliedAt: null,
    content, versions: { source: source.version, target: target.version },
    sourceInput: { store: source.store }, targetInput: { store: target.store }
  };
  await storeRefusing(() => writeRecord(root, recordKey(id), serialize(record)));
  return { migration: shown(record, { full: false }) };
}

const storeKindOfPath = (config, file) => artifactAddress(artifactKinds(config), file)?.kind ?? null;

/** A format migration with its answer and appliedAt: { migration }, refused with migration_unknown for an unknown id. */
export async function getMigration({ projectRoot, id }) {
  const root = await realpath(projectRoot);
  const { record } = await storedMigration(root, id);
  return { migration: shown(record) };
}

// ---- Answering ----

/** A migration as the review app's action reads it: { record, revision }, or null for an unknown id. */
export async function readMigrationForAnswer(projectRoot, id) {
  return storeRefusing(() => readMigrationRecord(projectRoot, id));
}

/**
 * Record a person's answer to a pending migration under the record's lock: { decision, conflicts, removeSource, note, by }, with conflicts by entry.
 * A migration that already has an answer is refused with already_answered, and revision, when given, must name the record the page read.
 */
export async function answerMigration(projectRoot, id, { decision, conflicts = {}, removeSource = false, note = null, by }, { revision = null } = {}) {
  const root = await realpath(projectRoot);
  await storedMigration(root, id);
  return storeRefusing(() => withRecordLock(root, recordKey(id), async () => {
    const { record, revision: current } = await storedMigration(root, id);
    if (record.answer) throw fail("already_answered", `The format migration ${id} already has an answer.`);
    if (revision !== null && revision !== current) throw fail("stale_revision", "The migration changed since the page read it.");
    const answer = {
      decision,
      conflicts: Object.fromEntries((record.conflicts ?? []).map((conflict) => [conflict.entry, conflicts[conflict.entry] === "source" ? "source" : "target"])),
      removeSource: record.separateSource === true && removeSource === true,
      note: note ?? null,
      by,
      at: new Date().toISOString()
    };
    const next = { ...record, answer };
    await writeRecord(root, recordKey(id), serialize(next));
    return { migration: shown(next) };
  }, fail));
}

/**
 * The gates a wait reads for a migration: one entry with its id and its answer once a person answered, or none for an id that no record holds.
 * A failed read, such as an unavailable store or a damaged record, throws with the store's own refusal, so a wait refuses on its first read and keeps polling after it.
 */
export async function migrationGates(projectRoot, id) {
  const read = await storeRefusing(() => readMigrationRecord(projectRoot, id));
  if (read && !isRecord(read.record)) throw fail("record_invalid", `The format migration record ${id} holds no migration.`, { id });
  if (!read) return [];
  const { record } = read;
  return [{ id: record.id, kind: "migration", question: `Accept the format migration of ${label(record.target)}? ${record.summary}`, migration: record.id, answer: record.answer ?? null }];
}

// ---- Applying ----

// Each glossary source written as migration alone names the migration it came from.
const withMigrationId = (type, text, id) => type !== "glossary" ? text : text.replace(/^(Source:.*)$/gm, (line) => line.replace(/(^Source:\s*|,\s*)migration(?![\w-]|\s+migration-)/g, `$1migration ${id}`));

/**
 * Apply an accepted format migration: write the content with each conflict's chosen entry and the migration's id after each migration source that stands alone,
 * remove a separate source only when the answer accepted its removal, and record appliedAt.
 * A store target or source changes only through Prism's store writes; returns { written, removed, acceptedBy, acceptedAt }.
 */
export async function applyMigration({ projectRoot, id }) {
  const root = await realpath(projectRoot);
  await storedMigration(root, id);
  return storeRefusing(() => withRecordLock(root, recordKey(id), async () => {
    const { record } = await storedMigration(root, id);
    if (typeof record.appliedAt === "string") throw fail("migration_applied", `The format migration ${id} was applied at ${record.appliedAt}.`);
    if (record.answer?.decision !== "accept") throw fail("migration_not_accepted", record.answer ? `A person declined the format migration ${id}, so it does not apply.` : `The format migration ${id} has no answer yet: a person accepts it on its page in the review browser first.`);
    const config = await readWorkflowConfig(root);
    const read = (entry, store) => readArtifact(root, config, { path: entry.path, ...(store ? scopeInputOf(entry.scope) : {}) }, { store });
    const source = await read(record.source, record.sourceInput?.store === true);
    const target = record.separateSource ? await read(record.target, record.targetInput?.store === true) : source;
    const stale = [];
    if (source.version !== record.versions.source) stale.push(source);
    if (record.separateSource && target.version !== record.versions.target) stale.push(target);
    if (stale.length) throw fail("migration_stale", `${stale.map(label).join(" and ")} changed since the format migration ${id} was proposed, so it does not apply; propose it again from the current ${stale.length === 1 ? "file" : "files"}.`, { paths: stale.map(named) });
    let content = record.content;
    for (const conflict of record.conflicts ?? []) {
      if (record.answer.conflicts?.[conflict.entry] === "source") content = replaceEntry(record.type, content, conflict.entry, conflict.source) ?? content;
    }
    content = withMigrationId(record.type, content, id);
    const removeSource = record.separateSource && record.answer.removeSource === true;
    const written = [], removed = [];
    const stored = [];
    if (target.store) {
      const storeRemove = removeSource && source.store ? { path: source.path, scope: source.scope, expectedVersion: source.version } : null;
      const status = record.type === "requirements" || record.type === "adr" ? headerValue(content, "Status") : null;
      try {
        stored.push(...await applyStoreMigration(root, { target: { path: target.path, scope: target.scope, content, expectedVersion: target.version, status }, remove: storeRemove }));
      } catch (error) {
        if (error?.code === "version_conflict") throw fail("migration_stale", `${label(target)}${storeRemove ? ` or ${label(source)}` : ""} changed in the record store since the format migration ${id} was proposed, so it does not apply; propose it again.`, { paths: [named(target), ...(storeRemove ? [named(source)] : [])] });
        throw error;
      }
      const entry = stored.find((item) => item.path === target.path && !item.removed);
      written.push({ path: target.path, scope: entry?.scope ?? target.scope });
      for (const item of stored.filter((entry) => entry.removed)) removed.push({ path: item.path, scope: item.scope, ...(item.removedComments ? { removedComments: item.removedComments } : {}) });
    } else {
      const file = path.join(root, target.path);
      await checkoutFile(root, target.path);
      await mkdir(path.dirname(file), { recursive: true });
      await checkoutFile(root, target.path);
      await writeAtomically(file, content);
      written.push({ path: target.path, scope: null });
    }
    if (removeSource && !source.store) {
      if (await checkoutFile(root, source.path)) await rm(path.join(root, source.path), { force: true });
      removed.push({ path: source.path, scope: null });
    } else if (removeSource && source.store && !target.store) {
      const [entry] = await applyStoreRemove(root, source);
      removed.push({ path: source.path, scope: entry?.scope ?? source.scope, ...(entry?.removedComments ? { removedComments: entry.removedComments } : {}) });
    }
    const appliedAt = new Date().toISOString();
    await writeRecord(root, recordKey(id), serialize({ ...record, appliedAt, written, removed }));
    return { written, removed, acceptedBy: record.answer.by, acceptedAt: record.answer.at };
  }, fail));
}

// A store source that a migration into the checkout removes goes through the store's own update, checked against the version the proposal read.
async function applyStoreRemove(root, source) {
  const { updateArtifact } = await import("./store-artifacts.mjs");
  try {
    return (await updateArtifact({ projectRoot: root, operations: [{ op: "remove", path: source.path, expectedVersion: source.version, ...scopeInputOf(source.scope) }] })).artifacts;
  } catch (error) {
    if (error?.code === "version_conflict") throw fail("migration_stale", `${label(source)} changed in the record store since the format migration was proposed, so it is not removed.`, { paths: [named(source)] });
    throw error;
  }
}

// The scope input that names a scope object, as get_artifact and update_artifact take it.
const scopeInputOf = (scope) => scope === null || scope === undefined ? {} : scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };
