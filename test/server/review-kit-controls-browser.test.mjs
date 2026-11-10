import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { boundaryFailures, choicesWithoutIndicator, contrastFailures, escapes, focusRing, launch, openPage, ROOT, serveProject, shownTooltip, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §5, §7, §8, §9, §10.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 21, 22, 23, 27 to 40, and 57 to 59.
// The controls are exercised through their public attributes, events, and keys on the served catalog page, where the kit is loaded as it ships.

const CONTROLS = ["prism-button", "prism-icon", "prism-chip", "prism-badge", "prism-tab", "prism-tabs", "prism-menu", "prism-menu-group", "prism-menu-item", "prism-tooltip", "prism-field", "prism-option", "prism-choice", "prism-choice-option"];
const HOLDS_ITEMS = ["prism-tabs", "prism-menu", "prism-choice"];
// Clause 28: every tag the kit registers, the first eleven in shadow DOM and the rest in light DOM.
const SHADOW = ["prism-button", "prism-icon", "prism-chip", "prism-badge", "prism-tab", "prism-menu-item", "prism-tooltip", "prism-stat", "prism-meter", "prism-spinner", "prism-avatar"];
const LIGHT = ["prism-tabs", "prism-menu", "prism-menu-group", "prism-field", "prism-option", "prism-choice", "prism-choice-option", "prism-panel", "prism-tree", "prism-tree-item", "prism-listbox", "prism-list-item", "prism-dialog", "prism-popover", "prism-disclosure", "prism-empty-state", "prism-banner", "prism-toast", "prism-claim", "prism-stepper", "prism-step", "prism-breadcrumbs", "prism-doc", "prism-code"];
const LONG = "A caption that is far longer than the room any control gives it, so it has to end early";
const UNBROKEN = "slice-with-a-very-long-name-that-has-no-spaces-anywhere-and-cannot-wrap-at-all";

async function emptyProject(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-controls-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  return root;
}

async function catalog(context, query = "", options = {}) {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await emptyProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog${query}`, options);
  await page.waitForFunction(() => customElements.get("prism-button") !== undefined, null, { timeout: 5000 });
  return { base, browser, page };
}

// Puts markup in a fixture region at the top of the catalog page and waits for its elements to upgrade.
async function mount(page, html, { width = "600px" } = {}) {
  await page.evaluate(([html, width]) => {
    document.querySelector("#fixture")?.remove();
    const region = document.createElement("div");
    region.id = "fixture";
    region.style.setProperty("width", width);
    region.style.setProperty("padding", "8px");
    region.innerHTML = html;
    document.body.prepend(region);
    window.scrollTo(0, 0);
  }, [html, width]);
  await page.waitForTimeout(150);
}

// The focused element through shadow roots, reported as its nearest kit host.
const focused = (page) => page.evaluate(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
    if (node.tagName?.toLowerCase().startsWith("prism-") && !["prism-tabs", "prism-menu", "prism-menu-group"].includes(node.tagName.toLowerCase())) {
      return { tag: node.tagName.toLowerCase(), value: node.getAttribute("value"), id: node.id, text: node.textContent.trim() };
    }
  }
  return element ? { tag: element.tagName.toLowerCase(), id: element.id } : null;
});

const record = (page, selector, type) => page.evaluate(([selector, type]) => {
  window.__events ??= [];
  document.querySelector(selector).addEventListener(type, (event) => window.__events.push({ type, detail: event.detail ?? null, target: event.target.tagName.toLowerCase() }));
}, [selector, type]);
const events = (page) => page.evaluate(() => window.__events ?? []);

async function kitElements() {
  const kit = await import(path.join(ROOT, "dist/server/review/public/kit/kit.js"));
  return kit.KIT_ELEMENTS.map((element) => ({ tag: element.tag, catalog: element.catalog }));
}

test("clauses 27, 28: the kit registry holds every element of the contract and describes each one", async () => {
  const elements = await kitElements();
  const tags = elements.map((element) => element.tag);
  for (const tag of [...SHADOW, ...LIGHT]) assert.ok(tags.includes(tag), `the kit registers ${tag}`);
  assert.equal(new Set(tags).size, tags.length, "each tag is registered once");
  for (const { tag, catalog } of elements) {
    assert.equal(typeof catalog?.purpose, "string", `${tag} states its purpose`);
    assert.ok(catalog.purpose.trim(), `${tag} states its purpose`);
    assert.ok(Array.isArray(catalog.options), `${tag} lists its options`);
    for (const option of catalog.options) assert.equal(typeof option.name, "string", `${tag} names each option`);
    assert.ok(Array.isArray(catalog.states) && catalog.states.length, `${tag} lists its states`);
    assert.ok(Array.isArray(catalog.keyboard), `${tag} describes its keyboard behavior`);
  }
  const kit = await import(path.join(ROOT, "dist/server/review/public/kit/kit.js"));
  assert.equal(typeof kit.defineKit, "function");
  kit.defineKit();
});

test("clause 28: the self-contained elements render in shadow DOM and the others in light DOM", { skip }, async (context) => {
  const { page } = await catalog(context);
  const roots = await page.evaluate((tags) => Object.fromEntries(tags.map((tag) => [tag, Boolean(document.createElement(tag).shadowRoot) || Boolean([...document.querySelectorAll(tag)].some((element) => element.shadowRoot))])), [...SHADOW, ...LIGHT]);
  for (const tag of SHADOW) assert.equal(roots[tag], true, `${tag} renders in shadow DOM`);
  for (const tag of LIGHT) assert.equal(roots[tag], false, `${tag} renders in light DOM`);
});

test("clause 57: the catalog shows every kit element with its documentation and live specimens", { skip }, async (context) => {
  const elements = await kitElements();
  const { page } = await catalog(context);
  const entries = await page.evaluate(() => [...document.querySelectorAll("[data-catalog-entry]")].map((entry) => ({
    tag: entry.dataset.catalogEntry,
    heading: entry.querySelector("h1, h2, h3, h4")?.textContent ?? "",
    docs: Object.fromEntries(["purpose", "options", "states", "keyboard"].map((name) => [name, entry.querySelector(`[data-doc="${name}"]`)?.textContent.trim() ?? null])),
    specimens: Object.fromEntries([...entry.querySelectorAll("[data-specimen]")].map((specimen) => [specimen.dataset.specimen, [...specimen.querySelectorAll("*")].filter((node) => node.tagName.toLowerCase().startsWith("prism-") && customElements.get(node.tagName.toLowerCase())).length]))
  })));
  assert.equal(entries[0]?.tag, "design-values", "the design values come first");
  assert.deepEqual(entries.slice(1).map((entry) => entry.tag).sort(), elements.map((element) => element.tag).sort(), "one entry per kit element");
  for (const { tag, catalog: description } of elements) {
    const entry = entries.find((item) => item.tag === tag);
    assert.ok(entry.heading.includes(tag), `${tag}'s entry names it`);
    assert.ok(entry.docs.purpose?.includes(description.purpose.trim().slice(0, 30)), `${tag} shows its purpose`);
    for (const option of description.options) assert.ok(entry.docs.options?.includes(option.name), `${tag} documents option ${option.name}`);
    for (const state of description.states) assert.ok(entry.specimens[state] > 0, `${tag} shows a live specimen for ${state}`);
    for (const line of description.keyboard) assert.ok(entry.docs.keyboard?.includes(line.trim().slice(0, 30)), `${tag} documents its keys`);
    assert.ok(entry.specimens["long-text"] > 0, `${tag} shows long text`);
    assert.ok(entry.specimens["unbroken-name"] > 0, `${tag} shows an unbroken name`);
    if (HOLDS_ITEMS.includes(tag)) assert.ok(entry.specimens["many-items"] > 0, `${tag} shows many items`);
  }
  assert.deepEqual(page.errors, []);
});

