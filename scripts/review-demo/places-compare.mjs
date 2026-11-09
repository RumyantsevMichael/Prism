// Compare the demo review app with the approved places mockup, scene by scene, and fail on any difference in structure, geometry, or design values.
// Each scene of the mockup is rendered in a window of the scene's width, the demo app is put into the same state at the same width and theme, and both are read into an outline that the comparison holds side by side.
// Usage: node scripts/review-demo/places-compare.mjs --out <directory> [--scenes work,attention,...] [--widths 1440,820,390] [--themes light,dark] [--parts rail,head,sidebar,topbar,trail,geometry,tokens] [--mockup <file>] [--app-mockup <file>]
// The output folder holds, per scene, width, and theme, `<scene>-<width>-<theme>.png` with the mockup on the left and the app on the right, `<scene>-<width>-<theme>.json` with both outlines and their differences, a `report.json`, and an `index.html` that shows each pair with its differences.
// It exits 0 when no pair differs, 1 when one does, and 2 when it cannot run.
// Playwright is not a dependency of this repository; the comparison uses an installed copy, local or global.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./project.mjs";
import { loadPlaywright, THEMES } from "./layout-audit.mjs";
import { frameWindow } from "./mockup-compare.mjs";

const HEIGHT = 900;
const DENSITY = "compact";
const WIDTHS = [1440, 820, 390];
const PARTS = ["rail", "head", "sidebar", "topbar", "trail", "geometry", "tokens"];
const SLICE = "slice:retry-hardening/timeout-retries";

// Each scene names its frame in the mockup, the widths it is drawn at, and how the demo app reaches the same state.
// `before` is a page opened first, `ref` the page the scene shows, `place` the place made current on the rail, and `then` what the scene does after that.
const SCENES = {
  work: { caption: "Work: a slice of Harden request retries", widths: WIDTHS, ref: SLICE, place: "Work" },
  attention: { caption: "Attention", widths: WIDTHS, ref: "attention", place: "Attention" },
  "attention-filtered": { caption: "Attention filtered to review findings", widths: WIDTHS, ref: "attention:findings", place: "Attention" },
  knowledge: { caption: "Knowledge: Touched by my work after a slice", widths: WIDTHS, before: SLICE, ref: "knowledge:touched", place: "Knowledge" },
  history: { caption: "History: a superseded initiative", widths: WIDTHS, ref: "initiative:csv-exports", place: "History" },
  roadmap: { caption: "Roadmap", widths: WIDTHS, ref: "roadmap", place: "Roadmap" },
  collapsed: { caption: "Work with the sidebar hidden", widths: WIDTHS, ref: SLICE, place: "Work", then: "collapse" },
  "drawer-tablet": { caption: "Tablet width: the drawer open", widths: [820], ref: SLICE, place: "Work", then: "drawer" },
  "drawer-phone": { caption: "Phone width: the drawer open", widths: [390], ref: SLICE, place: "Work", then: "drawer" }
};

// Where each side keeps the containers the outline measures; everything inside them is read by role, name, and attribute.
// The rail is the `nav` named Places, the place head is the sidebar's level 2 heading followed by its subtitle, and groups start at the sidebar's level 3 headings.
const MOCKUP_SIDE = { marksFixed: true, topbar: ".topbar", sidebar: "nav.sidebar", row: ".tree-item", rowLabel: ".label", tabs: ".doctabs", pagebar: ".pagebar", trail: "nav.crumbs", main: ".island.main" };
const APP_SIDE = { root: "html", marksFixed: false, topbar: "#topbar", sidebar: "#sidebar", row: "prism-tree-item", rowLabel: ".prism-tree-label", tabs: "#open-tabs", pagebar: "#page-bar", trail: "prism-breadcrumbs", main: "#main" };

function fail(message) {
  process.stderr.write(`places-compare: ${message}\n`);
  process.exit(2);
}

