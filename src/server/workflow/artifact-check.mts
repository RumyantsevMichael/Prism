import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, adrStatusOf, glossarySources, inspectArtifact, requirementOutline } from "./artifact-formats.mjs";
import { artifactAddress } from "./artifact-paths.mjs";
import { readComponents } from "./components.mjs";
import { artifactText, seenArtifactTexts } from "./store-artifacts.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";

// check_artifacts: lists the configured artifacts, or types the given paths, and checks each against its format.

export const MAX_CHECK_PATHS = 500;
const MAX_DEPTH = 4;

export class ArtifactCheckError extends Error {
  declare code: any;
  // The details a refusal carries, such as its artifacts.
  [key: string]: any;
  constructor(code: any, message: any, details = {}) {
    super(message);
    this.name = "ArtifactCheckError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: any, message: any, details?: any) => new ArtifactCheckError(code, message, details);

/** The configured location of each artifact type: a folder with an extension, or one file; types the configuration turns off are left out. */
export function artifactLocations(config: any) {
  const locations = [];
  if (config.paths.requirements !== null) locations.push({ type: "requirements", folder: config.paths.requirements, extension: ".md" });
  if (config.paths.adrs !== null) locations.push({ type: "adr", folder: config.paths.adrs, extension: ".md" });
  if (config.paths.glossary !== null) locations.push({ type: "glossary", file: config.paths.glossary });
  if (config.paths.features !== null) locations.push({ type: "feature", folder: config.paths.features, extension: ".feature" });
  return locations;
}

const within = (folder: any, file: any) => folder === "" || file.startsWith(`${folder}/`);

/** The artifact type of a project-relative path, by the configured location it lies under, or null. */
export function artifactTypeOf(locations: any, file: any) {
  const exact = locations.find((location: any) => location.file === file);
  if (exact) return exact.type;
  const folders = locations.filter((location: any) => location.folder !== undefined && within(location.folder, file)).sort((a: any, b: any) => b.folder.length - a.folder.length);
  return folders[0]?.type ?? null;
}

/** The artifact type of a path that a listing of the project's artifacts would hold, by its configured location and that listing's depth and name rules, or null. */
export function listedArtifactType(locations: any, file: any) {
  const type = artifactTypeOf(locations, file);
  const location = type === null ? undefined : locations.find((entry: any) => entry.type === type);
  return location !== undefined && listed(location, file) ? type : null;
}

async function walk(root: any, folder: any, extension: any, depth: any, found: any) {
  let entries;
  try {
    entries = await readdir(path.join(root, folder), { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = folder === "" ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(root, file, extension, depth + 1, found);
    } else if (entry.isFile() && entry.name.endsWith(extension) && entry.name !== "README.md") found.push(file);
  }
}

/** Every configured artifact of the project: [{ path, type }]. */
export async function listArtifacts(root: any, locations: any, type: any) {
  const found = [];
  for (const location of locations) {
    if (type && location.type !== type) continue;
    if (location.file !== undefined) {
      const info = await stat(path.join(root, location.file)).catch(() => null);
      if (info?.isFile()) found.push({ path: location.file, type: location.type });
      continue;
    }
    const files: any[] = [];
    await walk(root, location.folder, location.extension, 0, files);
    for (const file of files) if (artifactTypeOf(locations, file) === location.type) found.push({ path: file, type: location.type });
  }
  return found;
}

function normalized(file: any) {
  if (typeof file !== "string" || file === "" || file.length > 1024) throw fail("invalid_input", "Each path must be a project-relative file path.");
  const value = path.posix.normalize(file.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value === ".." || value.startsWith("../") || value === ".") throw fail("invalid_input", `The path ${file} must be relative to the project root and stay inside it.`, { path: file });
  return value;
}

// Glossary sources resolve from the glossary's folder to requirement sections, ADRs, and migrations.
// lookup(file) gives the source file's { text, status } where the glossary reads it, or { reason } when it reads none, with status null for a status written in the file.
function sourceResolver(glossaryPath: any, lookup: any, appliedMigration: any) {
  const found = new Map();
  return {
    async prepare(sources: any) {
      for (const source of sources) {
        if (source.kind === "migration") continue;
        const file = targetFile(glossaryPath, source.target);
        if (file === null || found.has(file)) continue;
        found.set(file, await lookup(file));
      }
    },
    resolve(source: any) {
      if (source.kind === "migration") {
        if (source.id && appliedMigration(source.id)) return { decided: true, inForce: true, reason: "applied migration" };
        return { decided: false, reason: "a migration that was not applied" };
      }
      const file = targetFile(glossaryPath, source.target);
      const held = file === null ? { reason: "missing" } : found.get(file) ?? { reason: "missing" };
      if (held.text === undefined || held.text === null) return { decided: false, reason: held.reason ?? "missing" };
      const { text } = held;
      if (source.kind === "adr") {
        const status = held.status ?? adrStatusOf(text) ?? "";
        if (status === "Accepted") return { decided: true, inForce: true, reason: "Accepted" };
        if (status.startsWith("Superseded")) return { decided: true, inForce: false, reason: "Superseded" };
        return { decided: false, reason: status.split(" ")[0] || "no status" };
      }
      const outline = requirementOutline(text);
      const number = Number(source.target.split("#")[1]);
      const section = outline.sections.find((entry: any) => entry.number === number);
      const status = held.status ?? outline.status ?? "";
      if (!section) return { decided: false, reason: "missing" };
      if (status === "Approved") {
        const disposition = section.disposition ?? "";
        if (disposition === "Active") return { decided: true, inForce: true, reason: "Active" };
        return { decided: true, inForce: false, reason: disposition.startsWith("Superseded") ? "Superseded" : disposition.startsWith("Withdrawn") ? "Withdrawn" : disposition || "no disposition" };
      }
      if (status === "Withdrawn") return { decided: true, inForce: false, reason: "Withdrawn" };
      if (status.startsWith("Superseded")) return { decided: true, inForce: false, reason: "Superseded" };
      return { decided: false, reason: status.split(" ")[0] || "no status" };
    }
  };
}

function targetFile(glossaryPath: any, target: any) {
  const file = target.split("#")[0];
  if (!file) return null;
  let decoded = file;
  try { decoded = decodeURI(file); } catch { /* A malformed escape stays as written. */ }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(glossaryPath), decoded));
  return joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined) ? null : joined;
}

