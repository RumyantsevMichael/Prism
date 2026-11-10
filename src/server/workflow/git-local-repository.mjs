import { constants } from "node:fs";
import { access, lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The repository that Git's receive-pack or upload-pack enters for a remote URL that Git reaches by its local transport, found by Git's own rules:
// transport_get in transport.c picks the transport, parse_connect_url in connect.c takes the path from the URL, and enter_repo in path.c (setup.c from Git 2.48) finds the repository,
// as Git 2.25 through the current release do.
// A sync names that repository on Git's command line and reads its settings, so the repository whose settings Prism reads is the one Git opens.

/** A local URL whose repository Prism cannot find the way Git would; the sync or the first clone refuses it, and hint, when set, says what the person can change. */
export class UnresolvableLocalRemote extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

// Git stops before it starts any helper for the URL, as when it finds no repository, so the command can name the URL as it is and fail with Git's own message.
const STOPS = Object.freeze({ stops: true });
// The longest path, in bytes, that enter_repo takes; Git for Windows' limit is not known here, so a longer path there cannot be resolved.
const PATH_MAX = { linux: 4096, darwin: 1024, freebsd: 1024, openbsd: 1024 };
const SCHEME = "[A-Za-z0-9][A-Za-z0-9+.-]*";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const NOT_UTF8_HINT = "Rename the folders on the way to the remote repository so that every name is UTF-8, then name the repository by its path.";

// Node opens a path by its UTF-8 text, so a name that is not UTF-8, which Node would decode with replacement characters into another path, is refused rather than read as one.
function exactText(bytes, where) {
  try { return UTF8.decode(bytes); }
  catch { throw new UnresolvableLocalRemote(`${where} holds a name that is not UTF-8`, NOT_UTF8_HINT); }
}

// A real path, as its bytes spell it.
async function realPathText(file) {
  return exactText(await realpath(file, { encoding: "buffer" }), `the path ${file}`);
}

// A home folder that Node read from the environment or the password database, where a name that is not UTF-8 is already replaced.
function exactHome(home, where) {
  if (home.includes("\uFFFD")) throw new UnresolvableLocalRemote(`${where} holds a name that is not UTF-8`, NOT_UTF8_HINT);
  return home;
}

const isDirSep = (platform, character) => character === "/" || (platform === "win32" && character === "\\");

// has_dos_drive_prefix: never on POSIX; on Windows one character, which may be any Unicode character that `subst` assigns, followed by a colon.
function drivePrefix(platform, text) {
  if (platform !== "win32") return 0;
  const found = /^[^\0]:/u.exec(text);
  return found ? found[0].length : 0;
}

const isAbsolute = (platform, text) => isDirSep(platform, text[0]) || drivePrefix(platform, text) > 0;

// is_valid_win32_path with core.protectNTFS on, its default: no reserved device name, no character Windows forbids, and no name that ends in a space or a period.
// With core.protectNTFS off Git takes every path as valid, so a path this calls invalid cannot be resolved without the person's setting.
function validWindowsPath(text) {
  const rest = text.slice(drivePrefix("win32", text));
  for (const segment of rest.split(/[\\/]/)) {
    if (/[:<>"|?*\x01-\x1f]/.test(segment)) return false;
    if (/[ .]$/.test(segment) && segment !== "." && segment !== "..") return false;
    if (/^(?:AUX|NUL|PRN|CON|CONIN\$|CONOUT\$|COM[1-9]|LPT[0-9]) *(?:$|[.:])/i.test(segment)) return false;
  }
  return true;
}

// url_is_local_not_ssh: a path with no colon, or a slash before its first colon, or on Windows a drive path that Windows accepts; anything else names an SSH host.
function localNotSsh(platform, url) {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return true;
  if (!drivePrefix(platform, url)) return false;
  if (validWindowsPath(url)) return true;
  throw new UnresolvableLocalRemote(`Git reaches "${url}" as a Windows path or as an SSH host depending on its core.protectNTFS setting`);
}

// url_decode: every %XX with two hex digits becomes its byte, except %00, and the scheme before the first colon stays as it is.
// Node opens a path by its UTF-8 text, so a URL that decodes to bytes that are not UTF-8 cannot be resolved here.
function urlDecode(url) {
  const colon = url.indexOf(":");
  const bytes = Buffer.from(url.slice(colon), "utf8");
  const out = [];
  for (let at = 0; at < bytes.length; at++) {
    const hex = bytes.subarray(at + 1, at + 3).toString("latin1");
    if (bytes[at] === 0x25 && /^[0-9A-Fa-f]{2}$/.test(hex) && parseInt(hex, 16) > 0) {
      out.push(parseInt(hex, 16));
      at += 2;
      continue;
    }
    out.push(bytes[at]);
  }
  try { return url.slice(0, colon) + new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(out)); }
  catch { throw new UnresolvableLocalRemote(`"${url}" decodes to a path that is not UTF-8`, NOT_UTF8_HINT); }
}

// host_end without unwrapping: an IPv6-style [host], after the last @ when one is followed by [, ends at its closing bracket, and any other host ends where it starts.
function hostEnd(host) {
  const at = host.indexOf("@[");
  const start = at >= 0 ? at + 1 : 0;
  if (host[start] !== "[") return 0;
  const close = host.indexOf("]", start + 1);
  return close >= 0 ? close : 0;
}

// win32_offset_1st_component: the length of a path's root, which for a UNC path //server/share/ covers the server and the share.
function windowsRootLength(text) {
  let at = drivePrefix("win32", text);
  if (!at && isDirSep("win32", text[0]) && isDirSep("win32", text[1])) {
    const server = text.slice(2).search(/[\\/]/);
    if (server < 0) return 0;
    at = server + 2;
    do at++; while (at < text.length && !isDirSep("win32", text[at]));
  }
  return at + (isDirSep("win32", text[at]) ? 1 : 0);
}

/**
 * The path that Git hands to receive-pack or upload-pack for a remote URL, by transport_get and parse_connect_url, on this platform or the one given:
 * null when Git reaches the URL by another transport, { path, plain } for its local transport, where plain marks a path that is not a URL, and { stops: true } when Git refuses the URL before it starts a helper.
 * A Windows file:// URL whose path starts with a slash and a drive, as file:///C:/stores/records.git, names that drive's path.
 * It throws UnresolvableLocalRemote when the answer depends on a setting of the person's.
 */
export function gitTransportPath(url, platform = process.platform) {
  if (typeof url !== "string" || !url) return null;
  // A remote helper, named before :: or by the URL's scheme, and the retired rsync transport start no local helper.
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
  // On Windows a file://server/share/... URL keeps its leading // as a UNC path, and elsewhere the host is dropped.
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

/** Whether Git reaches a remote URL by its local transport, so receive-pack or upload-pack run on this machine inside the remote repository. */
export function localTransport(url, platform = process.platform) {
  try { return Boolean(gitTransportPath(url, platform)); } catch { return true; }
}

// A file system path for a path as Git spells it, from Git's working folder; a Windows drive path with no separator after the drive is relative to that drive's own folder, which is not known here.
function onDisk(platform, cwd, text) {
  if (platform !== "win32") return text.startsWith("/") ? text : `${cwd}/${text}`;
  const drive = drivePrefix(platform, text);
  if (drive && !isDirSep(platform, text[drive])) throw new UnresolvableLocalRemote(`"${text}" names a folder relative to its drive's current folder`);
  return path.win32.resolve(cwd, text);
}

const statOf = (file) => stat(file).catch(() => null);
const accessible = (file) => access(file, constants.X_OK).then(() => true, () => false);
// Git's isspace: a space, a tab, a line feed, or a carriage return.
const GIT_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

// validate_headref: HEAD is a symbolic link into refs/, a "ref:" line naming a ref under refs/, or a detached commit's hex object name.
async function validHead(platform, cwd, file) {
  const found = await lstat(onDisk(platform, cwd, file)).catch(() => null);
  if (!found) return false;
  if (found.isSymbolicLink()) return (await readlink(onDisk(platform, cwd, file), { encoding: "buffer" }).catch(() => Buffer.alloc(0))).subarray(0, 5).toString("latin1") === "refs/";
  if (found.isDirectory()) return false;
  if (!found.isFile()) throw new UnresolvableLocalRemote(`its HEAD ${file} is not a file`);
  const handle = await open(onDisk(platform, cwd, file), "r").catch(() => null);
  if (!handle) return false;
  let bytes;
  try { const { bytesRead, buffer } = await handle.read(Buffer.alloc(255), 0, 255, 0); bytes = buffer.subarray(0, bytesRead); }
  catch { return false; }
  finally { await handle.close(); }
  const nul = bytes.indexOf(0);
  const text = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (text.subarray(0, 4).toString("latin1") === "ref:") {
    let at = 4;
    while (GIT_SPACE.has(text[at])) at++;
    if (text.subarray(at, at + 5).toString("latin1") === "refs/") return true;
  }
  return /^[0-9A-Fa-f]{40}/.test(text.subarray(0, 40).toString("latin1"));
}

// strbuf_realpath with die_on_error: every component must resolve except a missing last one.
async function gitRealPath(platform, file) {
  let found;
  try { found = await realpath(file, { encoding: "buffer" }); }
  catch (error) {
    if (error.code !== "ENOENT") throw STOPS;
    const parent = platform === "win32" ? path.win32.dirname(file) : path.posix.dirname(file);
    if (parent === file) throw STOPS;
    let real;
    try { real = await realpath(parent, { encoding: "buffer" }); } catch { throw STOPS; }
    return path.join(exactText(real, `the path ${parent}`), path.basename(file));
  }
  return exactText(found, `the path ${file}`);
}

// is_git_directory: a valid HEAD, and objects and refs folders in the repository's common folder, which a commondir file names for a linked worktree's Git directory.
async function isGitDirectory(platform, cwd, suspect) {
  if (!(await validHead(platform, cwd, `${suspect}${suspect.endsWith("/") ? "" : "/"}HEAD`))) return false;
  let common = suspect;
  const commondir = `${suspect}/commondir`;
  if (await statOf(onDisk(platform, cwd, commondir))) {
    let data;
    try { data = await readFile(onDisk(platform, cwd, commondir)); } catch { throw STOPS; }
    if (!data.length) throw STOPS;
    let length = data.length;
    while (data[length - 1] === 0x0a || data[length - 1] === 0x0d) length--;
    let named = data.subarray(0, length);
    if (named.includes(0)) named = named.subarray(0, named.indexOf(0));
    const text = exactText(named, `its commondir file ${commondir}`);
    common = await gitRealPath(platform, onDisk(platform, cwd, isAbsolute(platform, text) ? text : `${suspect}/${text}`));
  } else {
    common = onDisk(platform, cwd, suspect);
  }
  return (await accessible(`${common}/objects`)) && (await accessible(`${common}/refs`));
}

// read_gitfile for a path enter_repo accepted: null for a folder, or the real path of the Git directory a .git file names; Git stops on a file that names none.
async function gitFileTarget(platform, cwd, file) {
  const found = await statOf(onDisk(platform, cwd, file));
  if (!found?.isFile()) return null;
  if (found.size > 1 << 20) throw STOPS;
  let contents;
  try { contents = await readFile(onDisk(platform, cwd, file)); } catch { throw STOPS; }
  if (contents.subarray(0, 8).toString("latin1") !== "gitdir: ") throw STOPS;
  let length = contents.length;
  while (contents[length - 1] === 0x0a || contents[length - 1] === 0x0d) length--;
  if (length < 9) throw STOPS;
  let named = contents.subarray(8, length);
  if (named.includes(0)) named = named.subarray(0, named.indexOf(0));
  let directory = exactText(named, `its .git file ${file}`);
  const slash = file.lastIndexOf("/");
  if (!isAbsolute(platform, directory) && slash >= 0) directory = `${file.slice(0, slash + 1)}${directory}`;
  if (!(await isGitDirectory(platform, cwd, directory))) throw STOPS;
  return gitRealPath(platform, onDisk(platform, cwd, directory));
}

// enter_repo without --strict: the real path of the Git directory that receive-pack and upload-pack change into for a path, from Git's working folder, or STOPS when Git finds none.
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
    // interpolate_path: ~ is HOME as it is, and ~user that user's home folder from the password database.
    const slash = used.indexOf("/") < 0 ? used.length : used.indexOf("/");
    const user = used.slice(1, slash);
    let home;
    if (!user) {
      home = env.HOME;
      if (home === undefined && platform === "win32") throw new UnresolvableLocalRemote("HOME is not set, and Git for Windows then finds a home folder of its own");
      if (home === undefined) return STOPS;
      exactHome(home, "HOME");
    } else {
      // Git for Windows has no password database, so ~user names no folder there.
      if (platform === "win32") return STOPS;
      let me = null;
      try { me = os.userInfo(); } catch { me = null; }
      if (!me || me.username !== user) throw new UnresolvableLocalRemote(`Prism cannot look up the home folder of the user ${user}`);
      home = exactHome(me.homedir, `the home folder of ${user}`);
    }
    used = `${home}${used.slice(slash)}`;
  }
  for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
    const candidate = `${used}${suffix}`;
    const found = await statOf(onDisk(platform, cwd, candidate));
    if (!found || !(found.isFile() || (found.isDirectory() && await isGitDirectory(platform, cwd, candidate)))) continue;
    const target = (await gitFileTarget(platform, cwd, candidate)) ?? onDisk(platform, cwd, candidate);
    const real = await realpath(target, { encoding: "buffer" }).catch(() => null);
    const entered = real && exactText(real, `the path ${target}`);
    if (!entered || !(await statOf(entered))?.isDirectory()) return STOPS;
    return (await isGitDirectory(platform, entered, entered)) ? entered : STOPS;
  }
  return STOPS;
}

