import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// A claim that records the session a person can open leads to it wherever the review app shows the claim in words: an inline claim, a
// strip, and the claim's row on the Agents page end with a Session link chip that opens the session in a new tab, while an avatar and a
// claim without a session, or with a session of a kind this release does not know, show no link.
const SESSION = { kind: "claude-code-web", id: "cse_018gSB8BexampleLinkId" };
const URL_OF_SESSION = "https://claude.ai/code/session_018gSB8BexampleLinkId";

// Every Session chip in the page, with the claim or row it belongs to.
const chips = (page) => page.evaluate(() => [...document.querySelectorAll("prism-chip.prism-claim-session, prism-chip.agents-session")].filter((chip) => chip.getClientRects().length).map((chip) => ({
  owner: chip.closest("prism-claim")?.getAttribute("label") ?? chip.closest("[data-agent]")?.dataset.agent ?? null,
  href: chip.getAttribute("href"),
  target: chip.getAttribute("target"),
  text: chip.textContent.trim(),
  tip: chip.getAttribute("tip"),
  rel: chip.shadowRoot?.querySelector("a")?.getAttribute("rel") ?? null
})));

async function project(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Michael on runner", host: "Claude Code", session: SESSION, minutesLeft: 41 });
  await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Dana on studio-mac", host: "Codex", session: { kind: "another-host", id: "run-7" }, minutesLeft: 30 });
  const { base } = await serveProject(context, root);
  return { base, browser: await launch(context) };
}

test("§8 a claim with an openable session links to it on the slice and initiative pages, and nothing else links", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await project(context);
  for (const ref of ["slice:retry-hardening/timeout-retries", "initiative:retry-hardening"]) {
    const page = await openPage(browser, reviewUrl(base, ref), { viewport: { width: 1440, height: 900 } });
    await waitForView(page);
    const found = await settled(() => chips(page), (list) => list.length > 0);
    assert.ok(found.length > 0, `${ref} shows the session link`);
    for (const chip of found) {
      assert.equal(chip.owner, "Michael on runner", `${ref}: only the claim with a known session kind links`);
      assert.equal(chip.href, URL_OF_SESSION);
      assert.equal(chip.target, "_blank");
      assert.equal(chip.text, "Session");
      assert.equal(chip.rel, "noopener noreferrer");
      assert.match(chip.tip, /in Claude Code on the web in a new tab\. Only the person whose session it is can open it\.$/);
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test("§8 the Agents page links a claim's row to its session, and a row without one shows no link", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await project(context);
  const page = await openPage(browser, reviewUrl(base, "agents"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const found = await settled(() => chips(page), (list) => list.length > 0);
  assert.deepEqual(found.map((chip) => [chip.owner, chip.href, chip.target]), [["claim:retry-hardening/timeout-retries", URL_OF_SESSION, "_blank"]]);
  assert.deepEqual(page.errors, []);
});

test("§8 a prism-claim links only an https session address, and an avatar never links", { skip }, async (context) => {
  const { base, browser } = await project(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  await page.waitForFunction(() => customElements.get("prism-claim") !== undefined, null, { timeout: 5000 });
  const shown = await page.evaluate(() => [["inline", "https://claude.ai/code/session_1"], ["strip", "https://claude.ai/code/session_1"], ["avatar", "https://claude.ai/code/session_1"], ["inline", "javascript:alert(1)"], ["inline", "http://claude.ai/code/session_1"], ["inline", ""]].map(([variant, url]) => {
    const claim = document.createElement("prism-claim");
    claim.setAttribute("variant", variant);
    claim.setAttribute("label", "Dana on studio-mac");
    claim.setAttribute("session-url", url);
    document.body.append(claim);
    const href = claim.querySelector("prism-chip.prism-claim-session")?.getAttribute("href") ?? null;
    claim.remove();
    return href;
  }));
  assert.deepEqual(shown, ["https://claude.ai/code/session_1", "https://claude.ai/code/session_1", null, null, null, null]);
});
