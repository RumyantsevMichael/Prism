import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRepositorySkills, validateSkillDocument } from "../../scripts/validate-sdm.mjs";

test("rejects a missing or unsupported SDM version", () => {
  const missing = validateSkillDocument("---\nname: test\n---\n# Test\n");
  const unsupported = validateSkillDocument("---\nsdm: \"9.9\"\n---\n# Test\n");

  assert.deepEqual(missing.errors, [{ line: 1, message: "a skill needs a quoted `sdm` version" }]);
  assert.deepEqual(unsupported.errors, [{ line: 1, message: "unsupported SDM version `9.9`" }]);
});

test("reports mechanical SDM structure warnings without rejecting the skill", () => {
  const result = validateSkillDocument(`---
sdm: "0.3"
---
# Test
## 1. Ordered
## Plain
- Do
`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    { line: 5, message: "sibling headings mix numbered and unnumbered forms" },
    { line: 7, message: "`Do` needs a nested list" }
  ]);
});

test("accepts every shipped skill", async () => {
  const root = new URL("../../", import.meta.url).pathname;
  const results = await validateRepositorySkills(root);

  assert.ok(results.length > 0);
  for (const result of results) {
    assert.deepEqual(result.errors, [], result.file);
    assert.deepEqual(result.warnings, [], result.file);
  }
});

test("ignores structural examples inside fenced code blocks", async () => {
  const document = await readFile(new URL("../../docs/skill-language.md", import.meta.url), "utf8");
  const result = validateSkillDocument(document);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
