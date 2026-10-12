import { sharedNameGroups } from "./shared-dependencies.mjs";
import { moduleImports } from "./module-interfaces.mjs";
import { objectShapes, type ObjectShape } from "./shared-shapes.mjs";
import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface SharedLiteralOptions { include?: (unit: SourceUnit) => boolean; limit?: number }
export interface SharedLiteralGroup {
  literals: { name: string; users: number }[]; weight: number; members: { file: string; selector: string; kind: string; range: SourceRange; share: number }[];
  users: { file: string; selector: string }[]; clients: { file: string; selector: string; range: SourceRange }[];
  entryShape: { keys: string[]; entries: number; of: number } | null;
}

const OWNER_KINDS = new Set(["function", "method", "constant", "variable", "class"]);
const LIST_KINDS = new Set(["constant", "variable"]);
// Identifier-like strings name ids, states, keys, events, methods, and paths. Prose and format strings do not match.
const LITERAL = /(["'`])([A-Za-z_][\w.:/-]{2,80})\1/g;
// Module specifiers name files, not domain knowledge.
const MODULE_LINE = /^\s*import\b|^\s*export\b.*\bfrom\s*["'`]|\brequire\(|\bimport\(/;

// Instructions such as skills and prompts are clients too: a list item or paragraph that names identifiers in backticks uses them.
// A table describes one item per row, so it is not a use of its names together.
const INSTRUCTION_KINDS = new Set(["list-item", "paragraph"]);
const CODE_SPAN = /`([^`\n]+)`/g, IDENTIFIER_LIKE = /^[A-Za-z_][\w.:/-]{2,80}$/;

// The profile of a unit is the set of identifier-like literals that it spells. The innermost unit that covers a literal owns it.
export function literalProfiles(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, include: (unit: SourceUnit) => boolean = () => true) {
  const code = new Map<string, SourceUnit[]>(), instructions = new Map<string, SourceUnit[]>();
  for (const unit of index.units) {
    if (!unit.span || !include(unit)) continue;
    const target = OWNER_KINDS.has(unit.kind) && (!unit.domain || unit.domain === "code") ? code : INSTRUCTION_KINDS.has(unit.kind) && unit.domain === "instruction" ? instructions : null;
    if (target) (target.get(unit.file) || target.set(unit.file, []).get(unit.file)!).push(unit);
  }
  const profiles = new Map<string, Set<string>>();
  let literals = 0;
  const own = (units: SourceUnit[], offset: number, value: string) => {
    let owner: SourceUnit | undefined;
    for (const unit of units) if (unit.span!.start <= offset && offset < unit.span!.end && (!owner || unit.span!.end - unit.span!.start < owner.span!.end - owner.span!.start)) owner = unit;
    if (!owner) return;
    (profiles.get(owner.id) || profiles.set(owner.id, new Set()).get(owner.id)!).add(value);
    literals++;
  };
  for (const [file, units] of code) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(LITERAL)) {
      const index = match.index!, line = text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index) < 0 ? undefined : text.indexOf("\n", index));
      if (!MODULE_LINE.test(line)) own(units, index, match[2]);
    }
  }
  for (const [file, units] of instructions) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(CODE_SPAN)) {
      const index = match.index!, line = text.slice(text.lastIndexOf("\n", index) + 1);
      if (!line.trimStart().startsWith("|") && IDENTIFIER_LIKE.test(match[1])) own(units, index, match[1]);
    }
  }
  return { profiles, literals };
}

// The rarest key set of at least four keys that the definitions of most co-used names share in their nested objects.
// A definition is the innermost object literal in a code member that contains the name, such as { name: "find_x", inputSchema: {...} }.
function entryShape(names: string[], members: { file: string; range: SourceRange }[], objects: Map<string, ObjectShape[]>, contents: Map<string, string>, rarity: (key: string) => number) {
  const definitions: ObjectShape[][] = [];
  for (const name of names) for (const member of members) {
    const text = contents.get(member.file) || "", lines = text.split("\n"), start = lines.slice(0, member.range.startLine - 1).join("\n").length, end = lines.slice(0, member.range.endLine).join("\n").length;
    for (const match of text.slice(start, end).matchAll(new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "g"))) {
      const offset = start + match.index!, own = objects.get(member.file) || [];
      const definition = own.filter(object => object.offset < offset && offset < object.end).sort((a, b) => (a.end - a.offset) - (b.end - b.offset))[0];
      if (definition) definitions.push(own.filter(object => definition.offset <= object.offset && object.end <= definition.end));
    }
  }
  if (definitions.length < 2) return null;
  let best: { keys: string[]; entries: number; weight: number } | null = null;
  for (const object of definitions[0].concat(...definitions.slice(1))) for (const other of definitions.flat()) {
    if (object === other) continue;
    const keys = [...object.keys].filter(key => other.keys.has(key)).sort();
    if (keys.length < 4) continue;
    const entries = definitions.filter(list => list.some(item => keys.every(key => item.keys.has(key)))).length;
    const weight = keys.reduce((sum, key) => sum + rarity(key), 0);
    if (entries * 2 > definitions.length && (!best || weight > best.weight)) best = { keys, entries, weight };
  }
  return best && { keys: best.keys, entries: best.entries, of: definitions.length };
}

// Group units in different files that spell the same rare set of literals, which often shows a value set or a rule that several units must know.
export function sharedLiteralGroups(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, options: SharedLiteralOptions = {}) {
  const { profiles, literals } = literalProfiles(index, contents, options.include);
  // A member that imports the module of a constant in its group uses values of that list, so it does not keep its own copy of the set.
  // Such members move to users, and a group whose remaining members sit in one file has a single owner.
  // Type declarations do not count as lists: units that import a union type can still copy the logic that derives its values.
  // An instruction that names the values together uses them together, so it moves to clients when the group has code members.
  const imports = moduleImports(contents);
  const objects = new Map<string, ObjectShape[]>(), posting = new Map<string, number>();
  let objectCount = 0;
  const shapesOf = (file: string) => {
    if (!objects.has(file)) objects.set(file, objectShapes(file, contents.get(file) || ""));
    return objects.get(file)!;
  };
  for (const unit of index.units) if (unit.domain === "code" && !objects.has(unit.file)) for (const object of shapesOf(unit.file)) { objectCount++; for (const key of object.keys) posting.set(key, (posting.get(key) || 0) + 1); }
  const rarity = (key: string) => Math.log(Math.max(1, objectCount) / (posting.get(key) || 1));
  let ownedGroups = 0;
  const groups: SharedLiteralGroup[] = sharedNameGroups(index.units, profiles, options.limit).flatMap(({ names, weight, members }) => {
    const code = members.filter(member => !INSTRUCTION_KINDS.has(member.kind));
    const clients = code.length ? members.filter(member => INSTRUCTION_KINDS.has(member.kind)) : [];
    const lists = code.filter(member => LIST_KINDS.has(member.kind));
    const users = code.filter(member => !LIST_KINDS.has(member.kind) && lists.some(list => list.file !== member.file && imports.get(member.file)?.has(list.file)));
    const kept = members.filter(member => !users.includes(member) && !clients.includes(member));
    if (new Set([...kept, ...clients].map(member => member.file)).size < 2) { ownedGroups++; return []; }
    const shape = clients.length ? entryShape(names.map(name => name.name), kept, objects, contents, rarity) : null;
    return [{ literals: names, weight, members: kept, users: users.map(({ file, selector }) => ({ file, selector })),
      clients: clients.map(({ file, selector, range }) => ({ file, selector, range })), entryShape: shape }];
  });
  return { groups, coverage: { profiledUnits: profiles.size, literals, ownedGroups } };
}
