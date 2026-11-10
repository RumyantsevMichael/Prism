// Generated from src/server/repository-intelligence/native-files.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
const semanticError = (code, message) => Object.assign(new Error(message), { code });
async function assertSafeAncestors(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw semanticError("invalid_path", "Private storage must not follow a symlink ancestor.");
  }
}
async function regularBytes(file, max = 512 * 1024 * 1024) {
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
  } finally {
    await handle.close();
  }
}
export {
  assertSafeAncestors,
  regularBytes,
  semanticError
};
