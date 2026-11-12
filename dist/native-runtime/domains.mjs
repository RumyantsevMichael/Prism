// Generated from src/native-runtime/domains.mts by scripts/native-build/compile.mjs.
import path from "node:path";
const CODE_EXTENSIONS = /* @__PURE__ */ new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);
function domainFor(file) {
  if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) return "code";
  if (/\.(jsonc?|ya?ml)$/i.test(file)) return "configuration";
  if (/(^|\/)(skills|instructions|policies)(\/|$)|(^|\/)(AGENTS|CLAUDE|SKILL|instructions)\.md$/i.test(file)) return "instruction";
  return "documentation";
}
const LOCKFILES = /* @__PURE__ */ new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "gemfile.lock", "composer.lock", "go.sum", "packages.lock.json"]);
const GENERATED_DIRECTORIES = /* @__PURE__ */ new Set(["dist", "vendor", "third_party", "node_modules", "coverage"]);
function searchExclusion(file, content) {
  if (LOCKFILES.has(path.posix.basename(file).toLowerCase())) return "lockfile";
  if (file.split("/").slice(0, -1).some((part) => GENERATED_DIRECTORIES.has(part))) return "generated";
  if (/\.min\.[cm]?[jt]s$|\.min\.css$/i.test(file)) return "minified";
  const lines = content.split("\n").length;
  if (content.length > 2e4 && content.length / lines > 300) return "minified";
  return null;
}
export {
  CODE_EXTENSIONS,
  domainFor,
  searchExclusion
};
