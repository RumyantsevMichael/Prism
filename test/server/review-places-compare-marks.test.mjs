import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, skip } from "./fixtures/kit-browser.mjs";

// The places comparison leaves a format mark out of the app's outline, and still reports the same element without the mark's attribute.

const SCRIPT = path.join(ROOT, "scripts/review-demo/places-compare.mjs");
const MOCKUP = path.join(ROOT, "scripts/review-demo/mockups/review-app-places/mockup.html");
const BADGE = (attribute) => `<prism-badge ${attribute} tone="warning" title="requirements.header">Breaks its format</prism-badge>`;

async function folder(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-places-marks-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function changedMockup(context, edit) {
  const directory = await folder(context);
  await cp(path.dirname(MOCKUP), directory, { recursive: true });
  const file = path.join(directory, "mockup.html");
  await writeFile(file, edit(await readFile(file, "utf8")));
  return file;
}

const planted = (attribute) => (html) => html.replace(/(<section class="mock-frame" id="attention"[\s\S]*?)<span class="label">Failed verifications<\/span>/, `$1<span class="label">Failed verifications${BADGE(attribute)}</span>`);

const compare = async (context, app) => {
  const out = await folder(context);
  const result = spawnSync(process.execPath, [SCRIPT, "--out", out, "--mockup", MOCKUP, "--app-mockup", app, "--scenes", "attention", "--widths", "1440", "--themes", "light,dark"], { cwd: ROOT, encoding: "utf8", timeout: 240000 });
  return { result, out };
};

test("clause 10: a format mark in the app is no difference in either theme", { skip, timeout: 300000 }, async (context) => {
  const app = await changedMockup(context, planted("data-format-mark"));
  assert.notEqual(await readFile(app, "utf8"), await readFile(MOCKUP, "utf8"), "the mark was planted");
  const { result } = await compare(context, app);
  assert.equal(result.status, 0, `a format mark is left out of the comparison: ${result.stdout}${result.stderr}`);
});

test("clause 10: the same badge without the mark's attribute is still a difference", { skip, timeout: 300000 }, async (context) => {
  const app = await changedMockup(context, planted('data-kind="note"'));
  const { result, out } = await compare(context, app);
  assert.equal(result.status, 1, `an unmarked badge is a difference: ${result.stdout}`);
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  assert.ok(report.pairs.some((pair) => pair.differences.some((line) => /Breaks its format/.test(line))), JSON.stringify(report.pairs.map((pair) => pair.differences)));
});
