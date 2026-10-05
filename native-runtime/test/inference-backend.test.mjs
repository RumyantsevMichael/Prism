import test from "node:test";
import assert from "node:assert/strict";

test("the transformer CPU backend loads on the build platform", async () => {
  const { AutoModel } = await import("@huggingface/transformers");
  const { InferenceSession } = await import("onnxruntime-node");
  assert.equal(typeof AutoModel.from_pretrained, "function");
  assert.equal(typeof InferenceSession.create, "function");
});
