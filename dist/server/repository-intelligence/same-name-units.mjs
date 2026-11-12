// Generated from src/server/repository-intelligence/same-name-units.mts by scripts/native-build/compile.mjs.
import { dependencyProfiles } from "./shared-dependencies.mjs";
import { codeFamily, codeOnly, identifiers } from "./code-text.mjs";
const MIN_LINES = 3, MAX_MEMBERS = 20;
const MIN_SIMILARITY = 0.3, SHORT_SIMILARITY = 0.5;
const THROW = /\b(throw|raise|panic!)\b/g;
const lineCount = (range) => range.endLine - range.startLine + 1;
const jaccard = (a, b) => {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
};
function sameNameGroups(index, contents, options = {}) {
  const include = options.include || (() => true);
  const candidates = index.units.filter((unit) => unit.kind === "function" && unit.span && lineCount(unit.range) >= MIN_LINES && include(unit));
  const byName = /* @__PURE__ */ new Map();
  for (const unit of candidates) (byName.get(unit.name) || byName.set(unit.name, []).get(unit.name)).push(unit);
  const profiles = dependencyProfiles(index, include);
  const groups = [];
  for (const [name, units] of byName) {
    if (new Set(units.map((unit) => unit.file)).size < 2 || units.length > MAX_MEMBERS) continue;
    const code = new Map(units.map((unit) => [unit.id, codeOnly((contents.get(unit.file) || "").slice(unit.span.start, unit.span.end), codeFamily(unit.file))]));
    const body = (unit) => (contents.get(unit.file) || "").slice(unit.span.start, unit.span.end).replace(/^\s*(export\s+(default\s+)?|pub(\([^)]*\))?\s+)/, "").replace(/\s+/g, " ").trim();
    const variants = /* @__PURE__ */ new Map();
    for (const unit of units) (variants.get(body(unit)) || variants.set(body(unit), []).get(body(unit))).push(unit);
    const lists = [...variants.values()].sort((a, b) => b.length - a.length || a[0].file.localeCompare(b[0].file));
    const tokens = lists.map((list) => identifiers(code.get(list[0].id)));
    let similarity = 1;
    for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) similarity = Math.min(similarity, jaccard(tokens[i], tokens[j]));
    if (similarity < (lists.every((list) => lineCount(list[0].range) <= MIN_LINES) ? SHORT_SIMILARITY : MIN_SIMILARITY)) continue;
    const dependencies = lists.map((list) => profiles.get(list[0].id) || /* @__PURE__ */ new Set());
    const common = dependencies.reduce((shared, set) => new Set([...shared].filter((name2) => set.has(name2))));
    groups.push({
      name,
      kind: lists.length > 1 ? "diverged" : "identical",
      files: new Set(units.map((unit) => unit.file)).size,
      similarity: Number(similarity.toFixed(2)),
      variants: lists.map((list, position) => ({
        members: list.map((unit) => ({ file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, range: unit.range })),
        lines: lineCount(list[0].range),
        signature: list[0].signature || null,
        throws: (code.get(list[0].id).match(THROW) || []).length,
        onlyHere: [...dependencies[position]].filter((name2) => !common.has(name2)).sort().slice(0, 20)
      }))
    });
  }
  const signal = (group) => group.kind === "identical" ? 3 : new Set(group.variants.map((variant) => variant.throws > 0)).size > 1 ? 0 : group.variants.some((variant) => variant.onlyHere.length) ? 1 : 2;
  const weight = (group) => group.variants.reduce((sum, variant) => sum + variant.lines * variant.members.length, 0) - Math.max(...group.variants.map((variant) => variant.lines));
  groups.sort((a, b) => signal(a) - signal(b) || b.files - a.files || weight(b) - weight(a) || a.name.localeCompare(b.name));
  return { groups, coverage: { functions: candidates.length, names: byName.size } };
}
export {
  sameNameGroups
};
