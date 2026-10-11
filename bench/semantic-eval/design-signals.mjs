// Prototype design signals on a saved index with vectors: similar unit pairs across files, and cohesion clusters in classes and modules.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { isTestUnit, dependencyProfiles, sharedDependencyGroups } from "../../dist/server/repository-intelligence/shared-dependencies.mjs";
import { sharedLiteralGroups } from "../../dist/server/repository-intelligence/shared-literals.mjs";
import { cohesionReport } from "../../dist/server/repository-intelligence/cohesion.mjs";
import { benchStateDir } from "../state-dir.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: options } = parseArgs({ options: {
  index: { type: "string", default: path.join(benchStateDir(), "semantic-eval/index.json") },
  repo: { type: "string" },
  mode: { type: "string", default: "pairs" },
  show: { type: "string", default: "25" },
  "min-tokens": { type: "string", default: "80" },
  json: { type: "string" },
} });

const index = JSON.parse(readFileSync(options.index, "utf8"));
const repo = options.repo || path.join(path.dirname(options.index), "mirror");
const contentCache = new Map();
const content = file => { if (!contentCache.has(file)) { const full = path.join(repo, file); contentCache.set(file, existsSync(full) ? readFileSync(full, "utf8") : ""); } return contentCache.get(file); };
const contentMap = () => new Map([...new Set(index.units.map(unit => unit.file))].map(file => [file, content(file)]));
const byId = new Map(index.units.map(unit => [unit.id, unit]));
const production = unit => unit.domain === "code" && !isTestUnit(unit, content(unit.file));
const label = unit => `${unit.file}:${unit.range.startLine}-${unit.range.endLine} ${unit.selector || unit.qualifiedName || unit.name}`;

const place = unit => ({ file: unit.file, range: unit.range, selector: unit.selector || unit.qualifiedName || unit.name });
const result = options.mode === "pairs" || options.mode === "families" ? pairs() : options.mode === "groups" ? groups() : options.mode === "literals" ? literals() : cohesion();
if (options.json) writeFileSync(options.json, JSON.stringify(result));

// The existing shared dependency groups, as a baseline for recall.
function groups() {
  const { groups } = sharedDependencyGroups(index, { include: production, limit: 100 });
  for (const group of groups.slice(0, Number(options.show))) console.log(`\n## ${group.members.length} units share rare dependencies (weight ${group.weight}): ${group.dependencies.map(d => d.name).join(", ")}\n  ${group.members.map(m => `${m.file}:${m.range.startLine}-${m.range.endLine} ${m.selector} (share ${m.share})`).join("\n  ")}`);
  return groups.map(group => ({ units: group.members.map(member => ({ file: member.file, range: member.range, selector: member.selector })) }));
}

// Shared literals and cohesion clusters run the server analyses, so the benchmark measures the tool code.
function literals() {
  const { groups, coverage } = sharedLiteralGroups(index, contentMap(), { include: production, limit: 100 });
  console.log(JSON.stringify(coverage));
  for (const group of groups.slice(0, Number(options.show))) console.log(`\n## ${group.members.length} units spell the same rare literals: ${group.literals.map(literal => literal.name).join(", ")}\n  ${group.members.map(m => `${m.file}:${m.range.startLine}-${m.range.endLine} ${m.selector}`).join("\n  ")}`);
  return groups.map(group => ({ units: group.members.map(member => ({ file: member.file, range: member.range, selector: member.selector })) }));
}

function cohesion() {
  const { containers, coverage } = cohesionReport(index, contentMap(), { include: production });
  console.log(JSON.stringify(coverage));
  for (const entry of containers.slice(0, Number(options.show))) {
    console.log(`\n## ${entry.kind} ${entry.file} ${entry.name} lines=${entry.lines} members=${entry.members} clusters=${entry.clusters.length} separable=${entry.separableLines} modularity=${entry.modularity}`);
    for (const cluster of entry.clusters) console.log(`  ${cluster.lines}l ${cluster.members.length}m: ${cluster.members.map(member => member.selector.split("::").pop()).slice(0, 10).join(", ")} | state: ${cluster.state.slice(0, 8).join(", ")}`);
    console.log(`  + ${entry.smallClusters} small clusters`);
  }
  return containers.map(entry => ({ container: { file: entry.file, kind: entry.kind, name: entry.name, range: entry.range }, clusters: entry.clusters.length, lines: entry.lines }));
}

