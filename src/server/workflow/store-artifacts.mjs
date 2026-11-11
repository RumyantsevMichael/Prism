import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { addComment, aheadOfClock, appliedComment, appliedComments, commentFolderOf, listComments, movedComment, storedAuthor, storedTime } from "./artifact-comments.mjs";
import { artifactIndex, markArtifactIndexStale } from "./artifact-index.mjs";
import { writeAtomically } from "./artifact-store.mjs";
import { assertInput } from "./artifact-schema.mjs";
import { ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_NAME_FORM, ARTIFACT_STATUS, artifactAddress, artifactLocation, artifactPathOf, componentScope, holdsArtifactPaths, IDENTITY_FILE_MAX, identityContent, identityOf, kindInScope, letterCaseKey, locationArtifact, locationIdentity, malformedArtifactName, newIdentity, normalizeArtifactPath, repositoryScope, uniqueIdentities, windowsDeviceName, WORKSPACE_SCOPE, wellFormedName } from "./artifact-paths.mjs";
import { acceptedLocation, answerApproval, askApproval, hasStatus, newRecord, notAStatusArtifact, parseRecord, serializeRecord, statusFields, statusMismatch, statusRecordLocation, waitableGates, withAcceptedVersion } from "./artifact-status.mjs";
import { ComponentError, readComponents } from "./components.mjs";
import { checkArtifactFolders, noteToolCallWrite, recordStoreOf, resolveArtifactFile, resolveStatusFile, seenScopes, statusFileResolver, withArtifactStoreLock } from "./record-store.mjs";
import { pruneArtifactFolders, scheduleRecordSync } from "./record-store-sync.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";

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
  label: { type: "string", minLength: 1, maxLength: 300 },
  location: { type: "string", minLength: 1, maxLength: 4096 },
  offset: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  limit: { type: "integer", minimum: 1, maximum: PAGE_LINES },
  commentOffset: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  accepted: { type: "boolean" }
}, ["projectRoot"]);

