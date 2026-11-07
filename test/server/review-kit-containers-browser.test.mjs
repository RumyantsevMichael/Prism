import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundaryFailures, contrastFailures, escapes, launch, movingElements, openPage, ROOT, serveProject, shownTooltip, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §7, §8, §9, §10.
// The containers and content blocks are exercised through their public attributes, events, and keys on the served catalog page.

const CONTAINERS = ["prism-panel", "prism-tree", "prism-tree-item", "prism-listbox", "prism-list-item", "prism-dialog", "prism-disclosure", "prism-empty-state", "prism-banner", "prism-toast", "prism-stat", "prism-meter", "prism-spinner", "prism-doc", "prism-code"];
const HOLDS_ITEMS = ["prism-tree", "prism-listbox", "prism-panel"];
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

const focusedItem = (page) => page.evaluate(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
    if (["prism-tree-item", "prism-list-item"].includes(node.tagName?.toLowerCase())) return node.getAttribute("value");
  }
  return element?.id || element?.tagName.toLowerCase() || null;
});

const record = (page, selector, type) => page.evaluate(([selector, type]) => {
  window.__events ??= [];
  document.querySelector(selector).addEventListener(type, (event) => window.__events.push({ type, detail: event.detail ?? null }));
}, [selector, type]);
const events = (page, type) => page.evaluate((type) => (window.__events ?? []).filter((event) => event.type === type), type);

test("the kit registry and the catalog hold every container with live specimens", { skip }, async (context) => {
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

test("text and control boundaries in the container entries reach WCAG AA in both themes and densities, and they stay inside a phone width", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await catalog(context);
  const selector = CONTAINERS.map((tag) => `[data-catalog-entry="${tag}"]`).join(", ");
  for (const theme of ["light", "dark"]) {
    for (const density of ["compact", "comfortable"]) {
      const page = await openPage(browser, `${base}/kit/catalog?theme=${theme}&density=${density}`, { viewport: { width: 360, height: 740 } });
      assert.equal(await page.locator(selector).count(), CONTAINERS.length, "the catalog shows every container entry");
      assert.deepEqual(await contrastFailures(page, selector), [], `text contrast, ${theme} ${density}`);
      assert.deepEqual(await boundaryFailures(page, selector), [], `control boundaries, ${theme} ${density}`);
      assert.deepEqual(await escapes(page, selector), [], `layout, ${theme} ${density}`);
      await page.context().close();
    }
  }
});

test("a panel renders its heading, tools, body, and footer, and toggles maximized", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-panel id="panel" heading="Contract" level="3" eyebrow="Slice" source="docs/plans/a/slice.md" maximizable>
    <prism-button slot="tools">Open</prism-button><p id="body">Body text</p><p slot="footer" id="foot">Footer</p></prism-panel>`);
  await record(page, "#panel", "prism-maximize");
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("heading", { level: 3, name: "Contract" }).count(), 1);
  assert.match(await region.innerText(), /docs\/plans\/a\/slice\.md/);
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
});

test("a tree moves, expands, collapses, and selects from the keyboard with one Tab stop", { skip }, async (context) => {
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

test("a tree with long, unbroken, and many labels stays inside a narrow container and shows full labels", { skip }, async (context) => {
  const { page } = await catalog(context, "", { viewport: { width: 360, height: 740 } });
  await mount(page, `<prism-tree label="Many">${Array.from({ length: 60 }, (_, index) => `<prism-tree-item value="v${index}" label="${index % 2 ? LONG : UNBROKEN}"><prism-badge slot="end">${index}</prism-badge></prism-tree-item>`).join("")}</prism-tree>`, { width: "220px" });
  assert.deepEqual(await escapes(page, "#fixture"), []);
  const item = page.locator('prism-tree-item[value="v1"]');
  assert.equal(await item.evaluate((element) => element.hasAttribute("shortened")), true);
  await item.hover();
  await page.waitForTimeout(700);
  assert.equal(await shownTooltip(page), LONG);
});

test("a listbox driven from a field keeps focus in the field and moves its active option", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-field id="query" type="search" label="Jump to" name="q"></prism-field>
    <prism-listbox id="matches" label="Matches" for="query">
      <prism-list-item value="roadmap">Roadmap</prism-list-item>
      <prism-list-item value="slice">Timeout retries</prism-list-item>
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
});

test("a dialog opens modally, keeps focus inside, closes with Escape or its button, and returns focus", { skip }, async (context) => {
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
});

test("a disclosure toggles from the keyboard and reports it", { skip }, async (context) => {
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

test("empty states, banners, and toasts carry their roles and messages", { skip }, async (context) => {
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
  await page.waitForFunction(() => !document.querySelector("prism-toast").innerText.includes("Second message"), null, { timeout: 15000 });
});

test("stats, meters, and spinners expose their values and stand still under reduced motion", { skip }, async (context) => {
  const { page } = await catalog(context, "", { reducedMotion: "reduce" });
  await mount(page, `<prism-stat label="Runs" value="12" hint="exact" tone="info"></prism-stat>
    <prism-meter id="half" label="Index build" value="40"></prism-meter><prism-meter id="busy" label="Waiting"></prism-meter>
    <prism-spinner label="Rendering the diagram"></prism-spinner>`);
  const region = page.locator("#fixture");
  assert.match(await region.innerText(), /Runs[\s\S]*12/);
  assert.equal(await region.getByRole("progressbar", { name: "Index build" }).getAttribute("aria-valuenow"), "40");
  assert.equal(await region.getByRole("progressbar", { name: "Waiting" }).getAttribute("aria-valuenow"), null);
  assert.equal(await region.getByRole("status", { name: "Rendering the diagram" }).count(), 1);
  assert.deepEqual(await movingElements(page, "#fixture"), []);
});

test("rendered Markdown and code take the kit's content styles and syntax colors", { skip }, async (context) => {
  const { page } = await catalog(context, "?theme=dark");
  await mount(page, `<prism-doc id="doc"><h2>Retries</h2><p>A <a href="#x">link</a> and <code>inline code</code>.</p><table><tr><th>Term</th><td>Deadline</td></tr></table><pre><code>plain block</code></pre></prism-doc>
    <prism-code id="code" language="javascript" numbers start="7"><pre><code><span class="tok-keyword">const</span> x = <span class="tok-string">"a"</span>;
<span class="tok-comment">// done</span></code></pre></prism-code>`);
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
      inline: getComputedStyle(document.querySelector("#doc code")).fontFamily,
      block: getComputedStyle(document.querySelector("#code pre")).fontFamily,
      numbers: document.querySelector("#code").textContent.includes("7") || [...document.querySelectorAll("#code *")].some((node) => getComputedStyle(node, "::before").content.includes("7"))
    };
  });
  assert.equal(styles.keyword[0], styles.keyword[1]);
  assert.equal(styles.string[0], styles.string[1]);
  assert.equal(styles.comment[0], styles.comment[1]);
  assert.match(styles.inline, /^"?Prism Code"?/);
  assert.match(styles.block, /^"?Prism Code"?/);
  assert.equal(styles.numbers, true, "line numbers start at 7");
  assert.deepEqual(await contrastFailures(page, "#fixture"), []);
});
