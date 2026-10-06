import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const pluginPath = (...segments) => path.join(PLUGIN_ROOT, ...segments);
export const pluginURL = (...segments) => pathToFileURL(pluginPath(...segments));
