import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { isolateGit, networkStore, place, requirementFile, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { launch, settle, skip } from "./fixtures/kit-browser.mjs";

// A link preview on a workspace's page reads its target the way opening the link does, and shows the whole linked section, or the whole document, in a card that scrolls.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const LONG_SECTION = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} of the rounding section.`).join("\n\n");
// Both files keep the requirement format, which a store write checks, so the linked sections are subsections of the problem.
const withProblem = (title, problem) => requirementFile(title).replace("## Problem\n\nSomething is missing.\n", `## Problem\n\n${problem}\n`);
const TOTALS = withProblem("Totals", `Intro.\n\n### Rounding\n\n${LONG_SECTION}\n\n### Currency\n\nThe next section.\n`);
const BILLING = withProblem("Billing", "See [rounding](totals.md#rounding) and [all totals](totals.md).\n");

async function workspacePage(context, viewport = { width: 1280, height: 800 }) {
  const where = await place(context);
  const store = await networkStore(where);
  const root = await storeCheckout(context, where, "api", store.url);
  const api = await server(context, where, root);
  await writeArtifact(api, "docs/requirements/billing.md", BILLING, { scope: "repository" });
  await writeArtifact(api, "docs/requirements/totals.md", TOTALS, { scope: "repository" });
  const prism = await startApp(context, where);
  await prism.register(root);
  const browser = await launch(context);
  const page = await (await browser.newContext({ viewport })).newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  page.reads = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/artifact?")) page.reads.push(decodeURIComponent(request.url().split("/api/artifact?")[1]));
  });
  await page.goto(`${prism.viewer}/w/${workspaceId(store.identity)}/review?artifact=${encodeURIComponent("store:repositories/api/requirements/billing.md")}`);
  await settle(page);
  await page.locator("#workspace a[data-doc-link]").first().waitFor();
  return page;
}

const shown = (page) => page.locator(".link-preview:not([hidden])");

async function hover(page, locator) {
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => !document.querySelector(".link-preview:not([hidden])"));
  await locator.hover();
  await shown(page).waitFor({ timeout: 5000 });
  return page.evaluate(() => {
    const card = document.querySelector(".link-preview:not([hidden])");
    const body = card.querySelector(".prism-hover-card-body");
    return { text: card.textContent, width: card.getBoundingClientRect().width, scrolls: body.scrollHeight > body.clientHeight, overflow: getComputedStyle(body).overflowY, fades: body.hasAttribute("data-more") };
  });
}

test("a link with an anchor previews its whole section in a card that scrolls, and a link without one the whole document", { skip }, async (context) => {
  const page = await workspacePage(context);
  const section = await hover(page, page.locator("#workspace a", { hasText: /^rounding$/ }));
  assert.match(section.text, /Paragraph 1 of/, "the section starts at its heading");
  assert.match(section.text, /Paragraph 30 of/, "the whole section shows, past the first blocks");
  assert.doesNotMatch(section.text, /The next section/, "the section ends before the next heading of its level");
  assert.doesNotMatch(section.text, /Intro\./, "nothing before the section shows");
  assert.ok(section.scrolls && section.overflow === "auto", "a section taller than the room beside the link scrolls inside the card");
  assert.equal(section.fades, true, "the card's end fades while more of the section lies below");
  assert.ok(section.width > 500, `the card is as wide as a readable column, not ${section.width}px`);
  const whole = await hover(page, page.locator("#workspace a", { hasText: /^all totals$/ }));
  assert.match(whole.text, /Intro\./);
  assert.match(whole.text, /The next section/, "a link without an anchor previews the whole document");
  assert.deepEqual(page.errors, []);
});

test("the card stays beside its link and inside a narrow, short window", { skip }, async (context) => {
  const page = await workspacePage(context, { width: 420, height: 480 });
  await hover(page, page.locator("#workspace a", { hasText: /^rounding$/ }));
  const boxes = await page.evaluate(() => {
    const card = document.querySelector(".link-preview:not([hidden])").getBoundingClientRect();
    const link = [...document.querySelectorAll("#workspace a")].find((element) => element.textContent === "rounding").getBoundingClientRect();
    return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, link: { top: link.top, bottom: link.bottom }, width: innerWidth, height: innerHeight };
  });
  assert.ok(boxes.card.left >= 0 && boxes.card.right <= boxes.width, `the card fits the window's width: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.card.top >= 0 && boxes.card.bottom <= boxes.height, `the card fits the window's height: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.card.top >= boxes.link.bottom || boxes.card.bottom <= boxes.link.top, `the card never covers its link: ${JSON.stringify(boxes)}`);
});

test("a link naming a store artifact by its checkout path previews it by the store ref that opening it reads", { skip }, async (context) => {
  const page = await workspacePage(context);
  await page.evaluate(() => {
    const chip = document.createElement("span");
    chip.dataset.artifact = "docs/requirements/totals.md";
    chip.dataset.docAnchor = "rounding";
    chip.textContent = "totals by checkout path";
    document.querySelector("#workspace").prepend(chip);
  });
  page.reads.length = 0;
  const preview = await hover(page, page.getByText("totals by checkout path"));
  assert.match(preview.text, /Paragraph 30 of/);
  assert.deepEqual(page.reads, ["ref=store:repositories/api/requirements/totals.md"], "the preview reads the store ref, as opening the link does");
  await shown(page).hover();
  await page.mouse.wheel(0, 400);
  assert.equal(await shown(page).isVisible(), true, "scrolling inside the card keeps it open");
  await page.locator(".link-preview:not([hidden]) .prism-hover-card-body").evaluate((body) => { body.scrollTop = body.scrollHeight; body.dispatchEvent(new Event("scroll")); });
  assert.equal(await page.locator(".link-preview:not([hidden]) .prism-hover-card-body").evaluate((body) => body.hasAttribute("data-more")), false, "the fade goes at the end of the content");
  assert.deepEqual(page.errors, []);
});

test("a store document shown in the side panel from its checkout path links to other store artifacts that preview", { skip }, async (context) => {
  const page = await workspacePage(context);
  await page.evaluate(() => {
    const chip = document.createElement("span");
    chip.dataset.artifact = "docs/requirements/billing.md";
    chip.textContent = "billing by checkout path";
    document.querySelector("#workspace").prepend(chip);
  });
  await hover(page, page.getByText("billing by checkout path"));
  page.reads.length = 0;
  await shown(page).getByText("Show in side panel").click();
  const link = page.locator("#side-panel a", { hasText: /^rounding$/ });
  await link.waitFor();
  assert.deepEqual(page.reads, ["ref=store:repositories/api/requirements/billing.md"], "the panel reads the store ref, as opening the link does");
  assert.equal(await link.getAttribute("data-doc-link"), "store:repositories/api/requirements/totals.md", "the panel's links name store artifacts");
  const preview = await hover(page, link);
  assert.match(preview.text, /Paragraph 30 of/, "a link in the panel previews its section");
  assert.deepEqual(page.errors, []);
});