// Similar units: each unit's vector is the mean of its source fragment vectors, and a split unit also keeps the vector of each part.
function pairs() {
  const vectors = new Map(), parts = new Map(), tokens = new Map();
  for (const chunk of index.chunks) {
    if (chunk.role === "outline" || !chunk.embedding) continue;
    const vector = vectors.get(chunk.parentId);
    if (vector) for (let i = 0; i < vector.length; i++) vector[i] += chunk.embedding[i];
    else vectors.set(chunk.parentId, Float32Array.from(chunk.embedding));
    if (chunk.role === "part") (parts.get(chunk.parentId) || parts.set(chunk.parentId, []).get(chunk.parentId)).push(Float32Array.from(chunk.embedding));
    tokens.set(chunk.parentId, (tokens.get(chunk.parentId) || 0) + (chunk.tokens || 0));
  }
  const kinds = new Set(["function", "method", "class", "constant", "variable"]);
  const units = [...vectors.keys()].map(id => byId.get(id)).filter(unit => unit && kinds.has(unit.kind) && tokens.get(unit.id) >= 25 && production(unit));
  const normalize = vector => { const norm = Math.hypot(...vector); for (let i = 0; i < vector.length; i++) vector[i] /= norm; return vector; };
  for (const unit of units) { normalize(vectors.get(unit.id)); for (const part of parts.get(unit.id) || []) normalize(part); }
  const dot = (x, y) => { let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * y[i]; return sum; };
  const contains = (x, y) => x.file === y.file && x.span && y.span && x.span.start <= y.span.start && y.span.end <= x.span.end;
  // A caller and its callee, or a container and the view it renders, are related by design, not copies.
  const linked = new Set(index.edges.filter(edge => edge.kind !== "contains").flatMap(edge => [`${edge.source}\0${edge.target}`, `${edge.target}\0${edge.source}`]));
  // Two sides of a language boundary, such as a TypeScript IPC wrapper and its Rust command, are one interface.
  const language = unit => ({ ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js" })[unit.file.split(".").pop()] || unit.file.split(".").pop();
  const data = unit => unit.kind === "constant" || unit.kind === "variable";
  const profiles = dependencyProfiles(index, production);
  const copies = [], similar = [];
  for (let a = 0; a < units.length; a++) for (let b = a + 1; b < units.length; b++) {
    const x = units[a], y = units[b];
    if (contains(x, y) || contains(y, x) || linked.has(`${x.id}\0${y.id}`) || language(x) !== language(y)) continue;
    let score = dot(vectors.get(x.id), vectors.get(y.id));
    if (score >= 0.95) { copies.push({ a: x, b: y, score }); continue; }
    if (tokens.get(x.id) < 80 || tokens.get(y.id) < 80 || data(x) || data(y)) continue;
    // A part of a large unit can match a smaller unit that its whole vector does not match.
    for (const part of parts.get(x.id) || []) score = Math.max(score, dot(part, vectors.get(y.id)));
    for (const part of parts.get(y.id) || []) score = Math.max(score, dot(part, vectors.get(x.id)));
    if (score >= 0.85 && x.file !== y.file) similar.push({ a: x, b: y, score });
  }
  // Copies form families: every unit linked by a copy pair joins one family.
  const parent = new Map(), find = id => parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id));
  for (const { a, b } of copies) { for (const unit of [a, b]) if (!parent.has(unit.id)) parent.set(unit.id, unit.id); parent.set(find(a.id), find(b.id)); }
  const families = new Map();
  for (const id of parent.keys()) (families.get(find(id)) || families.set(find(id), []).get(find(id))).push(byId.get(id));
  // Rank families by the duplicated code: tokens of every copy after the first.
  // Copied data, such as style objects, carries less knowledge than copied logic, so it counts less.
  const rankedFamilies = [...families.values()].map(members => ({ members, files: new Set(members.map(unit => unit.file)).size, duplicated: Math.round((members.reduce((sum, unit) => sum + tokens.get(unit.id), 0) - Math.max(...members.map(unit => tokens.get(unit.id)))) * (members.every(data) ? 0.3 : 1)) }))
    .sort((x, y) => y.duplicated - x.duplicated);
  const familyOf = new Map(rankedFamilies.flatMap(family => family.members.map(unit => [unit.id, family])));
  // A file pair with many similar units is one finding, so group the similar pairs by file pair. Each unit appears in its best group only.
  const groups = new Map();
  for (const pair of similar.sort((x, y) => y.score - x.score)) {
    if (familyOf.has(pair.a.id) && familyOf.get(pair.a.id) === familyOf.get(pair.b.id)) continue;
    const key = [pair.a.file, pair.b.file].sort().join("\0");
    (groups.get(key) || groups.set(key, []).get(key)).push(pair);
  }
  // A unit can resemble several others, such as a third copy that diverged, but a generic unit should not fill the list.
  const used = new Map(), ranked = [], uses = id => used.get(id) || 0;
  for (const list of [...groups.values()].sort((x, y) => y[0].score - x[0].score)) {
    const kept = list.filter(pair => uses(pair.a.id) < 3 && uses(pair.b.id) < 3);
    if (!kept.length) continue;
    for (const pair of kept) { used.set(pair.a.id, uses(pair.a.id) + 1); used.set(pair.b.id, uses(pair.b.id) + 1); }
    ranked.push(kept);
  }
  const difference = (a, b) => {
    const pa = profiles.get(a.id) || new Set(), pb = profiles.get(b.id) || new Set();
    return `shared ${[...pa].filter(name => pb.has(name)).length} | only first: ${[...pa].filter(name => !pb.has(name)).slice(0, 8).join(", ")} | only second: ${[...pb].filter(name => !pa.has(name)).slice(0, 8).join(", ")}`;
  };
  console.log(JSON.stringify({ units: units.length, copyPairs: copies.length, families: rankedFamilies.length, similarPairs: similar.length, filePairs: ranked.length }));
  if (options.mode === "families") {
    for (const family of rankedFamilies.slice(0, Number(options.show))) {
      console.log(`\n## ${family.members.length} copies in ${family.files} files, ${family.duplicated} duplicated tokens`);
      for (const unit of family.members.slice(0, 6)) console.log(`  ${label(unit)} (${tokens.get(unit.id)}t)${unit.contentHash === family.members[0].contentHash ? "" : " DIFFERS"}`);
    }
    return rankedFamilies.map(family => ({ units: family.members.map(place) }));
  }
  for (const list of ranked.slice(0, Number(options.show))) {
    console.log(`\n## ${list[0].a.file} <-> ${list[0].b.file} (${list.length} pairs)`);
    for (const { a, b, score } of list.slice(0, 3)) console.log(`  ${score.toFixed(3)} ${label(a)} (${tokens.get(a.id)}t)\n        ${label(b)} (${tokens.get(b.id)}t)\n        ${difference(a, b)}`);
  }
  return ranked.map(list => ({ units: list.flatMap(pair => [place(pair.a), place(pair.b)]) }));
}
