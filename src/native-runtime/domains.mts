import path from "node:path";
import type { Domain } from "../server/repository-intelligence/repository-concept-types.mjs";

export const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);
export function domainFor(file: string): Domain {
  if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) return "code";
  if (/\.(jsonc?|ya?ml)$/i.test(file)) return "configuration";
  if (/(^|\/)(skills|instructions|policies)(\/|$)|(^|\/)(AGENTS|CLAUDE|SKILL|instructions)\.md$/i.test(file)) return "instruction";
  return "documentation";
}