const textOf = (input: any) => typeof input === "string" ? input : Buffer.from(input).toString("utf8");

// The sources that a glossary text cites, so that the resolver finds their files before the synchronous check runs.
async function glossaryContext(file: any, input: any, lookup: any, appliedMigration: any) {
  const resolver = sourceResolver(file, lookup, appliedMigration);
  const sources = [...textOf(input).matchAll(/^Source:\s*(.*?)\s*$/gm)].flatMap((match) => glossarySources(match[1]) ?? []);
  await resolver.prepare(sources);
  return { resolveSource: (source: any) => resolver.resolve(source) };
}

// A source file of a checkout glossary, read from the checkout.
const checkoutLookup = (root: any) => async (file: any) => {
  const text = await readFile(path.join(root, file), "utf8").catch(() => null);
  return text === null ? { reason: "missing" } : { text, status: null };
};

// The scopes a glossary's sources resolve in, nearest first: its own scope, then its repository's for a component, then the workspace.
function scopeChain(scope: any) {
  if (scope.kind === "workspace") return ["workspace"];
  if (scope.kind === "repository") return [scope.label, "workspace"];
  return [scope.label, scope.repository, "workspace"];
}

// A source file of a store glossary: the copy in the glossary's own scope, else in the nearest scope above it, with its recorded status, or the reason it counts as undecided.
const storeLookup = (scope: any, copiesOf: any) => async (file: any) => {
  const copies = await copiesOf(file);
  const chain = scopeChain(scope);
  for (const label of chain) {
    const copy = copies.find((entry: any) => entry.scope.label === label);
    if (!copy) continue;
    const text = copy.bytes === null ? null : artifactText(copy.bytes);
    return text === null ? { reason: "not readable as text" } : { text, status: copy.status };
  }
  if (copies.length === 0) return { reason: "missing" };
  const holders = copies.map((entry: any) => entry.scope.label).sort();
  return { reason: `outside the glossary's scope ${scope.label}, held only in scope ${holders.join(", ")}` };
};

