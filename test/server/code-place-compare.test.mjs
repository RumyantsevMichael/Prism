import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, skip } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/code-place.md §19, §23.
// Contract: docs/plans/code-place/slice.md clauses 50 to 53, through node scripts/review-demo/code-compare.mjs.
// The comparison renders each approved Code place scene from its kit markup and from the demo app in the same state, and compares their outlines.

const SCRIPT = path.join(ROOT, "scripts/review-demo/code-compare.mjs");
const MOCKUPS = path.join(ROOT, "scripts/review-demo/mockups/code-place");
const SCENES = ["all-1440-light", "all-1440-dark", "work-picked-1440-light", "tree-390-light", "file-390-light", "drawer-390-light"];

async function folder(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-code-compare-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 540000 });
}

test("clause 50: the folder holds the six approved pictures, their scenes, and the markup that drew them", async () => {
  const files = await readdir(MOCKUPS);
  for (const name of SCENES) assert.ok(files.includes(`code-${name}.png`), `code-${name}.png is kept`);
  assert.ok(files.includes("content.mjs"));
  const { scenes } = JSON.parse(await readFile(path.join(MOCKUPS, "scenes.json"), "utf8"));
  assert.deepEqual(scenes.map((scene) => `${scene.name}-${scene.width}-${scene.theme}`), SCENES);
});

test("clauses 50 to 53: the demo compared with every approved scene writes a picture and an outline for each, a report, and an index, and exits 0", { skip, timeout: 600000 }, async (context) => {
  const out = await folder(context);
  const result = run(["--out", out]);
  assert.equal(result.status, 0, `the comparison exits 0: ${result.stderr}${result.stdout}`);
  const files = await readdir(out);
  for (const name of SCENES) {
    assert.ok(files.includes(`${name}.png`), `${name}.png is written`);
    assert.ok(files.includes(`${name}.json`), `${name}.json is written`);
  }
  assert.ok(files.includes("index.html"));
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  assert.deepEqual(report.pairs.map((pair) => `${pair.scene}-${pair.width}-${pair.theme}`), SCENES);
  for (const pair of report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme} matches its mockup`);
  const outline = JSON.parse(await readFile(path.join(out, "all-1440-light.json"), "utf8"));
  for (const side of ["mockup", "app"]) {
    const shown = outline[side];
    for (const key of ["sidebar", "files", "scope", "tree", "file", "geometry"]) assert.ok(key in shown, `the ${side} outline has ${key}`);
    assert.deepEqual(shown.sidebar.groups.map((group) => group.heading), ["In progress", "Other branches"]);
    assert.ok(shown.sidebar.rows.some((row) => row.label === "Harden request retries"), "the outline lists the sidebar's rows");
    assert.equal(typeof shown.sidebar.quiet, "string", "the outline holds the quiet note");
  }
  const phone = JSON.parse(await readFile(path.join(out, "file-390-light.json"), "utf8"));
  assert.equal(typeof phone.app.back, "string", "the narrow file scene names its back button");
  assert.ok(Array.isArray(phone.app.file.versions), "the file scene lists its version chips");
});

test("clauses 51 and 52: a changed row in the markup fails the comparison and names the scene, width, and theme", { skip, timeout: 600000 }, async (context) => {
  const mockups = await folder(context);
  await cp(MOCKUPS, mockups, { recursive: true });
  const content = path.join(mockups, "content.mjs");
  await writeFile(content, (await readFile(content, "utf8")).replace("Harden request retries", "Harden every request"));
  const out = await folder(context);
  const result = run(["--out", out, "--mockups", mockups, "--scenes", "all", "--widths", "1440", "--themes", "light"]);
  assert.equal(result.status, 1, `a difference exits 1: ${result.stderr}${result.stdout}`);
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  assert.equal(report.pairs.length, 1, "--scenes, --widths, and --themes narrow the run");
  const differences = report.pairs[0].differences;
  assert.ok(differences.some((line) => /^all 1440 light: .*Harden every request/.test(line)), `the changed row is named: ${differences.join(" | ")}`);
  for (const line of differences) assert.ok(result.stdout.includes(line), `the difference is printed: ${line}`);
});

test("clause 52: a missing --out and an unknown scene, width, or theme exit 2 with a message", { skip, timeout: 120000 }, async (context) => {
  const out = await folder(context);
  for (const args of [[], ["--out", out, "--scenes", "lobby"], ["--out", out, "--widths", "200"], ["--out", out, "--themes", "sepia"]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")} exits 2`);
    assert.match(result.stderr, /code-compare: /, `${args.join(" ")} says why`);
  }
});
