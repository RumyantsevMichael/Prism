const REQUIRED_PROVIDER_METHODS = ["describe", "search", "neighbors", "read"];
const TIER_ORDER = new Map([["mustRead", 0], ["likelyRead", 1], ["possibleRead", 2]]);
const MUST_RELATIONSHIPS = new Set(["definition", "implementation", "implements", "extends", "overrides"]);
const LIKELY_RELATIONSHIPS = new Set(["caller", "callee", "calls", "reference", "tests", "type-dependency", "uses-type"]);
const HINT_KEYS = ["files", "symbols", "concepts", "expectedModifiedFiles"];

export const REPOSITORY_CONTEXT_INPUT_LIMITS = Object.freeze({
  taskCharacters: 16384,
  hintsPerKind: 32,
  hintCharacters: 1024
});

export const approximateTokenCounter = Object.freeze({
  name: "utf8-bytes-divided-by-3",
  exact: false,
  count(value) {
    return Math.ceil(Buffer.byteLength(String(value), "utf8") / 3);
  }
});

function assertProvider(provider) {
  const missing = REQUIRED_PROVIDER_METHODS.filter((name) => typeof provider?.[name] !== "function");
  if (missing.length) {
    throw new TypeError("A repository-intelligence provider must implement describe, search, neighbors, and read.");
  }
}

function exceedsCharacterLimit(value, limit) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function validateInputs(task, hints) {
  if (typeof task !== "string" || !task.trim()) {
    throw new TypeError("The repository-context task must be a non-empty string.");
  }
  if (exceedsCharacterLimit(task, REPOSITORY_CONTEXT_INPUT_LIMITS.taskCharacters)) {
    throw new TypeError(`The repository-context task must contain at most ${REPOSITORY_CONTEXT_INPUT_LIMITS.taskCharacters} characters.`);
  }
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) {
    throw new TypeError("Repository-context hints must be an object.");
  }
  const unknown = Object.keys(hints).filter((name) => !HINT_KEYS.includes(name));
  if (unknown.length) {
    throw new TypeError(`Unknown repository-context hint: ${unknown[0]}.`);
  }
  for (const name of HINT_KEYS) {
    const values = hints[name];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TypeError(`Repository-context ${name} hints must be an array.`);
    }
    if (values.length > REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind) {
      throw new TypeError(`Repository-context ${name} must contain at most ${REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind} entries.`);
    }
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) {
        throw new TypeError(`Repository-context ${name} entries must be non-empty strings.`);
      }
      if (exceedsCharacterLimit(value, REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters)) {
        throw new TypeError(`Repository-context ${name} entries must contain at most ${REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters} characters.`);
      }
    }
  }
}

