import test from "node:test";
import assert from "node:assert/strict";
import { literalProfiles, sharedLiteralGroups } from "../../dist/server/repository-intelligence/shared-literals.mjs";

// Each declaration becomes a unit that spans from its start text through the end of its end text.
function project(files, declarations) {
  const contents = new Map(Object.entries(files)), units = [];
  for (const { file, name, kind = "function", domain = "code", from, to } of declarations) {
    const text = contents.get(file), start = text.indexOf(from), end = text.indexOf(to, start) + to.length;
    const line = offset => text.slice(0, offset).split("\n").length;
    units.push({ id: `${file}#${name}`, file, kind, name, domain, range: { startLine: line(start), endLine: line(end) }, span: { start, end } });
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
  assert.deepEqual(coverage, { profiledUnits: 3, literals: 9, ownedGroups: 0 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].literals.map(literal => literal.name).sort(), ["applying", "available", "awaiting-consent", "idle"]);
  assert.deepEqual(groups[0].members.map(member => member.selector).sort(), ["PHASES", "render"]);
  assert.deepEqual(groups[0].users, []);
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

test("members that import the module of a constant in their group use its values and move to users", () => {
  const states = `export const PHASES = ["applying", "available", "awaiting-consent"];\n`;
  const user = `import { PHASES } from "./states.mjs";\nexport function render(phase) {\n  return phase === "applying" ? "available" : "awaiting-consent";\n}\n`;
  const copy = `export function label(phase) {\n  return { applying: "applying", available: "available", pending: "awaiting-consent" }[phase];\n}\n`;
  const declarations = (files) => Object.keys(files).map(file => file.endsWith("states.mjs") || file.endsWith("order.mjs")
    ? { file, name: "PHASES", kind: "constant", from: "export const", to: "];" } : { file, name: file.includes("panel") ? "render" : "label", from: "export function", to: "\n}" });
  // The only other member imports the owner, so the set has one owner and no group remains.
  let files = { "src/states.mjs": states, "src/panel.mjs": user };
  let { index, contents } = project(files, declarations(files));
  let result = sharedLiteralGroups(index, contents);
  assert.deepEqual([result.groups, result.coverage.ownedGroups], [[], 1]);
  // A member that spells the set without the import keeps the group, and the importing member is listed as a user.
  files = { "src/states.mjs": states, "src/panel.mjs": user, "src/copy.mjs": copy };
  ({ index, contents } = project(files, declarations(files)));
  result = sharedLiteralGroups(index, contents);
  assert.deepEqual(result.groups[0].members.map(member => member.file).sort(), ["src/copy.mjs", "src/states.mjs"]);
  assert.deepEqual(result.groups[0].users, [{ file: "src/panel.mjs", selector: "render" }]);
  // A second constant list is a copy that must stay in step, even when its module imports the first one.
  files = { "src/states.mjs": states, "src/order.mjs": `import { PHASES } from "./states.mjs";\nexport const PHASES = ["applying", "available", "awaiting-consent"];\n` };
  ({ index, contents } = project(files, declarations(files)));
  assert.deepEqual(sharedLiteralGroups(index, contents).groups[0].members.map(member => member.file).sort(), ["src/order.mjs", "src/states.mjs"]);
});

test("instruction list items that name identifiers in backticks are clients, and tables and documentation are not", () => {
  const tools = `export const TOOLS = [{ name: "find_shared_dependencies" }, { name: "find_shared_literals" }, { name: "report_cohesion_clusters" }];\n`;
  const skill = "## Discovery\n\n3. Call `find_shared_dependencies`, `find_shared_literals`, and `report_cohesion_clusters` for the scope.\n\n| Tool | Finds |\n| --- | --- |\n| `find_shared_dependencies` | x |\n| `find_shared_literals` | y |\n| `report_cohesion_clusters` | z |\n";
  const guide = "Use `find_shared_dependencies`, `find_shared_literals`, and `report_cohesion_clusters` together.\n";
  const { index, contents } = project({ "src/tools.mjs": tools, "skills/refactor/analysis.md": skill, "docs/guide.md": guide }, [
    { file: "src/tools.mjs", name: "TOOLS", kind: "constant", from: "export const", to: "];" },
    { file: "skills/refactor/analysis.md", name: "step", kind: "list-item", domain: "instruction", from: "3. Call", to: "scope." },
    { file: "skills/refactor/analysis.md", name: "table", kind: "paragraph", domain: "instruction", from: "| Tool", to: "| z |" },
    { file: "docs/guide.md", name: "guide", kind: "paragraph", domain: "documentation", from: "Use", to: "together." }
  ]);
  const { profiles } = literalProfiles(index, contents);
  assert.deepEqual([...profiles.keys()].sort(), ["skills/refactor/analysis.md#step", "src/tools.mjs#TOOLS"]);
  // The instruction that names the values together is a client of the code that defines them.
  const [group] = sharedLiteralGroups(index, contents).groups;
  assert.deepEqual([group.members.map(member => member.selector), group.clients.map(client => client.selector)], [["TOOLS"], ["step"]]);
});

test("clients that use several entry points together report the input shape that most entry definitions share", () => {
  const entry = (name, extra = "") => `  { name: "${name}", inputSchema: { type: "object", properties: { projectRoot: { type: "string" }, snapshotId: { type: "string" }, limit: { type: "integer" }, filters: { type: "object" }${extra} } } }`;
  const tools = `export const TOOLS = [\n${[entry("find_alpha"), entry("find_beta", ", offset: { type: \"integer\" }"), `  { name: "find_gamma", inputSchema: { type: "object", properties: { query: { type: "string" } } } }`].join(",\n")}\n];\n`;
  const skill = "1. Call `find_alpha`, `find_beta`, and `find_gamma` for the scope.\n";
  const { index, contents } = project({ "src/tools.mjs": tools, "skills/a/SKILL.md": skill }, [
    { file: "src/tools.mjs", name: "TOOLS", kind: "constant", from: "export const", to: "];" },
    { file: "skills/a/SKILL.md", name: "step", kind: "list-item", domain: "instruction", from: "1. Call", to: "scope." }
  ]);
  const [group] = sharedLiteralGroups(index, contents).groups;
  assert.deepEqual(group.entryShape, { keys: ["filters", "limit", "projectRoot", "snapshotId"], entries: 2, of: 3 });
  // A group without clients reports no entry shape.
  const plain = project({ "src/tools.mjs": tools, "src/other.mjs": `export const NAMES = ["find_alpha", "find_beta", "find_gamma"];\n` }, [
    { file: "src/tools.mjs", name: "TOOLS", kind: "constant", from: "export const", to: "];" },
    { file: "src/other.mjs", name: "NAMES", kind: "constant", from: "export const", to: "];" }
  ]);
  assert.equal(sharedLiteralGroups(plain.index, plain.contents).groups[0].entryShape, null);
});
