// Check the review browser layout on every page of the demo, edge-case, and empty projects at several window sizes, and the component catalog at each of them.
// The check fails on content that escapes its container, a page that scrolls the whole window, a control cut off by its container, and browser errors.
// Usage: node scripts/review-demo/layout-check.mjs [--viewports phone,tablet,laptop,wide] [--themes light,dark] [--screenshots directory] [--catalog url]
// With --catalog it checks only the catalog at that URL. Each catalog problem prints as `catalog <entry>: <problem> at <viewport> (<width>px), <theme>`.
// Playwright is not a dependency of this repository; the check uses an installed copy, local or global.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./project.mjs";
import { auditPage as audit, checkCatalog, checkNames, loadPlaywright as installedPlaywright, VIEWPORTS } from "./layout-audit.mjs";

const PLACES = ["attention", "roadmap", "requirements", "decisions", "glossary"];

const { values } = parseArgs({ options: { viewports: { type: "string", default: "phone,tablet,laptop,wide" }, themes: { type: "string", default: "light" }, screenshots: { type: "string" }, catalog: { type: "string" } } });
const viewports = values.viewports.split(",");
const themes = values.themes.split(",");
checkNames({ viewports, themes });

function loadPlaywright() {
  const playwright = installedPlaywright();
  if (playwright) return playwright;
  process.stderr.write("layout-check: Playwright is not installed. Install it with `npm install -g playwright` and `npx playwright install chromium`.\n");
  process.exit(2);
}

const catalogLine = ({ entry, problem, viewport, width, theme }) => `catalog ${entry}: ${problem} at ${viewport} (${width}px), ${theme}`;

// With --catalog, only that catalog is checked.
if (values.catalog) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let problems;
  try {
    problems = await checkCatalog({ url: values.catalog, viewports, themes, browser });
  } finally {
    await browser.close();
  }
  for (const problem of problems) process.stdout.write(`${catalogLine(problem)}\n`);
  process.stdout.write(`${viewports.length * themes.length} catalog checks, ${problems.length} ${problems.length === 1 ? "problem" : "problems"}.\n`);
  process.exit(problems.length ? 1 : 0);
}

const parent = await mkdtemp(path.join(os.tmpdir(), "prism-layout-check-"));
const appDirectory = path.join(parent, "app");
await mkdir(appDirectory, { mode: 0o700 });
const held = [];
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const findings = new Map();
let pages = 0;
let catalogProblems = [];

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
        // The vendored PlantUML runtime sets a style attribute while it renders, which the page's style policy refuses without effect on the result.
        // Chromium words that refusal either way, depending on its version.
        if (message.type() === "error" && !/^(Refused to apply inline style|Applying inline style violates)/.test(message.text())) record(`console error: ${message.text().split("\n")[0]}`, current);
      });
      const visit = async (project, ref, label = ref) => {
        current = `${viewport}/${theme} ${project.name}: ${label}`;
        const url = new URL("review", project.url);
        url.searchParams.set("artifact", ref);
        await page.goto(url.href);
        await page.waitForSelector('#artifact[aria-busy="false"]', { timeout: 10000 }).catch(() => record("the page did not render", current));
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
        // Each overlay opens the way a reader opens it, through its kit control.
        "who's working": ["attention", () => page.locator("header").getByRole("button", { name: /working/ }).click()],
        "navigation drawer": ["roadmap", async () => {
          const navigation = page.locator("header").getByRole("button", { name: "Navigation", exact: true });
          if (await navigation.isVisible()) await navigation.click();
        }],
        "maximized document": ["docs/wide.md", () => page.locator("[data-maximize]").first().click()],
        "maximized diagram": ["docs/plans/huge-initiative/slice-with-long-name/diagram.puml", () => page.locator("[data-maximize]").first().click()],
        "link preview": ["slice:huge-initiative/slice-with-long-name", () => page.locator("#artifact .link-chip").first().hover()],
        "side panel": ["slice:huge-initiative/slice-with-long-name", async () => {
          await page.locator('#artifact .link-chip[data-artifact$=".md"]').first().hover();
          await page.locator(".link-preview .link-preview-panel").click({ timeout: 3000 });
        }]
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
  // The component catalog of the empty project, at every checked viewport and theme.
  const emptyProject = projects.find((project) => project.name === "empty");
  catalogProblems = await checkCatalog({ url: new URL("kit/catalog", emptyProject.url).href, viewports, themes, browser });
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

for (const problem of catalogProblems) process.stdout.write(`${catalogLine(problem)}\n`);
for (const [finding, places] of findings) {
  process.stdout.write(`${finding}\n  ${places.slice(0, 5).join("\n  ")}${places.length > 5 ? `\n  and ${places.length - 5} more` : ""}\n`);
}
// A catalog problem counts as one finding per entry and problem, whatever the viewports and themes it shows at.
const distinct = findings.size + new Set(catalogProblems.map((problem) => `${problem.entry}\n${problem.problem}`)).size;
process.stdout.write(`${pages} page checks, ${viewports.length * themes.length} catalog checks, ${distinct} distinct ${distinct === 1 ? "finding" : "findings"}.\n`);
process.exit(distinct ? 1 : 0);
