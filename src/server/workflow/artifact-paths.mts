import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { parseStoreJson } from "./store-json.mjs";
import type { PathKey } from "./workflow-config.mjs";

/** A scope of the store: the whole workspace, one named repository, or one component of a repository. */
export type Scope = { kind: "workspace"; label: string; repository?: undefined; component?: undefined } | { kind: "repository"; repository: string; label: string; component?: undefined } | { kind: "component"; repository: string; component: string; label: string };
export type ArtifactKind = "requirements" | "adrs" | "plans" | "glossary" | "roadmap";
/** The configured artifact kinds of a workflow configuration, as artifactKinds gives them. */
export interface ArtifactKinds { kinds: { kind: PathKey; path: string; folder: boolean }[]; excluded: string[] }
/** The artifact a project-relative path names, as artifactAddress gives it. */
export interface ArtifactAddress { path: string; kind: string; rest: string | null }

// A store keeps descriptive artifacts under artifacts/, in one folder per scope, and inside it one fixed folder or file per kind,
// so checkouts that configure different paths share one layout, while the configured path stays each artifact's address.
export const ARTIFACTS = "artifacts";
// Beside artifacts/, a store keeps each requirement's and ADR's status record at artifact-status/<location>/status.json and the bytes a person accepted under their hash in artifact-accepted/.
export const ARTIFACT_STATUS = "artifact-status";
export const ARTIFACT_ACCEPTED = "artifact-accepted";
export const STATUS_RECORD_NAME = "status.json";
// Each comment on an artifact is one file of its own at artifact-comments/<the artifact's location>/<time>-<random suffix>.json, so comments from two machines never change the same file.
export const ARTIFACT_COMMENTS = "artifact-comments";
// Every artifact has an identity, kept beside it at artifact-identity/<location> as one line of JSON {"id": <32 lowercase hexadecimal digits>}:
// a create writes a new one, a move to another scope carries it, a removal removes it, and every other write keeps it,
// so a store sync merges a change made on one machine into the artifact it was made on, wherever the other machine moved it, and never into a later file at its path.
export const ARTIFACT_IDENTITY = "artifact-identity";
const IDENTITY_FORM = /^[0-9a-f]{32}$/;
// An identity file is one short line; a larger file someone placed there holds no identity and is never read whole.
export const IDENTITY_FILE_MAX = 256;

/** A new random identity. */
export const newIdentity = () => randomBytes(16).toString("hex");

/** The bytes of an identity file. */
export const identityContent = (id: string) => `${JSON.stringify({ id })}\n`;

/** The identity that a location gives an artifact whose identity file is missing, of another form, or shared: the first 32 hexadecimal digits of the SHA-256 of the location's UTF-8 bytes. */
export const locationIdentity = (location: string) => createHash("sha256").update(location, "utf8").digest("hex").slice(0, 32);

/**
 * The identity of each location of one tree that holds an artifact, as Map(location, id): the id its identity file holds, as written gives it, else the one its location gives.
 * No two locations of a tree have one identity: where two would, each location whose file gave that id takes the one its location gives instead,
 * which can meet an id that a third location's file holds, so this repeats until no two locations share one; a location that has the id its own location gives never changes again, so it ends.
 */
export function uniqueIdentities(locations: Iterable<string>, written: Map<string, string>) {
  const ids = new Map<string, string>();
  const holders = new Map<string, Set<string>>();
  const hold = (location: string, id: string) => {
    ids.set(location, id);
    if (!holders.has(id)) holders.set(id, new Set());
    holders.get(id)!.add(location);
    return holders.get(id)!.size > 1;
  };
  const shared: string[] = [];
  for (const location of locations) if (hold(location, written.get(location) ?? locationIdentity(location))) shared.push(ids.get(location)!);
  while (shared.length) {
    const id = shared.pop()!;
    const held = holders.get(id)!;
    if (held.size < 2) continue;
    for (const location of [...held]) {
      const own = locationIdentity(location);
      if (own === id) continue;
      held.delete(location);
      if (hold(location, own)) shared.push(own);
    }
  }
  return ids;
}

