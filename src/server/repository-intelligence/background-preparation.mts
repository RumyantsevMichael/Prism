import { prepareNativeProvider } from "./semantic-native-provider.mjs";
import { nativeSemanticRuntime, privateDirectory } from "./native-semantic-runtime.mjs";
import { ProgressRecorder } from "./index-progress.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";

interface Options {
  prepare?: (projectRoot: string) => Promise<unknown>;
  enabled?: (projectRoot: string) => Promise<boolean>;
  available?: () => Promise<boolean>;
  record?: (projectRoot: string, error: Error & { code?: unknown }) => Promise<void>;
}

const started = new Map<string, Promise<void>>();

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
  if (nativeSemanticRuntime.jobs.get(location.root)?.status === "preparing") return;
  await privateDirectory(location.directory);
  await new ProgressRecorder(location.directory, "background").fail([{ code: typeof error.code === "string" ? error.code : "preparation_failed", message: error.message,
    recovery: "Retry preparation after correcting the reported runtime, network, or source problem." }]);
}

// Starts index preparation for a project once per process and returns at once, so startup and tool calls never wait for it.
// The runtime shares a preparation between callers with the same snapshot, so a later search joins this build instead of starting another.
export function startBackgroundPreparation(projectRoot: string, options: Options = {}): Promise<void> {
  const existing = started.get(projectRoot);
  if (existing) return existing;
  const { prepare = (root: string) => prepareNativeProvider(root, { waitMs: 0 }), enabled = backgroundIndexingEnabled, available = runtimeAvailable, record = recordFailure } = options;
  const run = (async () => {
    if (!await enabled(projectRoot) || !await available()) return;
    try { await prepare(projectRoot); } catch (error) { await record(projectRoot, error); }
  })().catch(() => {});
  started.set(projectRoot, run);
  return run;
}

export function resetBackgroundPreparation() { started.clear(); }
