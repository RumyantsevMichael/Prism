import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { prepareTouched } from "./fixtures/places-touched.mjs";
import { choosePlace, comparePlaces, item, itemNames, open, placesDemo, settledOn, sidebar, SLICE } from "./fixtures/places-browser.mjs";

// Knowledge's two entry points on the real review page: Touched by my work after a slice page and without one, and Changed this week with and without history.

async function touched(page) {
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Touched by my work").click();
  await settledOn(page, "knowledge:touched");
  return page.locator("#artifact");
}

test("clauses 54, 55, 58: Touched by my work names the slice last opened and lists what its contract cites and what the work changes, with kind, status, and why", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: prepareTouched });
  const page = await open(browser, base, SLICE);
  const view = await touched(page);
  assert.equal(await view.getByText("Records behind the slice you have open: Harden request retries, slice Retry timed-out requests until a total deadline", { exact: true }).isVisible(), true);
  assert.equal(await view.getByRole("heading", { name: /^The contract cites\b/ }).isVisible(), true);
  assert.equal(await view.getByRole("heading", { name: /^This work changes\b/ }).isVisible(), true);
  const text = (await view.innerText()).replace(/\s+/g, " ");
  assert.match(text, /The contract cites 5\b/, "the group shows its count");
  assert.match(text, /Retry requirements Requirement Approved Section 1/);
  assert.match(text, /Retry deadline Glossary term Defined Clause 1/);
  assert.match(text, /timeout-retries Diagram Linked from the design/);
  assert.match(text, /Glossary Glossary Planned by the design/);
  await view.getByRole("link", { name: "Bound retries by a total deadline" }).first().click();
  await settledOn(page, "docs/ADRs/retries/total-retry-deadline.md");
  assert.deepEqual(page.errors, []);
});

test("clause 59: without a slice opened, Touched by my work says how to fill it and links each slice in progress", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  const view = await touched(page);
  assert.equal(await view.getByText("This page lists the records behind the slice you have open. Open a slice to see them.", { exact: true }).isVisible(), true);
  await view.getByRole("link", { name: "Emit retry metrics", exact: true }).click();
  await settledOn(page, "slice:retry-hardening/retry-metrics");
  const again = await touched(page);
  assert.equal(await again.getByText("Records behind the slice you have open: Harden request retries, slice Emit retry metrics", { exact: true }).isVisible(), true, "the slice just selected fills the page");
  assert.deepEqual(page.errors, []);
});

test("clause 63: Changed this week on a repository without a commit says why it cannot list changes, and the sidebar shows no count", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Knowledge");
  assert.ok((await itemNames(sidebar(page))).includes("Changed this week"), "the entry carries no count");
  await item(sidebar(page), "Changed this week").click();
  await settledOn(page, "knowledge:changed");
  assert.equal(await page.locator("#artifact").getByText("Change history is unavailable: the repository has no commits.", { exact: true }).isVisible(), true);
  assert.deepEqual(page.errors, []);
});

test("clause 61: Changed this week lists an uncommitted change first, labeled Not committed, then this week's commits with their authors", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: async (root) => {
    const run = (args, env = {}) => execFileSync("git", ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore", env: { ...process.env, ...env } });
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "Start"]);
    await writeFile(path.join(root, "docs/Glossary.md"), "# Glossary\n\n| Term | Definition |\n| --- | --- |\n| Retry deadline | Changed. |\n");
  } });
  const page = await open(browser, base, "knowledge:changed");
  const text = (await page.locator("#artifact").innerText()).replace(/\s+/g, " ");
  assert.ok(text.indexOf("Not committed") >= 0 && text.indexOf("Glossary") >= 0, "the uncommitted glossary is labeled");
  assert.ok(text.indexOf("Glossary") < text.indexOf("Retry requirements"), "uncommitted changes come first");
  assert.match(text, /Ada Lovelace/, "a commit's author is named");
  assert.deepEqual(page.errors, []);
});

test("clauses 55, 73: the Knowledge sidebar and the Touched page's trail match the mockup at three widths in both themes", { skip, timeout: 900000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "knowledge", parts: "sidebar,head,trail,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
