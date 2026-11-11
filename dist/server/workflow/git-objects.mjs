// Git's own checks of the objects that a fetch with fetch.fsckObjects, or a clone with transfer.fsckObjects, runs on what it receives, ported from Git's source,
// so the store sync applies them whatever this machine's Git checks: a commit or a tree that passes here passes the check of every Git release from 2.25 to 2.52.
// Each rule names the Git function it ports; the releases that added a rule are noted where an older supported Git lacks it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Code points that HFS+ ignores in a name, as Git 2.43's next_hfs_char in utf8.c lists them.
const HFS_IGNORED = new Set([0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff]);

/**
 * The code point at a byte of a name and its length, as Git 2.43's pick_one_utf8_char in utf8.c reads it: the name ends at its last byte as at a zero byte,
 * and a byte that begins no UTF-8 character, an overlong form, a surrogate, a code point above U+10FFFF, U+FFFE, and U+FFFF are all malformed, which is null.
 */
function utf8CodePoint(bytes, at) {
  const byte = (offset) => bytes[at + offset] ?? 0;
  const s0 = byte(0);
  const follows = (count) => Array.from({ length: count }, (_, offset) => byte(offset + 1)).every((next) => (next & 0xc0) === 0x80);
  if (s0 < 0x80) return { code: s0, size: 1 };
  if ((s0 & 0xe0) === 0xc0) return !follows(1) || (s0 & 0xfe) === 0xc0 ? null : { code: ((s0 & 0x1f) << 6) | (byte(1) & 0x3f), size: 2 };
  if ((s0 & 0xf0) === 0xe0) {
    if (!follows(2) || (s0 === 0xe0 && (byte(1) & 0xe0) === 0x80) || (s0 === 0xed && (byte(1) & 0xe0) === 0xa0) || (s0 === 0xef && byte(1) === 0xbf && (byte(2) & 0xfe) === 0xbe)) return null;
    return { code: ((s0 & 0x0f) << 12) | ((byte(1) & 0x3f) << 6) | (byte(2) & 0x3f), size: 3 };
  }
  if ((s0 & 0xf8) === 0xf0) {
    if (!follows(3) || (s0 === 0xf0 && (byte(1) & 0xf0) === 0x80) || (s0 === 0xf4 && byte(1) > 0x8f) || s0 > 0xf4) return null;
    return { code: ((s0 & 0x07) << 18) | ((byte(1) & 0x3f) << 12) | ((byte(2) & 0x3f) << 6) | (byte(3) & 0x3f), size: 4 };
  }
  return null;
}

/**
 * Whether a name's bytes are "." and the needle as Git 2.43's is_hfs_dot_generic in utf8.c reads them: HFS+'s ignored code points anywhere, ASCII letters in any case,
 * and after the needle the name's end, a malformed byte, or a folder separator, which is "/" and, on Git for Windows, "\".
 */
function hfsDotName(bytes, needle) {
  let at = 0;
  const next = () => {
    for (;;) {
      const read = utf8CodePoint(bytes, at);
      if (!read) return 0;
      at += read.size;
      if (!HFS_IGNORED.has(read.code)) return read.code;
    }
  };
  if (next() !== 0x2e) return false;
  for (const letter of needle) {
    const code = next();
    if (code > 127 || String.fromCharCode(code).toLowerCase() !== letter) return false;
  }
  const after = next();
  return after === 0 || after === 0x2f || after === 0x5c;
}

/**
 * Whether a name's bytes are one that Git 2.43's is_ntfs_dot_generic in path.c reads as "." and the needle: the needle in any ASCII letter case,
 * a short name of the needle's first six letters followed by "~1" to "~4", or a fall-back short name of up to six letters of shortPrefix, a "~", and digits, eight bytes in all,
 * each then followed only by spaces and dots up to the name's end or a colon.
 */
function ntfsDotName(bytes, needle, shortPrefix) {
  const byte = (at) => bytes[at] ?? 0;
  const lower = (code) => code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
  const sameLetters = (from, text) => [...text].every((letter, offset) => lower(byte(from + offset)) === letter.charCodeAt(0));
  const onlySpacesAndPeriods = (at) => {
    for (;;) {
      const code = byte(at++);
      if (code === 0 || code === 0x3a) return true;
      if (code !== 0x20 && code !== 0x2e) return false;
    }
  };
  if (byte(0) === 0x2e && sameLetters(1, needle)) return onlySpacesAndPeriods(needle.length + 1);
  if (sameLetters(0, needle.slice(0, 6)) && byte(6) === 0x7e && byte(7) >= 0x31 && byte(7) <= 0x34) return onlySpacesAndPeriods(8);
  let at = 0;
  for (let sawTilde = false; at < 8; at++) {
    const code = byte(at);
    if (code === 0) return false;
    if (sawTilde) { if (code < 0x30 || code > 0x39) return false; }
    else if (code === 0x7e) {
      at += 1;
      if (byte(at) < 0x31 || byte(at) > 0x39) return false;
      sawTilde = true;
    } else if (at >= 6 || code & 0x80 || lower(code) !== shortPrefix.charCodeAt(at)) return false;
  }
  return onlySpacesAndPeriods(at);
}

