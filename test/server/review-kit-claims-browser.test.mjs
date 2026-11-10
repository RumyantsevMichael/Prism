import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contrastFailures, launch, movingElements, openPage, serveProject, shownTooltip, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §7, §8, §10.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 52, 53, and 57.
// Avatars and claims are exercised through their public attributes on the served catalog page.

const minutes = (count) => new Date(Date.now() + count * 60000).toISOString();

async function catalog(context, query = "", options = {}) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-claims-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog${query}`, options);
  await page.waitForFunction(() => customElements.get("prism-claim") !== undefined, null, { timeout: 5000 });
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

// The computed value of a color token, in the form getComputedStyle reports colors.
const token = (page, name, property = "background-color") => page.evaluate(([name, property]) => {
  const probe = document.createElement("div");
  probe.style.setProperty(property, `var(${name})`);
  document.body.append(probe);
  const value = getComputedStyle(probe)[property === "color" ? "color" : "backgroundColor"];
  probe.remove();
  return value;
}, [name, property]);

// Every element of an element's flat tree, through shadow roots.
const paints = (page, selector) => page.evaluate((selector) => {
  const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
  const host = document.querySelector(selector);
  return [host, ...deep(host.shadowRoot ?? host), ...deep(host)].filter((node) => node.getClientRects().length).map((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, radius: style.borderTopLeftRadius, border: style.borderTopStyle, width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height), animation: style.animationName, text: node.childElementCount ? "" : node.textContent.trim() };
  });
}, selector);

test("clause 52: an agent avatar is a rounded square with the agent glyph and a person avatar a circle with initials, each named and sized from the design values", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-avatar id="agent" kind="agent" name="Claude on build-2"></prism-avatar>
    <prism-avatar id="person" kind="person" name="Mira Okafor" hue="2" size="lg"></prism-avatar>
    <prism-avatar id="small" kind="agent" name="Codex on ci" size="sm"></prism-avatar>`);
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("img", { name: "Claude on build-2 (agent)" }).count(), 1, "an agent is named with (agent)");
  assert.equal(await region.getByRole("img", { name: "Mira Okafor", exact: true }).count(), 1, "a person is named by name");
  const sizes = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    return { md: [Math.round(box("agent").width), parseFloat(root.getPropertyValue("--prism-avatar-size"))], lg: [Math.round(box("person").width), parseFloat(root.getPropertyValue("--prism-avatar-size-lg"))], sm: [Math.round(box("small").width), parseFloat(root.getPropertyValue("--prism-avatar-size-sm"))] };
  });
  for (const [size, [width, expected]] of Object.entries(sizes)) assert.equal(width, expected, `a ${size} avatar is ${expected}px`);
  const agent = await paints(page, "#agent");
  const person = await paints(page, "#person");
  const agentFill = await token(page, "--prism-color-agent");
  const personFill = await token(page, "--prism-color-person-2");
  const filled = (shapes, fill) => shapes.find((shape) => shape.background === fill);
  assert.ok(filled(agent, agentFill), "the agent avatar paints --prism-color-agent");
  assert.ok(filled(person, personFill), "the person avatar paints --prism-color-person-2");
  const radius = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--prism-radius-sm").trim());
  assert.equal(filled(agent, agentFill).radius, radius, "the agent avatar has --prism-radius-sm corners");
  assert.ok(parseFloat(filled(person, personFill).radius) >= filled(person, personFill).width / 2, "the person avatar is a circle");
  assert.ok(agent.some((shape) => shape.text === "") && await page.evaluate(() => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    return deep(document.getElementById("agent").shadowRoot).some((node) => node.tagName.toLowerCase() === "prism-icon" && node.getAttribute("name") === "agent" || node.tagName.toLowerCase() === "svg");
  }), "the agent avatar draws the agent glyph");
  assert.ok(person.some((shape) => shape.text === "MO"), "the person avatar shows the initials of the first two words");
  assert.deepEqual(await contrastFailures(page, "#fixture"), []);
});

test("clause 52: a live avatar shows the live dot, a breathing one pulses unless motion is reduced, and an expired one is hollow and dashed", { skip }, async (context) => {
  const { browser, page } = await catalog(context);
  await mount(page, `<prism-avatar id="live" kind="agent" name="A" live></prism-avatar><prism-avatar id="breathing" kind="agent" name="B" live breathing></prism-avatar><prism-avatar id="expired" kind="agent" name="C" expired live></prism-avatar>`);
  const live = await token(page, "--prism-color-live");
  const agentFill = await token(page, "--prism-color-agent");
  assert.ok((await paints(page, "#live")).some((shape) => shape.background === live), "a live avatar shows a dot in --prism-color-live");
  assert.ok((await paints(page, "#breathing")).some((shape) => shape.background === live && shape.animation !== "none"), "a breathing dot animates");
  assert.ok(!(await paints(page, "#live")).some((shape) => shape.background === live && shape.animation !== "none"), "a live dot that does not breathe stands still");
  const expired = await paints(page, "#expired");
  assert.ok(!expired.some((shape) => shape.background === live), "an expired avatar shows no dot");
  assert.ok(!expired.some((shape) => shape.background === agentFill), "an expired avatar is hollow");
  assert.ok(expired.some((shape) => shape.border === "dashed"), "an expired avatar has a dashed outline");
  const still = await openPage(browser, page.url(), { reducedMotion: "reduce" });
  await mount(still, `<prism-avatar id="breathing" kind="agent" name="B" live breathing></prism-avatar>`);
  assert.deepEqual(await movingElements(still, "#fixture"), [], "under reduced motion the dot stands still");
});

