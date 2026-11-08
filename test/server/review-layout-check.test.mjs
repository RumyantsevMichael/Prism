import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §11.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 60 and 61.
// The layout check opens a catalog page at checked widths and themes and names each entry that breaks.

const BROKEN = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; } body { margin: 0; font: 13px sans-serif; }
  section { border: 1px solid gray; margin: 8px; }
  .wide { width: 900px; height: 20px; background: silver; }
  .clip { overflow: hidden; width: 80px; } .clip button { margin-left: 120px; }
  @media (prefers-color-scheme: dark) { .dark-only { width: 1200px; height: 10px; } }
</style></head><body>
  <section data-catalog-entry="prism-fine"><p>Fits at every width.</p></section>
  <section data-catalog-entry="prism-escapes"><div class="wide"></div></section>
  <section data-catalog-entry="prism-cuts"><div class="clip"><button type="button">Cut</button></div></section>
  <section data-catalog-entry="prism-dark"><div class="dark-only"></div></section>
</body></html>`;

async function fixture(context) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(BROKEN);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/kit/catalog`;
}

const audit = () => import(path.join(ROOT, "scripts/review-demo/layout-audit.mjs"));

test("clause 60: a catalog entry that escapes its container, cuts off a control, or scrolls the page is named with its width and theme", { skip, timeout: 120000 }, async (context) => {
  const { checkCatalog } = await audit();
  const url = await fixture(context);
  const problems = await checkCatalog({ url, viewports: ["phone", "wide"], themes: ["light", "dark"] });
  for (const problem of problems) {
    assert.deepEqual(Object.keys(problem).sort(), ["entry", "problem", "theme", "viewport", "width"]);
    assert.equal(typeof problem.problem, "string");
  }
  const at = (entry, viewport, theme) => problems.filter((problem) => problem.entry === entry && problem.viewport === viewport && problem.theme === theme);
  assert.equal(problems.filter((problem) => problem.entry === "prism-fine").length, 0, "an entry that fits is not named");
  for (const theme of ["light", "dark"]) {
    assert.ok(at("prism-escapes", "phone", theme).length, `the escaping entry is named at phone in ${theme}`);
    assert.equal(at("prism-escapes", "phone", theme)[0].width, 360);
    assert.ok(at("prism-cuts", "phone", theme).length, `the cut-off control is named at phone in ${theme}`);
  }
  assert.equal(at("prism-escapes", "wide", "light").length, 0, "the entry fits at the wide width");
  assert.ok(at("prism-dark", "wide", "dark").length, "an entry that breaks only in the dark theme is named in the dark theme");
  assert.equal(at("prism-dark", "wide", "light").length, 0);
  assert.ok(at("prism-dark", "wide", "dark")[0].width === 1920);
});

test("clause 60: the shipped catalog passes the layout check at a phone and a wide width in both themes", { skip, timeout: 180000 }, async (context) => {
  const { checkCatalog } = await audit();
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-layout-catalog-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  assert.deepEqual(await checkCatalog({ url: `${base}/kit/catalog`, viewports: ["phone", "wide"], themes: ["light", "dark"] }), []);
});

test("clause 61: the layout check command prints each catalog problem with its entry, viewport, width, and theme, and fails", { skip, timeout: 240000 }, async (context) => {
  const url = await fixture(context);
  const run = promisify(execFile);
  const failed = await run(process.execPath, [path.join(ROOT, "scripts/review-demo/layout-check.mjs"), "--catalog", url, "--viewports", "phone,wide", "--themes", "light,dark"], { maxBuffer: 16 * 1024 * 1024, timeout: 230000 }).then(() => null, (error) => error);
  assert.ok(failed, "the command fails on a broken catalog");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^catalog prism-escapes: .+ at phone \(360px\), light$/m);
  assert.match(failed.stdout, /^catalog prism-escapes: .+ at phone \(360px\), dark$/m);
  assert.match(failed.stdout, /^catalog prism-cuts: .+ at phone \(360px\), (light|dark)$/m);
  assert.match(failed.stdout, /^catalog prism-dark: .+ at wide \(1920px\), dark$/m);
  assert.doesNotMatch(failed.stdout, /^catalog prism-fine:/m);
  assert.doesNotMatch(failed.stdout, /^catalog prism-dark: .+, light$/m);
});
