import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, ROOT, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Times in words keep themselves current, a clearable choice can go back to no option, and About names the running version.

async function project(context) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-live-time-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  return serveProject(context, root);
}

async function catalog(context) {
  const { base } = await project(context);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  await page.waitForFunction(() => customElements.get("prism-time") !== undefined && customElements.get("prism-choice") !== undefined, null, { timeout: 5000 });
  return page;
}

async function mount(page, html) {
  await page.evaluate((html) => {
    document.querySelector("#fixture")?.remove();
    const region = document.createElement("div");
    region.id = "fixture";
    region.innerHTML = html;
    document.body.prepend(region);
    window.scrollTo(0, 0);
  }, html);
  await page.waitForTimeout(150);
}

test("a prism-time shows its time in words, gives the exact time as its tip, and updates every minute without a reload", { skip }, async (context) => {
  const page = await catalog(context);
  await page.clock.install({ time: new Date() });
  const now = await page.evaluate(() => Date.now());
  const at = (minutes) => new Date(now + minutes * 60000).toISOString();
  await mount(page, `<prism-time id="ago" datetime="${at(-0.5)}"></prism-time> <prism-time id="short" format="short" datetime="${at(-3)}"></prism-time> <prism-time id="left" format="left" datetime="${at(2.5)}"></prism-time> <prism-time id="none" datetime="not a time"></prism-time>`);
  const read = () => page.evaluate(() => Object.fromEntries(["ago", "short", "left", "none"].map((id) => [id, document.getElementById(id).textContent])));
  assert.deepEqual(await read(), { ago: "just now", short: "3 min", left: "3 min left", none: "" });
  assert.match(await page.locator("#ago").getAttribute("tip"), /\d/, "the tip gives the exact time");
  assert.equal(await page.locator("#none").getAttribute("tip"), null, "a time that cannot be read has no tip");
  await page.clock.runFor(60000 * 3 + 500);
  assert.deepEqual(await read(), { ago: "3 min ago", short: "6 min", left: "Expired 0 min ago", none: "" });
  assert.equal(await page.locator("#left").getAttribute("expired"), "", "a lapsed time in the left format is marked expired");
});

test("a clearable choice goes back to no option when its chosen option is clicked or takes Space again, and sends change", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, `<prism-choice id="clearable" label="Your answer" clearable><prism-choice-option value="a">Accept</prism-choice-option><prism-choice-option value="b">Decline</prism-choice-option></prism-choice>
    <prism-choice id="plain" label="Plain"><prism-choice-option value="a">Accept</prism-choice-option><prism-choice-option value="b">Decline</prism-choice-option></prism-choice>`);
  await page.evaluate(() => {
    window.changes = 0;
    document.getElementById("clearable").addEventListener("change", () => { window.changes += 1; });
  });
  const value = (id) => page.locator(`#${id}`).evaluate((choice) => choice.value);
  const option = (id, index) => page.locator(`#${id} prism-choice-option`).nth(index);
  await option("clearable", 0).click();
  assert.equal(await value("clearable"), "a");
  await option("clearable", 0).click();
  assert.equal(await value("clearable"), "", "clicking the chosen option again leaves nothing chosen");
  await option("clearable", 1).locator("input").focus();
  await page.keyboard.press("Space");
  assert.equal(await value("clearable"), "b");
  await page.keyboard.press("Space");
  assert.equal(await value("clearable"), "", "Space on the chosen option leaves nothing chosen");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  assert.equal(await value("clearable"), "a", "the arrow keys still move the choice");
  assert.equal(await page.evaluate(() => window.changes), 6, "every change of the value sends change");
  await option("plain", 0).click();
  await option("plain", 0).click();
  assert.equal(await value("plain"), "a", "a choice that is not clearable keeps its option");
});

test("About Prism opens from the status bar and names the running plugin version", { skip }, async (context) => {
  const { base } = await project(context);
  const { version } = JSON.parse(await readFile(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const index = await (await fetch(`${base}/api/index`)).json();
  assert.equal(index.version, version, "the page's index carries the plugin version");
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/review`);
  await page.getByRole("button", { name: "About Prism" }).click();
  const dialog = page.getByRole("dialog", { name: "About Prism" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), new RegExp(`Version ${version.replace(/\./g, "\\.")}`));
  assert.equal(await dialog.getByRole("button", { name: /component catalog/i }).isVisible(), true, "About links to the component catalog");
  assert.deepEqual(page.errors, []);
});
