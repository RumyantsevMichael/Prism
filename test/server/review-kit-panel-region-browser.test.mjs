import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted } from "./fixtures/wait.mjs";

// A panel with the region option is a landmark named by its heading, so a page of several panels, such as a slice's Views tab, lists each by its heading.

async function catalog(context) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-panel-region-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  await page.waitForFunction(() => customElements.get("prism-panel") !== undefined, null, { timeout: 5000 });
  return page;
}

async function mount(page, html) {
  await page.evaluate((html) => {
    document.querySelector("#fixture")?.remove();
    const region = document.createElement("div");
    region.id = "fixture";
    region.innerHTML = html;
    document.body.prepend(region);
  }, html);
  await repainted(page);
}

test("a region panel is a landmark named by its heading, and only while it has the option and a heading", { skip, timeout: 60000 }, async (context) => {
  const page = await catalog(context);
  await mount(page, `<prism-panel id="view" heading="What does the screen show?" eyebrow="Wireframe view" level="3" region><p>Body</p></prism-panel><prism-panel id="untitled" region><p>No heading</p></prism-panel><prism-panel id="plain" heading="Plain"><p>Body</p></prism-panel>`);
  const fixture = page.locator("#fixture");
  assert.equal(await fixture.getByRole("region", { name: "What does the screen show?" }).count(), 1);
  assert.equal(await fixture.getByRole("region").count(), 1, "a panel without the option, or without a heading, is no landmark");
  await page.evaluate(() => document.getElementById("view").setAttribute("level", "2"));
  assert.equal(await fixture.getByRole("region", { name: "What does the screen show?" }).count(), 1, "a new heading level keeps the name");
  await page.evaluate(() => document.getElementById("view").setAttribute("heading", "Which operations does the API offer?"));
  assert.equal(await fixture.getByRole("region", { name: "Which operations does the API offer?" }).count(), 1, "the name follows the heading");
  await page.evaluate(() => document.getElementById("view").removeAttribute("region"));
  assert.equal(await fixture.getByRole("region").count(), 0);
  assert.equal(await page.locator("prism-panel[region]").count() > 0, true, "the catalog shows a region specimen");
});
