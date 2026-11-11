// Browser helpers for the review app UI kit's acceptance tests.
// Playwright is not a dependency of this repository, so the browser tests use an installed copy, local or global, and skip with a message that says how to install it.
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defer } from "./teardown.mjs";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function loadPlaywright() {
  const bases = [ROOT];
  try {
    // npm is a .cmd shim on Windows, which starts only through the shell.
    bases.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32", windowsHide: true }).trim());
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
// CI sets PRISM_REQUIRE_BROWSER, so a missing browser fails the run there instead of skipping every browser test.
if (!playwright && process.env.PRISM_REQUIRE_BROWSER === "1") throw new Error("PRISM_REQUIRE_BROWSER is 1, but Playwright is not installed; run npm install -g playwright and npx playwright install chromium");
export const skip = playwright ? false : "Playwright is not installed; run npm install -g playwright and npx playwright install chromium";

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  // A Git command that the review server started for a page may still be ending in the folder, which Windows reports as busy for a moment.
  defer(context, () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return directory;
}

// The review app folder holds the stored preferences, so every test gets its own before any server starts.
export async function useAppDirectory(context) {
  const directory = await temporary(context, "prism-kit-app-");
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = directory;
  defer(context, () => {
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
  defer(context, close);
  return { base: review.baseUrl.replace(/\/$/, ""), close };
}

export async function launch(context) {
  const browser = await playwright.chromium.launch();
  defer(context, () => browser.close());
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

/**
 * Writes a claim record for a slice of a project, as a Prism server writes one: live for `minutesLeft`, or lapsed `minutesLeft` minutes ago when it is negative.
 * Write it before the project's review server starts, since the server caches what it read.
 */
export async function writeClaim(projectRoot, initiative, slug, { label = "Claude on build-2", host = null, activity = "implementation", minutesLeft = 41, minutesClaimed = 20 } = {}) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const now = Date.now();
  const at = (minutes) => new Date(now + minutes * 60000).toISOString();
  const claim = { schemaVersion: 1, slug, holder: `session-${slug.replace(/[^a-z0-9]/g, "").padEnd(16, "0").slice(0, 16)}`, label, ...(host ? { host } : {}), activity, claimedAt: at(-minutesClaimed), renewedAt: at(minutesLeft - 30), expiresAt: at(minutesLeft), nonce: "0123456789abcdef01234567" };
  const folder = path.join(projectRoot, ".prism", "initiatives", initiative, "claims");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${slug}.json`), `${JSON.stringify(claim, null, 2)}\n`);
  return claim;
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
// The grounds a text or boundary may sit on: the composed backgrounds of its ancestors, or, below a translucent surface with a backdrop filter, that surface composed over pure black and over pure white, the worst cases of whatever shows through.
const grounds = (element) => {
  const layers = [];
  let glass = false;
  for (let node = element; node; node = parentOf(node)) {
    const style = getComputedStyle(node);
    const color = rgba(style.backgroundColor);
    if (color[3] > 0) layers.push(color);
    if (color[3] >= 1) break;
    if (color[3] > 0 && style.backdropFilter && style.backdropFilter !== "none") { glass = true; break; }
  }
  const compose = (base) => layers.reduceRight((below, layer) => over(layer, below), base);
  return glass ? [compose([0, 0, 0, 1]), compose([255, 255, 255, 1])] : [compose([255, 255, 255, 1])];
};
const backdrop = (element) => grounds(element)[0];
const worst = (color, element) => Math.min(...grounds(element).map((ground) => ratio(over(color, ground), ground)));
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
const FIELD_OR_CHOICE = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea, [role=textbox], [role=searchbox], [role=combobox], [role=radio], [role=checkbox], [role=switch], [data-indicator]";
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
          const value = worst(rgba(style.color), element);
          const minimum = large ? 3 : 4.5;
          if (value + 0.005 < minimum) failures.push(describe(element) + ": " + value.toFixed(2) + " < " + minimum + " " + JSON.stringify(node.textContent.trim().slice(0, 40)));
        }
      }
      return [...new Set(failures)];
    `);
    return audit(selector);
  }, [IN_PAGE, selector]);
}

/** Every visible enabled field or choice control below `selector` none of whose border sides or fill reaches 3:1 against what surrounds it, on glass over pure black and over pure white. */
export function boundaryFailures(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const audit = new Function("selector", `${code}
      const failures = [];
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType !== Node.ELEMENT_NODE || !node.matches(FIELD_OR_CHOICE) || node.closest("svg") || !visible(node) || disabled(node)) continue;
          const style = getComputedStyle(node);
          const around = parentOf(node) ?? document.documentElement;
          const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(style["border" + side + "Width"]) > 0 && style["border" + side + "Style"] !== "none" && rgba(style["border" + side + "Color"])[3] > 0);
          const passes = worst(rgba(style.backgroundColor), around) >= 3 || sides.some((side) => worst(rgba(style["border" + side + "Color"]), around) >= 3);
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
          return { element: describe(node), width: parseFloat(style.outlineWidth), style: style.outlineStyle, offset: parseFloat(style.outlineOffset), contrast: worst(rgba(style.outlineColor), parentOf(node) ?? document.documentElement), color: rgba(style.outlineColor) };
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

/** Every visible choice option below `selector` whose radio is hidden and that shows no visible indicator marked data-indicator. */
export function choicesWithoutIndicator(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const read = new Function("selector", `${code}
      const out = [];
      for (const scope of document.querySelectorAll(selector)) {
        for (const option of scope.querySelectorAll("prism-choice-option")) {
          if (!visible(option)) continue;
          const input = option.querySelector("input[type=radio]");
          const indicator = [...option.querySelectorAll("[data-indicator]")].some((node) => visible(node));
          if (!(input && visible(input)) && !indicator) out.push(describe(option));
        }
      }
      return out;
    `);
    return read(selector);
  }, [IN_PAGE, selector]);
}

/**
 * Every place below `selector` where the page names one of Prism's own files: visible text, an accessible name or description, a tooltip, or the document title that holds a file ending in .json, .md, or .puml, or a path under .prism/ or docs/.
 * Text inside an element marked data-code-subject, and rendered documents and code, are where repository files are the subject, and are left out.
 */
export function stateFileNames(page, selector = "body") {
  return page.evaluate(([code, selector]) => {
    const read = new Function("selector", `${code}
      const NAME = /(?:^|[\\s"'(\\[\\/])(?:[\\w.-]+\\.(?:json|md|puml))(?![\\w-])|\\.prism\\/|(?:^|[\\s"'(\\[])docs\\//i;
      const exempt = (element) => {
        for (let node = element; node; node = parentOf(node)) {
          if (node.hasAttribute?.("data-code-subject") || ["PRISM-DOC", "PRISM-CODE"].includes(node.tagName)) return true;
        }
        return false;
      };
      const out = [];
      if (NAME.test(document.title)) out.push("document title: " + JSON.stringify(document.title));
      for (const scope of document.querySelectorAll(selector)) {
        for (const node of walk(scope)) {
          if (node.nodeType === Node.TEXT_NODE) {
            const element = node.assignedSlot ?? node.parentElement ?? node.parentNode?.host;
            if (!element || ["SCRIPT", "STYLE", "TITLE"].includes(element.tagName) || element.closest?.("svg") || !visible(element) || exempt(element)) continue;
            if (NAME.test(node.textContent)) out.push(describe(element) + ": " + JSON.stringify(node.textContent.trim().slice(0, 80)));
          } else if (node.nodeType === Node.ELEMENT_NODE && !exempt(node)) {
            for (const attribute of ["aria-label", "aria-description", "tip", "title", "label", "heading", "summary"]) {
              const value = node.getAttribute(attribute);
              if (value && NAME.test(value)) out.push(describe(node) + " [" + attribute + "]: " + JSON.stringify(value.slice(0, 80)));
            }
            for (const id of (node.getAttribute("aria-labelledby") ?? "").split(/\\s+/).filter(Boolean)) {
              const label = node.getRootNode().getElementById?.(id) ?? document.getElementById(id);
              if (label && !exempt(label) && NAME.test(label.textContent)) out.push(describe(node) + " [aria-labelledby]: " + JSON.stringify(label.textContent.trim().slice(0, 80)));
            }
          }
        }
      }
      return [...new Set(out)];
    `);
    return read(selector);
  }, [IN_PAGE, selector]);
}