/**
 * Whether a tree entry's name is one that Git 2.43's object check reads as .gitattributes or .gitmodules on some machine, as is_hfs_dotgitattributes, is_ntfs_dotgitattributes,
 * is_hfs_dotgitmodules, and is_ntfs_dotgitmodules match its bytes, such as .GitModules, .gitattributes followed by U+200C, U+FFFE, or a byte that is not UTF-8, or GITATT~1 and gi7eba~9.
 * A store shares no .gitmodules and holds a .gitattributes only as the file at its root, so every other entry with such a name, of any mode, is one no store may hold,
 * whatever this machine's Git checks of it.
 */
export function gitFileName(bytes) {
  return hfsDotName(bytes, "gitattributes") || ntfsDotName(bytes, "gitattributes", "gi7d29") || hfsDotName(bytes, "gitmodules") || ntfsDotName(bytes, "gitmodules", "gi7eba");
}

/** Whether a name's bytes are one that Git's is_hfs_dotgit (utf8.c) or is_ntfs_dotgit (path.c) reads as Git's own folder, such as .GIT, ".git ", GIT~1, or .git followed by U+200C. */
export const dotGitName = (bytes) => hfsDotName(bytes, "git") || ntfsDotGit(bytes);

/** Whether a name's bytes are .gitmodules as Git's is_hfs_dotgitmodules or is_ntfs_dotgitmodules reads them. */
const modulesName = (bytes) => hfsDotName(bytes, "gitmodules") || ntfsDotName(bytes, "gitmodules", "gi7eba");

/**
 * Whether a name's bytes begin with .git or git~1, in any ASCII letter case, followed only by dots and spaces up to the name's end, a colon, or a folder separator,
 * as Git 2.43's is_ntfs_dotgit in path.c reads them; Git for Windows reads "/" and "\\" as folder separators.
 */
function ntfsDotGit(bytes) {
  const byte = (at) => bytes[at] ?? 0;
  const lower = (code) => code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
  let at = 1;
  if (byte(0) === 0x2e) {
    if (lower(byte(1)) !== 0x67 || lower(byte(2)) !== 0x69 || lower(byte(3)) !== 0x74) return false;
    at = 4;
  } else if (lower(byte(0)) === 0x67) {
    if (lower(byte(1)) !== 0x69 || lower(byte(2)) !== 0x74 || byte(3) !== 0x7e || byte(4) !== 0x31) return false;
    at = 5;
  } else return false;
  for (;;) {
    const code = byte(at++);
    if (code === 0 || code === 0x2f || code === 0x5c || code === 0x3a) return true;
    if (code !== 0x2e && code !== 0x20) return false;
  }
}

const S_IFMT = 0o170000;
export const isTreeMode = (mode) => (mode & S_IFMT) === 0o040000;
export const isLinkMode = (mode) => (mode & S_IFMT) === 0o120000;
// The modes Git's fsck_tree takes as standard: a file, an executable file, a link, a folder, and a submodule link.
const STANDARD_MODES = new Set([0o100755, 0o100644, 0o120000, 0o040000, 0o160000]);
// The longest tree entry name that Git 2.43 and later accept, as fsck.c's max_tree_entry_len sets it; a longer one is largePathname, which a checked fetch refuses.
export const TREE_NAME_BYTES_MAX = 4096;

/**
 * The tree entry that starts at a byte of a tree, as Git 2.43's decode_tree_entry in tree-walk.c reads it, or null where Git reads the tree as malformed:
 * { start, mode, modeText, name, object, next }, where mode is the octal mode as fsck_tree holds it, in 16 bits, name the name's bytes, and next the byte where the next entry starts.
 */
