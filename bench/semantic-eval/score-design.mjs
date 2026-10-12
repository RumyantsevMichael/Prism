// Score design-signal outputs against labeled design targets: how many targets appear in each detector's top results.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({ options: {
  targets: { type: "string" }, pairs: { type: "string" }, families: { type: "string" }, cohesion: { type: "string" }, groups: { type: "string" }, top: { type: "string", default: "20,50" },
} });
const targets = JSON.parse(readFileSync(options.targets, "utf8"));
const overlaps = (unit, location) => unit.file === location.file && unit.range.startLine <= location.endLine && location.startLine <= unit.range.endLine;
// A result touches a target when it names at least two of the target's locations, or one location for a single-location target.
const touched = (units, target) => {
  const hit = target.locations.filter(location => units.some(unit => overlaps(unit, location))).length;
  return hit >= Math.min(2, target.locations.length);
};
const detectors = {
  families: options.families && JSON.parse(readFileSync(options.families, "utf8")).map(entry => entry.units),
  pairs: options.pairs && JSON.parse(readFileSync(options.pairs, "utf8")).map(entry => entry.units),
  groups: options.groups && JSON.parse(readFileSync(options.groups, "utf8")).map(entry => entry.units),
  // A cohesion result is one container, so it touches a target when the container contains a target location.
  cohesion: options.cohesion && JSON.parse(readFileSync(options.cohesion, "utf8")).map(entry => [entry.container]),
};
for (const top of options.top.split(",").map(Number)) {
  const found = new Map(targets.map(target => [target.id, []]));
  for (const [name, results] of Object.entries(detectors)) if (results)
    for (const units of results.slice(0, top)) for (const target of targets) if (name === "cohesion" ? units.some(unit => target.locations.some(location => overlaps(unit, location))) && target.kind === "mixed responsibilities" : touched(units, target)) if (!found.get(target.id).includes(name)) found.get(target.id).push(name);
  console.log(`\ntop ${top}: ${[...found.values()].filter(list => list.length).length}/${targets.length} targets`);
  for (const target of targets) console.log(`  ${target.id.padEnd(4)} ${(found.get(target.id).join("+") || "-").padEnd(22)} ${target.kind.padEnd(26)} ${target.title.slice(0, 70)}`);
}
