import { sameNameGroups } from "../repository-intelligence/same-name-units.mjs";
import { sharedDependencyGroups, isTestUnit, isTestFile } from "../repository-intelligence/shared-dependencies.mjs";
import { sharedLiteralGroups } from "../repository-intelligence/shared-literals.mjs";
import { sharedShapes } from "../repository-intelligence/shared-shapes.mjs";
import { complexUnits } from "../repository-intelligence/complex-units.mjs";
import { cohesionReport } from "../repository-intelligence/cohesion.mjs";
import { moduleInterfaceReport } from "../repository-intelligence/module-interfaces.mjs";
import { searchExclusion } from "../../native-runtime/domains.mjs";
import type { IndexMetadata, SourceUnit } from "../repository-intelligence/repository-unit-types.mjs";

export interface DetectorSide { index: Pick<IndexMetadata, "units" | "edges" | "unresolvedReferences">; contents: Map<string, string> }
export interface DetectorFinding { code: string; severity: "failure" | "review_required"; file: string; message: string }

// Functions this short are small utilities, and a copy of one does not spread a concept that a design must own once.
export const DUPLICATE_MIN_LINES = 10;
// Both sides report every group, so that a group that falls below a ranking cut on one side does not look new on the other.
const LIMIT = 1000;

type Member = { file: string; selector: string };
const key = (member: Member) => `${member.file}#${member.selector}`;
const list = (members: Member[]) => members.map(member => `${member.file}:${member.selector}`).join(", ");

// Production code only, as in the repository analysis tools: tests and generated files repeat values and grow large by design.
function detect(side: DetectorSide) {
  const include = (unit: SourceUnit) => !isTestUnit(unit, side.contents.get(unit.file)) && !searchExclusion(unit.file, side.contents.get(unit.file) || "");
  return {
    sameName: sameNameGroups(side.index, side.contents, { include }).groups.filter(group => group.variants.every(variant => variant.lines >= DUPLICATE_MIN_LINES)),
    dependencies: sharedDependencyGroups(side.index, { include, limit: LIMIT }).groups,
    literals: sharedLiteralGroups(side.index, side.contents, { include, limit: LIMIT }).groups,
    shapes: sharedShapes(side.index, side.contents, { include, limit: LIMIT }).shapes,
    complex: complexUnits(side.index, side.contents, { include }).units,
    cohesion: cohesionReport(side.index, side.contents, { include }).containers,
    modules: moduleInterfaceReport(side.index, side.contents, { include: file => !isTestFile(file), allModules: true }).modules
  };
}

// Report what a change adds to the detector findings: findings that touch a changed file and are new, or larger than at the baseline.
// Findings that the baseline already had and the change leaves as they were are not reported, so a review judges only the change.
export function detectorDiff(before: DetectorSide, after: DetectorSide, changed: Set<string>): DetectorFinding[] {
  const left = detect(before), right = detect(after), findings: DetectorFinding[] = [];
  const touches = (members: Member[]) => members.find(member => changed.has(member.file));

  // A function name with copies in more files than before is a new copy, and a moved function keeps its count.
  for (const group of right.sameName) {
    const members = group.variants.flatMap(variant => variant.members), file = touches(members)?.file;
    const previous = left.sameName.find(item => item.name === group.name);
    if (file && group.files > (previous?.files || 1)) findings.push({ code: "duplication_introduced", severity: "failure", file,
      message: `The function ${group.name} now has copies in ${group.files} files: ${list(members)}. Consolidate the copies into one unit, or name the functions for their different contracts.` });
  }
  // A group of units in different files is new for the change when it pairs a unit in a changed file with a unit that the baseline did not pair it with.
  const pairs = (groups: { members: Member[] }[]) => new Set(groups.flatMap(group => group.members.flatMap(a => group.members.filter(b => a.file !== b.file && key(a) < key(b)).map(b => `${key(a)}|${key(b)}`))));
  const grouped = (code: string, groups: { members: Member[] }[], baseline: { members: Member[] }[], what: string) => {
    const known = pairs(baseline);
    for (const group of groups) {
      const fresh = group.members.some(a => changed.has(a.file) && group.members.some(b => a.file !== b.file && !known.has(key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`)));
      if (fresh) findings.push({ code, severity: "review_required", file: touches(group.members)!.file, message: `${what}: ${list(group.members)}.` });
    }
  };
  grouped("shared_dependencies_introduced", right.dependencies, left.dependencies, "Units in different files now use the same rare set of names");
  grouped("shared_literals_introduced", right.literals, left.literals, "Units in different files now spell the same rare set of values");
  for (const shape of right.shapes) {
    const file = shape.locations.find(location => changed.has(location.file))?.file, previous = left.shapes.find(item => item.keys.join() === shape.keys.join());
    if (file && shape.occurrences > (previous?.occurrences || 0)) findings.push({ code: "shared_shape_introduced", severity: "review_required", file,
      message: `The key set {${shape.keys.join(", ")}} now occurs in ${shape.occurrences} objects, up from ${previous?.occurrences || 0}.` });
  }
  for (const unit of right.complex) {
    const previous = left.complex.find(item => item.file === unit.file && item.selector === unit.selector);
    if (changed.has(unit.file) && (!previous || unit.lines > previous.lines || unit.branches > previous.branches)) findings.push({ code: "complexity_introduced", severity: "review_required", file: unit.file,
      message: `${unit.file}:${unit.selector} has ${unit.lines} lines and ${unit.branches} branches${previous ? `, up from ${previous.lines} lines and ${previous.branches} branches` : ""}.` });
  }
  for (const container of right.cohesion) {
    const previous = left.cohesion.find(item => item.file === container.file && item.name === container.name);
    if (changed.has(container.file) && (!previous || container.separableLines > previous.separableLines)) findings.push({ code: "cohesion_split_introduced", severity: "review_required", file: container.file,
      message: `${container.file}:${container.name} has ${container.clusters.length} separate clusters with ${container.separableLines} separable lines${previous ? `, up from ${previous.separableLines}` : ""}.` });
  }
  for (const module of right.modules) {
    if (!changed.has(module.file)) continue;
    const previous = new Set(left.modules.find(item => item.file === module.file)?.unusedExports || []);
    const added = module.unusedExports.filter(name => !previous.has(name));
    if (added.length) findings.push({ code: "unused_export_introduced", severity: "review_required", file: module.file, message: `${module.file} exports ${added.join(", ")}, which no module imports.` });
  }
  return findings;
}
