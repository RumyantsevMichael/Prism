// Generated from src/server/review/open-at-start.mts by scripts/native-build/compile.mjs.
import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { openAtStartDisabled } from "./review-app-discovery.mjs";
function canShowWindow(env, platform) {
  if (env.CLAUDE_CODE_REMOTE === "true" || env.CI) return false;
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? "")) return false;
  return platform === "darwin" || platform === "win32" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
async function opensAtStart(projectRoot, { env = process.env, platform = process.platform } = {}) {
  if (openAtStartDisabled(env) || !canShowWindow(env, platform)) return false;
  const interaction = await readWorkflowConfig(projectRoot).then((config) => config.sections.Interaction ?? {}, () => ({}));
  if (/^internal$/i.test(interaction["Review browser"] ?? "")) return false;
  return !/^off$/i.test(interaction["Review browser on start"] ?? "");
}
export {
  opensAtStart
};
