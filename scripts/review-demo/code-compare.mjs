// A real Claude Code or Codex stays off PATH, since the review app this comparison starts could otherwise find one.
import "../hostless-path.mjs";
// Compare the Code place with its approved mockups, scene by scene, and fail on any difference in what the two show or in the boxes of their panes.
// The comparison builds its own Code demo workspace from the Code place's test fixture, since only a store that registers repositories with code remotes has a Code place.
// For each scene it injects the mockup markup into that workspace's review app, as the approved pictures were drawn, and puts the app's own Code page into the same state, at the same window width and theme.
// Usage: node scripts/review-demo/code-compare.mjs --out <directory> [--scenes all,work-picked,tree,file,drawer] [--widths 1440,390] [--themes light,dark] [--mockups <folder>]
// The output folder holds, per scene, width, and theme, `<scene>-<width>-<theme>.png` with the mockup on the left and the app on the right, `<scene>-<width>-<theme>.json` with both outlines and their differences, a `report.json`, and an `index.html` that shows each pair beside its approved picture.
// It exits 0 when no pair differs, 1 when one does, and 2 when it cannot run.
// Playwright is not a dependency of this repository; the comparison uses an installed copy, local or global.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./project.mjs";
import { CHROMIUM_OPTIONS, loadPlaywright, THEMES } from "./layout-audit.mjs";

const SCENE_NAMES = ["all", "work-picked", "tree", "file", "drawer"];
const WIDTHS = [1440, 390];
const DEFAULT_MOCKUPS = path.join(ROOT, "scripts/review-demo/mockups/code-place");
// The sidebar rows each scene chooses in the app, by the Code address the mockup's picked row stands for.
const ADDRESSES = { "": "code", "s:deadline": "code:work/retries/deadline" };
// The folders that the mockup's files tree shows open, which the app's tree opens in this order before the file is chosen.
const OPEN_FOLDERS = ["api", "api/docs", "api/src", "api/src/http", "api/src/reports", "api/src/retry", "web", "web/packages"];
const OPEN_FILE = "api/src/retry/strategy.ts";
const TREE_LABEL = "Files of every repository";
const WRITE_SESSION_KEY = "prism-write-session";

// Where each side keeps the parts the outline reads; everything inside them is read by element, attribute, and text.
const MOCKUP_SIDE = { treePane: ".cv-tree-pane", filePane: ".cv-view", scope: ".cv-scope", head: ".cv-file-head", path: ".cv-path", notes: ".cv-overlap", back: ".cv-back" };
const APP_SIDE = { treePane: ".code-place-files", filePane: "section.code-place-file", scope: ".code-place-scope", head: ".code-place-head", path: ".code-place-path", notes: 'prism-inline-note[tone="warning"]', back: "[data-code-back]" };

function fail(message) {
  process.stderr.write(`code-compare: ${message}\n`);
  process.exit(2);
}

