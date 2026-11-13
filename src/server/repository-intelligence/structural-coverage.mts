import path from "node:path";
import { CODE_EXTENSIONS } from "../../native-runtime/domains.mjs";
import type { Diagnostic, IndexMetadata } from "./repository-unit-types.mjs";

// The code graph names every reference it could not resolve, and most of them are calls into libraries and the platform, which no index of
// the source can resolve. A file stays uncovered only for a reference that could name something this index defines, a missing link inside it.
const UNRESOLVED_MESSAGE = "The graph has unresolved references in this file.";
const isUnresolvedDiagnostic = (item: Diagnostic) => item.code === "incomplete_structure" && item.message === UNRESOLVED_MESSAGE;
const isCode = (file: string) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
const lastSegment = (name: string) => name.split(/\.|::|#/).at(-1) ?? name;

/** The structural coverage of an index whose runtime reported `unresolvedByFile`; an index without it keeps the coverage its runtime reported. */
export function structuralCoverage(index: Pick<IndexMetadata, "units" | "fileCoverage" | "syntaxCoverage" | "diagnostics" | "unresolvedByFile">): Record<string, boolean> {
  const unresolvedByFile = index.unresolvedByFile;
  if (!unresolvedByFile) return index.fileCoverage;
  // File units are named by their path and imports name what another file defines, so neither defines a name here.
  const defined = new Set(index.units.filter(unit => isCode(unit.file) && unit.kind !== "file" && unit.kind !== "import").map(unit => unit.name));
  const named = new Set(index.diagnostics.filter(item => item.file && !isUnresolvedDiagnostic(item)).map(item => item.file));
  const outside = ({ name, kind }: { name: string; kind: string }) =>
    kind === "imports" ? !name.startsWith(".") && !name.startsWith("/") : !defined.has(lastSegment(name));
  const coverage: Record<string, boolean> = {};
  for (const [file, covered] of Object.entries(index.fileCoverage)) {
    coverage[file] = isCode(file)
      ? index.syntaxCoverage?.[file] === true && !named.has(file) && (unresolvedByFile[file] || []).every(outside)
      : covered;
  }
  return coverage;
}