/** Reads one side into its outline. It runs in the page, so it uses nothing from this module. */
export function outline(side) {
  const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const visible = (element) => {
    if (!element) return false;
    for (let node = element; node; node = parentOf(node)) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (node.hasAttribute?.("hidden")) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Every element below a root in document order, through open shadow roots.
  const deep = (root) => {
    const found = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        found.push(child);
        if (child.shadowRoot) visit(child.shadowRoot);
        visit(child);
      }
    };
    if (root) visit(root);
    return found;
  };
  const deepAll = (root, selector) => deep(root).filter((element) => element.matches(selector));
  const firstVisible = (root, selector) => deepAll(root, selector).find(visible) ?? null;
  const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const nameOf = (element) => (element.getAttribute("aria-label") || element.getAttribute("label") || element.getAttribute("title") || text(element)).trim();
  const placeName = (element) => nameOf(element).split(",")[0].trim();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "rgba(0, 0, 0, 0)";
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
  };
  // The color an element paints: its own background, or, when that is clear, the background of the control its shadow root draws.
  const background = (element) => {
    if (!element) return null;
    const own = rgba(getComputedStyle(element).backgroundColor);
    if (!own.endsWith(", 0)") || !element.shadowRoot) return own;
    const control = deep(element.shadowRoot).find((node) => visible(node) && !rgba(getComputedStyle(node).backgroundColor).endsWith(", 0)"));
    return control ? rgba(getComputedStyle(control).backgroundColor) : own;
  };
  const round = (value) => Math.round(value * 10) / 10;
  const root = document.querySelector(side.root);
  const origin = root.getBoundingClientRect();
  const box = (element) => (visible(element) ? element.getBoundingClientRect() : null);
  const left = (element) => { const b = box(element); return b ? round(b.left - origin.left) : null; };
  const width = (element) => { const b = box(element); return b ? round(b.width) : null; };
  const height = (element) => { const b = box(element); return b ? round(b.height) : null; };
  const bottom = (element) => { const b = box(element); return b ? round(b.bottom - origin.top) : null; };
  const middle = (element) => { const b = box(element); return b ? round(b.top + b.height / 2 - origin.top) : null; };
  const controls = "a, button, prism-button, [role=button]";
  const isCurrent = (element) => element.getAttribute("aria-current") === "page" || element.getAttribute("aria-pressed") === "true" || element.hasAttribute("pressed") || Boolean(element.shadowRoot && deep(element.shadowRoot).some((node) => node.getAttribute("aria-pressed") === "true"));
  const hasCount = (element) => deepAll(element, ".rail-badge, .badge, .count, prism-badge").some((badge) => visible(badge) && text(badge) !== "");
  const sidebarButtons = [...root.querySelectorAll(controls)].filter((element) => /^(Collapse|Expand) the sidebar/.test(nameOf(element)));
  const sidebarButton = sidebarButtons.find(visible) ?? null;

  // The rail: the visible `nav` named Places, its place entries in order, the current one, and the Attention entry's count.
  const rails = deepAll(root, 'nav[aria-label="Places"]');
  const rail = rails.find(visible) ?? null;
  const entries = rail ? [...rail.querySelectorAll(controls)].filter((element) => !sidebarButtons.includes(element) && !element.parentElement.closest(controls)) : [];
  const current = entries.find(isCurrent) ?? null;
  const attention = entries.find((element) => placeName(element) === "Attention");

  // The sidebar: the visible one, its head, and its groups, each from a level 3 heading to the next.
  const sidebar = [...document.querySelectorAll(side.sidebar)].filter((element) => root.contains(element)).find(visible) ?? null;
  const title = sidebar ? firstVisible(sidebar, 'h2, [role=heading][aria-level="2"]') : null;
  const subtitle = title?.nextElementSibling ?? null;
  const rowLabel = (row) => text(row.querySelector(side.rowLabel)) || row.getAttribute("label") || text(row);
  const kindOf = (element) => {
    const names = element.classList;
    if (names.contains("twisty") || names.contains("prism-tree-twisty")) return "twisty";
    if (names.contains("label") || names.contains("prism-tree-label")) return "label";
    if (names.contains("flag")) return "flag";
    if (names.contains("avatar") || names.contains("stack") || element.matches("prism-avatar, prism-claim")) return "holder";
    if (names.contains("meta") || names.contains("count") || element.matches("prism-badge") || /^[\d/\s]+$/.test(text(element)) && text(element) !== "") return "count";
    return text(element) ? "flag" : "glyph";
  };
  // A row's parts in order; a kit row keeps its leading glyphs in a start slot and its trailing ones in an end slot.
  const partsOf = (row) => {
    const kinds = [];
    const drawn = row.querySelector(":scope > .prism-tree-row") ?? row;
    for (const child of drawn.children) {
      if (!visible(child)) continue;
      if (child.classList.contains("prism-tree-start")) {
        if ([...child.children].some(visible)) kinds.push("glyph");
      } else if (child.classList.contains("prism-tree-end")) {
        for (const end of child.children) if (visible(end)) kinds.push(kindOf(end));
      } else kinds.push(kindOf(child));
    }
    return kinds;
  };
  const groups = [];
  let group = null;
  let rowElement = null;
  for (const element of sidebar ? deepAll(sidebar, `h3, [role=heading][aria-level="3"], ${side.row}`) : []) {
    if (!visible(element)) continue;
    if (!element.matches(side.row)) {
      const label = [...element.childNodes].filter((node) => !(node.nodeType === 1 && node.matches(".count, .badge, prism-badge"))).map((node) => node.textContent).join(" ").replace(/\s+/g, " ").trim();
      group = { heading: label, count: hasCount(element), optional: element.hasAttribute("data-optional"), fixed: [], first: null };
      groups.push(group);
      continue;
    }
    if (!group) {
      group = { heading: "", count: false, optional: false, fixed: [], first: null };
      groups.push(group);
    }
    if (!group.first) group.first = partsOf(element);
    // The mockup marks the rows whose labels are fixed; the app marks none, so every row of its group is read and stands against the mockup's fixed rows.
    if (!side.marksFixed || element.hasAttribute("data-fixed")) group.fixed.push(rowLabel(element));
    rowElement ??= element.querySelector(":scope > .prism-tree-row") ?? element;
  }
  const selectedRow = sidebar ? deepAll(sidebar, side.row).find((row) => visible(row) && (row.getAttribute("aria-current") === "page" || row.hasAttribute("selected") || row.getAttribute("aria-selected") === "true")) : null;
  const selectedPaint = selectedRow ? (selectedRow.querySelector(":scope > .prism-tree-row") ?? selectedRow) : null;

  const topbar = root.querySelector(side.topbar);
  const topControls = topbar ? [...topbar.querySelectorAll(controls)].filter((element) => !element.parentElement.closest(controls)) : [];
  const navigation = topControls.find((element) => visible(element) && /navigation/i.test(nameOf(element))) ?? null;
  const bell = topControls.find((element) => visible(element) && /^Attention/.test(nameOf(element))) ?? null;
  const tabs = root.querySelector(side.tabs);
  const selectedTab = tabs ? firstVisible(tabs, '[role=tab][aria-selected="true"]') : null;
  const pagebar = [...root.querySelectorAll(side.pagebar)].find(visible) ?? null;
  const trail = pagebar ? deepAll(pagebar, side.trail).find(visible) ?? null : null;
  const crumb = trail ? firstVisible(trail, "a") : null;
  const main = [...root.querySelectorAll(side.main)].find(visible) ?? null;
  const separator = rail ? firstVisible(rail, '[role="separator"]') : null;
  const icon = current ? firstVisible(current, "svg, prism-icon") : null;

  return {
    rail: { visible: visible(rail), entries: entries.map(placeName), current: current ? placeName(current) : null, count: attention ? hasCount(attention) : false },
    head: { title: title ? text(title) : null, subtitle: subtitle ? text(subtitle) : null },
    sidebar: { groups: groups.map(({ heading, count, optional, fixed, first }) => ({ heading, count, ...(optional ? { optional } : {}), fixed, first })) },
    topbar: { navigation: Boolean(navigation), bell: Boolean(bell), bellCount: bell ? hasCount(bell) : false, sidebarButton: Boolean(sidebarButton) },
    trail: crumb ? text(crumb) : null,
    geometry: {
      railWidth: width(rail),
      railButtonWidth: width(entries.find(visible)),
      railButtonHeight: height(entries.find(visible)),
      railHeadBottom: bottom(separator),
      pagebarBottom: bottom(pagebar),
      sidebarButtonCenter: middle(sidebarButton),
      placeTitleCenter: middle(title),
      selectedTabCenter: middle(selectedTab),
      placeSubtitleCenter: middle(subtitle),
      trailCenter: middle(trail),
      sidebarLeft: left(sidebar),
      sidebarWidth: width(sidebar),
      placeTitleSize: title && visible(title) ? round(parseFloat(getComputedStyle(title).fontSize)) : null,
      rowHeight: height(rowElement),
      mainLeft: left(main)
    },
    tokens: {
      rail: visible(rail) ? background(rail) : null,
      sidebar: sidebar ? background(sidebar) : null,
      currentRail: current && visible(current) ? background(current) : null,
      selectedRow: selectedPaint ? background(selectedPaint) : null,
      currentRailIcon: icon ? rgba(getComputedStyle(icon).color) : null
    }
  };
}

