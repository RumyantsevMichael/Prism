import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, checkout, git, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { launch, settle, skip as noBrowser } from "./fixtures/kit-browser.mjs";

// The Review card of a store artifact keeps the person's place while the page redraws it: the numbered lines' own scroll and an unsent comment, also when the file moves to another scope.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

async function project(context) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  return { prism, review };
}

// A tab of the review page on the file that holds the review app's write session, as a tab that Prism opened holds it.
async function writableTab(context, review, width) {
  const browser = await launch(context);
  const tab = await browser.newContext({ viewport: { width, height: 900 } });
  await tab.addInitScript((token) => sessionStorage.setItem("prism-write-session", token), review.writeHeaders["X-Prism-Write"]);
  const page = await tab.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await page.goto(`${review.baseUrl.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(FILE)}`);
  await settle(page);
  await page.locator("[data-comment-form] textarea").waitFor({ timeout: 15000 });
  return page;
}

const scopeShown = (page, label) => page.waitForFunction((label) => [...document.querySelectorAll(".artifact-review prism-chip")].some((chip) => chip.textContent.trim() === label), label, { timeout: 15000 });

for (const width of [390, 1440]) {
  test(`at ${width} px an unsent comment, its focus, and its cursor follow the file to another scope, and sending it comments there`, { skip: noBrowser, timeout: 120000 }, async (context) => {
    const { prism, review } = await project(context);
    const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
    const page = await writableTab(context, review, width);
    const form = () => page.evaluate(() => {
      const text = document.querySelector("[data-comment-form] textarea");
      return { line: document.querySelector("[data-comment-form] input")?.value, text: text?.value, focused: document.activeElement === text, cursor: [text?.selectionStart, text?.selectionEnd] };
    });
    await page.locator("[data-comment-form] input").fill("3");
    await page.locator("[data-comment-form] textarea").fill("Which currency do totals use?");
    await page.evaluate(() => { const text = document.querySelector("[data-comment-form] textarea"); text.focus(); text.setSelectionRange(5, 5); });
    const typed = await form();

    ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: written.version, scope: "repository" }] }));
    await scopeShown(page, "api");
    await page.waitForTimeout(1500);
    assert.deepEqual(await form(), typed, "the unsent comment stays in the form with its focus and cursor");
    if (process.env.PRISM_SHOTS) await page.screenshot({ path: `${process.env.PRISM_SHOTS}/draft-moved-${width}.png`, fullPage: true });

    await page.locator("[data-comment-form] prism-button[data-apply]").click();
    await page.waitForFunction(() => document.body.textContent.includes("1 comment"), null, { timeout: 15000 });
    const read = ok(await prism.call("get_artifact", { path: FILE }));
    assert.equal(read.scope.label, "api");
    assert.deepEqual(read.comments.map((item) => [item.line, item.text]), [[3, "Which currency do totals use?"]], "the comment is made on the file in its new scope");
    assert.deepEqual(page.errors, []);
  });

  test(`at ${width} px the numbered lines keep the line the person scrolled to while a comment arrives and the file changes`, { skip: noBrowser, timeout: 120000 }, async (context) => {
    const { prism, review } = await project(context);
    const content = `${requirementFile("Billing")}${Array.from({ length: 400 }, (_, index) => `Sentence ${index + 1} of the billing rules.`).join("\n")}\n`;
    let current = await writeArtifact(prism, FILE, content);
    const page = await writableTab(context, review, width);
    await page.getByRole("button", { name: "Lines of the current version" }).click();
    await page.locator("#L250").waitFor({ timeout: 10000 });
    // The line at the top of the list's own scroll box, by its number.
    const topLine = () => page.evaluate(() => {
      const box = document.querySelector(".artifact-lines-scroll");
      const top = box.getBoundingClientRect().top;
      return [...box.querySelectorAll(".artifact-line")].find((line) => line.getBoundingClientRect().bottom > top + 1)?.id ?? null;
    });
    await page.evaluate(() => { const box = document.querySelector(".artifact-lines-scroll"); box.scrollTop += document.getElementById("L250").getBoundingClientRect().top - box.getBoundingClientRect().top; });
    await page.waitForTimeout(300);
    const before = await topLine();
    assert.equal(before, "L250");

    const commented = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "artifact.comment", target: `artifact:workspace:${FILE}`, input: { line: "250", text: "Round this total?" }, revision: current.version } });
    assert.equal(commented.status, 200, JSON.stringify(commented.body));
    await page.waitForFunction(() => document.body.textContent.includes("Round this total?"), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    assert.equal(await topLine(), before, "an arriving comment leaves the same line at the top of the list");

    current = ok(await prism.call("get_artifact", { path: FILE }));
    ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: current.version, edits: [{ oldText: "Sentence 300 of the billing rules.", newText: "Sentence 300 of the billing rules, in euros." }] }] }));
    await page.waitForFunction(() => document.querySelector(".artifact-lines")?.textContent.includes("in euros."), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    assert.equal(await topLine(), before, "an edit of the file leaves the same line at the top of the list");
    if (process.env.PRISM_SHOTS) await page.screenshot({ path: `${process.env.PRISM_SHOTS}/lines-${width}.png` });
    assert.deepEqual(page.errors, []);
  });
}
