import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { assertInput } from "./artifact-schema.mjs";
import { ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, artifactPathOf, collideInLetterCase, componentScope, holdsArtifactPaths, kindInScope, locationArtifact, malformedArtifactName, normalizeArtifactPath, repositoryScope, windowsDeviceName, WORKSPACE_SCOPE, wellFormedName } from "./artifact-paths.mjs";
import { ComponentError, readComponents } from "./components.mjs";
import { recordStoreOf, resolveArtifactFile, seenScopes, withArtifactStoreLock } from "./record-store.mjs";
import { pruneArtifactFolders, scheduleRecordSync } from "./record-store-sync.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";

// Agents read and write a workspace's descriptive artifacts in its record store through these tools, addressed by the project-relative path the checkout's configured paths give them.
const PAGE_LINES = 2000;
const PAGE_BYTES = 64 * 1024;
const LIST_MAX = 2000;
const CONTENT_MAX = 1024 * 1024;
// A file someone placed in the store by hand can exceed what a write accepts, so reads take a larger file, up to this bound.
// A larger file is still listed, checked by version, and removed: its version is hashed in chunks, so it never blocks the other artifacts.
const READ_MAX = 16 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;
// Locations stay short enough for a store's managed clone on Windows to check out without Git's core.longpaths.
const LOCATION_MAX = 120;
const SCOPE_KINDS = new Set(["workspace", "repository", "component"]);

export class ArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new ArtifactError(code, message, details);
export const artifactVersion = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const text = { type: "string", minLength: 1, maxLength: 4096 };
const anyText = { type: "string" };
const version = { oneOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] };
const scopeFields = { scope: { type: "string", maxLength: 64 }, component: { type: "string", maxLength: 200 } };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });

export const GET_ARTIFACT_SCHEMA = object({
  projectRoot: text,
  path: { type: "string", maxLength: 4096 },
  ...scopeFields,
  offset: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  limit: { type: "integer", minimum: 1, maximum: PAGE_LINES }
}, ["projectRoot"]);

