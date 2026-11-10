import { spawn } from "node:child_process";
import { access, constants, link, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { hostDefinition } from "./launch-hosts.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { LaunchError, launchesDirectory, prepareLaunchesDirectory } from "./launch-records.mjs";

// The confirmation of a launch outside the web page: a native dialog of the operating system, run without a shell.
// A confirmation opens a launch window that every process of this user on this machine reads from the review app folder.
// The page cannot answer the dialog, so a page credential alone never starts a session.

export const WINDOW_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 30 * 1000;
export const DIALOG_MS = 120 * 1000;
// A dialog that has not ended this long after its own timeout is ended and counted as unanswered.
const DIALOG_BACKSTOP_MS = DIALOG_MS + 10 * 1000;
// A pending record is held this long at most; an older one belongs to a process that ended without releasing it.
const PENDING_STALE_MS = DIALOG_BACKSTOP_MS * 2;
// A takeover of an abandoned pending record lasts milliseconds; a takeover lock this old belongs to a process that ended.
const TAKEOVER_STALE_MS = 10 * 1000;
// After a dialog program exits, its output is awaited this long at most, since a descendant may keep the pipes open.
const OUTPUT_WAIT_MS = 1000;
const WINDOW_FILE = "window.json";
const COOLDOWN_FILE = "confirmation-cooldown.json";
const PENDING_FILE = "confirmation-pending.json";
const UNAVAILABLE_PREFIX = "This computer cannot show a confirmation outside the browser: ";
const STDERR_MAX = 500;
const ZENITY_ARGS = Object.freeze(["--question", "--default-cancel", "--title=Prism", "--ok-label=Launch", "--cancel-label=Cancel", "--timeout=120"]);
const OSASCRIPT_DIALOG = "display dialog (item 1 of argv) with title \"Prism\" buttons {\"Cancel\", \"Launch\"} default button \"Cancel\" cancel button \"Cancel\" with icon caution giving up after 120";
const POWERSHELL_COMMAND = "$r = (New-Object -ComObject WScript.Shell).Popup($env:PRISM_LAUNCH_CONFIRM_TEXT, 120, 'Prism', 4 + 48 + 256); if ($r -eq 6) { exit 10 } elseif ($r -eq 7) { exit 11 } elseif ($r -eq -1) { exit 12 } else { exit 13 }";
const UNIX_DIALOG_PLATFORMS = new Set(["linux", "freebsd", "openbsd"]);

// The dialogs this process has open; the pending file carries the rule to other processes of this machine.
let openHere = 0;

// zenity renders its text as Pango markup, so the characters that markup reads are written as entities and shown as typed.
function pangoText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// kdialog lets Qt guess whether its text is rich text; a text that could read as markup is given as rich text that shows it as typed.
function qtText(text) {
  if (!/[<&]/.test(text)) return text;
  return `<p style="margin:0; white-space:pre-wrap">${pangoText(text)}</p>`;
}

export function confirmationText({ label, initiative, checkout }) {
  return `Start a ${label} session on this computer that runs Prism's orchestrate skill for the initiative ${initiative} in ${checkout}? Further launches in the next 30 minutes will start without asking.`;
}

function unavailable(missing, { verbatim = false } = {}) {
  // A program's own error closes the sentence as the program wrote it.
  return new LaunchError("confirmation_unavailable", `${UNAVAILABLE_PREFIX}${missing}${verbatim ? "" : "."}`);
}

function launchesFile(env, name) {
  return path.join(launchesDirectory(env), name);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The open launch window at `now`, as { confirmedAt, endsAt }, or null. */
export async function launchWindow({ env = process.env, now = Date.now() } = {}) {
  const window = await readJson(launchesFile(env, WINDOW_FILE));
  const confirmedAt = Date.parse(window?.confirmedAt);
  const endsAt = Date.parse(window?.endsAt);
  if (!Number.isFinite(confirmedAt) || !Number.isFinite(endsAt)) return null;
  // A window is never longer than one confirmation opens, whatever the file says.
  if (endsAt - confirmedAt > WINDOW_MS || now < confirmedAt || now >= endsAt) return null;
  return { confirmedAt: window.confirmedAt, endsAt: window.endsAt };
}

async function openWindow(env, now) {
  const window = { confirmedAt: new Date(now).toISOString(), endsAt: new Date(now + WINDOW_MS).toISOString() };
  await writeAtomically(launchesFile(env, WINDOW_FILE), `${JSON.stringify(window, null, 2)}\n`, { mode: 0o600 });
  return window;
}

async function coolingDown(env, now) {
  const record = await readJson(launchesFile(env, COOLDOWN_FILE));
  const refusedAt = Date.parse(record?.refusedAt);
  return Number.isFinite(refusedAt) && now >= refusedAt && now < refusedAt + COOLDOWN_MS;
}

async function startCooldown(env, now) {
  await writeAtomically(launchesFile(env, COOLDOWN_FILE), `${JSON.stringify({ refusedAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
}

function processRuns(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function holderIsLive(file) {
  const holder = await readJson(file);
  if (!holder) {
    // A record that cannot be read yet may still be written by another process; only an old one is abandoned.
    try {
      return Date.now() - (await stat(file)).mtimeMs < PENDING_STALE_MS;
    } catch (error) {
      return error.code !== "ENOENT";
    }
  }
  const startedAt = Date.parse(holder.startedAt);
  return processRuns(holder.pid) && Number.isFinite(startedAt) && Date.now() - startedAt < PENDING_STALE_MS;
}

/** Removes an abandoned pending record, under a takeover lock, so two processes never both take over and both open a dialog. */
async function takeOverAbandoned(file) {
  const lock = `${file}.takeover`;
  try {
    await writeFile(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - (await stat(lock)).mtimeMs >= TAKEOVER_STALE_MS) await rm(lock, { force: true });
    } catch (statError) {
      if (statError.code !== "ENOENT") throw statError;
    }
    return;
  }
  try {
    // Checked again under the lock: another process may have taken the slot over since.
    if (!(await holderIsLive(file))) await rm(file, { force: true });
  } finally {
    await rm(lock, { force: true });
  }
}

/** Takes this machine's one dialog slot, or returns null while another dialog is open. */
async function takePendingSlot(env, now) {
  // Taken before any await, so two requests of this process never both pass.
  if (openHere > 0) return null;
  openHere += 1;
  const file = launchesFile(env, PENDING_FILE);
  // The record is written in full under a private name, then linked into place, so no process ever reads it half written.
  const draft = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  let taken = false;
  try {
    await writeFile(draft, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), requestedAt: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 3 && !taken; attempt += 1) {
      try {
        await link(draft, file);
        taken = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await holderIsLive(file)) break;
        // The process that held the slot ended without releasing it.
        await takeOverAbandoned(file);
      }
    }
  } finally {
    await rm(draft, { force: true });
    if (!taken) openHere -= 1;
  }
  if (!taken) return null;
  return async () => {
    openHere -= 1;
    const holder = await readJson(file);
    if (holder?.pid === process.pid) await rm(file, { force: true });
  };
}

async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== "win32") await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(env, name) {
  const value = env.PATH ?? env.Path ?? "";
  for (const entry of value.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const file = path.join(entry, name);
    if (await executableFile(file)) return file;
  }
  return null;
}

/**
 * The dialog of this platform: { command, args, env, killAfterMs, read } where read({ code, stdout, stderr, timedOut })
 * answers "confirmed", "declined", "unanswered", or a LaunchError; or a LaunchError when this machine has no dialog.
 */
export async function nativeDialog({ text, env = process.env, platform = process.platform }) {
  if (UNIX_DIALOG_PLATFORMS.has(platform)) {
    const display = env.DISPLAY || env.WAYLAND_DISPLAY;
    if (!display) return unavailable("no graphical display (DISPLAY or WAYLAND_DISPLAY) is set for the review app");
    const zenity = await findOnPath(env, "zenity");
    if (zenity) {
      return {
        command: zenity,
        args: [...ZENITY_ARGS, `--text=${pangoText(text)}`],
        env,
        killAfterMs: DIALOG_BACKSTOP_MS,
        read: ({ code, stderr, timedOut }) => {
          if (timedOut) return "unanswered";
          if (code === 0) return "confirmed";
          if (code === 5) return "unanswered";
          if (code === 1) return /(failed to|cannot) open display/i.test(stderr) ? unavailable(`zenity could not open the display ${display}`) : "declined";
          return "unanswered";
        }
      };
    }
    const kdialog = await findOnPath(env, "kdialog");
    if (kdialog) {
      return {
        command: kdialog,
        args: ["--title", "Prism", "--yes-label", "Launch", "--no-label", "Cancel", "--warningyesno", qtText(text)],
        env,
        killAfterMs: DIALOG_MS,
        read: ({ code, timedOut }) => {
          if (timedOut) return "unanswered";
          if (code === 0) return "confirmed";
          if (code === 1) return "declined";
          return "unanswered";
        }
      };
    }
    return unavailable("neither zenity nor kdialog is installed");
  }
  if (platform === "darwin") {
    const osascript = await findOnPath(env, "osascript");
    if (!osascript) return unavailable("osascript was not found on PATH");
    return {
      command: osascript,
      args: ["-e", "on run argv", "-e", OSASCRIPT_DIALOG, "-e", "end run", text],
      env,
      killAfterMs: DIALOG_BACKSTOP_MS,
      read: ({ code, stdout, stderr, timedOut }) => {
        if (timedOut) return "unanswered";
        if (code === 0) {
          if (/gave up:\s*true/.test(stdout)) return "unanswered";
          return /button returned:\s*Launch\b/.test(stdout) && /gave up:\s*false/.test(stdout) ? "confirmed" : "declined";
        }
        if (stderr.includes("(-128)")) return "declined";
        return unavailable(`osascript failed: ${stderr.trim().slice(0, STDERR_MAX)}`, { verbatim: true });
      }
    };
  }
  if (platform === "win32") {
    const powershell = await findOnPath(env, "powershell.exe");
    if (!powershell) return unavailable("powershell.exe was not found on PATH");
    return {
      command: powershell,
      args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_COMMAND],
      env: { ...env, PRISM_LAUNCH_CONFIRM_TEXT: text },
      killAfterMs: DIALOG_BACKSTOP_MS,
      read: ({ code, timedOut }) => {
        if (timedOut) return "unanswered";
        if (code === 10) return "confirmed";
        if (code === 11) return "declined";
        if (code === 12) return "unanswered";
        return unavailable("PowerShell could not show the dialog");
      }
    };
  }
  return unavailable(`Prism has no native dialog for ${platform}`);
}

function runDialog(dialog) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(dialog.command, dialog.args, { env: dialog.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout, stderr: error.message, timedOut, spawnError: error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // A forced kill, which a dialog cannot ignore, so the one-dialog slot is always released.
      child.kill("SIGKILL");
    }, dialog.killAfterMs);
    let settled = false;
    let outputTimer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(outputTimer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on("error", (error) => done({ code: null, stdout, stderr: stderr || error.message, timedOut, spawnError: error }));
    // A descendant that inherited the pipes can hold them open long after the dialog ended, so its output is awaited briefly.
    child.on("exit", (code) => {
      clearTimeout(timer);
      outputTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done({ code, stdout, stderr, timedOut });
      }, OUTPUT_WAIT_MS);
    });
    child.on("close", (code) => done({ code, stdout, stderr, timedOut }));
  });
}

/**
 * Confirms a launch outside the page: resolves { asked, windowEndsAt } or rejects with a LaunchError whose code names the refusal.
 * The order is the open window, another open dialog, the cool-down after a refusal, a missing dialog, then the dialog itself.
 */
export async function confirmLaunch({ initiative, host, checkout, env = process.env, platform = process.platform, now = Date.now() }) {
  const definition = hostDefinition(host);
  if (!definition) throw new LaunchError("unknown_host", `Prism cannot launch the host ${host}.`);
  // The initiative is shown in the dialog, so only a slug reaches it.
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) throw new LaunchError("unknown_initiative", `Prism cannot launch the initiative ${String(initiative)}.`);
  await prepareLaunchesDirectory(env);
  const window = await launchWindow({ env, now });
  if (window) return { asked: false, windowEndsAt: window.endsAt };
  const release = await takePendingSlot(env, now);
  if (!release) throw new LaunchError("confirmation_pending", "Another launch is waiting for your confirmation.");
  try {
    if (await coolingDown(env, now)) {
      throw new LaunchError("confirmation_cooldown", "You declined a launch moments ago; wait a little before launching again.");
    }
    const text = confirmationText({ label: definition.label, initiative, checkout });
    const dialog = await nativeDialog({ text, env, platform });
    if (dialog instanceof LaunchError) throw dialog;
    const shownAt = Date.now();
    const outcome = await runDialog(dialog);
    // The cool-down runs from the dialog's end, on the request's clock.
    const endedAt = now + (Date.now() - shownAt);
    if (outcome.spawnError) throw unavailable(`${path.basename(dialog.command)} could not be started`);
    const answer = dialog.read(outcome);
    if (answer instanceof LaunchError) throw answer;
    if (answer === "confirmed") {
      const opened = await openWindow(env, now);
      return { asked: true, windowEndsAt: opened.endsAt };
    }
    await startCooldown(env, endedAt);
    if (answer === "declined") throw new LaunchError("confirmation_declined", "You declined the launch.");
    throw new LaunchError("confirmation_timeout", "Nobody answered the confirmation within 2 minutes.");
  } finally {
    await release();
  }
}
