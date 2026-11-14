import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Requirements: docs/requirements/review-app-ui-kit.md §8, §12.
// Contract: docs/plans/review-app-ui-kit/slice.md clause 83.
// The pull request workflow installs a browser on every runner of the server tests, so the browser acceptance tests guard every pull request instead of skipping.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);

// The text of one job of validate.yml, and its steps as their name, run text, and env block, read from the workflow's indentation.
async function workflowJob(name) {
  const text = await readFile(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `validate.yml has a ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  const job = lines.slice(start, end < 0 ? lines.length : end);
  const stepsAt = job.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  assert.ok(stepsAt > 0, `the ${name} job has steps`);
  const steps = [];
  for (const line of job.slice(stepsAt + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) steps.push([]);
    if (steps.length) steps.at(-1).push(line);
  }
  return {
    text: job.join("\n"),
    steps: steps.map((step) => {
      const body = step.join("\n");
      return { body, name: /name:\s*(.+)/.exec(body)?.[1]?.trim() ?? "", requireBrowser: /^\s+PRISM_REQUIRE_BROWSER:\s*["']1["']\s*$/m.test(body) };
    })
  };
}

// The shard count a system runs, from the test step's --shard k/n, where n is a number or ${{ matrix.os == 'os' && n || m }}.
function shardCounts(body) {
  const fixed = /--shard \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(body);
  if (fixed) return () => Number(fixed[1]);
  const chosen = /--shard \$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.os == '([\w.-]+)' && (\d+) \|\| (\d+) \}\}/.exec(body);
  if (!chosen) throw new Error("The test step names no shard count.");
  return (os) => Number(os === chosen[1] ? chosen[2] : chosen[3]);
}

// The server-tests matrix's runs: every os and shard pair, less the pairs its exclude list names.
function matrixRuns(text) {
  const list = (name) => /^ {8}NAME: \[([^\]]*)\]$/m.source.replace("NAME", name);
  const oses = new RegExp(list("os"), "m").exec(text)?.[1].split(",").map((item) => item.trim()) ?? [];
  const shards = new RegExp(list("shard"), "m").exec(text)?.[1].split(",").map(Number) ?? [];
  const excluded = [...text.matchAll(/^ {10}- \{ os: ([\w.-]+), shard: (\d+) \}$/gm)].map((match) => `${match[1]} ${match[2]}`);
  return oses.flatMap((os) => shards.map((shard) => ({ os, shard }))).filter((run) => !excluded.includes(`${run.os} ${run.shard}`));
}

// The validate check passes only once the server test shards passed, and each shard installs the browser before its tests.
test("clause 83: the validate job installs Playwright and Chromium before the tests and requires the browser while they run", async () => {
  const validate = await workflowJob("validate");
  assert.match(validate.text, /^ {4}needs: \[[^\]]*\bserver-tests\b[^\]]*\]$/m, "validate waits for the server test shards");
  const { text, steps } = await workflowJob("server-tests");
  const testing = steps.findIndex((step) => /node scripts\/test-shard\.mjs --shard \$\{\{ matrix\.shard \}\}\//.test(step.body));
  assert.ok(testing >= 0, "a step runs this runner's shard of the server tests");
  const installing = steps.findIndex((step) => /npm install -g playwright@1\.63\.0(\s|$)/m.test(step.body));
  assert.ok(installing >= 0, "a step installs playwright@1.63.0 globally");
  const linux = steps.findIndex((step) => /npx playwright install --with-deps chromium(\s|$)/m.test(step.body) && /if: runner\.os == 'Linux'/.test(step.body));
  assert.ok(linux >= 0, "a step installs Chromium with its system dependencies on Linux");
  const other = steps.findIndex((step) => /npx playwright install chromium(\s|$)/m.test(step.body) && /if: runner\.os != 'Linux'/.test(step.body));
  assert.ok(other >= 0, "a step installs Chromium on the other systems");
  assert.ok(installing < testing && linux < testing && other < testing, "Playwright and Chromium are installed before the tests run");
  assert.ok(steps[testing].requireBrowser, "the step that runs the tests sets PRISM_REQUIRE_BROWSER to 1");
  assert.match(text, /^ {8}os: \[ubuntu-latest, windows-2025\]$/m, "the shards run on Linux and on Windows");
  // Each system runs every shard of the count that the test step names for it, and no other, so no part of the suite goes unrun.
  const counts = shardCounts(steps[testing].body);
  const runs = matrixRuns(text);
  for (const os of ["ubuntu-latest", "windows-2025"]) {
    assert.deepEqual(runs.filter((run) => run.os === os).map((run) => run.shard), Array.from({ length: counts(os) }, (_, index) => index + 1), `${os} runs shards 1 to ${counts(os)}`);
  }
});

test("the validate and windows checks pass only when the test shards passed", async () => {
  for (const name of ["validate", "windows"]) {
    const { text, steps } = await workflowJob(name);
    assert.match(text, /^ {4}needs: \[[^\]]*\bserver-tests\b[^\]]*\]$/m, `${name} waits for the test shards`);
    assert.ok(steps.some((step) => /join\(needs\.\*\.result, ' '\)/.test(step.body) && /\[ "\$result" = success \] \|\| exit 1/.test(step.body)), `${name} fails unless every job it waits for succeeded`);
  }
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
