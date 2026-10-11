import { sharedNameGroups } from "./shared-dependencies.mjs";
import { moduleImports } from "./module-interfaces.mjs";
import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface SharedLiteralOptions { include?: (unit: SourceUnit) => boolean; limit?: number }
export interface SharedLiteralGroup { literals: { name: string; users: number }[]; weight: number; members: { file: string; selector: string; kind: string; range: SourceRange; share: number }[]; users: { file: string; selector: string }[] }

const OWNER_KINDS = new Set(["function", "method", "constant", "variable", "class"]);
const LIST_KINDS = new Set(["constant", "variable"]);
// Identifier-like strings name ids, states, keys, events, methods, and paths. Prose and format strings do not match.
const LITERAL = /(["'`])([A-Za-z_][\w.:/-]{2,80})\1/g;
// Module specifiers name files, not domain knowledge.
const MODULE_LINE = /^\s*import\b|^\s*export\b.*\bfrom\s*["'`]|\brequire\(|\bimport\(/;

// The profile of a unit is the set of identifier-like literals that it spells. The innermost unit that covers a literal owns it.
export function literalProfiles(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, include: (unit: SourceUnit) => boolean = () => true) {
  const byFile = new Map<string, SourceUnit[]>();
  for (const unit of index.units) if (OWNER_KINDS.has(unit.kind) && unit.span && (!unit.domain || unit.domain === "code") && include(unit))
    (byFile.get(unit.file) || byFile.set(unit.file, []).get(unit.file)!).push(unit);
  const profiles = new Map<string, Set<string>>();
  let literals = 0;
  for (const [file, units] of byFile) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(LITERAL)) {
      const index = match.index!, line = text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index) < 0 ? undefined : text.indexOf("\n", index));
      if (MODULE_LINE.test(line)) continue;
      let owner: SourceUnit | undefined;
      for (const unit of units) if (unit.span!.start <= index && index < unit.span!.end && (!owner || unit.span!.end - unit.span!.start < owner.span!.end - owner.span!.start)) owner = unit;
      if (!owner) continue;
      (profiles.get(owner.id) || profiles.set(owner.id, new Set()).get(owner.id)!).add(match[2]);
      literals++;
    }
  }
  return { profiles, literals };
}

// Group units in different files that spell the same rare set of literals, which often shows a value set or a rule that several units must know.
export function sharedLiteralGroups(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, options: SharedLiteralOptions = {}) {
  const { profiles, literals } = literalProfiles(index, contents, options.include);
  // A member that imports the module of a constant in its group uses values of that list, so it does not keep its own copy of the set.
  // Such members move to users, and a group whose remaining members sit in one file has a single owner.
  // Type declarations do not count as lists: units that import a union type can still copy the logic that derives its values.
  const imports = moduleImports(contents);
  let ownedGroups = 0;
  const groups: SharedLiteralGroup[] = sharedNameGroups(index.units, profiles, options.limit).flatMap(({ names, weight, members }) => {
    const lists = members.filter(member => LIST_KINDS.has(member.kind));
    const users = members.filter(member => !LIST_KINDS.has(member.kind) && lists.some(list => list.file !== member.file && imports.get(member.file)?.has(list.file)));
    const kept = members.filter(member => !users.includes(member));
    if (new Set(kept.map(member => member.file)).size < 2) { ownedGroups++; return []; }
    return [{ literals: names, weight, members: kept, users: users.map(({ file, selector }) => ({ file, selector })) }];
  });
  return { groups, coverage: { profiledUnits: profiles.size, literals, ownedGroups } };
}
