import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundaryFailures, contrastFailures, escapes, focusRing, launch, movingElements, openPage, ROOT, serveProject, shownTooltip, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §7, §8, §9, §10.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 21, 22, 41 to 51, and 54 to 57.
// The containers and content blocks are exercised through their public attributes, events, and keys on the served catalog page.

const CONTAINERS = ["prism-panel", "prism-tree", "prism-tree-item", "prism-listbox", "prism-list-item", "prism-dialog", "prism-popover", "prism-stepper", "prism-step", "prism-breadcrumbs", "prism-disclosure", "prism-empty-state", "prism-banner", "prism-toast", "prism-stat", "prism-meter", "prism-spinner", "prism-doc", "prism-contents", "prism-code"];
const HOLDS_ITEMS = ["prism-tree", "prism-listbox", "prism-panel", "prism-stepper", "prism-breadcrumbs", "prism-contents"];
const LONG = "A caption that is far longer than the room any container gives it, so it has to end early";
const UNBROKEN = "initiative-with-a-very-long-name-that-has-no-spaces-anywhere-and-cannot-wrap";

async function catalog(context, query = "", options = {}) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-containers-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog${query}`, options);
  await page.waitForFunction(() => customElements.get("prism-tree") !== undefined, null, { timeout: 5000 });
  return { base, browser, page };
}

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

// The focused element through shadow roots: an item's value, or else the id of its nearest kit host.
const focusedItem = (page) => page.evaluate(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
    if (["prism-tree-item", "prism-list-item"].includes(node.tagName?.toLowerCase())) return node.getAttribute("value");
  }
  for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
    if (node.tagName?.toLowerCase().startsWith("prism-")) return node.id || node.tagName.toLowerCase();
  }
  return element?.id || element?.tagName.toLowerCase() || null;
});

const record = (page, selector, type) => page.evaluate(([selector, type]) => {
  window.__events ??= [];
  document.querySelector(selector).addEventListener(type, (event) => window.__events.push({ type, detail: event.detail ?? null }));
}, [selector, type]);
const events = (page, type) => page.evaluate((type) => (window.__events ?? []).filter((event) => event.type === type), type);

test("clause 57: the kit registry and the catalog hold every container with live specimens", { skip }, async (context) => {
  const kit = await import(path.join(ROOT, "dist/server/review/public/kit/kit.js"));
  const tags = kit.KIT_ELEMENTS.map((element) => element.tag);
  for (const tag of CONTAINERS) assert.ok(tags.includes(tag), `the kit registers ${tag}`);
  const { page } = await catalog(context);
  for (const tag of CONTAINERS) {
    const entry = await page.evaluate((tag) => {
      const section = document.querySelector(`[data-catalog-entry="${tag}"]`);
      if (!section) return null;
      return {
        docs: ["purpose", "options", "states", "keyboard"].every((name) => section.querySelector(`[data-doc="${name}"]`)),
        specimens: [...section.querySelectorAll("[data-specimen]")].map((specimen) => specimen.dataset.specimen)
      };
    }, tag);
    assert.ok(entry, `the catalog has an entry for ${tag}`);
    assert.ok(entry.docs, `${tag} documents its purpose, options, states, and keys`);
    for (const specimen of ["long-text", "unbroken-name", ...(HOLDS_ITEMS.includes(tag) ? ["many-items"] : [])]) {
      assert.ok(entry.specimens.includes(specimen), `${tag} shows ${specimen}`);
    }
  }
});

test("clauses 21, 22: text and field and choice boundaries in the container entries reach WCAG AA in both themes and densities, and they stay inside a phone width", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await catalog(context);
  const selector = CONTAINERS.map((tag) => `[data-catalog-entry="${tag}"]`).join(", ");
  for (const theme of ["light", "dark"]) {
    for (const density of ["compact", "comfortable"]) {
      const page = await openPage(browser, `${base}/kit/catalog?theme=${theme}&density=${density}`, { viewport: { width: 360, height: 740 } });
      assert.equal(await page.locator(selector).count(), CONTAINERS.length, "the catalog shows every container entry");
      assert.deepEqual(await contrastFailures(page, selector), [], `text contrast, ${theme} ${density}`);
      assert.deepEqual(await boundaryFailures(page, selector), [], `field and choice boundaries, ${theme} ${density}`);
      assert.deepEqual(await escapes(page, selector), [], `layout, ${theme} ${density}`);
      await page.context().close();
    }
  }
});

test("clause 41: a panel renders its heading, tools, body, and footer, toggles maximized, and an island takes the island values", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-panel id="panel" heading="Contract" level="3" eyebrow="Slice" maximizable>
    <prism-button slot="tools">Open</prism-button><p id="body">Body text</p><p slot="footer" id="foot">Footer</p></prism-panel>
    <prism-panel id="island" variant="island" heading="Roadmap"><p>On the canvas.</p></prism-panel>`);
  await record(page, "#panel", "prism-maximize");
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("heading", { level: 3, name: "Contract" }).count(), 1);
  assert.match(await region.innerText(), /Slice[\s\S]*Contract/);
  const order = await page.evaluate(() => {
    const top = (id) => document.getElementById(id).getBoundingClientRect().top;
    const tools = document.querySelector('#panel [slot="tools"]').getBoundingClientRect();
    const heading = document.querySelector("#panel h3").getBoundingClientRect();
    return { toolsInHeader: Math.abs(tools.top - heading.top) < heading.height + 8, bodyBeforeFooter: top("body") < top("foot") };
  });
  assert.deepEqual(order, { toolsInHeader: true, bodyBeforeFooter: true });
  await region.getByRole("button", { name: "Maximize" }).click();
  assert.equal(await page.evaluate(() => document.getElementById("panel").hasAttribute("maximized")), true);
  await region.getByRole("button", { name: "Restore" }).click();
  assert.equal(await page.evaluate(() => document.getElementById("panel").hasAttribute("maximized")), false);
  assert.deepEqual((await events(page, "prism-maximize")).map((event) => event.detail.maximized), [true, false]);
  assert.equal(await region.getByRole("heading", { level: 2, name: "Roadmap" }).count(), 1, "a panel's heading is level 2 by default");
  const island = await page.evaluate(() => {
    const probe = (property, value) => {
      const element = document.createElement("div");
      element.style.setProperty(property, value);
      document.body.append(element);
      const computed = getComputedStyle(element)[property === "box-shadow" ? "boxShadow" : property === "border-top-left-radius" ? "borderTopLeftRadius" : "borderTopColor"];
      element.remove();
      return computed;
    };
    const style = getComputedStyle(document.getElementById("island"));
    return {
      radius: [style.borderTopLeftRadius, probe("border-top-left-radius", "var(--prism-radius-island)")],
      shadow: [style.boxShadow, probe("box-shadow", "var(--prism-shadow-island)")],
      edge: [style.borderTopColor, (() => { const element = document.createElement("div"); element.style.setProperty("border-top", "1px solid var(--prism-color-island-edge)"); document.body.append(element); const color = getComputedStyle(element).borderTopColor; element.remove(); return color; })()]
    };
  });
  assert.equal(island.radius[0], island.radius[1], "an island's corners are --prism-radius-island");
  assert.equal(island.shadow[0], island.shadow[1], "an island's shadow is --prism-shadow-island");
  assert.equal(island.edge[0], island.edge[1], "an island's edge is --prism-color-island-edge");
});

