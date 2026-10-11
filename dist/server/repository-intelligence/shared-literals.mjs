// Generated from src/server/repository-intelligence/shared-literals.mts by scripts/native-build/compile.mjs.
import { sharedNameGroups } from "./shared-dependencies.mjs";
import { moduleImports } from "./module-interfaces.mjs";
const OWNER_KINDS = /* @__PURE__ */ new Set(["function", "method", "constant", "variable", "class"]);
const LIST_KINDS = /* @__PURE__ */ new Set(["constant", "variable"]);
const LITERAL = /(["'`])([A-Za-z_][\w.:/-]{2,80})\1/g;
const MODULE_LINE = /^\s*import\b|^\s*export\b.*\bfrom\s*["'`]|\brequire\(|\bimport\(/;
function literalProfiles(index, contents, include = () => true) {
  const byFile = /* @__PURE__ */ new Map();
  for (const unit of index.units) if (OWNER_KINDS.has(unit.kind) && unit.span && (!unit.domain || unit.domain === "code") && include(unit))
    (byFile.get(unit.file) || byFile.set(unit.file, []).get(unit.file)).push(unit);
  const profiles = /* @__PURE__ */ new Map();
  let literals = 0;
  for (const [file, units] of byFile) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(LITERAL)) {
      const index2 = match.index, line = text.slice(text.lastIndexOf("\n", index2) + 1, text.indexOf("\n", index2) < 0 ? void 0 : text.indexOf("\n", index2));
      if (MODULE_LINE.test(line)) continue;
      let owner;
      for (const unit of units) if (unit.span.start <= index2 && index2 < unit.span.end && (!owner || unit.span.end - unit.span.start < owner.span.end - owner.span.start)) owner = unit;
      if (!owner) continue;
      (profiles.get(owner.id) || profiles.set(owner.id, /* @__PURE__ */ new Set()).get(owner.id)).add(match[2]);
      literals++;
    }
  }
  return { profiles, literals };
}
function sharedLiteralGroups(index, contents, options = {}) {
  const { profiles, literals } = literalProfiles(index, contents, options.include);
  const imports = moduleImports(contents);
  let ownedGroups = 0;
  const groups = sharedNameGroups(index.units, profiles, options.limit).flatMap(({ names, weight, members }) => {
    const lists = members.filter((member) => LIST_KINDS.has(member.kind));
    const users = members.filter((member) => !LIST_KINDS.has(member.kind) && lists.some((list) => list.file !== member.file && imports.get(member.file)?.has(list.file)));
    const kept = members.filter((member) => !users.includes(member));
    if (new Set(kept.map((member) => member.file)).size < 2) {
      ownedGroups++;
      return [];
    }
    return [{ literals: names, weight, members: kept, users: users.map(({ file, selector }) => ({ file, selector })) }];
  });
  return { groups, coverage: { profiledUnits: profiles.size, literals, ownedGroups } };
}
export {
  literalProfiles,
  sharedLiteralGroups
};
