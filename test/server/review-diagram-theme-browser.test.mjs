import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, ROOT, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { AUTHORED, REFERENCE } from "./fixtures/plantuml-reference.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §3, §8.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 63, 64, and 65.
// Diagrams follow the theme by mapping only the vendored PlantUML runtime's default colors to the diagram tokens, so every color an author set survives.

const ROLES = ["surface", "surface-2", "group", "group-line", "note", "line", "danger"];
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function served(context) {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  return { base, browser };
}

// Renders PlantUML sources in the page with the vendored runtime the review page loads, one at a time.
const render = (page, base, sources) => page.evaluate(async ([base, sources]) => {
  const { renderToString } = await import(`${base}/vendor/plantuml.js`);
  const out = {};
  for (const [name, lines] of Object.entries(sources)) out[name] = await new Promise((resolve) => renderToString(lines, resolve, (error) => resolve(`error: ${error}`), {}));
  return out;
}, [base, sources]);

const colorsOf = (svg) => [...svg.matchAll(/\b(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((match) => match[1].toUpperCase());

test("clause 63: the PlantUML default color table names the vendored runtime and maps each default to a diagram role or keeps it", async () => {
  const { PLANTUML_DEFAULTS, PLANTUML_RUNTIME } = await import(pathToFileURL(path.join(ROOT, "dist/server/review/public/kit/plantuml-defaults.js")).href);
  assert.equal(PLANTUML_RUNTIME, "1.2026.8");
  assert.ok(Object.isFrozen(PLANTUML_DEFAULTS), "the table is frozen");
  for (const [color, role] of Object.entries(PLANTUML_DEFAULTS)) {
    assert.match(color, /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/, `${color} is upper-case hex`);
    assert.ok(role === null || ROLES.includes(role), `${color} maps to a diagram role or null, not ${role}`);
  }
  for (const [color, role] of [["#F1F1F1", "surface"], ["#E2E2F0", "surface-2"], ["#FEFFDD", "note"], ["#181818", "line"]]) assert.equal(PLANTUML_DEFAULTS[color], role, `${color} is ${role}`);
});

test("clause 63: the vendored runtime paints exactly the colors of the default table for the reference diagrams", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await served(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  const drawn = await render(page, base, REFERENCE);
  for (const [name, svg] of Object.entries(drawn)) assert.match(svg, /<svg/, `the runtime draws the ${name} reference`);
  const painted = [...new Set(Object.values(drawn).flatMap(colorsOf))].sort();
  const { PLANTUML_DEFAULTS } = await page.evaluate(async (base) => ({ PLANTUML_DEFAULTS: (await import(`${base}/kit/plantuml-defaults.js`)).PLANTUML_DEFAULTS }), base);
  assert.deepEqual(painted, Object.keys(PLANTUML_DEFAULTS).sort(), "a runtime whose defaults change fails here; update the table and recheck the recoloring");
});

test("clause 64: themeDiagram maps default colors to the diagram tokens, keeps authored colors, and lifts authored text and lines to AA", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await served(context);
  for (const theme of ["dark", "light"]) {
    const page = await openPage(browser, `${base}/kit/catalog?theme=${theme}`);
    const drawn = await render(page, base, { ...REFERENCE, ...AUTHORED });
    const result = await page.evaluate(async ([base, drawn, theme]) => {
      const { themeDiagram } = await import(`${base}/kit/diagram-theme.js`);
      const { PLANTUML_DEFAULTS } = await import(`${base}/kit/plantuml-defaults.js`);
      const hex = (color) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d");
        paint.fillStyle = color;
        paint.fillRect(0, 0, 1, 1);
        const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      };
      const luminance = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const host = document.createElement("div");
      host.dataset.theme = theme;
      document.body.append(host);
      const token = (role) => hex(getComputedStyle(host).getPropertyValue(`--prism-color-diagram-${role}`).trim());
      const mapped = Object.entries(PLANTUML_DEFAULTS).filter(([, role]) => role).map(([color]) => color);
      const out = {};
      for (const [name, svg] of Object.entries(drawn)) {
        host.innerHTML = svg;
        const element = host.querySelector("svg");
        themeDiagram(element);
        const attributes = [...element.querySelectorAll("*")].flatMap((node) => ["fill", "stroke"].map((name) => node.getAttribute(name)).filter((value) => value && value.startsWith("#")).map((value) => value.toUpperCase()));
        out[name] = {
          leftover: attributes.filter((value) => mapped.includes(value)),
          fills: [...element.querySelectorAll("rect, path, polygon, ellipse, circle")].map((node) => (node.getAttribute("fill") ?? "").toUpperCase()),
          texts: [...element.querySelectorAll("text")].map((node) => ({ text: node.textContent, fill: (node.getAttribute("fill") ?? "").toUpperCase() })),
          strokes: [...element.querySelectorAll("line, path, polygon")].map((node) => (node.getAttribute("stroke") ?? "").toUpperCase())
        };
      }
      const tokens = Object.fromEntries(["paper", "ink", "line", "surface", "surface-2", "note"].map((role) => [role, token(role)]));
      host.remove();
      return { out, tokens, ratios: Object.fromEntries(Object.entries(out).map(([name, value]) => [name, { text: value.texts.filter((item) => item.fill.startsWith("#")).map((item) => ({ text: item.text, paper: ratio(item.fill, tokens.paper) })), stroke: value.strokes.filter((item) => item.startsWith("#") && item.length === 7).map((item) => ratio(item, tokens.paper)) }])) };
    }, [base, drawn, theme]);
    for (const [name, value] of Object.entries(result.out)) {
      if (name === "error") continue;
      assert.deepEqual(value.leftover, [], `${theme}: no mapped default color remains in the ${name} diagram`);
    }
    assert.ok(result.out.class.fills.includes(result.tokens.surface), `${theme}: a default class fill becomes diagram-surface`);
    assert.ok(result.out.sequence.fills.includes(result.tokens["surface-2"]), `${theme}: a default participant fill becomes diagram-surface-2`);
    assert.ok(result.out.sequence.fills.includes(result.tokens.note), `${theme}: a default note fill becomes diagram-note`);
    assert.ok(result.out.sequence.texts.filter((item) => item.text.trim()).every((item) => item.fill === result.tokens.ink || item.fill === ""), `${theme}: default text on default grounds becomes diagram-ink`);
    assert.ok(result.out.colored.fills.includes("#FFC0CB"), `${theme}: the authored pink fill survives`);
    const label = result.ratios.colored.text.find((item) => item.text.includes("authored label"));
    assert.ok(label, "the authored label is drawn");
    assert.ok(label.paper >= 4.5, `${theme}: the authored label reads at 4.5:1 on the paper, not ${label.paper.toFixed(2)}`);
    assert.ok(result.ratios.colored.stroke.every((value) => value >= 3), `${theme}: every authored line reaches 3:1 on the paper`);
    await page.context().close();
  }
});

test("clause 65: a diagram the review page shows sits on the paper and follows a theme change", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await served(context);
  await choose(base, { theme: "system" });
  const page = await openPage(browser, reviewUrl(base, "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml"), { colorScheme: "light" });
  await waitForView(page);
  await page.locator("#artifact svg").first().waitFor();
  const read = () => page.evaluate(async (base) => {
    const { PLANTUML_DEFAULTS } = await import(`${base}/kit/plantuml-defaults.js`);
    const mapped = Object.entries(PLANTUML_DEFAULTS).filter(([, role]) => role).map(([color]) => color);
    const svg = document.querySelector("#artifact svg");
    const colors = [...svg.querySelectorAll("*")].flatMap((node) => ["fill", "stroke"].map((name) => (node.getAttribute(name) ?? "").toUpperCase())).filter((value) => value.startsWith("#"));
    const probe = document.createElement("div");
    probe.style.setProperty("background-color", "var(--prism-color-diagram-paper)");
    document.body.append(probe);
    const paper = getComputedStyle(probe).backgroundColor;
    probe.remove();
    let sheet = null;
    for (let node = svg.parentElement; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)") { sheet = color; break; }
    }
    return { leftover: colors.filter((value) => mapped.includes(value)), colors: [...new Set(colors)].sort(), sheet, paper, theme: document.documentElement.dataset.theme };
  }, base);
  const light = await read();
  assert.equal(light.theme, "light");
  assert.deepEqual(light.leftover, [], "no mapped default color remains in the light theme");
  assert.equal(light.sheet, light.paper, "the diagram sits on a sheet painted --prism-color-diagram-paper");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForTimeout(500);
  const dark = await read();
  assert.deepEqual(dark.leftover, [], "no mapped default color remains in the dark theme");
  assert.equal(dark.sheet, dark.paper, "the sheet follows the dark paper");
  assert.notDeepEqual(dark.colors, light.colors, "the diagram is recolored when the theme changes");
});
