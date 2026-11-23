// Generated from src/server/workflow/artifact-check.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, adrStatusOf, glossarySources, inspectArtifact, requirementOutline } from "./artifact-formats.mjs";
import { artifactAddress } from "./artifact-paths.mjs";
import { readComponents } from "./components.mjs";
import { artifactText, seenArtifactTexts } from "./store-artifacts.mjs";
import { artifactKinds, readWorkflowConfig } from "./workflow-config.mjs";
const MAX_CHECK_PATHS = 500;
const MAX_DEPTH = 4;
class ArtifactCheckError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactCheckError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new ArtifactCheckError(code, message, details);
function artifactLocations(config) {
  const locations = [];
  if (config.paths.requirements !== null) locations.push({ type: "requirements", folder: config.paths.requirements, extension: ".md" });
  if (config.paths.adrs !== null) locations.push({ type: "adr", folder: config.paths.adrs, extension: ".md" });
  if (config.paths.glossary !== null) locations.push({ type: "glossary", file: config.paths.glossary });
  if (config.paths.features !== null) locations.push({ type: "feature", folder: config.paths.features, extension: ".feature" });
  return locations;
}
const within = (folder, file) => folder === "" || file.startsWith(`${folder}/`);
function artifactTypeOf(locations, file) {
  const exact = locations.find((location) => location.file === file);
  if (exact) return exact.type;
  const folders = locations.filter((location) => location.folder !== void 0 && within(location.folder, file)).sort((a, b) => b.folder.length - a.folder.length);
  return folders[0]?.type ?? null;
}
function listedArtifactType(locations, file) {
  const type = artifactTypeOf(locations, file);
  const location = type === null ? void 0 : locations.find((entry) => entry.type === type);
  return location !== void 0 && listed(location, file) ? type : null;
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
async function listArtifacts(root, locations, type) {
  const found = [];
  for (const location of locations) {
    if (type && location.type !== type) continue;
    if (location.file !== void 0) {
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
function sourceResolver(glossaryPath, lookup, appliedMigration) {
  const found = /* @__PURE__ */ new Map();
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
      if (held.text === void 0 || held.text === null) return { decided: false, reason: held.reason ?? "missing" };
      const { text } = held;
      if (source.kind === "adr") {
        const status2 = held.status ?? adrStatusOf(text) ?? "";
        if (status2 === "Accepted") return { decided: true, inForce: true, reason: "Accepted" };
        if (status2.startsWith("Superseded")) return { decided: true, inForce: false, reason: "Superseded" };
        return { decided: false, reason: status2.split(" ")[0] || "no status" };
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
  try {
    decoded = decodeURI(file);
  } catch {
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(glossaryPath), decoded));
  return joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined) ? null : joined;
}
const textOf = (input) => typeof input === "string" ? input : Buffer.from(input).toString("utf8");
async function glossaryContext(file, input, lookup, appliedMigration) {
  const resolver = sourceResolver(file, lookup, appliedMigration);
  const sources = [...textOf(input).matchAll(/^Source:\s*(.*?)\s*$/gm)].flatMap((match) => glossarySources(match[1]) ?? []);
  await resolver.prepare(sources);
  return { resolveSource: (source) => resolver.resolve(source) };
}
const checkoutLookup = (root) => async (file) => {
  const text = await readFile(path.join(root, file), "utf8").catch(() => null);
  return text === null ? { reason: "missing" } : { text, status: null };
};
function scopeChain(scope) {
  if (scope.kind === "workspace") return ["workspace"];
  if (scope.kind === "repository") return [scope.label, "workspace"];
  return [scope.label, scope.repository, "workspace"];
}
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
const SCOPE_KINDS = /* @__PURE__ */ new Set(["workspace", "repository", "component"]);
const STORE_TYPES = /* @__PURE__ */ new Map([["requirements", "requirements"], ["adrs", "adr"], ["glossary", "glossary"]]);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const labelOf = (entry) => entry.scope === null ? "" : entry.scope.label;
function pathEntry(given) {
  if (typeof given === "string") return { file: normalized(given) };
  if (given === null || typeof given !== "object" || Array.isArray(given)) throw fail("invalid_input", "Each entry of paths must be a project-relative path or { path, scope, component }.");
  const extra = Object.keys(given).filter((key) => !["path", "scope", "component"].includes(key));
  if (extra.length) throw fail("invalid_input", `A paths entry takes only path, scope, and component, not ${extra.join(", ")}.`);
  if (given.scope !== void 0 && typeof given.scope !== "string") throw fail("scope_invalid", 'scope must be "workspace", "repository", or "component".', { path: given.path });
  if (given.component !== void 0 && typeof given.component !== "string") throw fail("component_unknown", "component must name a component that ## Components in .prism/workflow.md declares.", { path: given.path });
  return { file: normalized(given.path), scope: given.scope, component: given.component };
}
function namedLabel(config, repository, { file, scope, component }) {
  if (!SCOPE_KINDS.has(scope)) throw fail("scope_invalid", `${JSON.stringify(scope)} is no scope: scope is "workspace", "repository" for this checkout's repository, or "component" with component naming a declared component.`, { path: file });
  if (scope !== "component") {
    if (component !== void 0) throw fail("scope_invalid", `component applies only with scope "component", not with scope ${JSON.stringify(scope)}.`, { path: file });
    return scope === "workspace" ? "workspace" : repository;
  }
  const declared = readComponents(config).declared.map((entry) => entry.name);
  if (component === void 0 || !declared.includes(component)) {
    throw fail("component_unknown", `${component === void 0 ? 'Scope "component" names no component' : `${JSON.stringify(component)} is no component`} of this repository: ## Components in .prism/workflow.md declares ${declared.length ? declared.join(", ") : "none"}.`, { path: file, components: declared });
  }
  return `${repository}/${component}`;
}
function listed(location, file) {
  if (location.file !== void 0) return location.file === file;
  if (!file.endsWith(location.extension) || path.posix.basename(file) === "README.md") return false;
  const rest = location.folder === "" ? file : file.slice(location.folder.length + 1);
  return rest.split("/").length - 1 <= MAX_DEPTH;
}
async function storeRefusing(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ArtifactCheckError) throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components", "key", "folder"].filter((key) => error[key] !== void 0).map((key) => [key, error[key]])));
    }
    throw error;
  }
}
async function checkArtifacts({ projectRoot, paths, type, appliedMigration, startRuns = true }) {
  const { root, store, targets } = await resolveArtifacts({ projectRoot, paths, type });
  const artifacts = await checkTargets(root, store, targets, { appliedMigration, startRuns, complete: paths === void 0 && type === void 0 });
  return { formats: ARTIFACT_FORMATS.map((entry) => ({ type: entry.type, version: entry.version, reference: entry.reference })), artifacts };
}
async function resolveArtifacts({ projectRoot, paths, type }) {
  if (type !== void 0 && !ARTIFACT_TYPES.includes(type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (paths !== void 0 && (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS)) throw fail("invalid_input", `paths must be a list of at most ${MAX_CHECK_PATHS} project-relative files or { path, scope, component } entries.`);
  const root = await realpath(projectRoot);
  const entries = paths === void 0 ? null : paths.map(pathEntry);
  const { config, locations, store, storeType } = await artifactSources(root);
  let targets;
  if (entries === null) {
    targets = (await listArtifacts(root, locations, type)).filter((entry) => storeType(entry.path) === null).map((entry) => ({ ...entry, scope: null }));
    if (store !== null) {
      for (const artifact of store.artifacts) {
        const artifactType = STORE_TYPES.get(artifact.kind);
        if (type && artifactType !== type || listedArtifactType(locations, artifact.path) !== artifactType) continue;
        targets.push({ path: artifact.path, type: artifactType, scope: artifact.scope, stored: artifact });
      }
    }
  } else {
    targets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const { file } = entry;
      const artifactType = artifactTypeOf(locations, file);
      if (artifactType === null) throw fail("artifact_type_unknown", `The path ${file} lies under none of the configured Requirements, ADRs, Glossary, or Feature files paths.`, { path: file });
      const inStore = store !== null && storeType(file) === artifactType;
      if (entry.scope !== void 0 || entry.component !== void 0) {
        if (store === null) throw fail("scope_invalid", `The path ${file} is a checkout file: this project's .prism/workflow.md names no record store, so a paths entry takes no scope.`, { path: file });
        if (!inStore) throw fail("scope_invalid", `The path ${file} is a checkout file, since feature files stay in the checkout, so a paths entry takes no scope for it.`, { path: file });
        if (entry.scope === void 0) throw fail("scope_invalid", 'component names a component scope, so it needs scope "component".', { path: file });
      }
      let found;
      if (inStore) {
        const copies = store.artifacts.filter((artifact) => artifact.path === file);
        if (entry.scope !== void 0) {
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
  return { root, store, targets };
}
const targetBytes = async (root, target) => target.stored ? target.stored.bytes ?? oversized(target.stored.size) : await readFile(path.join(root, target.path));
const contentVersion = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function artifactSources(root, { refusing = storeRefusing, paths = null } = {}) {
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  const store = (config.workspace?.store ?? null) !== null ? await refusing(() => seenArtifactTexts(root, { paths })) : null;
  const storeType = (file) => {
    const kind = store === null ? null : storeKindOf(config, file);
    return kind === null ? null : STORE_TYPES.get(kind) ?? null;
  };
  return { config, locations, store, storeType };
}
async function checkTargets(root, store, targets, { appliedMigration, refusing = storeRefusing, startRuns = true, complete = false } = {}) {
  const { allRuns, appliedMigrationIds, migrationStates, startMigrationRuns } = await import("./migration-runs.mjs");
  if (appliedMigration === void 0) {
    const applied = await refusing(() => appliedMigrationIds(root));
    appliedMigration = (id) => applied.has(id);
  }
  const order = (entry) => ARTIFACT_TYPES.indexOf(entry.type);
  targets = [...targets].sort((a, b) => order(a) - order(b) || compare(a.path, b.path) || compare(labelOf(a), labelOf(b)));
  const { reportedFindings } = await import("./format-findings.mjs");
  const reported = targets.length ? await refusing(() => reportedFindings(root)) : /* @__PURE__ */ new Map();
  const artifacts = [];
  const versions = [];
  for (const target of targets) {
    const bytes = await targetBytes(root, target);
    versions.push(contentVersion(bytes));
    let result;
    if (target.type === "glossary") {
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
  const checked2 = artifacts.map((artifact, index) => ({ ...artifact, formatVersion: artifact.version, version: versions[index] }));
  const states = migrationStates(await refusing(() => allRuns(root)), checked2);
  for (const [index, state] of states.entries()) artifacts[index].migration = state;
  if (startRuns && complete) {
    const started = await startMigrationRuns(root, checked2);
    if (started.length) {
      for (const [index, state] of migrationStates(started, checked2).entries()) if (state) artifacts[index].migration = state;
    }
  } else if (startRuns && checked2.some((artifact) => !artifact.conforms && artifact.type !== "feature")) {
    await checkArtifacts({ projectRoot: root }).catch(() => {
    });
    const states2 = migrationStates(await refusing(() => allRuns(root)), checked2);
    for (const [index, state] of states2.entries()) artifacts[index].migration = state;
  }
  return artifacts;
}
const reportedKey = (file, scope, version) => `${scope === null || scope === void 0 ? "" : scope.label}\0${file}\0${version}`;
async function checkArtifactContent({ path: file, type, bytes, status = null, lookup = null, appliedMigration = () => false, unknownAside = false }) {
  let context = { status, ...unknownAside ? { proposal: true } : {} };
  if (type === "glossary" && lookup !== null) context = { ...context, ...await glossaryContext(file, bytes, lookup, appliedMigration) };
  const { conforms, findings, unknowns } = inspectArtifact(type, bytes, { context });
  return { conforms, findings, unknowns };
}
const checkoutSourceLookup = (root) => checkoutLookup(root);
const storeSourceLookup = (scope, copiesOf) => storeLookup(scope, copiesOf);
const CHECKED_MAX = 2e4;
const checked = /* @__PURE__ */ new Map();
function inspected(target, bytes) {
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
const oversized = (size) => Buffer.alloc(Math.min(size, 1024 * 1024 + 1), 32);
function storeKindOf(config, file) {
  return artifactAddress(artifactKinds(config), file)?.kind ?? null;
}
export {
  ArtifactCheckError,
  MAX_CHECK_PATHS,
  artifactLocations,
  artifactSources,
  artifactTypeOf,
  checkArtifactContent,
  checkArtifacts,
  checkTargets,
  checkoutSourceLookup,
  contentVersion,
  listArtifacts,
  listedArtifactType,
  reportedKey,
  resolveArtifacts,
  storeSourceLookup,
  targetBytes
};
