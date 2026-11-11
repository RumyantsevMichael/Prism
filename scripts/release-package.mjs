import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORMS, publishedManifest } from "./native-build/published-manifest.mjs";

// A release installs a package, not this repository: only what runs, with a runtime manifest naming that release's assets.
// The package is committed on its own history line and tagged `prism--v<version>`, and both catalog entries pin that tag and commit.
export const PACKAGE_ENTRIES = [
  ".claude-plugin", ".codex-plugin", ".agents", ".claude-mcp.json", ".codex-mcp.json",
  "skills", "hooks", "dist", "bin", "vendor", "assets",
  "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md"
];
export const PACKAGE_TAG_PREFIX = "prism--v";
export const RUNTIME_MANIFEST = "vendor/native-runtime/manifest.json";
export const RELEASE_IDENTITY = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const CATALOGS = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

export const releaseTag = version => `v${version}`;
export const packageTag = version => `${PACKAGE_TAG_PREFIX}${version}`;
export const releaseBase = (repository, tag) => `https://github.com/${repository}/releases/download/${tag}`;

// Generated runtime output is built in CI rather than committed, so the package takes it from the working tree.
// Everything else is tracked files only, so local and ignored files never ship.
const GENERATED = ["dist/server", "dist/native-runtime", "dist/hooks"];

