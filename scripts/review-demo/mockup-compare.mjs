// Compare the demo review app with the approved UI kit mockup, scene by scene, as side-by-side screenshots.
// Each mockup scene is put into the same state in the app: the same kind of page, the same menu, popover, palette query, or side panel, at the same window size, theme, and density.
// Usage: node scripts/review-demo/mockup-compare.mjs --out <directory> [--scenes attention,roadmap,slice,palette,drawer] [--widths 1440,820,390] [--themes light,dark] [--densities compact,comfortable] [--mockup <file>]
// The output folder holds one `<scene>-<width>-<theme>-<density>.png` per combination, the mockup on the left and the app on the right, and an index.html that shows them in pairs.
// Playwright is not a dependency of this repository; the comparison uses an installed copy, local or global.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./project.mjs";
import { loadPlaywright, THEMES } from "./layout-audit.mjs";

const HEIGHT = 900;
const SLICE = "slice:retry-hardening/timeout-retries";
const DIAGRAM = "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml";

// Each scene names its frame in the mockup, the page the app opens, and how the app reaches the mockup's state from there.
const SCENES = {
  attention: {
    caption: "Attention with an open design gate, Appearance menu open",
    ref: "attention",
    async open(page) {
      // The mockup shows the design gate; the app lists every gate in one column, so the design gate is scrolled into view.
      await page.locator("#artifact .gate-visual-review").first().evaluate((element) => element.scrollIntoView({ block: "start" })).catch(() => {});
      await page.click("#appearance-button");
    }
  },
  roadmap: {
    caption: "Roadmap with the who's working popover open",
    ref: "roadmap",
    open: (page) => page.click("#presence-button")
  },
  slice: {
    caption: "A slice: stepper, claim, sub-tabs, and the diagram beside",
    ref: SLICE,
    // The diagram's link sits on the Files tab, so the panel opens from there, and the page then returns to the Design tab the mockup shows.
    async open(page) {
      const tab = (name) => page.locator("#artifact prism-tab").filter({ hasText: new RegExp(`^\\s*${name}`) }).first();
      await tab("Files").click();
      await page.locator(`#artifact prism-chip[data-artifact="${DIAGRAM}"]`).first().hover();
      await page.locator(".link-preview").getByRole("button", { name: "Show in side panel" }).click({ timeout: 4000 });
      await page.waitForTimeout(300);
      // Below tablet width the panel is a modal sheet over the page, so the tab is chosen without a pointer.
      await tab("Design").evaluate((element) => element.click());
      await page.mouse.move(0, 0);
    }
  },
  palette: {
    caption: "Command palette with its preview, over the roadmap",
    ref: "roadmap",
    async open(page) {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("retry");
    }
  },
  drawer: {
    caption: "Tablet width: the same sidebar opens as a drawer",
    ref: SLICE,
    async open(page) {
      const navigation = page.locator("#nav-button");
      if (await navigation.isVisible()) await navigation.click();
    }
  }
};
const DENSITIES = ["compact", "comfortable"];

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    scenes: { type: "string", default: Object.keys(SCENES).join(",") },
    widths: { type: "string", default: "1440,820,390" },
    themes: { type: "string", default: THEMES.join(",") },
    densities: { type: "string", default: DENSITIES.join(",") },
    mockup: { type: "string", default: path.join(ROOT, "docs/plans/review-app-ui-kit/mockup/mockup.html") }
  }
});
if (!values.out) {
  process.stderr.write("mockup-compare: pass --out <directory>.\n");
  process.exit(2);
}
const scenes = values.scenes.split(",");
const widths = values.widths.split(",").map(Number);
const themes = values.themes.split(",");
const densities = values.densities.split(",");
for (const name of scenes) if (!SCENES[name]) throw new Error(`Unknown scene ${name}; use ${Object.keys(SCENES).join(", ")}.`);
for (const name of themes) if (!THEMES.includes(name)) throw new Error(`Unknown theme ${name}; use ${THEMES.join(", ")}.`);
for (const name of densities) if (!DENSITIES.includes(name)) throw new Error(`Unknown density ${name}; use ${DENSITIES.join(", ")}.`);
for (const width of widths) if (!Number.isInteger(width) || width < 320) throw new Error(`Unknown width ${width}; use whole pixels of 320 or more.`);

