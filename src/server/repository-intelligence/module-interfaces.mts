import path from "node:path";
import { searchExclusion } from "../../native-runtime/domains.mjs";
import { isTestFile } from "./shared-dependencies.mjs";
import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface ModuleExport { name: string; kind: string; range: SourceRange; importers: number; testImporters: number }
export interface ModuleInterface { file: string; importers: number; testImporters: number; wholeModuleImporters: number; namesPerImporter: number | null; exports: ModuleExport[]; unusedExports: string[]; testOnlyExports: string[] }
export interface DelegatingClass { file: string; selector: string; range: SourceRange; publicMethods: number; forwarding: number; delegate: string; unchangedNames: number }
export interface ModuleInterfaceOptions { include?: (file: string) => boolean; allModules?: boolean }

const SCRIPT = /\.(m?[jt]sx?|c[jt]s)$/i;
const IMPORTING = /\.(m?[jt]sx?|c[jt]s|astro|vue|svelte|html?)$/i;
const DECLARATION = /\.d\.[cm]?ts$/i;
const EXPORT_KINDS = new Set(["function", "class", "constant", "variable"]);
// Design notes and examples can hold code that no program imports.
const NON_RUNTIME = /(^|\/)(docs|examples?|fixtures?)\//;

// Read a JSON file that may contain comments and trailing commas, such as tsconfig.json.
function looseJson(text: string) {
  try { return JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/[^\n]*/g, "$1").replace(/,(\s*[}\]])/g, "$1")); }
  catch { return null; }
}

interface Resolver { resolve(from: string, specifier: string): string | null; external(specifier: string): boolean }

