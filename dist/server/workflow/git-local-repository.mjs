// Generated from src/server/workflow/git-local-repository.mts by scripts/native-build/compile.mjs.
import { constants } from "node:fs";
import { access, lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
class UnresolvableLocalRemote extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}
const STOPS = Object.freeze({ stops: true });
const PATH_MAX = { linux: 4096, darwin: 1024, freebsd: 1024, openbsd: 1024 };
const SCHEME = "[A-Za-z0-9][A-Za-z0-9+.-]*";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const NOT_UTF8_HINT = "Rename the folders on the way to the remote repository so that every name is UTF-8, then name the repository by its path.";
function exactText(bytes, where) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new UnresolvableLocalRemote(`${where} holds a name that is not UTF-8`, NOT_UTF8_HINT);
  }
}
async function realPathText(file) {
  return exactText(await realpath(file, { encoding: "buffer" }), `the path ${file}`);
}
function exactHome(home, where) {
  if (home.includes("\uFFFD")) throw new UnresolvableLocalRemote(`${where} holds a name that is not UTF-8`, NOT_UTF8_HINT);
  return home;
}
const isDirSep = (platform, character) => character === "/" || platform === "win32" && character === "\\";
function drivePrefix(platform, text) {
  if (platform !== "win32") return 0;
  const found = /^[^\0]:/u.exec(text);
  return found ? found[0].length : 0;
}
const isAbsolute = (platform, text) => isDirSep(platform, text[0]) || drivePrefix(platform, text) > 0;
function validWindowsPath(text) {
  const rest = text.slice(drivePrefix("win32", text));
  for (const segment of rest.split(/[\\/]/)) {
    if (/[:<>"|?*\x01-\x1f]/.test(segment)) return false;
    if (/[ .]$/.test(segment) && segment !== "." && segment !== "..") return false;
    if (/^(?:AUX|NUL|PRN|CON|CONIN\$|CONOUT\$|COM[1-9]|LPT[0-9]) *(?:$|[.:])/i.test(segment)) return false;
  }
  return true;
}
function localNotSsh(platform, url) {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon < 0 || slash >= 0 && slash < colon) return true;
  if (!drivePrefix(platform, url)) return false;
  if (validWindowsPath(url)) return true;
  throw new UnresolvableLocalRemote(`Git reaches "${url}" as a Windows path or as an SSH host depending on its core.protectNTFS setting`);
}
function urlDecode(url) {
  const colon = url.indexOf(":");
  const bytes = Buffer.from(url.slice(colon), "utf8");
  const out = [];
  for (let at = 0; at < bytes.length; at++) {
    const hex = bytes.subarray(at + 1, at + 3).toString("latin1");
    if (bytes[at] === 37 && /^[0-9A-Fa-f]{2}$/.test(hex) && parseInt(hex, 16) > 0) {
      out.push(parseInt(hex, 16));
      at += 2;
      continue;
    }
    out.push(bytes[at]);
  }
  try {
    return url.slice(0, colon) + new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(out));
  } catch {
    throw new UnresolvableLocalRemote(`"${url}" decodes to a path that is not UTF-8`, NOT_UTF8_HINT);
  }
}
function hostEnd(host) {
  const at = host.indexOf("@[");
  const start = at >= 0 ? at + 1 : 0;
  if (host[start] !== "[") return 0;
  const close = host.indexOf("]", start + 1);
  return close >= 0 ? close : 0;
}
function windowsRootLength(text) {
  let at = drivePrefix("win32", text);
  if (!at && isDirSep("win32", text[0]) && isDirSep("win32", text[1])) {
    const server = text.slice(2).search(/[\\/]/);
    if (server < 0) return 0;
    at = server + 2;
    do
      at++;
    while (at < text.length && !isDirSep("win32", text[at]));
  }
  return at + (isDirSep("win32", text[at]) ? 1 : 0);
}
function gitTransportPath(url, platform = process.platform) {
  if (typeof url !== "string" || !url) return null;
  if (new RegExp(`^(?:${SCHEME})?::`).test(url) || url.startsWith("rsync:")) return null;
  const isUrl = new RegExp(`^${SCHEME}://`).test(url);
  if (isUrl && !url.startsWith("file://")) return null;
  const decoded = isUrl ? urlDecode(url) : url;
  const separator = decoded.indexOf("://");
  let scheme = "local";
  let host = decoded;
  if (separator >= 0) {
    scheme = decoded.slice(0, separator);
    if (["ssh", "git", "git+ssh", "ssh+git"].includes(scheme)) return null;
    if (scheme !== "file") return STOPS;
    host = decoded.slice(separator + 3);
  } else if (!localNotSsh(platform, decoded)) {
    return null;
  }
  const end = hostEnd(host);
  let found;
  if (scheme === "local") found = host.slice(end);
  else if (platform === "win32" && host[0] !== "/" && !drivePrefix(platform, host) && windowsRootLength(`//${host}`) > 1) found = `//${host}`;
  else if (drivePrefix(platform, host.slice(end))) found = host.slice(end);
  else {
    const slash = host.indexOf("/", end);
    found = slash < 0 ? null : host.slice(slash);
  }
  if (!found || found.startsWith("-")) return STOPS;
  if (platform === "win32" && scheme === "file" && found[0] === "/" && drivePrefix(platform, found.slice(1))) found = found.slice(1);
  return { path: found, plain: scheme === "local" };
}
function localTransport(url, platform = process.platform) {
  try {
    return Boolean(gitTransportPath(url, platform));
  } catch {
    return true;
  }
}
function onDisk(platform, cwd, text) {
  if (platform !== "win32") return text.startsWith("/") ? text : `${cwd}/${text}`;
  const drive = drivePrefix(platform, text);
  if (drive && !isDirSep(platform, text[drive])) throw new UnresolvableLocalRemote(`"${text}" names a folder relative to its drive's current folder`);
  return path.win32.resolve(cwd, text);
}
const statOf = (file) => stat(file).catch(() => null);
const accessible = (file) => access(file, constants.X_OK).then(() => true, () => false);
const GIT_SPACE = /* @__PURE__ */ new Set([32, 9, 10, 13]);
async function validHead(platform, cwd, file) {
  const found = await lstat(onDisk(platform, cwd, file)).catch(() => null);
  if (!found) return false;
  if (found.isSymbolicLink()) return (await readlink(onDisk(platform, cwd, file), { encoding: "buffer" }).catch(() => Buffer.alloc(0))).subarray(0, 5).toString("latin1") === "refs/";
  if (found.isDirectory()) return false;
  if (!found.isFile()) throw new UnresolvableLocalRemote(`its HEAD ${file} is not a file`);
  const handle = await open(onDisk(platform, cwd, file), "r").catch(() => null);
  if (!handle) return false;
  let bytes;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(255), 0, 255, 0);
    bytes = buffer.subarray(0, bytesRead);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
  const nul = bytes.indexOf(0);
  const text = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (text.subarray(0, 4).toString("latin1") === "ref:") {
    let at = 4;
    while (GIT_SPACE.has(text[at])) at++;
    if (text.subarray(at, at + 5).toString("latin1") === "refs/") return true;
  }
  return /^[0-9A-Fa-f]{40}/.test(text.subarray(0, 40).toString("latin1"));
}
async function gitRealPath(platform, file) {
  let found;
  try {
    found = await realpath(file, { encoding: "buffer" });
  } catch (error) {
    if (error.code !== "ENOENT") throw STOPS;
    const parent = platform === "win32" ? path.win32.dirname(file) : path.posix.dirname(file);
    if (parent === file) throw STOPS;
    let real;
    try {
      real = await realpath(parent, { encoding: "buffer" });
    } catch {
      throw STOPS;
    }
    return path.join(exactText(real, `the path ${parent}`), path.basename(file));
  }
  return exactText(found, `the path ${file}`);
}
async function isGitDirectory(platform, cwd, suspect) {
  if (!await validHead(platform, cwd, `${suspect}${suspect.endsWith("/") ? "" : "/"}HEAD`)) return false;
  let common = suspect;
  const commondir = `${suspect}/commondir`;
  if (await statOf(onDisk(platform, cwd, commondir))) {
    let data;
    try {
      data = await readFile(onDisk(platform, cwd, commondir));
    } catch {
      throw STOPS;
    }
    if (!data.length) throw STOPS;
    let length = data.length;
    while (data[length - 1] === 10 || data[length - 1] === 13) length--;
    let named = data.subarray(0, length);
    if (named.includes(0)) named = named.subarray(0, named.indexOf(0));
    const text = exactText(named, `its commondir file ${commondir}`);
    common = await gitRealPath(platform, onDisk(platform, cwd, isAbsolute(platform, text) ? text : `${suspect}/${text}`));
  } else {
    common = onDisk(platform, cwd, suspect);
  }
  return await accessible(`${common}/objects`) && await accessible(`${common}/refs`);
}
async function gitFileTarget(platform, cwd, file) {
  const found = await statOf(onDisk(platform, cwd, file));
  if (!found?.isFile()) return null;
  if (found.size > 1 << 20) throw STOPS;
  let contents;
  try {
    contents = await readFile(onDisk(platform, cwd, file));
  } catch {
    throw STOPS;
  }
  if (contents.subarray(0, 8).toString("latin1") !== "gitdir: ") throw STOPS;
  let length = contents.length;
  while (contents[length - 1] === 10 || contents[length - 1] === 13) length--;
  if (length < 9) throw STOPS;
  let named = contents.subarray(8, length);
  if (named.includes(0)) named = named.subarray(0, named.indexOf(0));
  let directory = exactText(named, `its .git file ${file}`);
  const slash = file.lastIndexOf("/");
  if (!isAbsolute(platform, directory) && slash >= 0) directory = `${file.slice(0, slash + 1)}${directory}`;
  if (!await isGitDirectory(platform, cwd, directory)) throw STOPS;
  return gitRealPath(platform, onDisk(platform, cwd, directory));
}
async function enterRepo(text, { platform, cwd, env }) {
  let length = text.length;
  while (length > 1 && text[length - 1] === "/") length--;
  let used = text.slice(0, length);
  const limit = PATH_MAX[platform];
  const bytes = Buffer.byteLength(used);
  if (limit ? bytes >= limit : bytes >= 260) {
    if (limit) return STOPS;
    throw new UnresolvableLocalRemote(`its path is longer than Prism knows Git takes on this system`);
  }
  if (used[0] === "~") {
    const slash = used.indexOf("/") < 0 ? used.length : used.indexOf("/");
    const user = used.slice(1, slash);
    let home;
    if (!user) {
      home = env.HOME;
      if (home === void 0 && platform === "win32") throw new UnresolvableLocalRemote("HOME is not set, and Git for Windows then finds a home folder of its own");
      if (home === void 0) return STOPS;
      exactHome(home, "HOME");
    } else {
      if (platform === "win32") return STOPS;
      let me = null;
      try {
        me = os.userInfo();
      } catch {
        me = null;
      }
      if (!me || me.username !== user) throw new UnresolvableLocalRemote(`Prism cannot look up the home folder of the user ${user}`);
      home = exactHome(me.homedir, `the home folder of ${user}`);
    }
    used = `${home}${used.slice(slash)}`;
  }
  for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
    const candidate = `${used}${suffix}`;
    const found = await statOf(onDisk(platform, cwd, candidate));
    if (!found || !(found.isFile() || found.isDirectory() && await isGitDirectory(platform, cwd, candidate))) continue;
    const target = await gitFileTarget(platform, cwd, candidate) ?? onDisk(platform, cwd, candidate);
    const real = await realpath(target, { encoding: "buffer" }).catch(() => null);
    const entered = real && exactText(real, `the path ${target}`);
    if (!entered || !(await statOf(entered))?.isDirectory()) return STOPS;
    return await isGitDirectory(platform, entered, entered) ? entered : STOPS;
  }
  return STOPS;
}
async function localRepository(url, base, { platform = process.platform, env = process.env } = {}) {
  const transport = gitTransportPath(url, platform);
  if (!transport) return null;
  if (transport.stops) return STOPS;
  const context = { platform, env };
  try {
    const cwd = await realPathText(base).catch((error) => {
      if (error instanceof UnresolvableLocalRemote) throw error;
      return path.resolve(base);
    });
    context.cwd = cwd;
    if (transport.plain && (await statOf(onDisk(platform, cwd, url)))?.isFile() && await isBundle(onDisk(platform, cwd, url))) return null;
    const entered = await enterRepo(transport.path, context);
    if (entered === STOPS) return STOPS;
    const named = platform === "win32" ? entered.replaceAll("\\", "/") : entered;
    const again = gitTransportPath(named, platform);
    if (!again?.plain || again.path !== named || await enterRepo(named, context).catch(() => null) !== entered) {
      throw new UnresolvableLocalRemote(`Git would open another repository for its path ${named}`);
    }
    return { path: named };
  } catch (error) {
    if (error === STOPS) return STOPS;
    throw error;
  }
}
async function isBundle(file) {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    const line = buffer.subarray(0, bytesRead).toString("latin1");
    return line === "# v2 git bundle\n" || line === "# v3 git bundle\n";
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}
export {
  UnresolvableLocalRemote,
  gitTransportPath,
  localRepository,
  localTransport
};
