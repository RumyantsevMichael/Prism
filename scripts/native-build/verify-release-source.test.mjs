import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseTag, verifyReleaseSource } from "./verify-release-source.mjs";
import { PLATFORMS } from "./published-manifest.mjs";

test("release verification rejects missing platforms and local or foreign assets", () => {
  const assetVersion = "native-runtime-123-1";
  const manifest = {
    schemaVersion: 1, assetVersion, model: { revision: "pinned" },
    bundles: Object.fromEntries(PLATFORMS.map(platform => [platform, {
      url: `https://github.com/example/prism/releases/download/${assetVersion}/prism-native-${platform}.tar.gz`,
      sha256: "a".repeat(64), bytes: 1, unpackedBytes: 2
    }]))
  };
  assert.equal(releaseTag(manifest, "example/prism"), assetVersion);
  assert.throws(() => releaseTag(manifest, "other/repository"));
  assert.throws(() => releaseTag({ ...manifest, assetVersion: "local-runtime" }, "example/prism"));
  assert.throws(() => releaseTag({ ...manifest, bundles: {} }, "example/prism"));
});

test("release metadata may change but runtime, server, build, and model inputs must match", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-release-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  git("config", "user.name", "Prism test");
  git("config", "user.email", "prism-test@example.invalid");
  const model = { revision: "model-1", files: [{ path: "model.onnx", sha256: "a".repeat(64) }] };
  await write("vendor/native-runtime/manifest.json", JSON.stringify({ model, bundles: {} }));
  await write("native-runtime/worker.mjs", "original runtime\n");
  const runtime = commit();
  await write("vendor/native-runtime/manifest.json", JSON.stringify({ model, assetVersion: "new-release", bundles: { tested: true } }));
  await write(".codex-plugin/plugin.json", '{"version":"1.2.3"}');
  await write("CHANGELOG.md", "A new version.\n");
  const promoted = commit();
  assert.deepEqual(verifyReleaseSource(directory, runtime), { runtime, source: promoted });
  for (const file of ["native-runtime/worker.mjs", "server/mcp.mjs", "scripts/native-build/compile.mjs", "vendor/native-runtime/licenses/NOTICE", ".github/workflows/native-default.yml"]) {
    await write(file, "changed\n");
    commit();
    assert.throws(() => verifyReleaseSource(directory, runtime), /does not match/);
    git("reset", "--hard", promoted);
  }
  await write("vendor/native-runtime/manifest.json", JSON.stringify({ model: { ...model, revision: "model-2" } }));
  commit();
  assert.throws(() => verifyReleaseSource(directory, runtime), /different model/);
});