export const UPDATE_ARTIFACT_SCHEMA = object({
  projectRoot: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "write" }, path: text, content: anyText, expectedVersion: version, ...scopeFields }, ["op", "path", "content", "expectedVersion"]),
    object({ op: { const: "edit" }, path: text, expectedVersion: version, edits: { type: "array", minItems: 1, maxItems: 200, items: object({ oldText: anyText, newText: anyText }) }, ...scopeFields }, ["op", "path", "expectedVersion", "edits"]),
    object({ op: { const: "remove" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion"]),
    object({ op: { const: "move_scope" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion", "scope"]),
    object({ op: { const: "ask_approval" }, path: text, status: { type: "string", minLength: 1, maxLength: 200 }, question: text, context: { type: "string", maxLength: 8000 }, ...scopeFields }, ["op", "path", "context"])
  ] } }
}, ["projectRoot", "operations"]);

const SCOPE_TEXT = "scope is \"workspace\", \"repository\" for this checkout's repository, or \"component\" with component naming a component that ## Components in .prism/workflow.md declares";

export const ARTIFACT_TOOLS = Object.freeze([
  {
    name: "get_artifact",
    description: `In a project whose .prism/workflow.md names a record store, read a descriptive artifact the store holds: a requirement, an ADR, a plan file such as slice.md, the glossary, or the roadmap view. Address it by the project-relative path that the configured Requirements, ADRs, Plans, Glossary, and Roadmap paths give it; feature files, the user guide, tests, and code stay in the checkout and are refused with not_an_artifact. Every name below a configured folder, and the configured Glossary and Roadmap file names, must begin with an ASCII letter or digit, hold only ASCII letters, digits, ".", "_", and "-", not end in "." or ".lock", and be no Windows device name such as con, aux, nul, com1, or lpt1 before its first "."; any other is refused with artifact_name_invalid, data.invalidName holding the first such name, and listings leave such files out. A file read returns path, scope, kind, version (sha256 of its bytes, which update_artifact takes as expectedVersion), bytes, totalLines, offset, content, and nextOffset: content is whole lines from offset (1-based) up to limit lines (default 2000) and 64 KiB, at least one line, so read again from nextOffset until it is null. A requirement or ADR also returns status, its recorded status, which only a person's answer at a gate changes, and statusMismatch with written, recorded, and a message when its Status: line says otherwise; every file returns acceptedVersion and changedSinceAccepted against the bytes a person last accepted, approval once one is recorded, latestAnswer with the gate, status, choice (approve or request-changes), note, answeredAt, by, and entry (the id of the review app's history entry that applied it) of the person's latest answer at an approval gate, so requested changes reach an agent that no longer waits, and accepted true reads those accepted bytes. Every file read also returns comments, the people's comments on the file from the review browser, oldest first and including those a store sync brought from other machines, each with id, version (the version it was made on), line, text, author (name and host), at, and entry (the id of the review app's history entry that applied it), at most 20 in one read, with totalComments, the number of all of them, and nextCommentOffset, the 1-based position of the first one left out, or null; read the rest with commentOffset (1-based, default 1) set to nextCommentOffset until it is null. The comments move with the file to another scope and are removed with it. Every read also returns location, the artifact's place below artifacts/ in the store. Without path, or with a folder, it lists the artifacts of every scope the store holds below it: the workspace scope, each repository's scope, and each component scope, also those of other repositories, each with path, location, scope, kind, version, bytes, and status for a requirement or ADR, sorted by path and then scope label, at most 2000 with truncated true when more exist, and indexedAt, the time of the index the listing answers from, which Prism refreshes after each store sync and artifact write and once it is a minute old. An entry's path is where this checkout's configured folder of its kind puts it, or null when this checkout configures no path for its kind, and entries without a path list last; read one of those by location. label names one scope by the label listings report, such as workspace, a repository's name, or <repository>/<component>, and with path reads that scope's artifact; an unknown label is refused with scope_unknown and data.scopes listing the labels the store holds, and label with scope or component is refused with scope_invalid. location, a listing entry's location, reads the artifact there in place of path, and with path, label, scope, or component is refused with scope_invalid. A path that more than one scope holds is refused with artifact_ambiguous, data.scopes listing every holding scope's label, until label picks one; scope and component still name only this checkout's own scopes: ${SCOPE_TEXT}. Refusals: artifact_not_found, artifact_not_text, scope_invalid, component_unknown, store_not_configured when the project has no store, and the store's own refusal, such as store_unavailable or a repository name refusal, when it cannot be used. Reads never change a checkout file.`,
    inputSchema: GET_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_artifact",
    description: `In a project whose .prism/workflow.md names a record store, change descriptive artifacts in the store, addressed by project-relative path as get_artifact reads them, never by editing files in the checkout. operations holds at most 50 of write (path, content, expectedVersion), edit (path, expectedVersion, edits of oldText and newText, each replacing text that occurs exactly once in the text earlier edits left, else edit_not_applied with data.edit its index), remove (path, expectedVersion), move_scope (path, expectedVersion, and the scope to move it to), and ask_approval (path, optional status, default Approved, optional question, and context, the situation for a person who has not followed the work), which records a pending approval gate on a requirement or ADR at its current version and returns its id as gate, for the person to answer on Attention in the review browser and for wait_for_user_gate with artifact; it is refused with not_a_status_artifact for any other file, status_by_ship for Accepted on an ADR, which only a ship accepts, and nothing_to_approve when the status is already recorded and the bytes are the accepted ones. Leave Status: and Approved: lines to gates: a write whose Status: line differs from the recorded status is kept and its entry carries statusMismatch. expectedVersion is the version last read, or null to create; any other mismatch is refused with version_conflict and data.version holding the current version or null. write, edit, and remove take an optional scope to pick one when two scopes hold the path; ${SCOPE_TEXT}. A new artifact takes the given scope, else the scope that holds its nearest folder, else the workspace scope, and creating a path that another seen scope holds is refused with artifact_exists. A write that creates an artifact, and a move_scope, whose path differs only in letter case from an artifact path a seen scope holds, or from another write of the update, is refused with artifact_name_conflict and data.path holding that path, so change only the letter case by a remove and then a write in a later update. Such a write or move_scope whose location in the store, the path below artifacts/ in the scope it would take, holds more than 120 characters is refused with artifact_path_too_long and data.location, so choose a shorter path or a scope with a shorter folder. Such a write or move_scope in a component scope whose component name is a Windows device name, such as aux, nul, or com1, is refused with component_name_invalid and data.component, so rename the component under ## Components in .prism/workflow.md or choose another scope. move_scope of a path that several scopes hold moves the one copy whose version is expectedVersion. Content is UTF-8 text of at most 1 MiB, else artifact_too_large. Prism checks every operation before it changes any file, so a refused update changes nothing. The result lists, for each operation, the artifact's path, scope, and new version, or removed true. An artifact's comments from the review browser belong to it: move_scope moves them with it, remove removes them, and a write that creates an artifact removes the comments that a removed or moved artifact left at its path, and such an entry carries removedComments, the number of comments removed, when there were any, so read a file's comments with get_artifact before you remove it. A name that breaks the artifact name form that get_artifact describes is refused with artifact_name_invalid and data.invalidName, so choose another name. An agent changes only the artifacts of its own checkout's scopes, the workspace, its repository, and its components: a new artifact never takes another repository's scope, and a write with a version, edit, remove, move_scope, or ask_approval of a path that only other repositories' scopes hold is refused with scope_not_writable, data.scope naming the first such scope's label, so change it from a checkout of that repository. Paths outside the artifact paths are refused with not_an_artifact and stay in the checkout; without a store it refuses with store_not_configured.`,
    inputSchema: UPDATE_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
]);

// The store's own refusals and an invalid component declaration reach the agent as artifact refusals with the same code and message.
async function refusing(action) {
  try { return await action(); }
  catch (error) {
    if (error?.name === "RecordStoreError" || error instanceof ComponentError) throw fail(error.code, error.message, Object.fromEntries(["proposed", "store", "key", "folder", "component"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
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
  checkArtifactFolders(config);
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
// With memo, a Map that one read of many artifacts shares, each folder's names are read once for that read.
async function exactLocation(base, target, memo = null) {
  let folder = base;
  for (const name of path.relative(base, target).split(path.sep)) {
    let names;
    try {
      if (memo === null) names = await readdir(folder);
      else {
        if (!memo.has(folder)) memo.set(folder, readdir(folder).then((listed) => new Set(listed)));
        names = await memo.get(folder);
      }
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    if (!names.includes?.(name) && !names.has?.(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}

/**
 * What a store location holds, found without opening it or following a symbolic link: "missing", "folder", "file",
 * or "under_file" when a folder above it is a file; a link or special file is refused with invalid_path.
 * With base, the artifacts folder, a location that some name matches only in letter case is "missing".
 */
async function locationKind(target, base = null, memo = null) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") return "missing";
    if (error.code === "ENOTDIR") return "under_file";
    throw error;
  }
  if (base !== null && !(await exactLocation(base, target, memo))) return "missing";
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
async function readStored(target, base = null, memo = null) {
  if ((await locationKind(target, base, memo)) !== "file") return null;
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

/**
 * The project-relative path of a store artifact in a checkout: the configured folder of its kind followed by its rest, or the configured Glossary or Roadmap path,
 * or null when the checkout configures no path for its kind or the path leads to another kind or an excluded folder there.
 */
function checkoutPath(kinds, { kind, rest }) {
  const file = artifactPathOf(kinds, kind, rest);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  return address?.kind === kind && address.rest === rest ? file : null;
}

// Paths first, entries without a path last by location, and then scope labels.
const byListing = (left, right) => {
  if (left.path !== right.path) {
    if (left.path === null) return 1;
    if (right.path === null) return -1;
    return left.path < right.path ? -1 : 1;
  }
  if (left.location !== right.location && left.path === null) return left.location < right.location ? -1 : 1;
  return left.scope.label < right.scope.label ? -1 : left.scope.label > right.scope.label ? 1 : 0;
};

// The artifacts of the given scopes below a project-relative folder, from the store's artifact index, each with its path in this checkout and its location in the store.
async function listing(seen, folder, scopes) {
  const index = await artifactIndex(seen, seen.all);
  const labels = new Set(scopes.map((scope) => scope.label));
  const found = [];
  for (const entry of index.entries) {
    if (!labels.has(entry.scope.label)) continue;
    const file = checkoutPath(seen.kinds, entry);
    if (folder !== "" && (file === null || !below(folder, file))) continue;
    found.push({ path: file, location: entry.location, scope: entry.scope, entry });
  }
  found.sort(byListing);
  const artifacts = found.slice(0, LIST_MAX).map(({ path: file, location, scope, entry }) => ({
    path: file, location, scope, kind: entry.kind, version: entry.version, bytes: entry.bytes, ...(hasStatus(entry.kind) ? { status: entry.status } : {})
  }));
  return { artifacts, truncated: found.length > LIST_MAX, indexedAt: index.indexedAt };
}

/** The folder whose entries a store file's names are matched against: artifacts/, or the status, accepted, comments, or identity folder beside it that holds the file. */
function baseFor(seen, target) {
  for (const folder of [ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY]) {
    const base = path.join(seen.store.base, folder);
    if (target.startsWith(`${base}${path.sep}`)) return base;
  }
  return seen.base;
}

// A written file's path is checked again just before the write, below the folder it belongs to.
const resolveAgain = (seen, target) => baseFor(seen, target) === seen.base
  ? resolveArtifactFile(seen, path.relative(seen.base, target).split(path.sep).join("/"))
  : resolveStatusFile(seen, path.relative(seen.store.base, target).split(path.sep).join("/"));

/**
 * The status record of an artifact in a scope, or the record of an artifact that no gate changed yet when none is stored.
 * A location that holds no regular file, such as a link someone placed there, holds no record, so a read never follows it and never fails on it.
 */
// A read of many artifacts passes one resolver from manyReads, so each shared folder is checked and listed once for all of them.
const manyReads = (seen) => Object.assign(statusFileResolver(seen), { names: new Map() });
async function statusRecordOf(seen, scope, address, resolve = (relative) => resolveStatusFile(seen, relative)) {
  const held = await resolve(statusRecordLocation(scope, address)).then((target) => readStored(target, baseFor(seen, target), resolve.names ?? null)).catch(() => null);
  return parseRecord(address.kind, held?.bytes ?? null);
}

// The bytes a person last accepted, which a read with accepted true returns.
async function acceptedBytes(seen, file, version) {
  if (version === null) throw fail("artifact_not_accepted", `No person has accepted a version of ${file} yet: it is accepted at an approval, at the design acceptance of the slice whose folder holds it, or when its initiative ships.`);
  const held = await resolveStatusFile(seen, acceptedLocation(version)).then((target) => readStored(target, baseFor(seen, target))).catch(() => null);
  if (held?.version !== version) throw fail("artifact_not_accepted", `The accepted version ${version} of ${file} is not in the record store, so its bytes cannot be read; read the current version without accepted.`);
  return contentOf(file, held);
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

const readAmbiguous = (file, held) => {
  const labels = held.map((entry) => entry.scope.label).sort();
  return fail("artifact_ambiguous", `${file} is held by more than one scope of the record store (${labels.join(", ")}): pass label, one of these scope labels as listings report them, to read one.`, { scopes: labels });
};
const ambiguous = (file, held) => fail("artifact_ambiguous", `${file} is held by more than one scope this checkout sees (${held.map((entry) => entry.scope.label).join(", ")}): pass ${SCOPE_TEXT}, to pick one.`, { scopes: held.map((entry) => entry.scope.label) });
const notFound = (file) => fail("artifact_not_found", `No scope this checkout sees holds the artifact ${file} in the record store.`);
const scopeLabels = (seen) => seen.all.map((scope) => scope.label);
const notWritable = (file, scope) => fail("scope_not_writable", `${file} is held only by scope ${scope.label} of the repository ${scope.repository}, and an agent changes only the artifacts of its own checkout's scopes, the workspace, its repository, and its components; nothing changed. Change it from a checkout of ${scope.repository}.`, { scope: scope.label });

/** Read one store artifact by path, by scope label and path, or by location, or list the artifacts of every scope below a folder. */
export async function getArtifact(input) {
  return refusing(async () => {
    assertInput(GET_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    if (input.location !== undefined) {
      if (["path", "label", "scope", "component"].some((key) => input[key] !== undefined)) throw fail("scope_invalid", "location names an artifact by its place in the record store on its own, so it takes no path, label, scope, or component.");
      return readByLocation(await seenScopes(input.projectRoot), input);
    }
    if (input.label !== undefined && (input.scope !== undefined || input.component !== undefined)) throw fail("scope_invalid", "label names a scope on its own, so it takes no scope or component.");
    const file = normalizeArtifactPath(input.path ?? "");
    if (file === null) throw notAnArtifact(input.path);
    const address = file === "" ? null : artifactAddress(kinds, file);
    if (!address && !holdsArtifactPaths(kinds, file)) throw notAnArtifact(input.path);
    if (address) checkName(input.path, address);
    const given = scopeInput(config, input);
    if (address) checkKindScope(address.kind, given);
    const seen = await seenScopes(input.projectRoot);
    let scopes = seen.all;
    if (input.label !== undefined) {
      const labeled = seen.all.find((scope) => scope.label === input.label);
      if (!labeled) throw fail("scope_unknown", `${JSON.stringify(input.label)} is no scope label of the record store, which holds ${scopeLabels(seen).join(", ")}.`, { scopes: scopeLabels(seen) });
      if (address) checkKindScope(address.kind, labeled);
      scopes = [labeled];
    } else if (given) scopes = [scopeOf(seen, given)];
    if (!address || address.rest === "") return listing(seen, file, scopes);
    const candidates = scopes.filter((scope) => kindInScope(address.kind, scope));
    const held = await holders(seen, address, candidates);
    if (held.length > 1) throw readAmbiguous(file, held);
    if (held.length === 0) {
      for (const scope of candidates) {
        if (await isFolder(await resolveArtifactFile(seen, artifactLocation(scope, address)), seen.base)) return listing(seen, file, scopes);
      }
      throw notFound(file);
    }
    const [{ scope, record }] = held;
    return readResult(seen, input, { file, name: file, scope, address, record });
  });
}

// A read of the artifact at a location below artifacts/, whatever the checkout configures, with its path in this checkout or null.
async function readByLocation(seen, input) {
  const location = input.location;
  const found = locationArtifact(location);
  if (!found) throw fail("not_an_artifact", `${JSON.stringify(location)} is no artifact location in the record store: a location is the path below artifacts/ of a listing entry, such as requirements/a.md or repositories/<repository>/plans/<folder>/slice.md.`);
  const invalid = location.split("/").find((name) => !wellFormedName(name));
  if (invalid !== undefined) throw nameInvalid(location, invalid);
  const scope = seen.all.find((candidate) => candidate.label === found.scope.label);
  if (!scope) throw fail("artifact_not_found", `No scope of the record store holds the artifact at ${location}.`);
  const record = await readStored(await resolveArtifactFile(seen, location), seen.base);
  if (record === null) throw fail("artifact_not_found", `No scope of the record store holds the artifact at ${location}.`);
  const address = { kind: found.kind, rest: found.rest };
  const file = checkoutPath(seen.kinds, address);
  return readResult(seen, input, { file, name: file ?? location, scope, address: { ...address, path: file ?? location }, record });
}

// The page of one stored artifact that a read returns, with its status, accepted version, and comments.
async function readResult(seen, input, { file, name, scope, address, record }) {
  const status = await statusRecordOf(seen, scope, address);
  const current = contentOf(name, record);
  const bytes = input.accepted ? await acceptedBytes(seen, name, status.acceptedVersion) : current;
  const content = decode(bytes, name);
  const offset = input.offset ?? 1;
  const read = page(content, offset, input.limit ?? PAGE_LINES);
  const mismatch = input.accepted ? null : statusMismatch(address.kind, name, content, status);
  return {
    path: file, location: artifactLocation(scope, address), scope, kind: address.kind, version: artifactVersion(bytes), bytes: bytes.length, totalLines: read.totalLines, offset, content: read.content, nextOffset: read.nextOffset,
    ...statusFields(address.kind, status, record.version), ...(mismatch ? { statusMismatch: mismatch } : {}), ...(input.accepted ? { accepted: true } : {}),
    ...(await listComments(seen, scope, address, input.commentOffset ?? 1))
  };
}

// Operations on a status, which only a requirement or an ADR has; answer_approval and accept_version are Prism's own, never an agent's.
const STATUS_OPERATIONS = new Set(["ask_approval", "answer_approval"]);

// What can be checked without the store: each operation's artifact, its scope input, and the size of the content it writes.
function checkOperation(config, kinds, operation) {
  const file = normalizeArtifactPath(operation.path);
  const address = file === null || file === "" ? null : artifactAddress(kinds, file);
  if (!address) throw notAnArtifact(operation.path);
  checkName(operation.path, address);
  if (address.rest === "") throw fail("invalid_path", `${file} is the configured folder itself; name a file inside it.`);
  if (STATUS_OPERATIONS.has(operation.op) && !hasStatus(address.kind)) throw notAStatusArtifact(file);
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
    const base = baseFor(seen, target);
    for (let folder = path.dirname(target); folder !== base && folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
      if (state.get(folder)) throw fail("invalid_path", `${file} lies below ${names.get(folder)}, which this update writes as a file, so the two cannot both exist; nothing changed.`);
    }
    // Store entries that hold an artifact a seen scope lists were refused with artifact_name_conflict already; this catches the rest, such as a folder that holds only a lock, a temporary file, or Finder's .DS_Store.
    const variant = await letterCaseVariant(base, target, entries);
    if (variant !== null) {
      const location = path.relative(base, target).split(path.sep).join("/");
      throw fail("invalid_path", `${file} would be written at ${location} in the record store, where ${variant} already exists with a name that differs only in letter case, so a file system that ignores letter case, as macOS and Windows do by default, would write it into ${variant} under another path; nothing changed. Choose another name; a person can remove ${variant} from the store's artifacts folder if nothing in it is needed.`, { location: variant });
    }
    const kind = await locationKind(target, base);
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
  const other = collidingPath(letterCaseIndex(held, (entry) => entry), address.kind, file)
    ?? collidingPath(letterCaseIndex(checked, (candidate) => candidate.operation.op === "write" ? { kind: candidate.address.kind, path: candidate.file } : null), address.kind, file);
  if (other === undefined) return;
  throw fail("artifact_name_conflict", `${file} differs only in letter case from ${other}, which ${held.some((entry) => entry.path === other) ? "the record store holds" : "this update also writes"}, and the two would be one file on a file system that ignores letter case, as macOS and Windows do by default; nothing changed. Choose another name, or change the letter case of an artifact by removing it in one update and writing it in the next.`, { path: other });
}

// Two paths collide in letter case exactly when some leading part of both, the same number of names long, is equal with letter case ignored and differs without, so an index of every leading part finds a collision with one lookup per name.
// The index of one list of paths is built once, so an update or a move that writes thousands of files never compares each with every other.
const letterCaseIndexes = new WeakMap();
function letterCaseIndex(list, pathOf) {
  if (letterCaseIndexes.has(list)) return letterCaseIndexes.get(list);
  const index = new Map();
  for (const entry of list) {
    const named = pathOf(entry);
    if (!named) continue;
    const names = named.path.split("/");
    for (let depth = 1; depth <= names.length; depth += 1) {
      const key = `${named.kind}\0${names.slice(0, depth).map(letterCaseKey).join("/")}`;
      const exact = names.slice(0, depth).join("/");
      if (!index.has(key)) index.set(key, new Map());
      if (!index.get(key).has(exact)) index.get(key).set(exact, named.path);
    }
  }
  letterCaseIndexes.set(list, index);
  return index;
}

/** A path of an index that collides in letter case with a path of a kind, as collideInLetterCase decides, or undefined. */
export function collidingPath(index, kind, file) {
  const names = file.split("/");
  for (let depth = 1; depth <= names.length; depth += 1) {
    const exact = names.slice(0, depth).join("/");
    for (const [prefix, other] of index.get(`${kind}\0${names.slice(0, depth).map(letterCaseKey).join("/")}`) ?? []) if (prefix !== exact) return other;
  }
  return undefined;
}

/** An index of { kind, path } entries for collidingPath. */
export const pathIndex = (entries) => letterCaseIndex(entries, (entry) => entry);

/** Apply checked artifact operations to the store as one update: every operation is checked against the store before any file changes. */
export async function updateArtifact(input) {
  return refusing(async () => {
    assertInput(UPDATE_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    const checked = input.operations.map((operation) => checkOperation(config, kinds, operation));
    const seen = await seenScopes(input.projectRoot);
    // The tool call notes what its update wrote, so a move that the call finishes still removes a moved file whose artifact the update changed.
    return withArtifactStoreLock(seen, () => applyOperations(seen, checked, { noteWrites: true }));
  });
}

/**
 * Apply checked operations while the store's artifact lock is held: every operation is checked against the store before any file changes.
 * Every change to a store artifact, an agent's update and Prism's own plan files and views alike, goes through here.
 */
async function applyOperations(seen, checked, { held = null, noteWrites = false } = {}) {
  // Each file's bytes as the earlier operations of this update leave them, so later operations see their effect.
  const original = new Map();
  const state = new Map();
  // The artifact path each written location belongs to, for refusals that name it.
  const names = new Map();
  const read = async (target) => {
    if (!state.has(target)) {
      const record = await readStored(target, baseFor(seen, target));
      original.set(target, record);
      state.set(target, record);
    }
    return state.get(target);
  };
  // The artifact paths every seen scope held before the update, found once when a write creates an artifact or a move_scope runs.
  let before;
  // The move of a checkout's files, which holds the lock across its updates, passes the listing it took once.
  const heldBefore = async () => before ??= held ?? await holdings(seen, "", null);
  const one = async ({ file, address }, scopes) => {
    const held = await holders(seen, address, scopes, read);
    if (held.length > 1) throw ambiguous(file, held);
    return held[0] ?? null;
  };
  // Each artifact's status record changes with it in the same update, under the same lock, so a sync commits both or neither.
  const statusOf = async (scope, address) => {
    const target = await resolveStatusFile(seen, statusRecordLocation(scope, address));
    const held = await read(target);
    return { target, exists: held !== null, record: parseRecord(address.kind, held === null ? null : contentOf(target, held)) };
  };
  const setStatus = (target, file, record) => {
    state.set(target, record === null ? null : stored(Buffer.from(serializeRecord(record), "utf8")));
    names.set(target, file);
  };
  // The accepted bytes are kept once under their hash, so an approval and a design acceptance of the same bytes share one file.
  const keepAccepted = async (file, bytes) => {
    const target = await resolveStatusFile(seen, acceptedLocation(artifactVersion(bytes)));
    if ((await read(target)) === null) { state.set(target, stored(bytes)); names.set(target, file); }
  };
  // Each artifact's comments move and go with it in the same update, so a sync commits the artifact and its comments together.
  // A comment folder's entries as the earlier operations of this update leave them, by folder: each holds { name, target, comment }, with comment null for an entry that is no comment.
  const folders = new Map();
  const commentsAt = async (scope, address) => {
    const folder = await commentFolderOf(seen, scope, address);
    const key = folder.target ?? `\0${folder.location}`;
    if (!folders.has(key)) {
      folders.set(key, folder.entries);
      for (const entry of folder.entries) if (!original.has(entry.target)) { original.set(entry.target, { version: "held" }); state.set(entry.target, original.get(entry.target)); }
    }
    return { key, entries: folders.get(key) };
  };
  // Remove everything a location's comment folder holds and return the comments among it, for a move to carry or a result to count.
  const takeComments = async (scope, address, file) => {
    const { key, entries } = await commentsAt(scope, address);
    folders.set(key, []);
    for (const entry of entries) { state.set(entry.target, null); names.set(entry.target, file); }
    return entries.filter((entry) => entry.comment);
  };
  const putComments = async (scope, address, file, comments) => {
    const { entries } = await commentsAt(scope, address);
    for (const comment of comments) {
      const moved = await movedComment(seen, scope, address, comment);
      if (!original.has(moved.target)) original.set(moved.target, null);
      state.set(moved.target, stored(moved.bytes));
      names.set(moved.target, file);
      entries.push({ name: comment.name, target: moved.target, comment: parseStoreJson(moved.bytes.toString("utf8")) });
    }
  };
  // Each artifact's identity changes with it in the same update: a create writes a new one, a move carries it, a removal removes it, and every other write keeps it.
  // An identity file is a short line, so a larger file someone placed there is replaced or removed unread.
  // An entry at the identity path that is no file, such as a folder a sync brought, or one that stands in place of a folder above it, is no artifact's identity:
  // the update removes it before it writes, so it neither fails nor half applies over it.
  const strays = new Map();
  const identityAt = async (scope, address) => {
    const location = artifactLocation(scope, address);
    const target = path.join(seen.store.base, ARTIFACT_IDENTITY, ...location.split("/"));
    if (!state.has(target)) {
      const { record, stray } = await identityEntry(seen, location);
      original.set(target, record);
      state.set(target, record);
      if (stray) strays.set(target, stray);
    }
    return { target, location, record: state.get(target) };
  };
  const setIdentity = async (scope, address, file, id) => {
    const { target } = await identityAt(scope, address);
    state.set(target, id === null ? null : stored(Buffer.from(identityContent(id), "utf8")));
    names.set(target, file);
  };
  // The identity an artifact has, by the rule that keeps every identity of the store's tree its own: the one its identity file holds, else the one its location gives.
  const identityHeld = async (scope, address) => {
    const location = artifactLocation(scope, address);
    return (await storeIdentities(seen)).get(location) ?? locationIdentity(location);
  };
  const counted = (entry, removed) => removed.length ? Object.assign(entry, { removedComments: removed.length }) : entry;
  // A change to an artifact that no own scope holds, while another repository's scope holds it, is that repository's to make.
  const own = new Set(seen.scopes.map((scope) => scope.label));
  const refuseOthers = async ({ file, address }) => {
    const others = (seen.all ?? []).filter((scope) => !own.has(scope.label) && kindInScope(address.kind, scope));
    const [held] = await holders(seen, address, others, read);
    if (held) throw notWritable(file, held.scope);
  };
  // A requirement's or ADR's entry reports a written status that differs from the recorded one once every operation has run.
  const mismatches = [];
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
      if (current === null && operation.expectedVersion !== null && !(await holders(seen, address, all, read)).length) await refuseOthers(item);
      // A create always runs the letter-case check, whatever the location's lookup found, since a case-insensitive file system finds a stored variant there.
      if (operation.expectedVersion === null) checkLetterCase(item, await heldBefore(), checked);
      checkVersion(file, operation.expectedVersion, current);
      if (current === null) {
        checkComponentName(file, scope);
        checkLocationLength(scope, address);
        // A created artifact starts a record of its own: a new requirement is Draft and a new ADR Proposed, and a record a removed file left behind goes.
        const status = await statusOf(scope, address);
        if (hasStatus(address.kind)) setStatus(status.target, file, newRecord(address.kind, operation.writtenStatus ?? null));
        else if (status.exists) setStatus(status.target, file, null);
        // A created artifact is a new one, whatever an earlier artifact at its location was, so a sync never merges a change made on that earlier one into it.
        await setIdentity(scope, address, file, newIdentity());
      }
      // A created artifact never shows a comment made on an earlier artifact at its path, such as one a sync brought after another machine removed that artifact.
      const removed = current === null ? await takeComments(scope, address, file) : [];
      // A moved checkout file keeps its exact bytes, which need not be text.
      const next = operation.bytes ?? Buffer.from(operation.content, "utf8");
      state.set(target, stored(next));
      names.set(target, file);
      artifacts.push(counted({ path: file, scope, version: artifactVersion(next) }, removed));
      if (hasStatus(address.kind)) mismatches.push({ entry: artifacts.at(-1), file, scope, address, text: operation.content });
      continue;
    }
    const source = operation.op === "move_scope" ? await moveSource(item, await holders(seen, address, scopesFor(seen, address.kind, null), read)) : await one(item, scopesFor(seen, address.kind, given));
    if (!source) {
      await refuseOthers(item);
      if (operation.expectedVersion !== null && operation.expectedVersion !== undefined) checkVersion(file, operation.expectedVersion, null);
      throw notFound(file);
    }
    if (operation.expectedVersion !== undefined) checkVersion(file, operation.expectedVersion, source.record);
    if (operation.op === "edit") {
      const text = applyEdits(file, decode(contentOf(file, source.record), file), operation.edits);
      const next = Buffer.from(text, "utf8");
      tooLarge(file, next.length);
      state.set(source.target, stored(next));
      names.set(source.target, file);
      artifacts.push({ path: file, scope: source.scope, version: artifactVersion(next) });
      if (hasStatus(address.kind)) mismatches.push({ entry: artifacts.at(-1), file, scope: source.scope, address, text });
    } else if (operation.op === "remove") {
      state.set(source.target, null);
      const status = await statusOf(source.scope, address);
      if (status.exists) setStatus(status.target, file, null);
      await setIdentity(source.scope, address, file, null);
      // A removed artifact has no page that could show its comments, so they go with it, and the result counts them for the agent.
      artifacts.push(counted({ path: file, scope: source.scope, removed: true }, await takeComments(source.scope, address, file)));
    } else if (operation.op === "ask_approval") {
      const status = await statusOf(source.scope, address);
      const asked = askApproval(address.kind, file, status.record, { status: operation.status, question: operation.question, context: operation.context, version: source.record.version });
      setStatus(status.target, file, asked.record);
      artifacts.push({ path: file, scope: source.scope, version: source.record.version, gate: asked.gate.id });
    } else if (operation.op === "answer_approval") {
      const status = await statusOf(source.scope, address);
      const answered = answerApproval(address.kind, file, status.record, { ...operation.answer, version: source.record.version, text: decode(contentOf(file, source.record), file) });
      let record = answered.record;
      let version = source.record.version;
      if (answered.text !== null) {
        const next = Buffer.from(answered.text, "utf8");
        tooLarge(file, next.length);
        state.set(source.target, stored(next));
        names.set(source.target, file);
        version = artifactVersion(next);
        await keepAccepted(file, next);
        record = withAcceptedVersion(record, version, { event: "accepted", gate: answered.gate.id, at: answered.gate.answer.answeredAt });
      }
      setStatus(status.target, file, record);
      artifacts.push({ path: file, scope: source.scope, version, gate: answered.gate });
    } else if (operation.op === "accept_version") {
      const status = await statusOf(source.scope, address);
      if (status.record.acceptedVersion !== source.record.version) {
        await keepAccepted(file, contentOf(file, source.record));
        setStatus(status.target, file, withAcceptedVersion(status.record, source.record.version, operation.event));
      }
      artifacts.push({ path: file, scope: source.scope, version: source.record.version, acceptedVersion: source.record.version });
    } else {
      const scope = scopeOf(seen, given);
      let removed = [];
      checkComponentName(file, scope);
      checkLetterCase(item, await heldBefore(), checked);
      checkLocationLength(scope, address);
      if (scope.label !== source.scope.label) {
        const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
        if ((await read(target)) !== null) throw fail("artifact_exists", `${file} already exists in scope ${scope.label}, so it cannot move there from scope ${source.scope.label}.`, { scope });
        state.set(target, stored(contentOf(file, source.record)));
        names.set(target, file);
        state.set(source.target, null);
        // The status record moves with the artifact, so its recorded status, gates, and accepted version stay its own.
        const from = await statusOf(source.scope, address);
        const to = await statusOf(scope, address);
        if (from.exists) { setStatus(to.target, file, from.record); setStatus(from.target, file, null); }
        else if (to.exists) setStatus(to.target, file, null);
        // The comments move with it too, each with its own file name and its location rewritten, and whatever the new location's folder held before goes, as a create removes it.
        removed = await takeComments(scope, address, file);
        await putComments(scope, address, file, await takeComments(source.scope, address, file));
        // The identity moves with it and leaves nothing at the old location, so a sync places a change that another machine made there on the moved artifact.
        const id = await identityHeld(source.scope, address);
        await setIdentity(source.scope, address, file, null);
        await setIdentity(scope, address, file, id);
      }
      artifacts.push(counted({ path: file, scope, version: source.record.version }, removed));
    }
  }
  for (const { entry, scope, address, file, text } of mismatches) {
    if (state.get(await resolveArtifactFile(seen, artifactLocation(scope, address)))?.version !== entry.version) continue;
    const mismatch = statusMismatch(address.kind, file, text, (await statusOf(scope, address)).record);
    if (mismatch) entry.statusMismatch = mismatch;
  }
  // New bytes are written before removals, so a move interrupted midway leaves the artifact in both scopes rather than in neither.
  const changed = [...state].filter(([target, record]) => (record?.version ?? null) !== (original.get(target)?.version ?? null));
  const clearing = [...strays].filter(([target]) => names.has(target));
  await checkLayout(seen, changed.filter(([target, record]) => record !== null && !strays.has(target)), state, names);
  // A stray entry where an identity file of this update belongs goes first, as no file of any artifact.
  for (const [, stray] of clearing) {
    if ((await lstat(stray).catch(() => null))?.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    await rm(stray, { recursive: true, force: true });
    await pruneArtifactFolders(baseFor(seen, stray), stray);
  }
  for (const [target, record] of changed.filter(([, record]) => record !== null)) {
    await mkdir(path.dirname(target), { recursive: true });
    await resolveAgain(seen, target);
    await writeAtomically(target, record.bytes);
    if (noteWrites) noteToolCallWrite(target, record.version);
  }
  for (const [target] of changed.filter(([, record]) => record === null)) {
    await rm(target, { force: true });
    await pruneArtifactFolders(baseFor(seen, target), target);
  }
  // A change syncs as a record write does, so it is committed and pushed without a further call; the sync stages artifacts only once this update releases the artifact lock.
  if (changed.length || clearing.length) {
    await markArtifactIndexStale(seen.store.base);
    if (seen.store.sync) scheduleRecordSync(seen.store.base);
  }
  return { artifacts };
}

/**
 * What a store holds at the identity path of a location: { record, stray }, with record the identity file as a stored record, { bytes: null, version: "held" } for a file too large to be one, or null,
 * and stray the path of an entry that stands in the way of an identity file there, a folder or other entry at the path, or a file or other entry in place of a folder above it, or null.
 * No link is followed: a link at or above the path is refused, as at every other store path.
 */
async function identityEntry(seen, location) {
  const names = location.split("/");
  let current = seen.store.base;
  for (const [index, name] of [ARTIFACT_IDENTITY, ...names].entries()) {
    current = path.join(current, name);
    const info = await lstat(current).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
    if (info === null) break;
    if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    if (index < names.length) {
      if (info.isDirectory()) continue;
      return { record: null, stray: current };
    }
    if (!info.isFile()) return { record: null, stray: current };
  }
  const target = await resolveStatusFile(seen, `${ARTIFACT_IDENTITY}/${location}`);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) return { record: null, stray: null };
  const bytes = info.size <= IDENTITY_FILE_MAX ? await readFile(target).catch(() => null) : null;
  return { record: bytes === null ? { bytes: null, version: "held" } : stored(bytes), stray: null };
}

/**
 * The identity of every artifact the store holds, as Map(location, id), read from the store's whole tree as a sync reads it:
 * each location below artifacts/ that holds a regular file takes the id its identity file holds, else the one its location gives, and no two locations keep one id.
 * Links are never followed, and a file too large to be an identity is never read.
 */
async function storeIdentities(seen) {
  const locations = [];
  const visit = async (relative) => {
    let entries;
    try { entries = await readdir(relative === "" ? seen.base : path.join(seen.base, ...relative.split("/")), { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && child.split("/").every(wellFormedName)) locations.push(child);
    }
  };
  await visit("");
  const written = new Map();
  for (const location of locations) {
    const target = path.join(seen.store.base, ARTIFACT_IDENTITY, ...location.split("/"));
    const info = await lstat(target).catch(() => null);
    const id = info?.isFile() && info.size <= IDENTITY_FILE_MAX ? identityOf(await readFile(target).catch(() => null)) : null;
    if (id !== null) written.set(location, id);
  }
  return uniqueIdentities(locations, written);
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
 * What the review browser shows of a stored artifact at a project-relative path, or null when no seen scope holds it:
 * { path, scope, bytes, version, modifiedAt, accepted, changed, comments, totalComments, nextCommentOffset }, where accepted is { version, content } of the bytes a person last accepted,
 * with content null when the store lacks those bytes, or null when none was accepted, changed whether the bytes differ from them,
 * and comments one page of the artifact's comments, oldest first, from the 1-based commentOffset, with their total and the offset of the next page, as get_artifact returns them.
 * Two seen scopes that hold the path are refused with artifact_ambiguous, as a read without scope is.
 */
export async function reviewStoreArtifact(projectRoot, file, { commentOffset = 1 } = {}) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    const held = await holders(seen, address, scopesFor(seen, address.kind, null));
    if (held.length > 1) throw ambiguous(normalized, held);
    if (!held.length) return null;
    const [{ scope, target, record }] = held;
    const modifiedAt = (await lstat(target).catch(() => null))?.mtimeMs ?? null;
    const { acceptedVersion } = await statusRecordOf(seen, scope, address);
    const acceptedText = acceptedVersion === null ? null : await acceptedBytes(seen, normalized, acceptedVersion).then((bytes) => artifactText(bytes), () => null);
    return {
      path: normalized, scope, bytes: contentOf(normalized, record), version: record.version, modifiedAt,
      accepted: acceptedVersion === null ? null : { version: acceptedVersion, content: acceptedText },
      changed: acceptedVersion !== record.version,
      ...(await listComments(seen, scope, address, commentOffset))
    };
  });
}

// The scope that a scope label names among the scopes a checkout sees, or null.
const labeledScope = (seen, label) => seen.scopes.find((scope) => scope.label === label) ?? null;

/**
 * The store artifact that a scope label and a project-relative path name, as the review app's comment target names it: { path, scope, kind, version },
 * or null when the project names no store, the path is no artifact path, or the labeled scope is not seen or holds no file there.
 * An unavailable store or a refused repository name is refused with the store's own refusal, as a read is.
 */
export async function storeArtifactTarget(projectRoot, label, file) {
  return refusing(async () => {
    let checked;
    try { checked = await ownArtifact(projectRoot, file); }
    catch (error) { if (["store_not_configured", "not_an_artifact", "artifact_name_invalid"].includes(error?.code)) return null; throw error; }
    if (checked.file !== file) return null;
    const seen = await seenScopes(projectRoot);
    const scope = labeledScope(seen, label);
    if (!scope || !kindInScope(checked.address.kind, scope)) return null;
    const [held] = await holders(seen, checked.address, [scope]);
    return held ? { path: checked.file, scope, kind: checked.address.kind, version: held.record.version } : null;
  });
}

/**
 * Store a person's comment on the artifact that a scope label and a project-relative path name, under the store's artifact lock: { path, label, version, line, text, author, entry },
 * where version is the version the comment was made on and entry the review app's history entry that applies it.
 * It is refused with artifact_not_found when no seen scope with that label holds the artifact, and with version_conflict and data.version when its bytes are another version now.
 * Returns the comment as a reader gets it.
 */
export async function commentOnArtifact(projectRoot, { path: file, label, version: expected, line, text, author, entry }) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const scope = labeledScope(seen, label);
      const [held] = scope ? await holders(seen, address, [scope]) : [];
      if (!held) throw notFound(normalized);
      if (held.record.version !== expected) throw fail("version_conflict", `${normalized} changed since the page read it.`, { version: held.record.version });
      return addComment(seen, scope, address, { version: expected, line, text, author, entry });
    });
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
        // A view that follows its plans folder to another scope moves there as move_scope moves a file, so its status record and comments go with it, and then takes its new text.
        const moved = preferred.label !== current.scope.label && inScope({ op: "move_scope", path: normalized, expectedVersion: version }, preferred);
        if (moved) checked = [moved, check({ op: "write", path: normalized, content: next, expectedVersion: version, ...scopeFieldsOf(preferred) })];
        else if (Buffer.from(next, "utf8").equals(current.record.bytes)) return unchanged;
        else checked = [check({ op: "write", path: normalized, content: next, expectedVersion: version })];
      }
      const entry = (await applyOperations(seen, checked)).artifacts.at(-1);
      return { written: true, scope: entry.scope, version: entry.version ?? null };
    });
  });
}

// The move of a checkout's existing artifacts runs inside the first access of the checkout, so it works on the scopes it was given, while holding the store's artifact lock itself.

/** The artifacts that the seen scopes hold, as { path, scope, kind, target } sorted by path and then scope label, without reading them. */
export const seenArtifacts = (seen) => holdings(seen, "", null);

/** The stored file of an artifact address in one scope, as { target, location, record }, with record { bytes, size, version } or null when the scope holds no file there. */
export async function storedArtifactIn(seen, scope, address) {
  const location = artifactLocation(scope, address);
  const target = await resolveArtifactFile(seen, location);
  return { target, location, record: await readStored(target, seen.base) };
}

/** The most characters an artifact's location may hold when Prism creates it. */
export const ARTIFACT_LOCATION_MAX = LOCATION_MAX;

/** The most bytes an artifact's content may hold when it is written. */
export const ARTIFACT_CONTENT_MAX = CONTENT_MAX;

/** The text of bytes that are UTF-8 text as a read decides it, or null when get_artifact would refuse them with artifact_not_text. */
export function artifactText(bytes) {
  try { return decoder.decode(bytes); }
  catch { return null; }
}

/**
 * Create artifacts in the store for the move of a checkout's files, while the caller holds the store's artifact lock: each of writes,
 * { file, address, scope, bytes, text, writtenStatus }, is created with its exact bytes in its scope, and a requirement or ADR records its written status.
 * held is the listing the move took of every seen scope, which stays valid while the move holds the lock, so no write lists the store again.
 * The writes take every check that an update's write takes, and a refused one refuses them all; returns the result's artifacts.
 */
export async function createMovedArtifacts(seen, writes, { held = null } = {}) {
  const items = writes.map(({ file, address, scope, bytes, text, writtenStatus }) => ({
    operation: { op: "write", path: file, content: text, bytes, expectedVersion: null, writtenStatus, ...scopeFieldsOf(scope) },
    file, address, given: scope.kind === "component" ? { kind: "component", component: scope.component } : { kind: scope.kind }
  }));
  return items.length ? (await applyOperations(seen, items, { held })).artifacts : [];
}

/**
 * Record the written status of a moved requirement or ADR whose store location already holds its bytes but no status record, as a move interrupted between the two leaves it,
 * while the caller holds the store's artifact lock; returns whether it wrote the record.
 */
export async function recordMovedStatus(seen, scope, address, written) {
  if (!hasStatus(address.kind)) return false;
  const target = await resolveStatusFile(seen, statusRecordLocation(scope, address));
  if ((await locationKind(target, baseFor(seen, target))) !== "missing") return false;
  await mkdir(path.dirname(target), { recursive: true });
  await resolveAgain(seen, target);
  await writeAtomically(target, serializeRecord(newRecord(address.kind, written ?? null)));
  await markArtifactIndexStale(seen.store.base);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return true;
}

/** Write a view that Prism generates into one scope for the move of a checkout's files, while the caller holds the store's artifact lock, replacing the version that was read. */
export async function writeMovedView(seen, file, address, scope, content, expectedVersion) {
  const item = { operation: { op: "write", path: file, content, expectedVersion, ...scopeFieldsOf(scope) }, file, address, given: { kind: scope.kind } };
  return (await applyOperations(seen, [item])).artifacts[0];
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

// Status changes at gates: the review browser answers approval gates, a gate wait reads them, and design acceptance keeps accepted versions, each through the checked update above.

/**
 * The scope input that a scope name from the review browser or a gate wait gives: "workspace", "repository", "component" with component, or a scope label as Attention lists it;
 * undefined leaves the scope to the path.
 */
function namedScope(seen, scope, component) {
  if (scope === undefined || scope === null) return {};
  if (typeof scope === "object") return namedScope(seen, scope.kind, scope.component);
  if (scope === "component" || (SCOPE_KINDS.has(scope) && component === undefined)) return { scope, ...(component === undefined ? {} : { component }) };
  if (scope === seen.repository) return { scope: "repository" };
  if (typeof scope === "string" && scope.startsWith(`${seen.repository}/`)) return { scope: "component", component: scope.slice(seen.repository.length + 1) };
  throw fail("scope_invalid", `${JSON.stringify(scope)} is no scope this checkout sees: ${SCOPE_TEXT}.`);
}

/**
 * Apply a person's answer to an approval gate of a requirement or ADR, refused with artifact_changed when the artifact changed since the gate was asked.
 * Approving rewrites its Status: and Approved: lines and records the status, the accepted version, and the approval with by, who answered,
 * and the status record keeps entry, the review app's history entry of the action that applied the answer.
 * Returns the artifact's entry: { path, scope, version, gate } with the answered gate.
 */
export async function answerArtifactApproval(projectRoot, { path: file, scope, component, id, choice, note = null, by, entry = null }) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const item = checkOperation(config, kinds, { op: "answer_approval", path: file, ...namedScope(seen, scope, component), answer: { id, choice, note, by, entry } });
    return withArtifactStoreLock(seen, async () => {
      // The id is checked again under the lock, so a status record that came to share it after the caller read the gates is never answered in its place.
      const holding = (await seenPendingGates(seen)).filter((gate) => gate.id === id);
      if (holding.length > 1) throw fail("approval_ambiguous", ambiguousApprovalMessage(id, holding), { holders: holding.map((gate) => gate.artifact) });
      return (await applyOperations(seen, [item])).artifacts[0];
    });
  });
}

/**
 * The refusal message of an approval id that more than one pending gate holds, naming each artifact's path and scope label,
 * since an answer to it cannot tell which file the person approves.
 */
export function ambiguousApprovalMessage(id, gates) {
  const named = gates.map((gate) => `${gate.artifact.path} (${gate.artifact.scope?.label ?? "workspace"})`);
  return `More than one pending approval holds the id ${id}, so an answer to it cannot tell which file it approves: ${named.join(", ")}. Nothing was recorded; the agent asks again for the file it means.`;
}

// The requirements and ADRs that the seen scopes hold, as holdings lists them.
async function statusHoldings(seen) {
  const found = [];
  for (const entry of seen.kinds.kinds.filter((candidate) => hasStatus(candidate.kind))) found.push(...(await holdings(seen, entry.path, null)).filter((held) => held.kind === entry.kind));
  return sortEntries(found);
}

/**
 * Every pending approval gate of the requirements and ADRs that the checkout sees, as { id, status, version, question, context, askedAt, artifact: { path, scope }, recorded, current, changed },
 * where recorded is the artifact's recorded status, current the version of its bytes now, and changed whether they changed since the gate was asked, so that an answer is refused with artifact_changed.
 */
export async function pendingApprovalGates(projectRoot) {
  return refusing(async () => {
    await configuration(projectRoot);
    return seenPendingGates(await seenScopes(projectRoot));
  });
}

async function seenPendingGates(seen) {
  const gates = [];
  const resolve = manyReads(seen);
  for (const entry of await statusHoldings(seen)) {
    const record = await statusRecordOf(seen, entry.scope, artifactAddress(seen.kinds, entry.path), resolve);
    if (!record.pending.length) continue;
    const current = await readStored(entry.target).catch(() => null);
    for (const gate of record.pending) gates.push({ ...gate, artifact: { path: entry.path, scope: entry.scope }, recorded: record.status, current: current?.version ?? null, changed: current?.version !== gate.version });
  }
  return gates;
}

// A status record's history item keeps the review app's history entry of the answer that applied it; a store sync brings records that no Prism checked,
// so an entry is taken only in the exact form answerApproval writes it, with its time, gate, choice, and author agreeing with the item that keeps it.
const ANSWER_EVENTS = { approved: "approve", changes_requested: "request-changes" };
const ENTRY_KEYS = ["id", "action", "target", "before", "after", "at", "by", "via"];
const isPlainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isPlainRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const appliedEntry = (item) => {
  if (!isPlainRecord(item) || !Object.hasOwn(ANSWER_EVENTS, item.event) || typeof item.gate !== "string" || item.gate === "" || !storedTime(item.at)) return null;
  if (!isPlainRecord(item.by) || typeof item.by.name !== "string" || typeof item.by.host !== "string") return null;
  const entry = item.entry;
  if (!exactKeys(entry, ENTRY_KEYS) || typeof entry.id !== "string" || !/^[0-9a-f]{32}$/.test(entry.id)) return null;
  if (entry.action !== "gate.answer" || entry.target !== `approval:${item.gate}` || entry.before !== null || entry.via !== "review-app") return null;
  if (!exactKeys(entry.after, ["choice", "note"]) || entry.after.choice !== ANSWER_EVENTS[item.event]) return null;
  if (entry.after.note !== null && !(typeof entry.after.note === "string" && entry.after.note.length <= 4000)) return null;
  if (!storedTime(entry.at) || entry.at !== item.at || !storedAuthor(entry.by) || entry.by.name !== item.by.name) return null;
  return entry;
};

/**
 * The review app's applied actions on the store artifacts the checkout sees: those that the status records of its requirements and ADRs keep, such as an approval's gate.answer,
 * and the comments, each read from its own file, each as its history entry with initiative null and artifact { path, scope }, since such an action belongs to no initiative;
 * an entry is listed only in the form Prism writes and once its time is no more than a few minutes ahead of the clock, and an entry that two records keep is listed once.
 * latest, when given, reads of each artifact's comments only the newest that many by time and then entry id, which are all a list of the newest that many entries can show.
 * Every caller passes latest, since without it every comment of every artifact is read; one applied action is found with appliedArtifactAction instead.
 */
export async function appliedArtifactActions(projectRoot, { latest = Infinity } = {}) {
  return refusing(async () => {
    await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const listed = new Map();
    // An entry dated more than a few minutes after this machine's clock waits, so no file stays at the top of the list by a time to come.
    const now = Date.now();
    const resolve = manyReads(seen);
    for (const entry of await statusHoldings(seen)) {
      const record = await statusRecordOf(seen, entry.scope, artifactAddress(seen.kinds, entry.path), resolve);
      for (const item of record.history) {
        const applied = appliedEntry(item);
        if (applied && !aheadOfClock(applied.at, now) && !listed.has(applied.id)) listed.set(applied.id, { ...applied, initiative: null, artifact: { path: entry.path, scope: entry.scope } });
      }
    }
    // Only the comment folders of the artifacts that the checkout sees are read, so a folder at a location that holds no artifact costs nothing.
    const artifacts = (await holdings(seen, "", null)).map(({ path: file, scope }) => ({ path: file, scope }));
    for (const comment of await appliedComments(seen, now, { latest, artifacts, resolve })) if (!listed.has(comment.id)) listed.set(comment.id, comment);
    return [...listed.values()];
  });
}

/** The store location of an artifact that a checkout names by its project-relative path and scope, as { path, scope }, or null when the path is no artifact path there. */
export async function artifactStoreLocation(projectRoot, { path: file, scope }) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const address = artifactAddress(kinds, file);
    return address ? artifactLocation(scope, address) : null;
  });
}