test("clause 58: the catalog lists every semantic token with its value in each shipped theme", { skip }, async (context) => {
  const { page } = await catalog(context);
  const listed = await page.evaluate(() => {
    const entry = document.querySelector('[data-catalog-entry="design-values"]');
    const names = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.selectorText?.includes('[data-theme="light"]')) for (const name of rule.style) if (/^--prism-(color|shadow)-/.test(name) || name === "--prism-gradient-canvas") names.add(name);
      }
    }
    return { text: entry?.textContent ?? "", names: [...names] };
  });
  assert.ok(listed.names.length >= 80, "the page loaded the semantic tokens");
  for (const name of listed.names) assert.ok(listed.text.includes(name), `the catalog lists ${name}`);
  for (const value of ["#5b3fe4", "#9a89ff"]) assert.ok(listed.text.toLowerCase().includes(value), `the catalog shows the value ${value} of a shipped theme`);
});

test("clause 59: the catalog's toolbar and query choose its theme, density, and width without storing them", { skip }, async (context) => {
  const { base, page } = await catalog(context, "?theme=dark&density=comfortable&width=narrow");
  const state = await page.evaluate(() => {
    const scoped = document.querySelector("[data-catalog-entry]").closest("[data-theme]");
    return { theme: scoped?.dataset.theme, density: document.querySelector("[data-catalog-entry]").closest("[data-density]")?.dataset.density, width: document.querySelector("[data-catalog-entry]").getBoundingClientRect().width };
  });
  assert.equal(state.theme, "dark");
  assert.equal(state.density, "comfortable");
  assert.ok(state.width <= 320, `a narrow catalog is at most 320px wide, not ${state.width}`);
  assert.deepEqual(await (await fetch(`${base}/api/preferences`)).json(), { theme: "system", density: "compact" }, "the catalog stores nothing");
  for (const name of ["Light", "Dark", "System", "Comfortable", "Compact", "Wide", "Narrow"]) {
    assert.ok(await page.getByRole("button", { name, exact: true }).or(page.getByRole("radio", { name, exact: true })).or(page.getByRole("menuitemradio", { name, exact: true })).count(), `the toolbar offers ${name}`);
  }
});

