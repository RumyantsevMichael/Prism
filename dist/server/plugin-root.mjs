// Generated from src/server/plugin-root.mts by scripts/native-build/compile.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const pluginPath = (...segments) => path.join(PLUGIN_ROOT, ...segments);
const pluginURL = (...segments) => pathToFileURL(pluginPath(...segments));
function pluginVersion() {
  try {
    const { version } = JSON.parse(readFileSync(pluginPath(".claude-plugin", "plugin.json"), "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
export {
  PLUGIN_ROOT,
  pluginPath,
  pluginURL,
  pluginVersion
};