function integer(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeRange(range) {
  const startLine = integer(range?.startLine, 1);
  const endLine = Math.max(startLine, integer(range?.endLine, startLine));
  return { startLine, endLine };
}

function validRange(range) {
  return Number.isInteger(range?.startLine) && range.startLine > 0 && Number.isInteger(range?.endLine) && range.endLine >= range.startLine;
}

function normalizeNode(node) {
  if (!node || typeof node !== "object" || typeof node.file !== "string" || !node.file) {
    throw new TypeError("Repository context nodes must include a file path.");
  }
  const range = normalizeRange(node.range);
  return {
    id: String(node.id || `${node.file}:${range.startLine}-${range.endLine}`),
    file: node.file,
    range,
    kind: String(node.kind || "symbol"),
    name: String(node.name || node.id || node.file),
    rangeComplete: validRange(node.range) && node.rangeComplete !== false,
    ...(node.qualifiedName ? { qualifiedName: String(node.qualifiedName) } : {}),
    ...(node.signature ? { signature: String(node.signature) } : {})
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function anchorTier(hit, rank) {
  if (hit.reasons?.includes("explicit-design-reference") || hit.reasons?.includes("expected-modification-target") || rank < 2) {
    return "mustRead";
  }
  return "likelyRead";
}

function neighborTier(neighbor, anchorTiers) {
  const relationship = String(neighbor.relationship || "related").toLowerCase();
  if (MUST_RELATIONSHIPS.has(relationship) && anchorTiers.get(String(neighbor.from)) === "mustRead") {
    return "mustRead";
  }
  if (LIKELY_RELATIONSHIPS.has(relationship)) {
    return "likelyRead";
  }
  return "possibleRead";
}

function candidate(nodeValue, tier, reasons, score) {
  const node = normalizeNode(nodeValue);
  return {
    ...node,
    tier,
    reasons: unique(reasons.map(String)),
    score: Number.isFinite(score) ? Number(score) : null,
    symbols: [{ name: node.name, kind: node.kind, ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}), ...(node.signature ? { signature: node.signature } : {}) }],
    needsRead: true
  };
}

function overlaps(left, right) {
  return left.file === right.file && left.range.startLine <= right.range.endLine && right.range.startLine <= left.range.endLine;
}

function mergeCandidate(left, right) {
  const preferredTier = TIER_ORDER.get(left.tier) <= TIER_ORDER.get(right.tier) ? left.tier : right.tier;
  return {
    id: `${left.file}:${Math.min(left.range.startLine, right.range.startLine)}-${Math.max(left.range.endLine, right.range.endLine)}`,
    file: left.file,
    range: {
      startLine: Math.min(left.range.startLine, right.range.startLine),
      endLine: Math.max(left.range.endLine, right.range.endLine)
    },
    kind: left.kind === right.kind ? left.kind : "source-range",
    name: left.name === right.name ? left.name : `${left.name}, ${right.name}`,
    rangeComplete: left.rangeComplete && right.rangeComplete,
    tier: preferredTier,
    reasons: unique([...left.reasons, ...right.reasons]),
    score: Math.max(left.score ?? Number.NEGATIVE_INFINITY, right.score ?? Number.NEGATIVE_INFINITY),
    symbols: [...left.symbols, ...right.symbols],
    needsRead: true
  };
}

function mergeOverlappingCandidates(candidates) {
  const ordered = [...candidates].sort((left, right) => left.file.localeCompare(right.file) || left.range.startLine - right.range.startLine || left.range.endLine - right.range.endLine);
  const merged = [];
  for (const item of ordered) {
    const previous = merged.at(-1);
    if (previous && overlaps(previous, item)) {
      merged[merged.length - 1] = mergeCandidate(previous, item);
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function publicItem(item) {
  return {
    id: item.id,
    file: item.file,
    range: item.range,
    kind: item.kind,
    name: item.name,
    symbols: item.symbols,
    reasons: item.reasons,
    score: Number.isFinite(item.score) ? item.score : null,
    rangeComplete: item.rangeComplete,
    sourceTokens: item.sourceTokens
  };
}

function sumTokens(items, includedTiers) {
  const included = items.filter(({ tier }) => includedTiers.has(tier));
  if (included.some(({ rangeComplete }) => !rangeComplete)) return null;
  return included.reduce((total, item) => total + item.sourceTokens, 0);
}

async function readCandidate(item, provider) {
  const requestedRange = item.range;
  const response = await provider.read({ file: item.file, range: requestedRange });
  const rendered = response?.rendered ?? response?.content;
  if (typeof rendered !== "string") {
    throw new TypeError(`The repository-intelligence provider returned no rendered source for ${item.file}.`);
  }
  let responseComplete = response?.rangeComplete === true;
  if (response?.range) {
    const responseRangeIsValid = validRange(response.range);
    item.range = normalizeRange(response.range);
    item.id = `${item.file}:${item.range.startLine}-${item.range.endLine}`;
    responseComplete = responseRangeIsValid && item.range.startLine <= requestedRange.startLine && item.range.endLine >= requestedRange.endLine && response?.rangeComplete !== false;
  }
  item.rangeComplete = item.rangeComplete && responseComplete;
  item.rendered = rendered;
  item.needsRead = false;
}

export async function planRepositoryContext({ task, hints = {}, provider, tokenCounter = approximateTokenCounter, limits = {} }) {
  validateInputs(task, hints);
  assertProvider(provider);
  if (typeof tokenCounter?.count !== "function" || typeof tokenCounter.name !== "string") {
    throw new TypeError("The token counter must include a name and count function.");
  }

  const description = await provider.describe();
  if (typeof description?.commit !== "string" || !description.commit.trim() || description.commit === "unknown") {
    throw new Error("The repository-intelligence provider did not supply a concrete repository commit.");
  }
  const search = await provider.search(task.trim(), hints, {
    topK: integer(limits.searchHits, 12),
    budget: limits.budget || "balanced"
  });
  const hits = Array.isArray(search?.hits) ? search.hits : [];
  const anchorTiers = new Map();
  const anchors = hits.map((hit, rank) => {
    const tier = anchorTier(hit, rank);
    const normalized = candidate(hit.node, tier, hit.reasons || ["provider-ranked-match"], hit.score);
    const existingTier = anchorTiers.get(normalized.id);
    if (!existingTier || TIER_ORDER.get(tier) < TIER_ORDER.get(existingTier)) {
      anchorTiers.set(normalized.id, tier);
    }
    return normalized;
  });

  const neighborResult = await provider.neighbors(anchors.map(({ id, file, range, kind, name, qualifiedName, signature, rangeComplete }) => ({
    id,
    file,
    range,
    kind,
    name,
    rangeComplete,
    ...(qualifiedName ? { qualifiedName } : {}),
    ...(signature ? { signature } : {})
  })), {
    maxNodes: integer(limits.graphNodes, 24),
    relationships: ["definition", "implementation", "caller", "callee", "reference", "type-dependency", "tests"]
  });
  const neighbors = (Array.isArray(neighborResult?.neighbors) ? neighborResult.neighbors : []).map((neighbor) => candidate(
    neighbor.node,
    neighborTier(neighbor, anchorTiers),
    [String(neighbor.relationship || "related")],
    neighbor.score
  ));

  let items = mergeOverlappingCandidates([...anchors, ...neighbors]);
  for (const item of items) {
    await readCandidate(item, provider);
  }
  while (true) {
    const mergedItems = mergeOverlappingCandidates(items);
    const unreadItems = mergedItems.filter(({ needsRead }) => needsRead);
    items = mergedItems;
    if (unreadItems.length === 0) break;
    for (const item of unreadItems) {
      await readCandidate(item, provider);
    }
  }
  for (const item of items) {
    item.sourceTokens = tokenCounter.count(item.rendered);
  }

  const must = new Set(["mustRead"]);
  const expected = new Set(["mustRead", "likelyRead"]);
  const upper = new Set(["mustRead", "likelyRead", "possibleRead"]);
  const classified = (tier) => items.filter((item) => item.tier === tier).map(publicItem);
  const providerDiagnostics = [
    ...(Array.isArray(search?.diagnostics) ? search.diagnostics : []),
    ...(Array.isArray(neighborResult?.diagnostics) ? neighborResult.diagnostics : [])
  ];
  const unresolvedRequired = Array.isArray(search?.unresolvedRequired) ? search.unresolvedRequired : [];
  const unresolvedConcepts = unique(Array.isArray(search?.unresolvedConcepts) ? search.unresolvedConcepts.map(String) : []);
  const noAnchors = anchors.length === 0;
  const capabilities = description?.capabilities || {};
  const providerEstimateEligible = search?.estimateEligible === true
    && neighborResult?.estimateEligible === true
    && capabilities.lexicalSearch === true
    && capabilities.semanticSearch === true
    && capabilities.symbolGraph === true
    && capabilities.verifiedSource === true;
  const estimate = (tiers) => unresolvedRequired.length || unresolvedConcepts.length || noAnchors || !providerEstimateEligible ? null : sumTokens(items, tiers);

  const providerResult = {
    name: String(description?.name || "unknown"),
    capabilities
  };
  for (const key of ["selection", "contributors", "fallback"]) {
    if (description?.[key] !== undefined) {
      providerResult[key] = description[key];
    }
  }

  if (typeof provider.verifySnapshot === "function") {
    await provider.verifySnapshot();
  }

  return {
    schemaVersion: 1,
    commit: description.commit,
    ...(description.sourceFingerprint ? { sourceFingerprint: String(description.sourceFingerprint) } : {}),
    provider: providerResult,
    anchors: anchors.map(publicItem),
    mustRead: classified("mustRead"),
    likelyRead: classified("likelyRead"),
    possibleRead: classified("possibleRead"),
    tokenEstimate: {
      lower: estimate(must),
      expected: estimate(expected),
      upper: estimate(upper),
      method: { name: tokenCounter.name, exact: tokenCounter.exact === true }
    },
    observedSource: {
      verifiedRangeCount: items.filter(({ rangeComplete }) => rangeComplete).length,
      approximateTokens: items.filter(({ rangeComplete }) => rangeComplete).reduce((sum, item) => sum + item.sourceTokens, 0),
      method: tokenCounter.name
    },
    diagnostics: {
      retrievalCoverage: search?.retrievalCoverage ?? null,
      graphCoverage: neighborResult?.graphCoverage ?? null,
      retrievalPlan: search?.retrievalPlan ?? null,
      unresolvedConcepts,
      unresolvedRequired,
      noAnchors,
      estimateEligible: providerEstimateEligible && unresolvedRequired.length === 0 && unresolvedConcepts.length === 0 && !noAnchors,
      incompleteRanges: items.filter(({ rangeComplete }) => !rangeComplete).map(({ file, range, name }) => ({ file, range, name })),
      provider: providerDiagnostics
    }
  };
}
