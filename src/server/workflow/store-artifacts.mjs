import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { assertInput } from "./artifact-schema.mjs";
import { ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, artifactPathOf, componentScope, holdsArtifactPaths, kindInScope, malformedArtifactName, normalizeArtifactPath, repositoryScope, WORKSPACE_SCOPE, wellFormedName } from "./artifact-paths.mjs";
import { ComponentError, readComponents } from "./components.mjs";
import { resolveArtifactFile, seenScopes, withArtifactStoreLock } from "./record-store.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";

// Agents read and write a workspace's descriptive artifacts in its record store through these tools, addressed by the project-relative path the checkout's configured paths give them.
const PAGE_LINES = 2000;
const PAGE_BYTES = 64 * 1024;
const LIST_MAX = 2000;
const CONTENT_MAX = 1024 * 1024;
// A file someone placed in the store by hand can exceed what a write accepts, so reads take a larger file, up to this bound.
const READ_MAX = 16 * 1024 * 1024;
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
    description: `In a project whose .prism/workflow.md names a record store, read a descriptive artifact the store holds: a requirement, an ADR, a plan file such as slice.md, the glossary, or the roadmap view. Address it by the project-relative path that the configured Requirements, ADRs, Plans, Glossary, and Roadmap paths give it; feature files, the user guide, tests, and code stay in the checkout and are refused with not_an_artifact. Every name below a configured folder, and the configured Glossary and Roadmap file names, must begin with an ASCII letter or digit, hold only ASCII letters, digits, ".", "_", and "-", and not end in ".lock"; any other is refused with artifact_name_invalid, data.invalidName holding the first such name, and listings leave such files out. A file read returns path, scope, kind, version (sha256 of its bytes, which update_artifact takes as expectedVersion), bytes, totalLines, offset, content, and nextOffset: content is whole lines from offset (1-based) up to limit lines (default 2000) and 64 KiB, at least one line, so read again from nextOffset until it is null. Without path, or with a folder, it lists the artifacts this checkout sees below it with path, scope, kind, version, and bytes, at most 2000 with truncated true when more exist. The checkout sees the workspace scope, its repository's scope, and its repository's component scopes the store holds; a path that two of them hold is refused with artifact_ambiguous, listing their labels, until ${SCOPE_TEXT}. Refusals: artifact_not_found, artifact_not_text, scope_invalid, component_unknown, store_not_configured when the project has no store, and the store's own refusal, such as store_unavailable or a repository name refusal, when it cannot be used. Reads never change a checkout file.`,
    inputSchema: GET_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_artifact",
    description: `In a project whose .prism/workflow.md names a record store, change descriptive artifacts in the store, addressed by project-relative path as get_artifact reads them, never by editing files in the checkout. operations holds at most 50 of write (path, content, expectedVersion), edit (path, expectedVersion, edits of oldText and newText, each replacing text that occurs exactly once in the text earlier edits left, else edit_not_applied with data.edit its index), remove (path, expectedVersion), and move_scope (path, expectedVersion, and the scope to move it to). expectedVersion is the version last read, or null to create; any other mismatch is refused with version_conflict and data.version holding the current version or null. write, edit, and remove take an optional scope to pick one when two scopes hold the path; ${SCOPE_TEXT}. A new artifact takes the given scope, else the scope that holds its nearest folder, else the workspace scope, and creating a path that another seen scope holds is refused with artifact_exists. Content is UTF-8 text of at most 1 MiB, else artifact_too_large. Prism checks every operation before it changes any file, so a refused update changes nothing. The result lists, for each operation, the artifact's path, scope, and new version, or removed true. A name that breaks the artifact name form that get_artifact describes is refused with artifact_name_invalid and data.invalidName, so choose another name. Paths outside the artifact paths are refused with not_an_artifact and stay in the checkout; without a store it refuses with store_not_configured.`,
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
 * What a store location holds, found without opening it or following a symbolic link: "missing", "folder", "file",
 * or "under_file" when a folder above it is a file; a link or special file is refused with invalid_path.
 */
async function locationKind(target) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") return "missing";
    if (error.code === "ENOTDIR") return "under_file";
    throw error;
  }
  if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact in the record store is a symbolic link, which Prism does not follow.");
  if (info.isDirectory()) return "folder";
  if (!info.isFile()) throw notRegular();
  return "file";
}

