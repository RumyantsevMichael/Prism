import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_FORMATS, ARTIFACT_TYPES, adrStatusOf, glossarySources, inspectArtifact, requirementOutline } from "./artifact-formats.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

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

// Glossary sources resolve from the glossary's folder to requirement sections, ADRs, and migrations, reading each file once.
function sourceResolver(root, glossaryPath, appliedMigration) {
  const texts = new Map();
  return {
    async prepare(sources) {
      for (const source of sources) {
        if (source.kind === "migration") continue;
        const file = targetFile(glossaryPath, source.target);
        if (file === null || texts.has(file)) continue;
        texts.set(file, await readFile(path.join(root, file), "utf8").catch(() => null));
      }
    },
    resolve(source) {
      if (source.kind === "migration") {
        if (source.id && appliedMigration(source.id)) return { decided: true, inForce: true, reason: "applied migration" };
        return { decided: false, reason: "a migration that was not applied" };
      }
      const file = targetFile(glossaryPath, source.target);
      const text = file === null ? null : texts.get(file) ?? null;
      if (text === null) return { decided: false, reason: "missing" };
      if (source.kind === "adr") {
        const status = adrStatusOf(text) ?? "";
        if (status === "Accepted") return { decided: true, inForce: true, reason: "Accepted" };
        if (status.startsWith("Superseded")) return { decided: true, inForce: false, reason: "Superseded" };
        return { decided: false, reason: status.split(" ")[0] || "no status" };
      }
      const outline = requirementOutline(text);
      const number = Number(source.target.split("#")[1]);
      const section = outline.sections.find((entry) => entry.number === number);
      const status = outline.status ?? "";
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

// The sources that a glossary text cites, so that the resolver reads their files before the synchronous check runs.
async function glossaryContext(root, file, input, appliedMigration) {
  const resolver = sourceResolver(root, file, appliedMigration);
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const sources = [...text.matchAll(/^Source:\s*(.*?)\s*$/gm)].flatMap((match) => glossarySources(match[1]) ?? []);
  await resolver.prepare(sources);
  return { resolveSource: (source) => resolver.resolve(source) };
}

/**
 * Checks the project's artifacts: { formats, artifacts }.
 * `legacyOf(path, type)` returns the legacy mark that covers a path, and `appliedMigration(id)` whether a migration was applied; both default to none.
 */
export async function checkArtifacts({ projectRoot, paths, type, legacyOf = () => null, appliedMigration = () => false }) {
  if (type !== undefined && !ARTIFACT_TYPES.includes(type)) throw fail("invalid_input", `type must be one of ${ARTIFACT_TYPES.join(", ")}.`);
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS)) throw fail("invalid_input", `paths must be a list of at most ${MAX_CHECK_PATHS} project-relative files.`);
  const root = await realpath(projectRoot);
  const config = await readWorkflowConfig(root);
  const locations = artifactLocations(config);
  let targets;
  if (paths === undefined) {
    targets = await listArtifacts(root, locations, type);
  } else {
    targets = [];
    const seen = new Set();
    for (const given of paths) {
      const file = normalized(given);
      const artifactType = artifactTypeOf(locations, file);
      if (artifactType === null) throw fail("artifact_type_unknown", `The path ${file} lies under none of the configured Requirements, ADRs, Glossary, or Feature files paths.`, { path: file });
      const info = await stat(path.join(root, file)).catch(() => null);
      if (!info?.isFile()) throw fail("artifact_missing", `The artifact ${file} does not exist.`, { path: file });
      if (type && artifactType !== type) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      targets.push({ path: file, type: artifactType });
    }
  }
  const order = (entry) => ARTIFACT_TYPES.indexOf(entry.type);
  targets.sort((a, b) => order(a) - order(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const artifacts = [];
  for (const target of targets) {
    const bytes = await readFile(path.join(root, target.path));
    const context = target.type === "glossary" ? await glossaryContext(root, target.path, bytes, appliedMigration) : {};
    const result = inspectArtifact(target.type, bytes, { context });
    const legacy = result.conforms ? null : legacyOf(target.path, target.type) ?? null;
    artifacts.push({ path: target.path, type: target.type, version: result.version, conforms: result.conforms, findings: result.findings, unknowns: result.unknowns, earlierFormat: result.earlierFormat, legacy });
  }
  return { formats: ARTIFACT_FORMATS.map((entry) => ({ type: entry.type, version: entry.version, reference: entry.reference })), artifacts };
}
