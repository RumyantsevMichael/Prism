// Generated from src/server/workflow/store-artifacts.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { addComment, aheadOfClock, appliedComment, appliedComments, commentFolderOf, listComments, movedComment, storedAuthor, storedTime } from "./artifact-comments.mjs";
import { artifactIndex, markArtifactIndexStale } from "./artifact-index.mjs";
import { writeAtomically } from "./artifact-store.mjs";
import { assertInput } from "./artifact-schema.mjs";
import { ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_NAME_FORM, ARTIFACTS, ARTIFACT_STATUS, artifactAddress, artifactLocation, artifactPathOf, componentScope, holdsArtifactPaths, IDENTITY_FILE_MAX, identityContent, identityOf, kindInScope, ARTIFACT_LOCATION_BYTES_MAX, letterCaseKey, locationArtifact, locationExcess, locationIdentity, locationLimits, malformedArtifactName, newIdentity, normalizeArtifactPath, repositoryScope, scopeFolder, STORE_NAME_BYTES_MAX, uniqueIdentities, windowsDeviceName, WORKSPACE_SCOPE, wellFormedName } from "./artifact-paths.mjs";
import { acceptAtShip, acceptedLocation, acceptedWhenMoved, answerApproval, askApproval, hasStatus, linkedPaths, movedWithoutAcceptance, newRecord, notAStatusArtifact, parseRecord, serializeRecord, statusFields, statusMismatch, statusRecordLocation, waitableGates, withAcceptedVersion, writtenStatus as writtenStatusOf } from "./artifact-status.mjs";
import { ComponentError, readComponents } from "./components.mjs";
import { checkArtifactFolders, folderChecks, noteToolCallWrite, recordStoreOf, repositoryScopes, resolveArtifactFile, resolveStatusFile, seenScopes, statusFileResolver, withArtifactStoreLock } from "./record-store.mjs";
import { pruneArtifactFolders, runGit, scheduleRecordSync } from "./record-store-sync.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { declaredView } from "./view-declarations.mjs";
const PAGE_LINES = 2e3;
const PAGE_BYTES = 64 * 1024;
const LIST_MAX = 2e3;
const CONTENT_MAX = 1024 * 1024;
const READ_MAX = 16 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;
const SCOPE_KINDS = /* @__PURE__ */ new Set(["workspace", "repository", "component"]);
class ArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new ArtifactError(code, message, details);
const artifactVersion = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const text = { type: "string", minLength: 1, maxLength: 4096 };
const anyText = { type: "string" };
const version = { oneOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] };
const scopeFields = { scope: { type: "string", maxLength: 64 }, component: { type: "string", maxLength: 200 } };
const workItemId = { type: "string", minLength: 1, maxLength: 200 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const GET_ARTIFACT_SCHEMA = object({
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
const UPDATE_ARTIFACT_SCHEMA = object({
  projectRoot: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "write" }, path: text, content: anyText, expectedVersion: version, ...scopeFields }, ["op", "path", "content", "expectedVersion"]),
    object({ op: { const: "edit" }, path: text, expectedVersion: version, edits: { type: "array", minItems: 1, maxItems: 200, items: object({ oldText: anyText, newText: anyText }) }, ...scopeFields }, ["op", "path", "expectedVersion", "edits"]),
    object({ op: { const: "remove" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion"]),
    object({ op: { const: "move_scope" }, path: text, expectedVersion: version, ...scopeFields }, ["op", "path", "expectedVersion", "scope"]),
    object({ op: { const: "ask_approval" }, path: text, status: { type: "string", minLength: 1, maxLength: 200 }, shipped: { type: "string", minLength: 1, maxLength: 200 }, question: text, context: { type: "string", maxLength: 8e3 }, initiative: workItemId, slice: workItemId, ...scopeFields }, ["op", "path", "context"])
  ] } }
}, ["projectRoot", "operations"]);
const SCOPE_TEXT = `scope is "workspace", "repository" for this checkout's repository, or "component" with component naming a component that ## Components in .prism/workflow.md declares`;
const ARTIFACT_TOOLS = Object.freeze([
  {
    name: "get_artifact",
    description: `In a project whose .prism/workflow.md names a record store, read a descriptive artifact the store holds: a requirement, an ADR, a plan file such as slice.md, the glossary, or the roadmap view. Address it by the project-relative path that the configured Requirements, ADRs, Plans, Glossary, and Roadmap paths give it; feature files, the user guide, tests, and code stay in the checkout and are refused with not_an_artifact. Every name below a configured folder, and the configured Glossary and Roadmap file names, must begin with an ASCII letter or digit, hold only ASCII letters, digits, ".", "_", and "-", not end in "." or ".lock", and be no Windows device name such as con, aux, nul, com1, or lpt1 before its first "."; any other is refused with artifact_name_invalid, data.invalidName holding the first such name, and listings leave such files out. A file read returns path, scope, kind, version (sha256 of its bytes, which update_artifact takes as expectedVersion), bytes, totalLines, offset, content, and nextOffset: content is whole lines from offset (1-based) up to limit lines (default 2000) and 64 KiB, at least one line, so read again from nextOffset until it is null. A requirement or ADR also returns status, its recorded status, which only a person's answer at a gate changes, and statusMismatch with written, recorded, and a message when its Status: line says otherwise; every file returns acceptedVersion and changedSinceAccepted against the bytes a person last accepted, acceptedFrom { migration, at } when a format migration run recorded that version as it migrated a decided artifact, approval once one is recorded, latestAnswer with the gate, status, choice (approve or request-changes), note, answeredAt, by, and entry (the id of the review app's history entry that applied it) of the person's latest answer at an approval gate, so requested changes reach an agent that no longer waits, and accepted true reads those accepted bytes. Every file read also returns comments, the people's comments on the file from the review browser, oldest first and including those a store sync brought from other machines, each with id, version (the version it was made on), line, text, author (name and host), at, and entry (the id of the review app's history entry that applied it), at most 20 in one read, with totalComments, the number of all of them, and nextCommentOffset, the 1-based position of the first one left out, or null; read the rest with commentOffset (1-based, default 1) set to nextCommentOffset until it is null. The comments move with the file to another scope and are removed with it. Every read also returns location, the artifact's place below artifacts/ in the store. A read of a plan file that its folder's slice.md declares in its ## Views section also returns view: { kind, question, clauses, contract, note }, where clauses are the contract clause numbers the view cites, contract is the path of the nearest slice.md with a Contract in its folder or a folder above it inside the Plans folder, and note says that where the view and the contract differ, the contract decides; any other file has no view. Without path, or with a folder, it lists the artifacts of every scope the store holds below it: the workspace scope, each repository's scope, and each component scope, also those of other repositories, each with path, location, scope, kind, version, bytes, and status for a requirement or ADR, sorted by path and then scope label, at most 2000 with truncated true when more exist, and indexedAt, the time of the index the listing answers from, which Prism refreshes after each store sync and artifact write and once it is a minute old. An entry's path is where this checkout's configured folder of its kind puts it, or null when this checkout configures no path for its kind, and entries without a path list last; read one of those by location. label names one scope by the label listings report, such as workspace, a repository's name, or <repository>/<component>, and with path reads that scope's artifact; an unknown label is refused with scope_unknown and data.scopes listing the labels the store holds, and label with scope or component is refused with scope_invalid. location, a listing entry's location, reads the artifact there in place of path, and with path, label, scope, or component is refused with scope_invalid. A path that more than one scope holds is refused with artifact_ambiguous, data.scopes listing every holding scope's label, until label picks one; scope and component still name only this checkout's own scopes: ${SCOPE_TEXT}. Refusals: artifact_not_found, artifact_not_text, scope_invalid, component_unknown, store_not_configured when the project has no store, and the store's own refusal, such as store_unavailable or a repository name refusal, when it cannot be used. Reads never change a checkout file. In the session of a format migration run, whose Prism server serves only that run, get_artifact reads only an artifact of the run's set or a file of the set's type under that type's configured path, by its extension and name rules, reads such a checkout file, also without a store, as { path, scope: null, content, version }, and refuses every other path, every dot-file, and everything in a dot-folder, such as .env, .prism, or .git/config, with migration_scope.`,
    inputSchema: GET_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_artifact",
    description: `In a project whose .prism/workflow.md names a record store, change descriptive artifacts in the store, addressed by project-relative path as get_artifact reads them, never by editing files in the checkout. operations holds at most 50 of write (path, content, expectedVersion), edit (path, expectedVersion, edits of oldText and newText, each replacing text that occurs exactly once in the text earlier edits left, else edit_not_applied with data.edit its index), remove (path, expectedVersion), move_scope (path, expectedVersion, and the scope to move it to), and ask_approval (path, optional status, default Approved, optional question, context, the situation for a person who has not followed the work, and optional initiative and slice, the ids of the work item the approval serves, which its Attention card links once the roadmap lists the initiative or its record holds the slice, so requirements that start an initiative name the id its roadmap entry will take; a slice needs an initiative or shipped, an initiative that differs from shipped is refused with validation_failed, and an acceptance after a ship serves the shipped initiative), which records a pending approval gate on a requirement or ADR at its current version and returns its id as gate, for the person to answer on Attention in the review browser and for wait_for_user_gate with artifact; with shipped, the id of an initiative the roadmap records as shipped, it asks to accept a Proposed ADR that the initiative's ship left Proposed, status Accepted by default and no other, and the person's approval records the acceptance with that initiative and the slice, repository, and verified commit of each slice its ship recorded, under acceptance with afterShip true, while the shipped decision stays as it is; it is refused with validation_failed when the initiative has not shipped, when the file is no Proposed ADR, or when no slice.md of the initiative links the ADR and the ADR links none of the initiative's requirement files; it is refused with not_a_status_artifact for any other file, status_by_ship for Accepted on an ADR without shipped, which a ship accepts, and nothing_to_approve when the status is already recorded and the bytes are the accepted ones. Leave Status: and Approved: lines to gates: a write whose Status: line differs from the recorded status is kept and its entry carries statusMismatch. expectedVersion is the version last read, or null to create; any other mismatch is refused with version_conflict and data.version holding the current version or null. write, edit, and remove take an optional scope to pick one when two scopes hold the path; ${SCOPE_TEXT}. A new artifact takes the given scope, else the scope that holds its nearest folder, else the workspace scope, and creating a path that another seen scope holds is refused with artifact_exists. A write that creates an artifact, and a move_scope, whose path differs only in letter case from an artifact path a seen scope holds, or from another write of the update, is refused with artifact_name_conflict and data.path holding that path, so change only the letter case by a remove and then a write in a later update. Such a write or move_scope whose location in the store, the path below artifacts/ in the scope it would take, holds more than ${ARTIFACT_LOCATION_BYTES_MAX} bytes, or a name of more than ${STORE_NAME_BYTES_MAX}, is refused with artifact_path_too_long and data.location, so choose a shorter path or a scope with a shorter folder. Such a write or move_scope in a component scope whose component name is a Windows device name, such as aux, nul, or com1, is refused with component_name_invalid and data.component, so rename the component under ## Components in .prism/workflow.md or choose another scope. move_scope of a path that several scopes hold moves the one copy whose version is expectedVersion. Content is UTF-8 text of at most 1 MiB, else artifact_too_large. Prism checks every operation before it changes any file, so a refused update changes nothing. A write or edit of a requirement file, ADR, or glossary is checked against its current format as check_artifacts checks it, with the recorded statuses and glossary sources as the whole update leaves them, and content that breaks the format is refused with artifact_nonconforming and data.artifacts [{ path, scope, type, findings }], whose message names each artifact in its scope and its rule ids; a required value written as unknown passes only while the recorded status is Draft for a requirement, which a new requirement always is, or Proposed for an ADR, so an approval answer that would make a file with an unknown value Approved is refused the same way and its gate stays pending. remove, move_scope, plan files, and the roadmap view are not checked, and a break the check does not see is reported with report_format_finding. The result lists, for each operation, the artifact's path, scope, and new version, or removed true. An artifact's comments from the review browser belong to it: move_scope moves them with it, remove removes them, and a write that creates an artifact removes the comments that a removed or moved artifact left at its path, and such an entry carries removedComments, the number of comments removed, when there were any, so read a file's comments with get_artifact before you remove it. A name that breaks the artifact name form that get_artifact describes is refused with artifact_name_invalid and data.invalidName, so choose another name. An agent changes only the artifacts of its own checkout's scopes, the workspace, its repository, and its components: a new artifact never takes another repository's scope, and a write with a version, edit, remove, move_scope, or ask_approval of a path that only other repositories' scopes hold is refused with scope_not_writable, data.scope naming the first such scope's label, so change it from a checkout of that repository. Paths outside the artifact paths are refused with not_an_artifact and stay in the checkout; without a store it refuses with store_not_configured.`,
    inputSchema: UPDATE_ARTIFACT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
]);
async function refusing(action) {
  try {
    return await action();
  } catch (error) {
    if (error?.name === "RecordStoreError" || error instanceof ComponentError) throw fail(error.code, error.message, Object.fromEntries(["proposed", "store", "key", "folder", "component"].filter((key) => error[key] !== void 0).map((key) => [key, error[key]])));
    throw error;
  }
}
const nameInvalid = (given, name) => fail("artifact_name_invalid", `${JSON.stringify(given)} has the name ${JSON.stringify(name)}, which the record store does not accept: ${ARTIFACT_NAME_FORM}. Choose a name of that form for the artifact.`, { invalidName: name });
function checkName(given, address) {
  const name = malformedArtifactName(address);
  if (name !== null) throw nameInvalid(given, name);
}
const notAnArtifact = (given) => fail("not_an_artifact", `${JSON.stringify(given)} is not a descriptive artifact path: only files under the Requirements, ADRs, and Plans folders and the Glossary and Roadmap files configured in .prism/workflow.md live in the record store, while feature files, the user guide, tests, code, and every other file stay in the checkout. Read and edit this file in the checkout with your own file tools.`);
async function configuration(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) throw fail("store_not_configured", "This project's .prism/workflow.md names no record store under ## Workspace, so its descriptive artifacts stay in the checkout: read and edit them there with your own file tools.");
  checkArtifactFolders(config);
  return { config, kinds: artifactKinds(config) };
}
function scopeInput(config, input, required = false) {
  if (input.scope === void 0) {
    if (input.component !== void 0) throw fail("scope_invalid", 'component names a component scope, so it needs scope "component".');
    if (required) throw fail("scope_invalid", `The operation needs a scope: ${SCOPE_TEXT}.`);
    return null;
  }
  if (!SCOPE_KINDS.has(input.scope)) throw fail("scope_invalid", `${JSON.stringify(input.scope)} is no scope: ${SCOPE_TEXT}.`);
  if (input.scope !== "component") {
    if (input.component !== void 0) throw fail("scope_invalid", `component applies only with scope "component", not with scope ${JSON.stringify(input.scope)}.`);
    return { kind: input.scope };
  }
  const declared = readComponents(config).declared.map((component) => component.name);
  if (typeof input.component !== "string" || !declared.includes(input.component)) {
    throw fail("component_unknown", `${input.component === void 0 ? 'Scope "component" names no component' : `${JSON.stringify(input.component)} is no component`} of this repository: ## Components in .prism/workflow.md declares ${declared.length ? declared.join(", ") : "none"}.`, { components: declared });
  }
  return { kind: "component", component: input.component };
}
const scopeOf = (seen, input) => input.kind === "workspace" ? WORKSPACE_SCOPE : input.kind === "repository" ? repositoryScope(seen.repository) : componentScope(seen.repository, input.component);
function checkKindScope(kind, input) {
  if (input && !kindInScope(kind, { kind: input.kind })) throw fail("scope_invalid", "The roadmap view lives only in the workspace scope.");
}
const notRegular = () => fail("invalid_path", "An artifact in the record store must be a regular file, and this location holds a special file such as a pipe or device, which Prism does not open.");
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
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
      throw error;
    }
    if (!names.includes?.(name) && !names.has?.(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}
async function locationKind(target, base = null, memo = null) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    if (error.code === "ENOTDIR") return "under_file";
    throw error;
  }
  if (base !== null && !await exactLocation(base, target, memo)) return "missing";
  if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact in the record store is a symbolic link, which Prism does not follow.");
  if (info.isDirectory()) return "folder";
  if (!info.isFile()) throw notRegular();
  return "file";
}
async function fileAbove(base, target, memo) {
  if (process.platform !== "win32") return false;
  for (let folder = path.dirname(target); folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
    if (!memo.has(folder)) memo.set(folder, lstat(folder).then((info) => info.isFile() ? "file" : "other", (error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
      throw error;
    }));
    const kind = await memo.get(folder);
    if (kind !== "missing") return kind === "file";
  }
  return false;
}
async function readStored(target, base = null, memo = null, max = READ_MAX) {
  if (await locationKind(target, base, memo) !== "file") return null;
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    if (error.code === "ELOOP") throw fail("invalid_path", "An artifact in the record store is a symbolic link, which Prism does not follow.");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return null;
    if (!info.isFile()) throw notRegular();
    if (info.size <= Math.min(max, READ_MAX)) return stored(await handle.readFile());
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK);
    let size = 0;
    for (let read; (read = (await handle.read(chunk, 0, HASH_CHUNK, null)).bytesRead) > 0; ) {
      hash.update(chunk.subarray(0, read));
      size += read;
    }
    return { bytes: null, size, version: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}
