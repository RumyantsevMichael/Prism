import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// The review page's canvases, scrolling, and refreshes: Attention's list and detail scroll apart, graphs and diagrams draw on a dotted grid that follows their zoom,
// a long menu keeps its scroll position, a text area grows with its text, a contents link scrolls smoothly, and a refresh never shows a half-built view.

async function stressPage(context, ref, options = {}) {
  await useAppDirectory(context);
  const root = await demoProject(context, "seed-stress.mjs");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, ref), options);
  return { root, base, page };
}

const graphView = async (page) => {
  await page.locator("#artifact").getByText("Graph", { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#artifact prism-canvas.graph-viewport svg"), null, { timeout: 15000 });
  await page.waitForTimeout(300);
};

test("Attention's list and detail scroll apart, so the picked item stays in view at the bottom of a long list", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "attention", { viewport: { width: 1440, height: 800 } });
  const shown = await page.evaluate(() => {
    const workspace = document.getElementById("workspace");
    const list = document.querySelector(".attention-list");
    list.scrollTop = list.scrollHeight;
    workspace.scrollTop = workspace.scrollHeight;
    const frame = workspace.getBoundingClientRect();
    const sheet = document.querySelector(".attention-sheet:not([hidden])").getBoundingClientRect();
    return { listScrolls: list.scrollHeight > list.clientHeight + 1, pageScrolls: workspace.scrollHeight > workspace.clientHeight + 1, listAtBottom: list.scrollTop > 0, sheetTop: sheet.top, frameTop: frame.top, frameBottom: frame.bottom };
  });
  assert.equal(shown.listScrolls, true, "the long list scrolls inside itself");
  assert.equal(shown.listAtBottom, true);
  assert.equal(shown.pageScrolls, false, "the page itself does not scroll the list and the detail together");
  assert.ok(shown.sheetTop >= shown.frameTop && shown.sheetTop < shown.frameBottom, "the picked item's detail stays in view");
  assert.deepEqual(page.errors, []);
});

test("a graph draws on a dotted grid that follows its zoom and pan, and its text cannot be selected", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "initiative:huge-initiative");
  await graphView(page);
  const canvas = page.locator("#artifact prism-canvas.graph-viewport");
  const read = () => canvas.evaluate((element) => {
    const style = getComputedStyle(element);
    return { scale: Number(element.getAttribute("scale")), step: Number(element.style.getPropertyValue("--prism-canvas-step")), image: style.backgroundImage, attachment: style.backgroundAttachment, select: style.userSelect, pannable: element.hasAttribute("pannable") };
  });
  const before = await read();
  assert.match(before.image, /radial-gradient/, "the canvas draws a dotted grid");
  assert.equal(before.attachment, "local", "the grid scrolls with the drawing");
  assert.equal(before.select, "none", "a graph's text cannot be selected");
  assert.equal(before.pannable, true);
  const zoom = page.locator("#artifact .graph-view [data-zoom='in']");
  await zoom.click();
  await zoom.click();
  const after = await read();
  assert.ok(after.scale > before.scale, "zooming in changes the canvas's scale");
  assert.ok(after.step >= 0.75 && after.step < 1.5, "the grid's spacing stays readable");
  assert.notEqual(after.step, before.step, "and follows the zoom");
  assert.deepEqual(page.errors, []);
});

test("a PlantUML diagram draws on the same dotted grid, which follows its zoom", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "docs/plans/huge-initiative/slice-with-long-name/diagram.puml");
  await page.waitForFunction(() => document.querySelector("#artifact prism-canvas.diagram-output svg"), null, { timeout: 15000 });
  const canvas = page.locator("#artifact prism-canvas.diagram-output");
  assert.match(await canvas.evaluate((element) => getComputedStyle(element).backgroundImage), /radial-gradient/);
  await page.locator("#artifact .diagram-view [data-action='zoom-in']").click();
  assert.ok(Number(await canvas.getAttribute("scale")) > 1, "zooming the diagram scales its grid");
  assert.deepEqual(page.errors, []);
});

