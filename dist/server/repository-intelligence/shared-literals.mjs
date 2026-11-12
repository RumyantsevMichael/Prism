// Generated from src/server/repository-intelligence/shared-literals.mts by scripts/native-build/compile.mjs.
import { sharedNameGroups } from "./shared-dependencies.mjs";
import { moduleImports } from "./module-interfaces.mjs";
import { objectShapes } from "./shared-shapes.mjs";
const OWNER_KINDS = /* @__PURE__ */ new Set(["function", "method", "constant", "variable", "class"]);
const LIST_KINDS = /* @__PURE__ */ new Set(["constant", "variable"]);
const LITERAL = /(["'`])([A-Za-z_][\w.:/-]{2,80})\1/g;
const MODULE_LINE = /^\s*import\b|^\s*export\b.*\bfrom\s*["'`]|\brequire\(|\bimport\(/;
const INSTRUCTION_KINDS = /* @__PURE__ */ new Set(["list-item", "paragraph"]);
const CODE_SPAN = /`([^`\n]+)`/g, IDENTIFIER_LIKE = /^[A-Za-z_][\w.:/-]{2,80}$/;
function literalProfiles(index, contents, include = () => true) {
  const code = /* @__PURE__ */ new Map(), instructions = /* @__PURE__ */ new Map();
  for (const unit of index.units) {
    if (!unit.span || !include(unit)) continue;
    const target = OWNER_KINDS.has(unit.kind) && (!unit.domain || unit.domain === "code") ? code : INSTRUCTION_KINDS.has(unit.kind) && unit.domain === "instruction" ? instructions : null;
    if (target) (target.get(unit.file) || target.set(unit.file, []).get(unit.file)).push(unit);
  }
  const profiles = /* @__PURE__ */ new Map();
  let literals = 0;
  const own = (units, offset, value) => {
    let owner;
    for (const unit of units) if (unit.span.start <= offset && offset < unit.span.end && (!owner || unit.span.end - unit.span.start < owner.span.end - owner.span.start)) owner = unit;
    if (!owner) return;
    (profiles.get(owner.id) || profiles.set(owner.id, /* @__PURE__ */ new Set()).get(owner.id)).add(value);
    literals++;
  };
  for (const [file, units] of code) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(LITERAL)) {
      const index2 = match.index, line = text.slice(text.lastIndexOf("\n", index2) + 1, text.indexOf("\n", index2) < 0 ? void 0 : text.indexOf("\n", index2));
      if (!MODULE_LINE.test(line)) own(units, index2, match[2]);
    }
  }
  for (const [file, units] of instructions) {
    const text = contents.get(file) || "";
    for (const match of text.matchAll(CODE_SPAN)) {
      const index2 = match.index, line = text.slice(text.lastIndexOf("\n", index2) + 1);
      if (!line.trimStart().startsWith("|") && IDENTIFIER_LIKE.test(match[1])) own(units, index2, match[1]);
    }
  }
  return { profiles, literals };
}
function entryShape(names, members, objects, contents, rarity) {
  const definitions = [];
  for (const name of names) for (const member of members) {
    const text = contents.get(member.file) || "", lines = text.split("\n"), start = lines.slice(0, member.range.startLine - 1).join("\n").length, end = lines.slice(0, member.range.endLine).join("\n").length;
    for (const match of text.slice(start, end).matchAll(new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "g"))) {
      const offset = start + match.index, own = objects.get(member.file) || [];
      const definition = own.filter((object) => object.offset < offset && offset < object.end).sort((a, b) => a.end - a.offset - (b.end - b.offset))[0];
      if (definition) definitions.push(own.filter((object) => definition.offset <= object.offset && object.end <= definition.end));
    }
  }
  if (definitions.length < 2) return null;
  let best = null;
  for (const object of definitions[0].concat(...definitions.slice(1))) for (const other of definitions.flat()) {
    if (object === other) continue;
    const keys = [...object.keys].filter((key) => other.keys.has(key)).sort();
    if (keys.length < 4) continue;
    const entries = definitions.filter((list) => list.some((item) => keys.every((key) => item.keys.has(key)))).length;
    const weight = keys.reduce((sum, key) => sum + rarity(key), 0);
    if (entries * 2 > definitions.length && (!best || weight > best.weight)) best = { keys, entries, weight };
  }
  return best && { keys: best.keys, entries: best.entries, of: definitions.length };
}
function sharedLiteralGroups(index, contents, options = {}) {
  const { profiles, literals } = literalProfiles(index, contents, options.include);
  const imports = moduleImports(contents);
  const objects = /* @__PURE__ */ new Map(), posting = /* @__PURE__ */ new Map();
  let objectCount = 0;
  const shapesOf = (file) => {
    if (!objects.has(file)) objects.set(file, objectShapes(file, contents.get(file) || ""));
    return objects.get(file);
  };
  for (const unit of index.units) if (unit.domain === "code" && !objects.has(unit.file)) for (const object of shapesOf(unit.file)) {
    objectCount++;
    for (const key of object.keys) posting.set(key, (posting.get(key) || 0) + 1);
  }
  const rarity = (key) => Math.log(Math.max(1, objectCount) / (posting.get(key) || 1));
  let ownedGroups = 0;
  const groups = sharedNameGroups(index.units, profiles, options.limit).flatMap(({ names, weight, members }) => {
    const code = members.filter((member) => !INSTRUCTION_KINDS.has(member.kind));
    const clients = code.length ? members.filter((member) => INSTRUCTION_KINDS.has(member.kind)) : [];
    const lists = code.filter((member) => LIST_KINDS.has(member.kind));
    const users = code.filter((member) => !LIST_KINDS.has(member.kind) && lists.some((list) => list.file !== member.file && imports.get(member.file)?.has(list.file)));
    const kept = members.filter((member) => !users.includes(member) && !clients.includes(member));
    if (new Set([...kept, ...clients].map((member) => member.file)).size < 2) {
      ownedGroups++;
      return [];
    }
    const shape = clients.length ? entryShape(names.map((name) => name.name), kept, objects, contents, rarity) : null;
    return [{
      literals: names,
      weight,
      members: kept,
      users: users.map(({ file, selector }) => ({ file, selector })),
      clients: clients.map(({ file, selector, range }) => ({ file, selector, range })),
      entryShape: shape
    }];
  });
  return { groups, coverage: { profiledUnits: profiles.size, literals, ownedGroups } };
}
export {
  literalProfiles,
  sharedLiteralGroups
};