export const UPDATE_ARTIFACT_SCHEMA = object({
  projectRoot: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "write" }, path: text, content: anyText, expectedVersion: version, ...scopeFields }, ["op", "path", "content", "expectedVersion"]),
    object({ op: { const: "edit" }, path: text, expectedVersion: version, edits: { type: "array", minItems: 1, maxItems: 200, items: object({ oldText: anyText, newText: anyText }) }, ...scopeFields }, ["op", "path", "expectedVersion", "edits"]),
    object({ op: { const: "remove" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion"]),
    object({ op: { const: "move_scope" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion", "scope"])
  ] } }
}, ["projectRoot", "operations"]);

const SCOPE_TEXT = "scope is \"workspace\", \"repository\" for this checkout's repository, or \"component\" with component naming a component that ## Components in .prism/workflow.md declares";

export const ARTIFACT_TOOLS = Object.freeze([
  {
    name: "get_artifact",
    description: `In a project whose .prism/workflow.md names a record store, read a descriptive artifact the store holds: a requirement, an ADR, a plan file such as slice.md, the glossary, or the roadmap view. Address it by the project-relative path that the configured Requirements, ADRs, Plans, Glossary, and Roadmap paths give it; feature files, the user guide, tests, and code stay in the checkout and are refused with not_an_artifact. Every name below a configured folder, and the configured Glossary and Roadmap file names, must begin with an ASCII letter or digit, hold only ASCII letters, digits, ".", "_", and "-", not end in "." or ".lock", and be no Windows device name such as con, aux, nul, com1, or lpt1 before its first "."; any other is refused with artifact_name_invalid, data.invalidName holding the first such name, and listings leave such files out. A file read returns path, scope, kind, version (sha256 of its bytes, which update_artifact takes as expectedVersion), bytes, totalLines, offset, content, and nextOffset: content is whole lines from offset (1-based) up to limit lines (default 2000) and 64 KiB, at least one line, so read again from nextOffset until it is null. Without path, or with a folder, it lists the artifacts this checkout sees below it with path, scope, kind, version, and bytes, at most 2000 with truncated true when more exist. The checkout sees the workspace scope, its repository's scope, and its repository's component scopes the store holds; a path that two of them hold is refused with artifact_ambiguous, listing their labels, until ${SCOPE_TEXT}. Refusals: artifact_not_found, artifact_not_text, scope_invalid, component_unknown, store_not_configured when the project has no store, and the store's own refusal, such as store_unavailable or a repository name refusal, when it cannot be used. Reads never change a checkout file.`,
    inputSchema: GET_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_artifact",
    description: `In a project whose .prism/workflow.md names a record store, change descriptive artifacts in the store, addressed by project-relative path as get_artifact reads them, never by editing files in the checkout. operations holds at most 50 of write (path, content, expectedVersion), edit (path, expectedVersion, edits of oldText and newText, each replacing text that occurs exactly once in the text earlier edits left, else edit_not_applied with data.edit its index), remove (path, expectedVersion), and move_scope (path, expectedVersion, and the scope to move it to). expectedVersion is the version last read, or null to create; any other mismatch is refused with version_conflict and data.version holding the current version or null. write, edit, and remove take an optional scope to pick one when two scopes hold the path; ${SCOPE_TEXT}. A new artifact takes the given scope, else the scope that holds its nearest folder, else the workspace scope, and creating a path that another seen scope holds is refused with artifact_exists. A write that creates an artifact, and a move_scope, whose path differs only in letter case from an artifact path a seen scope holds, or from another write of the update, is refused with artifact_name_conflict and data.path holding that path, so change only the letter case by a remove and then a write in a later update. Such a write or move_scope whose location in the store, the path below artifacts/ in the scope it would take, holds more than 120 characters is refused with artifact_path_too_long and data.location, so choose a shorter path or a scope with a shorter folder. Such a write or move_scope in a component scope whose component name is a Windows device name, such as aux, nul, or com1, is refused with component_name_invalid and data.component, so rename the component under ## Components in .prism/workflow.md or choose another scope. move_scope of a path that several scopes hold moves the one copy whose version is expectedVersion. Content is UTF-8 text of at most 1 MiB, else artifact_too_large. Prism checks every operation before it changes any file, so a refused update changes nothing. The result lists, for each operation, the artifact's path, scope, and new version, or removed true. A name that breaks the artifact name form that get_artifact describes is refused with artifact_name_invalid and data.invalidName, so choose another name. Paths outside the artifact paths are refused with not_an_artifact and stay in the checkout; without a store it refuses with store_not_configured.`,
    inputSchema: UPDATE_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
]);

// The store's own refusals and an invalid component declaration reach the agent as artifact refusals with the same code and message.
async function refusing(action) {
  try { return await action(); }
  catch (error) {
    if (error?.name === "RecordStoreError" || error instanceof ComponentError) throw fail(error.code, error.message, Object.fromEntries(["proposed", "store"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
    throw error;
  }
}

// A malformed name inside a configured folder is still the store's to refuse: the agent picks another name rather than writing the file elsewhere.
const nameInvalid = (given, name) => fail("artifact_name_invalid", `${JSON.stringify(given)} has the name ${JSON.stringify(name)}, which the record store does not accept: ${ARTIFACT_NAME_FORM}. Choose a name of that form for the artifact.`, { invalidName: name });

/** Refuse an artifact address with a name that breaks the artifact name form. */
function checkName(given, address) {
  const name = malformedArtifactName(address);
  if (name !== null) throw nameInvalid(given, name);
}

const notAnArtifact = (given) => fail("not_an_artifact", `${JSON.stringify(given)} is not a descriptive artifact path: only files under the Requirements, ADRs, and Plans folders and the Glossary and Roadmap files configured in .prism/workflow.md live in the record store, while feature files, the user guide, tests, code, and every other file stay in the checkout. Read and edit this file in the checkout with your own file tools.`);

// The checkout's configuration decides whether the tools apply at all, so a project without a store is refused before any path or store check.
async function configuration(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) throw fail("store_not_configured", "This project's .prism/workflow.md names no record store under ## Workspace, so its descriptive artifacts stay in the checkout: read and edit them there with your own file tools.");
  return { config, kinds: artifactKinds(config) };
}

/** A scope input as { kind, component } checked against the configuration, or null when no scope is given. */
function scopeInput(config, input, required = false) {
  if (input.scope === undefined) {
    if (input.component !== undefined) throw fail("scope_invalid", "component names a component scope, so it needs scope \"component\".");
    if (required) throw fail("scope_invalid", `The operation needs a scope: ${SCOPE_TEXT}.`);
    return null;
  }
  if (!SCOPE_KINDS.has(input.scope)) throw fail("scope_invalid", `${JSON.stringify(input.scope)} is no scope: ${SCOPE_TEXT}.`);
  if (input.scope !== "component") {
    if (input.component !== undefined) throw fail("scope_invalid", `component applies only with scope "component", not with scope ${JSON.stringify(input.scope)}.`);
    return { kind: input.scope };
  }
  const declared = readComponents(config).declared.map((component) => component.name);
  if (typeof input.component !== "string" || !declared.includes(input.component)) {
    throw fail("component_unknown", `${input.component === undefined ? "Scope \"component\" names no component" : `${JSON.stringify(input.component)} is no component`} of this repository: ## Components in .prism/workflow.md declares ${declared.length ? declared.join(", ") : "none"}.`, { components: declared });
  }
  return { kind: "component", component: input.component };
}

const scopeOf = (seen, input) => input.kind === "workspace" ? WORKSPACE_SCOPE : input.kind === "repository" ? repositoryScope(seen.repository) : componentScope(seen.repository, input.component);

function checkKindScope(kind, input) {
  if (input && !kindInScope(kind, { kind: input.kind })) throw fail("scope_invalid", "The roadmap view lives only in the workspace scope.");
}

const notRegular = () => fail("invalid_path", "An artifact in the record store must be a regular file, and this location holds a special file such as a pipe or device, which Prism does not open.");

/**
 * Whether every name of a location below the artifacts folder equals the name of an entry of its folder exactly.
 * A case-insensitive file system, the default on macOS and Windows, opens a stored Plan.md for plan.md, so only a location whose names all match counts as found.
 */
async function exactLocation(base, target) {
  let folder = base;
  for (const name of path.relative(base, target).split(path.sep)) {
    let names;
    try { names = await readdir(folder); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    if (!names.includes(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}

/**
 * What a store location holds, found without opening it or following a symbolic link: "missing", "folder", "file",
 * or "under_file" when a folder above it is a file; a link or special file is refused with invalid_path.
 * With base, the artifacts folder, a location that some name matches only in letter case is "missing".
 */
async function locationKind(target, base = null) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") return "missing";
    if (error.code === "ENOTDIR") return "under_file";
    throw error;
  }
  if (base !== null && !(await exactLocation(base, target))) return "missing";
  if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact in the record store is a symbolic link, which Prism does not follow.");
  if (info.isDirectory()) return "folder";
  if (!info.isFile()) throw notRegular();
  return "file";
}

/**
 * A stored file as { bytes, size, version }, or null when no file is there; bytes is null for a file above the bound a read takes.
 * The location is checked before it is opened, and opened without blocking, so a pipe never holds a read or the store's lock.
 * With base, the artifacts folder, a location that some name matches only in letter case holds no file; a listing's locations come from folder entries and need no base.
 */
async function readStored(target, base = null) {
  if ((await locationKind(target, base)) !== "file") return null;
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    if (error.code === "ELOOP") throw fail("invalid_path", "An artifact in the record store is a symbolic link, which Prism does not follow.");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return null;
    if (!info.isFile()) throw notRegular();
    if (info.size <= READ_MAX) return stored(await handle.readFile());
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK);
    let size = 0;
    for (let read; (read = (await handle.read(chunk, 0, HASH_CHUNK, null)).bytesRead) > 0;) { hash.update(chunk.subarray(0, read)); size += read; }
    return { bytes: null, size, version: `sha256:${hash.digest("hex")}` };
  } finally { await handle.close(); }
}

const stored = (bytes) => ({ bytes, size: bytes.length, version: artifactVersion(bytes) });

// The bytes of a stored file that a read, an edit, or a move needs, refused for a file above the bound a read takes.
function contentOf(file, record) {
  if (record.bytes === null) throw fail("artifact_too_large", `${file} in the record store is ${record.size} bytes, above the ${READ_MAX} bytes that Prism reads, so it cannot be read, edited, or moved; it can be removed with its version from a listing, or replaced by a write.`);
  return record.bytes;
}

async function isFolder(target, base) {
  try { if (!(await lstat(target)).isDirectory()) return false; }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  return exactLocation(base, target);
}

// A leading byte order mark is part of the stored text, so pages join to the file's text and an edit keeps it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decode(bytes, file) {
  try { return decoder.decode(bytes); }
  catch { throw fail("artifact_not_text", `${file} in the record store is not UTF-8 text, so the artifact tools cannot read or edit it.`); }
}

// Whole lines with their endings; a last line without an ending is a line too.
const linesOf = (content) => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function page(content, offset, limit) {
  const lines = linesOf(content);
  let index = offset - 1, size = 0, taken = "";
  while (index < lines.length && index - (offset - 1) < limit) {
    const length = Buffer.byteLength(lines[index]);
    if (index > offset - 1 && size + length > PAGE_BYTES) break;
    taken += lines[index];
    size += length;
    index += 1;
  }
  return { totalLines: lines.length, content: taken, nextOffset: index < lines.length ? index + 1 : null };
}

const scopesFor = (seen, kind, given) => given ? [scopeOf(seen, given)] : seen.scopes.filter((scope) => kindInScope(kind, scope));
const sortEntries = (entries) => entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.scope.label < right.scope.label ? -1 : left.scope.label > right.scope.label ? 1 : 0);
const below = (folder, file) => folder === "" || file === folder || file.startsWith(`${folder}/`);

// Every artifact file under one kind folder of one scope, as rests below the kind folder, skipping links, special files, and every name that breaks the artifact name form, such as the store's lock and temporary files.
async function walk(directory, prefix, found) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
  for (const entry of entries) {
    if (!wellFormedName(entry.name)) continue;
    const rest = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), rest, found);
    else if (entry.isFile()) found.push(rest);
  }
}