function treeEntryAt(contents, at, hashSize) {
  if (contents.length - at < hashSize + 3 || contents[contents.length - (hashSize + 1)] !== 0) return null;
  if (contents[at] === 0x20) return null;
  let mode = 0;
  let cursor = at;
  for (;;) {
    const code = contents[cursor++];
    if (code === 0x20) break;
    if (code === undefined || code < 0x30 || code > 0x37) return null;
    mode = ((mode << 3) + (code - 0x30)) >>> 0;
  }
  if (contents[cursor] === 0) return null;
  const end = contents.indexOf(0, cursor);
  return { start: at, mode: mode & 0xffff, modeText: contents.subarray(at, cursor - 1).toString("latin1"), name: contents.subarray(cursor, end), object: contents.subarray(end + 1, end + 1 + hashSize).toString("hex"), next: end + 1 + hashSize };
}

/** The entries of a tree's bytes in their order, up to the first that Git reads as malformed. */
export function treeEntries(contents, hashSize) {
  const entries = [];
  for (let at = 0; at < contents.length;) {
    const entry = treeEntryAt(contents, at, hashSize);
    if (!entry) break;
    entries.push(entry);
    at = entry.next;
  }
  return entries;
}

const UNORDERED = -1;
const DUPLICATE = -2;
const lessThanSlash = (code) => code > 0 && code < 0x2f;

/**
 * Whether two adjacent tree entries are in Git's order, as Git 2.43's verify_ordered in fsck.c decides: 0, UNORDERED, or DUPLICATE.
 * A folder sorts as its name with "/" added, and candidates keeps the files that a later folder of one name could duplicate, such as "a" before "a-b" and the folder "a".
 */
function verifyOrdered(mode1, name1, mode2, name2, candidates) {
  const length = Math.min(name1.length, name2.length);
  const compared = Buffer.compare(name1.subarray(0, length), name2.subarray(0, length));
  if (compared < 0) return 0;
  if (compared > 0) return UNORDERED;
  let c1 = name1[length] ?? 0;
  let c2 = name2[length] ?? 0;
  if (!c1 && !c2) return DUPLICATE;
  if (!c1 && isTreeMode(mode1)) c1 = 0x2f;
  if (!c2 && isTreeMode(mode2)) c2 = 0x2f;
  if (!c1 && lessThanSlash(c2)) candidates.push(name1);
  else if (c2 === 0x2f && lessThanSlash(c1)) {
    for (;;) {
      const file = candidates.pop();
      if (!file) break;
      if (!name2.subarray(0, file.length).equals(file)) continue;
      const after = name2[file.length] ?? 0;
      if (!after) return DUPLICATE;
      if (lessThanSlash(after)) { candidates.push(file); break; }
    }
  }
  return c1 < c2 ? 0 : UNORDERED;
}

/**
 * What a checked fetch of Git 2.43 to 2.52 refuses in a tree's bytes, as fsck_tree in fsck.c reports it with --strict, which makes every warning an error:
 * [{ id, text, names }], with Git's message id and text and the names of the entries it concerns, or [] for a tree every such Git accepts.
 * Git 2.25 to 2.42 refuse a subset of these: before 2.27 no file and folder of one name that are not adjacent, and before 2.43 no name over 4096 bytes.
 * badFilemode and the info messages on links named .gitattributes, .gitignore, or .mailmap never fail a fetch, so they are not reported.
 * The .gitmodules and .gitattributes that a tree holds are checked by their blobs, which the caller reads.
 */
