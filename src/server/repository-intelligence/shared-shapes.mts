import { codeFamily, codeOnly } from "./code-text.mjs";
import type { IndexMetadata, SourceUnit } from "./repository-unit-types.mjs";

export interface SharedShapeOptions { include?: (unit: SourceUnit) => boolean; limit?: number }
export interface SharedShape { keys: string[]; occurrences: number; files: number; declarations: number; locations: { file: string; line: number; selector: string | null }[] }

// A shape is the key set of an object literal, an interface, a struct, or a schema. Small key sets such as {id, name} are too common to show a clump.
const MIN_KEYS = 4, MIN_OCCURRENCES = 3, MAX_POSTING = 200, MAX_LOCATIONS = 20;
// A shape inside an interface, a type alias, or a struct declares a named type for its keys.
const DECLARATION_KINDS = new Set(["interface", "type_alias", "struct"]);
// A key is a name or a quoted name followed by an optional "?" and one colon, or a shorthand name followed by a comma or the closing brace.
const KEY = /(?:^|[{,;\n])\s*(?:readonly\s+|pub\s+)?(?:"([\w$-]+)"|'([\w$-]+)'|([A-Za-z_$][\w$]*))\s*(?:\??\s*:(?!:)|(?=\s*[,}]))/g;

export interface ObjectShape { file: string; offset: number; end: number; keys: Set<string> }

// The top-level keys of every brace pair in a file that has keys. Import and export lists are module syntax, not shapes.
export function objectShapes(file: string, text: string): ObjectShape[] {
  const family = codeFamily(file), code = codeOnly(text, family), raw = codeOnly(text, family, true), shapes: ObjectShape[] = [], open: number[] = [];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "{") open.push(index);
    else if (code[index] === "}" && open.length) {
      const start = open.pop()!, before = code.slice(Math.max(0, start - 80), start);
      // A brace after a parameter list, an arrow, or a block keyword opens a code block, not an object or a type.
      if (/\b(import|export)\s*(type\s*)?$|(\)|=>|\belse|\btry|\bfinally|\bdo)\s*$/.test(before)) continue;
      // Keep only this object's own text: each nested brace pair becomes one space.
      let depth = 0, own = "";
      for (let position = start; position <= index; position++) {
        const character = code[position];
        if (character === "{" && ++depth === 2) own += " ";
        if (depth === 1) own += raw[position];
        if (character === "}") depth--;
      }
      const keys = new Set([...own.matchAll(KEY)].map(match => match[1] || match[2] || match[3]));
      if (keys.size) shapes.push({ file, offset: start, end: index + 1, keys });
    }
  }
  return shapes;
}

// Find key sets that several objects, interfaces, or schemas repeat. A repeated set of parameters or fields without one owner is a data clump.
export function sharedShapes(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, options: SharedShapeOptions = {}) {
  const include = options.include || (() => true);
  const units = new Map<string, SourceUnit[]>();
  for (const unit of index.units) if (unit.span && (!unit.domain || unit.domain === "code") && include(unit)) (units.get(unit.file) || units.set(unit.file, []).get(unit.file)!).push(unit);
  const shapes = [...units.keys()].flatMap(file => objectShapes(file, contents.get(file) || "")).filter(shape => shape.keys.size >= MIN_KEYS);
  const posting = new Map<string, number[]>();
  shapes.forEach((shape, position) => { for (const key of shape.keys) (posting.get(key) || posting.set(key, []).get(key)!).push(position); });
  // A candidate shape is the key set that two objects share. The rarest key of an object limits the objects to compare.
  const candidates = new Map<string, string[]>();
  shapes.forEach((shape, position) => {
    const rarest = [...shape.keys].sort((a, b) => posting.get(a)!.length - posting.get(b)!.length)[0];
    for (const other of posting.get(rarest)!.slice(0, MAX_POSTING)) if (other > position) {
      const shared = [...shape.keys].filter(key => shapes[other].keys.has(key)).sort();
      if (shared.length >= MIN_KEYS) candidates.set(shared.join("\0"), shared);
    }
  });
  const owner = (file: string, offset: number) => (units.get(file) || []).filter(unit => unit.span!.start <= offset && offset < unit.span!.end)
    .sort((a, b) => (a.span!.end - a.span!.start) - (b.span!.end - b.span!.start))[0];
  const line = (file: string, offset: number) => (contents.get(file) || "").slice(0, offset).split("\n").length;
  const found = [...candidates.values()].map(keys => {
    const holders = posting.get([...keys].sort((a, b) => posting.get(a)!.length - posting.get(b)!.length)[0])!.filter(position => keys.every(key => shapes[position].keys.has(key)));
    return { keys, holders };
  }).filter(shape => shape.holders.length >= MIN_OCCURRENCES);
  // A smaller key set that the same objects hold says nothing more than the larger one.
  const maximal = found.filter(shape => !found.some(other => other !== shape && other.keys.length > shape.keys.length && other.holders.length === shape.holders.length && shape.keys.every(key => other.keys.includes(key))));
  const reported: SharedShape[] = maximal.map(({ keys, holders }) => {
    const owners = holders.map(position => ({ position, unit: owner(shapes[position].file, shapes[position].offset) }));
    return { keys, occurrences: holders.length, files: new Set(holders.map(position => shapes[position].file)).size,
      declarations: owners.filter(({ unit }) => unit && DECLARATION_KINDS.has(unit.kind)).length,
      locations: owners.slice(0, MAX_LOCATIONS).map(({ position, unit }) => ({ file: shapes[position].file, line: line(shapes[position].file, shapes[position].offset), selector: unit ? unit.selector || unit.qualifiedName || unit.name : null })) };
  });
  // Keys that most objects use, such as type, name, or description, belong to common formats, so rare keys weigh more, as in shared dependency groups.
  const weight = (shape: SharedShape) => shape.keys.reduce((sum, key) => sum + Math.log(shapes.length / posting.get(key)!.length), 0) * Math.log2(shape.occurrences);
  reported.sort((a, b) => weight(b) - weight(a) || b.files - a.files || a.keys.join().localeCompare(b.keys.join()));
  return { shapes: reported.slice(0, options.limit || 100), coverage: { objects: shapes.length, shapes: reported.length } };
}
