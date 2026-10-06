import path from "node:path";
import type { Domain } from "../server/repository-intelligence/repository-concept-types.mjs";

export const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);
export function domainFor(file: string): Domain {
  if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) return "code";
  if (/\.(jsonc?|ya?ml)$/i.test(file)) return "configuration";
  if (/(^|\/)(skills|instructions|policies)(\/|$)|(^|\/)(AGENTS|CLAUDE|SKILL|instructions)\.md$/i.test(file)) return "instruction";
  return "documentation";
}

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "gemfile.lock", "composer.lock", "go.sum", "packages.lock.json"]);
const GENERATED_DIRECTORIES = new Set(["dist", "vendor", "third_party", "node_modules", "coverage"]);

// Lockfiles, generated output, vendored code, and minified bundles add duplicate or opaque candidates without reusable concepts.
export function searchExclusion(file: string, content: string): "lockfile" | "generated" | "minified" | null {
  if (LOCKFILES.has(path.posix.basename(file).toLowerCase())) return "lockfile";
  if (file.split("/").slice(0, -1).some(part => GENERATED_DIRECTORIES.has(part))) return "generated";
  if (/\.min\.[cm]?[jt]s$|\.min\.css$/i.test(file)) return "minified";
  const lines = content.split("\n").length;
  if (content.length > 20000 && content.length / lines > 300) return "minified";
  return null;
}
