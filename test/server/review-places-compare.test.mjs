import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, skip } from "./fixtures/kit-browser.mjs";

// The places comparison renders each scene of the approved places mockup beside the demo app and compares their outlines.
// These tests check the comparison against the mockup itself, through --app-mockup, so they hold before and after the app matches it.

const SCRIPT = path.join(ROOT, "scripts/review-demo/places-compare.mjs");
const MOCKUP = path.join(ROOT, "scripts/review-demo/mockups/review-app-places/mockup.html");

async function folder(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-places-compare-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 240000 });
}

// A copy of the mockup next to its design values and fonts, changed by `edit`, so a difference can be planted.
async function changedMockup(context, edit) {
  const directory = await folder(context);
  await cp(path.dirname(MOCKUP), directory, { recursive: true });
  const file = path.join(directory, "mockup.html");
  await writeFile(file, edit(await readFile(file, "utf8")));
  return file;
}

test("clauses 67, 68, 69, 72: the mockup compared with itself writes a pair, an outline, a report, and an index for each scene, width, and theme, and exits 0", { skip, timeout: 300000 }, async (context) => {
  const out = await folder(context);
  const result = run(["--out", out, "--app-mockup", MOCKUP, "--scenes", "work,drawer-phone", "--widths", "1440,390", "--themes", "light,dark"]);
  assert.equal(result.status, 0, `the comparison exits 0: ${result.stderr}${result.stdout}`);
  const files = await readdir(out);
  for (const name of ["work-1440-light", "work-1440-dark", "work-390-light", "work-390-dark", "drawer-phone-390-light", "drawer-phone-390-dark"]) {
    assert.ok(files.includes(`${name}.png`), `${name}.png is written`);
    assert.ok(files.includes(`${name}.json`), `${name}.json is written`);
  }
  assert.equal(files.some((name) => name.startsWith("drawer-phone-1440")), false, "the phone drawer renders only at its own width");
  assert.ok(files.includes("index.html"));
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  assert.equal(report.pairs.length, 6);
  for (const pair of report.pairs) {
    assert.deepEqual(Object.keys(pair).sort(), ["differences", "png", "scene", "theme", "width"]);
    assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme} matches itself`);
  }
  const outline = JSON.parse(await readFile(path.join(out, "work-1440-light.json"), "utf8"));
  const mockup = outline.mockup;
  assert.deepEqual(mockup.rail.entries, ["Attention", "Work", "Roadmap", "Knowledge", "History"], "the rail's entries are read from the mockup");
  assert.equal(mockup.rail.current, "Work");
  assert.equal(mockup.rail.visible, true);
  assert.equal(mockup.rail.count, true);
  assert.deepEqual(mockup.head, { title: "Work", subtitle: "Designed and not shipped" });
  assert.deepEqual(mockup.sidebar.groups.map((group) => group.heading), ["In progress", "Blocked", "Designed, not started", "Not on the roadmap"]);
  assert.equal(mockup.topbar.bell, false, "the bell is not in the wide top bar");
  assert.equal(mockup.trail, "Work");
  for (const key of ["railWidth", "railButtonWidth", "railButtonHeight", "sidebarLeft", "sidebarWidth", "placeTitleSize", "rowHeight", "mainLeft"]) assert.equal(typeof mockup.geometry[key], "number", `geometry.${key} is measured`);
  for (const key of ["rail", "sidebar", "currentRail", "selectedRow", "currentRailIcon"]) assert.equal(typeof mockup.tokens[key], "string", `tokens.${key} is read`);
  const phone = JSON.parse(await readFile(path.join(out, "work-390-light.json"), "utf8")).mockup;
  assert.equal(phone.rail.visible, false, "the rail is hidden at phone width");
  assert.equal(phone.topbar.bell, true, "the bell is in the narrow top bar");
  assert.equal(phone.topbar.bellCount, true);
  const drawer = JSON.parse(await readFile(path.join(out, "drawer-phone-390-light.json"), "utf8")).mockup;
  assert.equal(drawer.rail.visible, true, "the open drawer shows the rail");
  assert.equal(drawer.head.title, "Work");
});

test("clauses 70, 71, 72: a changed rail, group, fixed row, geometry, or design value fails the comparison and names each difference", { skip, timeout: 300000 }, async (context) => {
  const changed = await changedMockup(context, (html) => html
    .replace(/(<section class="mock-frame" id="attention"[\s\S]*?)<a class="rail-item"[^>]*data-place="history">[\s\S]*?<\/a>/, "$1")
    .replace(/(<section class="mock-frame" id="attention"[\s\S]*?)<span>By kind<\/span>/, "$1<span>Kinds</span>")
    .replace(/(<section class="mock-frame" id="attention"[\s\S]*?)<span class="label">Failed verifications<\/span>/, "$1<span class=\"label\">Failed runs</span>")
    .replace("</style>", ".mock-frame { --rail-width: 72px !important; } .rail-item[aria-current=\"page\"] { background: rgb(1, 2, 3); }</style>"));
  const out = await folder(context);
  const result = run(["--out", out, "--app-mockup", changed, "--scenes", "attention", "--widths", "1440", "--themes", "light"]);
  assert.equal(result.status, 1, `a difference exits 1: ${result.stderr}`);
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  const differences = report.pairs[0].differences;
  const has = (pattern) => differences.some((line) => pattern.test(line));
  assert.ok(has(/^attention 1440 light rail: mockup .*History.*, app /), `the missing rail entry is named: ${differences.join(" | ")}`);
  assert.ok(has(/^attention 1440 light sidebar: .*By kind/), "the renamed group is named");
  assert.ok(has(/^attention 1440 light sidebar: .*Failed verifications/), "the renamed fixed row is named");
  assert.ok(has(/^attention 1440 light geometry: /), "the wider rail is named");
  assert.ok(has(/^attention 1440 light tokens: /), "the changed color is named");
  for (const line of differences) assert.ok(result.stdout.includes(line), `the difference is printed: ${line}`);
});

test("clauses 69, 71: --parts limits the comparison, and an optional group may be absent while a required one may not", { skip, timeout: 300000 }, async (context) => {
  const optionalGone = await changedMockup(context, (html) => html.replace(/(<section class="mock-frame" id="work"[\s\S]*?)<h3 class="section-label" data-optional><span>Not on the roadmap<\/span>[\s\S]*?<\/ul>/, "$1"));
  const out = await folder(context);
  const kept = run(["--out", out, "--mockup", MOCKUP, "--app-mockup", optionalGone, "--scenes", "work", "--widths", "1440", "--themes", "light"]);
  assert.equal(kept.status, 0, `an optional group the app leaves out is no difference: ${kept.stdout}`);
  const requiredGone = await changedMockup(context, (html) => html.replace(/(<section class="mock-frame" id="work"[\s\S]*?)<h3 class="section-label"><span>In progress<\/span>/, "$1<h3 class=\"section-label\"><span>Active</span>"));
  const out2 = await folder(context);
  const failed = run(["--out", out2, "--app-mockup", requiredGone, "--scenes", "work", "--widths", "1440", "--themes", "light"]);
  assert.equal(failed.status, 1, "a renamed required group is a difference");
  const out3 = await folder(context);
  const limited = run(["--out", out3, "--app-mockup", requiredGone, "--scenes", "work", "--widths", "1440", "--themes", "light", "--parts", "rail,geometry"]);
  assert.equal(limited.status, 0, `the sidebar part is not compared when --parts leaves it out: ${limited.stdout}`);
});

test("clause 72: a missing --out, an unknown scene, part, width, or theme, and an unreadable mockup exit 2 with a message", { skip, timeout: 120000 }, async (context) => {
  const out = await folder(context);
  for (const args of [[], ["--out", out, "--scenes", "lobby"], ["--out", out, "--parts", "colors"], ["--out", out, "--widths", "200"], ["--out", out, "--themes", "sepia"], ["--out", out, "--mockup", path.join(out, "missing.html")]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")} exits 2`);
    assert.match(result.stderr, /places-compare: /, `${args.join(" ")} says why`);
  }
});
