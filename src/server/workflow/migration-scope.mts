import path from "node:path";
import { MIGRATION_RUN_TOOLS, MIGRATION_SCOPE_VARIABLE } from "../session/launch-hosts.mjs";
import { artifactLocations, artifactTypeOf } from "./artifact-check.mjs";
import { readRun } from "./migration-runs.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// A Prism server that a format migration run's session started, with PRISM_MIGRATION_RUN naming the run, serves that run only:
// it lists and takes only the run's tools, each for that run in a project that holds it, and get_artifact only for an artifact of the run's set
// or a path under its type's configured path, where the run's targets lie. Artifact text that others wrote reaches that session,
// so nothing it is told can make Prism change another artifact, the roadmap, an initiative, a review, or coordination state.

/** The run that the environment scopes this server to, or null for a server that serves every tool. */
export function migrationScopeOf(env = process.env) {
  const run = env?.[MIGRATION_SCOPE_VARIABLE];
  return typeof run === "string" && run ? run : null;
}

/** The tools a server lists: all of them, or only the run's own under a scope. */
export function scopedTools(tools: any, run: any) {
  return run === null ? tools : tools.filter((tool: any) => MIGRATION_RUN_TOOLS.includes(tool.name));
}

const refusal = (run: any, message: any) => ({ code: "migration_scope", message: `This session serves the format migration run ${run} only: ${message}`, run });

// A project-relative path as an artifact address names it, or null for one that leaves the project.
function relativePath(value: any) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const normal = path.posix.normalize(value.replaceAll("\\", "/"));
  return normal === "." || normal === ".." || normal.startsWith("../") ? null : normal.replace(/^\.\//, "");
}

/**
 * The refusal of a tool call under the scope of run, or null for a call the scope takes: { code: "migration_scope", message, run }.
 * projectRoot is the call's project root as Prism resolved it.
 */
export async function scopeRefusal(run: any, name: any, args: any, projectRoot: any) {
  if (!MIGRATION_RUN_TOOLS.includes(name)) return refusal(run, `it calls only ${MIGRATION_RUN_TOOLS.join(", ")}, not ${String(name)}.`);
  if (name !== "get_artifact" && args?.run !== run) return refusal(run, `${name} is taken only for that run.`);
  let record;
  try {
    record = await readRun(projectRoot, run);
  } catch {
    record = null;
  }
  if (!record) return refusal(run, "the project named holds no such run.");
  if (name !== "get_artifact") return null;
  const file = relativePath(args?.path);
  const set = record.set ?? {};
  if (file !== null && (set.artifacts ?? []).some((artifact: any) => relativePath(artifact.path) === file)) return null;
  const config = await readWorkflowConfig(projectRoot);
  if (file !== null && artifactTypeOf(artifactLocations(config), file) === set.type) return null;
  return refusal(run, `get_artifact reads only the run's artifacts and paths under the configured path of its type, not ${JSON.stringify(String(args?.path ?? ""))}.`);
}
