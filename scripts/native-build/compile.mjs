import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { transform } from "esbuild";
const root = fileURLToPath(new URL("../..", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url)), "--project", path.join(root, "tsconfig.native.json")], { stdio: "inherit" });
const files = (await Promise.all(["server", "native-runtime"].map(async directory => (await readdir(path.join(root, directory))).filter(file => file.endsWith(".mts") && !file.endsWith("-types.mts")).map(file => `${directory}/${file}`)))).flat();
for (const file of files) {
  const output = await transform(await readFile(path.join(root, file), "utf8"), { loader: "ts", format: "esm", target: "node22", minify: false, legalComments: "inline" });
  const generated = `// Generated from ${path.basename(file)} by scripts/native-build/compile.mjs.\n` + output.code;
  const destination = path.join(root, file.replace(/\.mts$/, ".mjs"));
  if (process.argv.includes("--check")) { if (await readFile(destination, "utf8") !== generated) throw new Error(`Generated JavaScript is stale: ${destination}`); }
  else await writeFile(destination, generated);
}
