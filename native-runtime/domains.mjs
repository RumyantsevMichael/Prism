// Generated from domains.mts by scripts/native-build/compile.mjs.
import path from "node:path";
const CODE_EXTENSIONS = /* @__PURE__ */ new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);
function domainFor(file) {
  if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) return "code";
  if (/\.(jsonc?|ya?ml)$/i.test(file)) return "configuration";
  if (/(^|\/)(skills|instructions|policies)(\/|$)|(^|\/)(AGENTS|CLAUDE|SKILL|instructions)\.md$/i.test(file)) return "instruction";
  return "documentation";
}
export {
  CODE_EXTENSIONS,
  domainFor
};
