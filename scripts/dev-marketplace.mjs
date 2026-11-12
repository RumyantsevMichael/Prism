import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repository's marketplace files describe what users install, which need not be this working tree.
// This writes a separate marketplace whose only plugin is a copy of the working tree, for local development and CI.
// It copies rather than links: Claude Code does not run the hooks of a plugin whose directory is a link.
const PLUGIN_DIRECTORY = "prism";
const MARKER = ".prism-dev-marketplace";
const CATALOGS = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
const LOCAL_SOURCES = {
  ".claude-plugin/marketplace.json": `./${PLUGIN_DIRECTORY}`,
  ".agents/plugins/marketplace.json": { source: "local", path: `./${PLUGIN_DIRECTORY}` }
};

// Version control data, installed dependencies, and built runtime archives are not part of the plugin.
function included(relative) {
  const parts = relative.split(path.sep);
  return !parts.includes(".git") && !parts.includes("node_modules") && !relative.startsWith(path.join("dist", "native") + path.sep) && relative !== path.join("dist", "native");
}

// The directory is replaced, so only an empty or missing one, or an earlier development marketplace, is accepted.
async function prepare(directory, root) {
  const relative = path.relative(root, directory);
  if (!relative || !relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error(`Choose a directory outside the checkout, not ${directory}.`);
  const entries = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  if (entries.length && !entries.includes(MARKER)) throw new Error(`${directory} is not empty and is not a development marketplace.`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, MARKER), "");
}

export async function writeDevMarketplace(directory, checkout) {
  const root = path.resolve(checkout);
  directory = path.resolve(directory);
  await prepare(directory, root);
  await cp(root, path.join(directory, PLUGIN_DIRECTORY), { recursive: true, filter: source => included(path.relative(root, source)) });
  for (const catalog of CATALOGS) {
    const marketplace = JSON.parse(await readFile(path.join(checkout, catalog), "utf8"));
    const plugins = marketplace.plugins.map(plugin => ({ ...plugin, source: LOCAL_SOURCES[catalog] }));
    await mkdir(path.dirname(path.join(directory, catalog)), { recursive: true });
    await writeFile(path.join(directory, catalog), `${JSON.stringify({ ...marketplace, plugins }, null, 2)}\n`);
  }
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const directory = path.resolve(process.argv[2] || path.join(os.tmpdir(), "prism-dev-marketplace"));
  process.stdout.write(`${await writeDevMarketplace(directory, checkout)}\n`);
}
