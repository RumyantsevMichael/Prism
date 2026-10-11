// Prototype design signals on a saved index with vectors: similar unit pairs across files, and cohesion clusters in classes and modules.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { isTestUnit, dependencyProfiles, sharedDependencyGroups } from "../../dist/server/repository-intelligence/shared-dependencies.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: options } = parseArgs({ options: {
  index: { type: "string", default: path.join(here, ".work/index.json") },
  repo: { type: "string" },
  mode: { type: "string", default: "pairs" },
  show: { type: "string", default: "25" },
  "min-tokens": { type: "string", default: "80" },
  "min-lines": { type: "string", default: "120" },
  json: { type: "string" },
  container: { type: "string" },
  control: { type: "boolean", default: false },
} });

const index = JSON.parse(readFileSync(options.index, "utf8"));
const repo = options.repo || path.join(path.dirname(options.index), "mirror");
const contentCache = new Map();
const content = file => { if (!contentCache.has(file)) { const full = path.join(repo, file); contentCache.set(file, existsSync(full) ? readFileSync(full, "utf8") : ""); } return contentCache.get(file); };
const source = unit => unit.span ? content(unit.file).slice(unit.span.start, unit.span.end) : "";
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

// Shared literals: units in different files that spell the same rare set of identifier-like strings, such as ids, keys, method names, or paths.
// The grouping is the shared dependency grouping, with literals in place of callee names.
function literals() {
  const kinds = new Set(["function", "method", "constant", "variable", "class"]);
  const byFile = new Map();
  for (const unit of index.units) if (kinds.has(unit.kind) && unit.span && production(unit)) (byFile.get(unit.file) || byFile.set(unit.file, []).get(unit.file)).push(unit);
  // The grouping splits names at dots and colons, so the literal keeps them as look-alike characters.
  const encode = text => text.replace(/\./g, "\u2024").replace(/:/g, "\ua789").replace(/#/g, "\u266f"), decode = text => text.replace(/\u2024/g, ".").replace(/\ua789/g, ":").replace(/\u266f/g, "#");
  const references = [];
  for (const [file, units] of byFile) {
    const text = content(file);
    for (const match of text.matchAll(/(["'`])([A-Za-z_][\w.:\/-]{2,80})\1/g)) {
      // Module specifiers name files, not domain knowledge.
      const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
      if (/^\s*(import|export)\b|\brequire\(|\bimport\(/.test(line)) continue;
      // The innermost unit that covers the literal owns it.
      const owner = units.filter(unit => unit.span.start <= match.index && match.index < unit.span.end).sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0];
      if (owner) references.push({ source: owner.id, name: encode(match[2]), kind: "literal" });
    }
  }
  const synthetic = { units: index.units.map(unit => kinds.has(unit.kind) ? { ...unit, kind: "function" } : unit), edges: [], unresolvedReferences: references };
  const { groups } = sharedDependencyGroups(synthetic, { include: production, limit: 100 });
  console.log(JSON.stringify({ literals: references.length, groups: groups.length }));
  for (const group of groups.slice(0, Number(options.show))) console.log(`\n## ${group.members.length} units spell the same rare literals: ${group.dependencies.map(d => decode(d.name)).join(", ")}\n  ${group.members.map(m => `${m.file}:${m.range.startLine}-${m.range.endLine} ${m.selector}`).join("\n  ")}`);
  return groups.map(group => ({ units: group.members.map(member => ({ file: member.file, range: member.range, selector: member.selector })) }));
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

// Cohesion: link members that share state or call each other, and report large containers whose members fall into separate clusters.
function cohesion() {
  const containers = new Map();
  const add = (key, owner, member) => { const entry = containers.get(key) || containers.set(key, { owner, members: [] }).get(key); entry.members.push(member); };
  for (const unit of index.units) {
    if (!production(unit) || !["function", "method"].includes(unit.kind)) continue;
    const container = unit.containerId && byId.get(unit.containerId);
    if (unit.kind === "method" && container?.kind === "class") add(container.id, container, unit);
    // Rust and Go methods have no class container, so their type name groups them.
    else if (unit.kind === "method" && /::/.test(unit.qualifiedName || "")) add(`${unit.file}\0${unit.qualifiedName.split("::").slice(0, -1).join("::")}`, { file: unit.file, kind: "impl", name: unit.qualifiedName.split("::").slice(0, -1).join("::"), range: unit.range }, unit);
    else if (unit.kind === "function" && (!container || container.kind === "file")) add(`${unit.file}\0module`, { file: unit.file, kind: "module", name: path.basename(unit.file), range: { startLine: 1, endLine: content(unit.file).split("\n").length } }, unit);
  }
  // Module state: top-level variables and constants, by name, per file.
  const moduleState = new Map();
  for (const unit of index.units) if (["variable", "constant"].includes(unit.kind) && (!unit.containerId || byId.get(unit.containerId)?.kind === "file"))
    (moduleState.get(unit.file) || moduleState.set(unit.file, new Set()).get(unit.file)).add(unit.name);
  const calls = new Map();
  for (const edge of index.edges) if (edge.kind === "calls" || edge.kind === "references") (calls.get(edge.source) || calls.set(edge.source, new Set()).get(edge.source)).add(edge.target);
  const report = [];
  for (const { owner, members } of containers.values()) {
    const lines = owner.kind === "module" ? owner.range.endLine : owner.range.endLine - owner.range.startLine + 1;
    if (members.length < 6 || lines < Number(options["min-lines"])) continue;
    const memberIds = new Set(members.map(member => member.id)), names = new Set(members.map(member => member.name));
    const constructor = member => ["constructor", "__init__", "new", "default"].includes(member.name);
    const state = new Map();
    for (const member of members) {
      const text = source(member), used = new Set();
      if (owner.kind === "module") { for (const name of moduleState.get(member.file) || []) if (new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(text)) used.add(name); }
      else for (const match of text.matchAll(/\b(?:this|self)\.(#?\w+)/g)) if (!names.has(match[1])) used.add(match[1]);
      state.set(member.id, used);
    }
    // Each member uses items: state it reads or writes, and sibling members it calls. Members that share an item belong together.
    const active = members.filter(member => !constructor(member)), byName = new Map(active.map(member => [member.name, member]));
    const items = new Map(active.map(member => [member.id, new Set([`m:${member.name}`, ...[...state.get(member.id)].map(name => `f:${name}`)])]));
    for (const member of active) {
      for (const target of calls.get(member.id) || []) { const callee = byId.get(target); if (memberIds.has(target) && byName.get(callee.name) === callee) items.get(member.id).add(`m:${callee.name}`); }
      // A member also calls siblings by name through this or self, which the graph may not resolve.
      for (const match of source(member).matchAll(/\b(?:this|self)\.(#?\w+)\s*\(/g)) if (byName.has(match[1])) items.get(member.id).add(`m:${match[1]}`);
    }
    const size = member => member.range.endLine - member.range.startLine + 1;
    // Members that share a rare item are closely linked. An item that n members share adds 1/(n-1) to each of their pairs.
    const holders = new Map();
    active.forEach((member, position) => { for (const item of items.get(member.id)) (holders.get(item) || holders.set(item, []).get(item)).push(position); });
    const adjacency = active.map(() => new Map());
    for (const list of holders.values()) if (list.length >= 2) for (const i of list) for (const j of list) if (i !== j) adjacency[i].set(j, (adjacency[i].get(j) || 0) + 1 / (list.length - 1));
    const { communities, modularity } = louvain(adjacency);
    const groupsOf = new Map();
    communities.forEach((community, position) => (groupsOf.get(community) || groupsOf.set(community, []).get(community)).push(active[position]));
    const sized = [...groupsOf.values()].map(list => ({ members: list, lines: list.reduce((sum, member) => sum + size(member), 0) })).sort((a, b) => b.lines - a.lines);
    const hubs = new Set();
    const substantial = sized.filter(cluster => cluster.members.length >= 2 && cluster.lines >= 30);
    // Separable code is the code of every substantial cluster except the largest one.
    const separable = substantial.slice(1).reduce((sum, cluster) => sum + cluster.lines, 0);
    report.push({ owner, lines, members: members.length, hubs: [...hubs], clusters: sized, substantial: substantial.length, separable, modularity, state });
  }
  // Small modules with several helper clusters are common and rarely worth a split, so only large separable code counts.
  const flagged = entry => entry.substantial >= 2 && entry.modularity >= 0.3 && entry.separable >= 300;
  const ranked = report.filter(entry => options.container ? entry.owner.name === options.container : options.control ? !flagged(entry) : flagged(entry)).sort((a, b) => b.separable - a.separable || b.lines - a.lines);
  console.log(JSON.stringify({ containers: report.length, withSeparateClusters: ranked.length }));
  for (const entry of ranked.slice(0, Number(options.show))) {
    console.log(`\n## ${entry.owner.kind} ${entry.owner.file} ${entry.owner.name} lines=${entry.lines} members=${entry.members} hubs=[${entry.hubs.join(", ")}] clusters=${entry.substantial} separable=${entry.separable} modularity=${entry.modularity.toFixed(2)}`);
    for (const cluster of entry.clusters.filter(c => c.members.length >= 2 && c.lines >= 30).slice(0, 6)) {
      const fields = new Set(cluster.members.flatMap(member => [...entry.state.get(member.id)].filter(name => !entry.hubs.includes(`f:${name}`))));
      console.log(`  ${cluster.lines}l ${cluster.members.length}m: ${cluster.members.map(member => member.name).slice(0, 10).join(", ")} | state: ${[...fields].slice(0, 8).join(", ")}`);
    }
    const singles = entry.clusters.filter(c => c.members.length < 2 || c.lines < 30);
    console.log(`  + ${singles.length} small clusters`);
  }
  return ranked.map(entry => ({ container: { file: entry.owner.file, kind: entry.owner.kind, name: entry.owner.name, range: entry.owner.kind === "module" ? { startLine: 1, endLine: entry.lines } : entry.owner.range }, clusters: entry.substantial, lines: entry.lines }));
}

// Louvain community detection on a weighted undirected graph given as adjacency maps. It returns a community per node and the modularity.
function louvain(adjacency) {
  let graph = adjacency.map(map => new Map(map)), mapping = adjacency.map((_, node) => node);
  const degree = graph => graph.map(map => [...map.values()].reduce((sum, weight) => sum + weight, 0));
  const total = degree(adjacency).reduce((sum, value) => sum + value, 0);
  if (!total) return { communities: mapping, modularity: 0 };
  for (;;) {
    const deg = degree(graph), community = graph.map((_, node) => node), sums = [...deg];
    let moved = false, improved = true;
    while (improved) {
      improved = false;
      for (let node = 0; node < graph.length; node++) {
        const own = community[node], links = new Map();
        for (const [other, weight] of graph[node]) if (other !== node) links.set(community[other], (links.get(community[other]) || 0) + weight);
        sums[own] -= deg[node];
        let best = own, gain = (links.get(own) || 0) - sums[own] * deg[node] / total;
        for (const [candidate, weight] of links) { const value = weight - sums[candidate] * deg[node] / total; if (value > gain + 1e-12) { gain = value; best = candidate; } }
        sums[best] += deg[node];
        if (best !== own) { community[node] = best; improved = moved = true; }
      }
    }
    if (!moved) break;
    // Merge each community into one node and repeat on the smaller graph.
    const ids = new Map([...new Set(community)].map((value, position) => [value, position]));
    const next = [...ids.keys()].map(() => new Map());
    graph.forEach((map, node) => { for (const [other, weight] of map) { const a = ids.get(community[node]), b = ids.get(community[other]); next[a].set(b, (next[a].get(b) || 0) + weight); } });
    mapping = mapping.map(node => ids.get(community[node]));
    graph = next;
  }
  // Modularity: the share of link weight inside communities, minus the share that random links with the same degrees would give.
  const deg = degree(adjacency), inside = new Map(), sums = new Map();
  adjacency.forEach((map, node) => { sums.set(mapping[node], (sums.get(mapping[node]) || 0) + deg[node]); for (const [other, weight] of map) if (mapping[other] === mapping[node]) inside.set(mapping[node], (inside.get(mapping[node]) || 0) + weight); });
  let modularity = 0;
  for (const [community, sum] of sums) modularity += (inside.get(community) || 0) / total - (sum / total) ** 2;
  return { communities: mapping, modularity };
}
