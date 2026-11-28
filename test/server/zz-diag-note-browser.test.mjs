import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory, waitForView, writableReviewUrl } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

// The review page's canvases, scrolling, and refreshes: Attention's list and detail scroll apart, graphs and diagrams draw on a dotted grid that follows their zoom,
// a long menu keeps its scroll position, a text area grows with its text, a contents link scrolls smoothly, and a refresh never shows a half-built view.

async function stressPage(context, ref, options = {}) {
  await useAppDirectory(context);
  const root = await demoProject(context, "seed-stress.mjs");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, ref), options);
  return { root, base, page };
}

const graphView = async (page) => {
  await page.locator("#artifact").getByText("Graph", { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#artifact prism-canvas.graph-viewport svg"), null, { timeout: 15000 });
  await repainted(page);
};


// TEMPORARY diagnostic for the Windows-only failures of #494 and #480; never merged.
const tracer = () => {
  window.__log = [];
  window.__snaps = [];
  const t0 = performance.now();
  const log = (m) => window.__log.push(`${Math.round(performance.now() - t0)} ${m}`);
  window.__mark = log;
  const where = () => new Error().stack.split("\n").slice(2, 6).map((l) => l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^)]*\/(session\/[^/]+\/)?/, "").replace(/\)$/, "")).join(" < ");
  const proto = HTMLTextAreaElement.prototype;
  const focus = proto.focus;
  proto.focus = function (...a) { log(`focus() conn=${this.isConnected} ${where()}`); return focus.apply(this, a); };
  const ssr = proto.setSelectionRange;
  proto.setSelectionRange = function (...a) { log(`ssr(${a.slice(0, 2)}) conn=${this.isConnected} ${where()}`); return ssr.apply(this, a); };
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(proto, "value", { get() { return desc.get.call(this); }, set(v) { if (v) log(`value=${String(v).length} conn=${this.isConnected} ${where()}`); desc.set.call(this, v); }, configurable: true });
  const fetch0 = window.fetch;
  window.fetch = async (...a) => {
    const url = String(a[0]?.url ?? a[0]);
    const response = await fetch0(...a);
    if (/api\/(entity|events|actions)/.test(url)) {
      log(`fetch ${(a[1]?.method ?? "GET")} ${url.replace(/^.*\/api\//, "")} ${response.status}`);
      if (url.includes("entity?ref=attention")) response.clone().text().then((text) => { if (window.__snaps.at(-1)?.text !== text) { window.__snaps.push({ at: Math.round(performance.now() - t0), text }); log(`snapshot changed #${window.__snaps.length}`); } });
    }
    return response;
  };
  document.addEventListener("focusin", (e) => log(`focusin ${e.target.localName}`), true);
  document.addEventListener("focusout", (e) => log(`focusout ${e.target.localName} -> ${e.relatedTarget?.localName ?? "none"}`), true);
  const start = () => new MutationObserver((records) => { for (const r of records) { for (const n of r.addedNodes) if (n.classList?.contains("artifact-stage")) log("STAGE begin"); for (const n of r.removedNodes) if (n.querySelector?.("textarea")) log(`removed textarea from ${r.target.id || r.target.className || r.target.localName}`); } }).observe(document.body, { childList: true, subtree: true });
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
};
// The paths whose values differ between two snapshots, at most a few.
const differences = (a, b, path = "", out = []) => {
  if (out.length > 12) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) { if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`); return out; }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${path}.${key}`, out);
  return out;
};
async function report(page, label) {
  const { log, snaps } = await page.evaluate(() => ({ log: window.__log, snaps: window.__snaps }));
  const changes = snaps.slice(1).map((snap, index) => `#${index + 2} at ${snap.at}: ${differences(JSON.parse(snaps[index].text), JSON.parse(snap.text)).join(" | ")}`);
  console.log(`TRACE ${label}\n${log.join("\n")}\nCHANGES\n${changes.join("\n")}`);
}
const info = (element) => {
  const rect = element.getBoundingClientRect();
  return { h: rect.height, val: element.value.length, conn: element.isConnected, active: document.activeElement === element, at: element.selectionStart };
};

