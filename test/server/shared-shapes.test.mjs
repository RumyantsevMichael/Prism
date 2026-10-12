import test from "node:test";
import assert from "node:assert/strict";
import { sharedShapes } from "../../dist/server/repository-intelligence/shared-shapes.mjs";

// Each listed declaration becomes a unit from its start text through the end of its end text.
function project(files, declarations) {
  const contents = new Map(Object.entries(files)), units = [];
  for (const { file, name, kind, from, to } of declarations) {
    const text = contents.get(file), start = text.indexOf(from), end = text.indexOf(to, start) + to.length;
    units.push({ id: `${file}#${name}`, file, kind, name, domain: "code", range: { startLine: 1, endLine: 1 }, span: { start, end } });
  }
  return { index: { units }, contents };
}

const schema = (extra = "") => `{ projectRoot: { type: "string" }, snapshotId: { type: "string" }, limit: { type: "integer", minimum: 1 }, filters: { type: "object" }${extra} }`;

test("objects, schemas, and interfaces that repeat a key set form one shape, with nested keys and import lists left out", () => {
  const tools = `import { alpha, beta, gamma, delta } from "./a.mjs";\nexport const TOOLS = [\n  { name: "one", inputSchema: ${schema()} },\n  { name: "two", inputSchema: ${schema(', offset: { type: "integer" }')} },\n  { name: "three", inputSchema: ${schema()} }\n];\n`;
  const types = `export interface AnalysisInput { projectRoot: string; snapshotId?: string; limit?: number; filters?: { paths?: string[] } }\nexport function call(projectRoot, snapshotId, limit, filters) { return run({ projectRoot, snapshotId, limit, filters }); }\n`;
  const imports = `import { alpha, beta, gamma, delta } from "./a.mjs";\nimport { alpha, beta, gamma, delta } from "./b.mjs";\nexport { alpha, beta, gamma, delta };\n`;
  const { index, contents } = project({ "src/tools.mjs": tools, "src/types.ts": types, "src/imports.mjs": imports }, [
    { file: "src/tools.mjs", name: "TOOLS", kind: "constant", from: "export const", to: "];" },
    { file: "src/types.ts", name: "AnalysisInput", kind: "interface", from: "export interface", to: "] } }" },
    { file: "src/types.ts", name: "call", kind: "function", from: "export function", to: "}); }" },
    { file: "src/imports.mjs", name: "imports", kind: "constant", from: "import", to: "};" }
  ]);
  const { shapes } = sharedShapes(index, contents);
  // The largest shared key set is reported once, and its subsets with the same holders are not.
  assert.deepEqual(shapes.map(shape => [shape.keys, shape.occurrences, shape.files, shape.declarations]), [[["filters", "limit", "projectRoot", "snapshotId"], 5, 2, 1]]);
  assert.deepEqual(shapes[0].locations.map(location => location.selector).sort(), ["AnalysisInput", "TOOLS", "TOOLS", "TOOLS", "call"]);
});

test("a key set that fewer than three objects repeat, or that has fewer than four keys, is not a shape", () => {
  const text = `const a = { id: 1, name: "a", kind: "x" };\nconst b = { id: 2, name: "b", kind: "y" };\nconst c = { id: 3, name: "c", kind: "z" };\nconst d = { one: 1, two: 2, three: 3, four: 4 };\nconst e = { one: 1, two: 2, three: 3, four: 4 };\n`;
  const { index, contents } = project({ "src/a.mjs": text }, [{ file: "src/a.mjs", name: "all", kind: "constant", from: "const a", to: "4 };\n" }]);
  assert.deepEqual(sharedShapes(index, contents).shapes, []);
});