const show = (value) => JSON.stringify(value);

/** The differences between the mockup's outline and the app's, one line each, for the parts asked for. */
export function compareOutlines(mockup, app, { scene, width, theme, parts = PARTS }) {
  const lines = [];
  const differ = (part, mockupValue, appValue) => lines.push(`${scene} ${width} ${theme} ${part}: mockup ${mockupValue}, app ${appValue}`);
  for (const part of ["rail", "head", "topbar"]) {
    if (!parts.includes(part)) continue;
    for (const key of Object.keys(mockup[part])) {
      if (show(mockup[part][key]) !== show(app[part][key])) differ(part, `${key} ${show(mockup[part][key])}`, `${key} ${show(app[part][key])}`);
    }
  }
  if (parts.includes("trail") && mockup.trail !== app.trail) differ("trail", show(mockup.trail), show(app.trail));
  if (parts.includes("sidebar")) {
    // Each app group takes the next mockup group with its heading, past optional ones; one that matches none stands against the group the mockup expects there.
    const expected = mockup.sidebar.groups;
    const pairs = [];
    let at = 0;
    let ordered = true;
    for (const group of app.sidebar.groups) {
      let match = -1;
      for (let index = at; index < expected.length; index += 1) {
        if (expected[index].heading === group.heading) {
          match = index;
          break;
        }
        if (!expected[index].optional) break;
      }
      if (match === -1) {
        ordered = false;
        if (at < expected.length) pairs.push([expected[at], group]);
        at += 1;
      } else {
        pairs.push([expected[match], group]);
        at = match + 1;
      }
    }
    if (expected.slice(at).some((group) => !group.optional)) ordered = false;
    const headings = (groups) => show(groups.map((group) => group.heading));
    if (!ordered) differ("sidebar", `groups ${headings(expected)}`, `groups ${headings(app.sidebar.groups)}`);
    for (const [want, have] of pairs) {
      const named = (group) => (group.heading ? `"${group.heading}"` : "the first group");
      if (want.count !== have.count) differ("sidebar", `${named(want)} count ${want.count}`, `${named(have)} count ${have.count}`);
      if (want.fixed.length && show(want.fixed) !== show(have.fixed)) differ("sidebar", `${named(want)} fixed rows ${show(want.fixed)}`, `${named(have)} rows ${show(have.fixed)}`);
      if (show(want.first) !== show(have.first)) differ("sidebar", `${named(want)} first row ${show(want.first)}`, `${named(have)} first row ${show(have.first)}`);
    }
  }
  if (parts.includes("geometry")) {
    for (const key of Object.keys(mockup.geometry)) {
      const [a, b] = [mockup.geometry[key], app.geometry[key]];
      if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 2)) differ("geometry", `${key} ${show(a)}`, `${key} ${show(b)}`);
    }
  }
  if (parts.includes("tokens")) {
    for (const key of Object.keys(mockup.tokens)) {
      if (mockup.tokens[key] !== app.tokens[key]) differ("tokens", `${key} ${show(mockup.tokens[key])}`, `${key} ${show(app.tokens[key])}`);
    }
  }
  return lines;
}