const stored = (bytes) => ({ bytes, size: bytes.length, version: artifactVersion(bytes) });
function contentOf(file, record) {
  if (record.bytes === null) throw fail("artifact_too_large", `${file} in the record store is ${record.size} bytes, above the ${READ_MAX} bytes that Prism reads, so it cannot be read, edited, or moved; it can be removed with its version from a listing, or replaced by a write.`);
  return record.bytes;
}
async function isFolder(target, base) {
  try {
    if (!(await lstat(target)).isDirectory()) return false;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
  return exactLocation(base, target);
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decode(bytes, file) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw fail("artifact_not_text", `${file} in the record store is not UTF-8 text, so the artifact tools cannot read or edit it.`);
  }
}
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
async function walk(directory, prefix, found) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!wellFormedName(entry.name)) continue;
    const rest = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), rest, found);
    else if (entry.isFile()) found.push(rest);
  }
}
async function holdings(seen, folder, given) {
  const found = [];
  for (const scope of seen.scopes.filter((candidate) => !given || candidate.label === scopeOf(seen, given).label)) {
    for (const entry of seen.kinds.kinds) {
      if (!kindInScope(entry.kind, scope)) continue;
      if (!entry.folder) {
        if (!below(folder, entry.path) || malformedArtifactName({ path: entry.path, rest: null }) !== null) continue;
        const target = await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: null }));
        if (await locationKind(target, seen.base).catch(() => null) === "file") found.push({ path: entry.path, scope, kind: entry.kind, target });
        continue;
      }
      let start;
      if (below(folder, entry.path)) start = "";
      else if (below(entry.path, folder)) start = entry.path === "" ? folder : folder.slice(entry.path.length + 1);
      else continue;
      const rests = [];
      const folderTarget = await resolveArtifactFile(seen, artifactLocation(scope, { kind: entry.kind, rest: start }));
      if (await exactLocation(seen.base, folderTarget)) await walk(folderTarget, start, rests);
      for (const rest of rests) {
        const file = artifactPathOf(seen.kinds, entry.kind, rest);
        const address = artifactAddress(seen.kinds, file);
        if (address?.kind !== entry.kind || address.rest !== rest || !below(folder, file)) continue;
        found.push({ path: file, scope, kind: entry.kind, target: await resolveArtifactFile(seen, artifactLocation(scope, address)) });
      }
    }
  }
  return sortEntries(found);
}
function checkoutPath(kinds, { kind, rest }) {
  const file = artifactPathOf(kinds, kind, rest);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  return address?.kind === kind && address.rest === rest ? file : null;
}
const byListing = (left, right) => {
  if (left.path !== right.path) {
    if (left.path === null) return 1;
    if (right.path === null) return -1;
    return left.path < right.path ? -1 : 1;
  }
  if (left.location !== right.location && left.path === null) return left.location < right.location ? -1 : 1;
  return left.scope.label < right.scope.label ? -1 : left.scope.label > right.scope.label ? 1 : 0;
};
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
    path: file,
    location,
    scope,
    kind: entry.kind,
    version: entry.version,
    bytes: entry.bytes,
    ...hasStatus(entry.kind) ? { status: entry.status } : {}
  }));
  return { artifacts, truncated: found.length > LIST_MAX, indexedAt: index.indexedAt };
}
function baseFor(seen, target) {
  for (const folder of [ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY]) {
    const base = path.join(seen.store.base, folder);
    if (target.startsWith(`${base}${path.sep}`)) return base;
  }
  return seen.base;
}
const writeChecks = () => ({ folders: /* @__PURE__ */ new Set(), missing: { has: () => false, add: () => {
} }, reals: /* @__PURE__ */ new Map() });
const resolveAgain = (seen, target, writes = null) => {
  const fresh = { ...seen, folderChecks: writes };
  return baseFor(seen, target) === seen.base ? resolveArtifactFile(fresh, path.relative(seen.base, target).split(path.sep).join("/"), { fresh: writes === null }) : resolveStatusFile(fresh, path.relative(seen.store.base, target).split(path.sep).join("/"), { fresh: writes === null });
};
const manyReads = (seen) => Object.assign(statusFileResolver(seen), { names: /* @__PURE__ */ new Map() });
async function statusRecordOf(seen, scope, address, resolve = (relative) => resolveStatusFile(seen, relative)) {
  const held = await resolve(statusRecordLocation(scope, address)).then((target) => readStored(target, baseFor(seen, target), resolve.names ?? null)).catch(() => null);
  return parseRecord(address.kind, held?.bytes ?? null);
}
async function withMovedAcceptance(seen, scope, address, name, status, current) {
  if (!movedWithoutAcceptance(address.kind, status)) return status;
  try {
    const bytes = await movedBytes(seen, scope, address, current);
    if (bytes === null || writtenStatusOf(artifactText(bytes) ?? "") !== status.status) return status;
    const item = { operation: { op: "accept_moved", path: name, bytes, atScope: scope, event: { event: "moved", at: (/* @__PURE__ */ new Date()).toISOString() } }, file: name, address, given: null };
    await withArtifactStoreLock(seen, () => applyOperations(seen, [item]), { timeoutMs: MOVED_ACCEPTANCE_LOCK_MS });
    return await statusRecordOf(seen, scope, address);
  } catch {
    return status;
  }
}
const MOVED_ACCEPTANCE_LOCK_MS = 2e3;
async function movedBytes(seen, scope, address, current) {
  if (!seen.store.sync) return current;
  const file = `${ARTIFACTS}/${artifactLocation(scope, address)}`;
  const added = await runGit(seen.store.base, ["--literal-pathspecs", "log", "-1", "--no-renames", "--diff-filter=A", "--format=%H", "--", file]);
  if (!added.ok || !/^[0-9a-f]{40,64}$/.test(added.text)) return null;
  const blob = await runGit(seen.store.base, ["cat-file", "blob", `${added.text}:./${file}`]);
  return blob.ok ? blob.stdout : null;
}
async function acceptedBytes(seen, file, version2) {
  if (version2 === null) throw fail("artifact_not_accepted", `No person has accepted a version of ${file} yet: it is accepted at an approval, at the design acceptance of the slice whose folder holds it, or when its initiative ships.`);
  const held = await resolveStatusFile(seen, acceptedLocation(version2)).then((target) => readStored(target, baseFor(seen, target))).catch(() => null);
  if (held?.version !== version2) throw fail("artifact_not_accepted", `The accepted version ${version2} of ${file} is not in the record store, so its bytes cannot be read; read the current version without accepted.`);
  return contentOf(file, held);
}
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
async function getArtifact(input) {
  return refusing(async () => {
    assertInput(GET_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    if (input.location !== void 0) {
      if (["path", "label", "scope", "component"].some((key) => input[key] !== void 0)) throw fail("scope_invalid", "location names an artifact by its place in the record store on its own, so it takes no path, label, scope, or component.");
      return readByLocation(await seenScopes(input.projectRoot), input);
    }
    if (input.label !== void 0 && (input.scope !== void 0 || input.component !== void 0)) throw fail("scope_invalid", "label names a scope on its own, so it takes no scope or component.");
    const file = normalizeArtifactPath(input.path ?? "");
    if (file === null) throw notAnArtifact(input.path);
    const address = file === "" ? null : artifactAddress(kinds, file);
    if (!address && !holdsArtifactPaths(kinds, file)) throw notAnArtifact(input.path);
    if (address) checkName(input.path, address);
    const given = scopeInput(config, input);
    if (address) checkKindScope(address.kind, given);
    const seen = await seenScopes(input.projectRoot);
    let scopes = seen.all;
    if (input.label !== void 0) {
      const labeled = seen.all.find((scope2) => scope2.label === input.label);
      if (!labeled) throw fail("scope_unknown", `${JSON.stringify(input.label)} is no scope label of the record store, which holds ${scopeLabels(seen).join(", ")}.`, { scopes: scopeLabels(seen) });
      if (address) checkKindScope(address.kind, labeled);
      scopes = [labeled];
    } else if (given) scopes = [scopeOf(seen, given)];
    if (!address || address.rest === "") return listing(seen, file, scopes);
    const candidates = scopes.filter((scope2) => kindInScope(address.kind, scope2));
    const held = await holders(seen, address, candidates);
    if (held.length > 1) throw readAmbiguous(file, held);
    if (held.length === 0) {
      for (const scope2 of candidates) {
        if (await isFolder(await resolveArtifactFile(seen, artifactLocation(scope2, address)), seen.base)) return listing(seen, file, scopes);
      }
      throw notFound(file);
    }
    const [{ scope, record }] = held;
    return readResult(seen, input, { file, name: file, scope, address, record });
  });
}
async function readByLocation(seen, input) {
  const location = input.location;
  const found = locationArtifact(location);
  if (!found) throw fail("not_an_artifact", `${JSON.stringify(location)} is no artifact location in the record store: a location is the path below artifacts/ of a listing entry, such as requirements/a.md or repositories/<repository>/plans/<folder>/slice.md.`);
  const invalid = location.split("/").find((name) => !wellFormedName(name));
  if (invalid !== void 0) throw nameInvalid(location, invalid);
  const scope = seen.all.find((candidate) => candidate.label === found.scope.label);
  if (!scope) throw fail("artifact_not_found", `No scope of the record store holds the artifact at ${location}.`);
  const record = await readStored(await resolveArtifactFile(seen, location), seen.base);
  if (record === null) throw fail("artifact_not_found", `No scope of the record store holds the artifact at ${location}.`);
  const address = { kind: found.kind, rest: found.rest };
  const file = checkoutPath(seen.kinds, address);
  return readResult(seen, input, { file, name: file ?? location, scope, address: { ...address, path: file ?? location }, record });
}
async function readResult(seen, input, { file, name, scope, address, record }) {
  const current = contentOf(name, record);
  const status = await withMovedAcceptance(seen, scope, address, name, await statusRecordOf(seen, scope, address), current);
  const bytes = input.accepted ? await acceptedBytes(seen, name, status.acceptedVersion) : current;
  const content = decode(bytes, name);
  const offset = input.offset ?? 1;
  const read = page(content, offset, input.limit ?? PAGE_LINES);
  const mismatch = input.accepted ? null : statusMismatch(address.kind, name, content, status);
  const view = address.kind === "plans" && file ? await declaredView(input.projectRoot, file, { plans: (await readWorkflowConfig(input.projectRoot)).paths?.plans ?? null }).catch(() => null) : null;
  return {
    path: file,
    location: artifactLocation(scope, address),
    scope,
    kind: address.kind,
    version: artifactVersion(bytes),
    bytes: bytes.length,
    totalLines: read.totalLines,
    offset,
    content: read.content,
    nextOffset: read.nextOffset,
    ...statusFields(address.kind, status, record.version),
    ...mismatch ? { statusMismatch: mismatch } : {},
    ...input.accepted ? { accepted: true } : {},
    ...view ? { view } : {},
    ...await listComments(seen, scope, address, input.commentOffset ?? 1)
  };
}
const STATUS_OPERATIONS = /* @__PURE__ */ new Set(["ask_approval", "answer_approval"]);
function checkOperation(config, kinds, operation) {
  const file = normalizeArtifactPath(operation.path);
  const address = file === null || file === "" ? null : artifactAddress(kinds, file);
  if (!address) throw notAnArtifact(operation.path);
  checkName(operation.path, address);
  if (address.rest === "") throw fail("invalid_path", `${file} is the configured folder itself; name a file inside it.`);
  if (STATUS_OPERATIONS.has(operation.op) && !hasStatus(address.kind)) throw notAStatusArtifact(file);
  if (operation.op === "ask_approval") checkWorkItem(file, operation);
  const given = scopeInput(config, operation, operation.op === "move_scope");
  checkKindScope(address.kind, given);
  if (operation.op === "write") tooLarge(file, Buffer.byteLength(operation.content));
  return { operation, file, address, given };
}
function checkWorkItem(file, operation) {
  for (const field of ["initiative", "slice"]) {
    if (operation[field] !== void 0 && !SLUG_PATTERN.test(operation[field])) throw fail("validation_failed", `The ${field} of the approval of ${file} is an id of letters, digits, hyphens, and underscores, not ${JSON.stringify(operation[field])}; nothing changed.`);
  }
  if (operation.initiative !== void 0 && operation.shipped !== void 0 && operation.initiative !== operation.shipped) {
    throw fail("validation_failed", `The approval of ${file} names the initiative ${operation.initiative} and the shipped initiative ${operation.shipped}; an acceptance after a ship serves the shipped initiative, so leave out initiative or name the same one; nothing changed.`);
  }
  if (operation.slice !== void 0 && operation.initiative === void 0 && operation.shipped === void 0) {
    throw fail("validation_failed", `The approval of ${file} names the slice ${operation.slice} but no initiative; name the initiative that holds it; nothing changed.`);
  }
}
function tooLarge(file, size) {
  if (size > CONTENT_MAX) throw fail("artifact_too_large", `The content of ${file} is ${size} bytes, above the 1 MiB that an artifact may hold.`);
}
function checkVersion(file, expected, record) {
  const current = record?.version ?? null;
  if (expected === current) return;
  throw fail("version_conflict", current === null ? `${file} does not exist in that scope of the record store, so it can only be created, with expectedVersion null.` : `${file} changed since it was read${expected === null ? ", or already exists" : ""}: its current version is ${current}. Read it again and redo the change.`, { version: current });
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
const folded = (name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
async function letterCaseVariant(base, target, entries) {
  let folder = base;
  for (const name of path.relative(base, target).split(path.sep)) {
    if (!entries.has(folder)) entries.set(folder, await readdir(folder).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
      throw error;
    }));
    const names = entries.get(folder);
    if (!names.includes(name)) {
      const variant = names.find((other) => folded(other) === folded(name));
      return variant === void 0 ? null : path.relative(base, path.join(folder, variant)).split(path.sep).join("/");
    }
    folder = path.join(folder, name);
  }
  return null;
}
async function checkLayout(seen, writes, state, names) {
  const entries = /* @__PURE__ */ new Map(), above = /* @__PURE__ */ new Map();
  for (const [target] of writes) {
    const file = names.get(target);
    const base = baseFor(seen, target);
    for (let folder = path.dirname(target); folder !== base && folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
      if (state.get(folder)) throw fail("invalid_path", `${file} lies below ${names.get(folder)}, which this update writes as a file, so the two cannot both exist; nothing changed.`);
    }
    const variant = await letterCaseVariant(base, target, entries);
    if (variant !== null) {
      const location = path.relative(base, target).split(path.sep).join("/");
      throw fail("invalid_path", `${file} would be written at ${location} in the record store, where ${variant} already exists with a name that differs only in letter case, so a file system that ignores letter case, as macOS and Windows do by default, would write it into ${variant} under another path; nothing changed. Choose another name; a person can remove ${variant} from the store's artifacts folder if nothing in it is needed.`, { location: variant });
    }
    const kind = await locationKind(target, base);
    if (kind === "folder") throw fail("invalid_path", `${file} is a folder of artifacts in the record store, so no file can be written in its place; nothing changed.`);
    if (kind === "under_file" || kind === "missing" && await fileAbove(base, target, above)) throw fail("invalid_path", `${file} lies below a file that the record store holds, so it cannot be written; nothing changed.`);
  }
}
function moveSource({ file, operation }, held) {
  if (held.length <= 1) return held[0] ?? null;
  const matching = held.filter((entry) => entry.record.version === operation.expectedVersion);
  if (matching.length === 1) return matching[0];
  const labels = held.map((entry) => entry.scope.label);
  throw fail("artifact_ambiguous", `${file} is held by more than one scope this checkout sees (${labels.join(", ")}), and ${matching.length ? "more than one copy has" : "no copy has"} the version given as expectedVersion, so move_scope cannot tell which copy to move; nothing changed. Read each copy with get_artifact and its scope, remove the copy you do not keep with remove and that scope, and then move the other.`, { scopes: labels });
}
function checkLocationLength(scope, address) {
  const location = artifactLocation(scope, address);
  const excess = locationExcess(location);
  if (excess === null) return;
  throw fail("artifact_path_too_long", `${location}, the location of ${address.path} in scope ${scope.label} of the record store, ${excess}, so some machine could not write it or its comments; nothing changed. Choose a shorter path, or a scope with a shorter folder.`, locationLimits(location));
}
function checkComponentName(file, scope) {
  if (scope.kind !== "component" || !windowsDeviceName(scope.component)) return;
  throw fail("component_name_invalid", `${file} would live in scope ${scope.label}, whose component name ${scope.component} is a Windows device name (con, prn, aux, nul, com0 to com9, or lpt0 to lpt9), so its folder in the record store would stop the store on every Windows machine; nothing changed. Rename the component under ## Components in .prism/workflow.md to a name that is no device name, or choose another scope.`, { component: scope.component });
}
function checkLetterCase(item, held, checked) {
  const { file, address } = item;
  const other = collidingPath(letterCaseIndex(held, (entry) => entry), address.kind, file) ?? collidingPath(letterCaseIndex(checked, (candidate) => candidate.operation.op === "write" ? { kind: candidate.address.kind, path: candidate.file } : null), address.kind, file);
  if (other === void 0) return;
  throw fail("artifact_name_conflict", `${file} differs only in letter case from ${other}, which ${held.some((entry) => entry.path === other) ? "the record store holds" : "this update also writes"}, and the two would be one file on a file system that ignores letter case, as macOS and Windows do by default; nothing changed. Choose another name, or change the letter case of an artifact by removing it in one update and writing it in the next.`, { path: other });
}
const letterCaseIndexes = /* @__PURE__ */ new WeakMap();
function letterCaseIndex(list, pathOf) {
  if (letterCaseIndexes.has(list)) return letterCaseIndexes.get(list);
  const index = /* @__PURE__ */ new Map();
  for (const entry of list) {
    const named = pathOf(entry);
    if (!named) continue;
    const names = named.path.split("/");
    for (let depth = 1; depth <= names.length; depth += 1) {
      const key = `${named.kind}\0${names.slice(0, depth).map(letterCaseKey).join("/")}`;
      const exact = names.slice(0, depth).join("/");
      if (!index.has(key)) index.set(key, /* @__PURE__ */ new Map());
      if (!index.get(key).has(exact)) index.get(key).set(exact, named.path);
    }
  }
  letterCaseIndexes.set(list, index);
  return index;
}
function collidingPath(index, kind, file) {
  const names = file.split("/");
  for (let depth = 1; depth <= names.length; depth += 1) {
    const exact = names.slice(0, depth).join("/");
    for (const [prefix, other] of index.get(`${kind}\0${names.slice(0, depth).map(letterCaseKey).join("/")}`) ?? []) if (prefix !== exact) return other;
  }
  return void 0;
}
const pathIndex = (entries) => letterCaseIndex(entries, (entry) => entry);
async function updateArtifact(input) {
  return refusing(async () => {
    assertInput(UPDATE_ARTIFACT_SCHEMA, input);
    const { config, kinds } = await configuration(input.projectRoot);
    const checked = input.operations.map((operation) => checkOperation(config, kinds, operation));
    const seen = await seenScopes(input.projectRoot);
    for (const item of checked) if (item.operation.op === "ask_approval" && item.operation.shipped !== void 0) item.shipped = await shippedRealization(input.projectRoot, seen, kinds, item.operation.shipped);
    return withArtifactStoreLock(seen, async () => ({ artifacts: (await applyOperations(seen, checked, { noteWrites: true })).artifacts }));
  });
}
async function shippedRealization(projectRoot, seen, kinds, initiative) {
  const { readRoadmap } = await import("./roadmap.mjs");
  const { loaded } = await readRoadmap(projectRoot);
  const entry = (loaded.valid && Array.isArray(loaded.record?.initiatives) ? loaded.record.initiatives : []).find((item) => item.id === initiative);
  if (entry?.decision?.kind !== "shipped") throw fail("validation_failed", `The roadmap has no shipped initiative ${initiative}; an ADR that an initiative still to ship relies on is accepted by that ship, once a slice.md links it.`);
  const slices = isRecordValue(entry.decision.slices) ? entry.decision.slices : {};
  const verifiedBy = Object.keys(slices).sort().map((slice) => ({ slice, repository: typeof slices[slice]?.repository === "string" ? slices[slice].repository : null, commit: typeof slices[slice]?.verified === "string" ? slices[slice].verified : null }));
  const requirements = new Set((Array.isArray(entry.requirements) ? entry.requirements : []).filter((item) => typeof item === "string").map((item) => item.replace(/#.*$/, "")));
  const linked = /* @__PURE__ */ new Set();
  const { initiativePlan } = await import("./ship-standing.mjs");
  const { plan } = await initiativePlan(projectRoot, initiative).catch(() => ({ plan: null }));
  if (plan) {
    for (const { entry: slice, held } of await readPlanSlices(await planSeen(seen, plan), plan)) {
      const text2 = held.bytes ? artifactText(held.bytes) : null;
      for (const file of (text2 === null ? null : linkedPaths(text2, slice.path)) ?? []) linked.add(file);
    }
  }
  return { initiative, verifiedBy, requirements, linked };
}
function realizes(shipped, file, bytes) {
  if (shipped.linked.has(file)) return true;
  const text2 = bytes ? artifactText(bytes) : null;
  return ((text2 === null ? null : linkedPaths(text2, file)) ?? []).some((target) => shipped.requirements.has(target));
}
const isRecordValue = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
async function applyOperations(seenStore, checked, { held = null, noteWrites = false, formatCheck = { unknownAside: false, appliedMigration: null } } = {}) {
  const seen = { ...seenStore, folderChecks: folderChecks() };
  const listed = /* @__PURE__ */ new Map();
  const original = /* @__PURE__ */ new Map();
  const state = /* @__PURE__ */ new Map();
  const names = /* @__PURE__ */ new Map();
  const read = async (target) => {
    if (!state.has(target)) {
      const record = await readStored(target, baseFor(seen, target), listed);
      original.set(target, record);
      state.set(target, record);
    }
    return state.get(target);
  };
  let before;
  const heldBefore = async () => before ??= held ?? await holdings(seen, "", null);
  const one = async ({ file, address }, scopes) => {
    const held2 = await holders(seen, address, scopes, read);
    if (held2.length > 1) throw ambiguous(file, held2);
    return held2[0] ?? null;
  };
  const statusOf = async (scope, address) => {
    const target = await resolveStatusFile(seen, statusRecordLocation(scope, address));
    const held2 = await read(target);
    return { target, exists: held2 !== null, record: parseRecord(address.kind, held2 === null ? null : contentOf(target, held2)) };
  };
  const setStatus = (target, file, record) => {
    state.set(target, record === null ? null : stored(Buffer.from(serializeRecord(record), "utf8")));
    names.set(target, file);
  };
  const keepAccepted = async (file, bytes) => {
    const target = await resolveStatusFile(seen, acceptedLocation(artifactVersion(bytes)));
    if (await read(target) === null) {
      state.set(target, stored(bytes));
      names.set(target, file);
    }
  };
  const createdRecord = async (kind, written, file, bytes) => {
    const record = newRecord(kind, written);
    if (!acceptedWhenMoved(kind, written)) return record;
    await keepAccepted(file, bytes);
    return withAcceptedVersion(record, artifactVersion(bytes), { event: "moved", at: (/* @__PURE__ */ new Date()).toISOString() });
  };
  const folders = /* @__PURE__ */ new Map();
  const commentsAt = async (scope, address) => {
    const folder = await commentFolderOf(seen, scope, address);
    const key = folder.target ?? `\0${folder.location}`;
    if (!folders.has(key)) {
      folders.set(key, folder.entries);
      for (const entry of folder.entries) if (!original.has(entry.target)) {
        original.set(entry.target, { version: "held" });
        state.set(entry.target, original.get(entry.target));
      }
    }
    return { key, entries: folders.get(key) };
  };
  const takeComments = async (scope, address, file) => {
    const { key, entries } = await commentsAt(scope, address);
    folders.set(key, []);
    for (const entry of entries) {
      state.set(entry.target, null);
      names.set(entry.target, file);
    }
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
  const strays = /* @__PURE__ */ new Map();
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
  const identityHeld = async (scope, address) => {
    const location = artifactLocation(scope, address);
    return (await storeIdentities(seen)).get(location) ?? locationIdentity(location);
  };
  const counted = (entry, removed) => removed.length ? Object.assign(entry, { removedComments: removed.length }) : entry;
  const own = new Set(seen.scopes.map((scope) => scope.label));
  const refuseOthers = async ({ file, address }) => {
    const others = (seen.all ?? []).filter((scope) => !own.has(scope.label) && kindInScope(address.kind, scope));
    const [held2] = await holders(seen, address, others, read);
    if (held2) throw notWritable(file, held2.scope);
  };
  const mismatches = [];
  const formatted = [];
  const noteFormatted = (file, scope, address) => {
    if (FORMAT_KINDS.has(address.kind)) formatted.push({ file, scope, address });
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
        const held2 = await one(item, all);
        scope = held2?.scope ?? (operation.expectedVersion === null ? await creationScope(seen, address, all, state) : WORKSPACE_SCOPE);
        target = held2?.target ?? await resolveArtifactFile(seen, artifactLocation(scope, address));
        current = held2?.record ?? null;
      }
      if (current === null && operation.expectedVersion !== null && !(await holders(seen, address, all, read)).length) await refuseOthers(item);
      if (operation.expectedVersion === null) checkLetterCase(item, await heldBefore(), checked);
      checkVersion(file, operation.expectedVersion, current);
      if (current === null) {
        checkComponentName(file, scope);
        checkLocationLength(scope, address);
        const status = await statusOf(scope, address);
        if (hasStatus(address.kind)) setStatus(status.target, file, await createdRecord(address.kind, operation.writtenStatus ?? null, file, operation.bytes ?? Buffer.from(operation.content, "utf8")));
        else if (status.exists) setStatus(status.target, file, null);
        await setIdentity(scope, address, file, newIdentity());
      }
      const removed = current === null ? await takeComments(scope, address, file) : [];
      const next = operation.bytes ?? Buffer.from(operation.content, "utf8");
      state.set(target, stored(next));
      names.set(target, file);
      artifacts.push(counted({ path: file, scope, version: artifactVersion(next) }, removed));
      if (hasStatus(address.kind)) mismatches.push({ entry: artifacts.at(-1), file, scope, address, text: operation.content });
      if (operation.acceptedFrom && hasStatus(address.kind)) {
        const status = await statusOf(scope, address);
        if (["Approved", "Accepted"].includes(status.record.status)) {
          await keepAccepted(file, next);
          setStatus(status.target, file, withAcceptedVersion(status.record, artifactVersion(next), { event: "migrated", migration: operation.acceptedFrom.migration, at: operation.acceptedFrom.at }));
        }
      }
      if (operation.bytes === void 0) noteFormatted(file, scope, address);
      continue;
    }
    const source = operation.op === "move_scope" ? await moveSource(item, await holders(seen, address, scopesFor(seen, address.kind, null), read)) : operation.op === "accept_at_ship" || operation.op === "accept_moved" ? await one(item, [operation.atScope]) : await one(item, scopesFor(seen, address.kind, given));
    if (!source) {
      await refuseOthers(item);
      if (operation.expectedVersion !== null && operation.expectedVersion !== void 0) checkVersion(file, operation.expectedVersion, null);
      throw notFound(file);
    }
    if (operation.expectedVersion !== void 0) checkVersion(file, operation.expectedVersion, source.record);
    if (operation.op === "edit") {
      const text2 = applyEdits(file, decode(contentOf(file, source.record), file), operation.edits);
      const next = Buffer.from(text2, "utf8");
      tooLarge(file, next.length);
      state.set(source.target, stored(next));
      names.set(source.target, file);
      artifacts.push({ path: file, scope: source.scope, version: artifactVersion(next) });
      if (hasStatus(address.kind)) mismatches.push({ entry: artifacts.at(-1), file, scope: source.scope, address, text: text2 });
      noteFormatted(file, source.scope, address);
    } else if (operation.op === "remove") {
      state.set(source.target, null);
      const status = await statusOf(source.scope, address);
      if (status.exists) setStatus(status.target, file, null);
      await setIdentity(source.scope, address, file, null);
      artifacts.push(counted({ path: file, scope: source.scope, removed: true }, await takeComments(source.scope, address, file)));
    } else if (operation.op === "ask_approval") {
      const status = await statusOf(source.scope, address);
      if (item.shipped && !realizes(item.shipped, file, contentOf(file, source.record))) {
        throw fail("validation_failed", `${file} cites none of the requirement files of the shipped initiative ${item.shipped.initiative}, and no slice.md of its plan links it, so nothing shows that the initiative realized it; nothing changed.`);
      }
      const asked = askApproval(address.kind, file, status.record, { status: operation.status, question: operation.question, context: operation.context, version: source.record.version, initiative: operation.initiative, slice: operation.slice, ...item.shipped ? { shipped: item.shipped } : {} });
      setStatus(status.target, file, asked.record);
      artifacts.push({ path: file, scope: source.scope, version: source.record.version, gate: asked.gate.id });
    } else if (operation.op === "answer_approval") {
      const status = await statusOf(source.scope, address);
      const answered = answerApproval(address.kind, file, status.record, { ...operation.answer, version: source.record.version, text: decode(contentOf(file, source.record), file) });
      let record = answered.record;
      let version2 = source.record.version;
      if (answered.text !== null) {
        const next = Buffer.from(answered.text, "utf8");
        tooLarge(file, next.length);
        state.set(source.target, stored(next));
        names.set(source.target, file);
        version2 = artifactVersion(next);
        await keepAccepted(file, next);
        record = withAcceptedVersion(record, version2, { event: "accepted", gate: answered.gate.id, at: answered.gate.answer.answeredAt });
      }
      setStatus(status.target, file, record);
      artifacts.push({ path: file, scope: source.scope, version: version2, gate: answered.gate });
      if (answered.text !== null) noteFormatted(file, source.scope, address);
    } else if (operation.op === "accept_at_ship") {
      const status = await statusOf(source.scope, address);
      const accepted = acceptAtShip(status.record, decode(contentOf(file, source.record), file), { ...operation.ship, versionOf: (text2) => artifactVersion(Buffer.from(text2, "utf8")) });
      const next = Buffer.from(accepted.text, "utf8");
      tooLarge(file, next.length);
      state.set(source.target, stored(next));
      names.set(source.target, file);
      await keepAccepted(file, next);
      setStatus(status.target, file, accepted.record);
      artifacts.push({ path: file, scope: source.scope, version: accepted.record.acceptedVersion });
      noteFormatted(file, source.scope, address);
    } else if (operation.op === "accept_version") {
      const status = await statusOf(source.scope, address);
      if (status.record.acceptedVersion !== source.record.version) {
        await keepAccepted(file, contentOf(file, source.record));
        setStatus(status.target, file, withAcceptedVersion(status.record, source.record.version, operation.event));
      }
      artifacts.push({ path: file, scope: source.scope, version: source.record.version, acceptedVersion: source.record.version });
    } else if (operation.op === "accept_moved") {
      const status = await statusOf(source.scope, address);
      if (movedWithoutAcceptance(address.kind, status.record)) {
        await keepAccepted(file, operation.bytes);
        setStatus(status.target, file, withAcceptedVersion(status.record, artifactVersion(operation.bytes), operation.event));
      }
      artifacts.push({ path: file, scope: source.scope, version: source.record.version });
    } else {
      const scope = scopeOf(seen, given);
      let removed = [];
      checkComponentName(file, scope);
      checkLetterCase(item, await heldBefore(), checked);
      checkLocationLength(scope, address);
      if (scope.label !== source.scope.label) {
        const target = await resolveArtifactFile(seen, artifactLocation(scope, address));
        if (await read(target) !== null) throw fail("artifact_exists", `${file} already exists in scope ${scope.label}, so it cannot move there from scope ${source.scope.label}.`, { scope });
        state.set(target, stored(contentOf(file, source.record)));
        names.set(target, file);
        state.set(source.target, null);
        const from = await statusOf(source.scope, address);
        const to = await statusOf(scope, address);
        if (from.exists) {
          setStatus(to.target, file, from.record);
          setStatus(from.target, file, null);
        } else if (to.exists) setStatus(to.target, file, null);
        removed = await takeComments(scope, address, file);
        await putComments(scope, address, file, await takeComments(source.scope, address, file));
        const id = await identityHeld(source.scope, address);
        await setIdentity(source.scope, address, file, null);
        await setIdentity(scope, address, file, id);
        for (const entry of formatted) if (entry.file === file && entry.scope.label === source.scope.label) entry.scope = scope;
      }
      artifacts.push(counted({ path: file, scope, version: source.record.version }, removed));
    }
  }
  await checkFormats(seen, formatted, { read, statusOf, formatCheck });
  for (const { entry, scope, address, file, text: text2 } of mismatches) {
    if (state.get(await resolveArtifactFile(seen, artifactLocation(scope, address)))?.version !== entry.version) continue;
    const mismatch = statusMismatch(address.kind, file, text2, (await statusOf(scope, address)).record);
    if (mismatch) entry.statusMismatch = mismatch;
  }
  const changed = [...state].filter(([target, record]) => (record?.version ?? null) !== (original.get(target)?.version ?? null));
  const clearing = [...strays].filter(([target]) => names.has(target));
  await checkLayout(seen, changed.filter(([target, record]) => record !== null && !strays.has(target)), state, names);
  seen.folderChecks = null;
  for (const [, stray] of clearing) {
    if ((await lstat(stray).catch(() => null))?.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    await rm(stray, { recursive: true, force: true });
    await pruneArtifactFolders(baseFor(seen, stray), stray);
  }
  const writes = writeChecks();
  for (const [target, record] of changed.filter(([, record2]) => record2 !== null)) {
    await mkdir(path.dirname(target), { recursive: true });
    await resolveAgain(seen, target, writes);
    await writeAtomically(target, record.bytes);
    if (noteWrites) noteToolCallWrite(target, record.version);
  }
  for (const [target] of changed.filter(([, record]) => record === null)) {
    await rm(target, { force: true });
    await pruneArtifactFolders(baseFor(seen, target), target);
  }
  if (changed.length || clearing.length) {
    await markArtifactIndexStale(seen.store.base);
    if (seen.store.sync) scheduleRecordSync(seen.store.base);
  }
  return { artifacts, files: changed.map(([target]) => path.relative(seen.store.base, target).split(path.sep).join("/")) };
}
const FORMAT_TYPES = Object.freeze({ requirements: "requirements", adrs: "adr", glossary: "glossary" });
const scopeText = (scope) => `${scope.label}`;
async function checkFormats(seen, formatted, { read, statusOf, formatCheck }) {
  if (!formatted.length) return;
  const { checkArtifactContent, storeSourceLookup } = await import("./artifact-check.mjs");
  let applied = null;
  let everyScope = null;
  const recordedStatus = async (scope, address) => hasStatus(address.kind) ? (await statusOf(scope, address)).record?.status ?? null : null;
  const copiesOf = async (file) => {
    const address = normalizeArtifactPath(file) === file ? artifactAddress(seen.kinds, file) : null;
    if (!address || !hasStatus(address.kind) || address.rest === "" || malformedArtifactName(address) !== null) return [];
    everyScope ??= storeScopes(seen);
    const found = [];
    for (const { scope, record } of await holders(seen, address, (await everyScope).filter((scope2) => kindInScope(address.kind, scope2)), read)) {
      found.push({ scope, bytes: record.bytes, status: await recordedStatus(scope, address) });
    }
    return found;
  };
  const refused = [];
  const seenKeys = /* @__PURE__ */ new Set();
  for (const { file, scope, address } of formatted) {
    const key = `${scope.label}\0${file}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const record = await read(await resolveArtifactFile(seen, artifactLocation(scope, address)));
    if (record === null || record.bytes === null) continue;
    const type = FORMAT_TYPES[address.kind];
    if (type === "glossary" && applied === null) {
      const { appliedMigrationIds } = await import("./format-migrations.mjs");
      applied = await appliedMigrationIds(seen.root);
    }
    const result = await checkArtifactContent({
      path: file,
      type,
      bytes: record.bytes,
      status: await recordedStatus(scope, address),
      lookup: type === "glossary" ? storeSourceLookup(scope, copiesOf) : null,
      appliedMigration: (id) => formatCheck.appliedMigration?.(id) === true || applied?.has(id) === true,
      unknownAside: formatCheck.unknownAside === true
    });
    if (!result.conforms) refused.push({ path: file, scope, type, findings: result.findings });
  }
  if (!refused.length) return;
  const lines = refused.map((artifact) => `${artifact.path} in scope ${scopeText(artifact.scope)} breaks ${[...new Set(artifact.findings.map((finding) => finding.rule))].join(", ")}: ${artifact.findings.map((finding) => finding.message).join(" ")}`);
  throw fail("artifact_nonconforming", `The update would leave ${refused.length === 1 ? "an artifact that breaks its format" : "artifacts that break their formats"}, so nothing changed: ${lines.join(" ")} Write content that follows the format reference, or report a break the check does not see with report_format_finding.`, { artifacts: refused });
}
async function identityEntry(seen, location) {
  const names = location.split("/");
  let current = seen.store.base;
  const checked = seen.folderChecks?.folders ?? null;
  for (const [index, name] of [ARTIFACT_IDENTITY, ...names].entries()) {
    current = path.join(current, name);
    if (index < names.length && checked?.has(current)) continue;
    const info2 = await lstat(current).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    });
    if (info2 === null) break;
    if (info2.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    if (index < names.length) {
      if (info2.isDirectory()) {
        checked?.add(current);
        continue;
      }
      return { record: null, stray: current };
    }
    if (!info2.isFile()) return { record: null, stray: current };
  }
  const target = await resolveStatusFile(seen, `${ARTIFACT_IDENTITY}/${location}`);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) return { record: null, stray: null };
  const bytes = info.size <= IDENTITY_FILE_MAX ? await readFile(target).catch(() => null) : null;
  return { record: bytes === null ? { bytes: null, version: "held" } : stored(bytes), stray: null };
}
async function storeIdentities(seen) {
  const locations = [];
  const visit = async (relative) => {
    let entries;
    try {
      entries = await readdir(relative === "" ? seen.base : path.join(seen.base, ...relative.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && child.split("/").every(wellFormedName)) locations.push(child);
    }
  };
  await visit("");
  const written = /* @__PURE__ */ new Map();
  for (const location of locations) {
    const target = path.join(seen.store.base, ARTIFACT_IDENTITY, ...location.split("/"));
    const info = await lstat(target).catch(() => null);
    const id = info?.isFile() && info.size <= IDENTITY_FILE_MAX ? identityOf(await readFile(target).catch(() => null)) : null;
    if (id !== null) written.set(location, id);
  }
  return uniqueIdentities(locations, written);
}
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
async function ownArtifact(projectRoot, file) {
  const { config, kinds } = await configuration(projectRoot);
  const normalized = normalizeArtifactPath(file);
  const address = normalized === null || normalized === "" ? null : artifactAddress(kinds, normalized);
  if (!address || address.rest === "") throw notAnArtifact(file);
  checkName(file, address);
  return { config, kinds, file: normalized, address };
}
const GENERATED_VIEW = Buffer.from("This file is a generated view of ");
const generatedView = (record) => record?.bytes != null && record.bytes.includes(GENERATED_VIEW);
async function authoredFolder(target) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
  for (const entry of entries) {
    if (!wellFormedName(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && await authoredFolder(child)) return true;
    if (entry.isFile() && !generatedView(await readStored(child).catch(() => null))) return true;
  }
  return false;
}
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
const scopeFieldsOf = (scope) => scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };
async function readStoreArtifact(projectRoot, file) {
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
async function reviewStoreArtifact(projectRoot, file, { commentOffset = 1 } = {}) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    const held = await holders(seen, address, scopesFor(seen, address.kind, null));
    if (held.length > 1) throw ambiguous(normalized, held);
    if (!held.length) return null;
    const [{ scope, target, record }] = held;
    const modifiedAt = (await lstat(target).catch(() => null))?.mtimeMs ?? null;
    const status = await withMovedAcceptance(seen, scope, address, normalized, await statusRecordOf(seen, scope, address), contentOf(normalized, record));
    const { acceptedVersion } = status;
    const acceptedText = acceptedVersion === null ? null : await acceptedBytes(seen, normalized, acceptedVersion).then((bytes) => artifactText(bytes), () => null);
    return {
      path: normalized,
      scope,
      bytes: contentOf(normalized, record),
      version: record.version,
      modifiedAt,
      accepted: acceptedVersion === null ? null : { version: acceptedVersion, content: acceptedText },
      changed: acceptedVersion !== record.version,
      // The format migration run that recorded the accepted version, so the page says that Prism migrated the file.
      acceptedFrom: statusFields(address.kind, status, record.version).acceptedFrom ?? null,
      ...await listComments(seen, scope, address, commentOffset)
    };
  });
}
const labeledScope = (seen, label) => seen.scopes.find((scope) => scope.label === label) ?? null;
async function workspaceArtifacts(projectRoot) {
  return refusing(async () => {
    const seen = await seenScopes(projectRoot);
    const index = await artifactIndex(seen, seen.all);
    const held = (await lstat(seen.base).catch(() => null))?.isDirectory() === true;
    const entries = index.entries.map((entry) => ({ location: entry.location, scope: entry.scope, kind: entry.kind, rest: entry.rest, path: checkoutPath(seen.kinds, entry), ...hasStatus(entry.kind) ? { status: entry.status } : {} })).sort((left, right) => left.location < right.location ? -1 : left.location > right.location ? 1 : 0);
    return { indexedAt: index.indexedAt, held, scopes: seen.all, entries, repository: seen.repository ?? null };
  });
}
async function atLocation(seen, location) {
  const found = typeof location === "string" ? locationArtifact(location) : null;
  if (!found || location.split("/").some((name) => !wellFormedName(name))) return null;
  const scope = seen.all.find((candidate) => candidate.label === found.scope.label);
  if (!scope) return null;
  const address = { kind: found.kind, rest: found.rest };
  const target = await resolveArtifactFile(seen, location);
  const record = await readStored(target, seen.base);
  return record === null ? null : { scope, address, target, record };
}
async function reviewStoreArtifactAt(projectRoot, location, { commentOffset = 1 } = {}) {
  return refusing(async () => {
    const seen = await seenScopes(projectRoot);
    const held = await atLocation(seen, location);
    if (!held) return null;
    const { scope, address, target, record } = held;
    const file = checkoutPath(seen.kinds, address);
    const modifiedAt = (await lstat(target).catch(() => null))?.mtimeMs ?? null;
    const status = await withMovedAcceptance(seen, scope, address, file ?? location, await statusRecordOf(seen, scope, address), contentOf(file ?? location, record));
    const { acceptedVersion } = status;
    const acceptedText = acceptedVersion === null ? null : await acceptedBytes(seen, file ?? location, acceptedVersion).then((bytes) => artifactText(bytes), () => null);
    return {
      location,
      path: file,
      scope,
      kind: address.kind,
      bytes: contentOf(file ?? location, record),
      version: record.version,
      modifiedAt,
      accepted: acceptedVersion === null ? null : { version: acceptedVersion, content: acceptedText },
      changed: acceptedVersion !== record.version,
      acceptedFrom: statusFields(address.kind, status, record.version).acceptedFrom ?? null,
      ...await listComments(seen, scope, address, commentOffset)
    };
  });
}
async function readStoreArtifactAt(projectRoot, location) {
  return refusing(async () => {
    const held = await atLocation(await seenScopes(projectRoot), location);
    return held ? { location, scope: held.scope, bytes: contentOf(location, held.record) } : null;
  });
}
const belowScope = (seen, label, rest) => {
  const scope = seen.all.find((candidate) => candidate.label === label);
  if (!scope) return null;
  const folder = scopeFolder(scope);
  return folder === "" ? rest : `${folder}/${rest}`;
};
async function storeArtifactTarget(projectRoot, label, file) {
  return refusing(async () => {
    if (typeof file === "string" && normalizeArtifactPath(file) === file) {
      const seen2 = await seenScopes(projectRoot).catch((error) => {
        if (error?.code === "store_not_configured") return null;
        throw error;
      });
      const location = seen2 && belowScope(seen2, label, file);
      const held2 = location && await atLocation(seen2, location);
      if (held2 && held2.scope.label === label) return { path: checkoutPath(seen2.kinds, held2.address), location, scope: held2.scope, kind: held2.address.kind, version: held2.record.version };
    }
    let checked;
    try {
      checked = await ownArtifact(projectRoot, file);
    } catch (error) {
      if (["store_not_configured", "not_an_artifact", "artifact_name_invalid"].includes(error?.code)) return null;
      throw error;
    }
    if (checked.file !== file) return null;
    const seen = await seenScopes(projectRoot);
    const scope = labeledScope(seen, label);
    if (!scope || !kindInScope(checked.address.kind, scope)) return null;
    const [held] = await holders(seen, checked.address, [scope]);
    return held ? { path: checked.file, location: artifactLocation(scope, checked.address), scope, kind: checked.address.kind, version: held.record.version } : null;
  });
}
async function commentOnArtifact(projectRoot, { path: file, location = null, label, version: expected, line, text: text2, author, entry }) {
  return refusing(async () => {
    if (location !== null) {
      const seen2 = await seenScopes(projectRoot);
      return withArtifactStoreLock(seen2, async () => {
        const held = await atLocation(seen2, location);
        if (!held || held.scope.label !== label) throw fail("artifact_not_found", `No scope of the record store holds the artifact at ${location}.`);
        if (held.record.version !== expected) throw fail("version_conflict", `${location} changed since the page read it.`, { version: held.record.version });
        return addComment(seen2, held.scope, held.address, { version: expected, line, text: text2, author, entry });
      });
    }
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const scope = labeledScope(seen, label);
      const [held] = scope ? await holders(seen, address, [scope]) : [];
      if (!held) throw notFound(normalized);
      if (held.record.version !== expected) throw fail("version_conflict", `${normalized} changed since the page read it.`, { version: held.record.version });
      return addComment(seen, scope, address, { version: expected, line, text: text2, author, entry });
    });
  });
}
async function writeStoreArtifact(projectRoot, file, decide, { follow = false } = {}) {
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
      if (next === void 0 || next === null && current === null) return unchanged;
      const preferred = next !== null && (current === null || follow) ? await ownScope(seen, address, scopes) : current?.scope ?? null;
      const check = (operation) => checkOperation(config, kinds, operation);
      const inScope = (operation, scope) => {
        try {
          return check({ ...operation, ...scopeFieldsOf(scope) });
        } catch (error) {
          if (error?.code === "component_unknown") return null;
          throw error;
        }
      };
      const version2 = current?.record.version ?? null;
      let checked;
      if (next === null) checked = [check({ op: "remove", path: normalized, expectedVersion: version2 })];
      else if (current === null) checked = [inScope({ op: "write", path: normalized, content: next, expectedVersion: null }, preferred) ?? check({ op: "write", path: normalized, content: next, expectedVersion: null })];
      else {
        const moved = preferred.label !== current.scope.label && inScope({ op: "move_scope", path: normalized, expectedVersion: version2 }, preferred);
        if (moved) checked = [moved, check({ op: "write", path: normalized, content: next, expectedVersion: version2, ...scopeFieldsOf(preferred) })];
        else if (Buffer.from(next, "utf8").equals(current.record.bytes)) return unchanged;
        else checked = [check({ op: "write", path: normalized, content: next, expectedVersion: version2 })];
      }
      const entry = (await applyOperations(seen, checked)).artifacts.at(-1);
      return { written: true, scope: entry.scope, version: entry.version ?? null };
    });
  });
}
const seenArtifacts = (seen) => holdings(seen, "", null);
async function storedArtifactIn(seen, scope, address) {
  const location = artifactLocation(scope, address);
  const target = await resolveArtifactFile(seen, location);
  return { target, location, record: await readStored(target, seen.base) };
}
const FORMAT_KINDS = /* @__PURE__ */ new Set(["requirements", "adrs", "glossary"]);
async function storeScopes(seen) {
  let names = [];
  try {
    names = (await readdir(path.join(seen.base, "repositories"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && wellFormedName(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const scopes = [WORKSPACE_SCOPE];
  for (const name of names) scopes.push(...await repositoryScopes(seen, name));
  return scopes;
}
async function namedHoldings(seen, kinds, paths) {
  const found = [];
  for (const file of new Set(paths)) {
    const address = normalizeArtifactPath(file) === file ? artifactAddress(kinds, file) : null;
    if (!address || address.rest === "" || malformedArtifactName(address) !== null) continue;
    for (const { scope, target } of await holders(seen, address, seen.scopes.filter((scope2) => kindInScope(address.kind, scope2)), async (target2) => await locationKind(target2, seen.base).catch(() => null) === "file" ? {} : null)) {
      found.push({ path: file, scope, kind: address.kind, target });
    }
  }
  return found;
}
async function seenArtifactTexts(projectRoot, { paths = null } = {}) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const resolve = manyReads(seen);
    const statusOf = async (scope, file, kind) => hasStatus(kind) ? (await statusRecordOf(seen, scope, artifactAddress(kinds, file), resolve)).status : null;
    const artifacts = [];
    for (const entry of paths === null ? await holdings(seen, "", null) : await namedHoldings(seen, kinds, paths)) {
      if (!FORMAT_KINDS.has(entry.kind)) continue;
      const record = await readStored(entry.target);
      if (record === null) continue;
      artifacts.push({ path: entry.path, scope: entry.scope, kind: entry.kind, bytes: record.bytes, size: record.size, version: record.version, status: await statusOf(entry.scope, entry.path, entry.kind) });
    }
    let everyScope = null;
    const copies = /* @__PURE__ */ new Map();
    const copiesOf = (file) => {
      if (!copies.has(file)) copies.set(file, (async () => {
        const address = normalizeArtifactPath(file) === file ? artifactAddress(kinds, file) : null;
        if (!address || !hasStatus(address.kind) || address.rest === "" || malformedArtifactName(address) !== null) return [];
        everyScope ??= storeScopes(seen);
        const held = await holders(seen, address, (await everyScope).filter((scope) => kindInScope(address.kind, scope)));
        const found = [];
        for (const { scope, record } of held) found.push({ scope, bytes: record.bytes, status: await statusOf(scope, file, address.kind) });
        return found;
      })());
      return copies.get(file);
    };
    return { repository: seen.repository, artifacts, copiesOf: (file) => refusing(() => copiesOf(file)) };
  });
}
const ARTIFACT_CONTENT_MAX = CONTENT_MAX;
function artifactText(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
async function createMovedArtifacts(seen, writes, { held = null } = {}) {
  const items = writes.map(({ file, address, scope, bytes, text: text2, writtenStatus }) => ({
    operation: { op: "write", path: file, content: text2, bytes, expectedVersion: null, writtenStatus, ...scopeFieldsOf(scope) },
    file,
    address,
    given: scope.kind === "component" ? { kind: "component", component: scope.component } : { kind: scope.kind }
  }));
  return items.length ? (await applyOperations(seen, items, { held })).artifacts : [];
}
async function recordMovedStatus(seen, scope, address, written, bytes) {
  if (!hasStatus(address.kind)) return false;
  const target = await resolveStatusFile(seen, statusRecordLocation(scope, address));
  if (await locationKind(target, baseFor(seen, target)) !== "missing") return false;
  let record = newRecord(address.kind, written ?? null);
  if (acceptedWhenMoved(address.kind, written)) {
    const version2 = artifactVersion(bytes);
    const kept = await resolveStatusFile(seen, acceptedLocation(version2));
    if (await locationKind(kept, baseFor(seen, kept)) === "missing") {
      await mkdir(path.dirname(kept), { recursive: true });
      await resolveAgain(seen, kept);
      await writeAtomically(kept, bytes);
    }
    record = withAcceptedVersion(record, version2, { event: "moved", at: (/* @__PURE__ */ new Date()).toISOString() });
  }
  await mkdir(path.dirname(target), { recursive: true });
  await resolveAgain(seen, target);
  await writeAtomically(target, serializeRecord(record));
  await markArtifactIndexStale(seen.store.base);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return true;
}
async function writeMovedView(seen, file, address, scope, content, expectedVersion) {
  const item = { operation: { op: "write", path: file, content, expectedVersion, ...scopeFieldsOf(scope) }, file, address, given: { kind: scope.kind } };
  return (await applyOperations(seen, [item])).artifacts[0];
}
async function artifactAtLocation(projectRoot, storeBase, location) {
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
async function storeArtifactPaths(projectRoot, folder = "") {
  return refusing(async () => {
    await configuration(projectRoot);
    const normalized = normalizeArtifactPath(folder);
    if (normalized === null) throw notAnArtifact(folder);
    const seen = await seenScopes(projectRoot);
    return (await holdings(seen, normalized, null)).map(({ path: found, scope, kind }) => ({ path: found, scope, kind }));
  });
}
async function storeArtifactLocation(projectRoot, file) {
  return refusing(async () => {
    const { file: normalized, address } = await ownArtifact(projectRoot, file);
    const seen = await seenScopes(projectRoot);
    const scopes = scopesFor(seen, address.kind, null);
    const held = await holders(seen, address, scopes);
    if (held.length > 1) throw ambiguous(normalized, held);
    const scope = held[0]?.scope ?? await ownScope(seen, address, scopes);
    return { scope, location: artifactLocation(scope, address) };
  });
}
function namedScope(seen, scope, component) {
  if (scope === void 0 || scope === null) return {};
  if (typeof scope === "object") return namedScope(seen, scope.kind, scope.component);
  if (scope === "component" || SCOPE_KINDS.has(scope) && component === void 0) return { scope, ...component === void 0 ? {} : { component } };
  if (scope === seen.repository) return { scope: "repository" };
  if (typeof scope === "string" && scope.startsWith(`${seen.repository}/`)) return { scope: "component", component: scope.slice(seen.repository.length + 1) };
  throw fail("scope_invalid", `${JSON.stringify(scope)} is no scope this checkout sees: ${SCOPE_TEXT}.`);
}
async function answerArtifactApproval(projectRoot, { path: file, scope, component, id, choice, note = null, by, entry = null }) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const item = checkOperation(config, kinds, { op: "answer_approval", path: file, ...namedScope(seen, scope, component), answer: { id, choice, note, by, entry } });
    return withArtifactStoreLock(seen, async () => {
      const holding = (await seenPendingGates(seen)).filter((gate) => gate.id === id);
      if (holding.length > 1) throw fail("approval_ambiguous", ambiguousApprovalMessage(id, holding), { holders: holding.map((gate) => gate.artifact) });
      return (await applyOperations(seen, [item])).artifacts[0];
    });
  });
}
function ambiguousApprovalMessage(id, gates) {
  const named = gates.map((gate) => `${gate.artifact.path} (${gate.artifact.scope?.label ?? "workspace"})`);
  return `More than one pending approval holds the id ${id}, so an answer to it cannot tell which file it approves: ${named.join(", ")}. Nothing was recorded; the agent asks again for the file it means.`;
}
async function statusHoldings(seen) {
  const found = [];
  for (const entry of seen.kinds.kinds.filter((candidate) => hasStatus(candidate.kind))) found.push(...(await holdings(seen, entry.path, null)).filter((held) => held.kind === entry.kind));
  return sortEntries(found);
}
async function pendingApprovalGates(projectRoot) {
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
  if (entry.after.note !== null && !(typeof entry.after.note === "string" && entry.after.note.length <= 4e3)) return null;
  if (!storedTime(entry.at) || entry.at !== item.at || !storedAuthor(entry.by) || entry.by.name !== item.by.name) return null;
  return entry;
};
async function appliedArtifactActions(projectRoot, { latest = Infinity } = {}) {
  return refusing(async () => {
    await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const listed = /* @__PURE__ */ new Map();
    const now = Date.now();
    const resolve = manyReads(seen);
    for (const entry of await statusHoldings(seen)) {
      const record = await statusRecordOf(seen, entry.scope, artifactAddress(seen.kinds, entry.path), resolve);
      for (const item of record.history) {
        const applied = appliedEntry(item);
        if (applied && !aheadOfClock(applied.at, now) && !listed.has(applied.id)) listed.set(applied.id, { ...applied, initiative: null, artifact: { path: entry.path, scope: entry.scope } });
      }
    }
    const artifacts = (await holdings(seen, "", null)).map(({ path: file, scope }) => ({ path: file, scope }));
    for (const comment of await appliedComments(seen, now, { latest, artifacts, resolve })) if (!listed.has(comment.id)) listed.set(comment.id, comment);
    return [...listed.values()];
  });
}
async function artifactStoreLocation(projectRoot, { path: file, scope }) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const address = artifactAddress(kinds, file);
    return address ? artifactLocation(scope, address) : null;
  });
}
async function appliedArtifactAction(projectRoot, { location, id, action, comment = null }) {
  return refusing(async () => {
    await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const named = locationArtifact(location);
    if (!named) return null;
    const file = artifactPathOf(seen.kinds, named.kind, named.rest);
    const address = file === null ? null : artifactAddress(seen.kinds, file);
    if (!address || address.kind !== named.kind || address.rest !== named.rest || malformedArtifactName(address) !== null) return null;
    const scope = seen.scopes.find((candidate) => kindInScope(address.kind, candidate) && artifactLocation(candidate, address) === location);
    if (!scope) return null;
    const target = await resolveArtifactFile(seen, location).catch(() => null);
    if (!target || await locationKind(target, seen.base).catch(() => null) !== "file") return null;
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
async function approvalGatesWithIds(projectRoot, ids) {
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
async function storeArtifactStatuses(projectRoot, folder = "") {
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
async function artifactApprovalGates(projectRoot, file, scope, component, { since = false } = {}) {
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
async function planSeen(seen, plan) {
  const scopes = [WORKSPACE_SCOPE];
  for (const repository of [...new Set(plan.repositories)].sort()) scopes.push(...await repositoryScopes(seen, repository));
  return { ...seen, scopes };
}
function planSliceOf(plan, file) {
  let found = null;
  for (const slice of plan.slices) if (below(slice.folder, file) && (found === null || slice.folder.length > found.folder.length)) found = slice;
  return found;
}
async function planSliceFiles(wide, plan) {
  return (await holdings(wide, plan.folder, null)).filter((entry) => entry.kind === "plans" && path.posix.basename(entry.path) === "slice.md").map((entry) => ({ ...entry, slice: planSliceOf(plan, entry.path) })).filter((entry) => entry.slice !== null);
}
async function readPlanSlices(wide, plan) {
  const read = [];
  for (const entry of await planSliceFiles(wide, plan)) {
    const held = await readStored(entry.target, null, null, CONTENT_MAX);
    if (held !== null) read.push({ entry, held });
  }
  return read;
}
const sliceVersions = (read) => read.map(({ entry, held }) => ({ scope: entry.scope.label, path: entry.path, version: held.version }));
const planRepositories = (plan) => plan.slices.map((slice) => ({ folder: slice.folder, repositories: [...slice.repositories].sort() })).sort((left, right) => left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0);
async function planLinkedAdrs(seen, wide, kinds, read, { strict, resolve }) {
  const adrFolder = kinds.kinds.find((entry) => entry.kind === "adrs")?.path ?? null;
  if (adrFolder === null) return { linked: [], ambiguous: [] };
  const adrs = /* @__PURE__ */ new Map();
  for (const entry of await holdings(wide, adrFolder, null)) {
    if (entry.kind !== "adrs") continue;
    if (!adrs.has(entry.path)) adrs.set(entry.path, []);
    adrs.get(entry.path).push(entry);
  }
  const linked = /* @__PURE__ */ new Map();
  const ambiguous2 = /* @__PURE__ */ new Map();
  for (const { entry, held } of read) {
    if (held.bytes === null) {
      if (!strict) continue;
      throw fail("artifact_too_large", `${entry.path} in scope ${entry.scope.label} is ${held.size} bytes, above the ${CONTENT_MAX} bytes that an artifact may hold, so Prism cannot read the ADRs it links and the initiative does not ship; shorten it with update_artifact.`, { path: entry.path, scope: entry.scope });
    }
    const text2 = artifactText(held.bytes);
    if (text2 === null) continue;
    const files = linkedPaths(text2, entry.path);
    if (files === null) {
      if (!strict) continue;
      throw fail("artifact_too_large", `${entry.path} in scope ${entry.scope.label} nests its Markdown deeper, or repeats unclosed link syntax more often, than Prism reads, so Prism cannot read the ADRs it links and the initiative does not ship; simplify it with update_artifact.`, { path: entry.path, scope: entry.scope });
    }
    const allowed = (scope) => scope.kind === "workspace" || entry.slice.repositories.includes(scope.repository);
    for (const file of files) {
      const candidates = (adrs.get(file) ?? []).filter((candidate) => allowed(candidate.scope));
      const holder = candidates.find((candidate) => candidate.scope.label === entry.scope.label) ?? (candidates.length === 1 ? candidates[0] : null);
      if (holder === null) {
        if (candidates.length > 1) {
          const scopes = candidates.map((candidate) => candidate.scope.label).sort();
          ambiguous2.set(`${file}\0${scopes.join("\0")}`, { path: file, scopes });
        }
        continue;
      }
      const key = `${holder.scope.label}\0${file}`;
      if (!linked.has(key)) linked.set(key, { path: file, scope: holder.scope, target: holder.target });
    }
  }
  const named = [];
  for (const adr of linked.values()) {
    const address = artifactAddress(kinds, adr.path);
    named.push({ ...adr, address, record: await statusRecordOf(seen, adr.scope, address, resolve) });
  }
  const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return { linked: sortEntries(named), ambiguous: [...ambiguous2.values()].sort((left, right) => order(left.path, right.path) || order(left.scopes.join("\0"), right.scopes.join("\0"))) };
}
async function proposedVersions(linked) {
  const versions = [];
  for (const adr of linked) {
    if (adr.record.status !== "Proposed") continue;
    const held = await readStored(adr.target, null, null, CONTENT_MAX);
    if (held !== null) versions.push({ scope: adr.scope.label, path: adr.path, version: held.version });
  }
  return versions;
}
async function unlinkedAdrs(projectRoot, plan, requirements) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const folderOf = (kind) => kinds.kinds.find((entry) => entry.kind === kind)?.path ?? null;
    const adrFolder = folderOf("adrs");
    const cited = new Set(requirements.filter((item) => typeof item === "string").map((item) => item.replace(/#.*$/, "")));
    if (plan === null || adrFolder === null || !cited.size) return [];
    const seen = await seenScopes(projectRoot);
    const wide = await planSeen(seen, plan);
    const resolve = manyReads(seen);
    const { linked } = await planLinkedAdrs(seen, wide, kinds, await readPlanSlices(wide, plan), { strict: false, resolve });
    const own = new Set(linked.map((adr) => `${adr.scope.label}\0${adr.path}`));
    const elsewhere = /* @__PURE__ */ new Set();
    const plansFolder = folderOf("plans");
    if (plansFolder !== null) {
      for (const entry of await holdings(wide, plansFolder, null)) {
        if (entry.kind !== "plans" || path.posix.basename(entry.path) !== "slice.md" || below(plan.folder, entry.path)) continue;
        const held = await readStored(entry.target, null, null, CONTENT_MAX);
        const text2 = held?.bytes ? artifactText(held.bytes) : null;
        for (const file of (text2 === null ? null : linkedPaths(text2, entry.path)) ?? []) elsewhere.add(file);
      }
    }
    const allowed = (scope) => scope.kind === "workspace" || plan.repositories.includes(scope.repository);
    const found = [];
    for (const entry of await holdings(wide, adrFolder, null)) {
      if (entry.kind !== "adrs" || !allowed(entry.scope) || own.has(`${entry.scope.label}\0${entry.path}`) || elsewhere.has(entry.path)) continue;
      const record = await statusRecordOf(seen, entry.scope, artifactAddress(kinds, entry.path), resolve);
      if (record.status !== "Proposed") continue;
      const held = await readStored(entry.target, null, null, CONTENT_MAX);
      const text2 = held?.bytes ? artifactText(held.bytes) : null;
      const names = [...new Set((text2 === null ? null : linkedPaths(text2, entry.path)) ?? [])].filter((file) => cited.has(file)).sort();
      if (names.length) found.push({ path: entry.path, scope: entry.scope.label, requirements: names });
    }
    return found.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0);
  });
}
async function linkedAdrProblems(projectRoot, plan) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const wide = await planSeen(seen, plan);
    const { ambiguous: ambiguous2 } = await planLinkedAdrs(seen, wide, kinds, await readPlanSlices(wide, plan), { strict: true, resolve: manyReads(seen) });
    return { ambiguous: ambiguous2 };
  });
}
async function initiativeArtifactStanding(projectRoot, plan) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const wide = await planSeen(seen, plan);
    const read = await readPlanSlices(wide, plan);
    const { linked } = await planLinkedAdrs(seen, wide, kinds, read, { strict: false, resolve: manyReads(seen) });
    return { slices: sliceVersions(read), repositories: planRepositories(plan), adrs: await proposedVersions(linked) };
  });
}
function versionChanges(before, now) {
  const key = (entry) => `${entry.scope}\0${entry.path}`;
  const was = new Map(before.map((entry) => [key(entry), entry]));
  const is = new Map(now.map((entry) => [key(entry), entry]));
  const changes = [];
  for (const [at, entry] of is) {
    if (!was.has(at)) changes.push({ path: entry.path, scope: entry.scope, change: "added" });
    else if (was.get(at).version !== entry.version) changes.push({ path: entry.path, scope: entry.scope, change: "changed" });
  }
  for (const [at, entry] of was) if (!is.has(at)) changes.push({ path: entry.path, scope: entry.scope, change: "removed" });
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0);
}
function repositoryChanges(before, now) {
  const was = new Map(before.map((entry) => [entry.folder, entry.repositories]));
  const is = new Map(now.map((entry) => [entry.folder, entry.repositories]));
  const changes = [];
  for (const folder of /* @__PURE__ */ new Set([...was.keys(), ...is.keys()])) {
    const then = was.get(folder) ?? [];
    const current = is.get(folder) ?? [];
    if (!was.has(folder) || !is.has(folder) || then.join("\0") !== current.join("\0")) changes.push({ folder, repositories: current, before: then });
  }
  return changes.sort((left, right) => left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0);
}
async function acceptLinkedAdrs(projectRoot, ships) {
  return refusing(async () => {
    const { kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const resolve = manyReads(seen);
      const chosen = /* @__PURE__ */ new Map();
      const pending = [];
      const ambiguous2 = /* @__PURE__ */ new Map();
      for (const { plan, standing, ship } of ships) {
        const wide = await planSeen(seen, plan);
        const read = await readPlanSlices(wide, plan);
        const changed = [...versionChanges(standing.slices, sliceVersions(read)), ...repositoryChanges(standing.repositories, planRepositories(plan))];
        if (changed.length) return { refused: "ship_unconfirmed", gate: ship.gate, changed };
        const { linked, ambiguous: unclear } = await planLinkedAdrs(seen, wide, kinds, read, { strict: true, resolve });
        const sameShip = (record) => record.acceptance?.initiative === ship.initiative && record.acceptance?.gate === ship.gate;
        const done = new Set(linked.filter((adr) => adr.record.status !== "Proposed" && sameShip(adr.record)).map((adr) => `${adr.scope.label}\0${adr.path}`));
        const adrChanges = versionChanges(standing.adrs.filter((adr) => !done.has(`${adr.scope}\0${adr.path}`)), await proposedVersions(linked)).map((item) => ({ kind: "adrs", ...item }));
        if (adrChanges.length) return { refused: "ship_unconfirmed", gate: ship.gate, changed: adrChanges };
        for (const item of unclear) ambiguous2.set(`${item.path}\0${item.scopes.join("\0")}`, item);
        for (const adr of linked) {
          const key = `${adr.scope.label}\0${adr.path}`;
          if (chosen.has(key) || pending.some((item) => item.key === key)) continue;
          if (adr.record.status === "Proposed") {
            if (adr.record.pending.length) pending.push({ key, path: adr.path, scope: adr.scope, gates: adr.record.pending.map((gate) => gate.id) });
            else chosen.set(key, { path: adr.path, scope: adr.scope, address: adr.address, ship, verifiedBy: ship.verifiedBy, accept: true });
          } else if (sameShip(adr.record)) {
            chosen.set(key, { path: adr.path, scope: adr.scope, verifiedBy: Array.isArray(adr.record.acceptance.verifiedBy) ? adr.record.acceptance.verifiedBy : ship.verifiedBy, accept: false });
          }
        }
      }
      if (ambiguous2.size) return { refused: "adr_ambiguous", adrs: [...ambiguous2.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
      if (pending.length) return { refused: "adr_pending", adrs: sortEntries(pending.map(({ key, ...rest }) => rest)) };
      const accepted = sortEntries([...chosen.values()]);
      const items = accepted.filter((adr) => adr.accept).map((adr) => ({ operation: { op: "accept_at_ship", path: adr.path, atScope: adr.scope, ship: adr.ship }, file: adr.path, address: adr.address, given: null }));
      if (items.length) await applyOperations(seen, items);
      return { accepted: accepted.map((adr) => ({ path: adr.path, scope: adr.scope, verifiedBy: adr.verifiedBy })) };
    });
  });
}
async function acceptArtifactVersions(projectRoot, folders, { exclude = [], event }) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    return withArtifactStoreLock(seen, async () => {
      const items = [];
      for (const folder of folders) {
        for (const entry of await holdings(seen, folder, null)) {
          if (exclude.some((other) => below(other, entry.path)) || generatedView(await readStored(entry.target).catch(() => null))) continue;
          try {
            items.push(checkOperation(config, kinds, { op: "accept_version", path: entry.path, ...scopeFieldsOf(entry.scope), event }));
          } catch (error) {
            if (error?.code !== "component_unknown") throw error;
          }
        }
      }
      return items.length ? (await applyOperations(seen, items)).artifacts : [];
    });
  });
}
async function storeArtifactFile(projectRoot, file, input = {}) {
  return refusing(async () => {
    const { config, address } = await ownArtifact(projectRoot, file);
    const given = scopeInput(config, input);
    const seen = await seenScopes(projectRoot);
    const held = await holders(seen, address, scopesFor(seen, address.kind, given));
    return held.length === 1 ? held[0].target : null;
  });
}
async function storeArtifactCopy(projectRoot, file, input = {}) {
  return refusing(async () => {
    const { config, file: normalized, address } = await ownArtifact(projectRoot, file);
    const given = scopeInput(config, input);
    checkKindScope(address.kind, given);
    const seen = await seenScopes(projectRoot);
    const scopes = scopesFor(seen, address.kind, given);
    const held = await holders(seen, address, scopes);
    if (held.length > 1) throw ambiguous(normalized, held);
    if (!held.length) return { path: normalized, kind: address.kind, scope: given ? scopeOf(seen, given) : await ownScope(seen, address, scopes), held: null };
    const [{ scope, record }] = held;
    const status = hasStatus(address.kind) ? (await statusRecordOf(seen, scope, address)).status : null;
    return { path: normalized, kind: address.kind, scope, held: { bytes: contentOf(normalized, record), version: record.version, status } };
  });
}
async function applyStoreRun(projectRoot, { writes, removes = [], appliedMigration, acceptedFrom }) {
  return refusing(async () => {
    const { config, kinds } = await configuration(projectRoot);
    const seen = await seenScopes(projectRoot);
    const operations = [
      ...writes.map((target) => ({ op: "write", path: target.path, content: target.content, expectedVersion: target.expectedVersion, ...scopeFieldsOf(target.scope), ...target.expectedVersion === null && target.status ? { writtenStatus: target.status } : {}, acceptedFrom })),
      ...removes.map((source) => ({ op: "remove", path: source.path, expectedVersion: source.expectedVersion, ...scopeFieldsOf(source.scope) }))
    ];
    const checked = operations.map((operation) => {
      const { writtenStatus, acceptedFrom: from, ...plain } = operation;
      return { ...checkOperation(config, kinds, plain), operation };
    });
    return withArtifactStoreLock(seen, () => applyOperations(seen, checked, { noteWrites: true, formatCheck: { unknownAside: false, appliedMigration } }));
  });
}
async function storeSyncBase(projectRoot) {
  if (((await readWorkflowConfig(projectRoot)).workspace?.store ?? null) === null) return null;
  const seen = await seenScopes(projectRoot);
  return { base: seen.store.base, sync: Boolean(seen.store.sync) };
}
export {
  ARTIFACT_CONTENT_MAX,
  ARTIFACT_TOOLS,
  ArtifactError,
  GET_ARTIFACT_SCHEMA,
  UPDATE_ARTIFACT_SCHEMA,
  acceptArtifactVersions,
  acceptLinkedAdrs,
  ambiguousApprovalMessage,
  answerArtifactApproval,
  appliedArtifactAction,
  appliedArtifactActions,
  applyStoreRun,
  approvalGatesWithIds,
  artifactApprovalGates,
  artifactAtLocation,
  artifactStoreLocation,
  artifactText,
  artifactVersion,
  collidingPath,
  commentOnArtifact,
  createMovedArtifacts,
  getArtifact,
  initiativeArtifactStanding,
  linkedAdrProblems,
  pathIndex,
  pendingApprovalGates,
  readStoreArtifact,
  readStoreArtifactAt,
  recordMovedStatus,
  reviewStoreArtifact,
  reviewStoreArtifactAt,
  seenArtifactTexts,
  seenArtifacts,
  storeArtifactCopy,
  storeArtifactFile,
  storeArtifactLocation,
  storeArtifactPaths,
  storeArtifactStatuses,
  storeArtifactTarget,
  storeSyncBase,
  storedArtifactIn,
  unlinkedAdrs,
  updateArtifact,
  versionChanges,
  workspaceArtifacts,
  writeMovedView,
  writeStoreArtifact
};