function resolver(contents: Map<string, string>): Resolver {
  const files = new Set(contents.keys());
  const packages = new Map<string, { dir: string; exports: unknown; main?: string }>();
  const aliases: { dir: string; base: string; pattern: string; targets: string[] }[] = [];
  for (const [file, text] of contents) {
    const base = path.posix.basename(file), dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (base === "package.json") {
      const value = looseJson(text);
      if (!value) continue;
      if (typeof value.name === "string") packages.set(value.name, { dir, exports: value.exports, main: value.main || value.module || value.types });
    } else if (/^[jt]sconfig.*\.json$/.test(base)) {
      const options = looseJson(text)?.compilerOptions;
      for (const [pattern, targets] of Object.entries(options?.paths || {})) if (Array.isArray(targets))
        aliases.push({ dir, base: path.posix.join(dir, options.baseUrl || "."), pattern, targets: targets.filter((target: unknown) => typeof target === "string") });
    }
  }
  aliases.sort((a, b) => b.dir.length - a.dir.length);
  // A specifier can name a built file that mirrors a source file, such as dist/x.mjs for src/x.mts.
  const file = (base: string): string | null => {
    const generated = base.match(/^(?:(.*)\/)?(dist|build|out|lib)\/(.*)$/);
    if (generated) { const source = file(path.posix.join(generated[1] || "", "src", generated[3])); if (source) return source; }
    const stem = base.replace(/\.(m?js|cjs|jsx)$/, "");
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.mjs`, `${stem}.js`, `${stem}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.mjs`, `${base}/index.js`])
      if (files.has(candidate) && !DECLARATION.test(candidate)) return candidate;
    return null;
  };
  const exportTarget = (entry: unknown): string | null => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return null;
    const conditions = entry as Record<string, unknown>;
    for (const key of ["source", "bun", "import", "module", "default", "require", "types", "node"]) { const target = exportTarget(conditions[key]); if (target) return target; }
    return null;
  };
  const workspace = (specifier: string) => {
    const parts = specifier.split("/"), scoped = specifier.startsWith("@");
    const name = parts.slice(0, scoped ? 2 : 1).join("/"), sub = parts.slice(scoped ? 2 : 1).join("/");
    const entry = packages.get(name);
    if (!entry) return undefined;
    const join = (relative: string) => file(path.posix.normalize(path.posix.join(entry.dir, relative)));
    const map = entry.exports, key = sub ? `./${sub}` : ".";
    if (map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).some(item => item.startsWith("."))) {
      const exports = map as Record<string, unknown>;
      const direct = exportTarget(exports[key]);
      if (direct) return join(direct);
      for (const [pattern, target] of Object.entries(exports)) {
        const star = pattern.indexOf("*"), resolved = exportTarget(target);
        if (star < 0 || !resolved || !key.startsWith(pattern.slice(0, star)) || !key.endsWith(pattern.slice(star + 1))) continue;
        return join(resolved.replace("*", key.slice(star, key.length - (pattern.length - star - 1))));
      }
    } else if (!sub && exportTarget(map)) return join(exportTarget(map)!);
    return sub ? join(sub) : (entry.main ? join(entry.main) : join("index") || join("src/index"));
  };
  return {
    resolve(from, specifier) {
      if (specifier.startsWith(".")) return file(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
      const local = workspace(specifier);
      if (local !== undefined) return local;
      for (const alias of aliases) {
        if (alias.dir && !from.startsWith(`${alias.dir}/`)) continue;
        const star = alias.pattern.indexOf("*"), prefix = star < 0 ? alias.pattern : alias.pattern.slice(0, star), suffix = star < 0 ? "" : alias.pattern.slice(star + 1);
        if (star < 0 ? specifier !== alias.pattern : !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
        const middle = star < 0 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
        for (const target of alias.targets) { const found = file(path.posix.normalize(path.posix.join(alias.base, target.replace("*", middle)))); if (found) return found; }
      }
      return null;
    },
    // A specifier is external unless it is relative, names a workspace package, or matches a path alias.
    external(specifier) {
      if (specifier.startsWith(".")) return false;
      if (/^(node|bun|npm|jsr|https?|data|virtual):/.test(specifier) || specifier.startsWith("/")) return true;
      const parts = specifier.split("/"), name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      return !packages.has(name) && !aliases.some(alias => specifier.startsWith(alias.pattern.split("*")[0]));
    }
  };
}

interface ImportEdge { from: string; to: string; names: string[] }

// Static imports, re-exports, dynamic imports, and require calls. A dynamic import or require can use any export.
function importEdges(contents: Map<string, string>, resolve: Resolver) {
  const edges: ImportEdge[] = [];
  let statements = 0, unresolved = 0;
  const unresolvedSamples: string[] = [];
  const forms = [
    { pattern: /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\w*${}\s,]+?)\s+from\s*["']([^"'\n]+)["']/g, clause: 3, specifier: 4 },
    { pattern: /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g, clause: 0, specifier: 1 }
  ];
  for (const [file, text] of contents) {
    if (!IMPORTING.test(file) || DECLARATION.test(file)) continue;
    for (const form of forms) for (const match of text.matchAll(form.pattern)) {
      statements++;
      const specifier = match[form.specifier], to = resolve.resolve(file, specifier);
      if (!to) {
        if (!resolve.external(specifier)) { unresolved++; if (unresolvedSamples.length < 10) unresolvedSamples.push(`${file}: ${specifier}`); }
        continue;
      }
      const clause = form.clause ? match[form.clause] : "*", named = clause.match(/\{([\s\S]*?)\}/);
      const names = named ? named[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean) : [];
      if (!named && form.clause && match[1] === "import" && !clause.includes("*")) names.push("default");
      if (clause.includes("*")) names.push("*");
      else if (/^\s*\w+\s*,/.test(clause) && match[1] === "import") names.push("default");
      edges.push({ from: file, to, names: [...new Set(names)] });
    }
  }
  return { edges, statements, unresolved, unresolvedSamples };
}

// The files that each file imports through static imports, re-exports, dynamic imports, or require calls.
export function moduleImports(contents: Map<string, string>) {
  const imports = new Map<string, Set<string>>();
  for (const edge of importEdges(contents, resolver(contents)).edges) (imports.get(edge.from) || imports.set(edge.from, new Set()).get(edge.from)!).add(edge.to);
  return imports;
}

const parameterNames = (signature?: string) => {
  const match = (signature || "").match(/^\s*\((.*)\)/s);
  if (!match) return [];
  const items: string[] = [];
  let depth = 0, current = "";
  for (const character of match[1]) {
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (character === "," && depth === 0) { items.push(current); current = ""; } else current += character;
  }
  if (current.trim()) items.push(current);
  return items.map(item => item.trim().replace(/^(\.\.\.|\*+)/, "").replace(/^(public|private|protected|readonly)\s+/, "").split(/[:=\s?]/)[0])
    .filter(item => /^\w+$/.test(item) && !["self", "cls", "this"].includes(item));
};

// A public method forwards when its whole body is one call on a field of the same object that passes on every parameter.
function forwardTarget(method: SourceUnit, content: string) {
  if (!method.span) return null;
  const source = content.slice(method.span.start, method.span.end), python = method.file.endsWith(".py");
  const body = python ? source.replace(/^[^\n]*:\s*\n/, "").replace(/^\s*("""[\s\S]*?"""|'''[\s\S]*?''')\s*/, "") : source.replace(/^[^{]*?\{/s, "").replace(/\}\s*$/, "");
  const statements = body.split(python ? /\n/ : /;\s*|\n/).map(line => line.trim()).filter(line => line && !line.startsWith("//") && !line.startsWith("#"));
  if (statements.length !== 1) return null;
  const call = statements[0].match(/^(?:return\s+)?(?:await\s+)?(?:this|self)\.(#?\w+)\.(\w+)\((.*)\)$/s);
  if (!call || !parameterNames(method.signature).every(name => new RegExp(`\\b${name}\\b`).test(call[3]))) return null;
  return { field: call[1], unchanged: call[2] === method.name };
}

export function delegatingClasses(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, include: (file: string) => boolean = () => true) {
  const methods = new Map<string, SourceUnit[]>();
  for (const unit of index.units) if (unit.kind === "method" && unit.containerId) (methods.get(unit.containerId) || methods.set(unit.containerId, []).get(unit.containerId)!).push(unit);
  const found: DelegatingClass[] = [];
  for (const unit of index.units) {
    if (unit.kind !== "class" || !include(unit.file)) continue;
    const publicMethods = (methods.get(unit.id) || []).filter(method => !/^(_|#)/.test(method.name) && !["constructor", "__init__"].includes(method.name));
    if (publicMethods.length < 3) continue;
    const targets = publicMethods.map(method => forwardTarget(method, contents.get(unit.file) || "")), byField = new Map<string, number>();
    for (const target of targets) if (target) byField.set(target.field, (byField.get(target.field) || 0) + 1);
    const [delegate, forwarding] = [...byField].sort((a, b) => b[1] - a[1])[0] || ["", 0];
    if (forwarding < 3 || forwarding < publicMethods.length / 2) continue;
    found.push({ file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, range: unit.range, publicMethods: publicMethods.length, forwarding, delegate,
      unchangedNames: targets.filter(target => target?.field === delegate && target.unchanged).length });
  }
  return found.sort((a, b) => b.forwarding / b.publicMethods - a.forwarding / a.publicMethods || a.file.localeCompare(b.file));
}

// Report each JavaScript or TypeScript module's exports and the modules that import them.
export function moduleInterfaceReport(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, options: ModuleInterfaceOptions = {}) {
  const include = options.include || (() => true);
  const runtime = (file: string) => !isTestFile(file) && !NON_RUNTIME.test(file) && !DECLARATION.test(file) && !searchExclusion(file, contents.get(file) || "");
  const { edges, statements, unresolved, unresolvedSamples } = importEdges(contents, resolver(contents));
  const users = new Map<string, Map<string, Set<string>>>();
  for (const edge of edges) for (const name of edge.names) {
    const byName = users.get(edge.to) || users.set(edge.to, new Map()).get(edge.to)!;
    (byName.get(name) || byName.set(name, new Set()).get(name)!).add(edge.from);
  }
  const byId = new Map(index.units.map(unit => [unit.id, unit]));
  // The graph can mark closures and local variables as exported, so a module export must be a top-level declaration with the export keyword.
  const declaredExport = (unit: SourceUnit) => {
    const container = unit.containerId ? byId.get(unit.containerId) : undefined;
    const line = (contents.get(unit.file) || "").split("\n")[unit.range.startLine - 1] || "";
    return (!container || container.kind === "file") && /^\s*export\b/.test(line);
  };
  const exported = new Map<string, SourceUnit[]>();
  for (const unit of index.units) if (unit.isExported && EXPORT_KINDS.has(unit.kind) && SCRIPT.test(unit.file) && runtime(unit.file) && include(unit.file) && declaredExport(unit))
    (exported.get(unit.file) || exported.set(unit.file, []).get(unit.file)!).push(unit);
  const modules: ModuleInterface[] = [];
  for (const [file, units] of exported) {
    const byName = users.get(file) || new Map<string, Set<string>>(), whole = byName.get("*") || new Set<string>(), lines = (contents.get(file) || "").split("\n");
    // A default export is imported by the name "default", not by its declared name.
    const importersOf = (unit: SourceUnit) => new Set([...(byName.get(unit.name) || []), ...whole, ...(/^\s*export\s+default\b/.test(lines[unit.range.startLine - 1] || "") ? byName.get("default") || [] : [])]);
    const exports = units.map(unit => {
      const importers = [...importersOf(unit)].filter(importer => importer !== file);
      return { name: unit.name, kind: unit.kind, range: unit.range, importers: importers.filter(importer => !isTestFile(importer)).length, testImporters: importers.filter(isTestFile).length };
    });
    const all = new Set([...byName.values()].flatMap(set => [...set]).filter(importer => importer !== file));
    const counts = [...all].filter(importer => !whole.has(importer)).map(importer => [...byName].filter(([name, set]) => name !== "*" && set.has(importer)).length).sort((a, b) => a - b);
    const module = { file, importers: [...all].filter(importer => !isTestFile(importer)).length, testImporters: [...all].filter(isTestFile).length, wholeModuleImporters: whole.size,
      namesPerImporter: counts.length ? counts[Math.floor(counts.length / 2)] : null, exports,
      unusedExports: exports.filter(item => !item.importers && !item.testImporters).map(item => item.name),
      testOnlyExports: exports.filter(item => !item.importers && item.testImporters).map(item => item.name) };
    if (options.allModules || module.unusedExports.length || module.testOnlyExports.length) modules.push(module);
  }
  modules.sort((a, b) => b.unusedExports.length - a.unusedExports.length || b.testOnlyExports.length - a.testOnlyExports.length || a.file.localeCompare(b.file));
  const otherCode = new Set(index.units.filter(unit => unit.kind === "file" && /\.(py|go|rs|java|cs|c|h|cc|cpp|cxx|hpp|hh)$/i.test(unit.file)).map(unit => path.posix.extname(unit.file).toLowerCase()));
  return { modules, delegatingClasses: delegatingClasses(index, contents, file => runtime(file) && include(file)),
    coverage: { exportingModules: exported.size, importStatements: statements, resolvedImports: edges.length, unresolvedLocalImports: unresolved, unresolvedSamples, importAnalysisSkipped: [...otherCode].sort() } };
}
