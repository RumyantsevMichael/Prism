// Generated from src/server/workflow/artifact-paths.mts by scripts/native-build/compile.mjs.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { parseStoreJson } from "./store-json.mjs";
const ARTIFACTS = "artifacts";
const ARTIFACT_STATUS = "artifact-status";
const ARTIFACT_ACCEPTED = "artifact-accepted";
const STATUS_RECORD_NAME = "status.json";
const ARTIFACT_COMMENTS = "artifact-comments";
const ARTIFACT_IDENTITY = "artifact-identity";
const IDENTITY_FORM = /^[0-9a-f]{32}$/;
const IDENTITY_FILE_MAX = 256;
const newIdentity = () => randomBytes(16).toString("hex");
const identityContent = (id) => `${JSON.stringify({ id })}
`;
const locationIdentity = (location) => createHash("sha256").update(location, "utf8").digest("hex").slice(0, 32);
function uniqueIdentities(locations, written) {
  const ids = /* @__PURE__ */ new Map();
  const holders = /* @__PURE__ */ new Map();
  const hold = (location, id) => {
    ids.set(location, id);
    if (!holders.has(id)) holders.set(id, /* @__PURE__ */ new Set());
    holders.get(id).add(location);
    return holders.get(id).size > 1;
  };
  const shared = [];
  for (const location of locations) if (hold(location, written.get(location) ?? locationIdentity(location))) shared.push(ids.get(location));
  while (shared.length) {
    const id = shared.pop();
    const held = holders.get(id);
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
function identityOf(bytes) {
  if (!bytes || bytes.length > IDENTITY_FILE_MAX) return null;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.replace(/\n$/, "").includes("\n")) return null;
    value = parseStoreJson(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.id !== "string") return null;
  return IDENTITY_FORM.test(value.id) ? value.id : null;
}
const ARTIFACT_MIGRATIONS = "artifact-migrations";
const KIND_LOCATIONS = Object.freeze({ requirements: "requirements", adrs: "adrs", plans: "plans", glossary: "glossary.md", roadmap: "roadmap.md" });
const WORKSPACE_SCOPE = Object.freeze({ kind: "workspace", label: "workspace" });
const repositoryScope = (repository) => ({ kind: "repository", repository, label: repository });
const componentScope = (repository, component) => ({ kind: "component", repository, component, label: `${repository}/${component}` });
const contains = (folder, file) => folder === "" || file === folder || file.startsWith(`${folder}/`);
const NAME_FORM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOCK_ENDING = /\.lock$/i;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$) *(\.|$)/i;
const WINDOWS_REFUSED = /[<>:"|?*\\\x00-\x1f]/;
const ARTIFACT_NAME_FORM = `an artifact name begins with an ASCII letter or digit, holds only ASCII letters, digits, ".", "_", and "-", does not end in "." or in ".lock" in any letter case, and is no Windows device name, which is con, prn, aux, nul, com0 to com9, or lpt0 to lpt9 in any letter case before the name's first "." or as the whole name, such as aux.md or NUL.txt`;
const windowsDeviceName = (name) => DEVICE_NAME.test(name);
const portableName = (name) => typeof name === "string" && name !== "" && !WINDOWS_REFUSED.test(name) && !/[. ]$/.test(name) && !DEVICE_NAME.test(name);
const STORE_NAME_BYTES_MAX = 200;
const STORE_PATH_BYTES_MAX = 512;
const storePathFits = (file) => Buffer.byteLength(file) <= STORE_PATH_BYTES_MAX && file.split("/").every((name) => Buffer.byteLength(name) <= STORE_NAME_BYTES_MAX);
const COMMENT_NAME_BYTES = "2026-01-01T00-00-00-000Z-0123abcd.json".length;
const ARTIFACT_LOCATION_BYTES_MAX = STORE_PATH_BYTES_MAX - `${ARTIFACT_COMMENTS}/`.length - `/${"x".repeat(COMMENT_NAME_BYTES)}`.length;
const locationFits = (location) => storePathFits(`${ARTIFACT_COMMENTS}/${location}/${"x".repeat(COMMENT_NAME_BYTES)}`);
function locationExcess(location) {
  const long = location.split("/").find((name) => Buffer.byteLength(name) > STORE_NAME_BYTES_MAX);
  if (long !== void 0) return `holds a name of ${Buffer.byteLength(long)} bytes, above the ${STORE_NAME_BYTES_MAX} that a name in the store may hold`;
  const bytes = Buffer.byteLength(location);
  return bytes > ARTIFACT_LOCATION_BYTES_MAX ? `holds ${bytes} bytes, above the ${ARTIFACT_LOCATION_BYTES_MAX} that a location may hold` : null;
}
const locationLimits = (location) => ({ location, limit: ARTIFACT_LOCATION_BYTES_MAX, nameLimit: STORE_NAME_BYTES_MAX });
const wellFormedName = (name) => NAME_FORM.test(name) && portableName(name) && !LOCK_ENDING.test(name);
const letterCaseKey = (name) => name.normalize("NFC").toLowerCase();
const folded = letterCaseKey;
function collideInLetterCase(left, right) {
  const a = left.split("/"), b = right.split("/");
  const index = a.findIndex((name, at) => name !== b[at]);
  return index >= 0 && index < b.length && folded(a[index]) === folded(b[index]);
}
function normalizeArtifactPath(value) {
  if (typeof value !== "string") return null;
  const slashed = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed === "" ? "." : slashed).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}
