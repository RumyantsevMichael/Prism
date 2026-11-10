// Helpers for the review app places' acceptance tests: a demo project changed before its server starts, the rail, the sidebar, and the mockup comparison.
// Lookups stay inside the rail, the sidebar, or the drawer, and read names through the accessibility tree, so the catalog, the shell, and shadow roots cannot collide with them.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { demoProject, launch, openPage, reviewUrl, ROOT, serveProject, useAppDirectory, waitForView } from "./kit-browser.mjs";

export { reviewUrl, waitForView, ROOT };

export const SLICE = "slice:retry-hardening/timeout-retries";
export const PLACES = ["Attention", "Work", "Roadmap", "Knowledge", "History"];

/** Seeds a demo project, lets `prepare(root)` change its files, then starts its review server and a browser. */
export async function placesDemo(context, { seed = "seed.mjs", prepare = null } = {}) {
  await useAppDirectory(context);
  const root = await demoProject(context, seed);
  if (prepare) await prepare(root);
  const { base, close } = await serveProject(context, root);
  return { root, base, close, browser: await launch(context) };
}

export async function open(browser, base, ref, { width = 1440, height = 900, colorScheme = "light", query = "" } = {}) {
  const page = await openPage(browser, `${reviewUrl(base, ref)}${query}`, { viewport: { width, height }, colorScheme });
  await waitForView(page).catch(() => {});
  return page;
}

/** Edits a JSON file of a project in place. */
export async function editJson(root, relative, edit) {
  const file = path.join(root, relative);
  const value = JSON.parse(await readFile(file, "utf8"));
  const changed = edit(value) ?? value;
  await writeFile(file, `${JSON.stringify(changed, null, 2)}\n`);
}

export async function writeText(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

export const rail = (page) => page.getByRole("navigation", { name: "Places", exact: true });
export const placeButton = (scope, name) => rail(scope).getByRole("button", { name: new RegExp(`^${name}\\b`) });
// The sidebar of the shell, or the drawer's copy of it while the drawer is open.
export const sidebar = (page) => page.locator("#sidebar");
export const drawer = (page) => page.getByRole("dialog", { name: "Navigation" });
export const placeTitle = (scope) => scope.getByRole("heading", { level: 2 }).first();
export const groupHeadings = async (scope) => (await scope.getByRole("heading", { level: 3 }).allInnerTexts()).map((text) => text.replace(/\s+\d+\s*$/, "").replace(/\s+/g, " ").trim());
export const item = (scope, name) => scope.getByRole("treeitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first();
/** The row of a tree item, its own link without its children, so a click lands on it even while it is expanded. */
export const row = (scope, name) => item(scope, name).locator(":scope > a").first();
/** The visible treeitems' names in document order, read through the accessibility tree. */
export const itemNames = (scope) => scope.getByRole("treeitem").evaluateAll((items) => items.filter((node) => node.getClientRects().length).map((node) => {
  const ids = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  const text = ids.length ? ids.map((id) => node.getRootNode().getElementById?.(id)?.textContent ?? "").join(" ") : node.textContent;
  return text.replace(/\s+/g, " ").trim();
}));
/** The accessible names of the buttons below `scope`, in order, read from the accessibility tree so shadow roots and labels count as assistive technology reads them. */
export async function buttonNames(scope) {
  const snapshot = await scope.ariaSnapshot();
  return [...snapshot.matchAll(/- button "((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\"/g, '"'));
}
export const shownRef = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));

export async function settledOn(page, ref) {
  await page.waitForFunction((ref) => new URL(location.href).searchParams.get("artifact") === ref && document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", ref, { timeout: 10000 });
  await page.waitForTimeout(200);
}

/** Chooses a place on the rail of `scope`, a page or the drawer, and waits until the rail marks it current. */
export async function choosePlace(scope, name) {
  await placeButton(scope, name).click();
  await rail(scope).getByRole("button", { name: new RegExp(`^${name}\\b`), pressed: true }).waitFor({ timeout: 10000 });
}

/** The tabs of the strip as their refs, with * on the selected tab and (p) on the preview tab. */
export const tabs = (page) => page.evaluate(() => [...document.querySelectorAll("#open-tabs prism-doc-tab")].map((tab) => `${tab.getAttribute("value")}${tab.hasAttribute("selected") ? "*" : ""}${tab.hasAttribute("preview") ? "(p)" : ""}`));

/**
 * Runs the places comparison of the demo app with the approved mockup and returns its exit status and report.
 * Every slice that changes a screen runs it for its scenes and parts at 390, 820, and 1440 pixels in both themes.
 */
export async function comparePlaces(context, { scenes, parts, widths = "1440,820,390", themes = "light,dark" }) {
  const out = await mkdtemp(path.join(os.tmpdir(), "prism-places-pairs-"));
  context.after(() => rm(out, { recursive: true, force: true }));
  const args = [path.join(ROOT, "scripts/review-demo/places-compare.mjs"), "--out", out, "--scenes", scenes, "--widths", widths, "--themes", themes];
  if (parts) args.push("--parts", parts);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 900000 });
  let report = null;
  try {
    report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  } catch {
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", report, out };
}