// The artifacts that the given scope, or every seen scope, holds below a folder, as { path, scope, kind, target }, sorted by path and then scope label, without reading them.
async function holdings(seen, folder, given) {
  const found = [];
  for (const scope of seen.scopes.filter((candidate) => !given || candidate.label === scopeOf(seen, given).label)) {
    for (const entry of seen.kinds.kinds) {
      if (!kindInScope(entry.kind, scope)) continue;
      if (!entry.folder) {
        if (!below(folder, entry.path) || malformedArtifactName({ path: entry.path, rest: null }) !== null) continue;
        const target = await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: null }));
        if ((await locationKind(target, seen.base).catch(() => null)) === "file") found.push({ path: entry.path, scope, kind: entry.kind, target });
        continue;
      }
      // Only a kind folder that the listed folder holds, or that holds it, can hold artifacts below it.
      let start;
      if (below(folder, entry.path)) start = "";
      else if (below(entry.path, folder)) start = entry.path === "" ? folder : folder.slice(entry.path.length + 1);
      else continue;
      const rests = [];
      const folderTarget = await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: start }));
      // Below the folder the walk takes names from folder entries, so only the folder it starts in needs its names matched exactly.
      if (await exactLocation(seen.base, folderTarget)) await walk(folderTarget, start, rests);
      for (const rest of rests) {
        const file = artifactPathOf(seen.kinds, entry.kind, rest);
        // A stored file whose path another configured kind or an excluded folder claims is not this checkout's artifact.
        const address = artifactAddress(seen.kinds, file);
        if (address?.kind !== entry.kind || address.rest !== rest || !below(folder, file)) continue;
        found.push({ path: file, scope, kind: entry.kind, target: await resolveArtifactFile(seen, artifactLocation(scope, address)) });
      }
    }
  }
  return sortEntries(found);
}

