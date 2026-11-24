import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { eventually as waitFor, git, isolateGit, requirementFile, writeArtifact } from "./fixtures/workspace-view.mjs";
import { launch, openPage, reviewUrl, shownTooltip, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { choosePlace, drawer, eventually, open, placeButton, shownRef, sidebar, tabs } from "./fixtures/places-browser.mjs";
import { codePlaceWorkspace, commitWork } from "./fixtures/code-place.mjs";
import { repainted } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/code-place.md §2, §3, §9, §10, §14 to §19, §22 to §24, §26 to §29.
// Contract: docs/plans/code-place/slice.md clauses 3 to 5 and 39 to 49, through the review page of a workspace in a browser.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
let shared = null;
const workspace = () => (shared ??= codePlaceWorkspace(suite).then(async (built) => {
  await built.ready("place");
  // The review page that can write takes the one-time grant of a presented URL's fragment.
  const presented = await built.prism.control("present", { method: "POST", body: { open: true, acceptsGrant: true } });
  assert.equal(presented.status, 200, presented.body);
  return { ...built, base: `${built.prism.viewer}/w/${built.id}`, grant: presented.json.writeGrant, browser: await launch(suite) };
}));
const TIMEOUT = { skip, timeout: 600000 };

const tree = (page) => page.getByRole("tree", { name: "Files of every repository" });
const treeRow = (page, name) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }).first();
const chips = (page) => page.getByRole("group", { name: "Versions of this file" });
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

async function codePage(ref = "code", options = {}) {
  const { browser, base } = await workspace();
  const page = await open(browser, base, ref, options);
  await tree(page).waitFor({ timeout: 20000 });
  return page;
}

async function expand(page, ...names) {
  for (const name of names) {
    const row = treeRow(page, name);
    if (await row.getAttribute("aria-expanded") !== "true") await row.locator(":scope > a").first().click();
    await page.waitForFunction((label) => [...document.querySelectorAll("prism-tree-item")].some((node) => node.getAttribute("label") === label && node.hasAttribute("expanded")), name);
  }
}

async function openFile(page, folders, file) {
  await expand(page, ...folders);
  await treeRow(page, file).locator(":scope > a").first().click();
  await chips(page).waitFor({ timeout: 20000 });
}

test("clauses 40 and 42: a wide window shows one tree of every repository beside the file, with All files chosen on All work and branches", TIMEOUT, async () => {
  const page = await codePage();
  assert.equal(await placeButton(page, "Code").getAttribute("aria-pressed"), "true");
  const top = await tree(page).getByRole("treeitem").evaluateAll((items) => items.filter((node) => node.getAttribute("aria-level") === "1").map((node) => node.getAttribute("label") ?? node.textContent.trim()));
  assert.deepEqual(top, ["api", "infra", "mobile", "web"]);
  const files = page.getByRole("radiogroup", { name: "Files" }).or(page.getByRole("group", { name: "Files" }));
  assert.deepEqual((await files.getByRole("radio").allInnerTexts()).map((label) => label.trim()), ["All files", "Touched"]);
  assert.equal(await files.getByRole("radio", { name: "All files" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByText(/^Showing what /).count(), 0, "All work and branches names no narrowing");
  assert.equal(await treeRow(page, "api").locator('prism-icon[name="code"]').count(), 1, "a repository row shows the code icon");
  await openFile(page, ["api", "src", "retry"], "strategy.ts");
  const [treeBox, fileBox] = [await tree(page).boundingBox(), await chips(page).boundingBox()];
  assert.ok(treeBox.x + treeBox.width <= fileBox.x + 1, "the tree is beside the file");
});

test("clauses 42 and 43: files show their versions, New, or Removed with the marks of who changed them, and components show their badges", TIMEOUT, async () => {
  const page = await codePage();
  await expand(page, "api", "src", "retry");
  assert.match(await text(treeRow(page, "strategy.ts")), /4 versions/);
  assert.match(await text(treeRow(page, "deadline.ts")), /New/);
  assert.match(await text(treeRow(page, "legacy.ts")), /Removed/);
  assert.doesNotMatch(await text(treeRow(page, "backoff.ts")), /versions|New|Removed/);
  assert.ok(await treeRow(page, "strategy.ts").locator('prism-avatar[kind="person"][name="Dana Kim"]').count() >= 1);
  assert.ok(await treeRow(page, "strategy.ts").locator('prism-avatar[kind="agent"]').count() >= 1);
  assert.match(await text(treeRow(page, "infra")), /infra/, "infra's root component badge is on its row");
  assert.equal(await treeRow(page, "infra").locator("prism-chip prism-icon[name=\"layers\"]").count(), 1);
  await expand(page, "web", "packages");
  const charts = treeRow(page, "charts");
  assert.match(await text(charts), /charts.*1 branch/);
  await charts.locator("prism-chip, .prism-tree-flag").filter({ hasText: "1 branch" }).first().hover();
  assert.match(await eventually(async () => (await shownTooltip(page)) ?? "", "") || (await shownTooltip(page)) || "", /feature\/charts/);
});

test("clause 44: a repository with code content off says so and offers to turn it on to a page that can write", TIMEOUT, async () => {
  const { browser, base, grant } = await workspace();
  const page = await openPage(browser, `${reviewUrl(base, "code")}#write=${grant}`, { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await tree(page).waitFor({ timeout: 20000 });
  const mobile = treeRow(page, "mobile");
  assert.match(await text(mobile), /Off/);
  assert.equal(await mobile.getByRole("button", { name: "Turn code content on" }).count(), 1);
  const reader = await codePage();
  assert.equal(await treeRow(reader, "mobile").getByRole("button", { name: "Turn code content on" }).count(), 0, "a page that cannot write offers no switch");
});

test("clauses 45 and 46: a file shows its base and versions as chips, opens its first owned version as a difference, and a base as the file", TIMEOUT, async () => {
  const page = await codePage();
  await openFile(page, ["api", "src", "retry"], "strategy.ts");
  assert.match(await text(page.locator("#artifact")), /api \/ src\/retry\/strategy\.ts/);
  const labels = await chips(page).locator("prism-chip").evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, " ").trim()));
  assert.equal(labels.length, 4);
  assert.match(labels[0], /^main base$/);
  assert.match(labels[1], /Retry timed-out requests until a deadline.*\+3 −2.*verified/);
  assert.match(labels[2], /Report retry attempts as metrics.*\+4 −3.*verified/);
  assert.match(labels[3], /Tidy retry limits.*\+1 −1.*verified/);
  const pressed = await chips(page).locator("prism-chip").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("pressed")));
  assert.deepEqual(pressed, ["false", "true", "false", "false"]);
  const rows = await page.locator("#artifact table tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
  assert.equal(rows.length, 14);
  assert.deepEqual(rows[1].slice(0, 2), ["2", ""]);
  assert.match(rows[1][2], /^−/);
  assert.deepEqual(rows[2].slice(0, 2), ["", "2"]);
  assert.match(rows[2][2], /^\+/);
  await chips(page).locator("prism-chip").first().click();
  await eventually(() => chips(page).locator("prism-chip").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("pressed"))), ["true", "false", "false", "false"]);
  assert.equal(await page.locator("#artifact table tr td.diff-mark, #artifact .diff-mark").count(), 0, "the base shows no difference");
  assert.match(await text(page.locator("#artifact")), /export class RequestRetryStrategy/);
});