/**
 * The applied action on a store artifact, given by the artifact's store location and the entry's id and action, as this checkout's Recent changes lists it, naming the artifact by this checkout's path and scope,
 * or null when the checkout does not see the artifact, meaning that no scope it sees holds the file at that location, or does not list that entry.
 * A gate.answer is read from that one artifact's status record, and an artifact.comment from the one comment file that comment, the stored comment's id, names,
 * so delivering an action to another checkout costs about one entry, never a listing of every artifact's actions.
 */
export async function appliedArtifactAction(projectRoot, { location, id, action, comment = null }) {
  return refusing(async () => {
    await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const named = locationArtifact(location);
    if (!named) return null;
    const file = artifactPathOf(seen.kinds, named.kind, named.rest);
    const address = file === null ? null : artifactAddress(seen.kinds, file);
    // The checkout names the artifact by its own path only when that path leads back to the same kind and location, as a listing of its holdings finds it.
    if (!address || address.kind !== named.kind || address.rest !== named.rest || malformedArtifactName(address) !== null) return null;
    const scope = seen.scopes.find((candidate) => kindInScope(address.kind, candidate) && artifactLocation(candidate, address) === location);
    if (!scope) return null;
    const target = await resolveArtifactFile(seen, location).catch(() => null);
    if (!target || (await locationKind(target, seen.base).catch(() => null)) !== "file") return null;
    const now = Date.now();
    const artifact = { path: file, scope };
    if (action === "gate.answer") {
      if (!hasStatus(address.kind)) return null;
      const record = await statusRecordOf(seen, scope, address);
      const applied = record.history.map(appliedEntry).find((entry) => entry?.id === id) ?? null;
      return applied && !aheadOfClock(applied.at, now) ? { ...applied, initiative: null, artifact } : null;
    }
    if (action === "artifact.comment" && typeof comment === "string") return appliedComment(seen, artifact, address, { comment, id }, now);
    return null;
  });
}