const playwright = loadPlaywright();
if (!playwright) {
  process.stderr.write("mockup-compare: Playwright is not installed. Install it with `npm install -g playwright` and `npx playwright install chromium`.\n");
  process.exit(2);
}
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });

// The mockup's own controls set its theme and density from the query string.
// The mockup page frames each scene in a captioned window of fixed height; these rules make the scene's window fill the browser window instead.
const MOCKUP_FRAME_CSS = `
  .mock-bar, .mock-caption { display: none !important; }
  .mock-frames { padding: 0 !important; gap: 0 !important; }
  .mock-frame, .mock-frame.is-tablet { max-width: none !important; width: 100% !important; margin: 0 !important; }
  .mock-frame > .app { height: ${HEIGHT}px !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .caret { visibility: hidden !important; }
`;

async function shootMockup(browser, { scene, width, theme, density }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: theme });
  const page = await context.newPage();
  const url = pathToFileURL(values.mockup);
  url.searchParams.set("theme", theme);
  url.searchParams.set("density", density);
  await page.goto(url.href);
  await page.addStyleTag({ content: MOCKUP_FRAME_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const frame = page.locator(`#${scene} > .app`);
  const buffer = await frame.screenshot({ animations: "disabled" });
  await context.close();
  return buffer;
}

async function shootApp(browser, project, { scene, width, theme }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", isMobile: width < 720, hasTouch: width < 720 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async () => {
    const url = new URL("review", project.url);
    url.searchParams.set("artifact", SCENES[scene].ref);
    await page.goto(url.href);
    await page.waitForSelector('#artifact[aria-busy="false"]', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
  };
  await visit();
  // A page still settling can miss the first attempt, so a state that does not open gets one more visit before it counts as missing.
  let note = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await SCENES[scene].open(page);
      await page.waitForTimeout(900);
      note = "";
      break;
    } catch (error) {
      note = `could not open the scene's state: ${error.message.split("\n")[0]}`;
      if (attempt === 1) await visit();
    }
  }
  const buffer = await page.screenshot({ animations: "disabled" });
  await context.close();
  return { buffer, note: [note, ...errors.map((message) => `page error: ${message}`)].filter(Boolean).join("; ") };
}

