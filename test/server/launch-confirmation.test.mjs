import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The confirmation outside the web page: one native dialog per platform, a 30-minute launch window that it opens,
// and a refusal wherever no native dialog can be shown. Stub dialog programs on PATH record what they were asked.
const module = () => import("../../dist/server/session/launch-confirmation.mjs");
const posixOnly = process.platform === "win32" ? "the stub dialogs are POSIX scripts" : false;
const MINUTE = 60000;
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const CHECKOUT = "/work/reports";
const MESSAGE = `Start a Claude Code session on this computer that runs Prism's orchestrate skill for the initiative reports in ${CHECKOUT}? Further launches in the next 30 minutes will start without asking.`;

/**
 * A folder with stub dialog programs and a review app folder. Each stub appends { name, argv, env } to a log, prints `stdout`,
 * writes `stderr`, waits `waitMs`, and exits with `code`, as the plan file gives for its name.
 */
async function dialogs(t, names, plan) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-confirm-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bin = path.join(folder, "bin");
  const log = path.join(folder, "dialogs.jsonl");
  const plans = path.join(folder, "plans.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  await writeFile(plans, JSON.stringify(plan));
  for (const name of names) {
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env node
const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, argv: process.argv.slice(2), env: { PRISM_LAUNCH_CONFIRM_TEXT: process.env.PRISM_LAUNCH_CONFIRM_TEXT ?? null } }) + "\\n");
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plans)}, "utf8"))[name] ?? {};
if (plan.stdout) process.stdout.write(plan.stdout);
if (plan.stderr) process.stderr.write(plan.stderr);
setTimeout(() => process.exit(plan.code ?? 0), plan.waitMs ?? 10);
`);
    chmodSync(file, 0o755);
  }
  const app = path.join(folder, "app");
  const asked = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const setPlan = (value) => writeFile(plans, JSON.stringify(value));
  // PATH keeps node's own folder so the stubs' interpreter is found, but no system folder that could hold a real dialog program.
  const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, PRISM_REVIEW_APP_DIR: app };
  return { env, asked, setPlan, app };
}

const request = (env, extra = {}) => ({ initiative: "reports", host: "claude-code", checkout: CHECKOUT, env, platform: "linux", now: T0, ...extra });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

test("on Linux a confirmed zenity dialog opens a 30-minute window in which launches need no dialog", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["zenity"], { zenity: { code: 0 } });
  env.DISPLAY = ":0";
  const { confirmLaunch } = await module();
  assert.deepEqual(await confirmLaunch(request(env)), { asked: true, windowEndsAt: new Date(T0 + 30 * MINUTE).toISOString() });
  const [dialog] = asked();
  assert.deepEqual(dialog.argv, ["--question", "--default-cancel", "--title=Prism", "--ok-label=Launch", "--cancel-label=Cancel", "--timeout=120", `--text=${MESSAGE}`]);
  assert.deepEqual(await confirmLaunch(request(env, { now: T0 + 29 * MINUTE, host: "codex" })), { asked: false, windowEndsAt: new Date(T0 + 30 * MINUTE).toISOString() });
  assert.equal(asked().length, 1, "a launch inside the window shows no dialog");
  const after = await confirmLaunch(request(env, { now: T0 + 31 * MINUTE }));
  assert.deepEqual(after, { asked: true, windowEndsAt: new Date(T0 + 61 * MINUTE).toISOString() });
  assert.equal(asked().length, 2, "after the window ends the next launch asks again");
});

test("a launch inside the window does not extend it", { skip: posixOnly }, async (t) => {
  const { env } = await dialogs(t, ["zenity"], { zenity: { code: 0 } });
  env.WAYLAND_DISPLAY = "wayland-0";
  const { confirmLaunch } = await module();
  await confirmLaunch(request(env));
  await confirmLaunch(request(env, { now: T0 + 20 * MINUTE }));
  const later = await confirmLaunch(request(env, { now: T0 + 30 * MINUTE }));
  assert.equal(later.asked, true, "the window ends 30 minutes after the confirmation, not after the last launch");
});

test("the window survives in the review app folder for another process", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["zenity"], { zenity: { code: 0 } });
  env.DISPLAY = ":0";
  const script = `const { confirmLaunch } = await import(${JSON.stringify(new URL("../../dist/server/session/launch-confirmation.mjs", import.meta.url).href)});
