// Probe: can the pinned code graph SDK update a kept graph database for changed files only?
// Usage: node graph-sync.mjs <native runtime folder> <scratch folder>
// It indexes a generated tree of TypeScript files, changes one file, syncs only that path, and prints what each step touched and how long it took.
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
const [runtime, scratch] = process.argv.slice(2);
const require = createRequire(path.join(runtime, "worker.mjs"));
const sdk = require("@colbymchenry/codegraph");
const mirror = path.join(scratch, "mirror");
await rm(mirror, { recursive: true, force: true });
await mkdir(path.join(mirror, "src"), { recursive: true });
const FILES = 400;
const body = (index, extra = "") => `import { helper${(index + 1) % FILES} } from "./file${(index + 1) % FILES}";\nexport function helper${index}(value: number): number {\n  ${extra}return helper${(index + 1) % FILES}(value) + ${index};\n}\n`;
for (let index = 0; index < FILES; index++) await writeFile(path.join(mirror, "src", `file${index}.ts`), body(index));
const count = graph => { const connection = sdk.DatabaseConnection.open(sdk.getDatabasePath(mirror)); const queries = new sdk.QueryBuilder(connection.getDb()); const result = { files: queries.getAllFiles().length, nodes: queries.getAllNodes().length }; connection.close(); return result; };
let started = performance.now();
let graph = await sdk.CodeGraph.init(mirror, { index: false });
const full = await graph.indexAll({});
await graph.close();
console.log(JSON.stringify({ step: "indexAll", success: full.success, ms: Math.round(performance.now() - started), ...count() }));
await writeFile(path.join(mirror, "src", "file7.ts"), body(7, "const extra = helper3(value);\n  "));
await writeFile(path.join(mirror, "src", "added.ts"), "export function addedHelper(): number { return 1; }\n");
await rm(path.join(mirror, "src", "file9.ts"));
started = performance.now();
graph = await sdk.CodeGraph.open(mirror, { sync: false });
const synced = await graph.sync({ paths: ["src/file7.ts", "src/added.ts", "src/file9.ts"] });
await graph.close();
console.log(JSON.stringify({ step: "sync(paths)", ms: Math.round(performance.now() - started), filesChecked: synced.filesChecked, filesAdded: synced.filesAdded, filesModified: synced.filesModified, filesRemoved: synced.filesRemoved, ...count() }));
started = performance.now();
graph = await sdk.CodeGraph.open(mirror, { sync: false });
const swept = await graph.sync({});
await graph.close();
console.log(JSON.stringify({ step: "sync()", ms: Math.round(performance.now() - started), filesChecked: swept.filesChecked, filesAdded: swept.filesAdded, filesModified: swept.filesModified, filesRemoved: swept.filesRemoved, ...count() }));
