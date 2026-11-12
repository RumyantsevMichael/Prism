import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const pluginPath = (...segments) => path.join(PLUGIN_ROOT, ...segments);
export const pluginURL = (...segments) => pathToFileURL(pluginPath(...segments));

// The installed plugin's release version, or null when the manifest cannot be read.
export function pluginVersion() {
  try {
    const { version } = JSON.parse(readFileSync(pluginPath(".claude-plugin", "plugin.json"), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
