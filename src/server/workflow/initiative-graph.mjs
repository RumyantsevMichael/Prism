// Slice-graph invariants for initiative records, ported from the former write-map validator so the server enforces them on every write.
export const LEAF_STATUSES = Object.freeze(["not-started", "in-progress", "blocked", "deferred", "done"]);
export const SLICE_STATUSES = Object.freeze([...LEAF_STATUSES, "split"]);
export const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;
export const REQUIREMENT_PATTERN = /^[^\s#]+#[^\s#]+$/;

export class InitiativeGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = "InitiativeGraphError";
    this.code = "invalid_initiative";
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new InitiativeGraphError(message);
}

function copySlices(input) {
  const slices = Object.create(null);
  for (const [slug, slice] of Object.entries(input ?? {})) {
    slices[slug] = {
      title: slice.title,
      ...(slice.outcome === undefined ? {} : { outcome: slice.outcome }),
      status: slice.status,
      parent: slice.parent ?? null,
      requirements: [...(slice.requirements ?? [])],
      dependencies: [...(slice.dependencies ?? [])]
    };
  }
  return slices;
}

export function analyzeInitiative(input) {
  const slices = copySlices(input);
  const slugs = Object.keys(slices);
  requireCondition(slugs.length > 0, "Expected exactly one root");
  for (const slug of slugs) {
    const slice = slices[slug];
    requireCondition(SLUG_PATTERN.test(slug), "Invalid slice slug");
    requireCondition(typeof slice.title === "string" && slice.title.trim().length > 0 && !/[\r\n]/.test(slice.title), "Invalid slice title");
    requireCondition(slice.outcome === undefined || (typeof slice.outcome === "string" && !/[\r\n]/.test(slice.outcome)), "Invalid slice outcome");
    requireCondition(SLICE_STATUSES.includes(slice.status), "Invalid slice status");
    requireCondition(slice.parent === null || Object.hasOwn(slices, slice.parent), "Unknown parent slice");
    requireCondition(slice.parent !== slug, "A slice cannot be its own parent");
  }
  const roots = slugs.filter((slug) => slices[slug].parent === null);
  requireCondition(roots.length === 1, "Expected exactly one root");
  for (const slug of slugs) {
    const slice = slices[slug];
    requireCondition(slice.requirements.length > 0, "Missing requirement assignment");
    requireCondition(new Set(slice.requirements).size === slice.requirements.length, "Duplicate requirement assignment");
    for (const reference of slice.requirements) requireCondition(typeof reference === "string" && REQUIREMENT_PATTERN.test(reference), "Invalid requirement reference");
    requireCondition(new Set(slice.dependencies).size === slice.dependencies.length, "Duplicate dependency");
    for (const target of slice.dependencies) requireCondition(typeof target === "string" && Object.hasOwn(slices, target), "Unknown dependency target");
  }
  const childrenOf = Object.create(null);
  for (const slug of slugs) childrenOf[slug] = [];
  for (const slug of slugs) if (slices[slug].parent !== null) childrenOf[slices[slug].parent].push(slug);
  // A parent chain that never reaches the root is a cycle, which a single-root check alone cannot see.
  for (const slug of slugs) {
    const seen = new Set();
    for (let owner = slug; owner !== null; owner = slices[owner].parent) {
      requireCondition(!seen.has(owner), "Parent cycle");
      seen.add(owner);
    }
  }
  const leaves = (slug) => childrenOf[slug].length ? childrenOf[slug].flatMap(leaves) : [slug];
  for (const slug of slugs) {
    const slice = slices[slug];
    const children = childrenOf[slug];
    requireCondition((slice.status === "split") === (children.length > 0), "Split status must match children");
    if (children.length) {
      const assigned = new Set(children.flatMap((child) => slices[child].requirements));
      requireCondition(assigned.size === slice.requirements.length && slice.requirements.every((reference) => assigned.has(reference)), "Incomplete child coverage");
    }
  }
  const root = roots[0];
  const effectiveDependencies = {};
  for (const slug of leaves(root)) {
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
  const visit = (slug) => {
    requireCondition(!active.has(slug), "Expanded dependency cycle");
    if (visited.has(slug)) return;
    active.add(slug);
    effectiveDependencies[slug].forEach(visit);
    active.delete(slug);
    visited.add(slug);
  };
  Object.keys(effectiveDependencies).forEach(visit);
  const complete = Object.fromEntries(slugs.map((slug) => [slug, leaves(slug).every((leaf) => slices[leaf].status === "done")]));
  const leafSlugs = leaves(root).sort();
  const counts = Object.fromEntries(LEAF_STATUSES.map((status) => [status, leafSlugs.filter((slug) => slices[slug].status === status).length]));
  return {
    root,
    slices,
    children: Object.fromEntries(slugs.map((slug) => [slug, [...childrenOf[slug]].sort()])),
    leaves: leafSlugs,
    counts,
    effectiveDependencies,
    complete,
    designCandidates: leafSlugs.filter((slug) => slices[slug].status === "not-started"),
    dependenciesComplete: Object.keys(effectiveDependencies).filter((slug) => effectiveDependencies[slug].every((target) => complete[target])).sort()
  };
}

const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const declaration = new RegExp('^state (' + quoted + ') as (s_[0-9a-f]+) <<([a-z-]+)>>( \\{)?$');
const requirementLine = new RegExp('^(s_[0-9a-f]+) : requires (' + quoted + ')$');

function slugFor(alias) {
  const hex = alias.slice(2);
  const slug = Buffer.from(hex, "hex").toString("utf8");
  requireCondition(SLUG_PATTERN.test(slug) && Buffer.from(slug).toString("hex") === hex, "Invalid slice alias");
  return slug;
}

// Reads the retired map.puml grammar exactly, so legacy maps import deterministically.
export function parseLegacyMap(source) {
  const lines = source.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  requireCondition(lines.shift() === "@startuml" && lines.pop() === "@enduml", "Expected one PlantUML diagram");
  const title = /^title Initiative: ([A-Za-z0-9_-]+)$/.exec(lines.shift() ?? "");
  requireCondition(title, "Invalid initiative title");
  requireCondition(lines.shift() === "hide empty description", "Missing map header");
  const slices = Object.create(null);
  const stack = [];
  for (const line of lines) {
    let match;
    if ((match = declaration.exec(line))) {
      const [, titleJson, alias, status, opens] = match;
      const slug = slugFor(alias);
      requireCondition(!Object.hasOwn(slices, slug), "Duplicate slice");
      slices[slug] = { title: JSON.parse(titleJson), status, parent: stack.at(-1) ?? null, requirements: [], dependencies: [] };
      if (opens) stack.push(slug);
    } else if (line === "}") {
      requireCondition(stack.length > 0, "Unexpected closing brace");
      stack.pop();
    } else if ((match = requirementLine.exec(line))) {
      requireCondition(stack.length === 0, "Requirements must follow state declarations");
      const slug = slugFor(match[1]);
      requireCondition(Object.hasOwn(slices, slug), "Unknown requirement owner");
      slices[slug].requirements.push(JSON.parse(match[2]));
    } else if ((match = /^(s_[0-9a-f]+) --> (s_[0-9a-f]+) : depends on$/.exec(line))) {
      requireCondition(stack.length === 0, "Dependencies must follow state declarations");
      const from = slugFor(match[1]);
      requireCondition(Object.hasOwn(slices, from), "Unknown dependency target");
      slices[from].dependencies.push(slugFor(match[2]));
    } else {
      throw new InitiativeGraphError("Unsupported map syntax: " + line);
    }
  }
  requireCondition(stack.length === 0, "Unclosed state");
  return { id: title[1], slices: { ...analyzeInitiative(slices).slices } };
}