function artifactAddress({ kinds, excluded }, file) {
  if (typeof file !== "string" || excluded.some((folder) => contains(folder, file))) return null;
  const match = kinds.find((entry) => entry.folder ? contains(entry.path, file) : entry.path === file);
  if (!match) return null;
  const rest = !match.folder ? null : match.path === "" ? file : file === match.path ? "" : file.slice(match.path.length + 1);
  return { path: file, kind: match.kind, rest };
}
function malformedArtifactName({ path: file, rest }) {
  const names = rest === null ? [path.posix.basename(file)] : rest === "" ? [] : rest.split("/");
  return names.find((name) => !wellFormedName(name)) ?? null;
}
function holdsArtifactPaths({ kinds, excluded }, folder) {
  if (excluded.some((excludedFolder) => contains(excludedFolder, folder))) return false;
  return kinds.some((entry) => folder === "" || entry.path.startsWith(`${folder}/`));
}
function artifactPathOf({ kinds }, kind, rest) {
  const entry = kinds.find((candidate) => candidate.kind === kind);
  if (!entry) return null;
  if (!entry.folder) return entry.path;
  return entry.path === "" ? rest : `${entry.path}/${rest}`;
}
function scopeFolder(scope) {
  if (scope.kind === "workspace") return "";
  const repository = `repositories/${scope.repository}`;
  return scope.kind === "repository" ? repository : `${repository}/components/${scope.component}`;
}
const kindLocation = (kind) => KIND_LOCATIONS[kind];
function artifactLocation(scope, { kind, rest }) {
  if (kind === "roadmap") return KIND_LOCATIONS.roadmap;
  const inScope = rest === null || rest === "" ? KIND_LOCATIONS[kind] : `${KIND_LOCATIONS[kind]}/${rest}`;
  return path.posix.join(scopeFolder(scope), inScope);
}
function locationArtifact(location) {
  const names = typeof location === "string" ? location.split("/") : [];
  let scope = WORKSPACE_SCOPE, at = 0;
  if (names[0] === "repositories" && names.length > 2) {
    if (names[2] === "components" && names.length > 4) {
      scope = componentScope(names[1], names[3]);
      at = 4;
    } else {
      scope = repositoryScope(names[1]);
      at = 2;
    }
  }
  const [first, ...rest] = names.slice(at);
  const kind = Object.keys(KIND_LOCATIONS).find((candidate) => KIND_LOCATIONS[candidate] === first);
  if (!kind || !kindInScope(kind, scope)) return null;
  const folder = !KIND_LOCATIONS[kind].endsWith(".md");
  if (folder !== rest.length > 0) return null;
  return { scope, kind, rest: folder ? rest.join("/") : null };
}
const kindInScope = (kind, scope) => kind !== "roadmap" || scope.kind === "workspace";
export {
  ARTIFACTS,
  ARTIFACT_ACCEPTED,
  ARTIFACT_COMMENTS,
  ARTIFACT_IDENTITY,
  ARTIFACT_LOCATION_BYTES_MAX,
  ARTIFACT_MIGRATIONS,
  ARTIFACT_NAME_FORM,
  ARTIFACT_STATUS,
  IDENTITY_FILE_MAX,
  STATUS_RECORD_NAME,
  STORE_NAME_BYTES_MAX,
  STORE_PATH_BYTES_MAX,
  WORKSPACE_SCOPE,
  artifactAddress,
  artifactLocation,
  artifactPathOf,
  collideInLetterCase,
  componentScope,
  holdsArtifactPaths,
  identityContent,
  identityOf,
  kindInScope,
  kindLocation,
  letterCaseKey,
  locationArtifact,
  locationExcess,
  locationFits,
  locationIdentity,
  locationLimits,
  malformedArtifactName,
  newIdentity,
  normalizeArtifactPath,
  portableName,
  repositoryScope,
  scopeFolder,
  storePathFits,
  uniqueIdentities,
  wellFormedName,
  windowsDeviceName
};