// The two shots sit side by side with a label above each, drawn by the browser itself so the comparison needs no image library.
async function compose(browser, { mockup, app, width, title }) {
  const gap = 24;
  const label = 32;
  const context = await browser.newContext({ viewport: { width: width * 2 + gap, height: HEIGHT + label }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const image = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#8a8f98;font:600 14px system-ui,sans-serif;color:#fff">
    <div style="display:grid;grid-template-columns:${width}px ${width}px;gap:${gap}px">
      <div><div style="height:${label}px;display:flex;align-items:center;padding:0 8px;white-space:nowrap;overflow:hidden">Mockup · ${title}</div><img style="display:block" src="${image(mockup)}"></div>
      <div><div style="height:${label}px;display:flex;align-items:center;padding:0 8px;white-space:nowrap;overflow:hidden">App · ${title}</div><img style="display:block" src="${image(app)}"></div>
    </div></body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
  const buffer = await page.screenshot({ fullPage: true });
  await context.close();
  return buffer;
}

function indexHtml(entries) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sections = scenes.map((scene) => {
    const rows = entries.filter((entry) => entry.scene === scene).map((entry) => `
      <figure id="${escape(entry.file.replace(/\.png$/, ""))}">
        <figcaption>${escape(`${entry.width}px · ${entry.theme} · ${entry.density}`)}${entry.note ? ` <span class="note">${escape(entry.note)}</span>` : ""}</figcaption>
        <a href="${escape(entry.file)}"><img loading="lazy" src="${escape(entry.file)}" alt="${escape(`Mockup and app, ${SCENES[scene].caption}, ${entry.width}px, ${entry.theme}, ${entry.density}`)}"></a>
      </figure>`).join("");
    return `<section id="${scene}"><h2>${escape(SCENES[scene].caption)}</h2>${rows}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mockup comparison</title>
<style>body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#f4f4f6;color:#1a1a1f}h1{font-size:20px}h2{font-size:16px;margin:32px 0 8px}figure{margin:0 0 24px}figcaption{margin:0 0 6px;font-weight:600}.note{color:#b42318;font-weight:400}img{display:block;max-width:100%;height:auto;border:1px solid #c8c8d0}nav a{margin-right:12px}</style></head>
<body><h1>Mockup (left) and app (right)</h1><nav>${scenes.map((scene) => `<a href="#${scene}">${escape(SCENES[scene].caption)}</a>`).join("")}</nav>
${sections}
</body></html>`;
}

const parent = await mkdtemp(path.join(os.tmpdir(), "prism-mockup-compare-"));
const appDirectory = path.join(parent, "app");
await mkdir(appDirectory, { mode: 0o700 });
const browser = await playwright.chromium.launch();
let held = null;
const entries = [];
try {
  const projectRoot = path.join(parent, "demo");
  execFileSync(process.execPath, [path.join(ROOT, "scripts/review-demo/seed.mjs"), projectRoot], { stdio: "ignore" });
  const { startStandaloneReview } = await import(path.join(ROOT, "dist/server/review/review-server-pool.mjs"));
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: appDirectory, PLUGIN_DATA: path.join(parent, "demo-data") };
  delete env.PRISM_REVIEW_APP;
  const review = await startStandaloneReview({ projectRoot, env, openBrowser: async () => false });
  held = review.held;
  const project = { url: new URL(review.url) };
  project.url.search = "";

  // The review app stores one theme and density for every page it serves, and shares its open page between browsers, so the combinations run one after another.
  const jobs = densities.flatMap((density) => scenes.flatMap((scene) => widths.flatMap((width) => themes.map((theme) => ({ scene, width, theme, density })))));
  for (const job of jobs) {
    const stored = await fetch(new URL("api/preferences", project.url), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: job.theme, density: job.density }) });
    if (!stored.ok) throw new Error(`The review app did not store the ${job.theme} theme and ${job.density} density (${stored.status}).`);
    const [mockup, app] = await Promise.all([shootMockup(browser, job), shootApp(browser, project, job)]);
    const file = `${job.scene}-${job.width}-${job.theme}-${job.density}.png`;
    const title = `${SCENES[job.scene].caption} · ${job.width}px · ${job.theme} · ${job.density}`;
    await writeFile(path.join(out, file), await compose(browser, { mockup, app: app.buffer, width: job.width, title }));
    entries.push({ ...job, file, note: app.note });
    process.stdout.write(`${file}${app.note ? `  (${app.note})` : ""}\n`);
  }
  const order = (entry) => [scenes.indexOf(entry.scene), widths.indexOf(entry.width), themes.indexOf(entry.theme), densities.indexOf(entry.density)];
  entries.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    const at = x.findIndex((value, index) => value !== y[index]);
    return at === -1 ? 0 : x[at] - y[at];
  });
  await writeFile(path.join(out, "index.html"), indexHtml(entries));
  process.stdout.write(`${entries.length} pairs in ${out}; open index.html to see them.\n`);
} finally {
  await browser.close();
  await held?.close?.();
  try {
    const discovery = JSON.parse(await readFile(path.join(appDirectory, "review-app.json"), "utf8"));
    process.kill(discovery.pid);
  } catch {
  }
  await rm(parent, { recursive: true, force: true });
}
