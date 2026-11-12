// Generated from src/server/repository-intelligence/cohesion.mts by scripts/native-build/compile.mjs.
import path from "node:path";
const MIN_MEMBERS = 6, MIN_LINES = 120, MIN_CLUSTER_LINES = 30, MIN_SEPARABLE_LINES = 300, MIN_MODULARITY = 0.3;
const CONSTRUCTORS = /* @__PURE__ */ new Set(["constructor", "__init__", "new", "default"]);
const STATE = /\b(?:this|self)\.(#?\w+)/g, SELF_CALL = /\b(?:this|self)\.(#?\w+)\s*\(/g;
const lineCount = (range) => range.endLine - range.startLine + 1;
const selector = (unit) => unit.selector || unit.qualifiedName || unit.name;
function containersOf(index, contents, include) {
  const byId = new Map(index.units.map((unit) => [unit.id, unit]));
  const containers = /* @__PURE__ */ new Map();
  const add = (key, owner, member) => (containers.get(key) || containers.set(key, { ...owner, members: [] }).get(key)).members.push(member);
  for (const unit of index.units) {
    if (!["function", "method"].includes(unit.kind) || !include(unit)) continue;
    const container = unit.containerId ? byId.get(unit.containerId) : void 0;
    if (unit.kind === "method" && container?.kind === "class") add(container.id, { file: container.file, kind: "class", name: container.name, range: container.range }, unit);
    else if (unit.kind === "method" && unit.qualifiedName?.includes("::")) {
      const type = unit.qualifiedName.split("::").slice(0, -1).join("::");
      add(`${unit.file}\0${type}`, { file: unit.file, kind: "type", name: type, range: unit.range }, unit);
    } else if (unit.kind === "function" && (!container || container.kind === "file"))
      add(`${unit.file}\0`, { file: unit.file, kind: "module", name: path.posix.basename(unit.file), range: { startLine: 1, endLine: (contents.get(unit.file) || "").split("\n").length } }, unit);
  }
  for (const container of containers.values()) if (container.kind === "type")
    container.range = { startLine: Math.min(...container.members.map((member) => member.range.startLine)), endLine: Math.max(...container.members.map((member) => member.range.endLine)) };
  return containers;
}
function cohesionReport(index, contents, options = {}) {
  const include = options.include || (() => true);
  const byId = new Map(index.units.map((unit) => [unit.id, unit]));
  const moduleState = /* @__PURE__ */ new Map();
  for (const unit of index.units) if (["variable", "constant"].includes(unit.kind) && (!unit.containerId || byId.get(unit.containerId)?.kind === "file"))
    (moduleState.get(unit.file) || moduleState.set(unit.file, /* @__PURE__ */ new Set()).get(unit.file)).add(unit.name);
  const calls = /* @__PURE__ */ new Map();
  for (const edge of index.edges) if (edge.kind === "calls" || edge.kind === "references") (calls.get(edge.source) || calls.set(edge.source, /* @__PURE__ */ new Set()).get(edge.source)).add(edge.target);
  const source = (unit) => unit.span ? (contents.get(unit.file) || "").slice(unit.span.start, unit.span.end) : "";
  const reported = [];
  let examined = 0;
  for (const container of containersOf(index, contents, include).values()) {
    const lines = lineCount(container.range);
    if (container.members.length < MIN_MEMBERS || lines < MIN_LINES) continue;
    examined++;
    const members = container.members.filter((member) => !CONSTRUCTORS.has(member.name));
    const byName = new Map(members.map((member) => [member.name, member])), ids = new Set(members.map((member) => member.id));
    const state = /* @__PURE__ */ new Map(), items = /* @__PURE__ */ new Map();
    for (const member of members) {
      const text = source(member), used = /* @__PURE__ */ new Set();
      if (container.kind === "module") {
        const names = moduleState.get(member.file) || /* @__PURE__ */ new Set();
        for (const word of text.match(/[A-Za-z_$][\w$]*/g) || []) if (names.has(word)) used.add(word);
      } else for (const match of text.matchAll(STATE)) if (!byName.has(match[1])) used.add(match[1]);
      state.set(member.id, used);
      const own = /* @__PURE__ */ new Set([`member:${member.name}`, ...[...used].map((name) => `state:${name}`)]);
      for (const target of calls.get(member.id) || []) if (ids.has(target)) own.add(`member:${byId.get(target).name}`);
      for (const match of text.matchAll(SELF_CALL)) if (byName.has(match[1])) own.add(`member:${match[1]}`);
      items.set(member.id, own);
    }
    const holders = /* @__PURE__ */ new Map();
    members.forEach((member, position) => {
      for (const item of items.get(member.id)) (holders.get(item) || holders.set(item, []).get(item)).push(position);
    });
    const adjacency = members.map(() => /* @__PURE__ */ new Map());
    for (const list of holders.values()) if (list.length >= 2) {
      for (const i of list) for (const j of list) if (i !== j) adjacency[i].set(j, (adjacency[i].get(j) || 0) + 1 / (list.length - 1));
    }
    const { communities, modularity } = louvain(adjacency);
    const grouped = /* @__PURE__ */ new Map();
    communities.forEach((community, position) => (grouped.get(community) || grouped.set(community, []).get(community)).push(members[position]));
    const clusters = [...grouped.values()].map((list) => ({ list, lines: list.reduce((sum, member) => sum + lineCount(member.range), 0) })).sort((a, b) => b.lines - a.lines);
    const substantial = clusters.filter((cluster) => cluster.list.length >= 2 && cluster.lines >= MIN_CLUSTER_LINES);
    const separableLines = substantial.slice(1).reduce((sum, cluster) => sum + cluster.lines, 0);
    if (substantial.length < 2 || modularity < MIN_MODULARITY || separableLines < MIN_SEPARABLE_LINES) continue;
    reported.push({
      file: container.file,
      kind: container.kind,
      name: container.name,
      range: container.range,
      lines,
      members: container.members.length,
      modularity: Number(modularity.toFixed(2)),
      separableLines,
      clusters: substantial.slice(0, 8).map((cluster) => ({
        lines: cluster.lines,
        members: cluster.list.slice(0, 40).map((member) => ({ selector: selector(member), range: member.range })),
        state: [...new Set(cluster.list.flatMap((member) => [...state.get(member.id)]))].slice(0, 12)
      })),
      smallClusters: clusters.length - Math.min(substantial.length, 8)
    });
  }
  reported.sort((a, b) => b.separableLines - a.separableLines || b.lines - a.lines || a.file.localeCompare(b.file));
  return { containers: reported, coverage: { examinedContainers: examined, reportedContainers: reported.length } };
}
function louvain(adjacency) {
  const degree = (graph2) => graph2.map((map) => [...map.values()].reduce((sum, weight) => sum + weight, 0));
  const total = degree(adjacency).reduce((sum, value) => sum + value, 0);
  let graph = adjacency.map((map) => new Map(map)), mapping = adjacency.map((_, node) => node);
  if (!total) return { communities: mapping, modularity: 0 };
  for (let level = 0; level < 32; level++) {
    const weights2 = degree(graph), community = graph.map((_, node) => node), sums2 = [...weights2];
    let moved = false, improved = true;
    while (improved) {
      improved = false;
      for (let node = 0; node < graph.length; node++) {
        const own = community[node], links = /* @__PURE__ */ new Map();
        for (const [other, weight] of graph[node]) if (other !== node) links.set(community[other], (links.get(community[other]) || 0) + weight);
        sums2[own] -= weights2[node];
        let best = own, gain = (links.get(own) || 0) - sums2[own] * weights2[node] / total;
        for (const [candidate, weight] of links) {
          const value = weight - sums2[candidate] * weights2[node] / total;
          if (value > gain + 1e-12) {
            gain = value;
            best = candidate;
          }
        }
        sums2[best] += weights2[node];
        if (best !== own) {
          community[node] = best;
          improved = moved = true;
        }
      }
    }
    if (!moved) break;
    const ids = new Map([...new Set(community)].map((value, position) => [value, position]));
    const next = [...ids.keys()].map(() => /* @__PURE__ */ new Map());
    graph.forEach((map, node) => {
      for (const [other, weight] of map) {
        const a = ids.get(community[node]), b = ids.get(community[other]);
        next[a].set(b, (next[a].get(b) || 0) + weight);
      }
    });
    mapping = mapping.map((node) => ids.get(community[node]));
    graph = next;
  }
  const weights = degree(adjacency), inside = /* @__PURE__ */ new Map(), sums = /* @__PURE__ */ new Map();
  adjacency.forEach((map, node) => {
    sums.set(mapping[node], (sums.get(mapping[node]) || 0) + weights[node]);
    for (const [other, weight] of map) if (mapping[other] === mapping[node]) inside.set(mapping[node], (inside.get(mapping[node]) || 0) + weight);
  });
  let modularity = 0;
  for (const [community, sum] of sums) modularity += (inside.get(community) || 0) / total - (sum / total) ** 2;
  return { communities: mapping, modularity };
}
export {
  cohesionReport,
  louvain
};