/** The id that an identity file's bytes hold, or null for bytes of any other form: one line of JSON, an object whose only key id holds 32 lowercase hexadecimal digits. */
export function identityOf(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length > IDENTITY_FILE_MAX) return null;
  let value: any;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.replace(/\n$/, "").includes("\n")) return null;
    value = parseStoreJson(text);
  } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.id !== "string") return null;
  return IDENTITY_FORM.test(value.id) ? value.id : null;
}
// Each move of a checkout's existing artifacts into the store writes one ledger file of its own below artifact-migrations/, so two machines never change the same file.
export const ARTIFACT_MIGRATIONS = "artifact-migrations";
const KIND_LOCATIONS: Readonly<Record<string, string>> = Object.freeze({ requirements: "requirements", adrs: "adrs", plans: "plans", glossary: "glossary.md", roadmap: "roadmap.md" });

export const WORKSPACE_SCOPE: Readonly<Scope> = Object.freeze({ kind: "workspace", label: "workspace" });
export const repositoryScope = (repository: string): Scope => ({ kind: "repository", repository, label: repository });
export const componentScope = (repository: string, component: string): Scope => ({ kind: "component", repository, component, label: `${repository}/${component}` });

const contains = (folder: string, file: string) => folder === "" || file === folder || file.startsWith(`${folder}/`);
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
export const windowsDeviceName = (name: string) => DEVICE_NAME.test(name);

/**
 * Whether one path component can be a file or folder name on every machine Prism supports: Windows, and Git for Windows in its index as on disk,
 * refuses a Windows device name, a name that ends in "." or " ", and any of < > : " | ? * \\ or a control character.
 */
export const portableName = (name: string) => typeof name === "string" && name !== "" && !WINDOWS_REFUSED.test(name) && !/[. ]$/.test(name) && !DEVICE_NAME.test(name);

// ext4 and APFS hold a name of at most 255 bytes and NTFS one of 255 UTF-16 units, and every write of a store file goes through a temporary file ".<name>.<process id>.<16 hex digits>.tmp" beside it, up to 33 bytes longer.
// So a name that a store shares holds at most 200 bytes, and its whole path at most 512, which leaves room below the 1024 bytes macOS allows for the store's own folder and the sync folder's saved copies.
export const STORE_NAME_BYTES_MAX = 200;
export const STORE_PATH_BYTES_MAX = 512;

/** Whether every machine Prism supports can write a store-relative path and the temporary file beside it: each name holds at most STORE_NAME_BYTES_MAX bytes and the path at most STORE_PATH_BYTES_MAX. */
export const storePathFits = (file: string) => Buffer.byteLength(file) <= STORE_PATH_BYTES_MAX && file.split("/").every((name: string) => Buffer.byteLength(name) <= STORE_NAME_BYTES_MAX);

// The longest store path that Prism derives from an artifact's location is a comment's, artifact-comments/<location>/<time>-<random suffix>.json, whose name holds 38 bytes,
// so a location fits when that path does: its whole path holds at most ARTIFACT_LOCATION_BYTES_MAX bytes and each of its names at most STORE_NAME_BYTES_MAX.
// Prism runs every Git command in a store with core.longpaths, so Windows' old 260-character limit bounds no store path.
const COMMENT_NAME_BYTES = "2026-01-01T00-00-00-000Z-0123abcd.json".length;
export const ARTIFACT_LOCATION_BYTES_MAX = STORE_PATH_BYTES_MAX - `${ARTIFACT_COMMENTS}/`.length - `/${"x".repeat(COMMENT_NAME_BYTES)}`.length;

/** Whether a store shares every file Prism keeps for an artifact at a location below artifacts/: the artifact, its identity, its status record, and its comments. */
export const locationFits = (location: string) => storePathFits(`${ARTIFACT_COMMENTS}/${location}/${"x".repeat(COMMENT_NAME_BYTES)}`);

/** Why a location does not fit, as a phrase that follows the location, or null when it fits. */
export function locationExcess(location: string) {
  const long = location.split("/").find((name: string) => Buffer.byteLength(name) > STORE_NAME_BYTES_MAX);
  if (long !== undefined) return `holds a name of ${Buffer.byteLength(long)} bytes, above the ${STORE_NAME_BYTES_MAX} that a name in the store may hold`;
  const bytes = Buffer.byteLength(location);
  return bytes > ARTIFACT_LOCATION_BYTES_MAX ? `holds ${bytes} bytes, above the ${ARTIFACT_LOCATION_BYTES_MAX} that a location may hold` : null;
}

/** The data of an artifact_path_too_long refusal of a location. */
export const locationLimits = (location: string) => ({ location, limit: ARTIFACT_LOCATION_BYTES_MAX, nameLimit: STORE_NAME_BYTES_MAX });

/** Whether one path component follows the artifact name form. */
export const wellFormedName = (name: string) => NAME_FORM.test(name) && portableName(name) && !LOCK_ENDING.test(name);

