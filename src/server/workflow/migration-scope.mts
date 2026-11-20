import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { MIGRATION_PROJECT_VARIABLE, MIGRATION_RUN_TOOLS, MIGRATION_SCOPE_VARIABLE } from "../session/launch-hosts.mjs";
import { artifactLocations, artifactTypeOf } from "./artifact-check.mjs";
import { readRun } from "./migration-runs.mjs";
import { artifactVersion } from "./store-artifacts.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// A Prism server that a format migration run's session started, with PRISM_MIGRATION_RUN naming the run, serves that run only:
// it lists and takes only the run's tools, each for that run, and get_artifact only for an artifact of the run's set or a path under its type's
// configured path, where the run's targets lie. The session works outside the checkout and reads none of it, so PRISM_MIGRATION_PROJECT names
// the project, a call may leave projectRoot out, and get_artifact reads the run's checkout files itself, also without a store.
// Artifact text that others wrote reaches that session, so nothing it is told can make Prism change another artifact, the roadmap,
// an initiative, a review, or coordination state, or hand it another file of the checkout, such as .env or .git/config.

const CHECKOUT_FILE_MAX = 1024 * 1024;

/** The run that the environment scopes this server to, or null for a server that serves every tool. */
export function migrationScopeOf(env = process.env) {
  const run = env?.[MIGRATION_SCOPE_VARIABLE];
  return typeof run === "string" && run ? run : null;
}

/** The project that the environment names for a scoped server, or null. */
export function migrationProjectOf(env = process.env) {
  const project = env?.[MIGRATION_PROJECT_VARIABLE];
  return typeof project === "string" && path.isAbsolute(project) ? project : null;
}

/** The tools a server lists: all of them, or only the run's own under a scope, whose projectRoot the launch gives, so a call may leave it out. */
export function scopedTools(tools: any, run: any) {
  if (run === null) return tools;
  return tools.filter((tool: any) => MIGRATION_RUN_TOOLS.includes(tool.name)).map((tool: any) => {
    const required = tool.inputSchema?.required;
    if (!Array.isArray(required) || !required.includes("projectRoot")) return tool;
    return { ...tool, inputSchema: { ...tool.inputSchema, required: required.filter((name: string) => name !== "projectRoot") } };
  });
}

const refusal = (run: any, message: any) => ({ code: "migration_scope", message: `This session serves the format migration run ${run} only: ${message}`, run });

// A project-relative path as an artifact address names it, or null for one that leaves the project.
function relativePath(value: any) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const normal = path.posix.normalize(value.replaceAll("\\", "/"));
  return normal === "." || normal === ".." || normal.startsWith("../") ? null : normal.replace(/^\.\//, "").replace(/\/$/, "");
}

async function realOrNull(folder: string) {
  try {
    return await realpath(folder);
  } catch {
    return null;
  }
}

/**
 * The project root of a scoped call: the launch's project, which a call may leave out, or { refusal } for a projectRoot that names another folder.
 * Without a project in the environment, the root that fallback resolves.
 */
export async function scopedProjectRoot(run: any, project: string | null, args: any, fallback: () => Promise<string>) {
  if (project === null) return { root: await fallback() };
  const own = await realOrNull(project);
  if (own === null) return { refusal: refusal(run, `its project ${project} cannot be read.`) };
  if (args?.projectRoot === undefined) return { root: own };
  const named = typeof args.projectRoot === "string" && path.isAbsolute(args.projectRoot) ? await realOrNull(args.projectRoot) : null;
  if (named !== own) return { refusal: refusal(run, `projectRoot names ${JSON.stringify(String(args.projectRoot))}, not the run's project.`) };
  return { root: own };
}

/**
 * The refusal of a tool call under the scope of run, or null for a call the scope takes: { code: "migration_scope", message, run }.
 * projectRoot is the call's project root as Prism resolved it.
 */
export async function scopeRefusal(run: any, name: any, args: any, projectRoot: any) {
  if (!MIGRATION_RUN_TOOLS.includes(name)) return refusal(run, `it calls only ${MIGRATION_RUN_TOOLS.join(", ")}, not ${String(name)}.`);
  if (name !== "get_artifact" && args?.run !== run) return refusal(run, `${name} is taken only for that run.`);
  const record = await runOf(projectRoot, run);
  if (!record) return refusal(run, "the project named holds no such run.");
  if (name !== "get_artifact") return null;
  const file = relativePath(args?.path);
  if (file !== null && accepted(record, await readWorkflowConfig(projectRoot), file)) return null;
  return refusal(run, `get_artifact reads only the run's artifacts and paths under the configured path of its type, not ${JSON.stringify(String(args?.path ?? ""))}.`);
}

async function runOf(projectRoot: any, run: any) {
  try {
    return await readRun(projectRoot, run);
  } catch {
    return null;
  }
}

// Whether the scope takes a project-relative path: an artifact of the run's set, or a path under the configured path of the set's type.
const accepted = (record: any, config: any, file: string) => Boolean(setArtifact(record, file)) || artifactTypeOf(artifactLocations(config), file) === record.set?.type;

const setArtifact = (record: any, file: string) => (record.set?.artifacts ?? []).find((artifact: any) => relativePath(artifact.path) === file) ?? null;

/**
 * A scoped get_artifact of a checkout file, which scopeRefusal took: { path, scope: null, content, version } as get_artifact reads a store artifact,
 * for a project without a store or a checkout file of the run's set; { refusal } for a file that is no regular file inside the checkout outside .git;
 * or null when the store serves the path.
 */
export async function scopedCheckoutArtifact(run: any, args: any, projectRoot: string) {
  const file = relativePath(args?.path)!;
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
  // A link is followed only to a file that the scope takes by its own path, so no link under an artifact folder hands over another checkout file.
  const reached = real.startsWith(`${root}${path.sep}`) ? path.relative(root, real).split(path.sep).join("/") : null;
  if (reached === null || reached.split("/").includes(".git") || !record || !accepted(record, config, reached)) return { refusal: refusal(run, `${JSON.stringify(file)} leads outside the run's artifacts.`) };
  const info = await lstat(real);
  if (!info.isFile()) return { refusal: refusal(run, `${JSON.stringify(file)} is no file.`) };
  if (info.size > CHECKOUT_FILE_MAX) return { refusal: { ...refusal(run, `${JSON.stringify(file)} is larger than 1 MiB.`), code: "artifact_too_large" } };
  const bytes = await readFile(real);
  return { artifact: { path: file, scope: null, content: bytes.toString("utf8"), version: artifactVersion(bytes) } };
}
