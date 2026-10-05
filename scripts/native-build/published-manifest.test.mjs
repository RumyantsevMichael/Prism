import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORMS, publishedManifest } from "./published-manifest.mjs";

const release = "https://github.com/example/prism/releases/download/native-runtime-123-1";
const original = { schemaVersion: 1, assetVersion: "native-1", bundles: {}, model: { revision: "pinned-model", files: [] } };
const records = () => Object.fromEntries(PLATFORMS.map(platform => [platform, { [platform]: {
  url: `${release}/prism-native-${platform}.tar.gz`, bytes: 100, unpackedBytes: 200, sha256: "a".repeat(64)
} }]));

test("published manifests require all platforms and preserve pinned model identity", () => {
  const result = publishedManifest(original, records(), release);
  assert.deepEqual(Object.keys(result.bundles), PLATFORMS);
  assert.equal(result.assetVersion, "native-runtime-123-1");
  assert.deepEqual(result.model, original.model);
  assert.deepEqual(original.bundles, {});
});

test("incomplete or mixed release metadata cannot replace the default manifest", () => {
  for (const mutate of [
    values => delete values[PLATFORMS[0]],
    values => values[PLATFORMS[0]][PLATFORMS[0]].url = "file:///tmp/unpublished.tar.gz",
    values => values[PLATFORMS[0]][PLATFORMS[0]].url = `${release}-other/prism-native-${PLATFORMS[0]}.tar.gz`,
    values => values[PLATFORMS[0]][PLATFORMS[0]].sha256 = "unverified",
    values => values[PLATFORMS[0]][PLATFORMS[0]].bytes = 0,
    values => values[PLATFORMS[0]][PLATFORMS[0]].unpackedBytes = 0
  ]) {
    const values = records(); mutate(values);
    assert.throws(() => publishedManifest(original, values, release));
  }
});