/**
 * The key under which macOS and Windows file systems, which ignore letter case and Unicode normalization by default, read a path or name, so two paths with one key are one file or folder there.
 * An artifact name holds only ASCII letters, where this is plain ASCII folding.
 */
export const letterCaseKey = (name: string) => name.normalize("NFC").toLowerCase();
const folded = letterCaseKey;

/**
 * Whether two artifact paths of one kind collide in letter case: some folder or file of one, taken with the folders above it,
 * equals the same part of the other only when ASCII letter case is ignored, so a case-insensitive file system makes them one file or folder.
 */
export function collideInLetterCase(left: string, right: string) {
  const a = left.split("/"), b = right.split("/");
  const index = a.findIndex((name: string, at: number) => name !== b[at]);
  return index >= 0 && index < b.length && folded(a[index]) === folded(b[index]);
}

/** A project-relative path written with forward slashes and without a trailing slash, "" for the project root, or null when it is absolute or leaves the project. */
export function normalizeArtifactPath(value: unknown): string | null {
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
export function artifactAddress({ kinds, excluded }: ArtifactKinds, file: string): ArtifactAddress | null {
  if (typeof file !== "string" || excluded.some((folder: string) => contains(folder, file))) return null;
  const match = kinds.find((entry) => entry.folder ? contains(entry.path, file) : entry.path === file);
  if (!match) return null;
  const rest = !match.folder ? null : match.path === "" ? file : file === match.path ? "" : file.slice(match.path.length + 1);
  return { path: file, kind: match.kind, rest };
}

/**
 * The first name of an artifact address that breaks the artifact name form, or null when every name follows it:
 * each component below the configured folder, or the file name of a configured glossary or roadmap path.
 */
export function malformedArtifactName({ path: file, rest }: { path: string; rest: string | null }) {
  const names = rest === null ? [path.posix.basename(file)] : rest === "" ? [] : rest.split("/");
  return names.find((name: string) => !wellFormedName(name)) ?? null;
}

/** Whether a normalized path that is no artifact path is a folder that holds a configured artifact path, so a listing below it shows artifacts. */
export function holdsArtifactPaths({ kinds, excluded }: ArtifactKinds, folder: string) {
  if (excluded.some((excludedFolder) => contains(excludedFolder, folder))) return false;
  return kinds.some((entry) => folder === "" || entry.path.startsWith(`${folder}/`));
}

/** The project-relative path of an artifact kind's file below its kind folder, the inverse of artifactAddress, or null when the kind is not configured. */
export function artifactPathOf({ kinds }: Pick<ArtifactKinds, "kinds">, kind: string, rest: string) {
  const entry = kinds.find((candidate) => candidate.kind === kind);
  if (!entry) return null;
  if (!entry.folder) return entry.path;
  return entry.path === "" ? rest : `${entry.path}/${rest}`;
}

/** A scope's folder below artifacts/: "" for the workspace scope, repositories/<repository>, or repositories/<repository>/components/<component>. */
export function scopeFolder(scope: Scope) {
  if (scope.kind === "workspace") return "";
  const repository = `repositories/${scope.repository}`;
  return scope.kind === "repository" ? repository : `${repository}/components/${scope.component}`;
}

/** The folder or file of a kind inside a scope folder. */
export const kindLocation = (kind: string): string | undefined => KIND_LOCATIONS[kind];

/** An artifact's location, its path below artifacts/ in a scope: <scope folder>/<kind folder>/<rest>, or the kind's file, while the roadmap view lives only at roadmap.md. */
export function artifactLocation(scope: Scope, { kind, rest }: { kind: string; rest: string | null }) {
  if (kind === "roadmap") return KIND_LOCATIONS.roadmap;
  const inScope = rest === null || rest === "" ? KIND_LOCATIONS[kind] : `${KIND_LOCATIONS[kind]}/${rest}`;
  return path.posix.join(scopeFolder(scope), inScope);
}

/** The scope, kind, and rest of an artifact location below artifacts/, the inverse of artifactLocation: { scope, kind, rest }, or null for a location that names no artifact of a kind. */
export function locationArtifact(location: unknown): { scope: Scope; kind: string; rest: string | null } | null {
  const names = typeof location === "string" ? location.split("/") : [];
  let scope: Scope = WORKSPACE_SCOPE, at = 0;
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
export const kindInScope = (kind: string, scope: Pick<Scope, "kind">) => kind !== "roadmap" || scope.kind === "workspace";
