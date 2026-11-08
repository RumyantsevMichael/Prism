import path from "node:path";

// A store keeps descriptive artifacts under artifacts/, in one folder per scope, and inside it one fixed folder or file per kind,
// so checkouts that configure different paths share one layout, while the configured path stays each artifact's address.
export const ARTIFACTS = "artifacts";
const KIND_LOCATIONS = Object.freeze({ requirements: "requirements", adrs: "adrs", plans: "plans", glossary: "glossary.md", roadmap: "roadmap.md" });

export const WORKSPACE_SCOPE = Object.freeze({ kind: "workspace", label: "workspace" });
export const repositoryScope = (repository) => ({ kind: "repository", repository, label: repository });
export const componentScope = (repository, component) => ({ kind: "component", repository, component, label: `${repository}/${component}` });

const contains = (folder, file) => folder === "" || file === folder || file.startsWith(`${folder}/`);
// An artifact name begins with an ASCII letter or digit and holds only ASCII letters, digits, ".", "_", and "-", so no Git control name, dotfile, temporary file, or invisible character reaches the store's Git.
// Store sync's lock beside a store file is the file's name with ".lock" added, which the store's ignore file leaves out, so no name ends in ".lock", in any letter case.
// Git for Windows refuses to check out a name that ends in "." or is a Windows device name before its first ".", so one such name would stop the store on every Windows machine.
const NAME_FORM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOCK_ENDING = /\.lock$/i;
// Git for Windows reads a device name followed only by spaces before the first "." as the device too, and also refuses CONIN$ and CONOUT$.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$) *(\.|$)/i;
// Windows refuses these characters in a name, and Git for Windows refuses a path that holds one in its index as well as on disk.
const WINDOWS_REFUSED = /[<>:"|?*\\\x00-\x1f]/;
export const ARTIFACT_NAME_FORM = "an artifact name begins with an ASCII letter or digit, holds only ASCII letters, digits, \".\", \"_\", and \"-\", does not end in \".\" or in \".lock\" in any letter case, and is no Windows device name, which is con, prn, aux, nul, com0 to com9, or lpt0 to lpt9 in any letter case before the name's first \".\" or as the whole name, such as aux.md or NUL.txt";

/** Whether a name, before its first ".", is a Windows device name, which Git for Windows refuses as any component of a path. */
export const windowsDeviceName = (name) => DEVICE_NAME.test(name);

/**
 * Whether one path component can be a file or folder name on every machine Prism supports: Windows, and Git for Windows in its index as on disk,
 * refuses a Windows device name, a name that ends in "." or " ", and any of < > : " | ? * \\ or a control character.
 */
export const portableName = (name) => typeof name === "string" && name !== "" && !WINDOWS_REFUSED.test(name) && !/[. ]$/.test(name) && !DEVICE_NAME.test(name);

// ext4 and APFS hold a name of at most 255 bytes and NTFS one of 255 UTF-16 units, and every write of a store file goes through a temporary file ".<name>.<process id>.<16 hex digits>.tmp" beside it, up to 33 bytes longer.
// So a name that a store shares holds at most 200 bytes, and its whole path at most 512, which leaves room below the 1024 bytes macOS allows for the store's own folder and the sync folder's saved copies.
export const STORE_NAME_BYTES_MAX = 200;
export const STORE_PATH_BYTES_MAX = 512;

/** Whether every machine Prism supports can write a store-relative path and the temporary file beside it: each name holds at most STORE_NAME_BYTES_MAX bytes and the path at most STORE_PATH_BYTES_MAX. */
export const storePathFits = (file) => Buffer.byteLength(file) <= STORE_PATH_BYTES_MAX && file.split("/").every((name) => Buffer.byteLength(name) <= STORE_NAME_BYTES_MAX);

/** Whether one path component follows the artifact name form. */
export const wellFormedName = (name) => NAME_FORM.test(name) && portableName(name) && !LOCK_ENDING.test(name);

/**
 * The key under which macOS and Windows file systems, which ignore letter case and Unicode normalization by default, read a path or name, so two paths with one key are one file or folder there.
 * An artifact name holds only ASCII letters, where this is plain ASCII folding.
 */
export const letterCaseKey = (name) => name.normalize("NFC").toLowerCase();
const folded = letterCaseKey;

/**
 * Whether two artifact paths of one kind collide in letter case: some folder or file of one, taken with the folders above it,
 * equals the same part of the other only when ASCII letter case is ignored, so a case-insensitive file system makes them one file or folder.
 */
export function collideInLetterCase(left, right) {
  const a = left.split("/"), b = right.split("/");
  const index = a.findIndex((name, at) => name !== b[at]);
  return index >= 0 && index < b.length && folded(a[index]) === folded(b[index]);
}

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

/**
 * The first name of an artifact address that breaks the artifact name form, or null when every name follows it:
 * each component below the configured folder, or the file name of a configured glossary or roadmap path.
 */
export function malformedArtifactName({ path: file, rest }) {
  const names = rest === null ? [path.posix.basename(file)] : rest === "" ? [] : rest.split("/");
  return names.find((name) => !wellFormedName(name)) ?? null;
}

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

/** The scope, kind, and rest of an artifact location below artifacts/, the inverse of artifactLocation: { scope, kind, rest }, or null for a location that names no artifact of a kind. */
export function locationArtifact(location) {
  const names = typeof location === "string" ? location.split("/") : [];
  let scope = WORKSPACE_SCOPE, at = 0;
  // No kind folder is named repositories or components, so a scope folder is told apart from a kind folder by these names alone.
  if (names[0] === "repositories" && names.length > 2) {
    if (names[2] === "components" && names.length > 4) { scope = componentScope(names[1], names[3]); at = 4; }
    else { scope = repositoryScope(names[1]); at = 2; }
  }
  const [first, ...rest] = names.slice(at);
  const kind = Object.keys(KIND_LOCATIONS).find((candidate) => KIND_LOCATIONS[candidate] === first);
  if (!kind || !kindInScope(kind, scope)) return null;
  const folder = !KIND_LOCATIONS[kind].endsWith(".md");
  if (folder !== rest.length > 0) return null;
  return { scope, kind, rest: folder ? rest.join("/") : null };
}

/** Whether an artifact kind may live in a scope: every kind in every scope, except the roadmap view, which lives only in the workspace scope. */
export const kindInScope = (kind, scope) => kind !== "roadmap" || scope.kind === "workspace";
