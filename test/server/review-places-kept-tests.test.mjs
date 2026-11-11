import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The review app's tests that existed when the places design was accepted keep their titles and their assertions.
// docs/plans/review-app-places/kept-tests.json holds, per file, each top-level test's title and its count of assert calls, and the few titles that a frozen places test replaces.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Each top-level test(...) call, by its title, with the number of assert calls up to the next top-level test.
function testsOf(source) {
  const tests = {};
  for (const part of source.split(/^(?=test\()/m).slice(1)) {
    const match = /^test\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(part);
    if (!match) continue;
    const title = match[1].slice(1, -1);
    tests[title] = (tests[title] ?? 0) + (part.match(/\bassert(?:\.\w+)?\(/g) ?? []).length;
  }
  return tests;
}

test("clause 29: every review app test of the accepted design keeps its title and at least its number of assert calls, unless a frozen places test replaces it", async () => {
  const { baseline, replaced } = JSON.parse(await readFile(path.join(ROOT, "docs/plans/review-app-places/kept-tests.json"), "utf8"));
  assert.ok(Object.keys(baseline).length >= 40, "the baseline lists the review app's test files");
  const problems = [];
  for (const [file, expected] of Object.entries(baseline)) {
    let source;
    try {
      source = await readFile(path.join(ROOT, file), "utf8");
    } catch {
      problems.push(`${file} is gone`);
      continue;
    }
    const current = testsOf(source);
    for (const [title, count] of Object.entries(expected)) {
      const replacement = replaced[file]?.[title];
      if (replacement) {
        try {
          await readFile(path.join(ROOT, replacement), "utf8");
        } catch {
          problems.push(`${file}: "${title}" is replaced by ${replacement}, which does not exist`);
        }
        continue;
      }
      if (!(title in current)) problems.push(`${file}: "${title}" is gone`);
      else if (current[title] < count) problems.push(`${file}: "${title}" has ${current[title]} assert calls, fewer than ${count}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("clause 29: the replaced titles name frozen places tests only", async () => {
  const { replaced } = JSON.parse(await readFile(path.join(ROOT, "docs/plans/review-app-places/kept-tests.json"), "utf8"));
  for (const titles of Object.values(replaced)) {
    for (const replacement of Object.values(titles)) assert.match(replacement, /^test\/server\/review-places-[a-z-]+\.test\.mjs$/);
  }
});