async function listing(seen, folder, given) {
  const found = await holdings(seen, folder, given);
  const artifacts = [];
  for (const entry of found.slice(0, LIST_MAX)) {
    const record = await readStored(entry.target);
    if (record !== null) artifacts.push({ path: entry.path, scope: entry.scope, kind: entry.kind, version: record.version, bytes: record.size });
  }
  return { artifacts, truncated: found.length > LIST_MAX };
}

// The scopes among candidates whose store holds the artifact, with its file and its stored record.
async function holders(seen, address, scopes, read = (target) => readStored(target, seen.base)) {
  const held = [];
  for (const scope of scopes) {
    const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
    const record = await read(target);
    if (record !== null) held.push({ scope, target, record });
  }
  return held;
}

const ambiguous = (file, held) => fail("artifact_ambiguous", `${file} is held by more than one scope this checkout sees (${held.map((entry) => entry.scope.label).join(", ")}): pass ${SCOPE_TEXT}, to pick one.`, { scopes: held.map((entry) => entry.scope.label) });
const notFound = (file) => fail("artifact_not_found", `No scope this checkout sees holds the artifact ${file} in the record store.`);

/** Read one store artifact by path, or list the artifacts the checkout sees below a folder. */
export async function getArtifact(input) {
  return refusing(async () => {
    assertInput(GET_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    const file = normalizeArtifactPath(input.path ?? "");
    if (file === null) throw notAnArtifact(input.path);
    const address = file === "" ? null : artifactAddress(kinds, file);
    if (!address && !holdsArtifactPaths(kinds, file)) throw notAnArtifact(input.path);
    if (address) checkName(input.path, address);
    const given = scopeInput(config, input);
    if (address) checkKindScope(address.kind, given);
    const seen = await seenScopes(input.projectRoot);
    if (!address || address.rest === "") return listing(seen, file, given);
    const held = await holders(seen, address, scopesFor(seen, address.kind, given));
    if (held.length > 1) throw ambiguous(file, held);
    if (held.length === 0) {
      for (const scope of scopesFor(seen, address.kind, given)) {
        if (await isFolder(await resolveArtifactFile(seen, artifactLocation(scope, address)), seen.base)) return listing(seen, file, given);
      }
      throw notFound(file);
    }
    const [{ scope, record }] = held;
    const bytes = contentOf(file, record);
    const content = decode(bytes, file);
    const offset = input.offset ?? 1;
    const read = page(content, offset, input.limit ?? PAGE_LINES);
    return { path: file, scope, kind: address.kind, version: artifactVersion(bytes), bytes: bytes.length, totalLines: read.totalLines, offset, content: read.content, nextOffset: read.nextOffset };
  });
}

// What can be checked without the store: each operation's artifact, its scope input, and the size of the content it writes.
function checkOperation(config, kinds, operation) {
  const file = normalizeArtifactPath(operation.path);
  const address = file === null || file === "" ? null : artifactAddress(kinds, file);
  if (!address) throw notAnArtifact(operation.path);
  checkName(operation.path, address);
  if (address.rest === "") throw fail("invalid_path", `${file} is the configured folder itself; name a file inside it.`);
  const given = scopeInput(config, operation, operation.op === "move_scope");
  checkKindScope(address.kind, given);
  if (operation.op === "write") tooLarge(file, Buffer.byteLength(operation.content));
  return { operation, file, address, given };
}

function tooLarge(file, size) {
  if (size > CONTENT_MAX) throw fail("artifact_too_large", `The content of ${file} is ${size} bytes, above the 1 MiB that an artifact may hold.`);
}

function checkVersion(file, expected, record) {
  const current = record?.version ?? null;
  if (expected === current) return;
  throw fail("version_conflict", current === null
    ? `${file} does not exist in that scope of the record store, so it can only be created, with expectedVersion null.`
    : `${file} changed since it was read${expected === null ? ", or already exists" : ""}: its current version is ${current}. Read it again and redo the change.`, { version: current });
}

function applyEdits(file, content, edits) {
  let result = content;
  edits.forEach((edit, index) => {
    const at = edit.oldText === "" ? -1 : result.indexOf(edit.oldText);
    if (at < 0 || result.indexOf(edit.oldText, at + 1) >= 0) {
      throw fail("edit_not_applied", `Edit ${index} of ${file} was not applied: its oldText ${at < 0 ? "does not occur" : "occurs more than once"} in the text as the earlier edits left it, so nothing changed. Include enough surrounding text to make it unique.`, { edit: index });
    }
    result = `${result.slice(0, at)}${edit.newText}${result.slice(at + edit.oldText.length)}`;
  });
  return result;
}

// A written location's names follow the name form, which admits only ASCII letters, so ASCII folding finds the entries that match them in another letter case.
const folded = (name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The first entry on the way from the artifacts folder to a location whose name matches the location's name there only in letter case, as a location below artifacts/, or null.
 * A case-insensitive file system, the default on macOS and Windows, writes into that entry, so the file would land under another path; a name that matches exactly, or a missing one, is safe.
 */
async function letterCaseVariant(base, target, entries) {
  let folder = base;
  for (const name of path.relative(base, target).split(path.sep)) {
    if (!entries.has(folder)) entries.set(folder, await readdir(folder).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }));
    const names = entries.get(folder);
    if (!names.includes(name)) {
      const variant = names.find((other) => folded(other) === folded(name));
      return variant === undefined ? null : path.relative(base, path.join(folder, variant)).split(path.sep).join("/");
    }
    folder = path.join(folder, name);
  }
  return null;
}