test("clause 47: the open version says which other version changes overlapping lines, and a version without a conflict says nothing", TIMEOUT, async () => {
  const page = await codePage();
  await openFile(page, ["api", "src", "retry"], "strategy.ts");
  assert.match(await text(page.locator("#artifact")), /Report retry attempts as metrics also changes lines 2–4, so whichever merges second will conflict\./);
  assert.equal(await page.locator("prism-inline-note[tone=\"warning\"]").count(), 1);
  await chips(page).locator("prism-chip").nth(3).click();
  await eventually(() => chips(page).locator("prism-chip").nth(3).getAttribute("pressed"), "true");
  assert.doesNotMatch(await text(page.locator("#artifact")), /will conflict/);
});

test("clauses 40 and 41: a narrowed page names what it shows, chooses Touched, and All files shows the rest again", TIMEOUT, async () => {
  const page = await codePage("code:work/retries/deadline");
  assert.match(await text(page.locator("#artifact")), /Showing what Retry timed-out requests until a deadline changes/);
  assert.equal(await page.locator("#artifact b, #artifact strong").filter({ hasText: "Retry timed-out requests until a deadline" }).count(), 1);
  const files = page.getByRole("radiogroup", { name: "Files" }).or(page.getByRole("group", { name: "Files" }));
  assert.equal(await files.getByRole("radio", { name: "Touched" }).getAttribute("aria-checked"), "true");
  await expand(page, "api", "src", "retry");
  assert.equal(await treeRow(page, "backoff.ts").count(), 0, "Touched hides a file no shown version changes");
  assert.equal(await treeRow(page, "metrics.ts").count(), 0, "another slice's new file is not part of this tree");
  assert.equal(await treeRow(page, "infra").count(), 0, "a repository the slice does not change holds no touched file");
  await files.getByRole("radio", { name: "All files" }).click();
  await treeRow(page, "backoff.ts").waitFor({ timeout: 10000 });
  assert.match(await text(treeRow(page, "strategy.ts")), /2 versions/, "the narrowed tree counts only the slice's version and the base");
  await treeRow(page, "strategy.ts").locator(":scope > a").first().click();
  await chips(page).waitFor();
  assert.equal(await chips(page).locator("prism-chip").count(), 2);
});