test("clauses 21, 22: text and field and choice boundaries in the control entries reach WCAG AA in both themes and densities", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await emptyProject(context));
  const browser = await launch(context);
  const selector = CONTROLS.map((tag) => `[data-catalog-entry="${tag}"]`).join(", ");
  for (const theme of ["light", "dark"]) {
    for (const density of ["compact", "comfortable"]) {
      const page = await openPage(browser, `${base}/kit/catalog?theme=${theme}&density=${density}`);
      assert.equal(await page.locator(selector).count(), CONTROLS.length, "the catalog shows every control entry");
      assert.deepEqual(await contrastFailures(page, selector), [], `text contrast, ${theme} ${density}`);
      assert.deepEqual(await boundaryFailures(page, selector), [], `field and choice boundaries, ${theme} ${density}`);
      assert.deepEqual(await choicesWithoutIndicator(page, selector), [], `every choice option draws its radio or an indicator, ${theme} ${density}`);
      assert.ok(await page.locator(`${selector.split(", ").filter((part) => /prism-(field|choice)/.test(part)).join(", ")}`).locator("input, select, textarea, [data-indicator]").count() > 0, "the field and choice entries hold controls to check");
      await page.context().close();
    }
  }
});

test("clause 23: every keyboard focus stop on the catalog shows a 2px focus outline that reaches 3:1", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await emptyProject(context));
  const browser = await launch(context);
  for (const theme of ["light", "dark"]) {
    const page = await openPage(browser, `${base}/kit/catalog?theme=${theme}`);
    const seen = new Set();
    for (let stop = 0; stop < 80; stop += 1) {
      await page.keyboard.press("Tab");
      const ring = await focusRing(page);
      if (!ring || seen.has(ring.element)) continue;
      seen.add(ring.element);
      assert.equal(ring.style, "solid", `${theme}: ${ring.element} has a solid outline`);
      assert.equal(ring.width, 2, `${theme}: ${ring.element} has a 2px outline`);
      assert.equal(ring.offset, 1, `${theme}: ${ring.element} has a 1px offset`);
      assert.ok(ring.contrast >= 3, `${theme}: ${ring.element}'s outline reaches 3:1, not ${ring.contrast.toFixed(2)}`);
    }
    assert.ok(seen.size >= 10, `${theme}: the catalog has focus stops`);
    await page.context().close();
  }
});