async function readMockup(browser, file, { scene, width, theme }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const frame = await frameWindow(page, { file, scene, theme, density: DENSITY, height: HEIGHT });
    if (await frame.count() === 0) throw new Error(`The mockup ${file} has no scene ${scene}.`);
    const shape = await page.evaluate(outline, { ...MOCKUP_SIDE, root: `#${scene} > .app` });
    return { buffer: await frame.screenshot({ animations: "disabled" }), outline: shape, note: "" };
  } finally {
    await context.close();
  }
}

// Makes a place current through its rail button when the rail shows and the place is not current yet.
async function choosePlace(page, place) {
  const button = page.locator('nav[aria-label="Places"]').locator("a, button, prism-button").filter({ visible: true });
  const count = await button.count();
  for (let index = 0; index < count; index += 1) {
    const entry = button.nth(index);
    const name = (await entry.getAttribute("aria-label")) || (await entry.getAttribute("label")) || (await entry.getAttribute("title")) || (await entry.innerText());
    if (name.split(",")[0].trim() !== place) continue;
    const current = await entry.evaluate((element) => element.getAttribute("aria-current") === "page" || element.getAttribute("aria-pressed") === "true" || element.hasAttribute("pressed"));
    if (!current) await entry.click();
    return "";
  }
  return `the rail has no ${place} button`;
}

