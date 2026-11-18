import assert from "node:assert/strict";
import test from "node:test";
import { findings } from "./check-test-waits.mjs";

const found = (source) => findings(source, "test/server/example.test.mjs").map((item) => item.line);

test("a fixed sleep before a check is found, past blank lines and comments", () => {
  assert.deepEqual(found("await new Promise((resolve) => setTimeout(resolve, 300));\nassert.equal(value, 1);"), [1]);
  assert.deepEqual(found("await delay(300);\n\n// The page redraws.\nassert.ok(shown);"), [1]);
  assert.deepEqual(found("  await sleep(50);\n  assert.deepEqual(rows, []);"), [1]);
});

test("waitForTimeout is found wherever it is", () => {
  assert.deepEqual(found("await page.waitForTimeout(400);\nawait page.click('x');"), [1]);
});

test("a pause with its reason, a sleep inside a polling loop, and a sleep before an action are not found", () => {
  assert.deepEqual(found('await pause(500, "nothing may change");\nassert.equal(count, 1);'), []);
  assert.deepEqual(found("for (let tries = 0; tries < 40 && !ready(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));\nassert.ok(ready());"), []);
  assert.deepEqual(found("await new Promise((resolve) => setTimeout(resolve, 300));\nawait answer();"), []);
  assert.deepEqual(found("// await page.waitForTimeout(400);"), []);
});
