import path from "node:path";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

// File reads that the native runtime, the index store, and its thread share: each refuses a symlink and a file past its size limit.

export const semanticError = (code: string, message: string) => Object.assign(new Error(message), { code });

// A link on the way to private storage is refused unless only the operating system can change it, such as /var and /tmp on macOS:
// root owns the link, root owns every folder above it and nobody else can write them, and the process is not root, because every link
// that a root process makes is root's own. Such a link is resolved and its target checked the same way.
export async function assertSafeAncestors(target: string, uid = process.getuid?.()): Promise<void> {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root, systemOwned = systemFolder(await lstat(root));
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() && systemOwned && info.uid === 0 && uid !== undefined && uid !== 0) {
      return assertSafeAncestors(path.join(await realpath(current), ...parts.slice(index + 1)), uid);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw semanticError("invalid_path", "Private storage must not follow a symlink ancestor.");
    systemOwned &&= systemFolder(info);
  }
}

const systemFolder = (info: Stats) => info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0;

export async function regularBytes(file: string, max = 512 * 1024 * 1024) {
  await assertSafeAncestors(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw semanticError("invalid_path", "A cache file must be a regular file.");
  if (info.size > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
    const bytes = await handle.readFile();
    if (bytes.length > max) throw semanticError("resource_limit", "A cache file exceeds its size limit.");
    return bytes;
  } finally { await handle.close(); }
}
