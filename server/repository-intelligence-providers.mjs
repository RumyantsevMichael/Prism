import { CODENIB_CAPABILITIES, CODENIB_SUPPORTED_VERSION, CodeNibRepositoryIntelligence, openCodeNibClient } from "./codenib-provider.mjs";
import { CODEGRAPH_CAPABILITIES, CODEGRAPH_SUPPORTED_VERSION, openCodeGraphRepositoryIntelligence } from "./codegraph-provider.mjs";
import { CompositeRepositoryIntelligence, ExternalRepositoryIntelligenceError } from "./composite-repository-intelligence.mjs";
import { openNativeRepositoryIntelligence } from "./native-repository-intelligence.mjs";

const EXTERNAL_PROVIDER_ORDER = ["codegraph", "codenib"];
const NATIVE_CAPABILITIES = Object.freeze({
  lexicalSearch: true,
  semanticSearch: false,
  hybridSearch: false,
  symbolGraph: false,
  verifiedSource: true
});

function availabilityStatus(code) {
  return String(code || "").includes("incompatible") ? "incompatible" : "unavailable";
}

function sanitizedMessage(provider, code) {
  const messages = {
    "not-installed": `${provider} is not installed or cannot be started.`,
    "not-indexed": `${provider} has no index for this project.`,
    "stale-index": `${provider} has an index that does not match the current project state.`,
    "incomplete-index": `${provider} has an incomplete index.`,
    "incompatible-index": `${provider} has an index built by an incompatible version.`,
    "incompatible-version": `${provider} has an unsupported executable version.`,
    "invalid-server-identity": `${provider} did not return its required executable identity.`,
    "worktree-mismatch": `${provider} is indexed for another worktree.`,
    "project-mismatch": `${provider} returned data for another project root.`,
    "snapshot-mismatch": `${provider} does not describe the native source snapshot.`,
    "snapshot-changed": `${provider} source snapshot is no longer current.`,
    "response-too-large": `${provider} returned a response above its byte limit.`,
    "request-timeout": `${provider} did not respond before its time limit.`,
    "process-exited": `${provider} stopped before it completed the request.`,
    "provider-runtime-failed": `${provider} failed while it supplied repository intelligence.`,
    "open-failed": `${provider} could not open a repository intelligence session.`
  };
  return messages[code] || `${provider} is unavailable for this project.`;
}

function failureCode(error) {
  if (typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code)) return error.code;
  if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT" || /\bENOENT\b/.test(String(error?.message))) return "not-installed";
  return "open-failed";
}

async function closeSession(session) {
  try {
    await session?.close?.();
  } catch {
  }
}

async function normalizedSession(descriptor, projectRoot, context) {
  const opened = await descriptor.open(projectRoot, context);
  const close = typeof opened?.close === "function" ? () => opened.close() : async () => {};
  try {
    const provider = opened?.provider || opened;
    if (!provider || typeof provider.describe !== "function") {
      throw new Error(`${descriptor.id} did not open a repository intelligence provider.`);
    }
    const description = opened?.description || await provider.describe();
    if (!description || typeof description !== "object" || Array.isArray(description)) {
      throw new Error(`${descriptor.id} returned an invalid repository intelligence description.`);
    }
    return { descriptor, provider, description, close };
  } catch (error) {
    await closeSession({ close });
    throw error;
  }
}

function capabilityRank(session) {
  const value = session.description?.capabilities || {};
  return [
    value.verifiedSource === true ? 1 : 0,
    value.hybridSearch === true ? 1 : 0,
    value.semanticSearch === true ? 1 : 0,
    value.symbolGraph === true ? 1 : 0
  ];
}

function descriptorMetadata(descriptor) {
  return {
    version: String(descriptor.metadata?.version || "unknown"),
    capabilities: { ...(descriptor.metadata?.capabilities || {}) }
  };
}

function compareSessions(left, right) {
  const leftRank = capabilityRank(left);
  const rightRank = capabilityRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return left.descriptor.id.localeCompare(right.descriptor.id);
}

function availableRecord(session) {
  const metadata = descriptorMetadata(session.descriptor);
  return {
    id: session.descriptor.id,
    kind: session.descriptor.kind,
    status: "available",
    version: session.description?.version ? String(session.description.version) : metadata.version,
    capabilities: { ...metadata.capabilities, ...(session.description?.capabilities || {}) },
    diagnosticCode: null,
    message: null
  };
}

function unavailableRecord(descriptor, error) {
  const code = failureCode(error);
  const metadata = descriptorMetadata(descriptor);
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    status: availabilityStatus(code),
    version: error?.version ? String(error.version) : metadata.version,
    capabilities: metadata.capabilities,
    diagnosticCode: code,
    message: sanitizedMessage(descriptor.id, code)
  };
}

export class RepositoryIntelligenceSelectionError extends Error {
  constructor(provider, code, message = sanitizedMessage(provider, code), options = {}) {
    super(message, options);
    this.name = "RepositoryIntelligenceSelectionError";
    this.provider = provider;
    this.code = code;
    this.recoverable = true;
  }
}

