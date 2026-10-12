import test from "node:test";
import assert from "node:assert/strict";
import { complexUnits } from "../../dist/server/repository-intelligence/complex-units.mjs";
import { codeOnly } from "../../dist/server/repository-intelligence/code-text.mjs";

// One function unit that spans the whole text, as index and contents arguments.
const unit = (file, text, signature) => [{ units: [{ id: "u", file, kind: "function", name: "handle", signature, range: { startLine: 1, endLine: text.split("\n").length }, span: { start: 0, end: text.length } }] }, new Map([[file, text]])];

test("comments and string contents do not count as code, and offsets stay in place", () => {
  const text = `const a = "if (x) {"; // if y\nconst b = 'while'; /* for\nfor */ const c = \`case\`;`;
  const code = codeOnly(text, "c");
  assert.equal(code.length, text.length);
  assert.equal(code.split("\n").length, text.split("\n").length);
  assert.doesNotMatch(code, /\b(if|while|for|case)\b/);
  assert.match(codeOnly(text, "c", true), /"if \(x\) \{"/);
  assert.doesNotMatch(codeOnly("x = 1  # if this\ny = '''for\nwhile'''", "python"), /\b(if|for|while)\b/);
  // A Rust lifetime is not a string, so the code after it still counts.
  assert.match(codeOnly("fn f<'a>(x: &'a str) { if x.is_empty() {} }", "rust"), /\bif\b/);
});

test("a dispatch chain on one value is reported with its subject and the number of values", () => {
  const branches = Array.from({ length: 10 }, (_, index) => `  ${index ? "else " : ""}if (name === "tool_${index}") return run${index}(input);`).join("\n");
  const text = `function handle(name, input, { limit } = {}) {\n${branches}\n  // if (name === "commented") would not count\n  throw new Error("if unknown");\n}`;
  const { units, coverage } = complexUnits(...(unit("src/mcp.mjs", text, "(name, input, { limit } = {})")));
  assert.deepEqual(coverage, { functions: 1, reported: 1 });
  assert.deepEqual([units[0].dispatch, units[0].branches, units[0].parameters, units[0].maxDepth], [{ subject: "name", values: 10 }, 10, 3, 0]);
});

test("switch labels count toward the switch subject, and Python branches and nesting are counted", () => {
  const cases = Array.from({ length: 9 }, (_, index) => `    case "kind_${index}": return ${index};`).join("\n");
  const text = `function handle(node) {\n  switch (node.type) {\n${cases}\n  }\n}`;
  assert.deepEqual(complexUnits(...(unit("src/units.ts", text))).units[0].dispatch, { subject: "node.type", values: 9 });
  const python = `def handle(event):\n${Array.from({ length: 13 }, (_, index) => `    if event.kind == "k${index}" and event.ready:\n        for item in event.items:\n            process(item)`).join("\n")}`;
  const [reported] = complexUnits(...(unit("tools/run.py", python, "(event)"))).units;
  assert.deepEqual([reported.branches, reported.maxDepth, reported.dispatch], [39, 2, { subject: "event.kind", values: 13 }]);
  // A short unit without branches is not reported.
  assert.deepEqual(complexUnits(...(unit("src/small.mjs", "function handle() {\n  return 1;\n}"))).units, []);
});
