import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted } from "./fixtures/wait.mjs";

// The page's toast reports a change made in a modal dialog, such as Settings, so a shown message stands above every open dialog and its backdrop.

async function catalog(context, colorScheme) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-toast-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`, { colorScheme, viewport: { width: 390, height: 800 } });
  await page.waitForFunction(() => customElements.get("prism-toast") !== undefined && customElements.get("prism-dialog") !== undefined, null, { timeout: 5000 });
  return page;
}

// Whether the shown toast stands in the top layer, which draws its elements in the order they entered it, above the open modal dialog.
// A modal dialog makes the page behind it inert, and an inert element takes no hit test, so the layer order is read rather than the element under a point.
const toastOnTop = (page) => page.evaluate(() => {
  const toast = document.querySelector("prism-toast[shown]");
  if (!toast) return "no toast shown";
  if (!document.querySelector("dialog:modal")) return "no modal dialog open";
  return toast.matches(":popover-open") ? "toast" : "under the dialog";
});

for (const colorScheme of ["light", "dark"]) {
  test(`a toast shown while a modal dialog is open stands above the dialog and its backdrop, in the ${colorScheme} theme`, { skip, timeout: 60000 }, async (context) => {
    const page = await catalog(context, colorScheme);
    const message = "A message long enough to wrap onto a second line in a narrow window, which still has to stand above the open dialog";
    await page.evaluate(() => {
      const dialog = document.createElement("prism-dialog");
      dialog.id = "toast-layer-dialog";
      dialog.setAttribute("heading", "Settings");
      dialog.setAttribute("placement", "bottom");
      dialog.innerHTML = "<p>A dialog that covers the bottom of the window.</p>";
      document.body.append(dialog);
    });
    await page.evaluate(() => document.getElementById("toast-layer-dialog").show());
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await page.evaluate((text) => document.querySelector("prism-toast").show(text, { tone: "success" }), message);
    await repainted(page);
    assert.equal(await toastOnTop(page), "toast", "the toast is drawn above the dialog");
    const box = await page.locator("prism-toast[shown]").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, "the toast stays inside the window");
    assert.match(await page.locator("prism-toast[shown]").innerText(), /stand above the open dialog/);
    assert.equal(await page.locator("prism-toast[shown]").evaluate((toast) => getComputedStyle(toast).pointerEvents), "none", "a pointer passes through the toast to what it covers");
    await page.evaluate(() => document.querySelector("prism-toast").show("Second message"));
    await repainted(page);
    assert.equal(await toastOnTop(page), "toast", "a replacing message stays above the dialog");
    await page.evaluate(() => document.querySelector("prism-toast").hide());
    assert.deepEqual(await page.evaluate(() => {
      const toast = document.querySelector("prism-toast");
      return { popover: toast.hasAttribute("popover"), role: toast.getAttribute("role"), live: toast.getAttribute("aria-live") };
    }), { popover: false, role: "status", live: "polite" }, "a hidden toast leaves the top layer and stays the page's live region");
    assert.deepEqual(page.errors, []);
  });
}
