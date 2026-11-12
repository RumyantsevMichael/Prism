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
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactCheckError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new ArtifactCheckError(code, message, details);

/** The configured location of each artifact type: a folder with an extension, or one file; types the configuration turns off are left out. */
export function artifactLocations(config) {
  const locations = [];
  if (config.paths.requirements !== null) locations.push({ type: "requirements", folder: config.paths.requirements, extension: ".md" });
  if (config.paths.adrs !== null) locations.push({ type: "adr", folder: config.paths.adrs, extension: ".md" });
  if (config.paths.glossary !== null) locations.push({ type: "glossary", file: config.paths.glossary });
  if (config.paths.features !== null) locations.push({ type: "feature", folder: config.paths.features, extension: ".feature" });
  return locations;
}

const within = (folder, file) => folder === "" || file.startsWith(`${folder}/`);

/** The artifact type of a project-relative path, by the configured location it lies under, or null. */
export function artifactTypeOf(locations, file) {
  const exact = locations.find((location) => location.file === file);
  if (exact) return exact.type;
  const folders = locations.filter((location) => location.folder !== undefined && within(location.folder, file)).sort((a, b) => b.folder.length - a.folder.length);
  return folders[0]?.type ?? null;
}

async function walk(root, folder, extension, depth, found) {
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
export async function listArtifacts(root, locations, type) {
  const found = [];
  for (const location of locations) {
    if (type && location.type !== type) continue;
    if (location.file !== undefined) {
      const info = await stat(path.join(root, location.file)).catch(() => null);
      if (info?.isFile()) found.push({ path: location.file, type: location.type });
      continue;
    }
    const files = [];
    await walk(root, location.folder, location.extension, 0, files);
    for (const file of files) if (artifactTypeOf(locations, file) === location.type) found.push({ path: file, type: location.type });
  }
  return found;
}

function normalized(file) {
  if (typeof file !== "string" || file === "" || file.length > 1024) throw fail("invalid_input", "Each path must be a project-relative file path.");
  const value = path.posix.normalize(file.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value === ".." || value.startsWith("../") || value === ".") throw fail("invalid_input", `The path ${file} must be relative to the project root and stay inside it.`, { path: file });
  return value;
}

// Glossary sources resolve from the glossary's folder to requirement sections, ADRs, and migrations.
// lookup(file) gives the source file's { text, status } where the glossary reads it, or { reason } when it reads none, with status null for a status written in the file.
function sourceResolver(glossaryPath, lookup, appliedMigration) {
  const found = new Map();
  return {
    async prepare(sources) {
      for (const source of sources) {
        if (source.kind === "migration") continue;
        const file = targetFile(glossaryPath, source.target);
        if (file === null || found.has(file)) continue;
        found.set(file, await lookup(file));
      }
    },
    resolve(source) {
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
      const section = outline.sections.find((entry) => entry.number === number);
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

function targetFile(glossaryPath, target) {
  const file = target.split("#")[0];
  if (!file) return null;
  let decoded = file;
  try { decoded = decodeURI(file); } catch { /* A malformed escape stays as written. */ }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(glossaryPath), decoded));
  return joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined) ? null : joined;
}

const textOf = (input) => typeof input === "string" ? input : Buffer.from(input).toString("utf8");

// The sources that a glossary text cites, so that the resolver finds their files before the synchronous check runs.
async function glossaryContext(file, input, lookup, appliedMigration) {
  const resolver = sourceResolver(file, lookup, appliedMigration);
  const sources = [...textOf(input).matchAll(/^Source:\s*(.*?)\s*$/gm)].flatMap((match) => glossarySources(match[1]) ?? []);
  await resolver.prepare(sources);
  return { resolveSource: (source) => resolver.resolve(source) };
}

// A source file of a checkout glossary, read from the checkout.
const checkoutLookup = (root) => async (file) => {
  const text = await readFile(path.join(root, file), "utf8").catch(() => null);
  return text === null ? { reason: "missing" } : { text, status: null };
};

// The scopes a glossary's sources resolve in, nearest first: its own scope, then its repository's for a component, then the workspace.
function scopeChain(scope) {
  if (scope.kind === "workspace") return ["workspace"];
  if (scope.kind === "repository") return [scope.label, "workspace"];
  return [scope.label, scope.repository, "workspace"];
}

// A source file of a store glossary: the copy in the glossary's own scope, else in the nearest scope above it, with its recorded status, or the reason it counts as undecided.
const storeLookup = (scope, copiesOf) => async (file) => {
  const copies = await copiesOf(file);
  const chain = scopeChain(scope);
  for (const label of chain) {
    const copy = copies.find((entry) => entry.scope.label === label);
    if (!copy) continue;
    const text = copy.bytes === null ? null : artifactText(copy.bytes);
    return text === null ? { reason: "not readable as text" } : { text, status: copy.status };
  }
  if (copies.length === 0) return { reason: "missing" };
  const holders = copies.map((entry) => entry.scope.label).sort();
  return { reason: `outside the glossary's scope ${scope.label}, held only in scope ${holders.join(", ")}` };
};

const SCOPE_KINDS = new Set(["workspace", "repository", "component"]);
const STORE_TYPES = new Map([["requirements", "requirements"], ["adrs", "adr"], ["glossary", "glossary"]]);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const labelOf = (entry) => entry.scope === null ? "" : entry.scope.label;

// A path entry of paths: { file, scope, component }, from a path or { path, scope, component }.
function pathEntry(given) {
  if (typeof given === "string") return { file: normalized(given) };
  if (given === null || typeof given !== "object" || Array.isArray(given)) throw fail("invalid_input", "Each entry of paths must be a project-relative path or { path, scope, component }.");
  const extra = Object.keys(given).filter((key) => !["path", "scope", "component"].includes(key));
  if (extra.length) throw fail("invalid_input", `A paths entry takes only path, scope, and component, not ${extra.join(", ")}.`);
  if (given.scope !== undefined && typeof given.scope !== "string") throw fail("scope_invalid", "scope must be \"workspace\", \"repository\", or \"component\".", { path: given.path });
  if (given.component !== undefined && typeof given.component !== "string") throw fail("component_unknown", "component must name a component that ## Components in .prism/workflow.md declares.", { path: given.path });
  return { file: normalized(given.path), scope: given.scope, component: given.component };
}

// The scope label that a scope input names for this checkout, refusing a scope that is not one, or a component that the configuration does not declare.
function namedLabel(config, repository, { file, scope, component }) {
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

// The depth and name rules of a listing, applied to a store artifact's path below its configured folder.
function listed(location, file) {
  if (location.file !== undefined) return location.file === file;
  if (!file.endsWith(location.extension) || path.posix.basename(file) === "README.md") return false;
  const rest = location.folder === "" ? file : file.slice(location.folder.length + 1);
  return rest.split("/").length - 1 <= MAX_DEPTH;
}

// The store's refusals reach the caller as check refusals with the same code, message, and details.
async function storeRefusing(action) {
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
 * `legacyOf(path, type, scope)` returns the legacy mark that covers an artifact, and `appliedMigration(id)` whether a migration was applied; both default to none.
 */
export async function checkArtifacts({ projectRoot, paths, type, legacyOf = () => null, appliedMigration = () => false }) {
  if (type !== undefined && !ARTIFACT_TYPES.includes(type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS)) throw fail("invalid_input", `paths must be a list of at most ${MAX_CHECK_PATHS} project-relative files or { path, scope, component } entries.`);
  const root = await realpath(projectRoot);
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  const entries = paths === undefined ? null : paths.map(pathEntry);
  const store = (config.workspace?.store ?? null) !== null ? await storeRefusing(() => seenArtifactTexts(root)) : null;
  const storeType = (file) => {
    const kind = store === null ? null : storeKindOf(config, file);
    return kind === null ? null : STORE_TYPES.get(kind) ?? null;
  };
  let targets;
  if (entries === null) {
    targets = (await listArtifacts(root, locations, type)).filter((entry) => storeType(entry.path) === null).map((entry) => ({ ...entry, scope: null }));
    if (store !== null) {
      for (const artifact of store.artifacts) {
        const artifactType = STORE_TYPES.get(artifact.kind);
        const location = locations.find((entry) => entry.type === artifactType);
        if (!location || (type && artifactType !== type) || artifactTypeOf(locations, artifact.path) !== artifactType || !listed(location, artifact.path)) continue;
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
        const copies = store.artifacts.filter((artifact) => artifact.path === file);
        if (entry.scope !== undefined) {
          const label = namedLabel(config, store.repository, entry);
          const copy = copies.find((artifact) => artifact.scope.label === label);
          if (!copy) throw fail("artifact_missing", `The scope ${label} holds no artifact ${file} in the record store.`, { path: file });
          found = [copy];
        } else {
          if (copies.length > 1) {
            const scopes = copies.map((artifact) => artifact.scope.label);
            throw fail("artifact_ambiguous", `The artifact ${file} is held by more than one scope this checkout sees (${scopes.join(", ")}): name its scope as { path, scope, component }, with scope "workspace", "repository", or "component" and component.`, { path: file, scopes });
          }
          if (copies.length === 0) throw fail("artifact_missing", `No scope this checkout sees holds the artifact ${file} in the record store.`, { path: file });
          found = copies;
        }
        found = found.map((artifact) => ({ path: file, type: artifactType, scope: artifact.scope, stored: artifact }));
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
  const order = (entry) => ARTIFACT_TYPES.indexOf(entry.type);
  targets.sort((a, b) => order(a) - order(b) || compare(a.path, b.path) || compare(labelOf(a), labelOf(b)));
  const artifacts = [];
  for (const target of targets) {
    const bytes = target.stored ? target.stored.bytes ?? oversized(target.stored.size) : await readFile(path.join(root, target.path));
    const lookup = target.stored ? storeLookup(target.scope, store.copiesOf) : checkoutLookup(root);
    const context = target.type === "glossary" ? await storeRefusing(() => glossaryContext(target.path, bytes, lookup, appliedMigration)) : {};
    const result = inspectArtifact(target.type, bytes, { context });
    const legacy = result.conforms ? null : legacyOf(target.path, target.type, target.scope) ?? null;
    artifacts.push({ path: target.path, scope: target.scope, type: target.type, version: result.version, conforms: result.conforms, findings: result.findings, unknowns: result.unknowns, earlierFormat: result.earlierFormat, legacy });
  }
  return { formats: ARTIFACT_FORMATS.map((entry) => ({ type: entry.type, version: entry.version, reference: entry.reference })), artifacts };
}

// A store file above the bound a read takes is checked as bytes of its size, which breaks the text rule of every format.
const oversized = (size) => Buffer.alloc(Math.min(size, 1024 * 1024 + 1), 0x20);

// The store kind of a project-relative path, by the configured artifact kinds, or null for a path that stays in the checkout.
function storeKindOf(config, file) {
  return artifactAddress(artifactKinds(config), file)?.kind ?? null;
}
