// Generated from src/server/review/browser-opener.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "../log.mjs";
const OPEN_SETTLE_MS = 3e3;
function runsUnderWsl(environment = process.env) {
  if (environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}
function browserOpeners(url, { platform = process.platform, wsl = platform === "linux" && runsUnderWsl() } = {}) {
  const windowsHandler = ["url.dll,FileProtocolHandler", url];
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  if (platform === "win32") return [{ command: "rundll32", args: windowsHandler }];
  const linux = [{ command: "xdg-open", args: [url] }];
  return wsl ? [{ command: "rundll32.exe", args: windowsHandler }, { command: "wslview", args: [url] }, ...linux] : linux;
}
function runOpener({ command, args }, spawnProcess, settleMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { cwd: homedir(), detached: true, stdio: "ignore", windowsHide: true });
    } catch (error) {
      resolve(error?.code ?? String(error?.message ?? error));
      return;
    }
    const settle = setTimeout(() => {
      child.unref();
      resolve(null);
    }, settleMs);
    child.once("error", (error) => {
      clearTimeout(settle);
      resolve(error?.code ?? String(error?.message ?? error));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(settle);
      resolve(code === 0 ? null : signal ? `signal ${signal}` : `exit code ${code}`);
    });
  });
}
async function openBrowser(url, { platform = process.platform, environment = process.env, spawnProcess = spawn, settleMs = OPEN_SETTLE_MS, wsl } = {}) {
  const openers = browserOpeners(url, { platform, wsl: wsl ?? (platform === "linux" && runsUnderWsl(environment)) });
  for (const opener of openers) {
    const failure = await runOpener(opener, spawnProcess, settleMs);
    if (failure === null) return true;
    log.warn("browser_open_failed", { command: opener.command, reason: failure });
  }
  return false;
}
export {
  browserOpeners,
  openBrowser,
  runsUnderWsl
};