/**
 * The repository that Git's receive-pack and upload-pack enter for a remote URL when Git runs from a folder: null for a remote that Git reaches by another transport or a bundle file,
 * { path } with the repository's absolute real path, which Git takes on its command line for the same repository, or { stops: true } when Git finds no repository there and fails on its own.
 * A first clone of a managed store gets a plain path only from a url.<base>.insteadOf rule, and Git hands that path to upload-pack as it is, which expands a leading ~, so a clone resolves it as a fetch does.
 * It throws UnresolvableLocalRemote when Prism cannot find the repository the way Git would, including when a name on the way is not UTF-8.
 */
export async function localRepository(url, base, { platform = process.platform, env = process.env } = {}) {
  const transport = gitTransportPath(url, platform);
  if (!transport) return null;
  if (transport.stops) return STOPS;
  const context = { platform, env };
  try {
    const cwd = await realPathText(base).catch((error) => { if (error instanceof UnresolvableLocalRemote) throw error; return path.resolve(base); });
    context.cwd = cwd;
    // A local path to a bundle file reaches the bundle transport, which starts no helper.
    if (transport.plain && (await statOf(onDisk(platform, cwd, url)))?.isFile() && await isBundle(onDisk(platform, cwd, url))) return null;
    const entered = await enterRepo(transport.path, context);
    if (entered === STOPS) return STOPS;
    const named = platform === "win32" ? entered.replaceAll("\\", "/") : entered;
    // Git takes the repository's own path as the same repository only when it parses back to itself and holds no .git that Git would enter instead.
    const again = gitTransportPath(named, platform);
    if (!again?.plain || again.path !== named || (await enterRepo(named, context).catch(() => null)) !== entered) {
      throw new UnresolvableLocalRemote(`Git would open another repository for its path ${named}`);
    }
    return { path: named };
  } catch (error) {
    if (error === STOPS) return STOPS;
    throw error;
  }
}

// is_bundle: the file starts with the signature of a version 2 or version 3 bundle.
async function isBundle(file) {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    const line = buffer.subarray(0, bytesRead).toString("latin1");
    return line === "# v2 git bundle\n" || line === "# v3 git bundle\n";
  } catch { return false; }
  finally { await handle.close(); }
}
