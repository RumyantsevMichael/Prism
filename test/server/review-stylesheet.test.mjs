import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// An unclosed rule makes the browser drop every rule after it, and no other check notices, so the braces must balance.
test("the review stylesheet's braces balance", async () => {
  for (const file of ["src/server/review/public/review.css", "dist/server/review/public/review.css"]) {
    const text = (await readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"\n]*"|'[^'\n]*'/g, "");
    let depth = 0;
    text.split("\n").forEach((line, index) => {
      // The stylesheet indents everything inside a block, so a selector in the first column must start at the top level; a merge that drops a closing brace breaks that.
      if (/^[.#:*\[a-z]/i.test(line)) assert.equal(depth, 0, `${file}:${index + 1} starts a rule inside an unclosed block`);
      for (const char of line) {
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        assert.ok(depth >= 0, `${file}:${index + 1} closes a rule that was never opened`);
      }
    });
    assert.equal(depth, 0, `${file} leaves a rule open`);
  }
});
