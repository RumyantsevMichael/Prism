// Print the module interface report for a saved index and a repository checkout.
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";
import { moduleInterfaceReport } from "../../dist/server/repository-intelligence/module-interfaces.mjs";
import { benchStateDir } from "../state-dir.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: options } = parseArgs({ options: {
  index: { type: "string", default: path.join(benchStateDir(), "semantic-eval/index.json") },
  repo: { type: "string", default: path.resolve(here, "../..") },
  show: { type: "string", default: "10" },
} });

const index = JSON.parse(readFileSync(options.index, "utf8"));
const contents = new Map();
// The server reads every snapshot file, so the report also sees imports in files that the index does not parse.
for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: options.repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean)) {
  const absolute = path.join(options.repo, file);
  try { if (statSync(absolute).size > 2 * 1024 * 1024) continue; contents.set(file, readFileSync(absolute, "utf8")); } catch {}
}
const report = moduleInterfaceReport(index, contents);
const unused = report.modules.reduce((sum, module) => sum + module.unusedExports.length, 0), testOnly = report.modules.reduce((sum, module) => sum + module.testOnlyExports.length, 0);
console.log(JSON.stringify({ ...report.coverage, unresolvedSamples: report.coverage.unresolvedSamples.slice(0, 5), modulesWithFindings: report.modules.length, unusedExports: unused, testOnlyExports: testOnly, delegatingClasses: report.delegatingClasses.length }, null, 1));
for (const module of report.modules.slice(0, Number(options.show)))
  console.log(`${module.file} importers=${module.importers}+${module.testImporters} unused=[${module.unusedExports.join(", ")}] testOnly=[${module.testOnlyExports.join(", ")}]`);
for (const item of report.delegatingClasses) console.log(`delegates ${item.forwarding}/${item.publicMethods} to ${item.delegate} (unchanged ${item.unchangedNames}): ${item.file}:${item.selector}`);
