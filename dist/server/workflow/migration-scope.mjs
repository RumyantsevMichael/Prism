// Generated from src/server/workflow/migration-scope.mts by scripts/native-build/compile.mjs.
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { MIGRATION_PROJECT_VARIABLE, MIGRATION_RUN_TOOLS, MIGRATION_SCOPE_VARIABLE } from "../session/launch-hosts.mjs";
import { artifactLocations, listedArtifactType } from "./artifact-check.mjs";
import { readRun } from "./migration-runs.mjs";
import { artifactVersion } from "./store-artifacts.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
const CHECKOUT_FILE_MAX = 1024 * 1024;
function migrationScopeOf(env = process.env) {
  const run = env?.[MIGRATION_SCOPE_VARIABLE];
  return typeof run === "string" && run ? run : null;
}
function migrationProjectOf(env = process.env) {
  const project = env?.[MIGRATION_PROJECT_VARIABLE];
  return typeof project === "string" && path.isAbsolute(project) ? project : null;
}
function scopedTools(tools, run) {
  if (run === null) return tools;
  return tools.filter((tool) => MIGRATION_RUN_TOOLS.includes(tool.name)).map((tool) => {
    const required = tool.inputSchema?.required;
    if (!Array.isArray(required) || !required.includes("projectRoot")) return tool;
    return { ...tool, inputSchema: { ...tool.inputSchema, required: required.filter((name) => name !== "projectRoot") } };
  });
}
const refusal = (run, message) => ({ code: "migration_scope", message: `This session serves the format migration run ${run} only: ${message}`, run });
function relativePath(value) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const normal = path.posix.normalize(value.replaceAll("\\", "/"));
  return normal === "." || normal === ".." || normal.startsWith("../") ? null : normal.replace(/^\.\//, "").replace(/\/$/, "");
}
async function realOrNull(folder) {
  try {
    return await realpath(folder);
  } catch {
    return null;
  }
}
async function scopedProjectRoot(run, project, args, fallback) {
  if (project === null) return { root: await fallback() };
  const own = await realOrNull(project);
  if (own === null) return { refusal: refusal(run, `its project ${project} cannot be read.`) };
  if (args?.projectRoot === void 0) return { root: own };
  const named = typeof args.projectRoot === "string" && path.isAbsolute(args.projectRoot) ? await realOrNull(args.projectRoot) : null;
  if (named !== own) return { refusal: refusal(run, `projectRoot names ${JSON.stringify(String(args.projectRoot))}, not the run's project.`) };
  return { root: own };
}
async function scopeRefusal(run, name, args, projectRoot) {
  if (!MIGRATION_RUN_TOOLS.includes(name)) return refusal(run, `it calls only ${MIGRATION_RUN_TOOLS.join(", ")}, not ${String(name)}.`);
  if (name !== "get_artifact" && args?.run !== run) return refusal(run, `${name} is taken only for that run.`);
  const record = await runOf(projectRoot, run);
  if (!record) return refusal(run, "the project named holds no such run.");
  if (name !== "get_artifact") return null;
  const file = relativePath(args?.path);
  if (file !== null && accepted(record, await readWorkflowConfig(projectRoot), file)) return null;
  return refusal(run, `get_artifact reads only the run's artifacts and paths under the configured path of its type, not ${JSON.stringify(String(args?.path ?? ""))}.`);
}
async function runOf(projectRoot, run) {
  try {
    return await readRun(projectRoot, run);
  } catch {
    return null;
  }
}
const dotted = (file) => file.split("/").some((part) => part.startsWith("."));
function belowTypePath(config, type, file) {
  const location = artifactLocations(config).find((entry) => entry.type === type);
  if (!location) return file;
  if (location.file !== void 0) return location.file === file ? path.posix.basename(file).replace(/^\.+/, "") : file;
  if (location.folder === "") return file;
  return file.startsWith(`${location.folder}/`) ? file.slice(location.folder.length + 1) : file;
}
const accepted = (record, config, file) => !dotted(belowTypePath(config, record.set?.type, file)) && (Boolean(setArtifact(record, file)) || listedArtifactType(artifactLocations(config), file) === record.set?.type);
const setArtifact = (record, file) => (record.set?.artifacts ?? []).find((artifact) => relativePath(artifact.path) === file) ?? null;
async function scopedCheckoutArtifact(run, args, projectRoot) {
  const file = relativePath(args?.path);
  const record = await runOf(projectRoot, run);
  const config = await readWorkflowConfig(projectRoot);
  const storeless = (config.workspace?.store ?? null) === null;
  const own = record ? setArtifact(record, file) : null;
  if (!storeless && !(own && (own.scope ?? null) === null)) return null;
  const missing = () => ({ refusal: { ...refusal(run, `no file of the checkout is at ${JSON.stringify(file)}.`), code: "artifact_not_found" } });
  if (file.split("/").includes(".git")) return { refusal: refusal(run, "get_artifact reads no Git folder.") };
  const root = await realpath(projectRoot);
  const target = path.join(root, ...file.split("/"));
  const real = await realOrNull(target);
  if (real === null) return missing();
  const reached = real.startsWith(`${root}${path.sep}`) ? path.relative(root, real).split(path.sep).join("/") : null;
  if (reached === null || reached.split("/").includes(".git") || !record || !accepted(record, config, reached)) return { refusal: refusal(run, `${JSON.stringify(file)} leads outside the run's artifacts.`) };
  const info = await lstat(real);
  if (!info.isFile()) return { refusal: refusal(run, `${JSON.stringify(file)} is no file.`) };
  if (info.size > CHECKOUT_FILE_MAX) return { refusal: { ...refusal(run, `${JSON.stringify(file)} is larger than 1 MiB.`), code: "artifact_too_large" } };
  const bytes = await readFile(real);
  return { artifact: { path: file, scope: null, content: bytes.toString("utf8"), version: artifactVersion(bytes) } };
}
export {
  migrationProjectOf,
  migrationScopeOf,
  scopeRefusal,
  scopedCheckoutArtifact,
  scopedProjectRoot,
  scopedTools
};