// Every location an update writes must be able to hold a file, checked before any file changes: it is no folder, lies below no file the store holds, lies below no other file the update writes, and passes through no entry in another letter case.
async function checkLayout(seen, writes, state, names) {
  const entries = new Map();
  for (const [target] of writes) {
    const file = names.get(target);
    for (let folder = path.dirname(target); folder !== seen.base && folder.startsWith(`${seen.base}${path.sep}`); folder = path.dirname(folder)) {
      if (state.get(folder)) throw fail("invalid_path", `${file} lies below ${names.get(folder)}, which this update writes as a file, so the two cannot both exist; nothing changed.`);
    }
    // Store entries that hold an artifact a seen scope lists were refused with artifact_name_conflict already; this catches the rest, such as a folder that holds only a lock, a temporary file, or Finder's .DS_Store.
    const variant = await letterCaseVariant(seen.base, target, entries);
    if (variant !== null) {
      const location = path.relative(seen.base, target).split(path.sep).join("/");
      throw fail("invalid_path", `${file} would be written at ${location} in the record store, where ${variant} already exists with a name that differs only in letter case, so a file system that ignores letter case, as macOS and Windows do by default, would write it into ${variant} under another path; nothing changed. Choose another name; a person can remove ${variant} from the store's artifacts folder if nothing in it is needed.`, { location: variant });
    }
    const kind = await locationKind(target, seen.base);
    if (kind === "folder") throw fail("invalid_path", `${file} is a folder of artifacts in the record store, so no file can be written in its place; nothing changed.`);
    if (kind === "under_file") throw fail("invalid_path", `${file} lies below a file that the record store holds, so it cannot be written; nothing changed.`);
  }
}

/**
 * The copy a move_scope moves: the one seen scope that holds the path, or, when several do, the one copy whose version is expectedVersion,
 * since move_scope's scope names where the artifact goes rather than which copy it comes from.
 */
function moveSource({ file, operation }, held) {
  if (held.length <= 1) return held[0] ?? null;
  const matching = held.filter((entry) => entry.record.version === operation.expectedVersion);
  if (matching.length === 1) return matching[0];
  const labels = held.map((entry) => entry.scope.label);
  throw fail("artifact_ambiguous", `${file} is held by more than one scope this checkout sees (${labels.join(", ")}), and ${matching.length ? "more than one copy has" : "no copy has"} the version given as expectedVersion, so move_scope cannot tell which copy to move; nothing changed. Read each copy with get_artifact and its scope, remove the copy you do not keep with remove and that scope, and then move the other.`, { scopes: labels });
}

// A created or moved location stays within the limit; a longer one that the store already holds stays usable by its path.
function checkLocationLength(scope, address) {
  const location = artifactLocation(scope, address);
  if (location.length <= LOCATION_MAX) return;
  throw fail("artifact_path_too_long", `${location}, the location of ${address.path} in scope ${scope.label} of the record store, holds ${location.length} characters, above the ${LOCATION_MAX} that a location may hold so that every machine can check the store out; nothing changed. Choose a shorter path, or a scope with a shorter folder.`, { location, limit: LOCATION_MAX });
}

// No created or moved artifact makes a component folder that Git for Windows refuses to check out; the artifacts of such a folder already stored stay usable by their paths.
function checkComponentName(file, scope) {
  if (scope.kind !== "component" || !windowsDeviceName(scope.component)) return;
  throw fail("component_name_invalid", `${file} would live in scope ${scope.label}, whose component name ${scope.component} is a Windows device name (con, prn, aux, nul, com0 to com9, or lpt0 to lpt9), so its folder in the record store would stop the store on every Windows machine; nothing changed. Rename the component under ## Components in .prism/workflow.md to a name that is no device name, or choose another scope.`, { component: scope.component });
}

