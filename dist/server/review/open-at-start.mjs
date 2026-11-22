// Generated from src/server/review/open-at-start.mts by scripts/native-build/compile.mjs.
import { readPersonalSettings } from "../workflow/personal-settings.mjs";
import { openAtStartDisabled } from "./review-app-discovery.mjs";
function canShowWindow(env, platform) {
  if (env.CLAUDE_CODE_REMOTE === "true" || env.CI) return false;
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? "")) return false;
  return platform === "darwin" || platform === "win32" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
async function opensAtStart(projectRoot, { env = process.env, platform = process.platform } = {}) {
  if (openAtStartDisabled(env) || !canShowWindow(env, platform)) return false;
  const personal = await readPersonalSettings({ projectRoot, env }).catch(() => null);
  if (!personal) return true;
  return personal.settings.reviewBrowser !== "internal" && personal.settings.reviewBrowserOnStart === "on";
}
export {
  opensAtStart
};