test("clause 4: an address that names no listed work or branch shows All with a note", TIMEOUT, async () => {
  const page = await codePage("code:branch/api/nothing");
  assert.match(await text(page.locator("#artifact")), /api · nothing changes no code that the Code place shows\./);
  assert.equal(await page.getByRole("radio", { name: "All files" }).getAttribute("aria-checked"), "true");
});

test("clause 3: a file's address opens its file view, and in a new tab with All work and branches", TIMEOUT, async () => {
  const page = await codePage("code:api:src/retry/strategy.ts");
  await chips(page).waitFor({ timeout: 20000 });
  assert.equal(await chips(page).locator("prism-chip").count(), 4, "a fresh tab shows every version");
  assert.equal(await treeRow(page, "strategy.ts").getAttribute("aria-selected"), "true", "the tree opens at the file");
});

test("clause 5: a Ctrl or Cmd click on a file opens it in a tab that stays open, and a record's link to a code file opens the Code place", TIMEOUT, async () => {
  const { owner, store, browser, base } = await workspace();
  const page = await codePage();
  await expand(page, "api", "src", "retry");
  await treeRow(page, "deadline.ts").locator(":scope > a").first().click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  assert.ok((await eventually(() => tabs(page), [])).some((tab) => tab.startsWith("code:api:src/retry/deadline.ts") && !tab.includes("(p)")), "the file has a kept tab");
  await writeArtifact(owner.server, "docs/requirements/retries.md", requirementFile("Retries").replace("Something is missing.", "See [the strategy](../../src/retry/strategy.ts)."), { scope: "repository" });
  await waitFor(() => { try { git(store.bare, "cat-file", "-e", "main:artifacts/repositories/api/requirements/retries.md"); return true; } catch { return false; } }, 30000, "the store holds the requirement");
  const record = await open(browser, base, "store:repositories/api/requirements/retries.md");
  const link = await eventually(async () => record.locator('a[data-doc-link="code:api:src/retry/strategy.ts"]').count(), 1, { timeout: 20000 });
  assert.equal(link, 1);
  await record.locator('a[data-doc-link="code:api:src/retry/strategy.ts"]').click();
  assert.equal(await eventually(() => shownRef(record), "code:api:src/retry/strategy.ts"), "code:api:src/retry/strategy.ts");
  await chips(record).waitFor({ timeout: 20000 });
  assert.equal(await placeButton(record, "Code").getAttribute("aria-pressed"), "true");
});

test("clause 48: a narrow window shows the sidebar in the drawer and the tree and the file as two screens with a Files back button", TIMEOUT, async () => {
  const page = await codePage("code", { width: 390, height: 844 });
  assert.equal(await sidebar(page).isVisible(), false, "the sidebar is in the drawer");
  await page.locator("#nav-button").click();
  await drawer(page).waitFor();
  await choosePlace(drawer(page), "Code");
  assert.match(await drawer(page).innerText(), /All work and branches/);
  await page.keyboard.press("Escape");
  await repainted(page);
  await openFile(page, ["api", "src", "retry"], "strategy.ts");
  assert.equal(await tree(page).isVisible(), false, "the file is its own screen");
  const back = page.getByRole("button", { name: "Files" });
  assert.equal(await back.count(), 1);
  await back.click();
  await tree(page).waitFor();
  assert.equal(await treeRow(page, "strategy.ts").getAttribute("aria-selected"), "true", "the tree comes back with the file chosen");
  assert.equal(await chips(page).isVisible(), false);
});

test("clause 49: no screen offers a choice of repository or branch, and no text says concept", TIMEOUT, async () => {
  const page = await codePage();
  await openFile(page, ["api", "src", "retry"], "strategy.ts");
  const body = await text(page.locator("body"));
  for (const word of ["Compare with", "Repository:", "Branch:"]) assert.equal(body.includes(word), false, word);
  assert.doesNotMatch(body, /concept/i);
  assert.equal(await page.locator("[data-code-repository-menu], [data-code-branch-menu], [data-code-base-menu], prism-picker").count(), 0);
});

test("clause 39: a push to an open file's line of work redraws the open file without a reload", TIMEOUT, async () => {
  const page = await codePage("code:api:src/retry/strategy.ts");
  await chips(page).waitFor({ timeout: 20000 });
  const { owner } = await workspace();
  git(owner.root, "checkout", "-q", "-b", "team/strategy", "main");
  await commitWork(owner.root, { title: "rename the class", files: { "src/retry/strategy.ts": "export class RetryStrategy {}\n" } });
  git(owner.root, "push", "-q", "origin", "team/strategy");
  git(owner.root, "checkout", "-q", "main");
  assert.equal(await eventually(() => chips(page).locator("prism-chip").count(), 5, { timeout: 20000 }), 5, "the new version joins the open file");
  assert.equal(await shownRef(page), "code:api:src/retry/strategy.ts");
});