test("clauses 24, 29: a button takes its height from the density and its size, and sends clicks only while enabled", { skip }, async (context) => {
  const { browser, base, page } = await catalog(context);
  await mount(page, `<prism-button id="small" size="sm">Small</prism-button><prism-button id="save" variant="primary">Save</prism-button><prism-button id="off" disabled>Off</prism-button><prism-button id="bold" pressed>Bold</prism-button><prism-button id="close" label="Close the panel"><prism-icon name="close"></prism-icon></prism-button>`);
  const height = (target) => target.evaluate(() => document.querySelector("#save").getBoundingClientRect().height);
  assert.equal(await height(page), 24);
  assert.equal(await page.evaluate(() => document.querySelector("#small").getBoundingClientRect().height), 18, "a small button takes --prism-control-height-sm");
  const comfortable = await openPage(browser, `${base}/kit/catalog?density=comfortable`);
  await mount(comfortable, `<prism-button id="save">Save</prism-button>`);
  assert.equal(await height(comfortable), 30);
  await page.evaluate(() => {
    window.__clicks = [];
    for (const id of ["save", "off"]) document.getElementById(id).addEventListener("click", () => window.__clicks.push(id));
  });
  await page.getByRole("button", { name: "Save" }).click();
  await page.locator("#off").click({ force: true });
  await page.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  assert.deepEqual(await page.evaluate(() => window.__clicks), ["save", "save", "save"]);
  assert.equal(await page.getByRole("button", { name: "Off" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "Close the panel" }).count(), 1, "an icon-only button is named by its label");
});

test("clause 30: icons are hidden from assistive technology unless labelled", { skip }, async (context) => {
  const { page } = await catalog(context);
  const names = ["search", "close", "chevron-right", "chevron-down", "back", "forward", "menu", "panel", "link", "agent", "store", "sync", "maximize", "restore", "external", "check", "warning", "info", "more"];
  await mount(page, names.map((name) => `<prism-icon name="${name}"></prism-icon>`).join("") + `<prism-icon name="warning" label="Warning"></prism-icon>`);
  const drawn = await page.evaluate(() => [...document.querySelectorAll("#fixture prism-icon")].map((icon) => icon.getBoundingClientRect().width > 0 && Boolean(icon.shadowRoot?.querySelector("svg"))));
  assert.deepEqual(drawn, names.map(() => true).concat(true), "every icon draws an SVG");
  assert.equal(await page.locator("#fixture").getByRole("img").count(), 1);
  assert.equal(await page.locator("#fixture").getByRole("img", { name: "Warning" }).count(), 1);
});

test("clauses 31, 32: chips are static text, links, or buttons, and badges are static text", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-chip id="plain" tone="info">plain<span slot="meta">meta</span></prism-chip><prism-chip id="link" href="#target">link</prism-chip><prism-chip id="act" interactive>act</prism-chip><prism-badge tone="danger" variant="count">3</prism-badge>`);
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("link", { name: "link" }).count(), 1);
  assert.equal(await region.getByRole("button", { name: "act" }).count(), 1);
  assert.equal(await region.getByRole("button").count(), 1, "a static chip and a badge are not buttons");
  assert.equal(await region.getByRole("link").count(), 1);
  await record(page, "#act", "click");
  await region.getByRole("button", { name: "act" }).click();
  assert.equal((await events(page)).length, 1);
  assert.match(await page.locator("#plain").innerText(), /plain/);
  const roles = await page.evaluate(() => {
    const deep = (root) => [root, ...[...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node])];
    const badge = document.querySelector("#fixture prism-badge");
    return [badge, ...(badge.shadowRoot ? deep(badge.shadowRoot) : [])].map((node) => node.getAttribute?.("role")).filter(Boolean);
  });
  assert.deepEqual(roles.filter((role) => ["button", "link", "checkbox", "option", "tab", "menuitem"].includes(role)), [], "a badge carries no control role");
});

test("clauses 33, 34: tabs are a named tablist with one selected tab, move focus with arrow keys, and select with Enter", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="before">Before</prism-button><prism-tabs id="tabs" label="Slice"><prism-tab value="a" selected>Design</prism-tab><prism-tab value="b">Diagram</prism-tab><prism-tab value="c">Files</prism-tab></prism-tabs><prism-button id="after">After</prism-button>`);
  await record(page, "#tabs", "prism-select");
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("tablist", { name: "Slice" }).count(), 1);
  assert.equal(await region.getByRole("tab").count(), 3);
  assert.equal(await region.getByRole("tab", { name: "Design" }).getAttribute("aria-selected"), "true");
  assert.equal(await region.getByRole("tab", { selected: true }).count(), 1, "exactly one tab is selected");
  assert.equal(await region.getByRole("button", { name: /^Close/ }).count(), 0, "a tab offers no close button");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).value, "a", "Tab enters the tabs at the selected tab");
  await page.keyboard.press("ArrowRight");
  assert.equal((await focused(page)).value, "b");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal((await focused(page)).value, "a", "ArrowRight wraps");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await focused(page)).value, "c", "ArrowLeft wraps");
  await page.keyboard.press("Home");
  assert.equal((await focused(page)).value, "a");
  await page.keyboard.press("End");
  assert.equal((await focused(page)).value, "c");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await region.getByRole("tab", { name: "Design" }).click();
  const sent = await events(page);
  assert.deepEqual(sent.filter((event) => event.type === "prism-select").map((event) => event.detail.value), ["c", "b", "a"]);
  assert.equal(await region.getByRole("tab", { name: "Design" }).getAttribute("aria-selected"), "true");
  assert.equal(await region.getByRole("tab", { selected: true }).count(), 1, "selecting a tab unselects the others");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).id, "after", "only one tab is in the Tab order");
});

