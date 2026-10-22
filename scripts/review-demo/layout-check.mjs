// Check the review browser layout on every page of the demo, edge-case, and empty projects at several window sizes.
// The check fails on content that escapes its container, a page that scrolls the whole window, a control cut off by its container, and browser errors.
// Usage: node scripts/review-demo/layout-check.mjs [--viewports phone,tablet,laptop,wide] [--themes light,dark] [--screenshots directory]
// Playwright is not a dependency of this repository; the check uses an installed copy, local or global.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./project.mjs";

const VIEWPORTS = {
  phone: { width: 360, height: 740 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1280, height: 800 },
  short: { width: 1280, height: 560 },
  wide: { width: 1920, height: 1080 },
  ultra: { width: 2560, height: 1440 }
};
const PLACES = ["attention", "roadmap", "requirements", "decisions", "glossary"];

const { values } = parseArgs({ options: { viewports: { type: "string", default: "phone,tablet,laptop,wide" }, themes: { type: "string", default: "light" }, screenshots: { type: "string" } } });
const viewports = values.viewports.split(",");
const themes = values.themes.split(",");
for (const name of viewports) {
  if (!VIEWPORTS[name]) throw new Error(`Unknown viewport ${name}; use ${Object.keys(VIEWPORTS).join(", ")}.`);
}

function loadPlaywright() {
  for (const base of [ROOT, execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()]) {
    try {
      return createRequire(path.join(base, "noop.js"))("playwright");
    } catch {
    }
  }
  process.stderr.write("layout-check: Playwright is not installed. Install it with `npm install -g playwright` and `npx playwright install chromium`.\n");
  process.exit(2);
}

// Runs in the page: every finding names the element and the container it escapes.
function audit() {
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

const parent = await mkdtemp(path.join(os.tmpdir(), "prism-layout-check-"));
const appDirectory = path.join(parent, "app");
await mkdir(appDirectory, { mode: 0o700 });
const held = [];
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const findings = new Map();
let pages = 0;

function record(finding, where) {
  if (!findings.has(finding)) findings.set(finding, []);
  findings.get(finding).push(where);
}

try {
  const projects = [];
  for (const [name, seed] of [["demo", "seed.mjs"], ["stress", "seed-stress.mjs"]]) {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/review-demo", seed), path.join(parent, name)], { stdio: "ignore" });
    projects.push({ name, root: path.join(parent, name), data: path.join(parent, `${name}-data`) });
  }
  const empty = path.join(parent, "empty");
  await mkdir(path.join(empty, ".prism"), { recursive: true });
  await writeFile(path.join(empty, ".prism/workflow.md"), await readFile(path.join(parent, "demo/.prism/workflow.md")));
  projects.push({ name: "empty", root: empty, data: path.join(parent, "empty-data") });

  const { startStandaloneReview } = await import(path.join(ROOT, "dist/server/review/review-server-pool.mjs"));
  for (const project of projects) {
    const env = { ...process.env, PRISM_REVIEW_APP_DIR: appDirectory, PLUGIN_DATA: project.data };
    delete env.PRISM_REVIEW_APP;
    const review = await startStandaloneReview({ projectRoot: project.root, env, openBrowser: async () => false });
    held.push(review.held);
    project.url = new URL(review.url);
    project.url.search = "";
    const index = await (await fetch(new URL("api/index", project.url))).json();
    project.refs = [...new Set([...PLACES, ...index.navigation.index.map((entry) => entry.ref).filter((ref) => ref !== "glossary"), ...index.artifacts])];
  }

  for (const viewport of viewports) {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: VIEWPORTS[viewport], colorScheme: theme, isMobile: viewport === "phone", hasTouch: viewport === "phone" });
      const page = await context.newPage();
      let current = "";
      page.on("pageerror", (error) => record(`page error: ${error.message}`, current));
      page.on("console", (message) => {
        if (message.type() === "error") record(`console error: ${message.text().split("\n")[0]}`, current);
      });
      const visit = async (project, ref, label = ref) => {
        current = `${viewport}/${theme} ${project.name}: ${label}`;
        const url = new URL("review", project.url);
        url.searchParams.set("artifact", ref);
        await page.goto(url.href);
        await page.waitForSelector("#artifact .artifact-header, #artifact .document-card, #artifact .error", { timeout: 10000 }).catch(() => record("the page did not render", current));
        await page.waitForTimeout(400);
      };
      const check = async (project, label) => {
        pages += 1;
        for (const finding of await page.evaluate(audit)) record(finding, current);
        if (values.screenshots) {
          await mkdir(values.screenshots, { recursive: true });
          await page.screenshot({ path: path.join(values.screenshots, `${viewport}-${theme}-${project.name}-${label.replace(/[^a-z0-9]+/gi, "_").slice(-80)}.png`) });
        }
      };
      for (const project of projects) {
        for (const ref of project.refs) {
          await visit(project, ref);
          await check(project, ref);
        }
      }
      // Overlays and modes open over the edge-case project, whose long names stress them most.
      const stress = projects.find((project) => project.name === "stress");
      const states = {
        palette: ["roadmap", async () => { await page.keyboard.press("Control+k"); await page.keyboard.type("slice"); }],
        "project menu": ["attention", () => page.click("#project-button")],
        "index panel": ["attention", () => page.click("#indexing-button")],
        "sidebar toggled": ["roadmap", () => page.click("#sidebar-toggle")],
        "maximized document": ["docs/wide.md", () => page.click(".maximize-button")],
        "maximized diagram": ["docs/plans/huge-initiative/slice-with-long-name/diagram.puml", () => page.click(".maximize-button")],
        "link preview": ["slice:huge-initiative/slice-with-long-name", () => page.locator("#artifact .link-chip").first().hover()]
      };
      for (const [name, [ref, open]] of Object.entries(states)) {
        await visit(stress, ref, name);
        try {
          await open();
          await page.waitForTimeout(900);
        } catch (error) {
          record(`could not open the ${name}: ${error.message.split("\n")[0]}`, current);
        }
        await check(stress, name);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await Promise.all(held.map((server) => server?.close?.()));
  try {
    const discovery = JSON.parse(await readFile(path.join(appDirectory, "review-app.json"), "utf8"));
    process.kill(discovery.pid);
  } catch {
  }
  await rm(parent, { recursive: true, force: true });
}

for (const [finding, places] of findings) {
  process.stdout.write(`${finding}\n  ${places.slice(0, 5).join("\n  ")}${places.length > 5 ? `\n  and ${places.length - 5} more` : ""}\n`);
}
process.stdout.write(`${pages} page checks, ${findings.size} distinct ${findings.size === 1 ? "finding" : "findings"}.\n`);
process.exit(findings.size ? 1 : 0);
