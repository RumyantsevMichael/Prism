import { normalizeRepositorySourceRange } from "./repository-source-path.mjs";

const FUSION_OFFSET = 60;

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code) ? error.code : "provider-runtime-failed";
}

export class ExternalRepositoryIntelligenceError extends Error {
  constructor(provider, operation, cause) {
    super(`${provider} failed during ${operation}.`, { cause });
    this.name = "ExternalRepositoryIntelligenceError";
    this.provider = provider;
    this.operation = operation;
    this.code = safeErrorCode(cause);
    this.recoverable = cause?.recoverable !== false;
  }
}

async function callExternal(provider, operation, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExternalRepositoryIntelligenceError) throw error;
    throw new ExternalRepositoryIntelligenceError(provider, operation, error);
  }
}

function snapshotMismatch(message) {
  const error = new Error(message);
  error.code = "snapshot-mismatch";
  error.recoverable = true;
  return error;
}

function normalizedSnapshotIdentity(description) {
  const identity = description?.snapshotIdentity;
  if (!identity || typeof identity !== "object") return null;
  if (typeof identity.scheme !== "string" || !identity.scheme || typeof identity.commit !== "string" || !identity.commit || typeof identity.fingerprint !== "string" || !identity.fingerprint) {
    return null;
  }
  return { scheme: identity.scheme, commit: identity.commit, fingerprint: identity.fingerprint };
}

function assertMatchingSnapshot(nativeDescription, externalDescription) {
  const nativeIdentity = normalizedSnapshotIdentity(nativeDescription);
  const externalIdentity = normalizedSnapshotIdentity(externalDescription);
  if (!nativeIdentity || !externalIdentity) {
    throw snapshotMismatch("The provider did not supply a normalized source snapshot identity.");
  }
  if (nativeIdentity.scheme !== externalIdentity.scheme || nativeIdentity.commit !== externalIdentity.commit || nativeIdentity.fingerprint !== externalIdentity.fingerprint) {
    throw snapshotMismatch("The provider source snapshot does not match the native source snapshot.");
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map(String))];
}