test("clauses 42, 43: a tree moves, expands, collapses, and selects from the keyboard with one Tab stop", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="before">Before</prism-button>
    <prism-tree id="tree" label="Workspace">
      <prism-tree-item value="attention" label="Attention" selected><prism-badge slot="end" variant="count">2</prism-badge></prism-tree-item>
      <prism-tree-item value="initiative" label="Harden request retries">
        <prism-tree-item value="slice-a" label="Timeout retries"></prism-tree-item>
        <prism-tree-item value="slice-b" label="Observe retries"></prism-tree-item>
      </prism-tree-item>
      <prism-tree-item value="library" label="Library"></prism-tree-item>
    </prism-tree><prism-button id="after">After</prism-button>`);
  await record(page, "#tree", "prism-select");
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("tree", { name: "Workspace" }).count(), 1);
  assert.equal(await region.getByRole("treeitem", { name: /Harden request retries/ }).getAttribute("aria-expanded"), "false");
  assert.equal(await region.getByRole("treeitem", { name: /Attention/ }).getAttribute("aria-selected"), "true");
  assert.equal(await region.getByRole("treeitem", { name: /Attention/ }).getAttribute("aria-level"), "1");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  assert.equal(await focusedItem(page), "attention");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusedItem(page), "initiative");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusedItem(page), "library", "a collapsed item's children are skipped");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  assert.equal(await region.getByRole("treeitem", { name: /Harden request retries/ }).getAttribute("aria-expanded"), "true");
  assert.equal(await focusedItem(page), "initiative", "ArrowRight on a collapsed item expands it");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focusedItem(page), "slice-a", "ArrowRight on an expanded item moves to its first child");
  assert.equal(await region.getByRole("treeitem", { name: "Timeout retries" }).getAttribute("aria-level"), "2");
  assert.equal(await region.getByRole("group").count() >= 1, true, "child items sit in a group");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusedItem(page), "initiative", "ArrowLeft on a child moves to its parent");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await region.getByRole("treeitem", { name: /Harden request retries/ }).getAttribute("aria-expanded"), "false");
  await page.keyboard.press("End");
  assert.equal(await focusedItem(page), "library");
  await page.keyboard.press("Home");
  assert.equal(await focusedItem(page), "attention");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.deepEqual((await events(page, "prism-select")).map((event) => event.detail.value), ["library"]);
  assert.equal(await region.getByRole("treeitem", { name: "Library" }).getAttribute("aria-selected"), "true");
  await region.getByRole("treeitem", { name: /Attention/ }).click();
  assert.deepEqual((await events(page, "prism-select")).map((event) => event.detail.value), ["library", "attention"]);
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await focusedItem(page), "after", "only one item is in the Tab order");
});

test("clauses 38, 42: a tree with long, unbroken, and many labels stays inside a narrow container and shows full labels", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 360, height: 740 } });
  await mount(page, `<prism-tree label="Many">${Array.from({ length: 60 }, (_, index) => `<prism-tree-item value="v${index}" label="${index % 2 ? LONG : UNBROKEN}"><prism-badge slot="end">${index}</prism-badge></prism-tree-item>`).join("")}</prism-tree>`, { width: "220px" });
  assert.deepEqual(await escapes(page, "#fixture"), []);
  const item = page.locator('prism-tree-item[value="v1"]');
  assert.equal(await item.evaluate((element) => element.hasAttribute("shortened")), true);
  await item.hover();
  await page.waitForTimeout(700);
  assert.equal(await shownTooltip(page), LONG);
});

test("clause 44: a listbox driven from a field keeps focus in the field and moves its active option", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-field id="query" type="search" label="Jump to" name="q"></prism-field>
    <prism-listbox id="matches" label="Matches" for="query">
      <prism-list-item value="roadmap">Roadmap</prism-list-item>
      <prism-list-item value="slice">Timeout retries<span slot="meta">Slice</span></prism-list-item>
      <prism-list-item value="doc">docs/retry.md</prism-list-item>
    </prism-listbox>
    <prism-listbox id="plain" label="Plain"><prism-list-item value="one">One</prism-list-item><prism-list-item value="two">Two</prism-list-item></prism-listbox>`);
  await record(page, "#matches", "prism-select");
  await record(page, "#plain", "prism-select");
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("listbox", { name: "Matches" }).count(), 1);
  assert.equal(await region.getByRole("option").count(), 5);
  const search = region.getByRole("searchbox", { name: "Jump to" });
  await search.focus();
  const active = () => page.evaluate(() => {
    const control = document.querySelector("#query input");
    const id = control.getAttribute("aria-activedescendant");
    return { focusInField: document.activeElement === control, value: id ? document.getElementById(id)?.closest("prism-list-item")?.getAttribute("value") ?? document.getElementById(id)?.getAttribute("value") : null };
  });
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await active(), { focusInField: true, value: "roadmap" });
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await active(), { focusInField: true, value: "slice" });
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await events(page, "prism-select")).map((event) => event.detail.value), ["slice"]);
  await region.getByRole("listbox", { name: "Plain" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual((await events(page, "prism-select")).map((event) => event.detail.value), ["slice", "two"]);
  assert.match(await region.getByRole("option", { name: /Timeout retries/ }).innerText(), /Slice/, "an option shows its kind");
});