/**
 * Refuse a created or moved path that collides in letter case with an artifact path of its kind that a seen scope held before the update,
 * or with the path of another write of the update, since a case-insensitive file system makes the two one file.
 */
function checkLetterCase(item, held, checked) {
  const { file, address } = item;
  const others = [
    ...held.filter((entry) => entry.kind === address.kind).map((entry) => entry.path),
    ...checked.filter((other) => other !== item && other.operation.op === "write" && other.address.kind === address.kind).map((other) => other.file)
  ];
  const other = others.find((candidate) => collideInLetterCase(file, candidate));
  if (other === undefined) return;
  throw fail("artifact_name_conflict", `${file} differs only in letter case from ${other}, which ${held.some((entry) => entry.path === other) ? "the record store holds" : "this update also writes"}, and the two would be one file on a file system that ignores letter case, as macOS and Windows do by default; nothing changed. Choose another name, or change the letter case of an artifact by removing it in one update and writing it in the next.`, { path: other });
}

/** Apply checked artifact operations to the store as one update: every operation is checked against the store before any file changes. */
export async function updateArtifact(input) {
  return refusing(async () => {
    assertInput(UPDATE_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    const checked = input.operations.map((operation) => checkOperation(config, kinds, operation));
    const seen = await seenScopes(input.projectRoot);
    return withArtifactStoreLock(seen, () => applyOperations(seen, checked));
  });
}

/**
 * Apply checked operations while the store's artifact lock is held: every operation is checked against the store before any file changes.
 * Every change to a store artifact, an agent's update and Prism's own plan files and views alike, goes through here.
 */
async function applyOperations(seen, checked) {
  // Each file's bytes as the earlier operations of this update leave them, so later operations see their effect.
  const original = new Map();
  const state = new Map();
  // The artifact path each written location belongs to, for refusals that name it.
  const names = new Map();
  const read = async (target) => {
    if (!state.has(target)) {
      const record = await readStored(target, seen.base);
      original.set(target, record);
      state.set(target, record);
    }
    return state.get(target);
  };
  // The artifact paths every seen scope held before the update, found once when a write creates an artifact or a move_scope runs.
  let before;
  const heldBefore = async () => before ??= await holdings(seen, "", null);
  const one = async ({ file, address }, scopes) => {
    const held = await holders(seen, address, scopes, read);
    if (held.length > 1) throw ambiguous(file, held);
    return held[0] ?? null;
  };
  const artifacts = [];
  for (const item of checked) {
    const { operation, file, address, given } = item;
    if (operation.op === "write") {
      const all = scopesFor(seen, address.kind, null);
      let scope, target, current;
      if (given) {
        scope = scopeOf(seen, given);
        target = await resolveArtifactFile(seen, artifactLocation(scope, address));
        current = await read(target);
        if (current === null && operation.expectedVersion === null) {
          const other = (await holders(seen, address, all.filter((candidate) => candidate.label !== scope.label), read))[0];
          if (other) throw fail("artifact_exists", `${file} already exists in scope ${other.scope.label}, which this checkout sees, so it cannot also be created in scope ${scope.label}. Read and change that artifact, or move it with move_scope.`, { scope: other.scope });
        }
      } else {
        const held = await one(item, all);
        scope = held?.scope ?? (operation.expectedVersion === null ? await creationScope(seen, address, all, state) : WORKSPACE_SCOPE);
        target = held?.target ?? await resolveArtifactFile(seen, artifactLocation(scope, address));
        current = held?.record ?? null;
      }
      // A create always runs the letter-case check, whatever the location's lookup found, since a case-insensitive file system finds a stored variant there.
      if (operation.expectedVersion === null) checkLetterCase(item, await heldBefore(), checked);
      checkVersion(file, operation.expectedVersion, current);
      if (current === null) {
        checkComponentName(file, scope);
        checkLocationLength(scope, address);
      }
      const next = Buffer.from(operation.content, "utf8");
      state.set(target, stored(next));
      names.set(target, file);
      artifacts.push({ path: file, scope, version: artifactVersion(next) });
      continue;
    }
    const source = operation.op === "move_scope" ? await moveSource(item, await holders(seen, address, scopesFor(seen, address.kind, null), read)) : await one(item, scopesFor(seen, address.kind, given));
    if (!source) {
      if (operation.expectedVersion !== null) checkVersion(file, operation.expectedVersion, null);
      throw notFound(file);
    }
    checkVersion(file, operation.expectedVersion, source.record);
    if (operation.op === "edit") {
      const next = Buffer.from(applyEdits(file, decode(contentOf(file, source.record), file), operation.edits), "utf8");
      tooLarge(file, next.length);
      state.set(source.target, stored(next));
      names.set(source.target, file);
      artifacts.push({ path: file, scope: source.scope, version: artifactVersion(next) });
    } else if (operation.op === "remove") {
      state.set(source.target, null);
      artifacts.push({ path: file, scope: source.scope, removed: true });
    } else {
      const scope = scopeOf(seen, given);
      checkComponentName(file, scope);
      checkLetterCase(item, await heldBefore(), checked);
      checkLocationLength(scope, address);
      if (scope.label !== source.scope.label) {
        const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
        if ((await read(target)) !== null) throw fail("artifact_exists", `${file} already exists in scope ${scope.label}, so it cannot move there from scope ${source.scope.label}.`, { scope });
        state.set(target, stored(contentOf(file, source.record)));
        names.set(target, file);
        state.set(source.target, null);
      }
      artifacts.push({ path: file, scope, version: source.record.version });
    }
  }
  // New bytes are written before removals, so a move interrupted midway leaves the artifact in both scopes rather than in neither.
  const changed = [...state].filter(([target, record]) => (record?.version ?? null) !== (original.get(target)?.version ?? null));
  await checkLayout(seen, changed.filter(([, record]) => record !== null), state, names);
  for (const [target, record] of changed.filter(([, record]) => record !== null)) {
    await mkdir(path.dirname(target), { recursive: true });
    await resolveArtifactFile(seen, path.relative(seen.base, target).split(path.sep).join("/"));
    await writeAtomically(target, record.bytes);
  }
  for (const [target] of changed.filter(([, record]) => record === null)) {
    await rm(target, { force: true });
    await pruneArtifactFolders(seen.base, target);
  }
  // A change syncs as a record write does, so it is committed and pushed without a further call; the sync stages artifacts only once this update releases the artifact lock.
  if (changed.length && seen.store.sync) scheduleRecordSync(seen.store.base);
  return { artifacts };
}

// A new artifact without a scope takes the scope that holds its nearest folder below the kind folder, when exactly one seen scope holds that folder, else the workspace scope.
async function creationScope(seen, address, scopes, state) {
  if (address.rest === null) return WORKSPACE_SCOPE;
  const parts = address.rest.split("/").slice(0, -1);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const folder = { ...address, rest: parts.slice(0, depth).join("/") };
    const holding = [];
    for (const scope of scopes) {
      const target = await resolveArtifactFile(seen, artifactLocation(scope, folder));
      const written = [...state].some(([file, bytes]) => bytes !== null && file.startsWith(`${target}${path.sep}`));
      if (written || await isFolder(target, seen.base)) holding.push(scope);
    }
    if (holding.length === 1) return holding[0];
    if (holding.length > 1) break;
  }
  return WORKSPACE_SCOPE;
}

