import { readWorkflowConfig } from "../workflow/workflow-config.mjs";
import { openAtStartDisabled } from "./review-app-discovery.mjs";

// Cloud, CI, print-mode, and display-less sessions run the review app too, but nobody there can see a window it opens.
function canShowWindow(env, platform) {
  if (env.CLAUDE_CODE_REMOTE === "true" || env.CI) return false;
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? "")) return false;
  return platform === "darwin" || platform === "win32" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// Answers whether this session opens the review browser at start: only where someone can see it, and not when the user or the project
// turned it off or chose the internal browser, which only the agent can open.
export async function opensAtStart(projectRoot, { env = process.env, platform = process.platform } = {}) {
  if (openAtStartDisabled(env) || !canShowWindow(env, platform)) return false;
  const interaction = await readWorkflowConfig(projectRoot).then((config) => config.sections.Interaction ?? {}, () => ({}));
  if (/^internal$/i.test(interaction["Review browser"] ?? "")) return false;
  return !/^off$/i.test(interaction["Review browser on start"] ?? "");
}
