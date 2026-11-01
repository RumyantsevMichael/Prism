import assert from "node:assert/strict";
import test from "node:test";
import { badgedIcon, notificationText, notifyControl, shouldNotify, signalTitle } from "../../dist/server/review/public/views/attention-signal.js";

test("the tab title counts waiting questions and drops the count when none wait", () => {
  assert.equal(signalTitle("prism/main · Prism", 2), "(2) prism/main · Prism");
  assert.equal(signalTitle("prism/main · Prism", 0), "prism/main · Prism");
});

test("the tab icon gains a dot inside its own drawing", () => {
  const icon = badgedIcon('<svg viewBox="0 0 32 32"><rect/></svg>\n');
  assert.match(icon, /<rect\/><circle [^>]+\/><\/svg>$/);
});

test("a notification is only for a new question while the page is in the background and notifications are on", () => {
  const base = { previous: 0, count: 1, permission: "granted", visible: false };
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, previous: null }), false, "the first count a page sees is not news");
  assert.equal(shouldNotify({ ...base, previous: 1 }), false, "an unchanged count does not notify again");
  assert.equal(shouldNotify({ ...base, visible: true }), false, "a page the user is looking at needs no notification");
  assert.equal(shouldNotify({ ...base, permission: "default" }), false);
  assert.deepEqual(notificationText(2, "prism/main"), { title: "2 questions wait for you", body: "Prism · prism/main" });
});

test("the Attention page offers notifications only while the browser can still ask", () => {
  assert.match(notifyControl("default"), /data-notify/);
  assert.doesNotMatch(notifyControl("granted"), /data-notify/);
  assert.match(notifyControl("denied"), /blocked/);
  assert.equal(notifyControl(null), "", "a browser without notifications shows nothing");
});
