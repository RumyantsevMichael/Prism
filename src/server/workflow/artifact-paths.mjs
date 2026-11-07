import path from "node:path";

// A store keeps descriptive artifacts under artifacts/, in one folder per scope, and inside it one fixed folder or file per kind,
// so checkouts that configure different paths share one layout, while the configured path stays each artifact's address.
export const ARTIFACTS = "artifacts";
const KIND_LOCATIONS = Object.freeze({ requirements: "requirements", adrs: "adrs", plans: "plans", glossary: "glossary.md", roadmap: "roadmap.md" });

export const WORKSPACE_SCOPE = Object.freeze({ kind: "workspace", label: "workspace" });
export const repositoryScope = (repository) => ({ kind: "repository", repository, label: repository });
export const componentScope = (repository, component) => ({ kind: "component", repository, component, label: `${repository}/${component}` });

const contains = (folder, file) => folder === "" || file === folder || file.startsWith(`${folder}/`);
// The store's lock and temporary files sit beside the file they guard, so no artifact may take such a name.
const RESERVED = /(\.lock|^\..*\.tmp)$/;

/** A project-relative path written with forward slashes and without a trailing slash, "" for the project root, or null when it is absolute or leaves the project. */
export function normalizeArtifactPath(value) {
  if (typeof value !== "string") return null;
  const slashed = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed === "" ? "." : slashed).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

/**
 * The artifact a normalized project-relative path names: { path, kind, rest }, or null when the path is no artifact path.
 * kind is the kind of the longest configured path that contains it, and rest is the path below a configured folder, "" for the folder itself and null for a file kind.
 * A path inside a configured feature file or user guide folder is no artifact path.
 */
export function artifactAddress({ kinds, excluded }, file) {
  if (typeof file !== "string" || excluded.some((folder) => contains(folder, file))) return null;
  const match = kinds.find((entry) => entry.folder ? contains(entry.path, file) : entry.path === file);
  if (!match) return null;
  const rest = !match.folder ? null : match.path === "" ? file : file === match.path ? "" : file.slice(match.path.length + 1);
  return { path: file, kind: match.kind, rest };
}

/** Whether a normalized path names a store lock or temporary file, which no artifact may be. */
export const reservedArtifactName = (file) => RESERVED.test(path.posix.basename(file));

/** Whether a normalized path that is no artifact path is a folder that holds a configured artifact path, so a listing below it shows artifacts. */
export function holdsArtifactPaths({ kinds, excluded }, folder) {
  if (excluded.some((excludedFolder) => contains(excludedFolder, folder))) return false;
  return kinds.some((entry) => folder === "" || entry.path.startsWith(`${folder}/`));
}

/** The project-relative path of an artifact kind's file below its kind folder, the inverse of artifactAddress, or null when the kind is not configured. */
export function artifactPathOf({ kinds }, kind, rest) {
  const entry = kinds.find((candidate) => candidate.kind === kind);
  if (!entry) return null;
  if (!entry.folder) return entry.path;
  return entry.path === "" ? rest : `${entry.path}/${rest}`;
}

/** A scope's folder below artifacts/: "" for the workspace scope, repositories/<repository>, or repositories/<repository>/components/<component>. */
export function scopeFolder(scope) {
  if (scope.kind === "workspace") return "";
  const repository = `repositories/${scope.repository}`;
  return scope.kind === "repository" ? repository : `${repository}/components/${scope.component}`;
}

/** The folder or file of a kind inside a scope folder. */
export const kindLocation = (kind) => KIND_LOCATIONS[kind];

/** An artifact's location, its path below artifacts/ in a scope: <scope folder>/<kind folder>/<rest>, or the kind's file, while the roadmap view lives only at roadmap.md. */
export function artifactLocation(scope, { kind, rest }) {
  if (kind === "roadmap") return KIND_LOCATIONS.roadmap;
  const inScope = rest === null || rest === "" ? KIND_LOCATIONS[kind] : `${KIND_LOCATIONS[kind]}/${rest}`;
  return path.posix.join(scopeFolder(scope), inScope);
}

/** Whether an artifact kind may live in a scope: every kind in every scope, except the roadmap view, which lives only in the workspace scope. */
export const kindInScope = (kind, scope) => kind !== "roadmap" || scope.kind === "workspace";