export function createRepositoryIntelligenceDescriptors(options = {}) {
  const openNative = options.openNative || openNativeRepositoryIntelligence;
  const openCodeGraph = options.openCodeGraph || openCodeGraphRepositoryIntelligence;
  const openCodeNib = options.openCodeNib || openCodeNibClient;
  return [
    {
      id: "native",
      kind: "built-in",
      metadata: { version: "1", capabilities: NATIVE_CAPABILITIES },
      async open(projectRoot) {
        const provider = await openNative(projectRoot, options.native);
        return { provider, close: async () => {} };
      }
    },
    {
      id: "codegraph",
      kind: "external",
      metadata: { version: `>=${CODEGRAPH_SUPPORTED_VERSION.minimum},<${CODEGRAPH_SUPPORTED_VERSION.maximumExclusive}`, capabilities: CODEGRAPH_CAPABILITIES },
      async open(projectRoot, context) {
        const provider = await openCodeGraph(projectRoot, context.nativeProvider, options.codegraph);
        return { provider, close: async () => {} };
      }
    },
    {
      id: "codenib",
      kind: "external",
      metadata: { version: CODENIB_SUPPORTED_VERSION, capabilities: CODENIB_CAPABILITIES },
      async open(projectRoot, context) {
        const client = await openCodeNib(projectRoot, options.codenib);
        const provider = new CodeNibRepositoryIntelligence(client, {
          projectRoot: client.projectRoot || projectRoot,
          sourceProvider: context.nativeProvider,
          sourceDescription: context.nativeDescription
        });
        return { provider, close: () => client.close() };
      }
    }
  ];
}

function sortedDescriptors(descriptors) {
  return [...descriptors].sort((left, right) => left.id.localeCompare(right.id));
}

function descriptorMap(descriptors) {
  const entries = sortedDescriptors(descriptors).map((descriptor) => [descriptor.id, descriptor]);
  if (new Set(entries.map(([id]) => id)).size !== entries.length) {
    throw new Error("Repository intelligence provider identifiers must be unique.");
  }
  return new Map(entries);
}

async function openNativeSession(projectRoot, descriptors) {
  const descriptor = descriptorMap(descriptors).get("native");
  if (!descriptor || descriptor.kind !== "built-in") {
    throw new Error("The repository intelligence catalog must contain the built-in native provider.");
  }
  return normalizedSession(descriptor, projectRoot, {});
}

async function openExternalSession(descriptor, projectRoot, nativeSession) {
  return normalizedSession(descriptor, projectRoot, {
    nativeProvider: nativeSession.provider,
    nativeDescription: nativeSession.description
  });
}

export async function listRepositoryIntelligenceProviders(projectRoot, options = {}) {
  const descriptors = options.descriptors || createRepositoryIntelligenceDescriptors(options);
  const nativeSession = await openNativeSession(projectRoot, descriptors);
  try {
    const records = [availableRecord(nativeSession)];
    const externalDescriptors = sortedDescriptors(descriptors).filter(({ kind }) => kind === "external");
    const externalRecords = await Promise.all(externalDescriptors.map(async (descriptor) => {
      let session;
      try {
        session = await openExternalSession(descriptor, projectRoot, nativeSession);
        return availableRecord(session);
      } catch (error) {
        return unavailableRecord(descriptor, error);
      } finally {
        await closeSession(session);
      }
    }));
    return [...records, ...externalRecords].sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    await closeSession(nativeSession);
  }
}

function fallbackOf(session, error) {
  const code = failureCode(error);
  return { provider: session.descriptor.id, code, message: sanitizedMessage(session.descriptor.id, code) };
}

export async function withRepositoryIntelligence(projectRoot, action, options = {}) {
  if (typeof action !== "function") throw new TypeError("A repository intelligence action is required.");
  const requestedSelection = options.selection || "auto";
  const descriptors = options.descriptors || createRepositoryIntelligenceDescriptors(options);
  const byId = descriptorMap(descriptors);
  if (requestedSelection !== "auto" && !byId.has(requestedSelection)) {
    throw new RepositoryIntelligenceSelectionError(requestedSelection, "unknown-provider", `Unknown repository intelligence provider: ${requestedSelection}.`);
  }
  const nativeSession = await openNativeSession(projectRoot, descriptors);
  let selectedSession = null;
  const openedExternal = [];
  try {
    if (requestedSelection !== "native") {
      const candidates = requestedSelection === "auto"
        ? EXTERNAL_PROVIDER_ORDER.map((id) => byId.get(id)).filter(Boolean)
        : [byId.get(requestedSelection)];
      for (const descriptor of candidates) {
        if (descriptor.kind !== "external") continue;
        try {
          openedExternal.push(await openExternalSession(descriptor, projectRoot, nativeSession));
        } catch (error) {
          if (requestedSelection !== "auto") {
            const code = failureCode(error);
            throw new RepositoryIntelligenceSelectionError(descriptor.id, code, sanitizedMessage(descriptor.id, code), { cause: error });
          }
        }
      }
      if (requestedSelection === "auto") {
        openedExternal.sort(compareSessions);
        selectedSession = openedExternal[0] || null;
      } else {
        selectedSession = openedExternal[0] || null;
      }
      for (const session of openedExternal) {
        if (session !== selectedSession) await closeSession(session);
      }
    }

    const composite = new CompositeRepositoryIntelligence(nativeSession.provider, selectedSession?.provider || null, {
      requestedSelection,
      selectedExternal: selectedSession?.descriptor.id || null
    });
    try {
      return await action(composite);
    } catch (error) {
      const externalFailure = error instanceof ExternalRepositoryIntelligenceError
        && error.provider === selectedSession?.descriptor.id
        && error.recoverable === true;
      if (requestedSelection !== "auto" || !selectedSession || !externalFailure) throw error;
      const fallback = fallbackOf(selectedSession, error);
      await closeSession(selectedSession);
      selectedSession = null;
      const nativeOnly = new CompositeRepositoryIntelligence(nativeSession.provider, null, { requestedSelection, fallback });
      return action(nativeOnly);
    }
  } finally {
    await closeSession(selectedSession);
    await closeSession(nativeSession);
  }
}
