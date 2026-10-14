import test from "node:test";
import assert from "node:assert/strict";
import { detectorDiff } from "../../dist/server/conservation/detector-diff.mjs";

// Each function becomes a unit that spans its source text.
function side(files) {
  const contents = new Map(), units = [];
  for (const [file, functions] of Object.entries(files)) {
    let text = "";
    for (const [name, body] of Object.entries(functions)) {
      const start = text.length, line = text.split("\n").length;
      text += `${body}\n`;
      units.push({ id: `${file}#${name}`, file, domain: "code", kind: "function", name, selector: name, range: { startLine: line, endLine: line + body.split("\n").length - 1 }, span: { start, end: start + body.length } });
    }
    contents.set(file, text);
  }
  return { index: { units, edges: [], unresolvedReferences: [] }, contents };
}

const lockOwner = `function readLockOwner(lockPath) {
  const text = readFileSync(lockPath, "utf8");
  const owner = JSON.parse(text);
  if (!owner.pid) return null;
  if (owner.token.length !== 36) return null;
  const alive = processState(owner.pid);
  if (!alive) return null;
  const age = Date.now() - owner.createdAt;
  if (age > LOCK_STALE_MS) return null;
  return { pid: owner.pid, token: owner.token };
}`;
const branchy = `function route(event) {\n${Array.from({ length: 30 }, (_, index) => `  if (event.kind === "k${index}") return handle${index}(event);`).join("\n")}\n  return null;\n}`;
const codes = findings => findings.map(finding => `${finding.code}:${finding.file}`).sort();

test("a new copy of a function is a failure, while a moved function and an unchanged baseline copy are not reported", () => {
  const before = side({ "src/trace.mjs": { readLockOwner: lockOwner }, "src/facts.mjs": { readLockOwner: lockOwner }, "src/data.mjs": { report: "function report() {\n  return 1;\n}" } });
  const copied = side({ "src/trace.mjs": { readLockOwner: lockOwner }, "src/facts.mjs": { readLockOwner: lockOwner }, "src/data.mjs": { report: "function report() {\n  return 1;\n}", readLockOwner: lockOwner } });
  const found = detectorDiff(before, copied, new Set(["src/data.mjs"]));
  assert.deepEqual(codes(found).filter(code => code.startsWith("duplication")), ["duplication_introduced:src/data.mjs"]);
  assert.equal(found.find(finding => finding.code === "duplication_introduced").severity, "failure");
  assert.match(found.find(finding => finding.code === "duplication_introduced").message, /readLockOwner now has copies in 3 files/);
  const moved = side({ "src/store.mjs": { readLockOwner: lockOwner }, "src/facts.mjs": { readLockOwner: lockOwner }, "src/data.mjs": { report: "function report() {\n  return 1;\n}" } });
  const withTrace = side({ "src/trace.mjs": { readLockOwner: lockOwner }, "src/facts.mjs": { readLockOwner: lockOwner }, "src/data.mjs": { report: "function report() {\n  return 1;\n}" } });
  assert.deepEqual(codes(detectorDiff(withTrace, moved, new Set(["src/store.mjs", "src/trace.mjs"]))).filter(code => code.startsWith("duplication")), []);
  assert.deepEqual(detectorDiff(before, before, new Set(["src/facts.mjs"])).filter(finding => finding.code === "duplication_introduced"), []);
});

test("a unit that becomes complex in a changed file needs a review, and an unchanged complex unit does not", () => {
  const before = side({ "src/router.mjs": { route: "function route(event) {\n  return null;\n}" } });
  const after = side({ "src/router.mjs": { route: branchy } });
  const found = detectorDiff(before, after, new Set(["src/router.mjs"]));
  assert.ok(found.some(finding => finding.code === "complexity_introduced" && finding.severity === "review_required" && /route has 33 lines and 30 branches/.test(finding.message)));
  assert.deepEqual(detectorDiff(after, after, new Set(["src/router.mjs"])).filter(finding => finding.code === "complexity_introduced"), []);
});

// Each function calls the named operations through unresolved references, and filler functions make those operations rare.
function calls(files) {
  const result = side(Object.fromEntries(Object.entries(files).map(([file, functions]) => [file, Object.fromEntries(Object.keys(functions).map(name => [name, `function ${name}() {\n  return 1;\n}`]))])));
  const fillers = side(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/filler${index}.mjs`, { [`filler${index}`]: `function filler${index}() {\n  return 1;\n}` }])));
  result.index.units.push(...fillers.index.units);
  for (const [file, text] of fillers.contents) result.contents.set(file, text);
  result.index.unresolvedReferences = Object.entries(files).flatMap(([file, functions]) => Object.entries(functions).flatMap(([name, operations]) => operations.map(operation => ({ source: `${file}#${name}`, name: operation }))))
    .concat(fillers.index.units.map(unit => ({ source: unit.id, name: `own${unit.name}` })));
  return result;
}

test("a function that moves to another file keeps its dependency pairs, and a new pairing is reported", () => {
  const lock = ["openSync", "fstatSync", "renameSync", "linkSync"];
  const before = calls({ "src/trace.mjs": { lockTrace: lock }, "src/facts.mjs": { lockFacts: lock } });
  const moved = calls({ "src/shared.mjs": { lockTrace: lock }, "src/facts.mjs": { lockFacts: lock } });
  const added = calls({ "src/trace.mjs": { lockTrace: lock }, "src/facts.mjs": { lockFacts: lock }, "src/report.mjs": { summarize: lock } });
  const shared = findings => findings.filter(finding => finding.code === "shared_dependencies_introduced");
  assert.equal(shared(detectorDiff(before, added, new Set(["src/report.mjs"]))).length, 1);
  assert.deepEqual(shared(detectorDiff(before, moved, new Set(["src/shared.mjs", "src/trace.mjs"]))), []);
});