test("clause 45: a dialog opens modally over a blurred scrim, keeps focus inside, closes with Escape, its button, or the scrim, and returns focus", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="opener">Open the store</prism-button>
    <prism-dialog id="dialog" heading="Record store" size="md"><p>Records live in a shared store.</p><prism-field type="text" label="Filter" name="f"></prism-field><prism-button id="inside">Copy location</prism-button></prism-dialog>`);
  await record(page, "#dialog", "prism-close");
  await page.locator("#opener").focus();
  await page.evaluate(() => document.getElementById("dialog").show());
  const dialog = page.getByRole("dialog", { name: "Record store" });
  assert.equal(await dialog.count(), 1);
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  const inside = () => page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) if (node.id === "dialog") return true;
    return false;
  });
  assert.equal(await inside(), true, "focus moves into the dialog");
  for (let stop = 0; stop < 6; stop += 1) {
    await page.keyboard.press("Tab");
    assert.equal(await inside(), true, "Tab keeps focus inside the dialog");
  }
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "opener", "focus returns to the opener");
  await page.evaluate(() => document.getElementById("dialog").show());
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.evaluate(() => document.getElementById("dialog").show());
  await page.evaluate(() => document.getElementById("dialog").close());
  assert.equal((await events(page, "prism-close")).length, 3);
  await page.evaluate(() => document.getElementById("dialog").show());
  const scrim = await page.evaluate(() => {
    const dialog = document.querySelector('#fixture [role="dialog"]') ?? document.querySelector('[role="dialog"]');
    const box = dialog.getBoundingClientRect();
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    const probe = document.createElement("div");
    probe.style.setProperty("background-color", "var(--prism-color-scrim)");
    probe.style.setProperty("backdrop-filter", "blur(var(--prism-blur-scrim))");
    document.body.append(probe);
    const expected = { color: getComputedStyle(probe).backgroundColor, filter: getComputedStyle(probe).backdropFilter };
    probe.remove();
    const found = [document.documentElement, ...deep(document)].find((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.backgroundColor === expected.color && style.backdropFilter === expected.filter && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1;
    }) ?? null;
    if (!found) {
      const backdrop = getComputedStyle(document.querySelector("#dialog dialog") ?? document.querySelector("dialog") ?? document.body, "::backdrop");
      return { found: backdrop.backgroundColor === expected.color && backdrop.backdropFilter === expected.filter, outside: { x: 4, y: innerHeight - 4 }, inDialog: box };
    }
    return { found: true, outside: { x: 4, y: innerHeight - 4 }, inDialog: box };
  });
  assert.equal(scrim.found, true, "a full-window scrim paints --prism-color-scrim and blurs by --prism-blur-scrim");
  await page.mouse.click(scrim.outside.x, scrim.outside.y);
  assert.equal(await page.getByRole("dialog").count(), 0, "a click on the scrim closes the dialog");
  assert.equal((await events(page, "prism-close")).length, 4);
  for (const [placement, edge] of [["start", "left"], ["bottom", "bottom"]]) {
    await page.evaluate((placement) => { const dialog = document.getElementById("dialog"); dialog.setAttribute("placement", placement); dialog.show(); }, placement);
    const box = await page.evaluate(() => { const surface = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { left: surface.left, right: surface.right, bottom: surface.bottom, width: surface.width, window: innerWidth, height: innerHeight, drawer: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--prism-drawer-width")) }; });
    if (edge === "left") {
      assert.ok(Math.abs(box.left) <= 1, "a start dialog sits on the left edge");
      assert.ok(Math.abs(box.width - Math.min(box.drawer, box.window)) <= 1, "a start dialog is --prism-drawer-width wide");
    } else {
      assert.ok(Math.abs(box.bottom - box.height) <= 1, "a bottom dialog sits on the bottom edge");
      assert.ok(Math.abs(box.width - box.window) <= 1, "a bottom dialog spans the window");
    }
    await page.keyboard.press("Escape");
  }
});

test("clause 46: a popover opens from its button as a named non-modal dialog, closes with Escape or a click outside, and stays inside the window", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 1280, height: 800 } });
  await mount(page, `<div class="end"><prism-button id="who">3 working</prism-button></div>
    <prism-popover id="pop" for="who" heading="Who's working"><p>Claude on build-2 · Agent · implementation · 41 min left</p><prism-button id="inside">Inside</prism-button></prism-popover><prism-button id="other">Other</prism-button>`, { width: "1200px" });
  // The page's style policy refuses inline style attributes, so the right-edge layout goes through the CSSOM.
  await page.evaluate(() => { const end = document.querySelector("#fixture .end"); end.style.setProperty("display", "flex"); end.style.setProperty("justify-content", "flex-end"); });
  const button = page.locator("#fixture").getByRole("button", { name: "3 working" });
  assert.ok(await button.evaluate((element) => element.getBoundingClientRect().right > innerWidth - 120), "the button sits at the window's right edge");
  assert.equal(await button.getAttribute("aria-haspopup"), "dialog");
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  await button.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByRole("dialog", { name: "Who's working" });
  assert.equal(await popover.count(), 1);
  assert.equal(await button.getAttribute("aria-expanded"), "true");
  assert.notEqual(await popover.getAttribute("aria-modal"), "true", "a popover is not modal");
  const inside = await popover.evaluate((element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; });
  assert.equal(inside, true, "the popover stays inside the window");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Who's working" }).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "who", "Escape returns focus to the button");
  await button.click();
  await page.mouse.click(5, 790);
  assert.equal(await page.getByRole("dialog", { name: "Who's working" }).count(), 0, "a click outside closes it");
  await button.click();
  await button.click();
  assert.equal(await page.getByRole("dialog", { name: "Who's working" }).count(), 0, "its button toggles it");
  const phone = await openPage(page.context().browser(), page.url(), { viewport: { width: 390, height: 800 } });
  await mount(phone, `<prism-button id="who">3 working</prism-button><prism-popover for="who" heading="Who's working"><p>Text</p></prism-popover>`, { width: "360px" });
  await phone.locator("#fixture").getByRole("button", { name: "3 working" }).click();
  const width = await phone.getByRole("dialog", { name: "Who's working" }).evaluate((element) => [element.getBoundingClientRect().width, innerWidth]);
  assert.ok(Math.abs(width[0] - width[1]) <= 1, "at 720px and below a popover spans the window");
});

test("clause 54: a stepper lists the six phases with the current one marked and each state written out", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-stepper label="Lifecycle">
    <prism-step phase="requirements" state="done">Requirements</prism-step>
    <prism-step phase="design" state="done">Design</prism-step>
    <prism-step phase="frozen" state="done">Frozen</prism-step>
    <prism-step phase="build" state="current">Build</prism-step>
    <prism-step phase="review" state="upcoming">Review</prism-step>
    <prism-step phase="shipped" state="upcoming">Shipped</prism-step></prism-stepper>`);
  const region = page.locator("#fixture");
  const list = region.getByRole("list", { name: "Lifecycle" });
  assert.equal(await list.count(), 1);
  assert.equal(await list.getByRole("listitem").count(), 6);
  const current = await page.evaluate(() => [...document.querySelectorAll("#fixture prism-step")].map((step) => step.getAttribute("aria-current") ?? step.querySelector("[aria-current]")?.getAttribute("aria-current") ?? null));
  assert.deepEqual(current, [null, null, null, "step", null, null]);
  const spoken = await page.evaluate(() => [...document.querySelectorAll("#fixture prism-step")].map((step) => step.textContent.replace(/\s+/g, " ").trim()));
  assert.match(spoken[0], /done/i);
  assert.match(spoken[3], /current/i);
  assert.match(spoken[5], /upcoming|not started/i);
  const bars = await page.evaluate(() => {
    const token = (name) => { const probe = document.createElement("div"); probe.style.setProperty("background-color", `var(${name})`); document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; };
    const painted = (step) => [step, ...step.querySelectorAll("*")].map((node) => getComputedStyle(node).backgroundColor);
    const steps = [...document.querySelectorAll("#fixture prism-step")];
    return { build: painted(steps[3]).includes(token("--prism-color-phase-build-fill")), design: painted(steps[1]).includes(token("--prism-color-phase-design-fill")), review: painted(steps[4]).includes(token("--prism-color-line-strong")) };
  });
  assert.deepEqual(bars, { build: true, design: true, review: true }, "done and current steps draw their phase fill and upcoming ones the strong line");
});

