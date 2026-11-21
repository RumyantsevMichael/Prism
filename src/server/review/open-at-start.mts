import { readPersonalSettings } from "../workflow/personal-settings.mjs";
import { openAtStartDisabled } from "./review-app-discovery.mjs";

// Cloud, CI, print-mode, and display-less sessions run the review app too, but nobody there can see a window it opens.
function canShowWindow(env: NodeJS.ProcessEnv, platform: any) {
  if (env.CLAUDE_CODE_REMOTE === "true" || env.CI) return false;
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? "")) return false;
  return platform === "darwin" || platform === "win32" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// Answers whether this session opens the review browser at start: only where someone can see it, and not when the person's own settings, or a value their project records,
// turned it off or chose the internal browser, which only the agent can open.
export async function opensAtStart(projectRoot: string, { env = process.env, platform = process.platform }: any = {}) {
  if (openAtStartDisabled(env) || !canShowWindow(env, platform)) return false;
  const personal = await readPersonalSettings({ projectRoot, env }).catch(() => null);
  if (!personal) return true;
  return personal.settings.reviewBrowser !== "internal" && personal.settings.reviewBrowserOnStart === "on";
}