/**
 * The approval gates named by ids among the requirements and ADRs that the checkout sees, as { artifact: { path, scope }, gate },
 * with gate as a gate wait reads it: pending without an answer, or answered with it. A gate that a later question replaced, or whose artifact is gone, is not listed.
 */
export async function approvalGatesWithIds(projectRoot, ids) {
  return refusing(async () => {
    await configuration(projectRoot);
    const wanted = new Set(ids);
    const seen = await seenScopes(projectRoot);
    const gates = [];
    if (!wanted.size) return gates;
    const resolve = manyReads(seen);
    for (const entry of await statusHoldings(seen)) {
      const record = await statusRecordOf(seen, entry.scope, artifactAddress(seen.kinds, entry.path), resolve);
      for (const gate of waitableGates(record)) if (wanted.has(gate.id)) gates.push({ artifact: { path: entry.path, scope: entry.scope }, gate: { ...gate, artifact: entry.path } });
    }
    return gates;
  });
}

/** The recorded statuses of the requirements and ADRs that the seen scopes hold below a project-relative folder, as { path, scope, status }. */
export async function storeArtifactStatuses(projectRoot, folder = "") {
  return refusing(async () => {
    await configuration(projectRoot);
    const normalized = normalizeArtifactPath(folder);
    if (normalized === null) throw notAnArtifact(folder);
    const seen = await seenScopes(projectRoot);
    const statuses = [];
    const resolve = manyReads(seen);
    for (const entry of await statusHoldings(seen)) {
      if (below(normalized, entry.path)) statuses.push({ path: entry.path, scope: entry.scope, status: (await statusRecordOf(seen, entry.scope, artifactAddress(seen.kinds, entry.path), resolve)).status });
    }
    return statuses;
  });
}

