// Generated from src/server/repository-intelligence/background-preparation.mts by scripts/native-build/compile.mjs.
import { realpath } from "node:fs/promises";
import { prepareNativeProvider } from "./semantic-native-provider.mjs";
import { nativeSemanticRuntime, privateDirectory } from "./native-semantic-runtime.mjs";
import { ProgressRecorder, readProgressRecords } from "./index-progress.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { componentSources, indexComponents } from "./component-indexes.mjs";
const started = /* @__PURE__ */ new Map();
const time = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};
async function prepareComponentIndexes(projectRoot, declaration, runtime, rebuild, retryLimited = rebuild) {
  const root = await realpath(projectRoot), chosen = [], identity = rebuild && !retryLimited ? (await runtime.manifest()).identity : "";
  for (const entry of componentSources(root, declaration)) {
    const snapshot = await entry.source.snapshot();
    if (!snapshot.files.length) continue;
    const component = { name: entry.name, identity: entry.component, folder: entry.folder };
    const { directory } = await runtime.location(root, component);
    const published = await runtime.published(directory), indexed = Boolean(published?.snapshot);
    const outOfDate = indexed && published.snapshot !== snapshot.sourceFingerprint;
    const records = rebuild ? await readProgressRecords(directory) : [];
    const failed = rebuild && (runtime.jobs.get(directory)?.status === "degraded" || records.some((record) => record.state === "failed" && (!indexed || time(record.finishedAt ?? record.updatedAt) > time(published.builtAt))));
    const id = identity && runtime.componentPreparationId(directory, snapshot.sourceFingerprint, identity);
    const limited = Boolean(id) && (runtime.jobs.get(directory)?.failure?.code === "resource_limit" && runtime.jobs.get(directory)?.snapshot === snapshot.sourceFingerprint || records.some((record) => record.state === "failed" && record.preparationId === id && record.diagnostics.some((item) => item.code === "resource_limit")));
    if ((outOfDate || failed) && !limited) chosen.push({ source: entry.source, component });
  }
  if (chosen.length) await runtime.prepareComponents(chosen, 0, { retryLimited });
}
function preparation(runtime, rebuild, retryLimited = rebuild) {
  return async (projectRoot) => {
    const declaration = await indexComponents(projectRoot);
    if (declaration) return prepareComponentIndexes(projectRoot, declaration, runtime, rebuild, retryLimited);
    await prepareNativeProvider(projectRoot, { waitMs: 0, runtime });
  };
}
async function backgroundIndexingEnabled(projectRoot) {
  const config = await readWorkflowConfig(projectRoot).catch(() => null);
  const value = config?.sections?.["Repository intelligence"]?.["Background indexing"];
  return typeof value !== "string" || value.trim().toLowerCase() !== "off";
}
function runtimeAvailable(runtime) {
  return async () => {
    const availability = await runtime.availability();
    return availability.supported && availability.published;
  };
}
const recordFailure = (runtime) => async (projectRoot, error) => {
  const location = await runtime.location(projectRoot);
  if (["waiting", "preparing"].includes(runtime.jobs.get(location.directory)?.status ?? "")) return;
  await privateDirectory(location.directory);
  await new ProgressRecorder(location.directory, "background").fail([{
    code: typeof error.code === "string" ? error.code : "preparation_failed",
    message: error.message,
    recovery: "Retry preparation after correcting the reported runtime, network, or source problem."
  }]);
};
function startBackgroundPreparation(projectRoot, options = {}) {
  const existing = started.get(projectRoot);
  if (existing) return existing;
  const { runtime = nativeSemanticRuntime } = options;
  const { prepare = preparation(runtime, false), enabled = backgroundIndexingEnabled, available = runtimeAvailable(runtime), record = recordFailure(runtime) } = options;
  const run = (async () => {
    if (!await enabled(projectRoot) || !await available()) return;
    try {
      await prepare(projectRoot);
    } catch (error) {
      await record(projectRoot, error);
    }
  })().catch(() => {
  });
  started.set(projectRoot, run);
  return run;
}
const rebuilding = /* @__PURE__ */ new Map();
function startIndexRebuild(projectRoot, options = {}) {
  const existing = rebuilding.get(projectRoot);
  if (existing) return existing;
  const { runtime = nativeSemanticRuntime } = options;
  const { prepare = preparation(runtime, true, !options.automatic), available = runtimeAvailable(runtime), record = recordFailure(runtime) } = options;
  const run = (async () => {
    if (!await available()) return;
    try {
      await prepare(projectRoot);
    } catch (error) {
      await record(projectRoot, error);
    }
  })().catch(() => {
  }).finally(() => {
    rebuilding.delete(projectRoot);
  });
  rebuilding.set(projectRoot, run);
  return run;
}
function resetBackgroundPreparation() {
  started.clear();
  rebuilding.clear();
}
export {
  backgroundIndexingEnabled,
  resetBackgroundPreparation,
  startBackgroundPreparation,
  startIndexRebuild
};
