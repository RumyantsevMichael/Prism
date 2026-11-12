import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLATFORMS } from "./native-build/published-manifest.mjs";
import { buildPackage, commitPackage, pinCatalog, servePackage } from "./release-package.mjs";

const repository = "example/prism";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

async function write(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

// A checkout with one file of each kind the package keeps or leaves out.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-release-package-"));
  await write(root, ".claude-plugin/plugin.json", '{"name":"prism","version":"1.2.3"}\n');
  await write(root, ".claude-plugin/marketplace.json", '{"name":"prism","plugins":[{"name":"prism","source":"./","category":"workflow"}]}\n');
  await write(root, ".agents/plugins/marketplace.json", '{"name":"prism","plugins":[{"name":"prism","source":{"source":"local","path":"./"},"category":"Engineering"}]}\n');
  await write(root, "skills/demo/SKILL.md", "---\nname: demo\n---\n");
  await write(root, "dist/server/mcp.mjs", "export {};\n");
  await write(root, "dist/native/prism-native-linux-x64.tar.gz", "ignored archive");
  await write(root, "dist/native-runtime/node_modules/helper/index.js", "staged dependency");
  await write(root, "bin/prism", "#!/usr/bin/env node\n");
  await chmod(path.join(root, "bin/prism"), 0o755);
  await write(root, "vendor/native-runtime/manifest.json", '{"schemaVersion":1,"assetVersion":"development","bundles":{},"model":{"id":"m","revision":"r","files":[]}}\n');
  await write(root, "src/server.mts", "source\n");
  await write(root, "test/server.test.mjs", "test\n");
  await write(root, "README.md", "# Prism\n");
  await write(root, ".gitignore", "/dist/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  await write(root, "skills/demo/untracked.md", "not committed\n");
  const metadata = path.join(root, "..", `${path.basename(root)}-metadata`);
  await mkdir(metadata, { recursive: true });
  for (const platform of PLATFORMS) {
    await writeFile(path.join(metadata, `${platform}.json`), JSON.stringify({ [platform]: {
      url: `https://github.com/${repository}/releases/download/v1.2.3/prism-native-${platform}.tar.gz`, bytes: 10, sha256: "a".repeat(64), unpackedBytes: 20
    } }));
  }
  return { root, metadata, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(metadata, { recursive: true, force: true })]) };
}

const files = root => git(root, "ls-files").split("\n");

