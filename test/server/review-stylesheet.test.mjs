import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// An unclosed rule makes the browser drop every rule after it, and no other check notices, so the braces must balance.
async function stylesheets(directory) {
  const out = [];
  for (const entry of await readdir(new URL(`../../${directory}`, import.meta.url), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await stylesheets(relative));
    else if (entry.name.endsWith(".css")) out.push(relative);
  }
  return out;
}

test("every review app stylesheet's braces balance", async () => {
  const files = [];
  for (const copy of ["src/server/review/public", "dist/server/review/public"]) {
    for (const folder of ["kit", "styles"]) files.push(...await stylesheets(`${copy}/${folder}`));
  }
  assert.ok(files.some((file) => file.endsWith("/kit/kit.css")) && files.some((file) => file.endsWith("/styles/shell.css")), "the check finds the kit and area stylesheets");
  for (const file of files) {
    const text = (await readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"\n]*"|'[^'\n]*'/g, "");
    let depth = 0;
    text.split("\n").forEach((line, index) => {
      // The stylesheets indent everything inside a block, so a selector in the first column must start at the top level; a merge that drops a closing brace breaks that.
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
