import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditContent, auditProposal, readRun, runCheckout, runFor, runStore } from "./fixtures/format-migration-runs.mjs";
import { escapes, launch, openPage, skip as noBrowser, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { pause } from "./fixtures/wait.mjs";

// A format migration run's page shows its set, statement maps, and status, words each asked point with its recommendation prefilled, and offers one answer while the run asks
// and the rerun once it failed, built from the UI kit with every run and artifact text set as text.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-page-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const skip = noBrowser || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const MARKUP = "<img src=x onerror=window.__owned=1>";
const MARKED = `Administrators change settings ${MARKUP} that nobody can trace.`;
const MARKED_SOURCE = AUDIT_SOURCE.replace("Administrators change settings that nobody can trace.", MARKED);
const PATH_TEXT = "see [the retries](docs/requirements/retries.md) and docs/requirements/retries.md";
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
  const bare = await call("propose_migration", auditProposal(run, { content: auditContent({ problem: MARKED }) }));
  const asked = bare.value.points.map((point) => ({ point, recommendation: `Leave it unknown ${MARKUP}` }));
  const proposed = await call("propose_migration", auditProposal(run, { content: auditContent({ problem: MARKED }), summary: `Adds the sections ${MARKUP}, ${PATH_TEXT}`, asked }));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  return { run, points: proposed.value.migration.points };
}

const kitOnly = (page) => page.evaluate(() => {
  const view = document.querySelector("[data-view], main") ?? document.body;
  return [...view.querySelectorAll("*")].filter((element) => element.tagName.includes("-") && !element.tagName.toLowerCase().startsWith("prism-")).map((element) => element.tagName.toLowerCase());
});

test("clauses 4, 5, 10, 16, 17: an asking run's page shows its set, summary, and statement map, words each asked point with its recommendation prefilled, and offers one answer", { skip, timeout: 120000 }, async (context) => {
  const { page, run, points } = await opened(context, { ...CONFORMING, [AUDIT]: MARKED_SOURCE }, askingRun);
  await page.getByText("Format migration", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.match(text, /Format migration[^\n]*Requirements/);
  assert.ok(text.includes(run), "the page names the run");
  assert.ok(text.includes(AUDIT), "the page lists the set's artifact");
  assert.match(text, /asking|waits for your answers/i);
  assert.ok(text.includes(`Adds the sections ${MARKUP}, ${PATH_TEXT}`), "the summary is shown as text");
  const map = page.locator("prism-lib-table .prism-lib-row", { hasText: "The system shall record every administrative action." });
  assert.equal(await map.count(), 1, "the statement map lists the source statement once, word for word");
  assert.match(await map.innerText(), /1\. Record administrative actions/, "the statement shows the section it landed in");
  const marked = page.locator("prism-lib-table .prism-lib-row", { hasText: MARKED });
  assert.equal(await marked.count(), 1, "a source statement with markup is listed as text");
  assert.match(await marked.innerText(), /Problem/);
  assert.ok(text.includes("Added by the format"), "the map lists what the format added");
  assert.equal((text.match(/Which value is missing\?/g) ?? []).length, points.length, "each unknown point is worded");
  assert.ok(text.includes(`Leave it unknown ${MARKUP}`), "the recommendation is shown as text");
  const prefilled = await page.evaluate((ids) => ids.map((id) => document.querySelector(`[data-answer-field="${id}"]`)?.value ?? null), points.map((point) => point.id));
  assert.deepEqual(prefilled, points.map(() => `Leave it unknown ${MARKUP}`), "each answer starts as the recommendation, the value itself");
  assert.match(text, QUESTION_WORDS);
  assert.equal(await page.evaluate(() => window.__owned ?? null), null, "no run text runs as markup");
  assert.equal(await page.locator("img[src='x']").count(), 0);
  assert.equal(await page.locator("a", { hasText: "docs/requirements/retries.md" }).count(), 0, "a path in an agent's text is no link");
  assert.equal(await page.getByRole("button", { name: /send answers/i }).count(), 1, "one answer sends the whole run");
  assert.equal(await page.getByRole("button", { name: /^(accept|decline|keep)/i }).count(), 0, "the page offers no accept, decline, or keep-as-is");
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

test("a failed run's Attention sheet puts its two actions apart at the sheet's end, lists by its time among the questions, and its file's format finding offers the rerun", { skip, timeout: 120000 }, async (context) => {
  const { page, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, async (call) => {
    const id = await runFor(call, PATHS.requirements);
    // A question asked before the run failed lists after the failure, since Needs you lists the newest first.
    assert.equal((await call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "exports", title: "Exports", intent: "Export the records.", band: "Now" }] })).refused, false);
    const asked = await call("update_coordination_state", { initiative: "exports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Keep the old export layout?", context: "Two scripts still read it.", artifacts: [], options: [{ id: "keep", label: "Keep", consequence: "Both layouts." }, { id: "drop", label: "Drop", consequence: "Only the new one." }], recommended: { option: "keep", reason: "Both scripts read it." } }] } });
    assert.equal(asked.refused, false, asked.text);
    await pause(20, "the failure must be at least a millisecond newer than the question, which no event marks");
    assert.equal((await call("fail_migration_run", { run: id, reason: "The section numbers are ambiguous." })).refused, false);
    return { run: id };
  }, { open: () => [] });
  const titles = await page.locator("[data-needs-you] prism-inbox-item, prism-inbox-item").allInnerTexts();
  const failedAt = titles.findIndex((text) => text.includes("failed"));
  const questionAt = titles.findIndex((text) => text.includes("Keep the old export layout?"));
  assert.ok(failedAt >= 0 && questionAt >= 0 && failedAt < questionAt, `the newer failure lists before the older question: ${JSON.stringify(titles)}`);
  await page.getByText("Requirements in this checkout failed").first().click();
  const open = page.locator(".note-migration-failed prism-button", { hasText: "Open the run" });
  const rerun = page.locator(".note-migration-failed prism-button", { hasText: "Run again" });
  await rerun.waitFor();
  const [left, right, sheet] = [await open.boundingBox(), await rerun.boundingBox(), await page.locator(".note-migration-failed .gate-actions").boundingBox()];
  assert.ok(right.x - (left.x + left.width) >= 8, `the buttons keep a gap: ${JSON.stringify([left, right])}`);
  assert.ok(sheet.x + sheet.width - (right.x + right.width) <= 1, "the actions sit at the sheet's end");
  await page.getByText("Format findings").first().click();
  const finding = page.locator("prism-row", { hasText: PATHS.requirements }).locator("prism-button[data-migration-rerun]");
  await finding.waitFor();
  assert.equal(await finding.getAttribute("data-migration-rerun"), run);
  await finding.click();
  await page.getByText("Run the format migration again?").first().waitFor();
});

const applied = async (call) => {
  const id = await runFor(call, PATHS.requirements);
  const proposed = await call("propose_migration", { run: id, type: "requirements", source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [] });
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run: id })).refused, false);
  return { run: id };
};

test("clauses 6, 16: an applied run's page shows each migrated artifact's statement map and summary", { skip, timeout: 120000 }, async (context) => {
  const { page, call, run } = await opened(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, applied);
  assert.equal((await readRun(call, run)).status, "applied");
  await page.getByText("Adds the anchor of section 2.", { exact: false }).first().waitFor();
  const text = await page.locator("body").innerText();
  assert.match(text, /applied/i);
  assert.ok(text.includes("Clients give up on the first dropped connection."), "the statement map lists the source's statements");
  assert.ok(text.includes("Added by the format") && text.includes('<a id="2"></a>'), "the map lists the anchor the format added");
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
