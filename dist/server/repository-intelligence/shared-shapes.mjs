// Generated from src/server/repository-intelligence/shared-shapes.mts by scripts/native-build/compile.mjs.
import { codeFamily, codeOnly } from "./code-text.mjs";
const MIN_KEYS = 4, MIN_OCCURRENCES = 3, MAX_POSTING = 200, MAX_LOCATIONS = 20;
const DECLARATION_KINDS = /* @__PURE__ */ new Set(["interface", "type_alias", "struct"]);
const KEY = /(?:^|[{,;\n])\s*(?:readonly\s+|pub\s+)?(?:"([\w$-]+)"|'([\w$-]+)'|([A-Za-z_$][\w$]*))\s*(?:\??\s*:(?!:)|(?=\s*[,}]))/g;
function objectShapes(file, text) {
  const family = codeFamily(file), code = codeOnly(text, family), raw = codeOnly(text, family, true), shapes = [], open = [];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "{") open.push(index);
    else if (code[index] === "}" && open.length) {
      const start = open.pop(), before = code.slice(Math.max(0, start - 80), start);
      if (/\b(import|export)\s*(type\s*)?$|(\)|=>|\belse|\btry|\bfinally|\bdo)\s*$/.test(before)) continue;
      let depth = 0, own = "";
      for (let position = start; position <= index; position++) {
        const character = code[position];
        if (character === "{" && ++depth === 2) own += " ";
        if (depth === 1) own += raw[position];
        if (character === "}") depth--;
      }
      const keys = new Set([...own.matchAll(KEY)].map((match) => match[1] || match[2] || match[3]));
      if (keys.size) shapes.push({ file, offset: start, end: index + 1, keys });
    }
  }
  return shapes;
}
function sharedShapes(index, contents, options = {}) {
  const include = options.include || (() => true);
  const units = /* @__PURE__ */ new Map();
  for (const unit of index.units) if (unit.span && (!unit.domain || unit.domain === "code") && include(unit)) (units.get(unit.file) || units.set(unit.file, []).get(unit.file)).push(unit);
  const shapes = [...units.keys()].flatMap((file) => objectShapes(file, contents.get(file) || "")).filter((shape) => shape.keys.size >= MIN_KEYS);
  const posting = /* @__PURE__ */ new Map();
  shapes.forEach((shape, position) => {
    for (const key of shape.keys) (posting.get(key) || posting.set(key, []).get(key)).push(position);
  });
  const candidates = /* @__PURE__ */ new Map();
  shapes.forEach((shape, position) => {
    const rarest = [...shape.keys].sort((a, b) => posting.get(a).length - posting.get(b).length)[0];
    for (const other of posting.get(rarest).slice(0, MAX_POSTING)) if (other > position) {
      const shared = [...shape.keys].filter((key) => shapes[other].keys.has(key)).sort();
      if (shared.length >= MIN_KEYS) candidates.set(shared.join("\0"), shared);
    }
  });
  const owner = (file, offset) => (units.get(file) || []).filter((unit) => unit.span.start <= offset && offset < unit.span.end).sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))[0];
  const line = (file, offset) => (contents.get(file) || "").slice(0, offset).split("\n").length;
  const found = [...candidates.values()].map((keys) => {
    const holders = posting.get([...keys].sort((a, b) => posting.get(a).length - posting.get(b).length)[0]).filter((position) => keys.every((key) => shapes[position].keys.has(key)));
    return { keys, holders };
  }).filter((shape) => shape.holders.length >= MIN_OCCURRENCES);
  const maximal = found.filter((shape) => !found.some((other) => other !== shape && other.keys.length > shape.keys.length && other.holders.length === shape.holders.length && shape.keys.every((key) => other.keys.includes(key))));
  const reported = maximal.map(({ keys, holders }) => {
    const owners = holders.map((position) => ({ position, unit: owner(shapes[position].file, shapes[position].offset) }));
    return {
      keys,
      occurrences: holders.length,
      files: new Set(holders.map((position) => shapes[position].file)).size,
      declarations: owners.filter(({ unit }) => unit && DECLARATION_KINDS.has(unit.kind)).length,
      locations: owners.slice(0, MAX_LOCATIONS).map(({ position, unit }) => ({ file: shapes[position].file, line: line(shapes[position].file, shapes[position].offset), selector: unit ? unit.selector || unit.qualifiedName || unit.name : null }))
    };
  });
  const weight = (shape) => shape.keys.reduce((sum, key) => sum + Math.log(shapes.length / posting.get(key).length), 0) * Math.log2(shape.occurrences);
  reported.sort((a, b) => weight(b) - weight(a) || b.files - a.files || a.keys.join().localeCompare(b.keys.join()));
  return { shapes: reported.slice(0, options.limit || 100), coverage: { objects: shapes.length, shapes: reported.length } };
}
export {
  objectShapes,
  sharedShapes
};
