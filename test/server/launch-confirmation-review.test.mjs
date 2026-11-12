import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

// The confirmation's guarantees under timing and other processes: the cool-down runs from the dialog's end,
// a dialog that ignores a polite stop is still ended, and only one dialog of this machine is open at a time.
// Stub dialog programs on PATH stand in for zenity and kdialog; no real dialog is shown.
const module = () => import("../../dist/server/session/launch-confirmation.mjs");
const posixOnly = process.platform === "win32" ? "the stub dialogs are POSIX scripts" : false;
const T0 = Date.parse("2026-11-10T09:00:00.000Z");

async function dialogs(t, name, plan) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-confirm-review-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bin = path.join(folder, "bin");
  const log = path.join(folder, "dialogs.log");
  await mkdir(bin);
  const file = path.join(bin, name);
  await writeFile(file, `#!/usr/bin/env node
${plan.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n");
setTimeout(() => process.exit(${plan.code}), ${plan.waitMs});
`);
  chmodSync(file, 0o755);
  const asked = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const app = path.join(folder, "app");
  const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, PRISM_REVIEW_APP_DIR: app, DISPLAY: ":0" };
  return { env, asked, pending: path.join(app, "launches", "confirmation-pending.json") };
}

const request = (env, now) => ({ initiative: "reports", host: "claude-code", checkout: "/work/reports", env, platform: "linux", now });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

test("the cool-down runs 30 seconds from when the dialog was declined, not from when it was requested", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, "zenity", { code: 1, waitMs: 1500 });
  const { confirmLaunch } = await module();
  const requestedAt = Date.now();
  assert.equal((await rejection(confirmLaunch(request(env, requestedAt)))).code, "confirmation_declined");
  const declinedAt = Date.now();
  assert.equal((await rejection(confirmLaunch(request(env, declinedAt + 29000)))).code, "confirmation_cooldown");
  assert.equal(asked(), 1, "no dialog during the cool-down");
});

test("two launches requested at the same moment in one process show only one dialog", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, "zenity", { code: 0, waitMs: 300 });
  const { confirmLaunch } = await module();
  const results = await Promise.allSettled([confirmLaunch(request(env, T0)), confirmLaunch(request(env, T0))]);
  assert.equal(asked(), 1);
  assert.deepEqual(results.map((r) => r.status === "fulfilled" ? "confirmed" : r.reason.code).sort(), ["confirmation_pending", "confirmed"]);
});

test("a kdialog that ignores SIGTERM is still ended after 120 seconds as unanswered", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "kdialog", { code: 0, waitMs: 600000, ignoreTerm: true });
  const { confirmLaunch } = await module();
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const answer = confirmLaunch(request(env, T0)).then(() => "confirmed", (error) => error.code);
  while (asked() === 0) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(130000);
  mock.timers.reset();
  assert.equal(await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve("still open"), 3000))]), "confirmation_timeout");
  assert.equal(existsSync(pending), false, "the one-dialog slot is released");
});

test("a pending record that another process has created but not yet written is not taken over", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "zenity", { code: 0, waitMs: 10 });
  const { confirmLaunch } = await module();
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, "");
  assert.equal((await rejection(confirmLaunch(request(env, T0)))).code, "confirmation_pending");
  assert.equal(asked(), 0);
  assert.equal(readFileSync(pending, "utf8"), "", "the other process's record is left as it is");
});

test("an unreadable pending record left long ago is abandoned and the launch asks", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "zenity", { code: 0, waitMs: 10 });
  const { confirmLaunch } = await module();
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, "");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(pending, old, old);
  assert.equal((await confirmLaunch(request(env, T0))).asked, true);
  assert.equal(asked(), 1);
  assert.equal(existsSync(pending), false, "the slot is released after the dialog");
});

// A stub dialog program that records its arguments and declines.
async function recordingDialog(t, name) {
  const { env, asked } = await dialogs(t, name, { code: 1, waitMs: 10 });
  const argvLog = path.join(path.dirname(env.PRISM_REVIEW_APP_DIR), "argv.json");
  const file = path.join(env.PATH.split(path.delimiter)[0], name);
  await writeFile(file, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);
  return { env, asked, argv: () => JSON.parse(readFileSync(argvLog, "utf8")) };
}

const decodeEntities = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const markupCheckout = "/home/me/R&D/<b>tools</b>";

test("zenity shows the question as typed when the checkout contains & or <", { skip: posixOnly }, async (t) => {
  const { env, argv } = await recordingDialog(t, "zenity");
  const { confirmLaunch, confirmationText } = await module();
  await rejection(confirmLaunch({ ...request(env, T0), checkout: markupCheckout }));
  const text = argv().find((arg) => arg.startsWith("--text=")).slice("--text=".length);
  assert.doesNotMatch(text, /<|&(?!(amp|lt|gt);)/, "no markup is left for Pango to read");
  assert.equal(decodeEntities(text), confirmationText({ label: "Claude Code", initiative: "reports", checkout: markupCheckout }));
});

