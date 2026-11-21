import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, escapes, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

const INITIATIVE = "retry-hardening";
const SLICE = "timeout-retries";
const TEST = "test/retry/timeout-retries.test.mjs";
const LONG = `test/retry/${"x".repeat(120)}.test.mjs`;
const SOURCE = `import { test } from "node:test";

test("retries a timed-out request until the total deadline", () => {});

test("stops retrying once the deadline passes", () => {});
`;
const FAILING = ["retries a timed-out request until the total deadline", "stops retrying once the deadline passes", "a name no frozen test holds"];

/**
 * The demo slice with an accepted design that freezes two tests, one with an unbroken long name, and a failed run whose log is in this machine's plugin data,
 * or, with `elsewhere`, on another machine. Written before the review server starts, since the server caches what it read.
 */
async function sliceWithRun(root, { elsewhere = false } = {}) {
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const files = { [TEST]: SOURCE, [LONG]: "// long\n" };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const record = path.join(root, ".prism", "initiatives", INITIATIVE, "initiative.json");
  const initiative = JSON.parse(await readFile(record, "utf8"));
  initiative.slices[SLICE].design = { acceptedAt: "2026-11-20T21:14:00.000Z", review: "none", frozenTests: Object.entries(files).map(([file, text]) => ({ path: file, sha256: sha(text) })) };
  await writeFile(record, `${JSON.stringify(initiative, null, 2)}\n`);
  const id = "verification-001795220000000-abc123";
  const output = `${Array.from({ length: 400 }, (_, index) => `ok ${index} - passing test ${index}`).join("\n")}\n${FAILING.map((name) => `✖ ${name} (1ms)`).join("\n")}\nℹ fail 3\n`;
  const logFolder = path.join(path.dirname(root), "data", "verification-logs", "0123456789abcdef", INITIATIVE, SLICE);
  await mkdir(logFolder, { recursive: true });
  const log = path.join(logFolder, `${id}.log`);
  if (!elsewhere) await writeFile(log, output);
  const run = {
    kind: "verification", startedAt: "2026-11-20T23:40:24.000Z", command: "npm test", folder: ".", commandDigest: "0".repeat(64), designAcceptedAt: "2026-11-20T21:14:00.000Z",
    frozen: { checked: 2, changed: [], missing: [] }, finishedAt: "2026-11-20T23:41:12.000Z", durationMs: 48000, exitCode: 1, signal: null, timedOut: false, passed: false,
    reason: "command_failed", tree: null, failing: FAILING, failingCount: 3, outputTail: output.slice(-4000),
    checkout: { repository: null, remote: null, branch: "main", head: null, dirty: null, host: elsewhere ? "build-mac" : os.hostname().split(".")[0] },
    log: elsewhere ? `~/plugin-data/verification-logs/0123456789abcdef/${INITIATIVE}/${SLICE}/${id}.log` : log
  };
  const runs = path.join(root, ".prism", "initiatives", INITIATIVE, "slices", SLICE, "runs");
  await mkdir(runs, { recursive: true });
  await writeFile(path.join(runs, `${id}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

async function verificationTab(browser, base, viewport) {
  const page = await openPage(browser, reviewUrl(base, `slice:${INITIATIVE}/${SLICE}`), { viewport });
  await waitForView(page);
  await page.locator("#artifact").getByRole("tablist", { name: "Slice" }).getByRole("tab", { name: "Verification" }).click();
  return page;
}

const panel = (page) => page.evaluate(() => {
  const root = document.getElementById("side-panel");
  const body = document.getElementById("side-panel-body");
  return { open: !root.hidden, eyebrow: root.getAttribute("eyebrow"), heading: root.getAttribute("heading"), source: document.getElementById("side-panel-source").textContent, text: body.innerText, marked: [...body.querySelectorAll(".source-lines li.in-range")].map((line) => line.id) };
});

test("issues 381, 382: frozen tests, failing tests, and the run's log open in the side panel", { skip, timeout: 180000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await sliceWithRun(root);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await verificationTab(browser, base, { width: 1440, height: 900 });
  const card = page.locator("#artifact [data-tab-panel='verification']");
  assert.equal(await card.locator("prism-disclosure").count(), 0, "the output is no longer a collapsed section");
  assert.deepEqual(await escapes(page, "#artifact"), [], "a frozen test with an unbroken long name stays inside the card");

  await card.locator(`[data-frozen-test="${TEST}"]:not([data-frozen-line])`).click();
  await page.waitForFunction(() => document.querySelector("#side-panel-body .source-lines"));
  let shown = await panel(page);
  assert.deepEqual([shown.open, shown.eyebrow, shown.heading], [true, "Frozen test", "timeout-retries.test.mjs"]);
  assert.match(shown.text, /stops retrying once the deadline passes/);

  await card.locator("[data-frozen-line]", { hasText: FAILING[1] }).click();
  await page.waitForFunction(() => document.querySelector("#side-panel-body .source-lines li.in-range"));
  shown = await panel(page);
  assert.deepEqual(shown.marked, ["md-L5"], "a failing test opens its frozen test at the line naming it");
  assert.match(shown.source, /line 5/);
  const plain = card.locator("prism-chip", { hasText: FAILING[2] });
  assert.equal(await plain.getAttribute("interactive"), null, "a name no frozen test holds is not a link");

  await card.getByRole("button", { name: "Open the log" }).click();
  await page.waitForFunction(() => document.querySelector("#side-panel-body .verification-log"));
  shown = await panel(page);
  assert.equal(shown.eyebrow, "Verification log");
  assert.match(shown.text, /^ok 0 - passing test 0/, "this machine shows the whole log");
  assert.doesNotMatch(shown.text, /4,000 characters/);
  const end = await page.evaluate(() => { const body = document.getElementById("side-panel-body"); return body.scrollHeight - body.clientHeight - body.scrollTop; });
  assert.ok(end <= 2, "the log opens at its end");
  assert.deepEqual(page.errors, []);
});

test("issue 382: another machine's run shows the kept output with where the full log is, in the bottom sheet on a phone", { skip, timeout: 180000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await sliceWithRun(root, { elsewhere: true });
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await verificationTab(browser, base, { width: 390, height: 800 });
  await page.locator("#artifact").getByRole("button", { name: "Open the log" }).click();
  const sheet = page.locator("#side-panel-sheet");
  await sheet.locator(".verification-log-note").waitFor();
  const note = await sheet.locator(".verification-log-note").innerText();
  assert.match(note, /last 4,000 characters/);
  assert.match(note, /build-mac/);
  assert.match(note, /~\/plugin-data\/verification-logs\//);
  assert.match(await sheet.locator(".verification-log").innerText(), /^…/, "a partial log starts with an ellipsis");
  assert.ok(await sheet.locator(".verification-log-note").evaluate((element) => { const box = element.getBoundingClientRect(); return box.bottom <= innerHeight + 1 && box.top >= 0; }), "the sheet opens at the end, where the note is");
  assert.deepEqual(await escapes(page, "#side-panel"), []);
  assert.deepEqual(page.errors, []);
});