test("clauses 38, 55: breadcrumbs are a named navigation list whose last crumb is the current page, and long crumbs shorten", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-breadcrumbs id="trail"><a href="#roadmap">Roadmap</a><a href="#init">${UNBROKEN}</a><a href="#slice">Retry timed-out requests until a total deadline</a></prism-breadcrumbs>`, { width: "300px" });
  const nav = page.locator("#fixture").getByRole("navigation", { name: "Breadcrumb" });
  assert.equal(await nav.count(), 1);
  assert.equal(await nav.getByRole("list").count(), 1);
  assert.equal(await nav.getByRole("listitem").count(), 3);
  assert.equal(await nav.getByRole("link", { name: "Retry timed-out requests until a total deadline" }).getAttribute("aria-current"), "page");
  assert.deepEqual(await escapes(page, "#fixture"), []);
  const shortened = await page.evaluate(() => [...document.querySelectorAll("#trail a")].map((link) => link.hasAttribute("shortened") || link.closest("[shortened]") !== null));
  assert.equal(shortened[1], true, "the unbroken crumb is shortened");
});

test("clause 56: menus, popovers, tooltips, dialogs, and the toast are frosted glass, and a field on glass draws its boundary in the glass control color", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-button id="m">Menu</prism-button><prism-menu for="m"><prism-menu-item value="a">A</prism-menu-item></prism-menu>
    <prism-button id="p">Popover</prism-button><prism-popover for="p" heading="Pop"><prism-field type="search" label="Filter" name="f"></prism-field></prism-popover>
    <prism-chip tip="Full text of the chip">Chip</prism-chip>
    <prism-dialog id="d" heading="Dialog"><p>Body</p></prism-dialog>`);
  const expected = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.setProperty("background-color", "var(--prism-color-glass)");
    probe.style.setProperty("backdrop-filter", "blur(var(--prism-blur-glass)) saturate(var(--prism-saturate-glass))");
    probe.style.setProperty("border-radius", "var(--prism-radius-overlay)");
    probe.style.setProperty("box-shadow", "var(--prism-shadow-glass)");
    probe.style.setProperty("border-top", "1px solid var(--prism-color-glass-edge)");
    probe.style.setProperty("outline", "1px solid var(--prism-color-glass-control)");
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const out = { background: style.backgroundColor, filter: style.backdropFilter, radius: style.borderTopLeftRadius, shadow: style.boxShadow, edge: style.borderTopColor, control: style.outlineColor };
    probe.remove();
    return out;
  });
  const surface = (role, name) => page.evaluate(([role, name]) => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    const host = deep(document).find((node) => node.getAttribute("role") === role && node.getClientRects().length && (!name || (node.getAttribute("aria-label") ?? node.textContent).includes(name)));
    if (!host) return null;
    for (let node = host; node; node = node.parentElement ?? node.getRootNode().host) {
      const style = getComputedStyle(node);
      if (style.backdropFilter !== "none") return { background: style.backgroundColor, filter: style.backdropFilter, radius: style.borderTopLeftRadius, shadow: style.boxShadow, edge: style.borderTopColor };
    }
    return { filter: "none" };
  }, [role, name]);
  const check = (found, what) => {
    assert.ok(found, `${what} is shown`);
    for (const key of ["background", "filter", "radius", "shadow", "edge"]) assert.equal(found[key], expected[key], `${what} takes the glass ${key}`);
  };
  await page.locator("#m").click();
  check(await surface("menu"), "the menu");
  await page.keyboard.press("Escape");
  await page.locator("#p").click();
  check(await surface("dialog", "Pop"), "the popover");
  const field = await page.evaluate(() => getComputedStyle(document.querySelector("prism-popover input")).borderTopColor);
  assert.equal(field, expected.control, "a field on glass draws its boundary in --prism-color-glass-control");
  await page.keyboard.press("Escape");
  await page.locator("#fixture prism-chip").hover();
  await page.waitForTimeout(700);
  check(await surface("tooltip"), "the tooltip");
  await page.evaluate(() => document.getElementById("d").show());
  check(await surface("dialog", "Dialog"), "the dialog");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector("prism-toast").show("Saved"));
  check(await surface("status", "Saved"), "the toast");
});



