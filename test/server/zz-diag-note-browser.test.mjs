import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory, writableReviewUrl } from "./fixtures/kit-browser.mjs";
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


// TEMPORARY diagnostic for the Windows-only failure of "a gate's note grows with its text up to a limit"; never merged.
const info = (element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return { h: rect.height, w: rect.width, sh: element.scrollHeight, ch: element.clientHeight, val: element.value.length, ph: element.placeholder.length, inline: element.getAttribute("style"),
    sizing: style.fieldSizing, min: style.minHeight, max: style.maxHeight, lh: style.lineHeight, font: style.fontFamily.slice(0, 20), supports: CSS.supports("field-sizing", "content"),
    gate: element.closest("[data-detail]")?.dataset.detail, matches: document.querySelectorAll('.attention-sheet:not([hidden]) .gate-answer prism-field[data-field="note"] textarea').length,
    stage: Boolean(document.querySelector(".artifact-stage")), active: document.activeElement === element, fonts: document.fonts.status };
};
for (let round = 1; round <= 16; round += 1) test(`DIAG note grows ${round}`, { skip, timeout: 90000 }, async (context) => {
  await useAppDirectory(context);
  const page = await openPage(await launch(context), await writableReviewUrl(context, await demoProject(context, "seed-stress.mjs"), "attention"), { viewport: { width: 1440, height: 900 } });
  const note = page.locator('.attention-sheet:not([hidden]) .gate-answer prism-field[data-field="note"] textarea');
  const empty = await note.evaluate(info);
  await note.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of a longer note.`).join("\n"));
  const filled = await note.evaluate(info);
  await repainted(page);
  const grown = await note.evaluate(info);
  console.log(`DIAG ${round} ${grown.h > empty.h ? "PASS" : "FAIL"} ${JSON.stringify({ empty, filled, grown })}`);
});
