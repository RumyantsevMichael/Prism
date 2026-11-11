// Generated from src/server/repository-intelligence/structural-coverage.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { CODE_EXTENSIONS } from "../../native-runtime/domains.mjs";
const UNRESOLVED_MESSAGE = "The graph has unresolved references in this file.";
const isUnresolvedDiagnostic = (item) => item.code === "incomplete_structure" && item.message === UNRESOLVED_MESSAGE;
const isCode = (file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
const lastSegment = (name) => name.split(/\.|::|#/).at(-1) ?? name;
function structuralCoverage(index) {
  const unresolvedByFile = index.unresolvedByFile;
  if (!unresolvedByFile) return index.fileCoverage;
  const defined = new Set(index.units.filter((unit) => isCode(unit.file) && unit.kind !== "file" && unit.kind !== "import").map((unit) => unit.name));
  const named = new Set(index.diagnostics.filter((item) => item.file && !isUnresolvedDiagnostic(item)).map((item) => item.file));
  const outside = ({ name, kind }) => kind === "imports" ? !name.startsWith(".") && !name.startsWith("/") : !defined.has(lastSegment(name));
  const coverage = {};
  for (const [file, covered] of Object.entries(index.fileCoverage)) {
    coverage[file] = isCode(file) ? index.syntaxCoverage?.[file] === true && !named.has(file) && (unresolvedByFile[file] || []).every(outside) : covered;
  }
  return coverage;
}
export {
  structuralCoverage
};
