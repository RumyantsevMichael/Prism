import test from "node:test";
import assert from "node:assert/strict";
import { cohesionReport, louvain } from "../../dist/server/repository-intelligence/cohesion.mjs";

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

// Build a class or type whose methods each touch the state of their group, padded to a fixed number of lines.
function container({ file = "src/store.ts", self = "this", rust = false, groups, linesPerMethod = 80, shared = [] }) {
  let text = rust ? "impl Store {\n" : "class Store {\n";
  const methods = [];
  const add = (name, body) => {
    const start = text.length;
    text += rust ? `    fn ${name}(&self) {\n${body}    }\n` : `  ${name}() {\n${body}  }\n`;
    methods.push({ name, start, end: text.length });
  };
  add(rust ? "new" : "constructor", groups.flatMap(group => group.state).map(field => `    ${self}.${field} = 0;\n`).join(""));
  for (const group of groups) for (const name of group.names)
    add(name, [...[...group.state, ...shared].map(field => `    ${self}.${field}.write();\n`), ...Array(linesPerMethod - 2 - group.state.length - shared.length).fill("    work();\n")].join(""));
  text += "}\n";
  const units = [];
  if (!rust) units.push({ id: "class", file, kind: "class", name: "Store", range: { startLine: 1, endLine: lineOf(text, text.length - 1) }, span: { start: 0, end: text.length } });
  for (const method of methods) units.push({ id: method.name, file, kind: "method", name: method.name, qualifiedName: `Store::${method.name}`, containerId: rust ? undefined : "class",
    range: { startLine: lineOf(text, method.start), endLine: lineOf(text, method.end - 1) }, span: { start: method.start, end: method.end } });
  return { index: { units, edges: [] }, contents: new Map([[file, text]]) };
}

test("Louvain separates two linked triangles", () => {
  const adjacency = Array.from({ length: 6 }, () => new Map());
  const link = (a, b) => { adjacency[a].set(b, 1); adjacency[b].set(a, 1); };
  for (const [a, b] of [[0, 1], [1, 2], [0, 2], [3, 4], [4, 5], [3, 5], [2, 3]]) link(a, b);
  const { communities, modularity } = louvain(adjacency);
  assert.equal(new Set(communities.slice(0, 3)).size, 1);
  assert.equal(new Set(communities.slice(3)).size, 1);
  assert.notEqual(communities[0], communities[3]);
  assert.ok(modularity > 0.35 && modularity < 0.36, String(modularity));
});

test("a class whose methods use two separate sets of fields splits into two clusters, even when every method uses a logger", () => {
  const { index, contents } = container({ groups: [{ state: ["orders", "carts", "invoices"], names: ["place", "cancel", "refund", "ship"] }, { state: ["users", "sessions", "roles"], names: ["login", "logout", "rename", "ban"] }], shared: ["log"] });
  const { containers, coverage } = cohesionReport(index, contents);
  assert.deepEqual(coverage, { examinedContainers: 1, reportedContainers: 1 });
  const [store] = containers;
  assert.deepEqual([store.kind, store.name, store.members, store.clusters.length], ["class", "Store", 9, 2]);
  assert.deepEqual(store.clusters.map(cluster => cluster.members.map(member => member.selector).sort()), [["Store::cancel", "Store::place", "Store::refund", "Store::ship"], ["Store::ban", "Store::login", "Store::logout", "Store::rename"]]);
  assert.deepEqual(store.clusters.map(cluster => cluster.state.sort()), [["carts", "invoices", "log", "orders"], ["log", "roles", "sessions", "users"]]);
  assert.equal(store.separableLines, 320);
  assert.ok(store.modularity >= 0.3);
});

test("a cohesive class, a small class, and test code are not reported", () => {
  const cohesive = container({ groups: [{ state: ["orders"], names: ["place", "cancel", "refund", "ship", "login", "logout", "rename", "ban"] }] });
  assert.deepEqual(cohesionReport(cohesive.index, cohesive.contents).containers, []);
  // Each cluster is real, but the code outside the largest cluster is below the reporting size.
  const small = container({ groups: [{ state: ["orders"], names: ["place", "cancel", "refund"] }, { state: ["users"], names: ["login", "logout", "rename"] }], linesPerMethod: 40 });
  assert.deepEqual(cohesionReport(small.index, small.contents).containers, []);
  const split = container({ groups: [{ state: ["orders"], names: ["place", "cancel", "refund", "ship"] }, { state: ["users"], names: ["login", "logout", "rename", "ban"] }] });
  assert.deepEqual(cohesionReport(split.index, split.contents, { include: () => false }).coverage, { examinedContainers: 0, reportedContainers: 0 });
});

test("Rust methods group by the type in their qualified name and link through self fields", () => {
  const { index, contents } = container({ file: "src/store.rs", self: "self", rust: true, groups: [{ state: ["orders"], names: ["place", "cancel", "refund", "ship"] }, { state: ["users"], names: ["login", "logout", "rename", "ban"] }] });
  const [store] = cohesionReport(index, contents).containers;
  assert.deepEqual([store.kind, store.name, store.clusters.length], ["type", "Store", 2]);
});

test("module functions link through the module constants they use and the functions they call", () => {
  let text = "const ORDERS = new Map();\nconst USERS = new Map();\n";
  const units = [{ id: "file", file: "src/app.mjs", kind: "file", name: "src/app.mjs", range: { startLine: 1, endLine: 1 } }];
  for (const name of ["ORDERS", "USERS"]) units.push({ id: name, file: "src/app.mjs", kind: "constant", name, containerId: "file", range: { startLine: 1, endLine: 1 } });
  const edges = [];
  for (const [state, names] of [["ORDERS", ["place", "cancel", "refund", "ship"]], ["USERS", ["login", "logout", "rename", "ban"]]]) {
    for (const name of names) {
      const start = text.length;
      // Only the first function of each group uses the constant, and the others reach it through calls.
      text += `function ${name}() {\n${name === names[0] ? `  ${state}.clear();\n` : ""}${"  work();\n".repeat(78)}}\n`;
      units.push({ id: name, file: "src/app.mjs", kind: "function", name, containerId: "file", range: { startLine: lineOf(text, start), endLine: lineOf(text, text.length - 1) }, span: { start, end: text.length } });
      if (name !== names[0]) edges.push({ source: name, target: names[0], kind: "calls" });
    }
  }
  const [module] = cohesionReport({ units, edges }, new Map([["src/app.mjs", text]])).containers;
  assert.deepEqual([module.kind, module.name, module.clusters.length], ["module", "app.mjs", 2]);
  assert.deepEqual(module.clusters.map(cluster => cluster.state).sort(), [["ORDERS"], ["USERS"]]);
});
