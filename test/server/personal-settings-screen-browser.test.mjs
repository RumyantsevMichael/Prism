import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/personal-settings.md §3.
// Contract: docs/plans/personal-settings/slice.md clauses 18 to 24; each test names the clauses it checks at the start of its title.
// The approved mockup is scripts/review-demo/mockups/personal-settings/mockup.html.
// Settings gains a Personal section where the person changes their own settings, which stay on this machine.

const FILE = "personal-settings.json";
// A tab opened without a grant names the review link as the reason it can only read.
const READ_ONLY = "This tab can only read. It was opened from a review link, and only a tab that Prism opens itself can make changes. To make changes, run prism review in this project, or ask the agent to present the review.";
const NOTE = "These settings stay on this machine and apply to every project and every host you run Prism in. A change here reaches no one else.";
const SAVED = "Saved on this machine. This change reaches no one else.";
const GROUPS = [
  ["Questions", [["Question tool", "structured"], ["Numbered options", "plain-text"]]],
  ["Review browser", [["Auto", "auto"], ["Internal", "internal"], ["External", "external"]]],
  ["Open at session start", [["On", "on"], ["Off", "off"]]],
  ["Offer Prism", [["Ask", "ask"], ["Off", "off"]]]
];

async function project(context, lines = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-personal-browser-")));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  const interaction = lines.length ? `\n## Interaction\n${lines.map((line) => `- ${line}`).join("\n")}\n` : "";
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans/\n${interaction}`);
  return root;
}

// A review whose page Prism opened, so the page's address carries the one-time grant that gives the tab its write session.
async function serveWritable(context, root) {
  // The conservation store reads its location when its module loads, so private data is set before the review server's import, as the kit fixture does.
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-personal-browser-data-")));
  delete process.env.CLAUDE_PLUGIN_DATA;
  const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
  const opened = [];
  const review = await startReviewServer({ projectRoot: root, openBrowser: async (url) => { opened.push(url); return true; } });
  context.after(() => review.close());
  await review.open([]);
  const grant = new URLSearchParams(new URL(opened.at(-1)).hash.slice(1)).get("write");
  return { base: review.baseUrl.replace(/\/$/, ""), grant };
}

// A tab opened from the review URL alone, as from a link an agent printed, holds no write session; `writable` gives the tab the grant Prism's own opening gives.
async function fixture(context, { lines = [], file = null, width = 1440, colorScheme = "light", writable = true } = {}) {
  const directory = await useAppDirectory(context);
  if (file !== null) await writeFile(path.join(directory, FILE), file);
  const root = await project(context, lines);
  const browser = await launch(context);
  let base;
  let url;
  if (writable) {
    const served = await serveWritable(context, root);
    base = served.base;
    url = `${reviewUrl(base, "attention")}#write=${served.grant}`;
  } else {
    base = (await serveProject(context, root)).base;
    url = reviewUrl(base, "attention");
  }
  if (!writable) return { directory, root, base, page: await openPage(browser, url, { viewport: { width, height: 900 }, colorScheme }) };
  // The page exchanges the grant once it loads, so the test waits for that exchange before it changes anything.
  const page = await openPage(browser, "about:blank", { viewport: { width, height: 900 }, colorScheme });
  const exchanged = page.waitForResponse((response) => response.url().endsWith("/api/write-session"));
  await page.goto(url);
  assert.equal((await exchanged).status(), 200, "the page takes its write session");
  await settle(page);
  return { directory, root, base, page };
}

const dialog = (page) => page.getByRole("dialog", { name: "Settings" });
const personal = (page) => dialog(page).getByRole("region", { name: "Personal settings" });
const group = (page, name) => personal(page).getByRole("radiogroup", { name, exact: true });
const checked = (page, name) => group(page, name).getByRole("radio", { checked: true }).innerText().then((text) => text.trim());
const stored = async (directory) => JSON.parse(await readFile(path.join(directory, FILE), "utf8"));
const toastText = (page) => page.locator("prism-toast[shown]").innerText().then((text) => text.trim(), () => "");

async function openPersonal(page) {
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await dialog(page).waitFor();
  await dialog(page).getByRole("treeitem", { name: "Personal" }).click();
  await personal(page).waitFor();
}