export function treeProblems(contents, hashSize) {
  const found = new Map();
  const report = (id, name) => { if (!found.has(id)) found.set(id, []); if (name) found.get(id).push(name); };
  let entry = contents.length ? treeEntryAt(contents, 0, hashSize) : undefined;
  if (entry === null) report("badTree");
  let previous = null;
  const candidates = [];
  while (entry) {
    const { mode, name } = entry;
    if (/^0+$/.test(entry.object)) report("nullSha1", name);
    if (name.includes(0x2f)) report("fullPathname", name);
    if (!name.length) report("emptyName", name);
    if (name.length === 1 && name[0] === 0x2e) report("hasDot", name);
    if (name.length === 2 && name[0] === 0x2e && name[1] === 0x2e) report("hasDotdot", name);
    if (dotGitName(name)) report("hasDotgit", name);
    if (contents[entry.start] === 0x30) report("zeroPaddedFilemode", name);
    if (name.length > TREE_NAME_BYTES_MAX) report("largePathname", name);
    if (isLinkMode(mode) && modulesName(name)) report("gitmodulesSymlink", name);
    for (let slash = name.indexOf(0x5c); slash >= 0; slash = name.indexOf(0x5c, slash + 1)) {
      const rest = name.subarray(slash + 1);
      if (ntfsDotGit(rest)) report("hasDotgit", name);
      if (isLinkMode(mode) && ntfsDotName(rest, "gitmodules", "gi7eba")) report("gitmodulesSymlink", name);
    }
    const next = entry.next < contents.length ? treeEntryAt(contents, entry.next, hashSize) : undefined;
    if (next === null) { report("badTree"); break; }
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

// The deepest that Git 2.43 and later walk trees, the default of core.maxTreeDepth (environment.c in 2.43, repo-settings.c's DEFAULT_MAX_ALLOWED_TREE_DEPTH later).
export const TREE_DEPTH_MAX = 2048;
// Git's words when a walk goes deeper, as list-objects.c's process_tree dies with them.
export const TREE_DEPTH_TEXT = "exceeded maximum allowed tree depth";

/**
 * The first root below which a tree sits deeper than TREE_DEPTH_MAX, as Git 2.43's process_tree in list-objects.c counts depth: a commit's root tree is at depth 0,
 * each folder is one deeper than the tree that holds it, and the walk stops at a tree deeper than 2048, so every Git 2.43 or later fetch whose walk reaches it fails, as Git 2.25 to 2.42 never do.
 * Git counts the path on which its walk first reaches a tree, and another machine's walk starts from other commits, so every path through the given trees counts here.
 * trees holds the bytes of the trees a walk would reach, as Map(object, bytes); a folder whose tree it lacks does not count, as Git skips a tree that the fetching machine already holds before it counts it.
 * Returns { root, depth, names }, where names are the bytes of the folder names on the deepest path from that root, or null.
 */
export function tooDeepTree(roots, trees) {
  const deepest = new Map();
  const folders = (tree) => treeEntries(trees.get(tree), tree.length / 2).filter((entry) => isTreeMode(entry.mode) && trees.has(entry.object));
  for (const root of roots) {
    if (!trees.has(root)) continue;
    // Each tree's depth below it is found once, without recursion, so a chain of any length fits the stack.
    const walking = new Set([root]);
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

// Git 2.43's words for each tree message, as fsck_tree reports it.
const TREE_TEXT = {
  badTree: "cannot be parsed as a tree", nullSha1: "contains entries pointing to null sha1", fullPathname: "contains full pathnames", emptyName: "contains empty pathname",
  hasDot: "contains '.'", hasDotdot: "contains '..'", hasDotgit: "contains '.git'", zeroPaddedFilemode: "contains zero-padded file modes", largePathname: "contains excessively large pathname",
  gitmodulesSymlink: ".gitmodules is a symbolic link", duplicateEntries: "contains duplicate file entries", treeNotSorted: "not properly sorted"
};

/**
 * What a checked fetch of Git 2.40 to 2.52 refuses in a commit's bytes, as verify_headers, fsck_commit, and fsck_ident in fsck.c report it with --strict: { id, text }, or null.
 * Git 2.25 to 2.39 also take a date after spaces that are not spaces or tabs, such as a carriage return, which Git 2.40 refuses as badDate; every other rule is the same in each release.
 */
export function commitProblem(contents, hexLength) {
  for (let at = 0; at < contents.length; at++) {
    if (contents[at] === 0) return { id: "nulInHeader", text: `unterminated header: NUL at offset ${at}` };
    if (contents[at] === 10 && contents[at + 1] === 10) break;
    if (at === contents.length - 1 && contents[at] !== 10) return { id: "unterminatedHeader", text: "unterminated header" };
  }
  if (!contents.length) return { id: "unterminatedHeader", text: "unterminated header" };
  const byte = (at) => contents[at] ?? 0;
  const startsWith = (at, text) => at < contents.length && contents.subarray(at, at + text.length).equals(Buffer.from(text));
  const objectLine = (at) => /^[0-9a-fA-F]+$/.test(contents.subarray(at, at + hexLength).toString("latin1")) && contents.subarray(at, at + hexLength).length === hexLength && byte(at + hexLength) === 10;
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

// The largest date that Git's date_overflows takes, which a 64-bit signed time_t holds.
const DATE_MAX = 2n ** 63n - 1n;

/** An author or committer line from its first byte after the keyword, as Git 2.43's fsck_ident reads it: { next, problem }, where next is the byte after its line. */
function identity(contents, from) {
  const byte = (at) => contents[at] ?? 0;
  const lineEnd = contents.indexOf(10, from);
  const next = lineEnd < 0 ? contents.length : lineEnd + 1;
  const fail = (id, what) => ({ next, problem: { id, text: `invalid author/committer line - ${what}` } });
  const isDigit = (code) => code >= 0x30 && code <= 0x39;
  const skipName = (at) => { while (![0x3c, 0x3e, 10, 0].includes(byte(at))) at++; return at; };
  let at = from;
  if (byte(at) === 0x3c) return fail("missingNameBeforeEmail", "missing space before email");
  at = skipName(at);
  if (byte(at) === 0x3e) return fail("badName", "bad name");
  if (byte(at) !== 0x3c) return fail("missingEmail", "missing email");
  if (byte(at - 1) !== 0x20) return fail("missingSpaceBeforeEmail", "missing space before email");
  at = skipName(at + 1);
  if (byte(at) !== 0x3e) return fail("badEmail", "bad email");
  at += 1;
  if (byte(at) !== 0x20) return fail("missingSpaceBeforeDate", "missing space before date");
  at += 1;
  while (byte(at) === 0x20 || byte(at) === 0x09) at++;
  if (!isDigit(byte(at))) return fail("badDate", "bad date");
  if (byte(at) === 0x30 && byte(at + 1) !== 0x20) return fail("zeroPaddedDate", "zero-padded date");
  let end = at;
  while (isDigit(byte(end))) end++;
  if (BigInt(contents.subarray(at, end).toString("latin1")) > DATE_MAX) return fail("badDateOverflow", "date causes integer overflow");
  if (byte(end) !== 0x20) return fail("badDate", "bad date");
  at = end + 1;
  if ((byte(at) !== 0x2b && byte(at) !== 0x2d) || ![1, 2, 3, 4].every((offset) => isDigit(byte(at + offset))) || byte(at + 5) !== 10) return fail("badTimezone", "bad time zone");
  return { next, problem: null };
}

// The longest link target that Git 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1, and 2.45.1 accept, their PATH_MAX, which is 260 bytes on Windows.
export const LINK_TARGET_BYTES_MAX = 260;

/**
 * What those releases' fsck_blob refuses in a link's target, which every later release dropped again: symlinkTargetLength for one longer than PATH_MAX,
 * and symlinkPointsToGitDir for one with a part, between "/" or "\\", that Git reads as its own folder; { id, text } or null.
 */
export function linkTargetProblem(target) {
  if (target.length > LINK_TARGET_BYTES_MAX) return { id: "symlinkTargetLength", text: "symlink target too long" };
  const parts = [];
  for (let at = 0; at <= target.length;) {
    let end = at;
    while (end < target.length && target[end] !== 0x2f && target[end] !== 0x5c) end++;
    parts.push(target.subarray(at, end));
    at = end + 1;
  }
  return parts.some(dotGitName) ? { id: "symlinkPointsToGitDir", text: "symlink target points to git dir" } : null;
}

// Git's object identifier of no object, which a raw diff names for the side where a path is absent.
const NO_OBJECT = /^0+$/;

/**
 * The paths that differ between two trees of a project's repository and each path's object in the second tree:
 * [{ path, blob }] in Git's order, blob null where the second tree does not hold the path, and a moved file a removal and an addition.
 * A project below its Git top folder counts only its own paths, relative to the project root, as its content trees hold the whole checkout.
 * Returns null when Git cannot compare the trees, such as when it no longer holds one of them.
 */
export async function changedBlobs(projectRoot, from, to) {
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const prefix = (await execute("git", ["rev-parse", "--show-prefix"], { cwd: projectRoot, env })).stdout.trim();
    const { stdout } = await execute("git", ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", ...(prefix ? [`--relative=${prefix}`] : []), "--end-of-options", from, to], { cwd: projectRoot, env, maxBuffer: 256 * 1024 * 1024 });
    const fields = stdout.split("\0");
    const changed = [];
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const object = fields[at].split(" ")[3];
      if (fields[at][0] !== ":" || object === undefined) return null;
      changed.push({ path: fields[at + 1], blob: NO_OBJECT.test(object) ? null : object });
    }
    return changed;
  } catch {
    return null;
  }
}

/**
 * The object that a tree of a project's repository holds at each of the given project-relative paths: Map(path, object), null where the tree holds no such path.
 * The paths are taken literally, so a path with a pattern character names only itself.
 * Returns null when Git cannot read the tree.
 */
export async function objectsAt(projectRoot, tree, paths) {
  const found = new Map(paths.map((item) => [item, null]));
  if (!paths.length) return found;
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const { stdout } = await execute("git", ["--literal-pathspecs", "ls-tree", "-z", "--full-name", "--end-of-options", tree, "--", ...paths], { cwd: projectRoot, env, maxBuffer: 64 * 1024 * 1024 });
    const prefix = (await execute("git", ["rev-parse", "--show-prefix"], { cwd: projectRoot, env })).stdout.trim();
    for (const line of stdout.split("\0")) {
      const tab = line.indexOf("\t");
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