test("clause 34: tabs that do not fit scroll inside their strip", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-tabs label="Many">${Array.from({ length: 30 }, (_, index) => `<prism-tab value="t${index}"${index === 0 ? " selected" : ""}>${index % 3 ? "Tab" : UNBROKEN} ${index}</prism-tab>`).join("")}</prism-tabs>`, { width: "320px" });
  assert.deepEqual(await escapes(page, "#fixture"), []);
  const strip = await page.evaluate(() => {
    const tabs = document.querySelector("#fixture prism-tabs");
    const box = tabs.getBoundingClientRect();
    return { right: box.right, limit: document.querySelector("#fixture").getBoundingClientRect().right };
  });
  assert.ok(strip.right <= strip.limit + 1, "the strip stays inside its container");
  await page.locator('prism-tab[value="t29"]').evaluate((tab) => tab.focus());
  assert.ok(await page.locator('prism-tab[value="t29"]').isVisible(), "the last tab scrolls into view");
});

test("clauses 35, 36: a menu opens from its button, moves with arrow keys, chooses with Enter, and closes with Escape", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="trigger">Appearance</prism-button>
    <prism-menu id="menu" for="trigger">
      <prism-menu-group label="Theme">
        <prism-menu-item value="none" disabled>Unavailable</prism-menu-item>
        <prism-menu-item type="radio" value="system" checked>System</prism-menu-item>
        <prism-menu-item type="radio" value="light">Light</prism-menu-item>
        <prism-menu-item type="radio" value="dark">Dark</prism-menu-item>
      </prism-menu-group>
      <prism-menu-item type="checkbox" value="wrap" checked>Wrap lines</prism-menu-item>
      <prism-menu-item value="catalog">Component catalog</prism-menu-item>
    </prism-menu><prism-button id="other">Other</prism-button>`);
  await record(page, "#menu", "prism-select");
  const trigger = page.getByRole("button", { name: "Appearance" });
  assert.equal(await trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await trigger.focus();
  await page.keyboard.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByRole("menu").count(), 1);
  assert.equal(await page.getByRole("group", { name: "Theme" }).count(), 1);
  assert.equal(await page.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked"), "false");
  assert.equal(await page.getByRole("menuitemcheckbox", { name: "Wrap lines" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("menuitem", { name: "Component catalog" }).count(), 1);
  assert.equal((await focused(page)).value, "system", "the first enabled item takes focus");
  await page.keyboard.press("ArrowDown");
  assert.equal((await focused(page)).value, "light");
  await page.keyboard.press("End");
  assert.equal((await focused(page)).value, "catalog");
  await page.keyboard.press("Home");
  assert.equal((await focused(page)).value, "system");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await events(page)).map((event) => event.detail.value), ["dark"]);
  assert.equal(await page.getByRole("menu").count(), 0, "choosing closes the menu");
  assert.equal((await focused(page)).id, "trigger", "focus returns to the button");
  await page.keyboard.press("ArrowUp");
  assert.equal((await focused(page)).value, "catalog", "ArrowUp opens on the last item");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  assert.equal((await focused(page)).id, "trigger");
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  assert.equal(await page.getByRole("menu").count(), 0, "Tab closes the menu");
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  assert.deepEqual((await events(page)).map((event) => event.detail.value), ["dark", "light"]);
  await trigger.click();
  await page.mouse.click(5, 700);
  assert.equal(await page.getByRole("menu").count(), 0, "a click outside closes the menu");
});