test("the package holds the tracked runtime files and a manifest naming the release's assets", async () => {
  const { root, metadata, cleanup } = await fixture();
  try {
    const out = path.join(root, "..", `${path.basename(root)}-package`);
    await buildPackage({ checkout: root, out, repository, tag: "v1.2.3", metadata });
    const listed = execFileSync("find", [".", "-type", "f"], { cwd: out, encoding: "utf8" }).split("\n").filter(Boolean).map(file => file.slice(2)).sort();
    assert.deepEqual(listed, [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", ".claude-plugin/plugin.json", "README.md", "bin/prism", "dist/server/mcp.mjs", "skills/demo/SKILL.md", "vendor/native-runtime/manifest.json"]);
    assert.ok(files(root).includes("src/server.mts"));
    assert.ok(!files(root).includes("dist/server/mcp.mjs"));
    assert.equal((await stat(path.join(out, "bin/prism"))).mode & 0o111, 0o111);
    const manifest = JSON.parse(await readFile(path.join(out, "vendor/native-runtime/manifest.json"), "utf8"));
    assert.equal(manifest.assetVersion, "v1.2.3");
    assert.equal(manifest.modelMirror, `https://github.com/${repository}/releases/download/v1.2.3`);
    await pinCatalog(root, repository, "prism--v1.2.2", "c".repeat(40));
    await buildPackage({ checkout: root, out, repository, tag: "v1.2.3", metadata });
    assert.equal(JSON.parse(await readFile(path.join(out, ".claude-plugin/marketplace.json"), "utf8")).plugins[0].source, "./");
    assert.deepEqual(JSON.parse(await readFile(path.join(out, ".agents/plugins/marketplace.json"), "utf8")).plugins[0].source, { source: "local", path: "./" });
    assert.equal(manifest.bundles["win32-x64"].url, `https://github.com/${repository}/releases/download/v1.2.3/prism-native-win32-x64.tar.gz`);
    await rm(out, { recursive: true, force: true });
  } finally { await cleanup(); }
});

test("a checkout without built runtime output cannot be packaged", async () => {
  const { root, metadata, cleanup } = await fixture();
  try {
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    const out = path.join(root, "..", `${path.basename(root)}-package`);
    await assert.rejects(buildPackage({ checkout: root, out, repository, tag: "v1.2.3", metadata }), /npm run build:native/);
  } finally { await cleanup(); }
});

test("bundles built for another release cannot enter the package", async () => {
  const { root, metadata, cleanup } = await fixture();
  try {
    const out = path.join(root, "..", `${path.basename(root)}-package`);
    await assert.rejects(buildPackage({ checkout: root, out, repository, tag: "v1.2.4", metadata }), /Invalid published asset metadata/);
  } finally { await cleanup(); }
});

test("pinning replaces only each entry's source", async () => {
  const { root, cleanup } = await fixture();
  try {
    await pinCatalog(root, repository, "prism--v1.2.3", "b".repeat(40));
    const claude = JSON.parse(await readFile(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
    const codex = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
    assert.deepEqual(claude.plugins[0], { name: "prism", source: { source: "github", repo: repository, ref: "prism--v1.2.3", sha: "b".repeat(40) }, category: "workflow" });
    assert.deepEqual(codex.plugins[0], { name: "prism", source: { source: "url", url: `https://github.com/${repository}.git`, ref: "prism--v1.2.3", sha: "b".repeat(40) }, category: "Engineering" });
    await assert.rejects(pinCatalog(root, repository, "v1.2.3", "b".repeat(40)), /package tag/);
    await assert.rejects(pinCatalog(root, repository, "prism--v1.2.3", "main"), /full SHA/);
  } finally { await cleanup(); }
});

test("a package commit continues the package line and leaves the checkout untouched", async () => {
  const { root, metadata, cleanup } = await fixture();
  try {
    const out = path.join(root, "..", `${path.basename(root)}-package`);
    await buildPackage({ checkout: root, out, repository, tag: "v1.2.3", metadata });
    const status = git(root, "status", "--porcelain");
    const first = commitPackage(root, out, { message: "chore: package 1.2.3" });
    const second = commitPackage(root, out, { parent: first, message: "chore: package 1.2.4" });
    assert.equal(git(root, "rev-parse", `${second}^`), first);
    assert.equal(git(root, "status", "--porcelain"), status);
    assert.deepEqual(git(root, "ls-tree", "-r", "--name-only", first).split("\n").sort(), [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", ".claude-plugin/plugin.json", "README.md", "bin/prism", "dist/server/mcp.mjs", "skills/demo/SKILL.md", "vendor/native-runtime/manifest.json"]);
    assert.match(git(root, "ls-tree", first, "bin/prism"), /^100755 /);
    await rm(out, { recursive: true, force: true });
  } finally { await cleanup(); }
});

test("a served package is reachable at the GitHub URL through the returned git configuration", async () => {
  const { root, metadata, cleanup } = await fixture();
  try {
    const out = path.join(root, "..", `${path.basename(root)}-package`);
    const work = path.join(root, "..", `${path.basename(root)}-served`);
    await buildPackage({ checkout: root, out, repository, tag: "v1.2.3", metadata });
    const { sha, catalog, gitconfig } = await servePackage({ checkout: root, directory: out, repository, ref: "prism--v1.2.3", work });
    const pinned = JSON.parse(await readFile(path.join(catalog, ".claude-plugin/marketplace.json"), "utf8")).plugins[0].source;
    assert.deepEqual(pinned, { source: "github", repo: repository, ref: "prism--v1.2.3", sha });
    for (const url of [`https://github.com/${repository}.git`, `git@github.com:${repository}.git`]) {
      const listed = execFileSync("git", ["ls-remote", url, "refs/tags/prism--v1.2.3"], { env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
      assert.equal(listed.split("\t")[0], sha);
    }
    await Promise.all([rm(out, { recursive: true, force: true }), rm(work, { recursive: true, force: true })]);
  } finally { await cleanup(); }
});
