// Generated from src/server/repository-intelligence/background-preparation.mts by scripts/native-build/compile.mjs.
import { prepareNativeProvider } from "./semantic-native-provider.mjs";
import { nativeSemanticRuntime, privateDirectory } from "./native-semantic-runtime.mjs";
import { ProgressRecorder } from "./index-progress.mjs";
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { indexComponents } from "./component-indexes.mjs";
const started = /* @__PURE__ */ new Map();
async function prepareProject(projectRoot) {
  if (await indexComponents(projectRoot)) return;
  await prepareNativeProvider(projectRoot, { waitMs: 0 });
}
async function backgroundIndexingEnabled(projectRoot) {
  const config = await readWorkflowConfig(projectRoot).catch(() => null);
  const value = config?.sections?.["Repository intelligence"]?.["Background indexing"];
  return typeof value !== "string" || value.trim().toLowerCase() !== "off";
}
async function runtimeAvailable() {
  const availability = await nativeSemanticRuntime.availability();
  return availability.supported && availability.published;
}
async function recordFailure(projectRoot, error) {
  const location = await nativeSemanticRuntime.location(projectRoot);
  if (["waiting", "preparing"].includes(nativeSemanticRuntime.jobs.get(location.directory)?.status ?? "")) return;
  await privateDirectory(location.directory);
  await new ProgressRecorder(location.directory, "background").fail([{
    code: typeof error.code === "string" ? error.code : "preparation_failed",
    message: error.message,
    recovery: "Retry preparation after correcting the reported runtime, network, or source problem."
  }]);
}
function startBackgroundPreparation(projectRoot, options = {}) {
  const existing = started.get(projectRoot);
  if (existing) return existing;
  const { prepare = prepareProject, enabled = backgroundIndexingEnabled, available = runtimeAvailable, record = recordFailure } = options;
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
  const { prepare = prepareProject, available = runtimeAvailable, record = recordFailure } = options;
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
