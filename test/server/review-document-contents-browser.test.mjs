import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// A long document's contents fit the visible part of the page beside the text, their rule meets the sheet's edges, and their header has no fold arrow there.
// The Maximize control is the kit's icon button, and a maximized document keeps its Restore control in view while it scrolls.

const LONG_TITLE = "A section heading long enough to wrap over several lines in the contents beside the text";

function longDocument() {
  const lines = ["# A long document", ""];
  for (let index = 1; index <= 40; index += 1) {
    lines.push(`## ${index % 6 === 0 ? LONG_TITLE : `Section ${index}`}`, "", "The first sentence of a paragraph.", "The second sentence of the same paragraph.", "");
  }
  return lines.join("\n");
}

function plainDocument() {
  const lines = ["# A document without contents", ""];
  for (let index = 1; index <= 80; index += 1) lines.push(`Paragraph ${index}, first line.`, `Paragraph ${index}, second line.`, "");
  return lines.join("\n");
}

async function documentProject(context) {
  const root = await demoProject(context);
  await writeFile(path.join(root, "docs/long.md"), longDocument());
  await writeFile(path.join(root, "docs/plain.md"), plainDocument());
  execFileSync("git", ["add", "docs/long.md", "docs/plain.md"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Prism Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Add long documents"], { cwd: root });
  return root;
}

// The scrolling area, the sheet, the contents column and list, and the Maximize control, in window coordinates.
function measure(page) {
  return page.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    };
    const sheet = document.querySelector("#workspace .document-sheet");
    const scroller = sheet.closest(".is-maximized") ?? document.getElementById("workspace");
    const area = box(scroller);
    const list = sheet.querySelector(".doc-toc-body > ol");
    const control = sheet.querySelector("[data-maximize]");
    return {
      area: { top: area.top + scroller.clientTop, bottom: area.top + scroller.clientTop + scroller.clientHeight },
      sheet: box(sheet),
      toc: box(sheet.querySelector(".doc-toc")),
      body: box(sheet.querySelector(".doc-toc-body")),
      list: list && { box: box(list), scrollable: list.scrollHeight > list.clientHeight + 1 },
      control: box(control),
      label: control?.getAttribute("label"),
      icon: control?.querySelector("prism-icon")?.getAttribute("name"),
      text: control?.textContent.trim(),
      current: sheet.querySelector(".doc-toc a[aria-current]")?.textContent,
      currentBox: box(sheet.querySelector(".doc-toc a[aria-current]"))
    };
  });
}

async function scrollTo(page, fraction) {
  await page.evaluate((share) => {
    const sheet = document.querySelector("#workspace .document-sheet");
    const scroller = sheet.closest(".is-maximized") ?? document.getElementById("workspace");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * share;
  }, fraction);
  await page.waitForTimeout(300);
}

for (const height of [600, 900]) {
  test(`beside the text the contents fit the visible page, meet the sheet's edges, and follow the current section at ${height}px high`, { skip }, async (context) => {
    await useAppDirectory(context);
    const root = await documentProject(context);
    const { base } = await serveProject(context, root);
    const browser = await launch(context);
    const page = await openPage(browser, reviewUrl(base, "docs/long.md"), { viewport: { width: 1440, height } });
    await waitForView(page);
    assert.equal(await page.locator("#workspace .doc-toc-toggle").isVisible(), false, "beside the text the contents header has no fold toggle");
    assert.equal(await page.locator("#workspace .doc-toc-title").isVisible(), true, "beside the text the contents header is a title");
    for (const fraction of [0, 0.5, 1]) {
      await scrollTo(page, fraction);
      const shown = await measure(page);
      assert.ok(Math.abs(shown.toc.top - shown.sheet.top) <= 2 && Math.abs(shown.toc.bottom - shown.sheet.bottom) <= 2, `the contents rule runs from the sheet's top to its bottom at ${fraction}: ${JSON.stringify([shown.toc, shown.sheet])}`);
      assert.ok(shown.body.top >= shown.area.top - 1 && shown.body.bottom <= shown.area.bottom + 1, `the contents stay inside the visible page at ${fraction}: ${JSON.stringify([shown.body, shown.area])}`);
      assert.ok(shown.list.scrollable, "the contents list is longer than the window, so it scrolls on its own");
      assert.ok(shown.currentBox.top >= shown.list.box.top - 1 && shown.currentBox.bottom <= shown.list.box.bottom + 1, `the current entry ${shown.current} is in view at ${fraction}`);
      assert.ok(shown.control.top >= shown.area.top && shown.control.bottom <= shown.area.bottom, `the Maximize control is in view at ${fraction}`);
    }
    assert.match((await measure(page)).current, /^Section 40$/, "at the end the last section is current");
    assert.deepEqual(page.errors, []);
  });
}

test("the Maximize control is the kit's icon button, and a maximized document keeps Restore in view while it scrolls", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await documentProject(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  for (const [doc, width] of [["docs/long.md", 1440], ["docs/long.md", 900], ["docs/plain.md", 1440], ["docs/plain.md", 390]]) {
    const page = await openPage(browser, reviewUrl(base, doc), { viewport: { width, height: 800 } });
    await waitForView(page);
    const before = await measure(page);
    assert.equal(before.label, "Maximize");
    assert.equal(before.icon, "maximize");
    assert.equal(before.text, "", `the control is an icon without text on ${doc} at ${width}px`);
    assert.ok(before.control.width <= before.control.height * 2, `the control is a small icon button, not a bar across the sheet, on ${doc} at ${width}px: ${JSON.stringify(before.control)}`);
    await page.locator("#workspace [data-maximize]").click();
    await page.locator("#workspace .is-maximized").waitFor();
    for (const fraction of [0.5, 1]) {
      await scrollTo(page, fraction);
      const shown = await measure(page);
      assert.equal(shown.label, "Restore");
      assert.equal(shown.icon, "restore");
      assert.ok(shown.control.top >= shown.area.top - 1 && shown.control.bottom <= shown.area.bottom + 1, `Restore stays in view at ${fraction} on ${doc} at ${width}px: ${JSON.stringify([shown.control, shown.area])}`);
    }
    await page.locator("#workspace [data-maximize]").click();
    await page.locator("#workspace .is-maximized").waitFor({ state: "detached" });
    assert.deepEqual(page.errors, []);
    await page.close();
  }
});

test("in a narrow window the contents sit above the text and fold open from their header", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await documentProject(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "docs/long.md"), { viewport: { width: 900, height: 800 } });
  await waitForView(page);
  const toggle = page.locator("#workspace .doc-toc-toggle");
  assert.equal(await toggle.isVisible(), true);
  assert.equal(await page.locator("#workspace .doc-toc ol").isVisible(), false, "the contents start folded");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#workspace .doc-toc ol").isVisible(), true, "the header opens the contents");
  assert.deepEqual(page.errors, []);
});