function trackedFiles(checkout) {
  const entries = PACKAGE_ENTRIES.filter(entry => entry !== "dist");
  const output = execFileSync("git", ["ls-files", "-s", "-z", "--", ...entries], { cwd: checkout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter(Boolean).map(line => {
    const [stage, file] = line.split("\t");
    const mode = stage.split(" ")[0];
    if (mode !== "100644" && mode !== "100755") throw new Error(`Packages hold only regular files: ${file} has mode ${mode}.`);
    return { file, executable: mode === "100755" };
  });
}

// Staged dependencies under dist/native-runtime/node_modules belong to the runtime archive, not the package.
async function generatedFiles(checkout) {
  const found = [];
  async function walk(relative) {
    let entries;
    try { entries = await readdir(path.join(checkout, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) found.push({ file: child, executable: ((await stat(path.join(checkout, child))).mode & 0o111) !== 0 });
      else throw new Error(`Packages hold only regular files: ${child}.`);
    }
  }
  for (const directory of GENERATED) await walk(directory);
  if (!found.some(({ file }) => file === "dist/server/mcp.mjs")) throw new Error("Build the runtime first: npm run build:native.");
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

async function readRecords(directory) {
  return Object.fromEntries(await Promise.all(PLATFORMS.map(async platform => [platform, JSON.parse(await readFile(path.join(directory, `${platform}.json`), "utf8"))])));
}

// Writes the package tree for one release into `out`, which must not exist or must be replaceable.
export async function buildPackage({ checkout, out, repository, tag, metadata }) {
  const files = [...trackedFiles(checkout), ...await generatedFiles(checkout)];
  await rm(out, { recursive: true, force: true });
  for (const { file, executable } of files) {
    const target = path.join(out, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(checkout, file), target);
    if (executable) await chmod(target, 0o755);
  }
  // The tagged catalog still pins the previous package, so the package's own catalog points at itself instead.
  // A marketplace added at a package tag then installs exactly that package.
  await localCatalog(out);
  const original = JSON.parse(await readFile(path.join(checkout, RUNTIME_MANIFEST), "utf8"));
  const manifest = publishedManifest(original, await readRecords(metadata), releaseBase(repository, tag));
  await writeFile(path.join(out, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files: files.length, manifest };
}

async function localCatalog(root) {
  const sources = { ".claude-plugin/marketplace.json": "./", ".agents/plugins/marketplace.json": { source: "local", path: "./" } };
  for (const catalog of CATALOGS) {
    const file = path.join(root, catalog);
    const marketplace = JSON.parse(await readFile(file, "utf8"));
    if (marketplace.plugins?.length !== 1) throw new Error(`${catalog} must list exactly one plugin.`);
    marketplace.plugins[0].source = sources[catalog];
    await writeFile(file, `${JSON.stringify(marketplace, null, 2)}\n`);
  }
}

// Points both catalog entries at one package tag and its commit, keeping the rest of each entry.
export async function pinCatalog(root, repository, ref, sha) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Supply the GitHub repository as owner/name.");
  if (!ref.startsWith(PACKAGE_TAG_PREFIX)) throw new Error(`Pin a package tag such as ${PACKAGE_TAG_PREFIX}1.2.3, not ${ref}.`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Pin the package commit's full SHA.");
  const sources = {
    ".claude-plugin/marketplace.json": { source: "github", repo: repository, ref, sha },
    ".agents/plugins/marketplace.json": { source: "url", url: `https://github.com/${repository}.git`, ref, sha }
  };
  for (const catalog of CATALOGS) {
    const file = path.join(root, catalog);
    const marketplace = JSON.parse(await readFile(file, "utf8"));
    if (marketplace.plugins?.length !== 1) throw new Error(`${catalog} must list exactly one plugin.`);
    marketplace.plugins[0].source = sources[catalog];
    await writeFile(file, `${JSON.stringify(marketplace, null, 2)}\n`);
  }
}

// Writes a copy of the catalog whose entries pin the given package, for installing it before the catalog on main moves.
export async function writePinnedCatalog(directory, checkout, repository, ref, sha) {
  await rm(directory, { recursive: true, force: true });
  for (const catalog of CATALOGS) {
    await mkdir(path.dirname(path.join(directory, catalog)), { recursive: true });
    await copyFile(path.join(checkout, catalog), path.join(directory, catalog));
  }
  await pinCatalog(directory, repository, ref, sha);
  return directory;
}

// Commits a package tree as one commit whose parent is the previous package, without touching the checkout's index or work tree.
export function commitPackage(checkout, directory, { parent, message }) {
  const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: checkout, encoding: "utf8" }).trim();
  const index = path.join(path.dirname(directory), `.${path.basename(directory)}.index`);
  const identity = { GIT_AUTHOR_NAME: RELEASE_IDENTITY.name, GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email, GIT_COMMITTER_NAME: RELEASE_IDENTITY.name, GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email };
  const env = { ...process.env, ...identity, GIT_DIR: gitDirectory, GIT_WORK_TREE: directory, GIT_INDEX_FILE: index };
  const git = (...args) => execFileSync("git", args, { cwd: directory, env, encoding: "utf8" }).trim();
  try {
    git("add", "--all", "--force", ".");
    return git("commit-tree", git("write-tree"), ...(parent ? ["-p", parent] : []), "-m", message);
  } finally {
    rmSync(index, { force: true });
  }
}

// Serves a package from a local repository in place of GitHub, so it installs through its pinned catalog before anything is published.
// Git reads the returned configuration through GIT_CONFIG_GLOBAL, which rewrites the repository's GitHub URL to the local one.
export async function servePackage({ checkout, directory, repository, ref, work }) {
  await mkdir(work, { recursive: true });
  const origin = path.join(work, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const sha = commitPackage(checkout, directory, { message: `chore: rehearse package ${ref}` });
  execFileSync("git", ["push", "-q", origin, `${sha}:refs/heads/package`, `${sha}:refs/tags/${ref}`], { cwd: checkout });
  const gitconfig = path.join(work, "gitconfig");
  // Claude Code clones over SSH when it finds SSH set up, so every GitHub spelling of the repository is rewritten.
  const spellings = [`https://github.com/${repository}.git`, `git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git`];
  await writeFile(gitconfig, `[url "${pathToFileURL(origin).href}"]\n${spellings.map(url => `\tinsteadOf = ${url}\n`).join("")}`);
  const catalog = await writePinnedCatalog(path.join(work, "catalog"), checkout, repository, ref, sha);
  return { sha, catalog, gitconfig };
}

const usage = `Usage:
  node scripts/release-package.mjs build <out> <owner/repo> <release-tag> <metadata-dir>
  node scripts/release-package.mjs pin <owner/repo> <package-tag> <sha> [package-dir]
  node scripts/release-package.mjs catalog <out> <owner/repo> <package-tag> <sha>
  node scripts/release-package.mjs commit <package-dir> <parent-sha|""> <message>
  node scripts/release-package.mjs serve <package-dir> <owner/repo> <package-tag> <work-dir>`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  if (command === "build" && args.length === 4) {
    const [out, repository, tag, metadata] = args;
    const { files, manifest } = await buildPackage({ checkout, out: path.resolve(out), repository, tag, metadata: path.resolve(metadata) });
    process.stdout.write(`${JSON.stringify({ files, assetVersion: manifest.assetVersion })}\n`);
  } else if (command === "pin" && (args.length === 3 || args.length === 4)) {
    const [repository, ref, sha, packageDirectory] = args;
    await pinCatalog(checkout, repository, ref, sha);
    // Development on main uses the runtime of the latest release, so the pin also carries that release's manifest.
    if (packageDirectory) await copyFile(path.join(packageDirectory, RUNTIME_MANIFEST), path.join(checkout, RUNTIME_MANIFEST));
  } else if (command === "catalog" && args.length === 4) {
    const [out, repository, ref, sha] = args;
    process.stdout.write(`${await writePinnedCatalog(path.resolve(out), checkout, repository, ref, sha)}\n`);
  } else if (command === "commit" && args.length === 3) {
    const [directory, parent, message] = args;
    process.stdout.write(`${commitPackage(checkout, path.resolve(directory), { parent: parent || undefined, message })}\n`);
  } else if (command === "serve" && args.length === 4) {
    const [directory, repository, ref, work] = args;
    const served = await servePackage({ checkout, directory: path.resolve(directory), repository, ref, work: path.resolve(work) });
    process.stdout.write(`${Object.entries(served).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  } else {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
}
