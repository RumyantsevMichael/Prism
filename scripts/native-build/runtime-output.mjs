import path from "node:path";
import { readdir, readFile, writeFile, mkdir, rm, stat, chmod } from "node:fs/promises";
import { transform } from "esbuild";

const directories = ["server", "native-runtime", "hooks"];

async function files(directory, source = false) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || (source && entry.name === "test")) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file, source));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Runtime output must not contain symlinks: ${file}`);
  }
  return result;
}

async function pruneEmptyDirectories(directory, isRoot = true) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) if (entry.isDirectory() && entry.name !== "node_modules") await pruneEmptyDirectories(path.join(directory, entry.name), false);
  if (!isRoot && (await readdir(directory)).length === 0) await rm(directory, { recursive: true });
}

export async function generateRuntime(root, { check = false } = {}) {
  for (const directory of directories) {
    const sourceRoot = path.join(root, "src", directory);
    const destinationRoot = path.join(root, "dist", directory);
    const expected = new Map();
    for (const source of await files(sourceRoot, true)) {
      const relative = path.relative(sourceRoot, source);
      if (["package.json", "package-lock.json"].includes(relative) || relative.endsWith("-types.mts")) continue;
      if (relative.endsWith(".mts") && !relative.endsWith(".d.mts")) {
        const output = await transform(await readFile(source, "utf8"), { loader: "ts", format: "esm", target: "node22", minify: false, legalComments: "inline" });
        const generated = `// Generated from ${path.relative(root, source).split(path.sep).join("/")} by scripts/native-build/compile.mjs.\n` + output.code;
        expected.set(relative.replace(/\.mts$/, ".mjs"), { bytes: Buffer.from(generated), mode: (await stat(source)).mode });
      } else if (!/\.(?:mts|ts|map)$/.test(relative)) {
        expected.set(relative, { bytes: await readFile(source), mode: (await stat(source)).mode });
      }
    }
    const actual = new Set((await files(destinationRoot)).map(file => path.relative(destinationRoot, file)));
    for (const [relative, { bytes, mode }] of expected) {
      const destination = path.join(destinationRoot, relative);
      if (check) {
        if (!actual.has(relative)) throw new Error(`Generated runtime file is missing: ${destination}`);
        if (!bytes.equals(await readFile(destination))) throw new Error(`Generated runtime file is stale: ${destination}`);
        if (((await stat(destination)).mode & 0o111) !== (mode & 0o111)) throw new Error(`Generated runtime file mode is stale: ${destination}`);
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        await chmod(destination, mode & 0o777);
      }
      actual.delete(relative);
    }
    for (const relative of actual) {
      const destination = path.join(destinationRoot, relative);
      if (check) throw new Error(`Generated runtime file is obsolete: ${destination}`);
      await rm(destination);
    }
    if (!check) await pruneEmptyDirectories(destinationRoot);
  }
}
