import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "../log.mjs";

// An opener that is still running after this long has handed the URL to a browser that it runs itself, so the open counts as done.
const OPEN_SETTLE_MS = 3000;

type Opener = { command: string; args: string[] };
type OpenOptions = { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; spawnProcess?: typeof spawn; settleMs?: number; wsl?: boolean };

/** Whether this Linux process runs under the Windows Subsystem for Linux, where the person's browser is a Windows program. */
export function runsUnderWsl(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

/**
 * The commands that may open a URL in the person's browser on this system, in the order Prism tries them.
 * cmd.exe's start would read an & in the URL's query as a second command, so Windows opens the URL through the shell's URL handler,
 * and so does WSL, through the Windows interop that puts rundll32.exe on PATH, before the Linux openers that a WSL install often lacks.
 */
export function browserOpeners(url: string, { platform = process.platform, wsl = platform === "linux" && runsUnderWsl() }: { platform?: NodeJS.Platform; wsl?: boolean } = {}): Opener[] {
  const windowsHandler = ["url.dll,FileProtocolHandler", url];
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  if (platform === "win32") return [{ command: "rundll32", args: windowsHandler }];
  const linux = [{ command: "xdg-open", args: [url] }];
  return wsl ? [{ command: "rundll32.exe", args: windowsHandler }, { command: "wslview", args: [url] }, ...linux] : linux;
}

// Resolves with null once the opener started and either exited cleanly or is still running after the settle time, else with why it failed.
function runOpener({ command, args }: Opener, spawnProcess: typeof spawn, settleMs: number) {
  return new Promise<string | null>((resolve) => {
    let child;
    try {
      // A browser that the opener starts inherits its working folder, so it starts in the home folder and never keeps a project folder busy, which Windows would refuse to remove or rename.
      child = spawnProcess(command, args, { cwd: homedir(), detached: true, stdio: "ignore", windowsHide: true });
    } catch (error: any) {
      resolve(error?.code ?? String(error?.message ?? error));
      return;
    }
    const settle = setTimeout(() => {
      child.unref();
      resolve(null);
    }, settleMs);
    child.once("error", (error: any) => {
      clearTimeout(settle);
      resolve(error?.code ?? String(error?.message ?? error));
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      clearTimeout(settle);
      resolve(code === 0 ? null : signal ? `signal ${signal}` : `exit code ${code}`);
    });
  });
}

/**
 * Opens a URL in the person's browser and answers whether an opener took it.
 * Each opener for this system is tried in turn; one that cannot start or exits with an error is logged, so a machine without a working opener answers false
 * and the agent can tell the person, instead of reporting a tab that never appeared.
 */
export async function openBrowser(url: string, { platform = process.platform, environment = process.env, spawnProcess = spawn, settleMs = OPEN_SETTLE_MS, wsl }: OpenOptions = {}) {
  const openers = browserOpeners(url, { platform, wsl: wsl ?? (platform === "linux" && runsUnderWsl(environment)) });
  for (const opener of openers) {
    const failure = await runOpener(opener, spawnProcess, settleMs);
    if (failure === null) return true;
    log.warn("browser_open_failed", { command: opener.command, reason: failure });
  }
  return false;
}
