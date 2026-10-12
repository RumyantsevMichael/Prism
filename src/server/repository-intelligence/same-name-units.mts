import { dependencyProfiles } from "./shared-dependencies.mjs";
import { codeFamily, codeOnly, identifiers } from "./code-text.mjs";
import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface SameNameOptions { include?: (unit: SourceUnit) => boolean }
export interface SameNameVariant { members: { file: string; selector: string; range: SourceRange }[]; lines: number; signature: string | null; throws: number; onlyHere: string[] }
export interface SameNameGroup { name: string; kind: "diverged" | "identical"; files: number; similarity: number; variants: SameNameVariant[] }

// Bodies this short rarely carry knowledge, and members beyond this count make one name too generic to compare.
const MIN_LINES = 3, MAX_MEMBERS = 20;
// Variants that share less than this part of their identifiers are unrelated functions that only share a name.
const MIN_SIMILARITY = 0.3, SHORT_SIMILARITY = 0.5;
const THROW = /\b(throw|raise|panic!)\b/g;

const lineCount = (range: SourceRange) => range.endLine - range.startLine + 1;
const jaccard = (a: Set<string>, b: Set<string>) => { let shared = 0; for (const item of a) if (b.has(item)) shared++; return shared / Math.max(1, a.size + b.size - shared); };

// Group functions in different files that have the same name. Identical bodies are copies, and different bodies of one name are variants that can carry different contracts.
// Methods are left out, because the same method name in several classes is usually polymorphism.
export function sameNameGroups(index: Pick<IndexMetadata, "units" | "edges" | "unresolvedReferences">, contents: Map<string, string>, options: SameNameOptions = {}) {
  const include = options.include || (() => true);
  const candidates = index.units.filter(unit => unit.kind === "function" && unit.span && lineCount(unit.range) >= MIN_LINES && include(unit));
  const byName = new Map<string, SourceUnit[]>();
  for (const unit of candidates) (byName.get(unit.name) || byName.set(unit.name, []).get(unit.name)!).push(unit);
  const profiles = dependencyProfiles(index, include);
  const groups: SameNameGroup[] = [];
  for (const [name, units] of byName) {
    if (new Set(units.map(unit => unit.file)).size < 2 || units.length > MAX_MEMBERS) continue;
    const code = new Map(units.map(unit => [unit.id, codeOnly((contents.get(unit.file) || "").slice(unit.span!.start, unit.span!.end), codeFamily(unit.file))]));
    // Whitespace and an export keyword do not change a body, so the normalized text identifies each variant.
    const body = (unit: SourceUnit) => (contents.get(unit.file) || "").slice(unit.span!.start, unit.span!.end).replace(/^\s*(export\s+(default\s+)?|pub(\([^)]*\))?\s+)/, "").replace(/\s+/g, " ").trim();
    const variants = new Map<string, SourceUnit[]>();
    for (const unit of units) (variants.get(body(unit)) || variants.set(body(unit), []).get(body(unit))!).push(unit);
    const lists = [...variants.values()].sort((a, b) => b.length - a.length || a[0].file.localeCompare(b[0].file));
    const tokens = lists.map(list => identifiers(code.get(list[0].id)!));
    let similarity = 1;
    for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) similarity = Math.min(similarity, jaccard(tokens[i], tokens[j]));
    // A few shared identifiers make very short bodies look alike, so wrappers that only forward to different calls need more overlap.
    if (similarity < (lists.every(list => lineCount(list[0].range) <= MIN_LINES) ? SHORT_SIMILARITY : MIN_SIMILARITY)) continue;
    // A dependency that some variants use and others do not shows where their behavior differs.
    const dependencies = lists.map(list => profiles.get(list[0].id) || new Set<string>());
    const common = dependencies.reduce((shared, set) => new Set([...shared].filter(name => set.has(name))));
    groups.push({ name, kind: lists.length > 1 ? "diverged" : "identical", files: new Set(units.map(unit => unit.file)).size, similarity: Number(similarity.toFixed(2)),
      variants: lists.map((list, position) => ({
        members: list.map(unit => ({ file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, range: unit.range })),
        lines: lineCount(list[0].range), signature: list[0].signature || null,
        throws: (code.get(list[0].id)!.match(THROW) || []).length,
        onlyHere: [...dependencies[position]].filter(name => !common.has(name)).sort().slice(0, 20)
      })) });
  }
  // One name with different contracts misleads readers most: variants that differ in whether they throw come first, then variants that use different dependencies,
  // then other diverged variants, and then identical copies by duplicated lines.
  const signal = (group: SameNameGroup) => group.kind === "identical" ? 3
    : new Set(group.variants.map(variant => variant.throws > 0)).size > 1 ? 0 : group.variants.some(variant => variant.onlyHere.length) ? 1 : 2;
  const weight = (group: SameNameGroup) => group.variants.reduce((sum, variant) => sum + variant.lines * variant.members.length, 0) - Math.max(...group.variants.map(variant => variant.lines));
  groups.sort((a, b) => signal(a) - signal(b) || b.files - a.files || weight(b) - weight(a) || a.name.localeCompare(b.name));
  return { groups, coverage: { functions: candidates.length, names: byName.size } };
}
