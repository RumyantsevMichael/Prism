import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

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
  await repainted(page);
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

test("a zoomed-in PlantUML diagram pans by dragging it with a mouse, and only shows a grab cursor while there is something to pan", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "docs/plans/huge-initiative/slice-with-long-name/diagram.puml", { viewport: { width: 1280, height: 800 } });
  await page.waitForFunction(() => document.querySelector("#artifact prism-canvas.diagram-output svg"), null, { timeout: 15000 });
  const canvas = page.locator("#artifact prism-canvas.diagram-output");
  const zoom = (action) => page.locator(`#artifact .diagram-view [data-action='${action}']`).click();
  const read = () => canvas.evaluate((element) => ({ left: element.scrollLeft, page: document.getElementById("workspace").scrollTop, cursor: getComputedStyle(element).cursor, select: getComputedStyle(element).userSelect, touch: getComputedStyle(element).touchAction, overflowing: element.hasAttribute("overflowing"), panning: element.hasAttribute("panning") }));
  assert.equal(await canvas.getAttribute("pannable"), "", "a diagram's canvas pans by dragging");
  for (let step = 0; step < 8; step += 1) await zoom("zoom-out");
  const small = await settled(read, (value) => !value.overflowing);
  assert.equal(small.overflowing, false, "the smallest zoom of the diagram fits its canvas");
  assert.notEqual(small.cursor, "grab", "a diagram that fits shows no grab cursor");
  for (let step = 0; step < 16; step += 1) await zoom("zoom-in");
  const before = await settled(read, (value) => value.overflowing);
  assert.equal(before.overflowing, true, "the zoomed-in diagram is wider than its canvas");
  assert.equal(before.cursor, "grab");
  assert.equal(before.select, "none", "a drag selects no text");
  assert.notEqual(before.touch, "none", "a finger pans by the browser's own scrolling");
  const box = await canvas.boundingBox();
  // The canvas grows taller than the window with its diagram, so the drag starts in its padding near the top, which is in view and holds no link.
  const [x, y] = [box.x + box.width / 2, box.y + 12];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y - 60, { steps: 6 });
  const during = await read();
  assert.equal(during.panning, true, "the canvas shows it is being dragged");
  assert.equal(during.cursor, "grabbing");
  await page.mouse.up();
  const after = await read();
  assert.equal(after.panning, false);
  assert.ok(after.left > before.left, "dragging left moves the diagram left");
  assert.ok(after.page > before.page, "dragging up scrolls the page that holds the tall diagram");
  assert.equal(await page.evaluate(() => String(getSelection())), "", "dragging the diagram selects no text");
  assert.deepEqual(page.errors, []);
});

test("a press on a link or control in a pannable canvas keeps its meaning and starts no pan", { skip, timeout: 90000 }, async (context) => {
  const { page } = await stressPage(context, "docs/plans/huge-initiative/slice-with-long-name/diagram.puml", { viewport: { width: 1280, height: 800 } });
  await page.waitForFunction(() => document.querySelector("#artifact prism-canvas.diagram-output svg"), null, { timeout: 15000 });
  const moved = await page.evaluate(async () => {
    const canvas = document.createElement("prism-canvas");
    canvas.setAttribute("pannable", "");
    canvas.style.cssText = "width:200px;height:120px";
    canvas.innerHTML = `<svg width="800" height="600" viewBox="0 0 800 600"><a href="#here"><rect id="target" x="0" y="0" width="160" height="100"/></a></svg>`;
    document.body.append(canvas);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = canvas.querySelector("#target").getBoundingClientRect();
    const fire = (type, x, y) => canvas.querySelector("#target").dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
    fire("pointerdown", rect.left + 50, rect.top + 50);
    fire("pointermove", rect.left + 10, rect.top + 10);
    fire("pointerup", rect.left + 10, rect.top + 10);
    const result = { left: canvas.scrollLeft, panning: canvas.hasAttribute("panning"), overflowing: canvas.hasAttribute("overflowing") };
    canvas.remove();
    return result;
  });
  assert.equal(moved.overflowing, true);
  assert.equal(moved.left, 0, "a press on a link does not pan");
  assert.equal(moved.panning, false);
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
  await repainted(page);
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
  await repainted(page);
  const grown = await note.evaluate((element) => ({ height: element.getBoundingClientRect().height, hidden: element.scrollHeight - element.clientHeight }));
  assert.ok(grown.height > empty, "the note grows with its text");
  assert.ok(grown.hidden <= 1, "and shows all of it");
  await note.fill(Array.from({ length: 80 }, (_, index) => `Line ${index + 1}.`).join("\n"));
  await repainted(page);
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
  await settled(() => page.locator(".artifact-stage").count(), 0);
  await repainted(page);
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

for (const [reducedMotion, behavior] of [["no-preference", "smooth"], ["reduce", "instant"]]) {
  test(`choosing a section in a document's contents scrolls there ${behavior === "smooth" ? "smoothly" : "at once under reduced motion"}`, { skip, timeout: 90000 }, async (context) => {
    await useAppDirectory(context);
    const root = await demoProject(context);
    const lines = ["# A long document", ""];
    for (let index = 1; index <= 30; index += 1) lines.push(`## Section ${index}`, "", "A paragraph of the section.", "", "Another paragraph of the section.", "");
    await writeFile(path.join(root, "docs/long.md"), lines.join("\n"));
    execFileSync("git", ["add", "docs/long.md"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Prism Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Add a long document"], { cwd: root });
    const { base } = await serveProject(context, root);
    const browser = await launch(context);
    const page = await openPage(browser, reviewUrl(base, "docs/long.md"), { viewport: { width: 1440, height: 700 }, reducedMotion });
    await settle(page);
    // Whether the browser animates a smooth scroll depends on its platform's settings, so the test reads the scroll the page asks for, and where it ends.
    const result = await page.evaluate(async () => {
      const workspace = document.getElementById("workspace");
      const asked = [];
      const scrollTo = workspace.scrollTo.bind(workspace);
      workspace.scrollTo = (options) => {
        asked.push(options?.behavior ?? null);
        scrollTo(options);
      };
      const link = [...document.querySelectorAll("prism-contents a[data-doc-anchor]")].find((anchor) => anchor.textContent === "Section 25");
      link.click();
      for (let frame = 0; frame < 120; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
      const heading = [...document.querySelectorAll("#artifact h2")].find((element) => element.textContent.trim() === "Section 25");
      return { asked, end: workspace.scrollTop, headingTop: heading.getBoundingClientRect().top - workspace.getBoundingClientRect().top };
    });
    assert.deepEqual(result.asked, [behavior], `the page asks for a ${behavior} scroll`);
    assert.ok(result.end > 0, "the page scrolled to the section");
    assert.ok(Math.abs(result.headingTop) < 40, `the section ends at the top of the page: ${result.headingTop}`);
    assert.deepEqual(page.errors, []);
  });
}
