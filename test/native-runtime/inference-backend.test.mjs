import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../dist/native-runtime/worker.mjs", import.meta.url));
import assert from "node:assert/strict";

test("the transformer CPU backend loads on the build platform", async () => {
  const { AutoModel } = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
  const { InferenceSession } = await import(pathToFileURL(require.resolve("onnxruntime-node")).href);
  assert.equal(typeof AutoModel.from_pretrained, "function");
  assert.equal(typeof InferenceSession.create, "function");
});
