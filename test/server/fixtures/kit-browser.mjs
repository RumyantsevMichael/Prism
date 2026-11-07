// Browser helpers for the review app UI kit's acceptance tests.
// Playwright is not a dependency of this repository, so the browser tests use an installed copy, local or global, and skip with a message that says how to install it.
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function loadPlaywright() {
  const bases = [ROOT];
  try {
    bases.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
  }
  for (const base of bases) {
    try {
      return createRequire(path.join(base, "noop.js"))("playwright");
    } catch {
    }
  }
  return null;
}

export const playwright = loadPlaywright();
export const skip = playwright ? false : "Playwright is not installed; run npm install -g playwright and npx playwright install chromium";

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The review app folder holds the stored preferences, so every test gets its own before any server starts.
export async function useAppDirectory(context) {
  const directory = await temporary(context, "prism-kit-app-");
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = previous;
  });
  return directory;
}

// The conservation store reads its location when its module loads, so private data is set before the review server's import.
async function reviewServer() {
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-data-")));
  delete process.env.CLAUDE_PLUGIN_DATA;
  return import("../../../dist/server/review/review-server.mjs");
}

/** A demo project built by the review demo seed, with initiatives, slices, documents, records, and gates. */
export async function demoProject(context, seed = "seed.mjs") {
  const parent = await temporary(context, "prism-kit-demo-");
  const root = path.join(parent, "project");
  execFileSync(process.execPath, [path.join(ROOT, "scripts/review-demo", seed), root], { stdio: "ignore", env: { ...process.env, PLUGIN_DATA: path.join(parent, "data") } });
  return root;
}

/** Starts a review server for a project and returns its base URL without a trailing slash; the server closes after the test. */
export async function serveProject(context, projectRoot) {
  const { startReviewServer } = await reviewServer();
  const review = await startReviewServer({ projectRoot, openBrowser: async () => false });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await review.close();
    }
  };
  context.after(close);
  return { base: review.baseUrl.replace(/\/$/, ""), close };
}

export async function launch(context) {
  const browser = await playwright.chromium.launch();
  context.after(() => browser.close());
  return browser;
}

/** Opens a page that records browser errors; `blockOtherHosts` makes every host but 127.0.0.1 unreachable. */
export async function openPage(browser, url, { colorScheme = "light", reducedMotion = "no-preference", viewport = { width: 1280, height: 800 }, blockOtherHosts = false } = {}) {
  const context = await browser.newContext({ colorScheme, reducedMotion, viewport });
  if (blockOtherHosts) await context.route((target) => target.hostname !== "127.0.0.1", (route) => route.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await page.goto(url);
  await settle(page);
  return page;
}

/** Waits until the page has loaded, its fonts are ready, and a rendering view, if any, is no longer busy. */
// The review page keeps an event stream open and polls the index, so the network never goes idle; the page's load event and its fonts are the signal.
export async function settle(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector("#artifact")?.getAttribute("aria-busy") !== "true", null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}

export async function waitForView(page) {
  await page.waitForFunction(() => document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", null, { timeout: 10000 });
  await page.waitForTimeout(200);
}

export function reviewUrl(base, ref) {
  return `${base}/review?artifact=${encodeURIComponent(ref)}`;
}

// The functions below run in the page. They walk the flat tree, through open shadow roots and slots, and turn every CSS color into RGBA through a canvas.
const IN_PAGE = String.raw`
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const paint = canvas.getContext("2d", { willReadFrequently: true });
const rgba = (color) => {
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "rgba(0, 0, 0, 0)";
  paint.fillStyle = color;
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
};
const over = (top, bottom) => {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (!a) return [0, 0, 0, 0];
  return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
};
const luminance = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (x, y) => { const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
const backdrop = (element) => {
  const layers = [];
  for (let node = element; node; node = parentOf(node)) {
    const color = rgba(getComputedStyle(node).backgroundColor);
    if (color[3] > 0) layers.push(color);
    if (color[3] >= 1) break;
  }
  return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
};
const visible = (element) => {
  for (let node = element; node; node = parentOf(node)) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (node.hasAttribute?.("hidden") || node.classList?.contains("sr-only")) return false;
  }
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};
const describe = (element) => {
  const parts = [];
  for (let node = element; node && parts.length < 4; node = parentOf(node)) {
    parts.unshift(node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (node.getAttribute?.("data-catalog-entry") ? "[" + node.getAttribute("data-catalog-entry") + "]" : "") + (node.getAttribute?.("data-specimen") ? "[" + node.getAttribute("data-specimen") + "]" : ""));
  }
  return parts.join(" > ");
};
function* walk(root) {
  const nodes = [root];
  while (nodes.length) {
    const node = nodes.shift();
    yield node;
    if (node.shadowRoot) nodes.push(...node.shadowRoot.childNodes);
    nodes.push(...node.childNodes);
  }
}
const disabled = (element) => {
  for (let node = element; node; node = parentOf(node)) {
    if (node.hasAttribute?.("disabled") || node.getAttribute?.("aria-disabled") === "true") return true;
  }
  return false;
};
const CONTROL = "button, a[href], input, select, textarea, summary, [tabindex], [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem], [role=option], [role=radio], [role=checkbox], [role=switch], [role=combobox], [role=slider]";
`;

/** Every visible text below `selector` whose contrast is under WCAG AA, as `<element path>: <ratio> < <minimum> "<text>"`. */
export function contrastFailures(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const audit = new Function("selector", `${code}
      const failures = [];
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
          const element = node.assignedSlot ?? node.parentElement ?? node.parentNode?.host;
          if (!element || ["SCRIPT", "STYLE", "TITLE", "OPTION"].includes(element.tagName) || element.closest?.("svg") || !visible(element) || disabled(element)) continue;
          const style = getComputedStyle(element);
          const size = parseFloat(style.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          const background = backdrop(element);
          const text = over(rgba(style.color), background);
          const value = ratio(text, background);
          const minimum = large ? 3 : 4.5;
          if (value + 0.005 < minimum) failures.push(describe(element) + ": " + value.toFixed(2) + " < " + minimum + " " + JSON.stringify(node.textContent.trim().slice(0, 40)));
        }
      }
      return [...new Set(failures)];
    `);
    return audit(selector);
  }, [IN_PAGE, selector]);
}