test("a menu taller than the window keeps its scroll position when the page places it again", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "attention", { viewport: { width: 1280, height: 560 } });
  await page.evaluate(() => {
    const menu = document.getElementById("project-menu");
    const group = document.createElement("prism-menu-group");
    group.setAttribute("label", "Many checkouts");
    for (let index = 0; index < 80; index += 1) {
      const item = document.createElement("prism-menu-item");
      item.setAttribute("value", `checkout-${index}`);
      item.textContent = `Checkout ${index}`;
      group.append(item);
    }
    menu.append(group);
  });
  await page.locator("#project-button").click();
  await page.waitForTimeout(300);
  const kept = await page.evaluate(async () => {
    const menu = document.getElementById("project-menu");
    menu.scrollTop = 400;
    const scrolled = menu.scrollTop;
    menu.dispatchEvent(new Event("scroll"));
    menu.place();
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const box = menu.getBoundingClientRect();
    return { scrolled, now: menu.scrollTop, scrolls: menu.scrollHeight > menu.clientHeight, bottom: box.bottom, height: innerHeight };
  });
  assert.equal(kept.scrolls, true, "the long menu scrolls inside itself");
  assert.ok(kept.scrolled > 0);
  assert.equal(kept.now, kept.scrolled, "placing the menu again keeps where it was scrolled to");
  assert.ok(kept.bottom <= kept.height, "the menu stays inside the window");
  assert.deepEqual(page.errors, []);
});

test("a gate's note grows with its text up to a limit", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "attention", { viewport: { width: 1440, height: 900 } });
  const note = page.locator(".attention-sheet:not([hidden]) .gate-note textarea");
  const empty = await note.evaluate((element) => element.getBoundingClientRect().height);
  await note.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of a longer note.`).join("\n"));
  await page.waitForTimeout(100);
  const grown = await note.evaluate((element) => ({ height: element.getBoundingClientRect().height, hidden: element.scrollHeight - element.clientHeight }));
  assert.ok(grown.height > empty, "the note grows with its text");
  assert.ok(grown.hidden <= 1, "and shows all of it");
  await note.fill(Array.from({ length: 80 }, (_, index) => `Line ${index + 1}.`).join("\n"));
  await page.waitForTimeout(100);
  const capped = await note.evaluate((element) => ({ height: element.getBoundingClientRect().height, scrolls: element.scrollHeight > element.clientHeight }));
  assert.ok(capped.height < 800 && capped.scrolls, "past its limit the note scrolls");
  assert.deepEqual(page.errors, []);
});

test("a refresh of a graph page replaces the view whole, never showing it shorter while it is built", { skip, timeout: 90000 }, async (context) => {
  const { root, page } = await stressPage(context, "initiative:huge-initiative");
  await graphView(page);
  await page.evaluate(() => {
    const artifact = document.getElementById("artifact");
    window.heights = [];
    window.sampling = true;
    const sample = () => {
      window.heights.push(artifact.scrollHeight);
      if (window.sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const file = path.join(root, ".prism/initiatives/huge-initiative/initiative.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  const [slug] = Object.keys(record.slices);
  record.slices[slug].title = `${record.slices[slug].title} renamed`;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  await page.waitForFunction((title) => document.querySelector("#artifact")?.textContent.includes(title), `${record.slices[slug].title}`, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const heights = await page.evaluate(() => {
    window.sampling = false;
    return window.heights;
  });
  const tallest = Math.max(...heights);
  assert.ok(heights.length > 10);
  assert.ok(Math.min(...heights) >= tallest * 0.95, `the page never shrank while it refreshed: ${[...new Set(heights)].join(", ")}`);
  assert.equal(await page.locator(".artifact-stage").count(), 0, "no view is left half built");
  assert.deepEqual(page.errors, []);
});

test("choosing a section in a document's contents scrolls there smoothly", { skip, timeout: 90000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const lines = ["# A long document", ""];
  for (let index = 1; index <= 30; index += 1) lines.push(`## Section ${index}`, "", "A paragraph of the section.", "", "Another paragraph of the section.", "");
  await writeFile(path.join(root, "docs/long.md"), lines.join("\n"));
  execFileSync("git", ["add", "docs/long.md"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Prism Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Add a long document"], { cwd: root });
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "docs/long.md"), { viewport: { width: 1440, height: 700 } });
  await settle(page);
  const travel = await page.evaluate(async () => {
    const workspace = document.getElementById("workspace");
    const link = [...document.querySelectorAll("prism-contents a[data-doc-anchor]")].find((anchor) => anchor.textContent === "Section 25");
    const positions = [];
    link.click();
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      positions.push(workspace.scrollTop);
    }
    return positions;
  });
  const end = travel.at(-1);
  assert.ok(end > 0, "the page scrolled to the section");
  assert.ok(travel.some((position) => position > 0 && position < end), "it passed positions on the way rather than jumping");
  assert.deepEqual(page.errors, []);
});
