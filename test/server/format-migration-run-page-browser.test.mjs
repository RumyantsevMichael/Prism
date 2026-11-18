import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditContent, auditProposal, readRun, runCheckout, runFor, runStore } from "./fixtures/format-migration-runs.mjs";
import { escapes, launch, openPage, skip as noBrowser, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";

// A format migration run's page shows its set, diffs, and status, words each asked point, and offers the answer while the run asks
// and the rerun once it failed, built from the UI kit with every run and artifact text set as text.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-page-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const skip = noBrowser || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const MARKUP = "<img src=x onerror=window.__owned=1>";
const QUESTION_WORDS = /Where does this text belong\?|Do these entries mean the same\?|Which value is missing\?|Which definition stays\?|Remove the source document\?/;

async function opened(context, files, ref, { store = false, open = (prepared) => [`migration-run:${prepared.run}`] } = {}) {
  const { root, call, hosts } = store ? await runStore(context, files) : await runCheckout(context, files);
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app, PLUGIN_DATA: privateData });
  context.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  const prepared = await ref(call);
  const { review, opened: urls } = await startActionReview(context, root);
  await review.open(open(prepared));
  const browser = await launch(context);
  const page = await openPage(browser, urls.at(-1));
  await waitForView(page);
  return { page, call, root, ...prepared };
}

async function askingRun(call) {
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run, { content: auditContent({ problem: MARKUP }) }));
  const asked = bare.value.points.map((point) => ({ point, recommendation: `Leave it unknown ${MARKUP}` }));
  const proposed = await call("propose_migration", auditProposal(run, { content: auditContent({ problem: MARKUP }), summary: `Adds the sections ${MARKUP}`, asked }));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  return { run, points: proposed.value.migration.points };
}

const kitOnly = (page) => page.evaluate(() => {
  const view = document.querySelector("[data-view], main") ?? document.body;
  return [...view.querySelectorAll("*")].filter((element) => element.tagName.includes("-") && !element.tagName.toLowerCase().startsWith("prism-")).map((element) => element.tagName.toLowerCase());
});

test("clauses 4, 5, 10: an asking run's page shows its set, summary, and diff, words each asked point with its recommendation, and offers the answer", { skip, timeout: 120000 }, async (context) => {
  const { page, run, points } = await opened(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE }, askingRun);
  await page.getByText("Format migration", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.match(text, /Format migration[^\n]*Requirements/);
  assert.ok(text.includes(run), "the page names the run");
  assert.ok(text.includes(AUDIT), "the page lists the set's artifact");
  assert.match(text, /asking|waits for your answers/i);
  assert.ok(text.includes(`Adds the sections ${MARKUP}`), "the summary is shown as text");
  assert.ok(text.includes("## Problem"), "the diff from the source is shown");
  assert.equal((text.match(/Which value is missing\?/g) ?? []).length, points.length, "each unknown point is worded");
  assert.ok(text.includes(`Leave it unknown ${MARKUP}`), "the recommendation is shown as text");
  assert.match(text, QUESTION_WORDS);
  assert.equal(await page.evaluate(() => window.__owned ?? null), null, "no run text runs as markup");
  assert.equal(await page.locator("img[src='x']").count(), 0);
  assert.ok(await page.getByRole("button", { name: /answer/i }).count() >= 1, "the answer form is offered");
  assert.deepEqual(await kitOnly(page), [], "the page uses UI kit elements only");
  assert.deepEqual(await escapes(page), []);
  assert.deepEqual(page.errors, []);
});

test("clause 7: a failed run's page shows the reason and offers the rerun", { skip, timeout: 120000 }, async (context) => {
  const { page, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, async (call) => {
    const id = await runFor(call, PATHS.requirements);
    assert.equal((await call("fail_migration_run", { run: id, reason: `The section numbers are ambiguous. ${MARKUP}` })).refused, false);
    return { run: id };
  });
  await page.getByText("The section numbers are ambiguous.", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.ok(text.includes(`The section numbers are ambiguous. ${MARKUP}`));
  assert.ok(text.includes(run));
  assert.ok(await page.getByRole("button", { name: /run (it )?again|rerun/i }).count() >= 1, "the rerun is offered");
  assert.equal(await page.getByRole("button", { name: /^answer/i }).count(), 0, "a failed run offers no answer");
  assert.equal(await page.evaluate(() => window.__owned ?? null), null);
});

const applied = async (call) => {
  const id = await runFor(call, PATHS.requirements);
  const proposed = await call("propose_migration", { run: id, type: "requirements", source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [] });
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run: id })).refused, false);
  return { run: id };
};

test("clause 6: an applied run's page shows each migrated artifact's diff and summary", { skip, timeout: 120000 }, async (context) => {
  const { page, call, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, applied);
  assert.equal((await readRun(call, run)).status, "applied");
  await page.getByText("Adds the anchor of section 2.", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.match(text, /applied/i);
  assert.ok(text.includes('<a id="2"></a>'), "the diff from the source is shown");
  assert.equal(await page.getByRole("button", { name: /answer|run (it )?again|rerun/i }).count(), 0);
});

test("clause 8: a store artifact that a run migrated says on its page that Prism migrated it, with a link to the run", { skip, timeout: 120000 }, async (context) => {
  const { page, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, applied, { store: true, open: () => [PATHS.requirements] });
  await page.getByText("Prism migrated this file into its format", { exact: false }).first().waitFor();
  const link = page.locator(`a[href*="${encodeURIComponent(`migration-run:${run}`)}"], a[href*="migration-run:${run}"]`);
  assert.ok(await link.count() >= 1, "the note links the run's page");
});

test("clause 9: the Launched sessions list names a run's session Format migration and links the run's page", { skip, timeout: 120000 }, async (context) => {
  const { page, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, async (call) => ({ run: await runFor(call, PATHS.requirements) }), { open: () => ["launches"] });
  await page.getByText("Format migration", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.match(text, /Format migration[^\n]*Requirements/);
  const link = page.locator(`a[href*="${encodeURIComponent(`migration-run:${run}`)}"], a[href*="migration-run:${run}"]`);
  assert.ok(await link.count() >= 1, "the row links the run's page in place of an initiative");
});