// Prism's own plan files, views, and review pages reach the store through the functions below, which take the same checks and lock as the artifact tools.

/** A project-relative path of a project with a store, checked as an artifact address; a malformed name is refused with artifact_name_invalid. */
async function ownArtifact(projectRoot, file) {
  const { config, kinds } = await configuration(projectRoot);
  const normalized = normalizeArtifactPath(file);
  const address = normalized === null || normalized === "" ? null : artifactAddress(kinds, normalized);
  if (!address || address.rest === "") throw notAnArtifact(file);
  checkName(file, address);
  return { config, kinds, file: normalized, address };
}

// Every view that Prism generates from a record carries this notice, as generatedNotice in projection.mjs writes it.
const GENERATED_VIEW = Buffer.from("This file is a generated view of ");
const generatedView = (record) => record?.bytes != null && record.bytes.includes(GENERATED_VIEW);

// Whether a store folder holds an artifact that is no generated view, such as a slice.md, looking no further than the first one.
async function authoredFolder(target) {
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  for (const entry of entries) {
    if (!wellFormedName(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && await authoredFolder(child)) return true;
    if (entry.isFile() && !generatedView(await readStored(child).catch(() => null))) return true;
  }
  return false;
}

/**
 * The scope that a file Prism writes itself belongs in: the scope that holds its nearest folder below the kind folder, when exactly one seen scope holds that folder
 * with an artifact that is no generated view, else the workspace scope; a folder that holds only Prism's views, such as initiative.md, decides nothing.
 */
async function ownScope(seen, address, scopes) {
  if (address.rest === null) return WORKSPACE_SCOPE;
  const parts = address.rest.split("/").slice(0, -1);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const folder = { ...address, rest: parts.slice(0, depth).join("/") };
    const holding = [];
    for (const scope of scopes) {
      const target = await resolveArtifactFile(seen, artifactLocation(scope, folder));
      if (await isFolder(target, seen.base) && await authoredFolder(target)) holding.push(scope);
    }
    if (holding.length === 1) return holding[0];
    if (holding.length > 1) break;
  }
  return WORKSPACE_SCOPE;
}

// The scope input of an update_artifact operation that names a scope.
const scopeFieldsOf = (scope) => scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };

/**
 * The stored artifact at a project-relative path as { path, scope, bytes, version, modifiedAt }, or null when no seen scope holds it.
 * Two seen scopes that hold the path are refused with artifact_ambiguous, as a read without scope is.
 */