// A file's bytes, or null when no file is there; the location is checked before it is opened, and opened without blocking, so a pipe never holds a read or the store's lock.
async function readArtifactBytes(target) {
  if ((await locationKind(target)) !== "file") return null;
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
    if (info.size > READ_MAX) throw fail("artifact_too_large", `The artifact exceeds ${READ_MAX} bytes.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function isFolder(target) {
  try { const info = await lstat(target); return info.isDirectory(); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
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

async function listing(seen, folder, given) {
  const found = [];
  for (const scope of seen.scopes.filter((candidate) => !given || candidate.label === scopeOf(seen, given).label)) {
    for (const entry of seen.kinds.kinds) {
      if (!kindInScope(entry.kind, scope)) continue;
      if (!entry.folder) {
        if (!below(folder, entry.path) || malformedArtifactName({ path: entry.path, rest: null }) !== null) continue;
        const target = await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: null }));
        if ((await lstat(target).catch(() => null))?.isFile()) found.push({ path: entry.path, scope, kind: entry.kind, target });
        continue;
      }
      // Only a kind folder that the listed folder holds, or that holds it, can hold artifacts below it.
      let start;
      if (below(folder, entry.path)) start = "";
      else if (below(entry.path, folder)) start = entry.path === "" ? folder : folder.slice(entry.path.length + 1);
      else continue;
      const rests = [];
      await walk(await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: start })), start, rests);
      for (const rest of rests) {
        const file = artifactPathOf(seen.kinds, entry.kind, rest);
        // A stored file whose path another configured kind or an excluded folder claims is not this checkout's artifact.
        const address = artifactAddress(seen.kinds, file);
        if (address?.kind !== entry.kind || address.rest !== rest || !below(folder, file)) continue;
        found.push({ path: file, scope, kind: entry.kind, target: await resolveArtifactFile(seen, artifactLocation(scope, address)) });
      }
    }
  }
  sortEntries(found);
  const artifacts = [];
  for (const entry of found.slice(0, LIST_MAX)) {
    const bytes = await readArtifactBytes(entry.target);
    if (bytes !== null) artifacts.push({ path: entry.path, scope: entry.scope, kind: entry.kind, version: artifactVersion(bytes), bytes: bytes.length });
  }
  return { artifacts, truncated: found.length > LIST_MAX };
}

// The scopes among candidates whose store holds the artifact, with its file and bytes.
async function holders(seen, address, scopes, read = readArtifactBytes) {
  const held = [];
  for (const scope of scopes) {
    const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
    const bytes = await read(target);
    if (bytes !== null) held.push({ scope, target, bytes });
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
        if (await isFolder(await resolveArtifactFile(seen, artifactLocation(scope, address)))) return listing(seen, file, given);
      }
      throw notFound(file);
    }
    const [{ scope, bytes }] = held;
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

function checkVersion(file, expected, bytes) {
  const current = bytes === null ? null : artifactVersion(bytes);
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

// Every location an update writes must be able to hold a file, checked before any file changes: it is no folder, lies below no file the store holds, and lies below no other file the update writes.
async function checkLayout(seen, writes, state, names) {
  for (const [target] of writes) {
    const file = names.get(target);
    for (let folder = path.dirname(target); folder !== seen.base && folder.startsWith(`${seen.base}${path.sep}`); folder = path.dirname(folder)) {
      if (state.get(folder)) throw fail("invalid_path", `${file} lies below ${names.get(folder)}, which this update writes as a file, so the two cannot both exist; nothing changed.`);
    }
    const kind = await locationKind(target);
    if (kind === "folder") throw fail("invalid_path", `${file} is a folder of artifacts in the record store, so no file can be written in its place; nothing changed.`);
    if (kind === "under_file") throw fail("invalid_path", `${file} lies below a file that the record store holds, so it cannot be written; nothing changed.`);
  }
}

// Remove the folders that a removal left empty, up to the artifacts folder.
async function pruneParents(base, target) {
  for (let folder = path.dirname(target); folder !== base && folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
    try { await rmdir(folder); } catch { return; }
  }
}

/** Apply checked artifact operations to the store as one update: every operation is checked against the store before any file changes. */
export async function updateArtifact(input) {
  return refusing(async () => {
    assertInput(UPDATE_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    const checked = input.operations.map((operation) => checkOperation(config, kinds, operation));
    const seen = await seenScopes(input.projectRoot);
    return withArtifactStoreLock(seen, async () => {
      // Each file's bytes as the earlier operations of this update leave them, so later operations see their effect.
      const original = new Map();
      const state = new Map();
      // The artifact path each written location belongs to, for refusals that name it.
      const names = new Map();
      const read = async (target) => {
        if (!state.has(target)) {
          const bytes = await readArtifactBytes(target);
          original.set(target, bytes);
          state.set(target, bytes);
        }
        return state.get(target);
      };
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
          let scope, target, bytes;
          if (given) {
            scope = scopeOf(seen, given);
            target = await resolveArtifactFile(seen, artifactLocation(scope, address));
            bytes = await read(target);
            if (bytes === null && operation.expectedVersion === null) {
              const other = (await holders(seen, address, all.filter((candidate) => candidate.label !== scope.label), read))[0];
              if (other) throw fail("artifact_exists", `${file} already exists in scope ${other.scope.label}, which this checkout sees, so it cannot also be created in scope ${scope.label}. Read and change that artifact, or move it with move_scope.`, { scope: other.scope });
            }
          } else {
            const held = await one(item, all);
            scope = held?.scope ?? (operation.expectedVersion === null ? await creationScope(seen, address, all, state) : WORKSPACE_SCOPE);
            target = held?.target ?? await resolveArtifactFile(seen, artifactLocation(scope, address));
            bytes = held?.bytes ?? null;
          }
          checkVersion(file, operation.expectedVersion, bytes);
          const next = Buffer.from(operation.content, "utf8");
          state.set(target, next);
          names.set(target, file);
          artifacts.push({ path: file, scope, version: artifactVersion(next) });
          continue;
        }
        const source = operation.op === "move_scope" ? await one(item, scopesFor(seen, address.kind, null)) : await one(item, scopesFor(seen, address.kind, given));
        if (!source) {
          if (operation.expectedVersion !== null) checkVersion(file, operation.expectedVersion, null);
          throw notFound(file);
        }
        checkVersion(file, operation.expectedVersion, source.bytes);
        if (operation.op === "edit") {
          const next = Buffer.from(applyEdits(file, decode(source.bytes, file), operation.edits), "utf8");
          tooLarge(file, next.length);
          state.set(source.target, next);
          names.set(source.target, file);
          artifacts.push({ path: file, scope: source.scope, version: artifactVersion(next) });
        } else if (operation.op === "remove") {
          state.set(source.target, null);
          artifacts.push({ path: file, scope: source.scope, removed: true });
        } else {
          const scope = scopeOf(seen, given);
          if (scope.label !== source.scope.label) {
            const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
            if ((await read(target)) !== null) throw fail("artifact_exists", `${file} already exists in scope ${scope.label}, so it cannot move there from scope ${source.scope.label}.`, { scope });
            state.set(target, source.bytes);
            names.set(target, file);
            state.set(source.target, null);
          }
          artifacts.push({ path: file, scope, version: artifactVersion(source.bytes) });
        }
      }
      // New bytes are written before removals, so a move interrupted midway leaves the artifact in both scopes rather than in neither.
      const changed = [...state].filter(([target, bytes]) => !(bytes === null ? original.get(target) === null : original.get(target)?.equals(bytes)));
      await checkLayout(seen, changed.filter(([, bytes]) => bytes !== null), state, names);
      for (const [target, bytes] of changed.filter(([, bytes]) => bytes !== null)) {
        await mkdir(path.dirname(target), { recursive: true });
        await resolveArtifactFile(seen, path.relative(seen.base, target).split(path.sep).join("/"));
        await writeAtomically(target, bytes);
      }
      for (const [target] of changed.filter(([, bytes]) => bytes === null)) {
        await rm(target, { force: true });
        await pruneParents(seen.base, target);
      }
      return { artifacts };
    });
  });
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
      if (written || await isFolder(target)) holding.push(scope);
    }
    if (holding.length === 1) return holding[0];
    if (holding.length > 1) break;
  }
  return WORKSPACE_SCOPE;
}
