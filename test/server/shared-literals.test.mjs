import test from "node:test";
import assert from "node:assert/strict";
import { literalProfiles, sharedLiteralGroups } from "../../dist/server/repository-intelligence/shared-literals.mjs";

// Each declaration becomes a unit that spans from its start text through the end of its end text.
function project(files, declarations) {
  const contents = new Map(Object.entries(files)), units = [];
  for (const { file, name, kind = "function", from, to } of declarations) {
    const text = contents.get(file), start = text.indexOf(from), end = text.indexOf(to, start) + to.length;
    const line = offset => text.slice(0, offset).split("\n").length;
    units.push({ id: `${file}#${name}`, file, kind, name, domain: "code", range: { startLine: line(start), endLine: line(end) }, span: { start, end } });
  }
  return { index: { units }, contents };
}

test("units in different files that spell the same rare literals form a group", () => {
  const { index, contents } = project({
    "src/states.ts": `export const PHASES = ["applying", "available", "awaiting-consent", "idle"];\n`,
    "src/panel.ts": `export function render(phase) {\n  if (phase === "applying" || phase === 'available') return "awaiting-consent";\n  return "idle";\n}\n`,
    "src/other.ts": `export function label() { return "applying"; }\n`
  }, [
    { file: "src/states.ts", name: "PHASES", kind: "constant", from: "export const", to: "];" },
    { file: "src/panel.ts", name: "render", from: "export function", to: "\n}" },
    { file: "src/other.ts", name: "label", from: "export function", to: "}" }
  ]);
  const { groups, coverage } = sharedLiteralGroups(index, contents);
  assert.deepEqual(coverage, { profiledUnits: 3, literals: 9 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].literals.map(literal => literal.name).sort(), ["applying", "available", "awaiting-consent", "idle"]);
  assert.deepEqual(groups[0].members.map(member => member.selector).sort(), ["PHASES", "render"]);
});

test("module specifiers, prose, and literals outside units are ignored, and the innermost unit owns a literal", () => {
  const { index, contents } = project({
    "src/a.ts": `import { x } from "./shared-module";\nconst y = require("./other-module");\nexport function outer() {\n  const message = "Could not start";\n  function inner() { return ["alpha", "beta"]; }\n  return "gamma";\n}\nconst stray = "delta";\n`
  }, [
    { file: "src/a.ts", name: "outer", from: "export function outer", to: "\n}" },
    { file: "src/a.ts", name: "inner", from: "function inner", to: "; }" }
  ]);
  const { profiles } = literalProfiles(index, contents);
  assert.deepEqual([...profiles.get("src/a.ts#outer")], ["gamma"]);
  assert.deepEqual([...profiles.get("src/a.ts#inner")], ["alpha", "beta"]);
  assert.equal(profiles.size, 2);
});
