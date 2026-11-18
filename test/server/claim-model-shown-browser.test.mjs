import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

// A claim reads the same wherever the review app shows it: the harness its agent runs in, or Agent when the claim names none, and the
// model only when the claim records one, on the claim element of the kit and on every slice, initiative, roadmap, and sidebar claim.
const minutes = (count) => new Date(Date.now() + count * 60000).toISOString();

async function catalog(context) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-claim-model-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  await page.waitForFunction(() => customElements.get("prism-claim") !== undefined, null, { timeout: 5000 });
  return page;
}

test("§27 a prism-claim names its harness and model as Harness · model, Agent without a harness, and no model it was not given", { skip }, async (context) => {
  const page = await catalog(context);
  const shown = await page.evaluate((expires) => {
    const cases = [["Codex", "gpt-5.5"], ["", "gpt-5.5"], ["Claude Code", ""], ["", ""]];
    return cases.map(([host, model]) => {
      const claim = document.createElement("prism-claim");
      claim.setAttribute("label", "Dana on studio-mac");
      claim.setAttribute("activity", "design");
      claim.setAttribute("expires-at", expires);
      if (host) claim.setAttribute("host", host);
      if (model) claim.setAttribute("model", model);
      document.body.append(claim);
      const result = { kind: claim.querySelector(".prism-claim-kind")?.textContent ?? null, tooltip: claim.tooltipText };
      claim.setAttribute("variant", "avatar");
      result.avatar = claim.tooltipText;
      claim.remove();
      return result;
    });
  }, minutes(22));
  assert.deepEqual(shown.map((item) => item.kind), ["Codex · gpt-5.5", "Agent · gpt-5.5", "Claude Code", "Agent"]);
  assert.match(shown[0].tooltip, /^Dana on studio-mac · Codex · gpt-5\.5 · design · /);
  assert.match(shown[0].avatar, /^Dana on studio-mac · Codex · gpt-5\.5 · design · /, "an avatar claim's text names the model too");
  assert.match(shown[2].tooltip, /^Dana on studio-mac · Claude Code · design · /);
  const updated = await page.evaluate(() => {
    const claim = document.createElement("prism-claim");
    claim.setAttribute("label", "Sam on ci-runner-04");
    claim.setAttribute("host", "Claude Code");
    document.body.append(claim);
    claim.setAttribute("model", "Sonnet 5.5");
    const after = claim.querySelector(".prism-claim-kind").textContent;
    claim.remove();
    return after;
  });
  assert.equal(updated, "Claude Code · Sonnet 5.5", "a model set later redraws the claim");
  const entry = await page.evaluate(() => customElements.get("prism-claim").catalog.options.map((option) => option.name));
  assert.ok(entry.includes("model"), "the catalog lists the model option");
});

test("§27 every claim on a slice, an initiative, the roadmap, and the sidebar names the harness and model its claim records", { skip, timeout: 90000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Prism Test on build-2", host: "Codex", model: "gpt-5.5", minutesLeft: 41 });
  await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Prism Test on ci", minutesLeft: 30 });
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  // What every claim of a holder reads as: its own kind line, or the text it shows as a tooltip.
  const readings = (page, label) => page.evaluate((label) => [...document.querySelectorAll("prism-claim")].filter((claim) => claim.getAttribute("label") === label).map((claim) => [claim.querySelector(".prism-claim-kind")?.textContent ?? null, claim.tooltipText]), label);
  for (const ref of ["slice:retry-hardening/timeout-retries", "initiative:retry-hardening", "roadmap"]) {
    const page = await openPage(browser, reviewUrl(base, ref), { viewport: { width: 1440, height: 900 } });
    await waitForView(page);
    const modelled = await settled(() => readings(page, "Prism Test on build-2"), (list) => list.length > 0);
    assert.ok(modelled.length > 0, `${ref} shows the claim`);
    for (const [kind, tooltip] of modelled) {
      if (kind !== null) assert.equal(kind, "Codex · gpt-5.5", `${ref}: the claim's kind`);
      assert.match(tooltip, /^Prism Test on build-2 · Codex · gpt-5\.5 · /, `${ref}: the claim's text`);
    }
    for (const [kind, tooltip] of await readings(page, "Prism Test on ci")) {
      if (kind !== null) assert.equal(kind, "Agent", `${ref}: a claim with no harness or model`);
      assert.match(tooltip, /^Prism Test on ci · Agent · implementation · /);
    }
    await page.getByRole("navigation", { name: "Places" }).getByRole("button", { name: /^Work/ }).click();
    await page.locator("#sidebar prism-claim").first().waitFor({ state: "attached" });
    await repainted(page);
    const sidebar = await readings(page, "Prism Test on build-2");
    assert.ok(sidebar.some(([, tooltip]) => tooltip.startsWith("Prism Test on build-2 · Codex · gpt-5.5 ·")), `${ref}: the sidebar's claim names the model: ${JSON.stringify(sidebar)}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});
