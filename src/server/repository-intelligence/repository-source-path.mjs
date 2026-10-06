import path from "node:path";

function unsafePathError() {
  return new TypeError("The source range must use a safe project-relative path.");
}

export function normalizeRepositorySourcePath(value, options = {}) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw unsafePathError();
  const portable = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || /^[a-z]:/i.test(portable)) throw unsafePathError();
  const segments = portable.split("/");
  if (segments.includes("..")) throw unsafePathError();
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) throw unsafePathError();
  if (options.projectRoot) {
    const root = path.resolve(options.projectRoot);
    const resolved = path.resolve(root, ...normalized.split("/"));
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw unsafePathError();
  }
  return normalized;
}

export function normalizeRepositorySourceRange(sourceRange, options = {}) {
  const file = normalizeRepositorySourcePath(sourceRange?.file, options);
  const startLine = sourceRange?.range?.startLine;
  const endLine = sourceRange?.range?.endLine;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new TypeError("The source range must contain valid positive line numbers.");
  }
  return { file, range: { startLine, endLine } };
}