const SCOPE_KINDS = new Set(["workspace", "repository", "component"]);
const STORE_TYPES = new Map([["requirements", "requirements"], ["adrs", "adr"], ["glossary", "glossary"]]);
const compare = (left: any, right: any) => left < right ? -1 : left > right ? 1 : 0;
const labelOf = (entry: any) => entry.scope === null ? "" : entry.scope.label;

// A path entry of paths: { file, scope, component }, from a path or { path, scope, component }.
function pathEntry(given: any) {
  if (typeof given === "string") return { file: normalized(given) };
  if (given === null || typeof given !== "object" || Array.isArray(given)) throw fail("invalid_input", "Each entry of paths must be a project-relative path or { path, scope, component }.");
  const extra = Object.keys(given).filter((key) => !["path", "scope", "component"].includes(key));
  if (extra.length) throw fail("invalid_input", `A paths entry takes only path, scope, and component, not ${extra.join(", ")}.`);
  if (given.scope !== undefined && typeof given.scope !== "string") throw fail("scope_invalid", "scope must be \"workspace\", \"repository\", or \"component\".", { path: given.path });
  if (given.component !== undefined && typeof given.component !== "string") throw fail("component_unknown", "component must name a component that ## Components in .prism/workflow.md declares.", { path: given.path });
  return { file: normalized(given.path), scope: given.scope, component: given.component };
}

// The scope label that a scope input names for this checkout, refusing a scope that is not one, or a component that the configuration does not declare.
function namedLabel(config: any, repository: any, { file, scope, component }: any) {
  if (!SCOPE_KINDS.has(scope)) throw fail("scope_invalid", `${JSON.stringify(scope)} is no scope: scope is "workspace", "repository" for this checkout's repository, or "component" with component naming a declared component.`, { path: file });
  if (scope !== "component") {
    if (component !== undefined) throw fail("scope_invalid", `component applies only with scope "component", not with scope ${JSON.stringify(scope)}.`, { path: file });
    return scope === "workspace" ? "workspace" : repository;
  }
  const declared = readComponents(config).declared.map((entry) => entry.name);
  if (component === undefined || !declared.includes(component)) {
    throw fail("component_unknown", `${component === undefined ? "Scope \"component\" names no component" : `${JSON.stringify(component)} is no component`} of this repository: ## Components in .prism/workflow.md declares ${declared.length ? declared.join(", ") : "none"}.`, { path: file, components: declared });
  }
  return `${repository}/${component}`;
}

// The depth and name rules of a listing, applied to a path below its configured folder.
function listed(location: any, file: any) {
  if (location.file !== undefined) return location.file === file;
  if (!file.endsWith(location.extension) || path.posix.basename(file) === "README.md") return false;
  const rest = location.folder === "" ? file : file.slice(location.folder.length + 1);
  return rest.split("/").length - 1 <= MAX_DEPTH;
}

// The store's refusals reach the caller as check refusals with the same code, message, and details.
async function storeRefusing(action: any) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ArtifactCheckError) throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components", "key", "folder"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
    }
    throw error;
  }
}

/**
 * Checks the project's artifacts: { formats, artifacts }.
 * In a project with a record store, requirements, ADRs, and glossaries are read from every scope the checkout sees, and feature files from the checkout.
 * `appliedMigration(id)` returns whether a format migration was applied, by default as the project's migration records say.
 * Each artifact carries `migration`, the state of the latest format migration run whose set holds it at its current version, and the check starts a run for each new set apart from itself unless startRuns is false.
 */