test("clauses 19, 20: Settings lists Personal after Layout, and its section says the settings stay on this machine and shows each setting at its value with its source", { skip, timeout: 60000 }, async (context) => {
  const { page } = await fixture(context, { lines: ["Review browser: external"] });
  await openPersonal(page);
  const sections = (await dialog(page).getByRole("treeitem").allInnerTexts()).map((name) => name.trim());
  // Other sections may join the list; Personal follows Layout and comes before the record store.
  assert.deepEqual(sections.filter((name) => ["Appearance", "Layout", "Personal", "Record store", "About Prism"].includes(name)), ["Appearance", "Layout", "Personal", "Record store", "About Prism"]);
  assert.equal(await personal(page).getByRole("heading", { level: 3 }).innerText(), "Personal settings");
  assert.match((await personal(page).getByRole("status").first().innerText()).replace(/\s+/g, " "), new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const [name, options] of GROUPS) {
    const radios = (await group(page, name).getByRole("radio").allInnerTexts()).map((text) => text.trim());
    assert.deepEqual(radios, options.map(([label]) => label), `${name} offers its values in order`);
  }
  assert.equal(await checked(page, "Questions"), "Question tool");
  assert.equal(await checked(page, "Review browser"), "External", "the adopted value is shown");
  assert.equal(await checked(page, "Open at session start"), "On");
  assert.equal(await checked(page, "Offer Prism"), "Ask");
  const text = (await personal(page).innerText()).replace(/\s+/g, " ");
  assert.match(text, /Adopted from a repository's configuration/, "the adopted row names its source");
  assert.equal((text.match(/\bDefault\b/g) ?? []).length, 3, "the three other rows say Default");
  assert.deepEqual(page.errors, []);
});

test("clause 21: choosing a value saves it on this machine, says the change reaches no one else, and marks the row as the person's choice", { skip, timeout: 60000 }, async (context) => {
  const { page, directory } = await fixture(context);
  await openPersonal(page);
  await group(page, "Questions").getByRole("radio", { name: "Numbered options" }).click();
  assert.equal(await settled(async () => (await stored(directory).catch(() => null))?.settings?.interactionStyle?.value, "plain-text"), "plain-text");
  assert.equal((await stored(directory)).settings.interactionStyle.source, "chosen");
  assert.equal(await settled(() => toastText(page), SAVED), SAVED);
  assert.match((await personal(page).innerText()).replace(/\s+/g, " "), /Your choice/);
  await group(page, "Offer Prism").getByRole("radio", { name: "Off" }).click();
  assert.equal(await settled(async () => (await stored(directory)).settings.sessionOffer?.value, "off"), "off");
  assert.equal((await stored(directory)).settings.interactionStyle.value, "plain-text", "the earlier choice is kept");
  await page.reload();
  await openPersonal(page);
  assert.equal(await checked(page, "Questions"), "Numbered options", "a reload shows the saved value");
  assert.equal(await checked(page, "Offer Prism"), "Off");
  assert.deepEqual(page.errors, []);
});

test("clauses 21, 22: with a file Prism cannot read, the section warns, a change is refused with the reason, and the choice returns to its value", { skip, timeout: 60000 }, async (context) => {
  const { page, directory } = await fixture(context, { file: "{ broken", lines: ["Review browser: internal"] });
  await openPersonal(page);
  const warning = personal(page).getByRole("status").filter({ hasText: "Prism cannot read your personal settings" });
  assert.equal(await warning.count(), 1, "the section warns that it cannot read the settings");
  assert.match((await warning.innerText()).replace(/\s+/g, " "), /saves no change until you fix or remove personal-settings\.json in Prism's application folder/);
  assert.equal(await checked(page, "Review browser"), "Internal", "the repository's value is shown");
  assert.match((await personal(page).innerText()).replace(/\s+/g, " "), /From this repository's configuration/);
  await group(page, "Review browser").getByRole("radio", { name: "Auto" }).click();
  assert.match(await settled(() => toastText(page), (text) => text.startsWith("Prism could not save this change:")), /^Prism could not save this change: /);
  assert.equal(await settled(() => checked(page, "Review browser"), "Internal"), "Internal", "the choice returns to the value Prism uses");
  assert.equal(await readFile(path.join(directory, FILE), "utf8"), "{ broken", "the file is left as it is");
  assert.deepEqual(page.errors, []);
});

test("clause 23: opening Settings again shows a value an agent changed meanwhile", { skip, timeout: 60000 }, async (context) => {
  const { page, directory } = await fixture(context);
  await openPersonal(page);
  assert.equal(await checked(page, "Open at session start"), "On");
  await page.keyboard.press("Control+,");
  await dialog(page).waitFor({ state: "hidden" });
  await writeFile(path.join(directory, FILE), JSON.stringify({ schemaVersion: 1, settings: { reviewBrowserOnStart: { value: "off", source: "chosen", at: new Date().toISOString() } } }));
  await openPersonal(page);
  assert.equal(await settled(() => checked(page, "Open at session start"), "Off"), "Off");
});

test("clauses 18, 19: a tab without a write session shows the Personal choices at their values but disabled, with the read-only notice, and saves nothing", { skip, timeout: 60000 }, async (context) => {
  const { page, directory } = await fixture(context, { lines: ["Review browser: external"], writable: false, width: 390 });
  await openPersonal(page);
  const notice = personal(page).getByRole("note").filter({ hasText: "This tab can only read." });
  assert.equal(await notice.count(), 1, "the section shows the review app's read-only notice");
  assert.equal((await notice.innerText()).replace(/\s+/g, " ").trim(), READ_ONLY);
  for (const [name, options] of GROUPS) {
    const radios = group(page, name).getByRole("radio");
    assert.equal(await radios.count(), options.length, `${name} still lists its values`);
    for (let index = 0; index < options.length; index += 1) assert.equal(await radios.nth(index).isDisabled(), true, `${name} ${options[index][0]} is disabled`);
  }
  assert.equal(await checked(page, "Review browser"), "External", "the value Prism uses is still shown");
  await group(page, "Offer Prism").getByRole("radio", { name: "Off" }).click({ force: true });
  assert.equal(await checked(page, "Offer Prism"), "Ask", "a disabled choice does not change");
  assert.equal((await stored(directory)).settings.sessionOffer, undefined, "nothing is saved");
  assert.deepEqual(await escapes(page, "#settings-dialog"), [], "nothing escapes its container");
  assert.deepEqual(page.errors, []);
});

for (const [width, colorScheme] of [[390, "light"], [820, "dark"], [1440, "dark"]]) {
  test(`clause 24: the Personal section stays inside the dialog at ${width} pixels in the ${colorScheme} theme`, { skip, timeout: 60000 }, async (context) => {
    const { page } = await fixture(context, { width, colorScheme, lines: ["Review browser: external"] });
    await openPersonal(page);
    assert.deepEqual(await escapes(page, "#settings-dialog"), [], "nothing escapes its container");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the page does not scroll sideways");
    assert.deepEqual(page.errors, []);
  });
}
