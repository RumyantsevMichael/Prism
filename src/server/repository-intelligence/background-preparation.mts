import { realpath } from "node:fs/promises";
import { prepareNativeProvider } from "./semantic-native-provider.mjs";
import { nativeSemanticRuntime, privateDirectory } from "./native-semantic-runtime.mjs";
import type { NativeSemanticRuntime } from "./native-semantic-runtime.mjs";
import { ProgressRecorder, readProgressRecords } from "./index-progress.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentSources, indexComponents } from "./component-indexes.mjs";
import type { Declaration } from "./component-indexes.mjs";

interface Options {
  prepare?: (projectRoot: string) => Promise<unknown>;
  enabled?: (projectRoot: string) => Promise<boolean>;
  available?: () => Promise<boolean>;
  record?: (projectRoot: string, error: Error & { code?: unknown }) => Promise<void>;
  runtime?: NativeSemanticRuntime;
}

const started = new Map<string, Promise<void>>();
const time = (value: string | undefined) => { const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : 0; };

// In a repository that declares components, the start refreshes only the components that already have an index in this storage and are out of
// date, so a component that no tool has needed yet is never built in the background. The rebuild also prepares each component whose latest
// preparation failed, with or without an index. A rebuild that the person asks for also prepares one that reached a native limit; an automatic
// rebuild leaves a component whose latest preparation reached a native limit for its current content, in any process, because it would only fail again.
async function prepareComponentIndexes(projectRoot: string, declaration: Declaration, runtime: NativeSemanticRuntime, rebuild: boolean, retryLimited = rebuild) {
  const root = await realpath(projectRoot), chosen = [], identity = rebuild && !retryLimited ? (await runtime.manifest()).identity : "";
  for (const entry of componentSources(root, declaration)) {
    const snapshot = await entry.source.snapshot();
    if (!snapshot.files.length) continue;
    const component = { name: entry.name, identity: entry.component, folder: entry.folder };
    const { directory } = await runtime.location(root, component);
    const published = await runtime.published(directory), indexed = Boolean(published?.snapshot);
    const outOfDate = indexed && published!.snapshot !== snapshot.sourceFingerprint;
    // A failure counts only when it ended after the component's latest index; a job of this process that failed counts as recorded too.
    const records = rebuild ? await readProgressRecords(directory) : [];
    const failed = rebuild && (runtime.jobs.get(directory)?.status === "degraded"
      || records.some(record => record.state === "failed" && (!indexed || time(record.finishedAt ?? record.updatedAt) > time(published!.builtAt))));
    const id = identity && runtime.componentPreparationId(directory, snapshot.sourceFingerprint, identity);
    const limited = Boolean(id) && (runtime.jobs.get(directory)?.failure?.code === "resource_limit" && runtime.jobs.get(directory)?.snapshot === snapshot.sourceFingerprint
      || records.some(record => record.state === "failed" && record.preparationId === id && record.diagnostics.some(item => item.code === "resource_limit")));
    if ((outOfDate || failed) && !limited) chosen.push({ source: entry.source, component });
  }
  if (chosen.length) await runtime.prepareComponents(chosen, 0, { retryLimited });
}

// A repository without components prepares its one index; an invalid declaration refuses here, as it refuses the native tools, and so prepares nothing.
function preparation(runtime: NativeSemanticRuntime, rebuild: boolean, retryLimited = rebuild) {
  return async (projectRoot: string) => {
    const declaration = await indexComponents(projectRoot);
    if (declaration) return prepareComponentIndexes(projectRoot, declaration, runtime, rebuild, retryLimited);
    await prepareNativeProvider(projectRoot, { waitMs: 0, runtime });
  };
}

// A project opts out with "- Background indexing: off" under "## Repository intelligence" in .prism/workflow.md.
export async function backgroundIndexingEnabled(projectRoot: string) {
  const config = await readWorkflowConfig(projectRoot).catch(() => null);
  const value = config?.sections?.["Repository intelligence"]?.["Background indexing"];
  return typeof value !== "string" || value.trim().toLowerCase() !== "off";
}

// A platform without a published runtime would only fail, so it keeps the unavailable state the review browser already shows.
function runtimeAvailable(runtime: NativeSemanticRuntime) {
  return async () => {
    const availability = await runtime.availability();
    return availability.supported && availability.published;
  };
}

// Failures inside a build are recorded by the runtime. A failure before the build starts, such as an unreadable snapshot, is recorded here
// in the same progress file, unless a build for the project is already running in this process and owns that file.
const recordFailure = (runtime: NativeSemanticRuntime) => async (projectRoot: string, error: Error & { code?: unknown }) => {
  const location = await runtime.location(projectRoot);
  if (["waiting", "preparing"].includes(runtime.jobs.get(location.directory)?.status ?? "")) return;
  await privateDirectory(location.directory);
  await new ProgressRecorder(location.directory, "background").fail([{ code: typeof error.code === "string" ? error.code : "preparation_failed", message: error.message,
    recovery: "Retry preparation after correcting the reported runtime, network, or source problem." }]);
};

// Starts index preparation for a project once per process and returns at once, so startup and tool calls never wait for it.
// The runtime shares a preparation between callers with the same snapshot, so a later search joins this build instead of starting another.
export function startBackgroundPreparation(projectRoot: string, options: Options = {}): Promise<void> {
  const existing = started.get(projectRoot);
  if (existing) return existing;
  const { runtime = nativeSemanticRuntime } = options;
  const { prepare = preparation(runtime, false), enabled = backgroundIndexingEnabled, available = runtimeAvailable(runtime), record = recordFailure(runtime) } = options;
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
// `automatic` marks the review browser's own rebuild, which leaves a component that reached a native limit for its current content.
export function startIndexRebuild(projectRoot: string, options: Omit<Options, "enabled"> & { automatic?: boolean } = {}): Promise<void> {
  const existing = rebuilding.get(projectRoot);
  if (existing) return existing;
  const { runtime = nativeSemanticRuntime } = options;
  const { prepare = preparation(runtime, true, !options.automatic), available = runtimeAvailable(runtime), record = recordFailure(runtime) } = options;
  const run = (async () => {
    if (!await available()) return;
    try { await prepare(projectRoot); } catch (error) { await record(projectRoot, error); }
  })().catch(() => {}).finally(() => { rebuilding.delete(projectRoot); });
  rebuilding.set(projectRoot, run);
  return run;
}

export function resetBackgroundPreparation() { started.clear(); rebuilding.clear(); }