export async function checkArtifacts({ projectRoot, paths, type, appliedMigration, startRuns = true }: any) {
  const { root, store, targets } = await resolveArtifacts({ projectRoot, paths, type });
  const artifacts = await checkTargets(root, store, targets, { appliedMigration, startRuns, complete: paths === undefined && type === undefined });
  return { formats: ARTIFACT_FORMATS.map((entry) => ({ type: entry.type, version: entry.version, reference: entry.reference })), artifacts };
}

/**
 * The artifacts that a check names, refused as check_artifacts refuses them: { root, store, targets }, with targets as checkTargets takes them,
 * every configured artifact without paths, else the artifacts that paths name.
 */
export async function resolveArtifacts({ projectRoot, paths, type }: any) {
  if (type !== undefined && !ARTIFACT_TYPES.includes(type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS)) throw fail("invalid_input", `paths must be a list of at most ${MAX_CHECK_PATHS} project-relative files or { path, scope, component } entries.`);
  const root = await realpath(projectRoot);
  const entries = paths === undefined ? null : paths.map(pathEntry);
  const { config, locations, store, storeType } = await artifactSources(root);
  let targets;
  if (entries === null) {
    targets = (await listArtifacts(root, locations, type)).filter((entry) => storeType(entry.path) === null).map((entry): any => ({ ...entry, scope: null }));
    if (store !== null) {
      for (const artifact of store.artifacts) {
        const artifactType = STORE_TYPES.get(artifact.kind);
        if ((type && artifactType !== type) || listedArtifactType(locations, artifact.path) !== artifactType) continue;
        targets.push({ path: artifact.path, type: artifactType, scope: artifact.scope, stored: artifact });
      }
    }
  } else {
    targets = [];
    const seen = new Set();
    for (const entry of entries) {
      const { file } = entry;
      const artifactType = artifactTypeOf(locations, file);
      if (artifactType === null) throw fail("artifact_type_unknown", `The path ${file} lies under none of the configured Requirements, ADRs, Glossary, or Feature files paths.`, { path: file });
      const inStore = store !== null && storeType(file) === artifactType;
      if (entry.scope !== undefined || entry.component !== undefined) {
        if (store === null) throw fail("scope_invalid", `The path ${file} is a checkout file: this project's .prism/workflow.md names no record store, so a paths entry takes no scope.`, { path: file });
        if (!inStore) throw fail("scope_invalid", `The path ${file} is a checkout file, since feature files stay in the checkout, so a paths entry takes no scope for it.`, { path: file });
        if (entry.scope === undefined) throw fail("scope_invalid", "component names a component scope, so it needs scope \"component\".", { path: file });
      }
      let found;
      if (inStore) {
        const copies = store.artifacts.filter((artifact: any) => artifact.path === file);
        if (entry.scope !== undefined) {
          const label = namedLabel(config, store.repository, entry);
          const copy = copies.find((artifact: any) => artifact.scope.label === label);
          if (!copy) throw fail("artifact_missing", `The scope ${label} holds no artifact ${file} in the record store.`, { path: file });
          found = [copy];
        } else {
          if (copies.length > 1) {
            const scopes = copies.map((artifact: any) => artifact.scope.label);
            throw fail("artifact_ambiguous", `The artifact ${file} is held by more than one scope this checkout sees (${scopes.join(", ")}): name its scope as { path, scope, component }, with scope "workspace", "repository", or "component" and component.`, { path: file, scopes });
          }
          if (copies.length === 0) throw fail("artifact_missing", `No scope this checkout sees holds the artifact ${file} in the record store.`, { path: file });
          found = copies;
        }
        found = found.map((artifact: any) => ({ path: file, type: artifactType, scope: artifact.scope, stored: artifact }));
      } else {
        const info = await stat(path.join(root, file)).catch(() => null);
        if (!info?.isFile()) throw fail("artifact_missing", `The artifact ${file} does not exist.`, { path: file });
        found = [{ path: file, type: artifactType, scope: null }];
      }
      if (type && artifactType !== type) continue;
      for (const target of found) {
        const key = `${labelOf(target)}\0${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(target);
      }
    }
  }
  return { root, store, targets };
}

/** The bytes of a resolved artifact, as checkTargets reads them. */
export const targetBytes = async (root: any, target: any) => target.stored ? target.stored.bytes ?? oversized(target.stored.size) : await readFile(path.join(root, target.path));

/** The version of an artifact's bytes, as get_artifact names it. */
export const contentVersion = (bytes: any) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The project's artifact store reads that a check of named artifacts needs: { config, locations, store, storeType },
 * refusing as checkTargets takes it, where store is what seenArtifactTexts gives in a project with a record store, limited to paths when they are given, else null, and storeType(path) the format type of a path that the store holds, else null.
 */
export async function artifactSources(root: any, { refusing = storeRefusing, paths = null }: any = {}) {
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  const store = (config.workspace?.store ?? null) !== null ? await refusing(() => seenArtifactTexts(root, { paths })) : null;
  const storeType = (file: any) => {
    const kind = store === null ? null : storeKindOf(config, file);
    return kind === null ? null : STORE_TYPES.get(kind) ?? null;
  };
  return { config, locations, store, storeType };
}

/**
 * Checks resolved artifacts, each { path, type, scope, stored }, with stored the store's entry of a store artifact, in clause order of type, then path, then scope label:
 * the artifacts as check_artifacts lists them. `appliedMigration` defaults to the project's applied format migrations,
 * and `refusing` turns the store's refusals into check refusals by default, while a caller that passes the store's own refusals on gives `(action) => action()`.
 */
export async function checkTargets(root: any, store: any, targets: any, { appliedMigration, refusing = storeRefusing, startRuns = true, complete = false }: any = {}) {
  // A migration <id> source is decided once that format migration's run applied it, whichever checkout applied it, as the project's run records say.
  const { allRuns, appliedMigrationIds, migrationStates, startMigrationRuns } = await import("./migration-runs.mjs");
  if (appliedMigration === undefined) {
    const applied = await refusing(() => appliedMigrationIds(root));
    appliedMigration = (id: any) => applied.has(id);
  }
  const order = (entry: any) => ARTIFACT_TYPES.indexOf(entry.type);
  targets = [...targets].sort((a, b) => order(a) - order(b) || compare(a.path, b.path) || compare(labelOf(a), labelOf(b)));
  // The findings that agents reported, each against the version of the artifact it was reported on.
  const { reportedFindings } = await import("./format-findings.mjs");
  const reported = targets.length ? await refusing(() => reportedFindings(root)) : new Map();
  const artifacts = [];
  const versions: any[] = [];
  for (const target of targets) {
    const bytes = await targetBytes(root, target);
    versions.push(contentVersion(bytes));
    let result;
    if (target.type === "glossary") {
      // A glossary's findings depend on the files its sources name, so it is checked afresh each time.
      const lookup = target.stored ? storeLookup(target.scope, store.copiesOf) : checkoutLookup(root);
      const context = await refusing(() => glossaryContext(target.path, bytes, lookup, appliedMigration));
      result = inspectArtifact(target.type, bytes, { context });
    } else {
      result = inspected(target, bytes);
    }
    const own = reported.get(reportedKey(target.path, target.scope, contentVersion(bytes))) ?? [];
    if (own.length) result = { ...result, conforms: false, findings: [...result.findings, ...own] };
    artifacts.push({ path: target.path, scope: target.scope, type: target.type, version: result.version, conforms: result.conforms, findings: result.findings, unknowns: result.unknowns, earlierFormat: result.earlierFormat, migration: null });
  }
  if (!artifacts.length) return artifacts;
  const checked = artifacts.map((artifact, index) => ({ ...artifact, formatVersion: artifact.version, version: versions[index] }));
  const states = migrationStates(await refusing(() => allRuns(root)), checked);
  for (const [index, state] of states.entries()) artifacts[index].migration = state;
  // A set holds every nonconforming artifact of its type and scope, so a check of some artifacts starts runs from a check of all of them, apart from itself.
  // The runs are recorded before the check returns, and their confirmation with a store's remote and their sessions follow apart from it.
  if (startRuns && complete) {
    const started = await startMigrationRuns(root, checked);
    if (started.length) for (const [index, state] of migrationStates(started, checked).entries()) if (state) artifacts[index].migration = state;
  } else if (startRuns && checked.some((artifact) => !artifact.conforms && artifact.type !== "feature")) {
    await checkArtifacts({ projectRoot: root }).catch(() => {});
    const states = migrationStates(await refusing(() => allRuns(root)), checked);
    for (const [index, state] of states.entries()) artifacts[index].migration = state;
  }
  return artifacts;
}

/** The key of an artifact version's reported findings: its scope label, path, and version. */
export const reportedKey = (file: any, scope: any, version: any) => `${scope === null || scope === undefined ? "" : scope.label}\0${file}\0${version}`;

/**
 * Checks the content that a write would leave at a requirement, ADR, or glossary path against the current format, as check_artifacts would check it:
 * status is the recorded status the write leaves for a store requirement or ADR, or null to read the Status: line,
 * and lookup(file) gives a glossary source's { text, status } or { reason } as the whole write leaves it, from the glossary's own scope.
 * appliedMigration(id) says whether a format migration was applied, and unknownAside leaves unknown values aside, as a format migration's content is checked.
 * Returns { conforms, findings, unknowns }.
 */
export async function checkArtifactContent({ path: file, type, bytes, status = null, lookup = null, appliedMigration = () => false, unknownAside = false }: any) {
  let context = { status, ...(unknownAside ? { proposal: true } : {}) };
  if (type === "glossary" && lookup !== null) context = { ...context, ...await glossaryContext(file, bytes, lookup, appliedMigration) };
  const { conforms, findings, unknowns } = inspectArtifact(type, bytes, { context });
  return { conforms, findings, unknowns };
}

/** The lookup of a checkout glossary's sources, read from the checkout at root. */
export const checkoutSourceLookup = (root: any) => checkoutLookup(root);

/** The lookup of a store glossary's sources in the scope chain of its scope, over copiesOf(file), which lists { scope, bytes, status } for each copy. */
export const storeSourceLookup = (scope: any, copiesOf: any) => storeLookup(scope, copiesOf);

// The checks of artifacts whose findings depend on their bytes alone, by scope and path, each kept with the hash of the version it checked,
// so a listing of many artifacts checks again only those that changed since the last listing.
const CHECKED_MAX = 20000;
const checked = new Map();

function inspected(target: any, bytes: any) {
  // The unknown rule reads the recorded status of a store requirement or ADR, so the status is part of what a check is kept by.
  const status = target.stored?.status ?? null;
  const key = `${target.type}\0${labelOf(target)}\0${target.path}`;
  const version = `${createHash("sha256").update(bytes).digest("hex")}\0${status ?? ""}`;
  const hit = checked.get(key);
  if (hit && hit.version === version) return hit.result;
  const result = inspectArtifact(target.type, bytes, { context: { status } });
  if (checked.size >= CHECKED_MAX) checked.delete(checked.keys().next().value);
  checked.set(key, { version, result });
  return result;
}

// A store file above the bound a read takes is checked as bytes of its size, which breaks the text rule of every format.
const oversized = (size: any) => Buffer.alloc(Math.min(size, 1024 * 1024 + 1), 0x20);

// The store kind of a project-relative path, by the configured artifact kinds, or null for a path that stays in the checkout.
function storeKindOf(config: any, file: any) {
  return artifactAddress(artifactKinds(config), file)?.kind ?? null;
}