function exactSymbolMatch(node, expected) {
  const normalizedExpected = String(expected || "").trim().toLowerCase();
  if (!normalizedExpected) return false;
  const identities = [node?.qualifiedName, node?.name]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  if (identities.includes(normalizedExpected)) return true;
  if (normalizedExpected.includes(".") || normalizedExpected.includes("::") || normalizedExpected.includes("#")) return false;
  return identities.some((identity) => identity.split(/::|[.#/\\]/).at(-1)?.replace(/\(.*$/, "") === normalizedExpected.replace(/\(.*$/, ""));
}

function nodeKey(node) {
  return [node?.file, node?.range?.startLine, node?.range?.endLine, node?.qualifiedName || node?.name || node?.id].join(":");
}

function providerDiagnostic(provider, diagnostic) {
  return { provider, ...diagnostic };
}

function contributor(description, kind) {
  return {
    id: String(description?.name || "unknown"),
    kind,
    version: description?.version ? String(description.version) : null,
    capabilities: description?.capabilities || {}
  };
}

function capabilities(descriptions) {
  const result = {};
  for (const description of descriptions) {
    for (const [name, value] of Object.entries(description?.capabilities || {})) {
      result[name] = result[name] === true || value === true;
    }
  }
  return result;
}

function replacementForNativeFile(nativeHit, externalHits) {
  if (nativeHit?.node?.kind !== "file") return null;
  if (nativeHit.reasons?.includes("explicit-design-reference") || nativeHit.reasons?.includes("expected-modification-target")) return null;
  return externalHits.find(({ node }) => node?.file === nativeHit.node.file && node.kind !== "file") || null;
}

function fuseHits(results) {
  const externalHits = results.slice(1).flatMap(({ result }) => Array.isArray(result?.hits) ? result.hits : []);
  const fused = new Map();
  for (const [providerIndex, { provider, result }] of results.entries()) {
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    for (const [rank, hit] of hits.entries()) {
      const replacement = providerIndex === 0 ? replacementForNativeFile(hit, externalHits) : null;
      const effectiveHit = replacement ? { ...hit, node: replacement.node } : hit;
      const key = nodeKey(effectiveHit.node);
      const previous = fused.get(key);
      const score = 1 / (FUSION_OFFSET + rank + 1);
      if (previous) {
        previous.score += score;
        previous.reasons = unique([...previous.reasons, ...(effectiveHit.reasons || [])]);
        previous.providers = unique([...previous.providers, provider]);
      } else {
        fused.set(key, {
          ...effectiveHit,
          node: effectiveHit.node,
          score,
          reasons: unique(effectiveHit.reasons || ["provider-ranked-match"]),
          providers: [provider]
        });
      }
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || nodeKey(left.node).localeCompare(nodeKey(right.node)))
    .map(({ providers: contributingProviders, ...hit }) => ({
      ...hit,
      reasons: unique([...hit.reasons, ...contributingProviders.map((provider) => `provider:${provider}`)])
    }));
}

function unresolvedRequired(results, hits) {
  const unresolved = new Map();
  for (const { result } of results) {
    for (const item of Array.isArray(result?.unresolvedRequired) ? result.unresolvedRequired : []) {
      const normalized = { kind: String(item.kind), value: String(item.value) };
      unresolved.set(`${normalized.kind}:${normalized.value}`, normalized);
    }
  }
  for (const [key, item] of unresolved) {
    const resolved = item.kind === "file"
      ? hits.some(({ node }) => node?.file === item.value)
      : item.kind === "symbol"
        ? hits.some(({ node }) => exactSymbolMatch(node, item.value))
        : false;
    if (resolved) unresolved.delete(key);
  }
  return [...unresolved.values()].sort((left, right) => `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`));
}

function unresolvedConcepts(hints, results) {
  const requested = unique(Array.isArray(hints?.concepts) ? hints.concepts : []);
  return requested.filter((concept) => {
    const normalized = concept.trim().toLowerCase();
    return !results.some(({ result }) => {
      if (!Array.isArray(result?.unresolvedConcepts)) return false;
      return !result.unresolvedConcepts.some((value) => String(value).trim().toLowerCase() === normalized);
    });
  });
}

function mergeCoverage(values) {
  const numeric = values.filter(Number.isFinite);
  return numeric.length === values.length && numeric.length ? Math.min(...numeric) : null;
}

export class CompositeRepositoryIntelligence {
  constructor(nativeProvider, externalProvider = null, options = {}) {
    if (!nativeProvider) throw new TypeError("A native repository intelligence provider is required.");
    this.nativeProvider = nativeProvider;
    this.externalProvider = externalProvider;
    this.requestedSelection = options.requestedSelection || "auto";
    this.selectedExternal = options.selectedExternal || null;
    this.fallback = options.fallback ?? null;
    this.descriptions = null;
  }

  async describe() {
    const nativeDescription = await this.nativeProvider.describe();
    const externalDescription = this.externalProvider
      ? await callExternal(this.selectedExternal || "external", "describe", async () => {
        const description = await this.externalProvider.describe();
        assertMatchingSnapshot(nativeDescription, description);
        return description;
      })
      : null;
    this.descriptions = [nativeDescription, externalDescription].filter(Boolean);
    return {
      name: this.descriptions.map(({ name }) => name).join("+"),
      commit: nativeDescription.commit,
      ...(nativeDescription.sourceFingerprint ? { sourceFingerprint: nativeDescription.sourceFingerprint } : {}),
      capabilities: capabilities(this.descriptions),
      selection: {
        requested: this.requestedSelection,
        selected: this.selectedExternal || "native"
      },
      contributors: this.descriptions.map((description, index) => contributor(description, index === 0 ? "built-in" : "external")),
      fallback: this.fallback
    };
  }

  async search(task, hints, options) {
    if (!this.descriptions) await this.describe();
    const results = [{ provider: "native", result: await this.nativeProvider.search(task, hints, options) }];
    if (this.externalProvider) {
      const provider = this.selectedExternal || this.descriptions[1]?.name || "external";
      const result = await callExternal(provider, "search", () => this.externalProvider.search(task, hints, options));
      results.push({ provider, result });
    }
    const hits = fuseHits(results);
    const diagnostics = results.flatMap(({ provider, result }) => (Array.isArray(result?.diagnostics) ? result.diagnostics : []).map((item) => providerDiagnostic(provider, item)));
    const retrievalCoverageValues = results.map(({ result }) => result?.retrievalCoverage);
    const aggregateCapabilities = capabilities(this.descriptions);
    const eligibleEvidence = results.some(({ result }) => result?.estimateEligible === true);
    const completeCapabilitySet = aggregateCapabilities.lexicalSearch === true
      && aggregateCapabilities.semanticSearch === true
      && aggregateCapabilities.symbolGraph === true
      && aggregateCapabilities.verifiedSource === true;
    const requiredEvidenceComplete = results.every(({ result }) => result?.requiredEvidenceComplete !== false);
    return {
      hits,
      retrievalCoverage: mergeCoverage(retrievalCoverageValues),
      unresolvedConcepts: unresolvedConcepts(hints, results),
      unresolvedRequired: unresolvedRequired(results, hits),
      requiredEvidenceComplete,
      diagnostics,
      estimateEligible: completeCapabilitySet && eligibleEvidence && requiredEvidenceComplete,
      retrievalPlan: {
        fusion: "reciprocal-rank-fusion",
        offset: FUSION_OFFSET,
        contributors: results.map(({ provider, result }) => ({ provider, plan: result?.retrievalPlan ?? null }))
      }
    };
  }

  async neighbors(nodes, options) {
    const results = [{ provider: "native", result: await this.nativeProvider.neighbors(nodes, options) }];
    if (this.externalProvider) {
      const provider = this.selectedExternal || "external";
      const result = await callExternal(provider, "neighbors", () => this.externalProvider.neighbors(nodes, options));
      results.push({ provider, result });
    }
    const fused = new Map();
    for (const { provider, result } of results) {
      for (const [rank, neighbor] of (Array.isArray(result?.neighbors) ? result.neighbors : []).entries()) {
        const key = `${neighbor.from || ""}:${neighbor.relationship || "related"}:${nodeKey(neighbor.node)}`;
        const previous = fused.get(key);
        const score = 1 / (FUSION_OFFSET + rank + 1);
        if (previous) {
          previous.score += score;
          previous.providers = unique([...previous.providers, provider]);
        } else {
          fused.set(key, { ...neighbor, score, providers: [provider] });
        }
      }
    }
    const neighbors = [...fused.values()]
      .sort((left, right) => right.score - left.score || nodeKey(left.node).localeCompare(nodeKey(right.node)))
      .slice(0, options.maxNodes)
      .map(({ providers: _providers, ...neighbor }) => neighbor);
    const graphCoverageValues = results.map(({ result }) => result?.graphCoverage);
    const aggregateCapabilities = capabilities(this.descriptions || []);
    const eligibleEvidence = results.some(({ result }) => result?.estimateEligible === true);
    return {
      neighbors,
      graphCoverage: mergeCoverage(graphCoverageValues),
      diagnostics: results.flatMap(({ provider, result }) => (Array.isArray(result?.diagnostics) ? result.diagnostics : []).map((item) => providerDiagnostic(provider, item))),
      estimateEligible: aggregateCapabilities.symbolGraph === true && eligibleEvidence
    };
  }

  async read(sourceRange) {
    const normalizedRange = normalizeRepositorySourceRange(sourceRange);
    const validatedRange = typeof this.nativeProvider.validateSourceRange === "function"
      ? await this.nativeProvider.validateSourceRange(normalizedRange)
      : normalizedRange;
    return this.nativeProvider.read(validatedRange);
  }

  async verifySnapshot() {
    if (this.externalProvider) {
      if (typeof this.externalProvider.verifySnapshot !== "function") {
        await callExternal(this.selectedExternal || "external", "snapshot verification", async () => {
          throw snapshotMismatch("The external provider cannot verify its final source snapshot.");
        });
      }
      await callExternal(this.selectedExternal || "external", "snapshot verification", () => this.externalProvider.verifySnapshot());
    }
    if (typeof this.nativeProvider.verifySnapshot === "function") {
      return this.nativeProvider.verifySnapshot();
    }
    return null;
  }
}