for (let round = 1; round <= 12; round += 1) test(`DIAG2 note grows ${round}`, { skip, timeout: 90000 }, async (context) => {
  await useAppDirectory(context);
  const page = await openPage(await launch(context), await writableReviewUrl(context, await demoProject(context, "seed-stress.mjs"), "attention"), { viewport: { width: 1440, height: 900 }, prepare: (browserContext) => browserContext.addInitScript(tracer) });
  const note = page.locator('.attention-sheet:not([hidden]) .gate-answer prism-field[data-field="note"] textarea');
  const empty = await note.evaluate(info);
  await page.evaluate(() => window.__mark("--- fill"));
  await note.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of a longer note.`).join("\n"));
  await page.evaluate(() => window.__mark("--- filled"));
  await repainted(page);
  const grown = await note.evaluate(info);
  const ok = grown.h > empty.h;
  console.log(`DIAG2 ${round} ${ok ? "PASS" : "FAIL"} ${JSON.stringify({ empty, grown })}`);
  if (!ok || round === 1) await report(page, `494 round ${round}`);
});

async function writableAttention(context, viewport, init) {
  await useAppDirectory(context);
  const url = await writableReviewUrl(context, await demoProject(context), "attention");
  const page = await openPage(await launch(context), url, { viewport, prepare: (browserContext) => browserContext.addInitScript(init) });
  await waitForView(page);
  return page;
}

const pick = async (page, text) => {
  await page.locator("prism-inbox-item").filter({ hasText: text }).first().click();
  await repainted(page);
};

const SHEET = ".attention-sheet:not([hidden])";
const answerOf = (page) => page.locator(`${SHEET} .gate-answer-form`);
const shownText = (locator) => locator.evaluate((element) => element.innerText.replace(/\s+/g, " ").trim());
const submitOf = (answer) => answer.locator("prism-button[data-apply]");

async function submitState(answer) {
  const submit = submitOf(answer);
  return { label: await shownText(submit), variant: await submit.getAttribute("variant"), disabled: await submit.evaluate((element) => element.hasAttribute("disabled")) };
}

for (let round = 1; round <= 10; round += 1) test(`DIAG3 cursor ${round} survives another answer of the same initiative: the note keeps its text and focus while Attention is drawn again, and Send goes against the new revision`, { skip, timeout: 90000 }, async (context) => {
  const page = await writableAttention(context, { width: 1440, height: 900 }, tracer);
  await pick(page, "Review the change map");
  const row = answerOf(page).locator('.action-row[data-action-key$="|gate.answer"]');
  await row.waitFor();
  const target = await answerOf(page).getAttribute("data-answer-target");
  await row.locator("prism-choice-option").nth(1).click();
  const note = row.locator('prism-field[data-field="note"] textarea');
  await page.evaluate(() => window.__mark("--- fill"));
  await note.fill("Split the parser.");
  await note.evaluate((element) => element.setSelectionRange(5, 5));
  await page.evaluate(() => window.__mark("--- other answer"));
  // Another tab answers the initiative's other question, which changes the initiative's record and so the revision this card read.
  const other = await page.evaluate(async (own) => {
    const initiative = own.split("/")[0];
    const attention = await (await fetch("./api/entity?ref=attention")).json();
    const gate = attention.data.needsYou.find((item) => item.type === "gate" && `gate:${item.initiative?.id}/${item.id}` !== own && `gate:${item.initiative?.id}` === initiative);
    const headers = { "Content-Type": "application/json", "X-Prism-Write": sessionStorage.getItem("prism-write-session") };
    const listing = await (await fetch(`./api/actions?target=${encodeURIComponent(`gate:${gate.initiative.id}/${gate.id}`)}`, { headers })).json();
    const action = listing.actions.find((item) => item.id === "gate.answer");
    const applied = await fetch("./api/actions/apply", { method: "POST", headers, body: JSON.stringify({ action: "gate.answer", target: action.target, input: { note: "Approve it now." }, revision: action.revision }) });
    return { status: applied.status, question: gate.question };
  }, target);
  assert.equal(other.status, 200);
  await settled(() => page.locator(".attention-group[aria-labelledby='attention-group-answered'] prism-inbox-item").count(), (count) => count > 0);
  await repainted(page);
  const kept = await page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.localName, value: active?.value, at: active?.selectionStart, field: active?.closest("prism-field")?.dataset.field };
  });
  console.log(`DIAG3 ${round} ${kept.at === 5 ? "PASS" : "FAIL"} ${JSON.stringify(kept)}`);
  if (kept.at !== 5 || round === 1) await report(page, `480 round ${round}`);
  assert.deepEqual(kept, { tag: "textarea", value: "Split the parser.", at: 5, field: "note" }, "the note keeps its text, its focus, and its cursor");
  const submit = answerOf(page).locator("prism-button[data-apply]");
  assert.deepEqual([await shownText(submit), await submit.getAttribute("variant")], ["Request changes", "danger"], "the picked answer is kept too");
  await submit.click();
  await settled(() => page.locator(`.gate-answer-form[data-answer-target="${target}"]`).count(), 0);
  assert.equal(await page.locator(`.gate-answer-form[data-answer-target="${target}"]`).count(), 0, "the answer was recorded although the revision changed after the card read it");
  assert.equal(await page.locator(".attention-detail .action-error:not([hidden])").count(), 0);
  assert.deepEqual(page.errors, []);
});