export async function readStoreArtifact(projectRoot, file) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    const held = await holders(seen, address, scopesFor(seen, address.kind, null));
    if (held.length > 1) throw ambiguous(normalized, held);
    if (!held.length) return null;
    const [{ scope, target, record }] = held;
    const modifiedAt = (await lstat(target).catch(() => null))?.mtimeMs ?? null;
    return { path: normalized, scope, bytes: contentOf(normalized, record), version: record.version, modifiedAt };
  });
}

/**
 * Change one store artifact for Prism itself under the store's artifact lock: decide gets the artifact's current text, or null when no seen scope holds it,
 * and returns the text to write, null to remove the artifact, or undefined to leave it.
 * The change is made of update_artifact operations with the version just read, so it takes every check an agent's update takes.
 * A new artifact takes the scope of ownScope, and with follow, which a generated view takes, an existing one moves there too, so a view follows its plans folder's scope.
 * Returns { written, scope, version }, with written false when nothing changed.
 */
export async function writeStoreArtifact(projectRoot, file, decide, { follow = false } = {}) {
  return refusing(async () => {
    const { config, kinds, file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const scopes = scopesFor(seen, address.kind, null);
      const held = await holders(seen, address, scopes);
      if (held.length > 1) throw ambiguous(normalized, held);
      const current = held[0] ?? null;
      const unchanged = { written: false, scope: current?.scope ?? null, version: current?.record.version ?? null };
      const next = await decide(current === null ? null : decode(contentOf(normalized, current.record), normalized));
      if (next === undefined || (next === null && current === null)) return unchanged;
      const preferred = next !== null && (current === null || follow) ? await ownScope(seen, address, scopes) : current?.scope ?? null;
      const check = (operation) => checkOperation(config, kinds, operation);
      // A scope that ## Components no longer declares cannot be named, so the file stays where it is, or takes the scope update_artifact gives it.
      const inScope = (operation, scope) => { try { return check({ ...operation, ...scopeFieldsOf(scope) }); } catch (error) { if (error?.code === "component_unknown") return null; throw error; } };
      const version = current?.record.version ?? null;
      let checked;
      if (next === null) checked = [check({ op: "remove", path: normalized, expectedVersion: version })];
      else if (current === null) checked = [inScope({ op: "write", path: normalized, content: next, expectedVersion: null }, preferred) ?? check({ op: "write", path: normalized, content: next, expectedVersion: null })];
      else {
        const moved = preferred.label !== current.scope.label && inScope({ op: "write", path: normalized, content: next, expectedVersion: null }, preferred);
        if (moved) checked = [check({ op: "remove", path: normalized, expectedVersion: version, ...scopeFieldsOf(current.scope) }), moved];
        else if (Buffer.from(next, "utf8").equals(current.record.bytes)) return unchanged;
        else checked = [check({ op: "write", path: normalized, content: next, expectedVersion: version })];
      }
      const entry = (await applyOperations(seen, checked)).artifacts.at(-1);
      return { written: true, scope: entry.scope, version: entry.version ?? null };
    });
  });
}

/**
 * The artifact at a location below artifacts/ in the record store at storeBase, as the checkout at projectRoot names it: { path, scope },
 * with path null when the checkout's store is another one or its configuration gives the location's kind no path.
 * It reads only the configuration, so a sync's saved copy is named even while the store refuses other access.
 */
export async function artifactAtLocation(projectRoot, storeBase, location) {
  const found = locationArtifact(location);
  if (!found) return null;
  const named = { path: null, scope: found.scope };
  try {
    const { kinds } = await configuration(projectRoot);
    if ((await recordStoreOf(projectRoot)).base !== storeBase) return named;
    const file = artifactPathOf(kinds, found.kind, found.rest);
    const address = file === null ? null : artifactAddress(kinds, file);
    return address?.kind === found.kind && address.rest === found.rest ? { ...named, path: file } : named;
  } catch {
    return named;
  }
}

/** The artifacts that the seen scopes hold below a project-relative folder, "" for all, as { path, scope, kind } sorted by path and then scope label, without reading them. */
export async function storeArtifactPaths(projectRoot, folder = "") {
  return refusing(async () => {
    await configuration(projectRoot);
    const normalized = normalizeArtifactPath(folder);
    if (normalized === null) throw notAnArtifact(folder);
    const seen = await seenScopes(projectRoot);
    return (await holdings(seen, normalized, null)).map(({ path: found, scope, kind }) => ({ path: found, scope, kind }));
  });
}

/**
 * The location below artifacts/ that a project-relative artifact path has in the scope that holds it, or would take when Prism writes it, as writeStoreArtifact decides,
 * with the limit a created location may hold.
 */
export async function storeArtifactLocation(projectRoot, file) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    const scopes = scopesFor(seen, address.kind, null);
    const held = await holders(seen, address, scopes);
    if (held.length > 1) throw ambiguous(normalized, held);
    const scope = held[0]?.scope ?? await ownScope(seen, address, scopes);
    return { scope, location: artifactLocation(scope, address), limit: LOCATION_MAX };
  });
}