async function readApp(browser, project, { scene, width, theme }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", isMobile: width < 720, hasTouch: width < 720 });
  const page = await context.newPage();
  const notes = [];
  page.on("pageerror", (error) => notes.push(`page error: ${error.message}`));
  const visit = async (ref) => {
    const url = new URL("review", project.url);
    url.searchParams.set("artifact", ref);
    await page.goto(url.href);
    await page.waitForSelector('#artifact[aria-busy="false"]', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  };
  const definition = SCENES[scene];
  let collapsed = false;
  try {
    if (definition.before) await visit(definition.before);
    await visit(definition.ref);
    const wide = await page.locator('nav[aria-label="Places"]').filter({ visible: true }).count() > 0;
    if (wide) {
      const missing = await choosePlace(page, definition.place);
      if (missing) notes.push(missing);
      await page.waitForTimeout(400);
    }
    if (definition.then === "collapse") {
      const toggle = page.locator("#sidebar-toggle");
      if (await toggle.isVisible()) {
        await toggle.click();
        collapsed = true;
      }
    }
    if (definition.then === "drawer") {
      const navigation = page.locator("#nav-button");
      if (await navigation.isVisible()) await navigation.click();
      else notes.push("the Navigation button is not visible");
    }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(700);
  } catch (error) {
    notes.push(`could not open the scene's state: ${error.message.split("\n")[0]}`);
  }
  const shape = await page.evaluate(outline, APP_SIDE);
  const buffer = await page.screenshot({ animations: "disabled" });
  // The app stores a hidden sidebar, so the scene shows it again for the scenes after it.
  if (collapsed) await page.locator("#sidebar-toggle").click().catch(() => {});
  await page.waitForTimeout(200);
  await context.close();
  return { buffer, outline: shape, note: notes.join("; ") };
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The two shots sit side by side under a label each, with the differences below them, drawn by the browser itself so the comparison needs no image library.
async function compose(browser, { mockup, app, width, title, differences, note }) {
  const gap = 24;
  const context = await browser.newContext({ viewport: { width: width * 2 + gap, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const image = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
  const lines = differences.length ? differences.map((line) => `<li>${escape(line.replace(/^\S+ \S+ \S+ /, ""))}</li>`).join("") : "<li>No difference that the outline measures.</li>";
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#3d4250;font:13px/1.4 system-ui,sans-serif;color:#fff">
    <div style="padding:8px 10px;font-weight:600;font-size:14px;overflow-wrap:anywhere">${escape(title)}</div>
    <div style="display:grid;grid-template-columns:${width}px ${width}px;gap:${gap}px;align-items:start">
      <div><div style="padding:4px 8px;background:#2563eb;font-weight:600">Mockup</div><img style="display:block" src="${image(mockup)}"></div>
      <div><div style="padding:4px 8px;background:#9333ea;font-weight:600">App</div><img style="display:block" src="${image(app)}"></div>
    </div>
    <div style="padding:8px 10px 12px"><div style="font-weight:600">${differences.length} difference${differences.length === 1 ? "" : "s"}${note ? ` · ${escape(note)}` : ""}</div><ul style="margin:4px 0 0;padding-left:18px;overflow-wrap:anywhere">${lines}</ul></div>
    </body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
  const buffer = await page.screenshot({ fullPage: true });
  await context.close();
  return buffer;
}

function indexHtml(scenes, pairs) {
  const sections = scenes.map((scene) => {
    const rows = pairs.filter((pair) => pair.scene === scene).map((pair) => `
      <figure id="${escape(pair.png.replace(/\.png$/, ""))}">
        <figcaption>${escape(`${pair.width}px · ${pair.theme}`)} · <span class="${pair.differences.length ? "bad" : "good"}">${pair.differences.length ? `${pair.differences.length} differences` : "no differences"}</span>${pair.note ? ` <span class="note">${escape(pair.note)}</span>` : ""}</figcaption>
        ${pair.differences.length ? `<ul>${pair.differences.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>` : ""}
        <a href="${escape(pair.png)}"><img loading="lazy" src="${escape(pair.png)}" alt="${escape(`Mockup and app, ${SCENES[scene].caption}, ${pair.width}px, ${pair.theme}`)}"></a>
      </figure>`).join("");
    return `<section id="${scene}"><h2>${escape(SCENES[scene].caption)}</h2>${rows}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Places comparison</title>
<style>body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#f4f4f6;color:#1a1a1f}h1{font-size:20px}h2{font-size:16px;margin:32px 0 8px}figure{margin:0 0 24px}figcaption{margin:0 0 6px;font-weight:600}ul{margin:0 0 8px;padding-left:20px;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.bad,.note{color:#b42318}.good{color:#067647}img{display:block;max-width:100%;height:auto;border:1px solid #c8c8d0}nav a{margin-right:12px}</style></head>
<body><h1>Places mockup (left) and app (right)</h1><nav>${scenes.map((scene) => `<a href="#${scene}">${escape(SCENES[scene].caption)}</a>`).join("")}</nav>
${sections}
</body></html>`;
}

async function startDemo(parent) {
  const appDirectory = path.join(parent, "app");
  await mkdir(appDirectory, { mode: 0o700 });
  const projectRoot = path.join(parent, "demo");
  execFileSync(process.execPath, [path.join(ROOT, "scripts/review-demo/seed.mjs"), projectRoot], { stdio: "ignore" });
  const { startStandaloneReview } = await import(path.join(ROOT, "dist/server/review/review-server-pool.mjs"));
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: appDirectory, PLUGIN_DATA: path.join(parent, "demo-data") };
  delete env.PRISM_REVIEW_APP;
  const review = await startStandaloneReview({ projectRoot, env, openBrowser: async () => false });
  const url = new URL(review.url);
  url.search = "";
  return {
    url,
    async close() {
      await review.held?.close?.();
      try {
        const discovery = JSON.parse(await readFile(path.join(appDirectory, "review-app.json"), "utf8"));
        process.kill(discovery.pid);
      } catch {
      }
    }
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: "string" },
        scenes: { type: "string", default: Object.keys(SCENES).join(",") },
        widths: { type: "string", default: WIDTHS.join(",") },
        themes: { type: "string", default: THEMES.join(",") },
        parts: { type: "string", default: PARTS.join(",") },
        mockup: { type: "string", default: path.join(ROOT, "docs/plans/review-app-places/mockup/mockup.html") },
        "app-mockup": { type: "string" }
      }
    }));
  } catch (error) {
    fail(error.message);
  }
  if (!values.out) fail("pass --out <directory>.");
  const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const scenes = list(values.scenes);
  const widths = list(values.widths).map(Number);
  const themes = list(values.themes);
  const parts = list(values.parts);
  for (const name of scenes) if (!SCENES[name]) fail(`unknown scene ${name}; use ${Object.keys(SCENES).join(", ")}.`);
  for (const width of widths) if (!WIDTHS.includes(width)) fail(`unknown width ${width}; use ${WIDTHS.join(", ")}.`);
  for (const name of themes) if (!THEMES.includes(name)) fail(`unknown theme ${name}; use ${THEMES.join(", ")}.`);
  for (const name of parts) if (!PARTS.includes(name)) fail(`unknown part ${name}; use ${PARTS.join(", ")}.`);
  const mockupFile = path.resolve(values.mockup);
  const appMockup = values["app-mockup"] ? path.resolve(values["app-mockup"]) : null;
  for (const file of [mockupFile, appMockup].filter(Boolean)) {
    try {
      await readFile(file, "utf8");
    } catch (error) {
      fail(`cannot read the mockup ${file}: ${error.message}`);
    }
  }
  const playwright = loadPlaywright();
  if (!playwright) fail("Playwright is not installed. Install it with `npm install -g playwright` and `npx playwright install chromium`.");
  const out = path.resolve(values.out);
  await mkdir(out, { recursive: true });

  const parent = await mkdtemp(path.join(os.tmpdir(), "prism-places-compare-"));
  const browser = await playwright.chromium.launch();
  let demo = null;
  let failure = null;
  const pairs = [];
  try {
    if (!appMockup) demo = await startDemo(parent);
    const jobs = scenes.flatMap((scene) => widths.filter((width) => SCENES[scene].widths.includes(width)).flatMap((width) => themes.map((theme) => ({ scene, width, theme }))));
    for (const job of jobs) {
      if (demo) {
        // The review app stores one theme and density for every page it serves, so the combinations run one after another.
        const stored = await fetch(new URL("api/preferences", demo.url), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: job.theme, density: DENSITY }) });
        if (!stored.ok) throw new Error(`The review app did not store the ${job.theme} theme and ${DENSITY} density (${stored.status}).`);
      }
      const mockup = await readMockup(browser, mockupFile, job);
      const app = appMockup ? await readMockup(browser, appMockup, job) : await readApp(browser, demo, job);
      const differences = compareOutlines(mockup.outline, app.outline, { ...job, parts });
      const name = `${job.scene}-${job.width}-${job.theme}`;
      const title = `${SCENES[job.scene].caption} · ${job.width}px · ${job.theme} · ${DENSITY}`;
      await writeFile(path.join(out, `${name}.png`), await compose(browser, { mockup: mockup.buffer, app: app.buffer, width: job.width, title, differences, note: app.note }));
      await writeFile(path.join(out, `${name}.json`), `${JSON.stringify({ ...job, mockup: mockup.outline, app: app.outline, differences, ...(app.note ? { note: app.note } : {}) }, null, 2)}\n`);
      pairs.push({ ...job, png: `${name}.png`, differences, note: app.note });
      process.stdout.write(`${name}.png: ${differences.length ? `${differences.length} difference${differences.length === 1 ? "" : "s"}` : "no differences"}${app.note ? `  (${app.note})` : ""}\n`);
      for (const line of differences) process.stdout.write(`  ${line}\n`);
    }
    await writeFile(path.join(out, "report.json"), `${JSON.stringify({ pairs: pairs.map(({ scene, width, theme, png, differences }) => ({ scene, width, theme, png, differences })) }, null, 2)}\n`);
    await writeFile(path.join(out, "index.html"), indexHtml(scenes, pairs));
  } catch (error) {
    failure = error.message;
  } finally {
    await browser.close();
    await demo?.close();
    await rm(parent, { recursive: true, force: true });
  }
  if (failure) fail(failure);
  const differing = pairs.filter((pair) => pair.differences.length).length;
  process.stdout.write(`${pairs.length} pairs in ${out}, ${differing} with differences; open index.html to see them.\n`);
  process.exit(differing ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
