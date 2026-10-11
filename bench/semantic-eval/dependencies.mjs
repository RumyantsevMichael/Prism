// Measure the shared dependency groups on a benchmark index with judged unit pairs.
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { sharedDependencyGroups, isTestFile } from "../../dist/server/repository-intelligence/shared-dependencies.mjs";
import { searchExclusion } from "../../dist/native-runtime/domains.mjs";
import { benchStateDir } from "../state-dir.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: options } = parseArgs({ options: {
  index: { type: "string", default: path.join(benchStateDir(), "semantic-eval/index.json") },
  pairs: { type: "string", default: path.join(here, "queries/prism-dependencies.json") },
  repo: { type: "string", default: path.resolve(here, "../..") },
  limit: { type: "string", default: "20,50" },
  show: { type: "string", default: "0" },
} });

const index = JSON.parse(readFileSync(options.index, "utf8"));
const content = file => existsSync(path.join(options.repo, file)) ? readFileSync(path.join(options.repo, file), "utf8") : "";
const include = unit => !isTestFile(unit.file) && !searchExclusion(unit.file, content(unit.file));
const pairs = JSON.parse(readFileSync(options.pairs, "utf8"));
const same = (member, unit) => member.file === unit.file && member.selector.split("::").pop() === unit.name;

for (const limit of options.limit.split(",").map(Number)) {
  const { groups, coverage } = sharedDependencyGroups(index, { include, limit });
  const together = pair => groups.some(group => group.members.some(member => same(member, pair.a)) && group.members.some(member => same(member, pair.b)));
  const rate = verdicts => { const list = pairs.filter(pair => verdicts.includes(pair.verdict)); return `${list.filter(together).length}/${list.length}`; };
  console.log(`groups=${groups.length} profiled=${coverage.profiledUnits}/${coverage.units} same ${rate(["same"])} related ${rate(["related"])} unrelated ${rate(["unrelated"])}`);
  if (Number(options.show)) for (const group of groups.slice(0, Number(options.show)))
    console.log(`  ${group.weight} [${group.dependencies.map(item => item.name).join(", ")}]\n    ${group.members.map(member => `${member.file}:${member.selector} (${member.share})`).join("\n    ")}`);
}
