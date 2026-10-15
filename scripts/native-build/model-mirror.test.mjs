import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mirrorModel } from "./model-mirror.mjs";

const pinned = bytes => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

test("model mirrors keep pinned bytes under flat release asset names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-model-mirror-"));
  try {
    const config = Buffer.from("{}"), model = Buffer.from("onnx");
    const manifest = { model: { id: "org/model", revision: "abc", files: [{ path: "config.json", ...pinned(config) }, { path: "onnx/model.onnx", ...pinned(model) }] } };
    const requested = [];
    const names = await mirrorModel(manifest, directory, async url => { requested.push(url); return url.endsWith("config.json") ? config : model; });
    assert.deepEqual(names, ["model-config.json", "model-onnx-model.onnx"]);
    assert.deepEqual((await readdir(directory)).sort(), names);
    assert.deepEqual(requested, ["https://huggingface.co/org/model/resolve/abc/config.json", "https://huggingface.co/org/model/resolve/abc/onnx/model.onnx"]);
    await assert.rejects(mirrorModel(manifest, directory, async () => Buffer.from("changed")), /does not match the pinned model/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
