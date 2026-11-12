// The layout audit shared by the layout check: the checked window sizes, the page audit, and the catalog check.
// The page audit names content that escapes its container, a page that scrolls the whole window, and a control cut off by its container;
// checkCatalog runs the same checks on each entry of a component catalog and names the entry that breaks.
// Playwright is not a dependency of this repository; the audit uses an installed copy, local or global.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./project.mjs";

export const VIEWPORTS = {
  phone: { width: 360, height: 740 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1280, height: 800 },
  short: { width: 1280, height: 560 },
  wide: { width: 1920, height: 1080 },
  ultra: { width: 2560, height: 1440 }
};

export const THEMES = ["light", "dark"];

/** The installed Playwright, local or global, or null when there is none. */
export function loadPlaywright() {
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

/** Throws for a viewport or theme the audit does not know. */
export function checkNames({ viewports = [], themes = [] }) {
  for (const name of viewports) {
    if (!VIEWPORTS[name]) throw new Error(`Unknown viewport ${name}; use ${Object.keys(VIEWPORTS).join(", ")}.`);
  }
  for (const name of themes) {
    if (!THEMES.includes(name)) throw new Error(`Unknown theme ${name}; use ${THEMES.join(", ")}.`);
  }
}

/** Runs in the page: every finding names the element and the container it escapes. */
export function auditPage() {
  const out = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) out.push(`the window scrolls horizontally (${root.scrollWidth} > ${root.clientWidth})`);
  if (root.scrollHeight > root.clientHeight + 1) out.push(`the window scrolls vertically (${root.scrollHeight} > ${root.clientHeight})`);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[hidden], svg, .sr-only");
  for (const el of document.querySelectorAll("body *")) {
    if (!shown(el) || ["absolute", "fixed"].includes(getComputedStyle(el).position)) continue;
    const parent = el.parentElement;
    if (!parent || parent === document.body || getComputedStyle(parent).overflowX !== "visible") continue;
    const box = el.getBoundingClientRect();
    const limit = parent.getBoundingClientRect();
    if (box.width && box.right > limit.right + 2 && box.left < limit.right) out.push(`${describe(el)} overflows ${describe(parent)}`);
  }
  for (const el of document.querySelectorAll("button, a[href], input, textarea, select")) {
    if (!shown(el)) continue;
    const box = el.getBoundingClientRect();
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow === "auto" || overflow === "scroll") break;
      if (overflow === "hidden" || overflow === "clip") {
        const limit = parent.getBoundingClientRect();
        if (box.width && box.right > limit.right + 2 && box.left < limit.right) out.push(`control ${describe(el)} is cut off by ${describe(parent)}`);
        break;
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Runs in the page: one `{ entry, problem }` for each catalog entry, marked `data-catalog-entry`, that holds content escaping its container,
 * a control cut off by a container that clips it, or content past the window's right edge while the window scrolls horizontally.
 * It looks through open shadow roots, so a kit element's own parts are checked too.
 */
export function auditCatalog() {
  const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    for (let node = el; node; node = parentOf(node)) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || node.hasAttribute?.("hidden") || node.classList?.contains("sr-only") || node.tagName.toLowerCase() === "svg") return false;
    }
    return true;
  };
  const floating = (el) => {
    for (let node = el; node; node = parentOf(node)) {
      if (["absolute", "fixed"].includes(getComputedStyle(node).position)) return true;
      if (node.hasAttribute?.("data-catalog-entry")) return false;
    }
    return false;
  };
  const CONTROL = "button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [tabindex]";
  function* walk(root) {
    const nodes = [...root.children];
    if (root.shadowRoot) nodes.unshift(...root.shadowRoot.children);
    while (nodes.length) {
      const node = nodes.shift();
      yield node;
      if (node.shadowRoot) nodes.push(...node.shadowRoot.children);
      nodes.push(...node.children);
    }
  }
  const out = [];
  const root = document.documentElement;
  const scrolls = root.scrollWidth > root.clientWidth + 1;
  for (const entry of document.querySelectorAll("[data-catalog-entry]")) {
    const name = entry.getAttribute("data-catalog-entry");
    const add = (problem) => out.push({ entry: name, problem });
    if (scrolls && entry.getBoundingClientRect().right > root.clientWidth + 1) add(`the page scrolls horizontally (${root.scrollWidth} > ${root.clientWidth})`);
    for (const el of walk(entry)) {
      if (!shown(el) || floating(el)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width) continue;
      const parent = parentOf(el);
      if (parent && parent !== document.body && getComputedStyle(parent).overflowX === "visible" && getComputedStyle(parent).display !== "contents") {
        const limit = parent.getBoundingClientRect();
        if (box.right > limit.right + 2 && box.left < limit.right) add(`${describe(el)} overflows ${describe(parent)}`);
      }
      if (scrolls && box.right > root.clientWidth + 1) add(`${describe(el)} passes the window's right edge (${Math.round(box.right)} > ${root.clientWidth})`);
      if (!el.matches(CONTROL)) continue;
      for (let node = parentOf(el); node && node !== document.body; node = parentOf(node)) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") break;
        if (overflow === "hidden" || overflow === "clip") {
          const limit = node.getBoundingClientRect();
          if (box.right > limit.right + 2 || box.left < limit.left - 2) add(`control ${describe(el)} is cut off by ${describe(node)}`);
          break;
        }
        if (node.hasAttribute?.("data-catalog-entry")) break;
      }
    }
  }
  const seen = new Set();
  return out.filter((item) => {
    const key = `${item.entry}\n${item.problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Opens a catalog URL at each named viewport and theme, emulating the theme as the operating system's color scheme and setting it in the `theme` query,
 * and resolves to one `{ entry, viewport, width, theme, problem }` per problem of a catalog entry.
 */
export async function checkCatalog({ url, viewports = ["phone", "laptop"], themes = ["light"], browser = null } = {}) {
  checkNames({ viewports, themes });
  let owned = null;
  if (!browser) {
    const playwright = loadPlaywright();
    if (!playwright) throw new Error("Playwright is not installed; run npm install -g playwright and npx playwright install chromium");
    owned = await playwright.chromium.launch();
  }
  const problems = [];
  try {
    for (const viewport of viewports) {
      for (const theme of themes) {
        // The window is exactly the viewport's width, also for a page without a viewport meta element, so an entry is checked at the width it names.
        const context = await (browser ?? owned).newContext({ viewport: VIEWPORTS[viewport], colorScheme: theme });
        try {
          const page = await context.newPage();
          const target = new URL(url);
          target.searchParams.set("theme", theme);
          await page.goto(target.href);
          await page.waitForLoadState("load");
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => document.querySelector("#catalog")?.getAttribute("aria-busy") !== "true", null, { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(300);
          for (const { entry, problem } of await page.evaluate(auditCatalog)) problems.push({ entry, viewport, width: VIEWPORTS[viewport].width, theme, problem });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await owned?.close();
  }
  return problems;
}