/** Reads one side into its outline. It runs in the page, so it uses nothing from this module. */
export function outline(side) {
  const TREE = "Files of every repository";
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!element) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (node.hasAttribute("hidden")) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const shown = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
  const firstShown = (root, selector) => shown(root, selector)[0] ?? null;
  // A chip's text is its name and then its meta slot's text, which the kit draws apart.
  const chipText = (chip) => {
    const meta = text(chip.querySelector('[slot="meta"]'));
    const whole = text(chip);
    const name = meta && whole.endsWith(meta) ? whole.slice(0, whole.length - meta.length).trim() : whole;
    return { name, meta };
  };
  const badge = (chip) => Object.values(chipText(chip)).filter(Boolean).join(" ");
  const avatar = (node) => `${node.getAttribute("kind")}:${node.getAttribute("name")}`;
  const glyph = (node) => {
    if (!node) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "prism-status") return `status ${node.getAttribute("value")} ${node.getAttribute("label")}`;
    if (tag === "prism-phase") return `phase ${node.getAttribute("phase")} ${node.getAttribute("label")}`;
    if (tag === "prism-icon") return `icon ${node.getAttribute("name")}`;
    return tag;
  };
  // A row of a kit tree: its depth, the glyph in its start slot, its label, and what its end shows.
  const row = (item) => {
    let depth = 0;
    for (let node = item; node; node = node.parentElement?.closest("prism-tree-item")) depth += 1;
    const line = item.querySelector(":scope > .prism-tree-row");
    const start = line?.querySelector(".prism-tree-start > *") ?? null;
    const end = line?.querySelector(".prism-tree-end") ?? null;
    const meta = text(line?.querySelector(".prism-tree-meta")) || text(end?.querySelector(".nav-meta"));
    return {
      depth,
      glyph: glyph(start),
      label: item.getAttribute("label"),
      selected: item.hasAttribute("selected"),
      flags: [...(end?.querySelectorAll(".prism-tree-flag") ?? [])].map(text),
      badges: [...(end?.querySelectorAll("prism-chip") ?? [])].map(badge),
      avatars: [...(end?.querySelectorAll("prism-avatar") ?? [])].map(avatar),
      count: meta || null
    };
  };
  const box = (element) => {
    if (!visible(element)) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  };

  const sidebarRoot = document.getElementById("sidebar");
  const sidebarShown = visible(sidebarRoot);
  const sidebarTrees = sidebarShown ? shown(sidebarRoot, "prism-tree").filter((tree) => tree.getAttribute("label") !== TREE) : [];
  const sidebar = {
    groups: sidebarShown ? shown(sidebarRoot, "h3.prism-group-heading").map((heading) => ({ heading: text(heading.querySelector("span:not(.prism-group-count)")), count: text(heading.querySelector(".prism-group-count")) })) : [],
    rows: sidebarTrees.flatMap((tree) => shown(tree, "prism-tree-item").map(row)),
    quiet: sidebarShown ? (firstShown(sidebarRoot, ".prism-foot-note") ? text(firstShown(sidebarRoot, ".prism-foot-note")) : null) : null
  };

  const main = document.getElementById("artifact");
  const segmented = firstShown(main, 'prism-segmented[label="Files"]');
  const files = segmented ? { options: [...segmented.querySelectorAll("prism-option")].map(text), choice: segmented.getAttribute("value") } : null;
  const scope = firstShown(main, side.scope);
  const tree = firstShown(main, `prism-tree[label="${TREE}"]`);

  const filePane = firstShown(main, side.filePane);
  const head = filePane ? firstShown(filePane, side.head) : null;
  const group = filePane ? firstShown(filePane, '[aria-label="Versions of this file"]') : null;
  const file = head ? {
    head: { path: text(head.querySelector(side.path)), badges: [...head.querySelectorAll("prism-chip")].map(badge) },
    versions: group ? [...group.querySelectorAll("prism-chip")].map((chip) => {
      const { name: label, meta: counts } = chipText(chip);
      const start = chip.querySelector('[slot="start"]');
      return { label, counts, start: start?.tagName === "PRISM-AVATAR" ? avatar(start) : glyph(start), pressed: chip.getAttribute("pressed") === "true" };
    }) : [],
    notes: shown(filePane, side.notes).map(text),
    difference: [...filePane.querySelectorAll("table.line-diff tr")].filter(visible).map((tr) => {
      const cells = [...tr.cells];
      return { op: (tr.className.match(/diff-(\w+)/) ?? [])[1] ?? "", before: text(cells[0]), after: text(cells[1]), mark: text(cells[2]?.querySelector(".diff-mark")) };
    })
  } : null;
  const back = firstShown(main, side.back);

  return {
    sidebar,
    files,
    scope: scope ? text(scope) : null,
    tree: tree ? shown(tree, "prism-tree-item").map(row) : [],
    file,
    back: back ? text(back) : null,
    geometry: { sidebar: sidebarShown ? box(sidebarRoot) : null, tree: box(firstShown(main, side.treePane)), file: box(filePane) }
  };
}

