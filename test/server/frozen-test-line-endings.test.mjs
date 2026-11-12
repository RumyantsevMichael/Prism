import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkFrozenTests, digestFrozenTests } from "../../dist/server/workflow/slice-design.mjs";

// Git on Windows checks text out with CRLF line endings by default, so a frozen test frozen in one checkout reads the same in another.
test("a frozen text test whose line endings alone changed is unchanged, while a content or binary change is not", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-frozen-endings-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "text.test.mjs"), "line one\nline two\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from("a\0b\nc\n"));
  const frozen = await digestFrozenTests(root, ["text.test.mjs", "binary.bin"]);

  await writeFile(path.join(root, "text.test.mjs"), "line one\r\nline two\r\n");
  assert.deepEqual(await checkFrozenTests(root, frozen), { checked: 2, changed: [], missing: [] });

  await writeFile(path.join(root, "text.test.mjs"), "line one\r\nline 2\r\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from("a\0b\r\nc\r\n"));
  assert.deepEqual(await checkFrozenTests(root, frozen), { checked: 2, changed: ["binary.bin", "text.test.mjs"], missing: [] });
});