test("clause 53: a claim names its agent holder, the activity in words with its phase facet, and the time left, and holds no control", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-claim id="inline" variant="inline" label="Claude on build-2" activity="implementation" claimed-at="${minutes(-20)}" renewed-at="${minutes(-1)}" expires-at="${minutes(40.5)}"></prism-claim>
    <prism-claim id="design" variant="inline" label="Codex on ci" activity="design" claimed-at="${minutes(-200)}" renewed-at="${minutes(-1)}" expires-at="${minutes(180)}"></prism-claim>
    <prism-claim id="expired" variant="inline" label="Claude on vm" activity="design" claimed-at="${minutes(-60)}" renewed-at="${minutes(-34)}" expires-at="${minutes(-4)}"></prism-claim>`);
  const text = (id) => page.locator(`#${id}`).innerText();
  assert.match(await text("inline"), /Claude on build-2[\s\S]*Agent[\s\S]*implementation[\s\S]*41 min left/);
  assert.match(await text("design"), /Codex on ci[\s\S]*Agent[\s\S]*design[\s\S]*3 h left/);
  assert.match(await text("expired"), /Claude on vm[\s\S]*Expired 4 min ago/);
  const region = page.locator("#fixture");
  assert.equal(await region.getByRole("img", { name: "Claude on build-2 (agent)" }).count(), 1, "the claim shows the agent avatar");
  assert.equal(await region.getByRole("button").count() + await region.getByRole("link").count(), 0, "a claim holds no control");
  const build = await token(page, "--prism-color-phase-build");
  const buildFill = await token(page, "--prism-color-phase-build-fill");
  const design = await token(page, "--prism-color-phase-design");
  const designFill = await token(page, "--prism-color-phase-design-fill");
  const facet = (shapes, colors) => shapes.some((shape) => colors.includes(shape.background) || colors.includes(shape.color));
  assert.ok(facet(await paints(page, "#inline"), [build, buildFill]), "implementation carries the build phase color");
  assert.ok(facet(await paints(page, "#design"), [design, designFill]), "design carries the design phase color");
  const warning = await token(page, "--prism-color-warning", "color");
  assert.ok((await paints(page, "#expired")).some((shape) => /Expired 4 min ago/.test(shape.text) && shape.color === warning), "the expiry is written in the warning color");
  assert.ok((await paints(page, "#expired")).some((shape) => shape.border === "dashed"), "the expired claim's avatar is hollow and dashed");
  assert.deepEqual(await contrastFailures(page, "#fixture"), []);
});

test("clause 53: an avatar claim shows its text as a tooltip, a strip adds since and a lease meter, and the time left updates every minute", { skip }, async (context) => {
  const { page } = await catalog(context);
  await page.clock.install({ time: new Date() });
  const now = await page.evaluate(() => Date.now());
  const at = (count) => new Date(now + count * 60000).toISOString();
  await mount(page, `<prism-claim id="avatar" variant="avatar" label="Claude on build-2" activity="implementation" claimed-at="${at(-20)}" renewed-at="${at(-10)}" expires-at="${at(20)}"></prism-claim>
    <prism-claim id="strip" variant="strip" label="Claude on build-2" activity="implementation" claimed-at="${at(-20)}" renewed-at="${at(-10)}" expires-at="${at(20)}"></prism-claim>`);
  const avatar = page.locator("#avatar");
  assert.doesNotMatch(await avatar.innerText(), /min left/, "an avatar claim shows only the avatar");
  const description = await page.evaluate(() => {
    const host = document.getElementById("avatar");
    const described = host.getAttribute("aria-describedby") ?? host.querySelector("[aria-describedby]")?.getAttribute("aria-describedby");
    return { tip: host.getAttribute("tip") ?? host.querySelector("[tip]")?.getAttribute("tip") ?? "", described: Boolean(described) || Boolean(host.getAttribute("aria-description") ?? host.querySelector("[aria-description]")) };
  });
  assert.match(description.tip, /Claude on build-2[\s\S]*implementation[\s\S]*20 min left/);
  assert.equal(description.described, true, "the avatar carries its text as its accessible description");
  await avatar.hover();
  await page.clock.runFor(700);
  assert.match(await shownTooltip(page) ?? "", /20 min left/);
  const strip = page.locator("#strip");
  assert.match(await strip.innerText(), /since/);
  const meter = strip.getByRole("progressbar");
  assert.equal(await meter.count(), 1, "a strip shows a lease meter");
  assert.equal(await meter.getAttribute("aria-valuenow"), "67", "the meter shows the time left out of the lease");
  await page.clock.runFor(60000 * 2 + 500);
  assert.match(await strip.innerText(), /18 min left/, "the time left updates without a reload");
});

test("clause 57: the catalog has entries with live specimens for avatars and claims, including an expired claim", { skip }, async (context) => {
  const { page } = await catalog(context);
  const entries = await page.evaluate(() => Object.fromEntries(["prism-avatar", "prism-claim"].map((tag) => {
    const section = document.querySelector(`[data-catalog-entry="${tag}"]`);
    return [tag, section ? [...section.querySelectorAll("[data-specimen]")].map((specimen) => specimen.dataset.specimen) : null];
  })));
  assert.ok(entries["prism-avatar"]?.includes("long-text") && entries["prism-avatar"].includes("unbroken-name"), "the avatar entry shows long and unbroken names");
  assert.ok(entries["prism-claim"]?.includes("long-text") && entries["prism-claim"].includes("unbroken-name"), "the claim entry shows long and unbroken names");
  assert.ok(entries["prism-claim"].some((name) => /expired/i.test(name)), "the claim entry shows an expired claim");
});
