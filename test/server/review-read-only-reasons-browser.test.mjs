import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, serveProject, skip, useAppDirectory, writableReviewUrl } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// A tab that can only read says why: it was opened from a review link, the grant it was opened with no longer worked, or its write session ended.

const FIRST = "This tab can only read.";
const REMEDY = "To make changes, run prism review in this project, or ask the agent to present the review.";
const REASONS = {
  link: "It was opened from a review link, and only a tab that Prism opens itself can make changes.",
  grant: "The link that Prism opened it with was already used or was more than two minutes old.",
  ended: "Its write session ended, because the review app restarted."
};
const notice = (reason) => `${FIRST} ${REASONS[reason]} ${REMEDY}`;

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-read-only-reasons-")));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  return root;
}

const dialog = (page) => page.getByRole("dialog", { name: "Settings" });
const personal = (page) => dialog(page).getByRole("region", { name: "Personal settings" });

async function personalNotice(page) {
  if (!(await dialog(page).isVisible())) await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await dialog(page).getByRole("treeitem", { name: "Personal" }).click();
  await personal(page).waitFor();
  const shown = personal(page).getByRole("note").filter({ hasText: FIRST });
  await shown.waitFor();
  return (await shown.innerText()).replace(/\s+/g, " ").trim();
}

test("a tab opened from a review link says it was opened from a link", { skip, timeout: 60000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await project(context));
  const page = await openPage(await launch(context), `${base}/review`);
  assert.equal(await personalNotice(page), notice("link"));
});

test("a tab whose grant was already used says the link Prism opened it with no longer worked", { skip, timeout: 60000 }, async (context) => {
  await useAppDirectory(context);
  const url = await writableReviewUrl(context, await project(context), "attention");
  const grant = new URLSearchParams(new URL(url).hash.slice(1)).get("write");
  const exchange = new URL("api/write-session", new URL(url).href.replace(/review.*$/, ""));
  const used = await fetch(exchange, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant }) });
  assert.equal(used.status, 200, "another client took the grant first");
  const browser = await launch(context);
  const page = await openPage(browser, "about:blank");
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/write-session"));
  await page.goto(url);
  assert.equal((await refused).status(), 403);
  assert.equal(await personalNotice(page), notice("grant"));
});

test("a tab whose write session the review app no longer accepts drops it and says it ended", { skip, timeout: 60000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await project(context));
  // A token this server never issued stands for one that a review app issued before it restarted.
  const prepare = (browserContext) => browserContext.addInitScript(() => sessionStorage.setItem("prism-write-session", "A".repeat(43)));
  const page = await openPage(await launch(context), `${base}/review`, { prepare });
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await dialog(page).getByRole("treeitem", { name: "Personal" }).click();
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/personal-settings") && response.request().method() === "PUT");
  await personal(page).getByRole("radiogroup", { name: "Open at session start", exact: true }).getByRole("radio", { name: "Off" }).click();
  assert.equal((await refused).status(), 403, "the review app refuses the old write session");
  assert.equal(await settled(() => page.evaluate(() => sessionStorage.getItem("prism-write-session")), null), null, "the tab drops the write session");
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "hidden" });
  assert.equal(await personalNotice(page), notice("ended"));
});
