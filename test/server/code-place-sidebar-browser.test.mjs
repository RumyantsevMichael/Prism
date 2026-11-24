import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { git, isolateGit } from "./fixtures/workspace-view.mjs";
import { launch, shownTooltip, skip } from "./fixtures/kit-browser.mjs";
import { buttonNames, choosePlace, eventually, groupHeadings, item, itemNames, open, placeButton, rail, row, shownPlace, shownRef, sidebar } from "./fixtures/places-browser.mjs";
import { codePlaceWorkspace, codeWorkspace, commitWork } from "./fixtures/code-place.mjs";
import { repainted } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/code-place.md §1, §3 to §8, §10 to §13, review-app-places.md §53.
// Contract: docs/plans/code-place/slice.md clauses 1 to 4, 19 to 25, and 39, through the review page of a workspace in a browser.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
let shared = null;
const workspace = () => (shared ??= codePlaceWorkspace(suite).then(async (built) => {
  await built.ready("place");
  return { ...built, base: `${built.prism.viewer}/w/${built.id}`, browser: await launch(suite) };
}));
const TIMEOUT = { skip, timeout: 600000 };

async function codePage(ref = "code", options = {}) {
  const { browser, base } = await workspace();
  const page = await open(browser, base, ref, options);
  await choosePlace(page, "Code");
  return page;
}

const IN_PROGRESS = [
  "Harden request retries",
  "Retry timed-out requests until a deadline",
  "Report retry attempts as metrics",
  "Export activity reports",
  "Download signed reports",
  "api · claude/signed-download",
  "api · claude/signed-download-ui",
  "Tidy retry limits"
];
const OTHERS = ["api · review/deadline", "web · feature/charts", "api · feature/http", "api · release/2026.11", "api · gh-pages"];

test("clause 1: the rail holds Code between Knowledge and History, named on focus, with its subtitle", TIMEOUT, async () => {
  const page = await codePage();
  const names = (await buttonNames(rail(page))).map((name) => name.split(",")[0]);
  assert.deepEqual(names, ["Attention", "Work", "Roadmap", "Knowledge", "Code", "History"]);
  assert.equal(await placeButton(page, "Code").getAttribute("aria-pressed"), "true");
  assert.equal(await shownPlace(page), "Code");
  assert.match(await sidebar(page).innerText(), /What the code in flight changes/);
});

test("clause 1: a workspace whose store registers no repository has no Code place", TIMEOUT, async (context) => {
  const empty = await codeWorkspace(context, { repositories: [] });
  const browser = await launch(context);
  const page = await open(browser, `${empty.prism.viewer}/w/${empty.id}`, "roadmap");
  assert.equal(await placeButton(page, "Code").count(), 0);
  assert.equal(await placeButton(page, "History").count(), 1);
});

test("clause 2: Knowledge lists no Code entry, and a Code address presses Code and leads its trail", TIMEOUT, async () => {
  const page = await codePage();
  await choosePlace(page, "Knowledge");
  assert.equal(await sidebar(page).getByRole("treeitem", { name: /^Code\b/ }).count(), 0);
  const { browser, base } = await workspace();
  const file = await open(browser, base, "code:api:src/retry/strategy.ts");
  assert.equal(await placeButton(file, "Code").getAttribute("aria-pressed"), "true");
  assert.equal((await file.locator("#page-bar prism-breadcrumbs a").first().innerText()).trim(), "Code");
});