test("clause 36: a menu near the bottom of the window opens above its button and stays inside the window", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 800, height: 600 } });
  await page.evaluate(() => {
    const holder = document.createElement("div");
    holder.id = "low";
    holder.style.setProperty("position", "fixed");
    holder.style.setProperty("bottom", "4px");
    holder.style.setProperty("right", "4px");
    holder.innerHTML = `<prism-button id="low-trigger">Appearance</prism-button><prism-menu for="low-trigger">${Array.from({ length: 6 }, (_, index) => `<prism-menu-item value="v${index}">Item number ${index} with a longer caption</prism-menu-item>`).join("")}</prism-menu>`;
    document.body.append(holder);
  });
  await page.waitForTimeout(150);
  await page.locator("#low-trigger").click();
  const boxes = await page.evaluate(() => {
    const menu = document.querySelector("#low prism-menu");
    let surface = menu;
    for (const node of [menu, ...menu.querySelectorAll("*")]) if (node.getAttribute("role") === "menu") surface = node;
    const box = surface.getBoundingClientRect();
    return { menu: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, trigger: document.querySelector("#low-trigger").getBoundingClientRect().top, width: innerWidth, height: innerHeight };
  });
  assert.ok(boxes.menu.bottom <= boxes.trigger + 1, "the menu opens above its button");
  assert.ok(boxes.menu.top >= 0 && boxes.menu.left >= 0 && boxes.menu.right <= boxes.width && boxes.menu.bottom <= boxes.height, "the menu stays inside the window");
});

test("clauses 37, 38: shortened text shows its full text in a tooltip on hover and on keyboard focus", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="before">Before</prism-button>
    <div class="narrow"><prism-chip id="long">${LONG}</prism-chip></div>
    <div class="narrow"><prism-chip id="unbroken">${UNBROKEN}</prism-chip></div>
    <div class="narrow"><prism-button id="wide">${LONG}</prism-button></div>
    <prism-chip id="short">Short</prism-chip>
    <prism-button id="tipped" tip="Opens the roadmap">Roadmap</prism-button>`);
  // The page's style policy refuses inline style attributes, so the narrow widths go through the CSSOM.
  await page.evaluate(() => { for (const box of document.querySelectorAll("#fixture .narrow")) box.style.setProperty("width", "140px"); });
  await page.waitForTimeout(200);
  assert.deepEqual(await escapes(page, "#fixture"), [], "shortened elements stay inside their containers");
  const attribute = (id) => page.evaluate((id) => document.getElementById(id).hasAttribute("shortened"), id);
  assert.equal(await attribute("long"), true);
  assert.equal(await attribute("unbroken"), true);
  assert.equal(await attribute("wide"), true);
  assert.equal(await attribute("short"), false);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#fixture *")].some((node) => node.hasAttribute("title") || [...(node.shadowRoot?.querySelectorAll("[title]") ?? [])].length)), false, "no kit element renders a native title tooltip");
  await page.locator("#long").hover();
  await page.waitForTimeout(700);
  assert.equal(await shownTooltip(page), LONG, "hovering shows the full text after the delay");
  const describedBy = await page.evaluate(() => document.getElementById("long").getAttribute("aria-describedby"));
  assert.equal(await page.evaluate((id) => document.getElementById(id)?.getAttribute("role"), describedBy), "tooltip", "the element names its tooltip");
  await page.mouse.move(700, 700);
  await page.waitForTimeout(300);
  assert.equal(await shownTooltip(page), null, "leaving hides the tooltip");
  await page.locator("#short").hover();
  await page.waitForTimeout(700);
  assert.equal(await shownTooltip(page), null, "text that fits shows no tooltip");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).id, "long", "a shortened static chip joins the Tab order");
  await page.waitForTimeout(60);
  assert.equal(await shownTooltip(page), LONG, "keyboard focus shows the full text at once");
  await page.keyboard.press("Escape");
  assert.equal(await shownTooltip(page), null, "Escape hides the tooltip");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
  assert.equal(await shownTooltip(page), UNBROKEN);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(60);
  assert.equal(await shownTooltip(page), LONG, "a shortened button shows its full caption");
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).id, "tipped", "a chip that fits stays out of the Tab order");
  await page.waitForTimeout(60);
  assert.equal(await shownTooltip(page), "Opens the roadmap", "a tip shows on focus");
});

test("clause 39: a field creates a labelled native control whose value and events reach the page", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<form id="form">
    <prism-field id="note" type="textarea" label="Note" name="note" hint="Optional unless you request changes" placeholder="Write a note"></prism-field>
    <prism-field id="lane" type="select" label="Lane" name="lane"><prism-option value="a">Alpha</prism-option><prism-option value="b" selected>Beta</prism-option></prism-field>
    <prism-field id="query" type="search" label="Jump to" name="q"></prism-field>
    <prism-field id="bad" type="text" label="Name" name="name" invalid error="A name is required" required></prism-field>
    <prism-field id="off" type="text" label="Locked" name="locked" disabled value="fixed"></prism-field>
  </form>`);
  await page.evaluate(() => {
    window.__seen = [];
    document.getElementById("form").addEventListener("input", (event) => window.__seen.push(["input", event.target.closest("prism-field")?.id]));
    document.getElementById("form").addEventListener("change", (event) => window.__seen.push(["change", event.target.closest("prism-field")?.id]));
  });
  const region = page.locator("#fixture");
  const note = region.getByRole("textbox", { name: "Note" });
  assert.equal(await note.count(), 1);
  await note.fill("Looks right");
  assert.equal(await page.evaluate(() => document.getElementById("note").value), "Looks right");
  await page.evaluate(() => { document.getElementById("note").value = "Changed"; });
  assert.equal(await note.inputValue(), "Changed");
  assert.equal(await page.evaluate(() => new FormData(document.getElementById("form")).get("note")), "Changed", "the native control belongs to the form");
  const lane = region.getByRole("combobox", { name: "Lane" });
  assert.equal(await lane.inputValue(), "b");
  await lane.selectOption("a");
  assert.equal(await page.evaluate(() => document.getElementById("lane").value), "a");
  assert.equal(await region.getByRole("searchbox", { name: "Jump to" }).count(), 1);
  const bad = region.getByRole("textbox", { name: "Name" });
  assert.equal(await bad.getAttribute("aria-invalid"), "true");
  assert.match(await page.evaluate(() => {
    const control = document.querySelector("#bad input");
    return control.getAttribute("aria-describedby").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  }), /A name is required/);
  assert.equal(await region.getByRole("textbox", { name: "Locked" }).isDisabled(), true);
  assert.match(await region.innerText(), /Optional unless you request changes/);
  const seen = await page.evaluate(() => window.__seen);
  assert.ok(seen.some(([type, id]) => type === "input" && id === "note"), "input bubbles from the native control");
  assert.ok(seen.some(([type, id]) => type === "change" && id === "lane"), "change bubbles from the native control");
});