const show = (value) => JSON.stringify(value);

/** The differences between the mockup's outline and the app's, one line each, as `<scene> <width> <theme>: <difference>`. */
export function compareOutlines(mockup, app, { scene, width, theme }) {
  const lines = [];
  const differ = (what, a, b) => lines.push(`${scene} ${width} ${theme}: ${what}: mockup ${a}, app ${b}`);
  const rowName = (row) => `"${row?.label}"`;
  const list = (what, want, have, name) => {
    for (let index = 0; index < Math.max(want.length, have.length); index += 1) {
      const [a, b] = [want[index], have[index]];
      if (show(a) !== show(b)) differ(`${what} ${index + 1}${name ? ` ${name(a ?? b)}` : ""}`, show(a ?? null), show(b ?? null));
    }
  };
  list("sidebar group", mockup.sidebar.groups, app.sidebar.groups);
  list("sidebar row", mockup.sidebar.rows, app.sidebar.rows, rowName);
  if (mockup.sidebar.quiet !== app.sidebar.quiet) differ("quiet note", show(mockup.sidebar.quiet), show(app.sidebar.quiet));
  if (show(mockup.files) !== show(app.files)) differ("Files control", show(mockup.files), show(app.files));
  if (mockup.scope !== app.scope) differ("scope line", show(mockup.scope), show(app.scope));
  list("tree row", mockup.tree, app.tree, rowName);
  if ((mockup.file === null) !== (app.file === null)) differ("file view", mockup.file ? "shown" : "not shown", app.file ? "shown" : "not shown");
  else if (mockup.file) {
    if (show(mockup.file.head) !== show(app.file.head)) differ("file head", show(mockup.file.head), show(app.file.head));
    list("version chip", mockup.file.versions, app.file.versions, (chip) => `"${chip?.label}"`);
    list("conflict note", mockup.file.notes, app.file.notes);
    list("difference row", mockup.file.difference, app.file.difference);
  }
  if (mockup.back !== app.back) differ("back button", show(mockup.back), show(app.back));
  for (const key of Object.keys(mockup.geometry)) {
    const [a, b] = [mockup.geometry[key], app.geometry[key]];
    const off = a && b && ["x", "y", "width", "height"].some((edge) => Math.abs(a[edge] - b[edge]) > 2);
    if ((a === null) !== (b === null) || off) differ(`${key} box`, show(a), show(b));
  }
  return lines;
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The two shots sit side by side under a label each, with the differences below them, drawn by the browser itself so the comparison needs no image library.
async function compose(browser, { mockup, app, width, height, title, differences }) {
  const gap = 24;
  const context = await browser.newContext({ viewport: { width: width * 2 + gap, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const image = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
  const lines = differences.length ? differences.map((line) => `<li>${escape(line.replace(/^\S+ \S+ \S+: /, ""))}</li>`).join("") : "<li>No difference that the outline measures.</li>";
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#3d4250;font:13px/1.4 system-ui,sans-serif;color:#fff">
    <div style="padding:8px 10px;font-weight:600;font-size:14px;overflow-wrap:anywhere">${escape(title)}</div>
    <div style="display:grid;grid-template-columns:${width}px ${width}px;gap:${gap}px;align-items:start">
      <div><div style="padding:4px 8px;background:#2563eb;font-weight:600">Mockup</div><img style="display:block" src="${image(mockup)}"></div>
      <div><div style="padding:4px 8px;background:#9333ea;font-weight:600">App</div><img style="display:block" src="${image(app)}"></div>
    </div>
    <div style="padding:8px 10px 12px"><div style="font-weight:600">${differences.length} difference${differences.length === 1 ? "" : "s"}</div><ul style="margin:4px 0 0;padding-left:18px;overflow-wrap:anywhere">${lines}</ul></div>
    </body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
  const buffer = await page.screenshot({ fullPage: true });
  await context.close();
  return buffer;
}

function indexHtml(pairs) {
  const rows = pairs.map((pair) => `
    <figure id="${escape(pair.png.replace(/\.png$/, ""))}">
      <figcaption>${escape(`${pair.scene} · ${pair.width}px · ${pair.theme}`)} · <span class="${pair.differences.length ? "bad" : "good"}">${pair.differences.length ? `${pair.differences.length} differences` : "no differences"}</span></figcaption>
      ${pair.differences.length ? `<ul>${pair.differences.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>` : ""}
      <div class="pair"><a href="${escape(pair.png)}"><img loading="lazy" src="${escape(pair.png)}" alt="${escape(`Mockup and app, ${pair.scene}, ${pair.width}px, ${pair.theme}`)}"></a>
      ${pair.approved ? `<a href="${escape(pair.approved)}"><img loading="lazy" src="${escape(pair.approved)}" alt="${escape(`The approved picture of ${pair.scene}, ${pair.width}px, ${pair.theme}`)}"></a>` : ""}</div>
    </figure>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Code place comparison</title>
<style>body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#f4f4f6;color:#1a1a1f}h1{font-size:20px}figure{margin:0 0 24px}figcaption{margin:0 0 6px;font-weight:600}ul{margin:0 0 8px;padding-left:20px;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.bad{color:#b42318}.good{color:#067647}.pair{display:grid;grid-template-columns:2fr 1fr;gap:12px;align-items:start}img{display:block;max-width:100%;height:auto;border:1px solid #c8c8d0}</style></head>
<body><h1>Code place mockup and app, with the approved picture beside them</h1>
${rows}
</body></html>`;
}

// The Code demo workspace: the Code place's test fixture, built in a temporary Git environment, with a context whose cleanups run when the comparison ends.
async function startWorkspace() {
  const fixtures = path.join(ROOT, "test/server/fixtures");
  const { eventually, isolateGit } = await import(pathToFileURL(path.join(fixtures, "workspace-view.mjs")).href);
  const { codePlaceWorkspace } = await import(pathToFileURL(path.join(fixtures, "code-place.mjs")).href);
  const environment = await isolateGit();
  const cleanups = [];
  const context = { after: (cleanup) => cleanups.push(cleanup) };
  const close = async () => {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { }
    }
    await rm(environment, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const built = await codePlaceWorkspace(context);
    await built.ready("place");
    await built.ready("files?scope=all");
    // The review app grants one open per 10-second open lease, and the fixture's verifications may have taken it, so this presents until a present carries a grant.
    const presented = await eventually(async () => {
      const answer = await built.prism.control("present", { method: "POST", body: { open: true, acceptsGrant: true } });
      return answer.json?.writeGrant ? answer : null;
    }, 30000, "a present that carries a write grant");
    return { base: `${built.prism.viewer}/w/${built.id}`, grant: presented.json.writeGrant, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const address = (workspace, ref) => `${workspace.base}/review?artifact=${encodeURIComponent(ref)}`;

async function newPage(browser, job, token) {
  const phone = job.width < 720;
  const context = await browser.newContext({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1, colorScheme: job.theme, reducedMotion: "reduce", isMobile: phone, hasTouch: phone, bypassCSP: true });
  // Every tab writes with the write session that the first tab took from the grant, as the tab Prism opens does.
  if (token) await context.addInitScript(([key, value]) => { try { sessionStorage.setItem(key, value); } catch { } }, [WRITE_SESSION_KEY, token]);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  return { context, page };
}

async function openCode(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tree", { name: TREE_LABEL }).waitFor({ timeout: 30000 });
}

// Takes the write session once from the grant in a presented address's fragment.
async function writeToken(browser, workspace) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900, theme: "light" }, null);
  try {
    await page.goto(`${address(workspace, "code")}#write=${workspace.grant}`);
    return await page.waitForFunction((key) => sessionStorage.getItem(key), WRITE_SESSION_KEY, { timeout: 30000 }).then((handle) => handle.jsonValue());
  } finally {
    await context.close();
  }
}

async function settleShot(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(700);
}

async function readMockup(browser, workspace, token, markup, job, host) {
  const { context, page } = await newPage(browser, job, token);
  try {
    await openCode(page, address(workspace, "code"));
    await page.addStyleTag({ content: `${markup.CSS}#workspace:has(.cv-ide){overflow:hidden} #artifact.cv-host{height:100%}` });
    if (job.drawer) {
      await page.locator("#nav-button").click();
      await page.waitForTimeout(600);
    }
    const nav = markup.sidebar(job.pick ?? "", { host });
    const html = markup.page({ picked: Boolean(job.picked), only: Boolean(job.only), mode: job.mode ?? "both" });
    // The app redraws its sidebar as its answers change, so the markup is put back until it holds through the settling pause.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.evaluate(({ nav, html }) => {
        for (const n of document.querySelectorAll(".nav, #nav")) {
          n.innerHTML = nav;
          n.dataset.codeMockup = "";
        }
        const artifact = document.getElementById("artifact");
        artifact.classList.add("cv-host");
        artifact.innerHTML = html;
      }, { nav, html });
      await settleShot(page);
      const held = await page.evaluate(() => Boolean(document.querySelector("#artifact > .cv-ide")) && [...document.querySelectorAll(".nav, #nav")].every((n) => "codeMockup" in n.dataset && n.querySelector("prism-tree")));
      if (held) break;
    }
    const shape = await page.evaluate(outline, MOCKUP_SIDE);
    return { buffer: await page.screenshot({ animations: "disabled" }), outline: shape, errors: page.errors };
  } finally {
    await context.close();
  }
}

async function readApp(browser, workspace, token, job) {
  const { context, page } = await newPage(browser, job, token);
  try {
    await openCode(page, address(workspace, ADDRESSES[job.pick ?? ""] ?? "code"));
    const tree = page.getByRole("tree", { name: TREE_LABEL });
    const item = (value) => tree.locator(`prism-tree-item[value="${value}"]`).first();
    for (const folder of OPEN_FOLDERS) {
      const row = item(folder);
      if (await row.count() === 0) continue;
      if (await row.getAttribute("aria-expanded") !== "true") await row.locator(":scope > a").first().click();
      await page.waitForFunction((value) => [...document.querySelectorAll("prism-tree-item")].some((node) => node.getAttribute("value") === value && node.hasAttribute("expanded")), folder, { timeout: 20000 });
    }
    await item(OPEN_FILE).locator(":scope > a").first().click();
    await page.getByRole("group", { name: "Versions of this file" }).waitFor({ timeout: 30000 });
    await page.locator("#artifact table.line-diff").first().waitFor({ timeout: 30000 });
    if (job.mode === "tree") {
      await page.locator("[data-code-back]").click();
      await tree.waitFor({ timeout: 20000 });
    }
    if (job.drawer) {
      await page.locator("#nav-button").click();
      await page.waitForTimeout(600);
    }
    await settleShot(page);
    const shape = await page.evaluate(outline, APP_SIDE);
    return { buffer: await page.screenshot({ animations: "disabled" }), outline: shape, errors: page.errors };
  } finally {
    await context.close();
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: "string" },
        scenes: { type: "string", default: SCENE_NAMES.join(",") },
        widths: { type: "string", default: WIDTHS.join(",") },
        themes: { type: "string", default: THEMES.join(",") },
        mockups: { type: "string", default: DEFAULT_MOCKUPS }
      }
    }));
  } catch (error) {
    fail(error.message);
  }
  if (!values.out) fail("pass --out <directory>.");
  const list = (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const scenes = list(values.scenes);
  const widths = list(values.widths).map(Number);
  const themes = list(values.themes);
  for (const name of scenes) if (!SCENE_NAMES.includes(name)) fail(`unknown scene ${name}; use ${SCENE_NAMES.join(", ")}.`);
  for (const width of widths) if (!WIDTHS.includes(width)) fail(`unknown width ${width}; use ${WIDTHS.join(", ")}.`);
  for (const name of themes) if (!THEMES.includes(name)) fail(`unknown theme ${name}; use ${THEMES.join(", ")}.`);
  const folder = path.resolve(values.mockups);
  let all;
  let markup;
  try {
    ({ scenes: all } = JSON.parse(await readFile(path.join(folder, "scenes.json"), "utf8")));
    markup = await import(`${pathToFileURL(path.join(folder, "content.mjs")).href}?read=${Date.now()}`);
  } catch (error) {
    fail(`cannot read the mockups in ${folder}: ${error.message}`);
  }
  const jobs = all.filter((job) => scenes.includes(job.name) && widths.includes(job.width) && themes.includes(job.theme)).map((job) => ({ ...job, scene: job.name }));
  const playwright = loadPlaywright();
  if (!playwright) fail("Playwright is not installed. Install it with `npm install -g playwright` and `npx playwright install chromium`.");
  const out = path.resolve(values.out);
  await mkdir(out, { recursive: true });

  // The claim avatars name the short host name of the machine that ran the workspace's verifications, which is this one.
  const host = os.hostname().split(".")[0];
  const browser = await playwright.chromium.launch(CHROMIUM_OPTIONS);
  let workspace = null;
  let failure = null;
  const pairs = [];
  try {
    if (jobs.length) {
      workspace = await startWorkspace();
      const token = await writeToken(browser, workspace);
      for (const job of jobs) {
        const mockup = await readMockup(browser, workspace, token, markup, job, host);
        const app = await readApp(browser, workspace, token, job);
        const differences = compareOutlines(mockup.outline, app.outline, job);
        const name = `${job.scene}-${job.width}-${job.theme}`;
        const title = `Code place · ${job.scene} · ${job.width}px · ${job.theme}`;
        await writeFile(path.join(out, `${name}.png`), await compose(browser, { mockup: mockup.buffer, app: app.buffer, width: job.width, height: job.height, title, differences }));
        await writeFile(path.join(out, `${name}.json`), `${JSON.stringify({ scene: job.scene, width: job.width, theme: job.theme, mockup: mockup.outline, app: app.outline, differences, errors: { mockup: mockup.errors, app: app.errors } }, null, 2)}\n`);
        let approved = null;
        if (job.picture) {
          approved = `approved-${job.picture}`;
          await copyFile(path.join(folder, job.picture), path.join(out, approved)).catch(() => { approved = null; });
        }
        pairs.push({ scene: job.scene, width: job.width, theme: job.theme, png: `${name}.png`, approved, differences });
        process.stdout.write(`${name}.png: ${differences.length ? `${differences.length} difference${differences.length === 1 ? "" : "s"}` : "no differences"}\n`);
        for (const line of differences) process.stdout.write(`${line}\n`);
      }
    }
    await writeFile(path.join(out, "report.json"), `${JSON.stringify({ pairs: pairs.map(({ scene, width, theme, png, differences }) => ({ scene, width, theme, png, differences })) }, null, 2)}\n`);
    await writeFile(path.join(out, "index.html"), indexHtml(pairs));
  } catch (error) {
    failure = error.message;
  } finally {
    await browser.close().catch(() => {});
    await workspace?.close();
  }
  if (failure) fail(failure);
  const differing = pairs.filter((pair) => pair.differences.length).length;
  process.stdout.write(`${pairs.length} pairs in ${out}, ${differing} with differences; open index.html to see them.\n`);
  process.exit(differing ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