/** Every visible enabled control below `selector` that draws a boundary none of whose sides or fill reaches 3:1 against what surrounds it. */
export function boundaryFailures(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const audit = new Function("selector", `${code}
      const failures = [];
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.ELEMENT_NODE || !node.matches(CONTROL) || node.closest("svg") || !visible(node) || disabled(node)) continue;
          const style = getComputedStyle(node);
          const outside = backdrop(parentOf(node) ?? document.documentElement);
          const fill = over(rgba(style.backgroundColor), outside);
          const fillDiffers = ratio(fill, outside) > 1.05;
          const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(style["border" + side + "Width"]) > 0 && style["border" + side + "Style"] !== "none" && rgba(style["border" + side + "Color"])[3] > 0);
          if (!fillDiffers && !sides.length) continue;
          const passes = ratio(fill, outside) >= 3 || sides.some((side) => ratio(over(rgba(style["border" + side + "Color"]), outside), outside) >= 3);
          if (!passes) failures.push(describe(node));
        }
      }
      return [...new Set(failures)];
    `);
    return audit(selector);
  }, [IN_PAGE, selector]);
}

/** The deepest focused element's focus ring: its outline width, style, offset, and contrast against what surrounds it, or null without focus. */
export function focusRing(page) {
  return page.evaluate((code) => {
    const read = new Function(`${code}
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      if (!element || element === document.body) return null;
      const candidates = [element];
      for (let node = parentOf(element); node && node !== document.body; node = parentOf(node)) {
        if (node.tagName.toLowerCase().startsWith("prism-")) { candidates.push(node); break; }
      }
      for (const node of candidates) {
        const style = getComputedStyle(node);
        if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) {
          const outside = backdrop(parentOf(node) ?? document.documentElement);
          return { element: describe(node), width: parseFloat(style.outlineWidth), style: style.outlineStyle, offset: parseFloat(style.outlineOffset), contrast: ratio(over(rgba(style.outlineColor), outside), outside), color: rgba(style.outlineColor) };
        }
      }
      return { element: describe(element), width: 0, style: "none", offset: 0, contrast: 0, color: null };
    `);
    return read();
  }, IN_PAGE);
}

/** The background color of every visible element below `selector` that paints one, keyed by its element path, leaving out SVG content. */
export function paintedBackgrounds(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const read = new Function("selector", `${code}
      const painted = {};
      const counts = {};
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.ELEMENT_NODE || node.closest("svg") || node.tagName === "svg" || !visible(node)) continue;
          const color = rgba(getComputedStyle(node).backgroundColor);
          if (color[3] === 0) continue;
          let key = describe(node);
          counts[key] = (counts[key] ?? 0) + 1;
          if (counts[key] > 1) key += " #" + counts[key];
          painted[key] = color.join(",");
        }
      }
      return painted;
    `);
    return read(selector);
  }, [IN_PAGE, selector]);
}

/** The computed transition and animation durations of every element and shadow element below `selector` that are not zero. */
export function movingElements(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const read = new Function("selector", `${code}
      const moving = [];
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          for (const pseudo of [null, "::before", "::after"]) {
            const style = getComputedStyle(node, pseudo);
            const transitions = style.transitionProperty === "none" ? [] : style.transitionDuration.split(",");
            const animations = style.animationName === "none" ? [] : style.animationDuration.split(",");
            if ([...transitions, ...animations].some((value) => parseFloat(value) > 0)) moving.push(describe(node) + (pseudo ?? "") + " " + style.transitionDuration + " " + style.animationDuration);
          }
        }
      }
      return [...new Set(moving)];
    `);
    return read(selector);
  }, [IN_PAGE, selector]);
}

/** Every element below `selector` whose right edge passes its parent's while the parent does not scroll or clip, and a horizontally scrolling window. */
export function escapes(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const read = new Function("selector", `${code}
      const out = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) out.push("the window scrolls horizontally");
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.ELEMENT_NODE || node.closest("svg") || !visible(node)) continue;
          const style = getComputedStyle(node);
          if (["absolute", "fixed"].includes(style.position)) continue;
          const parent = parentOf(node);
          if (!parent || parent === document.body || getComputedStyle(parent).overflowX !== "visible") continue;
          const box = node.getBoundingClientRect();
          const limit = parent.getBoundingClientRect();
          if (box.width && box.right > limit.right + 2 && box.left < limit.right) out.push(describe(node) + " overflows " + describe(parent));
        }
      }
      return [...new Set(out)];
    `);
    return read(selector);
  }, [IN_PAGE, selector]);
}

/** Reads a custom property as it computes on the root element. */
export function rootToken(page, name) {
  return page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
}

/** The visible text of the shown tooltip, or null when none shows. */
export function shownTooltip(page) {
  return page.evaluate((code) => {
    const read = new Function(`${code}
      for (const node of walk(document.body)) {
        if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute("role") === "tooltip" && visible(node)) return node.textContent.trim();
      }
      return null;
    `);
    return read();
  }, IN_PAGE);
}