/**
 * The approval gates of one requirement or ADR as a gate wait reads them: pending ones without an answer, answered ones with it, each with options and kind approval.
 * The artifact is found by its path, and by scope when two seen scopes hold it.
 * A wait that already read the gates passes since true: an artifact that is gone from the seen scopes then has no gates, so the wait ends as resolved,
 * and one that another scope came to hold too has the gates of every copy, since a gate id names one gate.
 */
export async function artifactApprovalGates(projectRoot, file, scope, component, { since = false } = {}) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const { address, given } = checkOperation(config, kinds, { op: "answer_approval", path: file, ...namedScope(seen, scope, component) });
    const held = await holders(seen, address, scopesFor(seen, address.kind, given));
    if (since) {
      const gates = [];
      for (const entry of held) gates.push(...waitableGates(await statusRecordOf(seen, entry.scope, address)));
      return gates;
    }
    if (held.length > 1) throw ambiguous(file, held);
    if (!held.length) throw notFound(file);
    return waitableGates(await statusRecordOf(seen, held[0].scope, address));
  });
}

/**
 * Keep the current bytes of every store artifact below the given project-relative folders, except below the excluded ones and except Prism's generated views,
 * as each one's accepted version, recording event with it; returns the touched artifacts' entries.
 */
export async function acceptArtifactVersions(projectRoot, folders, { exclude = [], event }) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const items = [];
      for (const folder of folders) {
        for (const entry of await holdings(seen, folder, null)) {
          if (exclude.some((other) => below(other, entry.path)) || generatedView(await readStored(entry.target).catch(() => null))) continue;
          try { items.push(checkOperation(config, kinds, { op: "accept_version", path: entry.path, ...scopeFieldsOf(entry.scope), event })); }
          catch (error) { if (error?.code !== "component_unknown") throw error; }
        }
      }
      return items.length ? (await applyOperations(seen, items)).artifacts : [];
    });
  });
}
