import { prepareNativeProvider } from "./semantic-native-provider.mjs";
import { nativeSemanticRuntime, privateDirectory } from "./native-semantic-runtime.mjs";
import { ProgressRecorder } from "./index-progress.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { indexComponents } from "./component-indexes.mjs";

interface Options {
  prepare?: (projectRoot: string) => Promise<unknown>;
  enabled?: (projectRoot: string) => Promise<boolean>;
  available?: () => Promise<boolean>;
  record?: (projectRoot: string, error: Error & { code?: unknown }) => Promise<void>;
}

const started = new Map<string, Promise<void>>();

// A repository that declares components has no whole-repository index for a tool to read, so this preparation queues no build of the whole
// repository there; an invalid declaration refuses here, as it refuses the native tools, and so prepares nothing.
async function prepareProject(projectRoot: string) {
  if (await indexComponents(projectRoot)) return;
  await prepareNativeProvider(projectRoot, { waitMs: 0 });
}

// A project opts out with "- Background indexing: off" under "## Repository intelligence" in .prism/workflow.md.
export async function backgroundIndexingEnabled(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot).catch(() => null);
  const value = config?.sections?.["Repository intelligence"]?.["Background indexing"];
  return typeof value !== "string" || value.trim().toLowerCase() !== "off";
}

// A platform without a published runtime would only fail, so it keeps the unavailable state the review browser already shows.
async function runtimeAvailable() {
  const availability = await nativeSemanticRuntime.availability();
  return availability.supported && availability.published;
}

// Failures inside a build are recorded by the runtime. A failure before the build starts, such as an unreadable snapshot, is recorded here
// in the same progress file, unless a build for the project is already running in this process and owns that file.
async function recordFailure(projectRoot: string, error: Error & { code?: unknown }) {
  const location = await nativeSemanticRuntime.location(projectRoot);
  if (["waiting", "preparing"].includes(nativeSemanticRuntime.jobs.get(location.directory)?.status ?? "")) return;
  await privateDirectory(location.directory);
  await new ProgressRecorder(location.directory, "background").fail([{ code: typeof error.code === "string" ? error.code : "preparation_failed", message: error.message,
    recovery: "Retry preparation after correcting the reported runtime, network, or source problem." }]);
}

// Starts index preparation for a project once per process and returns at once, so startup and tool calls never wait for it.
// The runtime shares a preparation between callers with the same snapshot, so a later search joins this build instead of starting another.
export function startBackgroundPreparation(projectRoot: string, options: Options = {}): Promise<void> {
  const existing = started.get(projectRoot);
  if (existing) return existing;
  const { prepare = prepareProject, enabled = backgroundIndexingEnabled, available = runtimeAvailable, record = recordFailure } = options;
  const run = (async () => {
    if (!await enabled(projectRoot) || !await available()) return;
    try { await prepare(projectRoot); } catch (error) { await record(projectRoot, error); }
  })().catch(() => {});
  started.set(projectRoot, run);
  return run;
}

const rebuilding = new Map<string, Promise<void>>();

// Starts one rebuild of a project's index and returns at once; a call while one runs in this process joins it, and a later call starts another.
// The review browser uses it when the index went out of date or the person asks, so the line ranges it shows catch up without an agent search.
export function startIndexRebuild(projectRoot: string, options: Omit<Options, "enabled"> = {}): Promise<void> {
  const existing = rebuilding.get(projectRoot);
  if (existing) return existing;
  const { prepare = prepareProject, available = runtimeAvailable, record = recordFailure } = options;
  const run = (async () => {
    if (!await available()) return;
    try { await prepare(projectRoot); } catch (error) { await record(projectRoot, error); }
  })().catch(() => {}).finally(() => { rebuilding.delete(projectRoot); });
  rebuilding.set(projectRoot, run);
  return run;
}

export function resetBackgroundPreparation() { started.clear(); rebuilding.clear(); }