test("clause 47: a disclosure toggles from the keyboard and reports it", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-disclosure id="more" summary="Raw record"><p id="hidden-text">The record as stored.</p></prism-disclosure>`);
  await record(page, "#more", "toggle");
  const toggle = page.locator("#fixture").getByRole("button", { name: "Raw record" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#hidden-text").isVisible(), false);
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#hidden-text").isVisible(), true);
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal((await events(page, "toggle")).length, 2);
});

test("clauses 48, 49: empty states, banners, and toasts carry their roles and messages, and a toast stays at least four seconds", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-empty-state heading="Nothing waits for you"><p>Answered gates move to Earlier.</p></prism-empty-state>
    <prism-banner id="gone" tone="danger" heading="The review app stopped">Ask the agent to open the review browser.</prism-banner>
    <prism-banner id="private" tone="warning" heading="This page belongs to one session" dismissible>Another session may show this project elsewhere.</prism-banner>`);
  await record(page, "#private", "prism-dismiss");
  const region = page.locator("#fixture");
  assert.match(await region.innerText(), /Nothing waits for you[\s\S]*Answered gates move to Earlier\./);
  assert.equal(await region.getByRole("alert").count(), 1);
  assert.equal(await region.getByRole("status").count(), 1);
  await region.getByRole("button", { name: "Dismiss" }).click();
  assert.equal((await events(page, "prism-dismiss")).length, 1);
  const toast = await page.evaluate(() => {
    const element = document.querySelector("prism-toast");
    return element ? { role: element.getAttribute("role") ?? element.querySelector("[role]")?.getAttribute("role"), live: element.getAttribute("aria-live") ?? element.querySelector("[aria-live]")?.getAttribute("aria-live") } : null;
  });
  assert.deepEqual(toast, { role: "status", live: "polite" }, "the page has one toast region");
  await page.evaluate(() => document.querySelector("prism-toast").show("Answer sent", { tone: "success" }));
  assert.match(await page.locator("prism-toast").innerText(), /Answer sent/);
  await page.evaluate(() => document.querySelector("prism-toast").show("Second message"));
  const text = await page.locator("prism-toast").innerText();
  assert.match(text, /Second message/);
  assert.doesNotMatch(text, /Answer sent/, "a new message replaces the shown one");
  await page.waitForTimeout(3500);
  assert.match(await page.locator("prism-toast").innerText(), /Second message/, "the toast still shows after three and a half seconds");
  await page.waitForFunction(() => !document.querySelector("prism-toast").innerText.includes("Second message"), null, { timeout: 15000 });
  const still = await openPage(page.context().browser(), page.url(), { reducedMotion: "reduce" });
  await still.evaluate(() => document.querySelector("prism-toast").show("Calm message"));
  await still.waitForTimeout(3500);
  assert.match(await still.locator("prism-toast").innerText(), /Calm message/, "under reduced motion the toast stays as long");
});

