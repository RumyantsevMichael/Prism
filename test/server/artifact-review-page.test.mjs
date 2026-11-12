import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { browserRequest, checkout, closeServers, git, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { launch, settle, skip as noBrowser } from "./fixtures/kit-browser.mjs";
import { defer } from "./fixtures/teardown.mjs";

// The Review card of a store artifact keeps the person's place while the page redraws it: the numbered lines' own scroll and an unsent comment, also when the file moves to another scope.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

// The workspace removes its folder in the first after hook that it adds, while an open page still polls the review app in that folder,
// which Windows refuses with EBUSY, so the teardown stack is added first: it closes the page's browser, then the review app, then the servers,
// and removes the folder retrying, since a Git process that the review app started can still be working in the checkout for a moment after it closed.
async function project(context) {
  let parent = null;
  defer(context, async () => {
    await closeServers();
    (await import("../../dist/server/workflow/record-store-sync.mjs")).cancelRecordSyncs();
    if (parent) await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const place = await workspace(context);
  parent = place.parent;
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  const close = review.close.bind(review);
  let closing = null;
  review.close = () => (closing ??= close());
  defer(context, () => review.close());
  return { place, prism, review };
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

  test(`at ${width} px the comment list is the file's first comments while comments arrive and go, and More comments keeps keyboard focus`, { skip: noBrowser, timeout: 240000 }, async (context) => {
    const { place, prism, review } = await project(context);
    const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
    const comment = async (text) => {
      const sent = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "artifact.comment", target: `artifact:workspace:${FILE}`, input: { line: "3", text }, revision: written.version } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
    };
    for (let index = 1; index <= 41; index += 1) await comment(`Comment ${index}.`);
    const page = await writableTab(context, review, width);
    const card = () => page.evaluate(() => ({
      heading: document.querySelector("#artifact-comments-heading")?.textContent,
      texts: [...document.querySelectorAll(".artifact-comment-text")].map((item) => item.textContent),
      more: Boolean(document.querySelector("[data-more-comments]")),
      focus: document.activeElement?.closest?.("[data-more-comments]") ? "More" : document.activeElement?.querySelector?.(".artifact-comment-text")?.textContent ?? document.activeElement?.tagName,
      wide: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }));
    const until = (predicate, label) => page.waitForFunction(predicate, null, { timeout: 15000 }).catch(async () => assert.fail(`${label}: ${JSON.stringify(await card())}`));
    const counting = (count) => Array.from({ length: count }, (_, index) => `Comment ${index + 1}.`);

    await page.locator("[data-more-comments]").focus();
    await page.keyboard.press("Enter");
    await until(() => document.querySelectorAll(".artifact-comment-text").length === 40, "a second read lists 40");
    assert.equal((await card()).focus, "More", "focus moves to the More comments button that follows the added comments");

    await comment("Comment 42.");
    await until(() => document.querySelector("#artifact-comments-heading")?.textContent === "42 comments", "an arriving comment is counted");
    await page.waitForTimeout(500);
    assert.equal((await card()).focus, "More", "a redraw for an arriving comment keeps focus on More comments");

    await page.keyboard.press("Enter");
    await until(() => document.querySelectorAll(".artifact-comment-text").length === 42, "a third read lists every comment");
    const read = await card();
    assert.deepEqual(read.texts, counting(42));
    assert.equal(read.more, false, "no More comments button follows the last comment");
    assert.equal(read.focus, "Comment 41.", "focus moves to the first added comment when no button follows");

    // A sync brings a comment made earlier on another machine, which sorts among the listed ones, and then a listed one goes.
    const folder = path.join(place.store, "artifact-comments", "requirements", "billing.md");
    const names = (await readdir(folder)).sort();
    const tenth = JSON.parse(await readFile(path.join(folder, names[9]), "utf8"));
    const at = new Date(Date.parse(tenth.at) + 1).toISOString();
    await writeFile(path.join(folder, `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`), `${JSON.stringify({ ...tenth, text: "Synced late.", at, entry: randomBytes(16).toString("hex") })}\n`);
    await until(() => document.querySelectorAll(".artifact-comment-text").length === 43, "the synced comment is listed");
    const synced = await card();
    assert.equal(synced.heading, "43 comments");
    assert.deepEqual(synced.texts, [...counting(10), "Synced late.", ...counting(42).slice(10)], "the synced comment takes its place in time order");
    assert.equal(synced.more, false);
    await rm(path.join(folder, names[4]));
    await until(() => document.querySelectorAll(".artifact-comment-text").length === 42, "a removed comment leaves the list");
    const removed = await card();
    assert.equal(removed.heading, "42 comments");
    assert.equal(removed.texts.includes("Comment 5."), false);
    assert.equal(removed.more, false);
    assert.equal(removed.wide, false, "the page does not scroll sideways");
    if (process.env.PRISM_SHOTS) await page.screenshot({ path: `${process.env.PRISM_SHOTS}/comments-${width}.png` });

    // Focus on a comment that More comments listed stays on that comment while the card redraws for another arriving comment, and never moves into the comment form.
    await page.locator('[data-comment-id]').filter({ hasText: "Comment 41." }).focus();
    await comment("Comment 43.");
    await until(() => document.querySelector("#artifact-comments-heading")?.textContent === "43 comments", "another arriving comment is counted");
    await page.waitForTimeout(500);
    assert.equal((await card()).focus, "Comment 41.", "a redraw keeps focus on the comment it was on");
    await page.keyboard.type("j");
    assert.equal(await page.evaluate(() => document.querySelector("[data-comment-form] input")?.value), "", "a typed key never reaches the comment form");
    assert.deepEqual(page.errors, []);
  });

  test(`at ${width} px the page never starts a poll while its last poll still runs`, { skip: noBrowser, timeout: 120000 }, async (context) => {
    const { prism, review } = await project(context);
    await writeArtifact(prism, FILE, requirementFile("Billing"));
    const page = await writableTab(context, review, width);
    const counts = { index: { now: 0, most: 0, started: 0 }, artifact: { now: 0, most: 0, started: 0 } };
    const kind = (request) => { const name = new URL(request.url()).pathname; return name.endsWith("/api/index") ? "index" : name.endsWith("/api/artifact") ? "artifact" : null; };
    page.on("request", (request) => { const count = counts[kind(request)]; if (count) { count.now += 1; count.started += 1; count.most = Math.max(count.most, count.now); } });
    const done = (request) => { const count = counts[kind(request)]; if (count) count.now -= 1; };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    // Each poll's first request answers only after 4 s, far longer than the 1.5 s between polls.
    await page.route((url) => url.pathname.endsWith("/api/index"), async (route) => { await new Promise((resolve) => setTimeout(resolve, 4000)); await route.continue().catch(() => {}); });
    await page.waitForTimeout(13000);
    assert.ok(counts.index.started >= 2, `the page went on polling: ${JSON.stringify(counts)}`);
    assert.equal(counts.index.most, 1, `polls never overlap: ${JSON.stringify(counts)}`);
    assert.ok(counts.artifact.most <= 1, `reads of the open file never overlap: ${JSON.stringify(counts)}`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    assert.deepEqual(page.errors, []);
  });

  test(`at ${width} px a press of More comments whose read a poll's redraw overtakes moves focus to the first added comment, never to the page`, { skip: noBrowser, timeout: 180000 }, async (context) => {
    const { prism, review } = await project(context);
    const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
    for (let number = 1; number <= 25; number += 1) {
      const posted = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "artifact.comment", target: `artifact:workspace:${FILE}`, input: { line: "3", text: `Comment ${number}.` }, revision: written.version } });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
    }
    const page = await writableTab(context, review, width);
    const focus = () => page.evaluate(() => {
      const active = document.activeElement;
      if (active?.closest?.("[data-more-comments]")) return "More";
      return active?.matches?.("li.artifact-comment") ? active.querySelector(".artifact-comment-text")?.textContent : active?.tagName;
    });
    await page.locator("[data-more-comments]").waitFor({ timeout: 15000 });
    await page.locator("[data-more-comments]").focus();
    // The press's read of the next page answers 3.5 s late, so the page's next poll reads both pages first and redraws the card with every comment.
    let delayed = 0;
    await page.route(/\/api\/artifact\?.*commentOffset=21/, async (route) => {
      if (delayed++ === 0) await new Promise((resolve) => setTimeout(resolve, 3500));
      await route.continue().catch(() => {});
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".artifact-comments > li").length === 25 && !document.querySelector("[data-more-comments]"), null, { timeout: 15000 });
    await page.waitForTimeout(5000);
    assert.ok(delayed >= 2, `a poll read the next page while the press's read waited: ${delayed}`);
    assert.equal(await focus(), "Comment 21.", "focus is on the first added comment");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    assert.deepEqual(page.errors, []);
  });
}
