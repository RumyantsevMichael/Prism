// Generated from src/server/command-launch.mts by scripts/native-build/compile.mjs.
import { statSync } from "node:fs";
import path from "node:path";
function commandLaunch(command, args, platform = process.platform, environment = process.env) {
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
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
export {
  commandLaunch
};
