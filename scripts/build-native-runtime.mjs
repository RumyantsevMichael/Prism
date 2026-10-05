import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, cp, readdir, readFile, writeFile, lstat, rm, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(new URL("./native-build/package.json", import.meta.url));
const { c } = require("tar"), { build } = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, [path.join(root, "scripts/native-build/compile.mjs"), "--check"], { stdio: "inherit" });
const { patchCodeGraph, PATCH_VERSION } = await import("../native-runtime/patch-codegraph.mjs");
const output = path.resolve(process.argv[2] || path.join(root, "dist/native"));
const platform = `${process.platform}-${process.arch}`;
const staging = path.join(output, `prism-native-${platform}`);
const sha = value => createHash("sha256").update(value).digest("hex");
await mkdir(output, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging);
await cp(path.join(root, "vendor/native-runtime/licenses"), path.join(staging, "licenses"), { recursive: true });
await cp(path.join(root, "native-runtime/node_modules"), path.join(staging, "node_modules"), { recursive: true, filter: source => !source.split(path.sep).includes(".bin") });
for (const entry of await readdir(path.join(root, "native-runtime"))) if (entry.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(entry)) await cp(path.join(root, "native-runtime", entry), path.join(staging, entry));
const graphPackage = path.join(staging, `node_modules/@colbymchenry/codegraph-${platform}`);
const nodeName = process.platform === "win32" ? "node.exe" : "node";
await cp(path.join(graphPackage, nodeName), path.join(staging, nodeName));
await rm(path.join(graphPackage, nodeName));
const ortPlatforms = path.join(staging, "node_modules/onnxruntime-node/bin/napi-v6");
for (const name of await readdir(ortPlatforms)) if (name !== process.platform) await rm(path.join(ortPlatforms, name), { recursive: true, force: true });
for (const name of await readdir(path.join(ortPlatforms, process.platform))) if (name !== process.arch) await rm(path.join(ortPlatforms, process.platform, name), { recursive: true, force: true });
await chmod(path.join(staging, nodeName), 0o700);
const nodeVersion = execFileSync(path.join(staging, nodeName), ["--version"], { encoding: "utf8" }).trim().replace(/^v/, "");
if (nodeVersion !== "24.16.0") throw new Error(`Unexpected bundled Node ${nodeVersion}.`);
const patches = await patchCodeGraph(path.join(graphPackage, "lib/dist"));
await writeFile(path.join(staging, "patches.json"), JSON.stringify({ version: PATCH_VERSION, patches }, null, 2));
const files = {}, licenses = [];
let unpackedBytes = 0;
async function inventory(directory) {
  for (const entry of (await readdir(directory)).sort()) {
    const file = path.join(directory, entry), info = await lstat(file), relative = path.relative(staging, file).split(path.sep).join("/");
    if (info.isSymbolicLink()) throw new Error(`Runtime packages must not contain symlinks: ${relative}`);
    if (info.isDirectory()) await inventory(file);
    else {
      const bytes = await readFile(file); files[relative] = sha(bytes); unpackedBytes += bytes.length;
      if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(entry)) licenses.push(relative);
    }
  }
}
await inventory(staging);
const dependencies = JSON.parse(await readFile(path.join(staging, "package.json"), "utf8")).dependencies;
await writeFile(path.join(staging, "runtime.json"), JSON.stringify({ schemaVersion: 1, platform, node: nodeVersion, dependencies, patchVersion: PATCH_VERSION, licenses, files }));
unpackedBytes += (await lstat(path.join(staging, "runtime.json"))).size;
const archive = path.join(output, `prism-native-${platform}.tar.gz`);
await c({ file: archive, cwd: staging, gzip: true, portable: true, mtime: new Date(0) }, (await readdir(staging)).sort());
const bytes = await readFile(archive);
const asset = { url: process.env.PRISM_NATIVE_RELEASE_BASE ? `${process.env.PRISM_NATIVE_RELEASE_BASE}/${path.basename(archive)}` : pathToFileURL(archive).href, bytes: bytes.length, sha256: sha(bytes), unpackedBytes };
await writeFile(path.join(output, `${platform}.json`), JSON.stringify({ [platform]: asset }, null, 2));
await build({ entryPoints: [path.join(root, "scripts/native-build/extract.mjs")], outfile: path.join(root, "vendor/native-runtime/extract.mjs"), bundle: true, platform: "node", format: "esm", minify: true, banner: { js: '// Bundled tar archive reader. See licenses.json for third-party licenses.\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
const buildLicenses = {};
async function collectLicenses(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), info = await lstat(file);
    if (info.isDirectory()) await collectLicenses(file);
    else if (/^licen[cs]e(\.|$)/i.test(name)) buildLicenses[path.relative(path.join(root, "scripts/native-build/node_modules"), file)] = await readFile(file, "utf8");
  }
}
await collectLicenses(path.join(root, "scripts/native-build/node_modules"));
await writeFile(path.join(root, "vendor/native-runtime/licenses.json"), JSON.stringify(buildLicenses, null, 2));
process.stdout.write(`${JSON.stringify({ platform, archive, ...asset })}\n`);
