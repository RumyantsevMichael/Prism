import { statSync } from "node:fs";
import path from "node:path";

// A command the person names, such as codex or codenib, may be installed on Windows as a .cmd or .bat shim, as npm and pip install them.
// Node finds only executables on PATH and Windows starts a shim only through cmd.exe, so on Windows the command is looked up on PATH with PATHEXT:
// an executable starts directly by its full path, a shim through the shell with each word quoted, and a command found nowhere starts as named, so its spawn fails with ENOENT.
// Windows paths cannot contain a double quote.
export function commandLaunch(command, args, platform = process.platform, environment = process.env) {
  if (platform !== "win32") return { command, args, shell: false };
  const found = windowsCommand(command, environment);
  if (!found) return { command, args, shell: false };
  if (/\.(?:exe|com)$/i.test(found)) return { command: found, args, shell: false };
  return { command: `"${found}"`, args: args.map((value) => `"${value}"`), shell: true };
}

function windowsCommand(command, environment) {
  const value = (name) => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
  const extensions = path.extname(command) ? [""] : (value("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const folders = /[\\/]/.test(command) ? [""] : value("PATH").split(";").filter(Boolean);
  for (const folder of folders) {
    for (const extension of extensions) {
      const candidate = path.join(folder, command + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}