test("kdialog shows the question as typed when the checkout contains & or <", { skip: posixOnly }, async (t) => {
  const { env, argv } = await recordingDialog(t, "kdialog");
  const { confirmLaunch, confirmationText } = await module();
  await rejection(confirmLaunch({ ...request(env, T0), checkout: markupCheckout }));
  const args = argv();
  assert.deepEqual(args.slice(0, -1), ["--title", "Prism", "--yes-label", "Launch", "--no-label", "Cancel", "--warningyesno"]);
  const match = /^<p style="[^"]*white-space:pre-wrap[^"]*">([^<]*)<\/p>$/.exec(args.at(-1));
  assert.ok(match, "the text is one rich-text paragraph whose own characters are entities");
  assert.equal(decodeEntities(match[1]), confirmationText({ label: "Claude Code", initiative: "reports", checkout: markupCheckout }));
});

// zenity (g_strcompress) and kdialog (Utils::parseString) both turn \\ into \ before showing the text; zenity also decodes \n, octal and other escapes.
const decodeBackslashes = (value) => value.replace(/\\(.)/gs, (_, c) => c === "\\" ? "\\" : `<undoubled \\${c}>`);
const backslashCheckout = "/home/me/repo\\n\\074b\\076tools\\";

for (const name of ["zenity", "kdialog"]) {
  test(`${name} shows the question as typed when the checkout contains backslashes`, { skip: posixOnly }, async (t) => {
    const { env, argv } = await recordingDialog(t, name);
    const { confirmLaunch, confirmationText } = await module();
    await rejection(confirmLaunch({ ...request(env, T0), checkout: backslashCheckout }));
    const text = name === "zenity" ? argv().find((arg) => arg.startsWith("--text=")).slice("--text=".length) : argv().at(-1);
    assert.equal(decodeBackslashes(text), confirmationText({ label: "Claude Code", initiative: "reports", checkout: backslashCheckout }));
  });
}

test("an initiative that is not a slug is refused before any dialog", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, "zenity", { code: 0, waitMs: 10 });
  const { confirmLaunch } = await module();
  const refused = await rejection(confirmLaunch({ ...request(env, T0), initiative: "<b>x</b>" }));
  assert.equal(refused.code, "unknown_initiative");
  assert.equal(asked(), 0);
});

test("a GTK 3 zenity that cannot open the display is unavailable, not a decline", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, "zenity", { code: 1, waitMs: 10 });
  const file = path.join(env.PATH.split(path.delimiter)[0], "zenity");
  await writeFile(file, `#!/bin/sh\necho "(zenity:4242): Gtk-WARNING **: 10:00:00.000: cannot open display: :0" >&2\nexit 1\n`);
  const { confirmLaunch } = await module();
  const refused = await rejection(confirmLaunch(request(env, T0)));
  assert.equal(refused.code, "confirmation_unavailable");
  assert.equal(refused.message, "This computer cannot show a confirmation outside the browser: zenity could not open the display :0.");
  assert.equal(asked(), 0);
  assert.equal(existsSync(path.join(env.PRISM_REVIEW_APP_DIR, "launches", "confirmation-cooldown.json")), false, "no cool-down follows");
});

test("a dialog whose descendant keeps its output open is still ended after the forced kill", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "kdialog", { code: 0, waitMs: 10 });
  const file = path.join(env.PATH.split(path.delimiter)[0], "kdialog");
  const log = path.join(path.dirname(env.PRISM_REVIEW_APP_DIR), "dialogs.log");
  await writeFile(file, `#!/bin/sh\necho x >> ${JSON.stringify(log)}\ntrap '' TERM\nsleep 20\n`);
  const { confirmLaunch } = await module();
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const answer = confirmLaunch(request(env, T0)).then(() => "confirmed", (error) => error.code);
  while (asked() === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(130000);
  mock.timers.reset();
  assert.equal(await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve("still open"), 3000))]), "confirmation_timeout");
  assert.equal(existsSync(pending), false, "the one-dialog slot is released");
});

test("an abandoned pending record that another process is taking over is left to that process", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "zenity", { code: 0, waitMs: 10 });
  const { confirmLaunch } = await module();
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, `${JSON.stringify({ pid: 999999999, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })}\n`);
  await writeFile(`${pending}.takeover`, "1\n");
  assert.equal((await rejection(confirmLaunch(request(env, T0)))).code, "confirmation_pending");
  assert.equal(asked(), 0);
});

test("a takeover lock left long ago does not hold the slot", { skip: posixOnly }, async (t) => {
  const { env, asked, pending } = await dialogs(t, "zenity", { code: 0, waitMs: 10 });
  const { confirmLaunch } = await module();
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, `${JSON.stringify({ pid: 999999999, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })}\n`);
  const lock = `${pending}.takeover`;
  await writeFile(lock, "1\n");
  const old = new Date(Date.now() - 60 * 1000);
  await utimes(lock, old, old);
  assert.equal((await confirmLaunch(request(env, T0))).asked, true);
  assert.equal(asked(), 1);
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(lock), false);
});

// Pending answers only while a dialog is actually open; with no display, two simultaneous requests both find no dialog.
test("two simultaneous requests without a display both answer confirmation_unavailable", async (t) => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-confirm-race-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = { PATH: "/nonexistent", PRISM_REVIEW_APP_DIR: path.join(folder, "app") };
  const { confirmLaunch } = await module();
  const ask = () => confirmLaunch({ initiative: "reports", host: "claude-code", checkout: "/srv/x", env, platform: "linux", now: Date.now() }).then(() => "resolved", (error) => error.code);
  assert.deepEqual(await Promise.all([ask(), ask()]), ["confirmation_unavailable", "confirmation_unavailable"]);
});