test("clause 50: stats, meters, and spinners expose their values and stand still under reduced motion", { skip }, async (context) => {
  const { page } = await catalog(context, "", { reducedMotion: "reduce" });
  await mount(page, `<prism-stat label="Runs" value="12" hint="exact" tone="info"></prism-stat>
    <prism-meter id="half" label="Index build" value="40"></prism-meter><prism-meter id="busy" label="Waiting"></prism-meter>
    <prism-spinner label="Rendering the diagram"></prism-spinner>`);
  const region = page.locator("#fixture");
  assert.match(await region.innerText(), /Runs[\s\S]*12/);
  assert.equal(await region.getByRole("progressbar", { name: "Index build" }).getAttribute("aria-valuenow"), "40");
  assert.equal(await region.getByRole("progressbar", { name: "Waiting" }).getAttribute("aria-valuenow"), null);
  const bar = await page.evaluate(() => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    const meter = document.getElementById("half");
    const heights = [meter, ...deep(meter.shadowRoot ?? meter)].filter((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)").map((node) => Math.round(node.getBoundingClientRect().height));
    return { heights, token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--prism-meter-height")) };
  });
  assert.ok(bar.heights.includes(bar.token), `the meter's bar is --prism-meter-height (${bar.token}px) tall: ${bar.heights}`);
  assert.equal(await region.getByRole("status", { name: "Rendering the diagram" }).count(), 1);
  assert.deepEqual(await movingElements(page, "#fixture"), []);
});

test("clause 51: rendered Markdown and code take the kit's content styles and syntax colors", { skip }, async (context) => {
  const { page } = await catalog(context, "?theme=dark");
  await mount(page, `<prism-doc id="doc"><h2>Retries</h2><p>A <a href="#x">link</a> and <code>inline code</code>.</p><table><tr><th>Term</th><td>Deadline</td></tr></table><pre><code>plain block</code></pre></prism-doc>
    <prism-code id="code" language="javascript" numbers start="7"><pre><code><span class="tok-keyword">const</span> x = <span class="tok-string">"a"</span>;
<span class="tok-comment">// done</span> <span class="tok-unknownname">other</span></code></pre></prism-code>`);
  const styles = await page.evaluate(() => {
    const value = (name) => {
      const probe = document.createElement("span");
      probe.style.setProperty("color", `var(${name})`);
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const color = (selector) => getComputedStyle(document.querySelector(selector)).color;
    return {
      keyword: [color("#code .tok-keyword"), value("--prism-color-syntax-keyword")],
      string: [color("#code .tok-string"), value("--prism-color-syntax-string")],
      comment: [color("#code .tok-comment"), value("--prism-color-syntax-comment")],
      unknown: [color("#code .tok-unknownname"), value("--prism-color-ink")],
      inline: getComputedStyle(document.querySelector("#doc code")).fontFamily,
      block: getComputedStyle(document.querySelector("#code pre")).fontFamily,
      numbers: document.querySelector("#code").textContent.includes("7") || [...document.querySelectorAll("#code *")].some((node) => getComputedStyle(node, "::before").content.includes("7"))
    };
  });
  assert.equal(styles.keyword[0], styles.keyword[1]);
  assert.equal(styles.string[0], styles.string[1]);
  assert.equal(styles.comment[0], styles.comment[1]);
  assert.equal(styles.unknown[0], styles.unknown[1], "a token name the theme does not define falls back to the ink color");
  assert.match(styles.inline, /^"?Prism Code"?/);
  assert.match(styles.block, /^"?Prism Code"?/);
  assert.equal(styles.numbers, true, "line numbers start at 7");
  assert.deepEqual(await contrastFailures(page, "#fixture"), []);
});

test("contents sit beside a document, fit the visible part of their scroller, scroll only their list to the current entry, and take tools in their header", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 1440, height: 900 } });
  const sections = Array.from({ length: 40 }, (_, index) => index + 1);
  await mount(page, `<div id="scroller"><div id="box"><prism-contents id="contents"><prism-maximize slot="tools" id="tool"></prism-maximize><ol>${sections.map((index) => `<li><a href="#s${index}">Section ${index}</a></li>`).join("")}</ol></prism-contents><prism-doc>${sections.map((index) => `<h3 id="s${index}">Section ${index}</h3><p>Text.</p>`).join("")}</prism-doc></div></div>`, { width: "1000px" });
  const shown = await page.evaluate(async () => {
    const scroller = document.getElementById("scroller");
    const contents = document.getElementById("contents");
    // The page's policy refuses style attributes in markup, so the scrolling box gets its size from the style object.
    scroller.style.setProperty("height", "400px");
    scroller.style.setProperty("overflow", "auto");
    scroller.scrollTop = 600;
    contents.fit(scroller);
    contents.markCurrent(contents.links.at(-1));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const area = scroller.getBoundingClientRect();
    const body = contents.querySelector(".prism-contents-body").getBoundingClientRect();
    const list = contents.querySelector(".prism-contents-list");
    const current = contents.links.at(-1).getBoundingClientRect();
    const frame = list.getBoundingClientRect();
    return {
      beside: contents.getBoundingClientRect().left > document.querySelector("#box prism-doc").getBoundingClientRect().right,
      inside: body.top >= area.top - 1 && body.bottom <= area.bottom + 1,
      listScrolled: list.scrollTop > 0,
      currentShown: current.top >= frame.top - 1 && current.bottom <= frame.bottom + 1,
      marked: contents.querySelectorAll('a[aria-current="location"]').length,
      toolInHeader: document.getElementById("tool").parentElement.classList.contains("prism-contents-tools"),
      named: contents.getAttribute("role") === "navigation" && contents.getAttribute("aria-label") === "Contents"
    };
  });
  assert.deepEqual(shown, { beside: true, inside: true, listScrolled: true, currentShown: true, marked: 1, toolInHeader: true, named: true });
  assert.equal(await page.locator("#contents .prism-contents-toggle").isVisible(), false, "beside a document the header is a title, not a fold toggle");
  assert.deepEqual(page.errors, []);
});

test("contents above a document in a narrow window fold from their header", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 900, height: 800 } });
  await mount(page, `<div><prism-contents id="contents"><ol><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ol></prism-contents><prism-doc><h3 id="a">A</h3><h3 id="b">B</h3></prism-doc></div>`);
  const toggle = page.locator("#contents .prism-contents-toggle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#contents ol").isVisible(), false);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#contents ol").isVisible(), true);
});

test("a maximize button asks for the other state and leaves applying it to its owner", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-maximize id="button"></prism-maximize>`);
  await record(page, "#button", "prism-maximize-request");
  const region = page.locator("#fixture");
  await region.getByRole("button", { name: "Maximize" }).click();
  assert.equal(await page.evaluate(() => document.getElementById("button").hasAttribute("maximized")), false, "the button does not change its own state");
  await page.evaluate(() => document.getElementById("button").setAttribute("maximized", ""));
  await region.getByRole("button", { name: "Restore" }).click();
  assert.deepEqual((await events(page, "prism-maximize-request")).map((event) => event.detail.maximized), [true, false]);
});
