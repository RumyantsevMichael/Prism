// Generated from src/server/workflow/git-objects.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const HFS_IGNORED = /* @__PURE__ */ new Set([8204, 8205, 8206, 8207, 8234, 8235, 8236, 8237, 8238, 8298, 8299, 8300, 8301, 8302, 8303, 65279]);
function utf8CodePoint(bytes, at) {
  const byte = (offset) => bytes[at + offset] ?? 0;
  const s0 = byte(0);
  const follows = (count) => Array.from({ length: count }, (_, offset) => byte(offset + 1)).every((next) => (next & 192) === 128);
  if (s0 < 128) return { code: s0, size: 1 };
  if ((s0 & 224) === 192) return !follows(1) || (s0 & 254) === 192 ? null : { code: (s0 & 31) << 6 | byte(1) & 63, size: 2 };
  if ((s0 & 240) === 224) {
    if (!follows(2) || s0 === 224 && (byte(1) & 224) === 128 || s0 === 237 && (byte(1) & 224) === 160 || s0 === 239 && byte(1) === 191 && (byte(2) & 254) === 190) return null;
    return { code: (s0 & 15) << 12 | (byte(1) & 63) << 6 | byte(2) & 63, size: 3 };
  }
  if ((s0 & 248) === 240) {
    if (!follows(3) || s0 === 240 && (byte(1) & 240) === 128 || s0 === 244 && byte(1) > 143 || s0 > 244) return null;
    return { code: (s0 & 7) << 18 | (byte(1) & 63) << 12 | (byte(2) & 63) << 6 | byte(3) & 63, size: 4 };
  }
  return null;
}
function hfsDotName(bytes, needle) {
  let at = 0;
  const next = () => {
    for (; ; ) {
      const read = utf8CodePoint(bytes, at);
      if (!read) return 0;
      at += read.size;
      if (!HFS_IGNORED.has(read.code)) return read.code;
    }
  };
  if (next() !== 46) return false;
  for (const letter of needle) {
    const code = next();
    if (code > 127 || String.fromCharCode(code).toLowerCase() !== letter) return false;
  }
  const after = next();
  return after === 0 || after === 47 || after === 92;
}
function ntfsDotName(bytes, needle, shortPrefix) {
  const byte = (at2) => bytes[at2] ?? 0;
  const lower = (code) => code >= 65 && code <= 90 ? code + 32 : code;
  const sameLetters = (from, text) => [...text].every((letter, offset) => lower(byte(from + offset)) === letter.charCodeAt(0));
  const onlySpacesAndPeriods = (at2) => {
    for (; ; ) {
      const code = byte(at2++);
      if (code === 0 || code === 58) return true;
      if (code !== 32 && code !== 46) return false;
    }
  };
  if (byte(0) === 46 && sameLetters(1, needle)) return onlySpacesAndPeriods(needle.length + 1);
  if (sameLetters(0, needle.slice(0, 6)) && byte(6) === 126 && byte(7) >= 49 && byte(7) <= 52) return onlySpacesAndPeriods(8);
  let at = 0;
  for (let sawTilde = false; at < 8; at++) {
    const code = byte(at);
    if (code === 0) return false;
    if (sawTilde) {
      if (code < 48 || code > 57) return false;
    } else if (code === 126) {
      at += 1;
      if (byte(at) < 49 || byte(at) > 57) return false;
      sawTilde = true;
    } else if (at >= 6 || code & 128 || lower(code) !== shortPrefix.charCodeAt(at)) return false;
  }
  return onlySpacesAndPeriods(at);
}
function gitFileName(bytes) {
  return hfsDotName(bytes, "gitattributes") || ntfsDotName(bytes, "gitattributes", "gi7d29") || hfsDotName(bytes, "gitmodules") || ntfsDotName(bytes, "gitmodules", "gi7eba");
}
const dotGitName = (bytes) => hfsDotName(bytes, "git") || ntfsDotGit(bytes);
const modulesName = (bytes) => hfsDotName(bytes, "gitmodules") || ntfsDotName(bytes, "gitmodules", "gi7eba");
function ntfsDotGit(bytes) {
  const byte = (at2) => bytes[at2] ?? 0;
  const lower = (code) => code >= 65 && code <= 90 ? code + 32 : code;
  let at = 1;
  if (byte(0) === 46) {
    if (lower(byte(1)) !== 103 || lower(byte(2)) !== 105 || lower(byte(3)) !== 116) return false;
    at = 4;
  } else if (lower(byte(0)) === 103) {
    if (lower(byte(1)) !== 105 || lower(byte(2)) !== 116 || byte(3) !== 126 || byte(4) !== 49) return false;
    at = 5;
  } else return false;
  for (; ; ) {
    const code = byte(at++);
    if (code === 0 || code === 47 || code === 92 || code === 58) return true;
    if (code !== 46 && code !== 32) return false;
  }
}
const S_IFMT = 61440;
const isTreeMode = (mode) => (mode & S_IFMT) === 16384;
const isLinkMode = (mode) => (mode & S_IFMT) === 40960;
const STANDARD_MODES = /* @__PURE__ */ new Set([33261, 33188, 40960, 16384, 57344]);
const TREE_NAME_BYTES_MAX = 4096;
function treeEntryAt(contents, at, hashSize) {
  if (contents.length - at < hashSize + 3 || contents[contents.length - (hashSize + 1)] !== 0) return null;
  if (contents[at] === 32) return null;
  let mode = 0;
  let cursor = at;
  for (; ; ) {
    const code = contents[cursor++];
    if (code === 32) break;
    if (code === void 0 || code < 48 || code > 55) return null;
    mode = (mode << 3) + (code - 48) >>> 0;
  }
  if (contents[cursor] === 0) return null;
  const end = contents.indexOf(0, cursor);
  return { start: at, mode: mode & 65535, modeText: contents.subarray(at, cursor - 1).toString("latin1"), name: contents.subarray(cursor, end), object: contents.subarray(end + 1, end + 1 + hashSize).toString("hex"), next: end + 1 + hashSize };
}
function treeEntries(contents, hashSize) {
  const entries = [];
  for (let at = 0; at < contents.length; ) {
    const entry = treeEntryAt(contents, at, hashSize);
    if (!entry) break;
    entries.push(entry);
    at = entry.next;
  }
  return entries;
}
const UNORDERED = -1;
const DUPLICATE = -2;
const lessThanSlash = (code) => code > 0 && code < 47;
function verifyOrdered(mode1, name1, mode2, name2, candidates) {
  const length = Math.min(name1.length, name2.length);
  const compared = Buffer.compare(name1.subarray(0, length), name2.subarray(0, length));
  if (compared < 0) return 0;
  if (compared > 0) return UNORDERED;
  let c1 = name1[length] ?? 0;
  let c2 = name2[length] ?? 0;
  if (!c1 && !c2) return DUPLICATE;
  if (!c1 && isTreeMode(mode1)) c1 = 47;
  if (!c2 && isTreeMode(mode2)) c2 = 47;
  if (!c1 && lessThanSlash(c2)) candidates.push(name1);
  else if (c2 === 47 && lessThanSlash(c1)) {
    for (; ; ) {
      const file = candidates.pop();
      if (!file) break;
      if (!name2.subarray(0, file.length).equals(file)) continue;
      const after = name2[file.length] ?? 0;
      if (!after) return DUPLICATE;
      if (lessThanSlash(after)) {
        candidates.push(file);
        break;
      }
    }
  }
  return c1 < c2 ? 0 : UNORDERED;
}
function treeProblems(contents, hashSize) {
  const found = /* @__PURE__ */ new Map();
  const report = (id, name) => {
    if (!found.has(id)) found.set(id, []);
    if (name) found.get(id).push(name);
  };
  let entry = contents.length ? treeEntryAt(contents, 0, hashSize) : void 0;
  if (entry === null) report("badTree");
  let previous = null;
  const candidates = [];
  while (entry) {
    const { mode, name } = entry;
    if (/^0+$/.test(entry.object)) report("nullSha1", name);
    if (name.includes(47)) report("fullPathname", name);
    if (!name.length) report("emptyName", name);
    if (name.length === 1 && name[0] === 46) report("hasDot", name);
    if (name.length === 2 && name[0] === 46 && name[1] === 46) report("hasDotdot", name);
    if (dotGitName(name)) report("hasDotgit", name);
    if (contents[entry.start] === 48) report("zeroPaddedFilemode", name);
    if (name.length > TREE_NAME_BYTES_MAX) report("largePathname", name);
    if (isLinkMode(mode) && modulesName(name)) report("gitmodulesSymlink", name);
    for (let slash = name.indexOf(92); slash >= 0; slash = name.indexOf(92, slash + 1)) {
      const rest = name.subarray(slash + 1);
      if (ntfsDotGit(rest)) report("hasDotgit", name);
      if (isLinkMode(mode) && ntfsDotName(rest, "gitmodules", "gi7eba")) report("gitmodulesSymlink", name);
    }
    const next = entry.next < contents.length ? treeEntryAt(contents, entry.next, hashSize) : void 0;
    if (next === null) {
      report("badTree");
      break;
    }
    if (previous) {
      const order = verifyOrdered(previous.mode, previous.name, mode, name, candidates);
      if (order === UNORDERED) report("treeNotSorted", name);
      else if (order === DUPLICATE) report("duplicateEntries", name);
    }
    previous = entry;
    entry = next;
  }
  return [...found].map(([id, names]) => ({ id, text: TREE_TEXT[id], names }));
}
const TREE_DEPTH_MAX = 2048;
const TREE_DEPTH_TEXT = "exceeded maximum allowed tree depth";
function tooDeepTree(roots, trees) {
  const deepest = /* @__PURE__ */ new Map();
  const folders = (tree) => treeEntries(trees.get(tree), tree.length / 2).filter((entry) => isTreeMode(entry.mode) && trees.has(entry.object));
  for (const root of roots) {
    if (!trees.has(root)) continue;
    const walking = /* @__PURE__ */ new Set([root]);
    const stack = [{ tree: root, folders: folders(root), next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const folder = top.folders[top.next];
      if (folder) {
        top.next += 1;
        if (!deepest.has(folder.object) && !walking.has(folder.object)) {
          walking.add(folder.object);
          stack.push({ tree: folder.object, folders: folders(folder.object), next: 0 });
        }
        continue;
      }
      let best = { depth: 0, via: null };
      for (const entry of top.folders) {
        const below = (deepest.get(entry.object)?.depth ?? 0) + 1;
        if (below > best.depth) best = { depth: below, via: entry };
      }
      deepest.set(top.tree, best);
      walking.delete(top.tree);
      stack.pop();
    }
    const found = deepest.get(root);
    if (found.depth > TREE_DEPTH_MAX) {
      const names = [];
      for (let step = found; step.via; step = deepest.get(step.via.object)) names.push(step.via.name);
      return { root, depth: found.depth, names };
    }
  }
  return null;
}
const TREE_TEXT = {
  badTree: "cannot be parsed as a tree",
  nullSha1: "contains entries pointing to null sha1",
  fullPathname: "contains full pathnames",
  emptyName: "contains empty pathname",
  hasDot: "contains '.'",
  hasDotdot: "contains '..'",
  hasDotgit: "contains '.git'",
  zeroPaddedFilemode: "contains zero-padded file modes",
  largePathname: "contains excessively large pathname",
  gitmodulesSymlink: ".gitmodules is a symbolic link",
  duplicateEntries: "contains duplicate file entries",
  treeNotSorted: "not properly sorted"
};
function commitProblem(contents, hexLength) {
  for (let at2 = 0; at2 < contents.length; at2++) {
    if (contents[at2] === 0) return { id: "nulInHeader", text: `unterminated header: NUL at offset ${at2}` };
    if (contents[at2] === 10 && contents[at2 + 1] === 10) break;
    if (at2 === contents.length - 1 && contents[at2] !== 10) return { id: "unterminatedHeader", text: "unterminated header" };
  }
  if (!contents.length) return { id: "unterminatedHeader", text: "unterminated header" };
  const byte = (at2) => contents[at2] ?? 0;
  const startsWith = (at2, text) => at2 < contents.length && contents.subarray(at2, at2 + text.length).equals(Buffer.from(text));
  const objectLine = (at2) => /^[0-9a-fA-F]+$/.test(contents.subarray(at2, at2 + hexLength).toString("latin1")) && contents.subarray(at2, at2 + hexLength).length === hexLength && byte(at2 + hexLength) === 10;
  let at = 0;
  if (!startsWith(at, "tree ")) return { id: "missingTree", text: "invalid format - expected 'tree' line" };
  if (!objectLine(at + 5)) return { id: "badTreeSha1", text: "invalid 'tree' line format - bad sha1" };
  at += 5 + hexLength + 1;
  while (startsWith(at, "parent ")) {
    if (!objectLine(at + 7)) return { id: "badParentSha1", text: "invalid 'parent' line format - bad sha1" };
    at += 7 + hexLength + 1;
  }
  let authors = 0;
  while (startsWith(at, "author ")) {
    authors += 1;
    const read = identity(contents, at + 7);
    if (read.problem) return read.problem;
    at = read.next;
  }
  if (authors < 1) return { id: "missingAuthor", text: "invalid format - expected 'author' line" };
  if (authors > 1) return { id: "multipleAuthors", text: "invalid format - multiple 'author' lines" };
  if (!startsWith(at, "committer ")) return { id: "missingCommitter", text: "invalid format - expected 'committer' line" };
  const committer = identity(contents, at + 10);
  if (committer.problem) return committer.problem;
  if (contents.includes(0)) return { id: "nulInCommit", text: "NUL byte in the commit object body" };
  return null;
}
const DATE_MAX = 2n ** 63n - 1n;
function identity(contents, from) {
  const byte = (at2) => contents[at2] ?? 0;
  const lineEnd = contents.indexOf(10, from);
  const next = lineEnd < 0 ? contents.length : lineEnd + 1;
  const fail = (id, what) => ({ next, problem: { id, text: `invalid author/committer line - ${what}` } });
  const isDigit = (code) => code >= 48 && code <= 57;
  const skipName = (at2) => {
    while (![60, 62, 10, 0].includes(byte(at2))) at2++;
    return at2;
  };
  let at = from;
  if (byte(at) === 60) return fail("missingNameBeforeEmail", "missing space before email");
  at = skipName(at);
  if (byte(at) === 62) return fail("badName", "bad name");
  if (byte(at) !== 60) return fail("missingEmail", "missing email");
  if (byte(at - 1) !== 32) return fail("missingSpaceBeforeEmail", "missing space before email");
  at = skipName(at + 1);
  if (byte(at) !== 62) return fail("badEmail", "bad email");
  at += 1;
  if (byte(at) !== 32) return fail("missingSpaceBeforeDate", "missing space before date");
  at += 1;
  while (byte(at) === 32 || byte(at) === 9) at++;
  if (!isDigit(byte(at))) return fail("badDate", "bad date");
  if (byte(at) === 48 && byte(at + 1) !== 32) return fail("zeroPaddedDate", "zero-padded date");
  let end = at;
  while (isDigit(byte(end))) end++;
  if (BigInt(contents.subarray(at, end).toString("latin1")) > DATE_MAX) return fail("badDateOverflow", "date causes integer overflow");
  if (byte(end) !== 32) return fail("badDate", "bad date");
  at = end + 1;
  if (byte(at) !== 43 && byte(at) !== 45 || ![1, 2, 3, 4].every((offset) => isDigit(byte(at + offset))) || byte(at + 5) !== 10) return fail("badTimezone", "bad time zone");
  return { next, problem: null };
}
const LINK_TARGET_BYTES_MAX = 260;
function linkTargetProblem(target) {
  if (target.length > LINK_TARGET_BYTES_MAX) return { id: "symlinkTargetLength", text: "symlink target too long" };
  const parts = [];
  for (let at = 0; at <= target.length; ) {
    let end = at;
    while (end < target.length && target[end] !== 47 && target[end] !== 92) end++;
    parts.push(target.subarray(at, end));
    at = end + 1;
  }
  return parts.some(dotGitName) ? { id: "symlinkPointsToGitDir", text: "symlink target points to git dir" } : null;
}
const NO_OBJECT = /^0+$/;
async function changedBlobs(projectRoot, from, to) {
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const prefix = (await execute("git", ["rev-parse", "--show-prefix"], { cwd: projectRoot, env, windowsHide: true })).stdout.trim();
    const { stdout } = await execute("git", ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", ...prefix ? [`--relative=${prefix}`] : [], "--end-of-options", from, to], { cwd: projectRoot, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    const fields = stdout.split("\0");
    const changed = [];
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const object = fields[at].split(" ")[3];
      if (fields[at][0] !== ":" || object === void 0) return null;
      changed.push({ path: fields[at + 1], blob: NO_OBJECT.test(object) ? null : object });
    }
    return changed;
  } catch {
    return null;
  }
}
async function objectsAt(projectRoot, tree, paths) {
  const found = new Map(paths.map((item) => [item, null]));
  if (!paths.length) return found;
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const { stdout } = await execute("git", ["--literal-pathspecs", "ls-tree", "-z", "--full-name", "--end-of-options", tree, "--", ...paths], { cwd: projectRoot, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const prefix = (await execute("git", ["rev-parse", "--show-prefix"], { cwd: projectRoot, env, windowsHide: true })).stdout.trim();
    for (const line of stdout.split("\0")) {
      const tab = line.indexOf("	");
      if (tab < 0) continue;
      const name = line.slice(tab + 1);
      const relative = name.startsWith(prefix) ? name.slice(prefix.length) : null;
      if (relative !== null && found.has(relative)) found.set(relative, line.slice(0, tab).split(" ")[2]);
    }
    return found;
  } catch {
    return null;
  }
}
export {
  LINK_TARGET_BYTES_MAX,
  TREE_DEPTH_MAX,
  TREE_DEPTH_TEXT,
  TREE_NAME_BYTES_MAX,
  changedBlobs,
  commitProblem,
  dotGitName,
  gitFileName,
  isLinkMode,
  isTreeMode,
  linkTargetProblem,
  objectsAt,
  tooDeepTree,
  treeEntries,
  treeProblems
};
