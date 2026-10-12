// Generated from src/server/conservation/detector-diff.mts by scripts/native-build/compile.mjs.
import { sameNameGroups } from "../repository-intelligence/same-name-units.mjs";
import { sharedDependencyGroups, isTestUnit, isTestFile } from "../repository-intelligence/shared-dependencies.mjs";
import { sharedLiteralGroups } from "../repository-intelligence/shared-literals.mjs";
import { sharedShapes } from "../repository-intelligence/shared-shapes.mjs";
import { complexUnits } from "../repository-intelligence/complex-units.mjs";
import { cohesionReport } from "../repository-intelligence/cohesion.mjs";
import { moduleInterfaceReport } from "../repository-intelligence/module-interfaces.mjs";
import { searchExclusion } from "../../native-runtime/domains.mjs";
const DUPLICATE_MIN_LINES = 10;
const LIMIT = 1e3;
const key = (member) => `${member.file}#${member.selector}`;
const list = (members) => members.map((member) => `${member.file}:${member.selector}`).join(", ");
function detect(side) {
  const include = (unit) => !isTestUnit(unit, side.contents.get(unit.file)) && !searchExclusion(unit.file, side.contents.get(unit.file) || "");
  return {
    sameName: sameNameGroups(side.index, side.contents, { include }).groups.filter((group) => group.variants.every((variant) => variant.lines >= DUPLICATE_MIN_LINES)),
    dependencies: sharedDependencyGroups(side.index, { include, limit: LIMIT }).groups,
    literals: sharedLiteralGroups(side.index, side.contents, { include, limit: LIMIT }).groups,
    shapes: sharedShapes(side.index, side.contents, { include, limit: LIMIT }).shapes,
    complex: complexUnits(side.index, side.contents, { include }).units,
    cohesion: cohesionReport(side.index, side.contents, { include }).containers,
    modules: moduleInterfaceReport(side.index, side.contents, { include: (file) => !isTestFile(file), allModules: true }).modules
  };
}
function detectorDiff(before, after, changed) {
  const left = detect(before), right = detect(after), findings = [];
  const touches = (members) => members.find((member) => changed.has(member.file));
  for (const group of right.sameName) {
    const members = group.variants.flatMap((variant) => variant.members), file = touches(members)?.file;
    const previous = left.sameName.find((item) => item.name === group.name);
    if (file && group.files > (previous?.files || 1)) findings.push({
      code: "duplication_introduced",
      severity: "failure",
      file,
      message: `The function ${group.name} now has copies in ${group.files} files: ${list(members)}. Consolidate the copies into one unit, or name the functions for their different contracts.`
    });
  }
  const pairs = (groups) => new Set(groups.flatMap((group) => group.members.flatMap((a) => group.members.filter((b) => a.file !== b.file && key(a) < key(b)).map((b) => `${key(a)}|${key(b)}`))));
  const grouped = (code, groups, baseline, what) => {
    const known = pairs(baseline);
    for (const group of groups) {
      const fresh = group.members.some((a) => changed.has(a.file) && group.members.some((b) => a.file !== b.file && !known.has(key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`)));
      if (fresh) findings.push({ code, severity: "review_required", file: touches(group.members).file, message: `${what}: ${list(group.members)}.` });
    }
  };
  grouped("shared_dependencies_introduced", right.dependencies, left.dependencies, "Units in different files now use the same rare set of names");
  grouped("shared_literals_introduced", right.literals, left.literals, "Units in different files now spell the same rare set of values");
  for (const shape of right.shapes) {
    const file = shape.locations.find((location) => changed.has(location.file))?.file, previous = left.shapes.find((item) => item.keys.join() === shape.keys.join());
    if (file && shape.occurrences > (previous?.occurrences || 0)) findings.push({
      code: "shared_shape_introduced",
      severity: "review_required",
      file,
      message: `The key set {${shape.keys.join(", ")}} now occurs in ${shape.occurrences} objects, up from ${previous?.occurrences || 0}.`
    });
  }
  for (const unit of right.complex) {
    const previous = left.complex.find((item) => item.file === unit.file && item.selector === unit.selector);
    if (changed.has(unit.file) && (!previous || unit.lines > previous.lines || unit.branches > previous.branches)) findings.push({
      code: "complexity_introduced",
      severity: "review_required",
      file: unit.file,
      message: `${unit.file}:${unit.selector} has ${unit.lines} lines and ${unit.branches} branches${previous ? `, up from ${previous.lines} lines and ${previous.branches} branches` : ""}.`
    });
  }
  for (const container of right.cohesion) {
    const previous = left.cohesion.find((item) => item.file === container.file && item.name === container.name);
    if (changed.has(container.file) && (!previous || container.separableLines > previous.separableLines)) findings.push({
      code: "cohesion_split_introduced",
      severity: "review_required",
      file: container.file,
      message: `${container.file}:${container.name} has ${container.clusters.length} separate clusters with ${container.separableLines} separable lines${previous ? `, up from ${previous.separableLines}` : ""}.`
    });
  }
  for (const module of right.modules) {
    if (!changed.has(module.file)) continue;
    const previous = new Set(left.modules.find((item) => item.file === module.file)?.unusedExports || []);
    const added = module.unusedExports.filter((name) => !previous.has(name));
    if (added.length) findings.push({ code: "unused_export_introduced", severity: "review_required", file: module.file, message: `${module.file} exports ${added.join(", ")}, which no module imports.` });
  }
  return findings;
}
export {
  DUPLICATE_MIN_LINES,
  detectorDiff
};