test("clause 40: a choice is a radio group that arrow keys move and that reports its value", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-choice id="answer" label="Your answer" name="answer">
    <prism-choice-option value="accept">Accept<span slot="detail">The slices start in order.</span></prism-choice-option>
    <prism-choice-option value="later" disabled>Later</prism-choice-option>
    <prism-choice-option value="changes" tone="danger">Request changes<span slot="detail">Design revises the contract.</span></prism-choice-option>
  </prism-choice>`);
  await page.evaluate(() => {
    window.__values = [];
    document.getElementById("answer").addEventListener("change", (event) => window.__values.push(event.currentTarget.value));
  });
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("radiogroup", { name: "Your answer" }).count(), 1);
  assert.equal(await region.getByRole("radio").count(), 3);
  await region.getByRole("radio", { name: /Accept/ }).click();
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await page.evaluate(() => window.__values), ["accept", "changes"], "the arrow key skips the disabled option");
  assert.equal(await page.evaluate(() => document.getElementById("answer").value), "changes");
  assert.equal(await region.getByRole("radio", { name: /Later/ }).isDisabled(), true);
  assert.match(await region.innerText(), /Design revises the contract\./);
});

test("clause 38: controls that receive many items or long names stay inside their containers at a narrow width", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 360, height: 740 } });
  await mount(page, `<prism-choice label="${LONG}" name="many">${Array.from({ length: 12 }, (_, index) => `<prism-choice-option value="v${index}">${index % 2 ? LONG : UNBROKEN}</prism-choice-option>`).join("")}</prism-choice>
    <prism-field type="select" label="${UNBROKEN}" name="s">${Array.from({ length: 40 }, (_, index) => `<prism-option value="o${index}">${UNBROKEN}${index}</prism-option>`).join("")}</prism-field>
    <prism-field type="text" label="${LONG}" name="t" value="${UNBROKEN}"></prism-field>
    <div>${Array.from({ length: 20 }, (_, index) => `<prism-badge tone="info">${UNBROKEN}${index}</prism-badge>`).join("")}</div>`, { width: "320px" });
  assert.deepEqual(await escapes(page, "#fixture"), []);
});