test("clauses 19 and 20: the sidebar leads with the filter, All work and branches, In progress, Other branches, and the quiet note", TIMEOUT, async () => {
  const page = await codePage();
  const side = sidebar(page);
  assert.equal(await side.getByRole("searchbox", { name: "Filter work and branches" }).or(side.getByRole("textbox", { name: "Filter work and branches" })).count(), 1);
  const { ready } = await workspace();
  const lines = (await ready("place")).json.lines;
  assert.match((await item(side, "All work and branches").innerText()).replace(/\s+/g, " "), new RegExp(`All work and branches ${lines}$`));
  assert.deepEqual(await groupHeadings(side), ["In progress", "Other branches"]);
  const headings = (await side.getByRole("heading", { level: 3 }).allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  assert.deepEqual(headings, ["In progress 3", "Other branches 5"]);
  assert.deepEqual(await itemNames(side), ["All work and branches", ...IN_PROGRESS, ...OTHERS]);
  assert.match((await side.innerText()).replace(/\s+/g, " "), /1 quiet branch is hidden: no push in 30 days\. Show them/);
  assert.equal(await side.getByRole("link", { name: "Show them" }).count(), 1);
});

test("clause 20: each row shows its glyph, its count of changed files, and its agent or person", TIMEOUT, async () => {
  const page = await codePage();
  const side = sidebar(page);
  const text = async (name) => (await row(side, name).innerText()).replace(/\s+/g, " ").trim();
  assert.match(await text("Harden request retries"), /6$/);
  assert.match(await text("Retry timed-out requests until a deadline"), /5$/);
  assert.match(await text("api · claude/signed-download"), /2$/);
  assert.match(await text("api · release/2026.11"), /1$/);
  assert.equal(await item(side, "Harden request retries").locator("prism-status").count() >= 1, true, "a work item shows its status glyph");
  assert.equal(await item(side, "Retry timed-out requests until a deadline").locator("prism-phase").count() >= 1, true, "a slice shows its phase glyph");
  assert.equal(await row(side, "api · release/2026.11").locator('prism-avatar[kind="person"][name="Sam Ortiz"]').count(), 1);
  assert.equal(await row(side, "web · feature/charts").locator('prism-avatar[kind="person"][name="Dana Kim"]').count(), 1);
  assert.equal(await row(side, "api · claude/signed-download").locator("prism-icon[name=\"branch\"]").count(), 1);
});

test("clause 21: only a row with more than one line of work expands into them, and each row names its facts on focus", TIMEOUT, async () => {
  const page = await codePage();
  const side = sidebar(page);
  assert.equal(await item(side, "Download signed reports").getAttribute("aria-expanded"), "true");
  assert.equal(await item(side, "Tidy retry limits").getAttribute("aria-expanded"), null, "one line of work is not expanded into a row");
  await row(side, "api · claude/signed-download").focus();
  const tip = await eventually(async () => /from main/.test((await shownTooltip(page)) ?? ""), true);
  assert.equal(tip, true, "the row's tooltip names its base");
  assert.match(await shownTooltip(page), /api · claude\/signed-download, from main · .* · 2 files changed/);
});

test("clause 22: the filter keeps the rows whose title, repository, or branch holds the text, and Escape clears it", TIMEOUT, async () => {
  const page = await codePage();
  const side = sidebar(page);
  const field = side.locator("prism-field").first();
  await field.click();
  await page.keyboard.type("HTTP");
  assert.deepEqual(await eventually(() => itemNames(side), ["All work and branches", "api · feature/http"]), ["All work and branches", "api · feature/http"]);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("deadline");
  const deadline = await eventually(() => itemNames(side), ["All work and branches", "Harden request retries", "Retry timed-out requests until a deadline", "api · review/deadline"]);
  assert.deepEqual(deadline, ["All work and branches", "Harden request retries", "Retry timed-out requests until a deadline", "api · review/deadline"]);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("nothing-like-this");
  assert.match(await side.innerText(), /No work or branch matches "nothing-like-this"\./);
  await page.keyboard.press("Escape");
  assert.deepEqual(await eventually(() => itemNames(side), ["All work and branches", ...IN_PROGRESS, ...OTHERS]), ["All work and branches", ...IN_PROGRESS, ...OTHERS]);
});

test("clauses 3 and 24: choosing a row opens its address and marks it, All resets, and a browser opens the place on All first", TIMEOUT, async () => {
  const page = await codePage("roadmap");
  assert.equal(await shownRef(page), "code", "the first open of the Code place shows All work and branches");
  const side = sidebar(page);
  assert.equal(await row(side, "Retry timed-out requests until a deadline").getAttribute("href"), "./review?artifact=code%3Awork%2Fretries%2Fdeadline");
  assert.equal(await row(side, "api · feature/http").getAttribute("href"), "./review?artifact=code%3Abranch%2Fapi%2Ffeature%2Fhttp");
  await row(side, "Retry timed-out requests until a deadline").click();
  assert.equal(await eventually(() => shownRef(page), "code:work/retries/deadline"), "code:work/retries/deadline");
  assert.equal(await item(side, "Retry timed-out requests until a deadline").getAttribute("aria-selected"), "true");
  await row(side, "Harden request retries").click();
  assert.equal(await eventually(() => shownRef(page), "code:work/retries"), "code:work/retries");
  await row(side, "All work and branches").click();
  assert.equal(await eventually(() => shownRef(page), "code"), "code");
  assert.equal(await item(side, "All work and branches").getAttribute("aria-selected"), "true");
});

test("clause 23: Show them lists the quiet branches and Hide them hides them again", TIMEOUT, async () => {
  const page = await codePage();
  const side = sidebar(page);
  await side.getByRole("link", { name: "Show them" }).click();
  assert.ok((await eventually(() => itemNames(side), [])).includes("api · old/experiment"));
  assert.match((await side.innerText()).replace(/\s+/g, " "), /1 quiet branch is shown\. Hide them/);
  await side.getByRole("link", { name: "Hide them" }).click();
  await repainted(page);
  assert.equal((await itemNames(side)).includes("api · old/experiment"), false);
  assert.match((await side.innerText()).replace(/\s+/g, " "), /1 quiet branch is hidden: no push in 30 days\. Show them/);
});

test("clause 25: Settings sets the quiet-branch threshold from 1 to 365 days and keeps it", TIMEOUT, async () => {
  const page = await codePage();
  await page.keyboard.press("Control+,");
  const field = page.getByRole("spinbutton", { name: "Quiet branches after" });
  await field.waitFor({ timeout: 10000 });
  assert.equal(await field.inputValue(), "30");
  await field.fill("40");
  await field.press("Enter");
  await page.keyboard.press("Escape");
  const side = sidebar(page);
  assert.ok((await eventually(async () => (await itemNames(side)).includes("api · old/experiment"), true)), "35 days without a commit is not quiet at 40");
  assert.doesNotMatch(await side.innerText(), /quiet branch/);
  const { browser, base } = await workspace();
  const again = await open(browser, base, "code");
  await again.keyboard.press("Control+,");
  const kept = again.getByRole("spinbutton", { name: "Quiet branches after" });
  await kept.waitFor({ timeout: 10000 });
  assert.equal(await kept.inputValue(), "40", "the threshold is the person's own preference");
  for (const value of ["0", "366"]) {
    await kept.fill(value);
    await kept.press("Enter");
    assert.equal(await kept.evaluate((input) => input.validity?.valid ?? input.control?.validity?.valid), false, `${value} is outside 1 to 365`);
  }
  await kept.fill("30");
  await kept.press("Enter");
});

test("clause 39: a branch pushed while the place is open appears without a reload", TIMEOUT, async () => {
  const page = await codePage();
  const { owner } = await workspace();
  git(owner.root, "checkout", "-q", "-b", "team/late", "main");
  await commitWork(owner.root, { title: "late work", files: { "src/late.ts": "export const late = true;\n" } });
  git(owner.root, "push", "-q", "origin", "team/late");
  git(owner.root, "checkout", "-q", "main");
  const names = await eventually(async () => (await itemNames(sidebar(page))).includes("api · team/late"), true, { timeout: 20000 });
  assert.equal(names, true);
});
