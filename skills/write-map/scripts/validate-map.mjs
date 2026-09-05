import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const statuses = new Set(["not-started", "in-progress", "blocked", "deferred", "done", "split"]);
const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const declaration = new RegExp('^state (' + quoted + ') as (s_[0-9a-f]+) <<([a-z-]+)>>( \\{)?$');
const requirement = new RegExp('^(s_[0-9a-f]+) : requires (' + quoted + ')$');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function slugFor(alias) {
  const hex = alias.slice(2);
  const slug = Buffer.from(hex, "hex").toString("utf8");
  requireCondition(/^[A-Za-z0-9_-]+$/.test(slug) && Buffer.from(slug).toString("hex") === hex, "Invalid slice alias");
  return slug;
}

export function parseMap(source) {
  const lines = source.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  requireCondition(lines.shift() === "@startuml" && lines.pop() === "@enduml", "Expected one PlantUML diagram");
  requireCondition(/^title Initiative: [A-Za-z0-9_-]+$/.test(lines.shift()), "Invalid initiative title");
  requireCondition(lines.shift() === "hide empty description", "Missing map header");
  const slices = Object.create(null);
  const stack = [];
  const requirements = [];
  const edges = [];
  for (const line of lines) {
    let match;
    if ((match = declaration.exec(line))) {
      const [, titleJson, alias, status, opens] = match;
      const slug = slugFor(alias);
      const title = JSON.parse(titleJson);
      requireCondition(!Object.hasOwn(slices, slug), "Duplicate slice");
      requireCondition(typeof title === "string" && title.trim().length > 0 && !/[\r\n]/.test(title), "Invalid slice title");
      requireCondition(statuses.has(status), "Invalid slice status");
      slices[slug] = { title, status, parent: stack.at(-1) ?? null, requirements: [], dependencies: [] };
      if (opens) stack.push(slug);
    } else if (line === "}") {
      requireCondition(stack.length > 0, "Unexpected closing brace");
      stack.pop();
    } else if ((match = requirement.exec(line))) {
      requireCondition(stack.length === 0, "Requirements must follow state declarations");
      requirements.push([slugFor(match[1]), JSON.parse(match[2])]);
    } else if ((match = /^(s_[0-9a-f]+) --> (s_[0-9a-f]+) : depends on$/.exec(line))) {
      requireCondition(stack.length === 0, "Dependencies must follow state declarations");
      edges.push([slugFor(match[1]), slugFor(match[2])]);
    } else {
      throw new Error("Unsupported map syntax: " + line);
    }
  }
  requireCondition(stack.length === 0, "Unclosed state");
  const roots = Object.keys(slices).filter((slug) => slices[slug].parent === null);
  requireCondition(roots.length === 1, "Expected exactly one root");
  for (const [slug, ref] of requirements) {
    requireCondition(Object.hasOwn(slices, slug), "Unknown requirement owner");
    requireCondition(typeof ref === "string" && /^[^\s#]+#[^\s#]+$/.test(ref), "Invalid requirement reference");
    requireCondition(!slices[slug].requirements.includes(ref), "Duplicate requirement assignment");
    slices[slug].requirements.push(ref);
  }
  for (const [from, to] of edges) {
    requireCondition(Object.hasOwn(slices, from) && Object.hasOwn(slices, to), "Unknown dependency target");
    requireCondition(!slices[from].dependencies.includes(to), "Duplicate dependency");
    slices[from].dependencies.push(to);
  }
  const children = (slug) => Object.keys(slices).filter((key) => slices[key].parent === slug);
  const leaves = (slug) => children(slug).length ? children(slug).flatMap(leaves) : [slug];
  for (const [slug, slice] of Object.entries(slices)) {
    requireCondition(slice.requirements.length > 0, "Missing requirement assignment");
    const childIds = children(slug);
    requireCondition((slice.status === "split") === (childIds.length > 0), "Split status must match children");
    if (childIds.length) {
      const assigned = new Set(childIds.flatMap((child) => slices[child].requirements));
      requireCondition(assigned.size === slice.requirements.length && slice.requirements.every((ref) => assigned.has(ref)), "Incomplete child coverage");
    }
  }
  const effectiveDependencies = {};
  for (const slug of leaves(roots[0])) {
    const targets = new Set();
    for (let owner = slug; owner !== null; owner = slices[owner].parent) {
      for (const dependency of slices[owner].dependencies) {
        for (const target of leaves(dependency)) targets.add(target);
      }
    }
    requireCondition(!targets.has(slug), "Expanded self-dependency");
    effectiveDependencies[slug] = [...targets].sort();
  }
  const visited = new Set();
  const active = new Set();
  function visit(slug) {
    requireCondition(!active.has(slug), "Expanded dependency cycle");
    if (visited.has(slug)) return;
    active.add(slug);
    effectiveDependencies[slug].forEach(visit);
    active.delete(slug);
    visited.add(slug);
  }
  Object.keys(effectiveDependencies).forEach(visit);
  const complete = Object.fromEntries(Object.keys(slices).map((slug) => [slug, leaves(slug).every((leaf) => slices[leaf].status === "done")]));
  return {
    root: roots[0], slices, effectiveDependencies, complete,
    designCandidates: leaves(roots[0]).filter((slug) => slices[slug].status === "not-started").sort(),
    dependenciesComplete: Object.keys(effectiveDependencies).filter((slug) => effectiveDependencies[slug].every((target) => complete[target])).sort()
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireCondition(process.argv.length === 3, "Usage: validate-map.mjs <map.puml>");
    console.log(JSON.stringify(parseMap(await readFile(process.argv[2], "utf8")), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
