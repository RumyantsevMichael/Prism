import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §2, §12.
// The guard reads files a contributor changed and names each raw design value and each control styled or written around the kit.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = path.join(ROOT, "scripts/review-kit/kit-guard.mjs");
const run = promisify(execFile);

async function project(context, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-guard-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

async function check(context, files) {
  const { checkKitUsage } = await import(GUARD);
  const root = await project(context, files);
  return checkKitUsage({ root, files: Object.keys(files) });
}

const has = (findings, file, line, rule, value) => findings.some((finding) => finding.file === file && finding.line === line && finding.rule === rule && finding.value === value);
const lines = (...rows) => `${rows.join("\n")}\n`;

test("raw colors in stylesheets, scripts, and pages are named with their file and line", async (context) => {
  const findings = await check(context, {
    "app/screen.css": lines(".a {", "  color: #fff;", "  background: rgb(1 2 3);", "  border-color: rebeccapurple;", "  outline-color: transparent;", "  fill: currentColor;", "  text-decoration-color: hsl(10 20% 30%);", "  /* #abcdef in a comment */", "}"),
    "app/view.js": lines("// A comment may name #e5484d.", "const badge = `<circle fill=\"#e5484d\"/>`;", "element.style.color = \"#123456\";", "document.querySelector(\"#artifact\");", "const entity = \"&#160;\";"),
    "app/page.html": lines("<meta name=\"theme-color\" content=\"#17152b\">")
  });
  assert.ok(has(findings, "app/screen.css", 2, "raw-value", "#fff"));
  assert.ok(has(findings, "app/screen.css", 3, "raw-value", "rgb(1 2 3)"));
  assert.ok(has(findings, "app/screen.css", 4, "raw-value", "rebeccapurple"));
  assert.ok(has(findings, "app/screen.css", 7, "raw-value", "hsl(10 20% 30%)"));
  assert.ok(has(findings, "app/view.js", 2, "raw-value", "#e5484d"));
  assert.ok(has(findings, "app/view.js", 3, "raw-value", "#123456"));
  assert.ok(has(findings, "app/page.html", 1, "raw-value", "#17152b"));
  assert.equal(findings.filter((finding) => finding.file === "app/screen.css" && [5, 6, 8].includes(finding.line)).length, 0, "transparent, currentColor, and comments are not raw values");
  assert.equal(findings.filter((finding) => finding.file === "app/view.js" && [1, 4, 5].includes(finding.line)).length, 0, "comments, id selectors, and character references are not colors");
});

test("raw sizes, radii, shadows, layers, and times are named, while tokens, zero, keywords, and layout sizes pass", async (context) => {
  const findings = await check(context, {
    "app/sizes.css": lines(
      ".b {",
      "  font-size: 13px;",
      "  padding: 4px 0;",
      "  margin: 0;",
      "  gap: var(--prism-space-2);",
      "  border-radius: 50%;",
      "  box-shadow: none;",
      "  z-index: 5;",
      "  transition: color 120ms ease;",
      "  animation-duration: var(--prism-duration-fast);",
      "  width: 16rem;",
      "  margin-inline: calc(-1 * var(--prism-space-3));",
      "  padding-left: var(--prism-space-4, 6px);",
      "  border-top-left-radius: var(--prism-radius-sm);",
      "  animation: spin 800ms linear infinite;",
      "  height: var(--prism-control-height);",
      "  font: 600 12px/1.4 var(--prism-font-ui);",
      "}"
    ),
    "app/move.js": lines("panel.style.padding = \"4px\";", "panel.style.width = `${width}px`;", "panel.style.setProperty(\"z-index\", \"3\");", "panel.style.setProperty(\"--side-panel-width\", `${width}px`);")
  });
  for (const [line, value] of [[2, "13px"], [3, "4px"], [6, "50%"], [8, "5"], [9, "120ms"], [13, "6px"], [15, "800ms"], [17, "12px"]]) {
    assert.ok(has(findings, "app/sizes.css", line, "raw-value", value), `line ${line} reports ${value}`);
  }
  for (const line of [4, 5, 7, 10, 11, 12, 14, 16]) {
    assert.equal(findings.filter((finding) => finding.file === "app/sizes.css" && finding.line === line).length, 0, `line ${line} passes`);
  }
  assert.ok(has(findings, "app/move.js", 1, "raw-value", "4px"));
  assert.ok(has(findings, "app/move.js", 3, "raw-value", "3"));
  assert.equal(findings.filter((finding) => finding.file === "app/move.js" && [2, 4].includes(finding.line)).length, 0, "layout sizes written through style pass");
});

test("the design values file may hold raw values", async (context) => {
  const findings = await check(context, {
    "src/server/review/public/kit/tokens.css": lines(":root {", "  --prism-color-ink: #242137;", "  --prism-space-2: 4px;", "  --prism-shadow-popup: 0 4px 14px rgb(36 33 55 / 0.14);", "}"),
    "src/server/review/public/kit/kit.css": lines("prism-chip { color: #000; }")
  });
  assert.equal(findings.filter((finding) => finding.file.endsWith("kit/tokens.css")).length, 0);
  assert.ok(has(findings, "src/server/review/public/kit/kit.css", 1, "raw-value", "#000"), "the kit's own stylesheets also take values from the design values file");
});

test("selectors that style a control outside the kit are named", async (context) => {
  const files = {
    "src/server/review/public/styles/area.css": lines(
      "button { margin: 0; }",
      ".toolbar input[type=\"search\"] { margin: 0; }",
      "[role=\"tab\"] { margin: 0; }",
      "prism-chip { margin: 0; }",
      "prism-button::part(control) { margin: 0; }",
      ".claim-chip { margin: 0; }",
      ".view-card .title { margin: 0; }",
      ".tok-tag { margin: 0; }",
      ".sidebar-layout, .chip-row { margin: 0; }",
      "details > summary { margin: 0; }",
      ".attention-list { margin: 0; }"
    ),
    "src/server/review/public/kit/kit.css": lines("prism-chip { margin: 0; }", "prism-field > input { margin: 0; }", ".x-chip { margin: 0; }")
  };
  const findings = await check(context, files);
  const area = "src/server/review/public/styles/area.css";
  for (const [line, value] of [[1, "button"], [2, ".toolbar input[type=\"search\"]"], [3, "[role=\"tab\"]"], [4, "prism-chip"], [5, "prism-button::part(control)"], [6, ".claim-chip"], [7, ".view-card .title"], [10, "details > summary"]]) {
    assert.ok(has(findings, area, line, "control-style", value), `line ${line} reports ${value}`);
  }
  for (const line of [8, 9, 11]) {
    assert.equal(findings.filter((finding) => finding.file === area && finding.line === line).length, 0, `line ${line} is layout`);
  }
  assert.equal(findings.filter((finding) => finding.file.endsWith("kit/kit.css")).length, 0, "the kit styles its own controls");
});

test("native controls, control roles, and native tooltips written outside the kit are named", async (context) => {
  const files = {
    "src/server/review/public/views/screen.js": lines(
      "const save = `<button type=\"button\">Save</button>`;",
      "const field = document.createElement(\"input\");",
      "const tabs = `<div role=\"tablist\">`;",
      "const hint = `<span title=\"Full name\">Name</span>`;",
      "const more = `<details><summary>More</summary></details>`;",
      "const link = `<a href=\"#x\" data-title=\"x\">x</a>`;",
      "const icon = `<svg><title>Graph</title></svg>`;",
      "const kit = `<prism-button>Save</prism-button>`;",
      "const region = `<div role=\"region\">`;"
    ),
    "src/server/review/review.html": lines("<button id=\"jump\">Jump</button>"),
    "src/server/review/public/kit/elements/prism-button.js": lines("const inner = document.createElement(\"button\");", "inner.setAttribute(\"role\", \"button\");")
  };
  const findings = await check(context, files);
  const screen = "src/server/review/public/views/screen.js";
  assert.ok(has(findings, screen, 1, "native-control", "<button"));
  assert.ok(has(findings, screen, 2, "native-control", "createElement(\"input\")"));
  assert.ok(has(findings, screen, 3, "native-control", "role=\"tablist\""));
  assert.ok(has(findings, screen, 4, "native-control", "title=\"Full name\""));
  assert.ok(has(findings, screen, 5, "native-control", "<details"));
  assert.ok(has(findings, screen, 5, "native-control", "<summary"));
  for (const line of [6, 7, 8, 9]) {
    assert.equal(findings.filter((finding) => finding.file === screen && finding.line === line).length, 0, `line ${line} passes`);
  }
  assert.ok(has(findings, "src/server/review/review.html", 1, "native-control", "<button"));
  assert.equal(findings.filter((finding) => finding.file.includes("/kit/")).length, 0, "the kit builds its controls from native ones");
});

test("findings are sorted by file and line", async (context) => {
  const findings = await check(context, {
    "b.css": lines(".x { color: #111; }", ".y { color: #222; }"),
    "a.css": lines(".z { padding: 3px; }", ".w { color: #333; }")
  });
  const order = findings.map((finding) => `${finding.file}:${finding.line}`);
  assert.deepEqual(order, ["a.css:1", "a.css:2", "b.css:1", "b.css:2"]);
  for (const finding of findings) assert.deepEqual(Object.keys(finding).sort(), ["file", "line", "rule", "value"]);
});

test("the command checks the review app's browser files, prints each finding, and fails when there is one", async (context) => {
  const dirty = await project(context, {
    "src/server/review/public/views/a.js": lines("const x = 1;", "const y = `<button>`;"),
    "src/server/review/public/styles/a.css": lines(".a { color: #fff; }"),
    "src/server/review/public/kit/tokens.css": lines(":root { --prism-color-ink: #242137; }"),
    "docs/elsewhere.css": lines(".a { color: #fff; }")
  });
  const failed = await run(process.execPath, [GUARD, dirty]).then(() => null, (error) => error);
  assert.ok(failed, "the command fails");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^src\/server\/review\/public\/styles\/a\.css:1: raw-value #fff$/m);
  assert.match(failed.stdout, /^src\/server\/review\/public\/views\/a\.js:2: native-control <button$/m);
  assert.doesNotMatch(failed.stdout, /elsewhere|tokens\.css/);
  const clean = await project(context, { "src/server/review/public/styles/a.css": lines(".a { color: var(--prism-color-ink); }") });
  const passed = await run(process.execPath, [GUARD, clean]);
  assert.equal(passed.stdout.trim(), "");
});
