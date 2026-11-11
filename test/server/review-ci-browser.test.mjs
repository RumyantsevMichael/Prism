import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Requirements: docs/requirements/review-app-ui-kit.md §8, §12.
// Contract: docs/plans/review-app-ui-kit/slice.md clause 83.
// The pull request workflow installs a browser, so the browser acceptance tests guard every pull request instead of skipping.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);

// The steps of the validate job, each as its name, its run text, and its env block, read from the workflow's indentation.
async function validateSteps() {
  const text = await readFile(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}validate:\s*$/.test(line));
  assert.ok(start >= 0, "validate.yml has a validate job");
  const stepsAt = lines.findIndex((line, index) => index > start && /^ {4}steps:\s*$/.test(line));
  assert.ok(stepsAt > start, "the validate job has steps");
  const steps = [];
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,4}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) steps.push([]);
    if (steps.length) steps.at(-1).push(line);
  }
  return steps.map((step) => {
    const body = step.join("\n");
    return { body, name: /name:\s*(.+)/.exec(body)?.[1]?.trim() ?? "", requireBrowser: /^\s+PRISM_REQUIRE_BROWSER:\s*["']1["']\s*$/m.test(body) };
  });
}

test("clause 83: the validate job installs Playwright and Chromium before the tests and requires the browser while they run", async () => {
  const steps = await validateSteps();
  const testing = steps.findIndex((step) => /^\s+npm test\s*$/m.test(step.body));
  assert.ok(testing >= 0, "a step runs npm test");
  const installing = steps.findIndex((step) => /npm install -g playwright@1\.63\.0(\s|$)/m.test(step.body));
  assert.ok(installing >= 0, "a step installs playwright@1.63.0 globally");
  const browser = steps.findIndex((step) => /npx playwright install --with-deps chromium(\s|$)/m.test(step.body));
  assert.ok(browser >= 0, "a step installs Chromium with its system dependencies");
  assert.ok(installing < testing && browser < testing, "Playwright and Chromium are installed before the tests run");
  assert.ok(steps[testing].requireBrowser, "the step that runs npm test sets PRISM_REQUIRE_BROWSER to 1");
});

test("clause 83: with PRISM_REQUIRE_BROWSER set, a browser test without Playwright fails instead of skipping", async () => {
  // A copy of Node that finds no Playwright: no global modules and no local install named playwright.
  const probe = `process.env.PRISM_REQUIRE_BROWSER = "1"; const loaded = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "test/server/fixtures/kit-browser.mjs")).href)}).then(() => "loaded", (error) => "refused: " + error.message); console.log(loaded);`;
  const environment = { ...process.env, PRISM_REQUIRE_BROWSER: "1", NODE_PATH: "", npm_config_prefix: path.join(ROOT, "test", "no-such-global-prefix") };
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], { env: environment, cwd: ROOT });
  const found = await run(process.execPath, ["--input-type=module", "-e", `import { playwright } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "test/server/fixtures/kit-browser.mjs")).href)}; console.log(playwright ? "found" : "missing");`], { env: { ...environment, PRISM_REQUIRE_BROWSER: "" }, cwd: ROOT });
  if (found.stdout.trim() === "found") assert.equal(stdout.trim(), "loaded", "with Playwright present the fixture loads");
  else assert.match(stdout.trim(), /^refused: .*PRISM_REQUIRE_BROWSER/, "without Playwright the fixture refuses to load, so every browser test fails");
});