const answer = await confirmLaunch(${JSON.stringify(request(env))}); process.stdout.write(JSON.stringify(answer));`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(err)));
  });
  const { confirmLaunch } = await module();
  assert.equal((await confirmLaunch(request(env, { now: T0 + MINUTE }))).asked, false);
  assert.equal(asked().length, 1);
});

test("a declined or unanswered dialog refuses the launch, and a launch right after shows no dialog for 30 seconds", { skip: posixOnly }, async (t) => {
  const { env, asked, setPlan } = await dialogs(t, ["zenity"], { zenity: { code: 1 } });
  env.DISPLAY = ":0";
  const { confirmLaunch } = await module();
  const declined = await rejection(confirmLaunch(request(env)));
  assert.equal(declined.code, "confirmation_declined");
  assert.equal(declined.message, "You declined the launch.");
  const cooling = await rejection(confirmLaunch(request(env, { now: T0 + 29000 })));
  assert.equal(cooling.code, "confirmation_cooldown");
  assert.equal(asked().length, 1, "no dialog during the cool-down");
  await setPlan({ zenity: { code: 5 } });
  const timedOut = await rejection(confirmLaunch(request(env, { now: T0 + 31000 })));
  assert.equal(timedOut.code, "confirmation_timeout");
  assert.equal(timedOut.message, "Nobody answered the confirmation within 2 minutes.");
  assert.equal(asked().length, 2);
  await setPlan({ zenity: { code: 0 } });
  assert.equal((await rejection(confirmLaunch(request(env, { now: T0 + 50000 })))).code, "confirmation_cooldown");
  assert.equal((await confirmLaunch(request(env, { now: T0 + 62000 }))).asked, true);
});

test("a second launch while a dialog is open is refused without a second dialog", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["zenity"], { zenity: { code: 0, waitMs: 800 } });
  env.DISPLAY = ":0";
  const { confirmLaunch } = await module();
  const first = confirmLaunch(request(env));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await rejection(confirmLaunch(request(env, { host: "codex" })));
  assert.equal(second.code, "confirmation_pending");
  assert.equal((await first).asked, true);
  assert.equal(asked().length, 1);
});

test("on Linux without a display, or without a dialog program, the launch is refused with what is missing", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["zenity"], { zenity: { code: 0 } });
  const { confirmLaunch } = await module();
  const headless = await rejection(confirmLaunch(request(env)));
  assert.equal(headless.code, "confirmation_unavailable");
  assert.equal(headless.message, "This computer cannot show a confirmation outside the browser: no graphical display (DISPLAY or WAYLAND_DISPLAY) is set for the review app.");
  assert.equal(asked().length, 0);
  const bare = await dialogs(t, [], {});
  bare.env.DISPLAY = ":0";
  const missing = await rejection(confirmLaunch(request(bare.env)));
  assert.equal(missing.code, "confirmation_unavailable");
  assert.equal(missing.message, "This computer cannot show a confirmation outside the browser: neither zenity nor kdialog is installed.");
});

test("a zenity that cannot open its display refuses the launch as unavailable, not declined", { skip: posixOnly }, async (t) => {
  const { env } = await dialogs(t, ["zenity"], { zenity: { code: 1, stderr: "(zenity:10020): Gtk-WARNING **: 23:57:25.871: Failed to open display\n" } });
  env.DISPLAY = ":99";
  const { confirmLaunch } = await module();
  const refused = await rejection(confirmLaunch(request(env)));
  assert.equal(refused.code, "confirmation_unavailable");
  assert.equal(refused.message, "This computer cannot show a confirmation outside the browser: zenity could not open the display :99.");
});

test("on Linux without zenity, kdialog asks with Cancel as the default", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["kdialog"], { kdialog: { code: 0 } });
  env.DISPLAY = ":0";
  const { confirmLaunch } = await module();
  assert.equal((await confirmLaunch(request(env))).asked, true);
  assert.deepEqual(asked()[0].argv, ["--title", "Prism", "--yes-label", "Launch", "--no-label", "Cancel", "--warningyesno", MESSAGE]);
});

test("on macOS osascript shows a dialog whose default button is Cancel and that gives up after 2 minutes", { skip: posixOnly }, async (t) => {
  const { env, asked, setPlan } = await dialogs(t, ["osascript"], { osascript: { code: 0, stdout: "button returned:Launch, gave up:false\n" } });
  const { confirmLaunch } = await module();
  assert.equal((await confirmLaunch(request(env, { platform: "darwin" }))).asked, true);
  assert.deepEqual(asked()[0].argv, ["-e", "on run argv", "-e", "display dialog (item 1 of argv) with title \"Prism\" buttons {\"Cancel\", \"Launch\"} default button \"Cancel\" cancel button \"Cancel\" with icon caution giving up after 120", "-e", "end run", MESSAGE]);
  const fresh = await dialogs(t, ["osascript"], { osascript: { code: 0, stdout: "button returned:, gave up:true\n" } });
  assert.equal((await rejection(confirmLaunch(request(fresh.env, { platform: "darwin" })))).code, "confirmation_timeout");
  const cancelled = await dialogs(t, ["osascript"], { osascript: { code: 1, stderr: "execution error: User canceled. (-128)\n" } });
  assert.equal((await rejection(confirmLaunch(request(cancelled.env, { platform: "darwin" })))).code, "confirmation_declined");
  const broken = await dialogs(t, ["osascript"], { osascript: { code: 1, stderr: "execution error: Not authorized to send Apple events. (-1743)\n" } });
  const unavailable = await rejection(confirmLaunch(request(broken.env, { platform: "darwin" })));
  assert.equal(unavailable.code, "confirmation_unavailable");
  assert.equal(unavailable.message, "This computer cannot show a confirmation outside the browser: osascript failed: execution error: Not authorized to send Apple events. (-1743)");
  await setPlan({ osascript: { code: 0, stdout: "button returned:Cancel, gave up:false\n" } });
  assert.equal((await rejection(confirmLaunch(request(env, { platform: "darwin", now: T0 + 31 * MINUTE })))).code, "confirmation_declined", "only the Launch button confirms");
});

test("on Windows PowerShell shows a Yes/No popup with No as the default, reading the message from the environment", { skip: posixOnly }, async (t) => {
  const { env, asked } = await dialogs(t, ["powershell.exe"], { "powershell.exe": { code: 10 } });
  const { confirmLaunch } = await module();
  assert.equal((await confirmLaunch(request(env, { platform: "win32" }))).asked, true);
  const [dialog] = asked();
  assert.deepEqual(dialog.argv, ["-NoProfile", "-NonInteractive", "-Command", "$r = (New-Object -ComObject WScript.Shell).Popup($env:PRISM_LAUNCH_CONFIRM_TEXT, 120, 'Prism', 4 + 48 + 256); if ($r -eq 6) { exit 10 } elseif ($r -eq 7) { exit 11 } elseif ($r -eq -1) { exit 12 } else { exit 13 }"]);
  assert.equal(dialog.env.PRISM_LAUNCH_CONFIRM_TEXT, MESSAGE);
  for (const [code, refusal] of [[11, "confirmation_declined"], [12, "confirmation_timeout"], [13, "confirmation_unavailable"]]) {
    const fresh = await dialogs(t, ["powershell.exe"], { "powershell.exe": { code } });
    assert.equal((await rejection(confirmLaunch(request(fresh.env, { platform: "win32" })))).code, refusal);
  }
  const none = await dialogs(t, [], {});
  const missing = await rejection(confirmLaunch(request(none.env, { platform: "win32" })));
  assert.equal(missing.code, "confirmation_unavailable");
  assert.equal(missing.message, "This computer cannot show a confirmation outside the browser: powershell.exe was not found on PATH.");
});

test("a platform with no native dialog refuses every launch", { skip: posixOnly }, async (t) => {
  const { env } = await dialogs(t, ["zenity"], { zenity: { code: 0 } });
  env.DISPLAY = ":0";
  const { confirmLaunch } = await module();
  const refused = await rejection(confirmLaunch(request(env, { platform: "aix" })));
  assert.equal(refused.code, "confirmation_unavailable");
  assert.equal(refused.message, "This computer cannot show a confirmation outside the browser: Prism has no native dialog for aix.");
});
