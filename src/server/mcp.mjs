import readline from "node:readline";
import { pluginURL } from "./plugin-root.mjs";
import { ACTIVE_OPERATIONS_SCHEMA } from "./workflow/active-operations.mjs";
import { assertInput } from "./workflow/artifact-schema.mjs";
import { CONSERVATION_TOOLS, callConservationTool } from "./conservation/conservation-tools.mjs";
import { ConceptDeltaError, GET_CONCEPT_DELTA_SCHEMA, UPDATE_CONCEPT_DELTA_SCHEMA, getConceptDelta, updateConceptDelta } from "./conservation/concept-delta.mjs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY_CONTEXT_INPUT_LIMITS, planRepositoryContext } from "./repository-intelligence/repository-intelligence.mjs";
import {
  listRepositoryIntelligenceProviders,
  RepositoryIntelligenceSelectionError,
  withRepositoryIntelligence
} from "./repository-intelligence/repository-intelligence-providers.mjs";
import {
  createActiveSessionCapacityRequest,
  evaluateActiveRepositoryFit,
  evaluateRepositoryFit,
  resolveActiveSessionCapacity,
  resolveSessionCapacity
} from "./session/session-capacity.mjs";
import { summarizeSessionConsumption } from "./session/session-trace-store.mjs";
import { appendDecision, readDecisionHistory, setDecisionRecording } from "./workflow/decision-history.mjs";
import { listArtifacts } from "./review/review-server.mjs";
import { createReviewServerPool } from "./review/review-server-pool.mjs";
import { checkpointPause, readCoordinationState, updateCoordinationState, validateCoordinationState } from "./workflow/state.mjs";
import { nativeSemanticRuntime } from "./repository-intelligence/native-semantic-runtime.mjs";
import { NATIVE_INTELLIGENCE_TOOLS, prepareNativeProvider, searchRepositoryConcepts } from "./repository-intelligence/semantic-native-provider.mjs";

const reviewServers = createReviewServerPool();
const pluginManifest = JSON.parse(await readFile(pluginURL(".codex-plugin/plugin.json"), "utf8"));

function decisionDataDirectory(argumentsValue) {
  const configured = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (configured && argumentsValue.dataDirectory && path.resolve(argumentsValue.dataDirectory) !== path.resolve(configured)) {
    throw new Error("The dataDirectory argument does not match the host plugin data directory.");
  }
  return argumentsValue.dataDirectory || configured;
}

async function recordAutomaticDecision(input) {
  try {
    return await appendDecision(input);
  } catch {
    return { status: "unavailable", reasonCode: "decision_store_unavailable" };
  }
}

function estimateReasons(plan) {
  if (plan.tokenEstimate?.expected !== null) return [];
  const result = [];
  const diagnostics = plan.diagnostics || {};
  if (diagnostics.noAnchors) result.push("no_anchors");
  if (diagnostics.unresolvedRequired?.length) result.push("unresolved_required");
  if (diagnostics.unresolvedConcepts?.length) result.push("unresolved_concepts");
  for (const [name, enabled] of Object.entries(plan.provider?.capabilities || {})) {
    if (["lexicalSearch", "semanticSearch", "symbolGraph", "verifiedSource"].includes(name) && enabled !== true) {
      result.push(`${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_unavailable`);
    }
  }
  if (!diagnostics.estimateEligible && result.length === 0) result.push("provider_estimate_ineligible");
  return result;
}

function contextDecision(plan, requestedProvider, exclusions = []) {
  const ranges = [plan.mustRead || [], plan.likelyRead || [], plan.possibleRead || []];
  const verifiedTokens = plan.observedSource?.approximateTokens ?? ranges.flat().reduce((sum, item) => sum + (item.rangeComplete && Number.isSafeInteger(item.sourceTokens) ? item.sourceTokens : 0), 0);
  return {
    kind: "context_plan",
    outcome: "SUCCESS",
    requestedProvider,
    selectedProvider: plan.provider?.selection?.selected || "native",
    reasonCodes: [
      ...estimateReasons(plan),
      ...exclusions.map((item) => `${item.provider}_${item.reasonCode}`.replace(/[^a-z0-9_-]/g, "_"))
    ],
    counts: { must: ranges[0].length, likely: ranges[1].length, possible: ranges[2].length, verifiedTokens },
    estimate: { lower: plan.tokenEstimate?.lower ?? null, expected: plan.tokenEstimate?.expected ?? null, upper: plan.tokenEstimate?.upper ?? null }
  };
}

function taskId(metadata = {}) {
  return metadata["x-codex-turn-metadata"]?.thread_id ?? metadata.threadId ?? "mcp-process";
}

async function requestedProjectRoot(argumentsValue) {
  const hostProjectRoot = process.env.CLAUDE_PROJECT_DIR;
  const hasSuppliedProjectRoot = Object.hasOwn(argumentsValue, "projectRoot");
  if (
    hasSuppliedProjectRoot
    && (typeof argumentsValue.projectRoot !== "string" || !path.isAbsolute(argumentsValue.projectRoot))
  ) {
    throw new Error("The projectRoot argument must be an absolute path.");
  }
  const projectRoot = hostProjectRoot ?? argumentsValue.projectRoot;
  if (!projectRoot) {
    throw new Error("The projectRoot argument is required when the host does not provide a project root.");
  }
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("The projectRoot argument must be an absolute path.");
  }
  const resolvedRoot = await realpath(projectRoot);
  if (hostProjectRoot && hasSuppliedProjectRoot) {
    const suppliedRoot = await realpath(argumentsValue.projectRoot);
    if (suppliedRoot !== resolvedRoot) {
      throw new Error("The projectRoot argument does not match the host project root.");
    }
  }
  return resolvedRoot;
}

async function server(argumentsValue, metadata) {
  const id = taskId(metadata);
  const projectRoot = await requestedProjectRoot(argumentsValue);
  return reviewServers.get(projectRoot, id);
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function requestedTabs(argumentsValue) {
  const hasArtifact = Object.hasOwn(argumentsValue, "artifact");
  const hasArtifacts = Object.hasOwn(argumentsValue, "artifacts");
  if (hasArtifact && hasArtifacts) {
    throw new Error("Use either artifact or artifacts, not both.");
  }
  if (hasArtifacts) {
    return argumentsValue.artifacts;
  }
  return hasArtifact ? argumentsValue.artifact : undefined;
}

function reviewContent(url, review) {
  const trustInstructions = review.trustInstructions ? `\n${review.trustInstructions}` : "";
  return `Human review URL: ${url}${trustInstructions}`;
}

function stateContent(result) {
  const validity = result.valid ? "valid" : "invalid";
  const revision = result.revision ?? "none";
  return `Coordination state ${validity}: ${result.statePath}\nRevision: ${revision}`;
}

function contextPlanContent(plan) {
  return [
    `Repository context plan for commit ${plan.commit}.`,
    `Must read: ${plan.mustRead.length}.`,
    `Likely read: ${plan.likelyRead.length}.`,
    `Possible read: ${plan.possibleRead.length}.`,
    `Token estimate: ${plan.tokenEstimate.lower} / ${plan.tokenEstimate.expected} / ${plan.tokenEstimate.upper}.`,
    `Observed verified source: ${plan.observedSource?.approximateTokens ?? 0} approximate tokens across ${plan.observedSource?.verifiedRangeCount ?? 0} ranges.`
  ].join("\n");
}

function repositoryFitContent(result) {
  if (result.status === "UNSUPPORTED") {
    return `Repository fit: UNSUPPORTED.\nReason: ${result.reason}${result.reasonCode ? `\nReason code: ${result.reasonCode}.` : ""}`;
  }
  return [
    `Repository fit: ${result.fit}.`,
    `Repository read budget: ${result.repositoryReadBudgetTokens}.`,
    `Compaction threshold: ${result.capacity.compactionThresholdTokens}.`,
    `Capacity profile: ${result.profileId ?? "explicit-input"}.`
  ].join("\n");
}

function sessionCapacityContent(result) {
  if (result.status === "UNSUPPORTED") {
    return `Session capacity: UNSUPPORTED.\nReason: ${result.reason}${result.reasonCode ? `\nReason code: ${result.reasonCode}.` : ""}`;
  }
  return [
    "Session capacity: SUPPORTED.",
    `Context window: ${result.capacity.contextWindowTokens}.`,
    `Compaction threshold: ${result.capacity.compactionThresholdTokens}.`,
    `Capacity profile: ${result.profileId ?? "explicit-input"}.`
  ].join("\n");
}

function providerListContent(providers) {
  return providers.map(({ id, status, diagnosticCode }) => `${id}: ${status}${diagnosticCode ? ` (${diagnosticCode})` : ""}`).join("\n");
}

function sessionConsumptionContent(summary) {
  if (summary.status === "UNSUPPORTED") {
    return `Session consumption: UNSUPPORTED.\nReason: ${summary.reason}${summary.reasonCode ? `\nReason code: ${summary.reasonCode}.` : ""}`;
  }
  return [
    "Session consumption: SUPPORTED.",
    `Coverage: ${summary.coverage}.`,
    `Pre-edit window: ${summary.preEdit.window}.`,
    `Rendered tokens: ${summary.preEdit.renderedTokens ?? "unavailable"}.`,
    `Source reads: ${summary.preEdit.sourceReadCount}.`,
    `Compactions before first edit: ${summary.compaction.countBeforeFirstEdit}.`
  ].join("\n");
}

function reviewSessionContent(review) {
  return review.getSession();
}

function assertExactToolArguments(value, allowed, required, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${name} contains an unknown property: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${name}.${key} is required.`);
    }
  }
}

function activeCapacityRequest(argumentsValue, projectRoot) {
  return createActiveSessionCapacityRequest(argumentsValue.session, {
    dataDirectory: process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA,
    projectRoot
  });
}

function failure(id, code, message, data) {
  const response = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) {
    response.error.data = data;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function stateErrorData(error) {
  if (error instanceof RepositoryIntelligenceSelectionError) {
    return { code: error.code, provider: error.provider, recoverable: error.recoverable };
  }
  if (error instanceof ConceptDeltaError) {
    return { code: error.code, ...(error.errors ? { errors: error.errors } : {}), ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) };
  }
  if (error?.name !== "CoordinationStateError") {
    if (["validation_failed", "invalid_path", "lock_timeout", "stale_snapshot", "preparation_failed", "unsupported_runtime", "corrupt_asset", "resource_limit", "incomplete_structure", "evidence_missing", "gate_blocked", "revision_conflict"].includes(error.code)) return { code: error.code, ...Object.fromEntries(["errors", "problems", "currentRevision", "expectedSnapshot", "currentSnapshot", "evidenceId"].filter(key => error[key] !== undefined).map(key => [key, Array.isArray(error[key]) ? error[key].slice(0, 100) : error[key]])) };
    return undefined;
  }
  const data = { code: error.code };
  for (const key of ["errors", "warnings", "current", "validation"]) {
    if (error[key] !== undefined) {
      data[key] = error[key];
    }
  }
  return data;
}

const capacityOverridesInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    contextWindowTokens: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    compactionThresholdTokens: { type: "integer", minimum: 1, maximum: 9007199254740991 }
  }
};

const completeCapacityOverridesInputSchema = {
  ...capacityOverridesInputSchema,
  required: ["contextWindowTokens", "compactionThresholdTokens"]
};

const sessionCorrelationKeyInputSchema = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
  description: "The SHA-256 session correlation key emitted as developer context by the enabled Prism session hook."
};

const explicitSessionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["harness", "harnessVersion", "provider", "model"],
  properties: {
    harness: { type: "string", minLength: 1 },
    harnessVersion: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    capacityOverrides: capacityOverridesInputSchema
  }
};

const activeSessionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "correlationKey", "dataDirectory"],
  properties: {
    mode: { const: "active" },
    correlationKey: sessionCorrelationKeyInputSchema,
    dataDirectory: { type: "string", minLength: 1, description: "The absolute Prism plugin data directory emitted by the enabled session hook." },
    capacityOverrides: completeCapacityOverridesInputSchema,
    compactionScope: { const: "total", description: "Explicitly attest that the supplied capacity threshold counts total session tokens." }
  }
};

const sessionInputSchema = { oneOf: [explicitSessionInputSchema, activeSessionInputSchema] };

const tools = [
  ...CONSERVATION_TOOLS,
  ...NATIVE_INTELLIGENCE_TOOLS,
  {
    name: "get_concept_delta",
    description: "Read a bounded page of a slice concept-delta.json through MCP. Pin expectedRevision across pages and to the audited design. Reads never create files.",
    inputSchema: GET_CONCEPT_DELTA_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_concept_delta",
    description: "Insert, update, or remove concept entries in one validated atomic batch. Read first and pass its revision. Use null only for creation. Never edit the artifact directly. Missing addition evidence keeps drafts not ready for FIT.",
    inputSchema: UPDATE_CONCEPT_DELTA_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_review_url",
    description: "Start or update the local Prism HTTPS review server and return a human review URL only. Use artifacts to select the shared persistent tabs. This tool does not open a browser or return rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path. Use artifacts for multiple tabs." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths to open as persistent tabs. An empty array closes all tabs." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "present_review",
    description: "Open or update one local Prism HTTPS review page in the system browser for the human. Use artifacts to select the shared persistent tabs. Repeated calls update connected viewer pages without opening another tab. Omit artifact to show the complete artifact tree when artifacts is also omitted. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path. Use artifacts for multiple tabs." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths to open as persistent tabs. An empty array closes all tabs." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "list_reviewable_artifacts",
    description: "List reviewable Prism source artifacts. This tool reads file names only and returns no image data.",
    inputSchema: {
      type: "object",
      properties: { projectRoot: { type: "string", description: "The absolute path to the active project root." } },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "list_repository_intelligence_providers",
    description: "List registered repository intelligence providers and their current availability for a project. This tool does not create, synchronize, or update provider indexes.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "plan_repository_context",
    description: "Plan bounded repository source context. Auto prepares bundled native semantic analysis, downloading pinned assets and writing private caches as needed. Returns preparing after ten seconds or source ranges with token estimates. Explicit external providers remain available. This tool does not decide session fit.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        provider: { type: "string", enum: ["auto", "native", "codegraph", "codenib"], default: "auto", description: "Auto selects native analysis. Select codegraph or codenib explicitly to use an external contributor." },
        task: { type: "string", minLength: 1, maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.taskCharacters, description: "The implementation or design outcome to investigate." },
        hints: {
          type: "object",
          additionalProperties: false,
          properties: {
            files: { type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind, items: { type: "string", minLength: 1, maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters } },
            symbols: { type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind, items: { type: "string", minLength: 1, maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters } },
            concepts: { type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind, items: { type: "string", minLength: 1, maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters } },
            expectedModifiedFiles: { type: "array", maxItems: REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind, items: { type: "string", minLength: 1, maxLength: REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters } }
          }
        },
        budget: { type: "string", enum: ["fast", "balanced", "thorough"], default: "balanced" },
        searchHits: { type: "integer", minimum: 1, maximum: 100, default: 12 },
        graphNodes: { type: "integer", minimum: 1, maximum: 100, default: 24 },
        expectedSnapshot: { type: "string", pattern: "^[a-f0-9]{64}$" },
        correlationKey: sessionCorrelationKeyInputSchema,
        dataDirectory: { type: "string", description: "The absolute Prism plugin data directory for optional decision recording." }
      },
      required: ["projectRoot", "task"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "resolve_session_capacity",
    description: "Resolve exact capacity for an explicit session or for the same active host session identified by the hook-emitted correlation key and plugin data directory. Active resolution fails closed when hook facts are unavailable, stale, mismatched, or do not attest an exact total-session threshold.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root. Active mode requires this value when the host does not provide it." },
        session: sessionInputSchema
      },
      required: ["session"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "evaluate_repository_fit",
    description: "Resolve supported target-session capacity and compare a repository context estimate with its adjustable read budget. Returns FIT, SPLIT, UNCERTAIN, or UNSUPPORTED with capacity provenance.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root. Active mode requires this value when the host does not provide it." },
        session: sessionInputSchema,
        costs: {
          type: "object",
          additionalProperties: false,
          required: ["baseSessionContextTokens", "featureDesignContextTokens"],
          properties: {
            baseSessionContextTokens: { type: "integer", minimum: 0, maximum: 9007199254740991 },
            featureDesignContextTokens: { type: "integer", minimum: 0, maximum: 9007199254740991 },
            implementationReserveTokens: { type: "integer", minimum: 0, maximum: 9007199254740991 }
          }
        },
        tokenEstimate: {
          type: "object",
          additionalProperties: false,
          required: ["lower", "expected", "upper"],
          properties: {
            lower: { oneOf: [{ type: "integer", minimum: 0, maximum: 9007199254740991 }, { type: "null" }] },
            expected: { oneOf: [{ type: "integer", minimum: 0, maximum: 9007199254740991 }, { type: "null" }] },
            upper: { oneOf: [{ type: "integer", minimum: 0, maximum: 9007199254740991 }, { type: "null" }] }
          }
        }
      },
      required: ["session", "costs", "tokenEstimate"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "summarize_session_consumption",
    description: "Summarize content-free repository context observations before the first successful edit in the same active host session identified by the hook-emitted correlation key and plugin data directory. Missing or incomplete instrumentation stays explicit.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        correlationKey: sessionCorrelationKeyInputSchema,
        dataDirectory: { type: "string", minLength: 1, description: "The absolute Prism plugin data directory emitted by the enabled session hook." }
      },
      required: ["projectRoot", "correlationKey", "dataDirectory"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "set_workflow_recording",
    description: "Enable or disable local decision recording for one project. Recording is disabled by default.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        dataDirectory: { type: "string" },
        enabled: { type: "boolean" }
      },
      required: ["projectRoot", "dataDirectory", "enabled"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "read_workflow_decisions",
    description: "Read local ordered decision records and explicit coverage gaps for one project.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        dataDirectory: { type: "string" },
        correlationKey: sessionCorrelationKeyInputSchema,
        statePath: { type: "string" },
        recoveryPaths: { type: "array", items: { type: "string" } }
      },
      required: ["projectRoot", "dataDirectory"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "record_workflow_decision",
    description: "Record a structured design or review checkpoint without prompts or source text.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        dataDirectory: { type: "string" },
        correlationKey: sessionCorrelationKeyInputSchema,
        decision: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "outcome"],
          properties: {
            kind: { type: "string", enum: ["design_fit", "review"] },
            outcome: { type: "string", enum: ["FIT", "SPLIT", "BLOCKED", "CLEAN", "FINDINGS"] },
            reasonCodes: { type: "array", items: { type: "string" } },
            evidencePaths: { type: "array", items: { type: "string" } },
            counts: { type: "object", additionalProperties: false, properties: { elements: { type: "integer" }, links: { type: "integer" }, notes: { type: "integer" } } },
            readability: { type: "string", enum: ["readable", "difficult", "unreadable", "not_assessed"] },
            splitAssessment: { type: "string", enum: ["split", "keep", "undecided"] },
            findingIds: { type: "array", items: { type: "string" } },
            reviewPhase: { type: "string", enum: ["design_audit", "implementation_review", "security_review"] },
            dispositions: { type: "array", items: { type: "string" } },
            agentLabel: { type: "string" }
          }
        }
      },
      required: ["projectRoot", "dataDirectory", "decision"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "checkpoint_pause",
    description: "Write the active slice recovery note and update coordination state under one revision lock.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        statePath: { type: "string" },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "null" }] },
        activeSlice: { type: "string" },
        recoveryPath: { type: "string" },
        recoveryContent: { type: "string", maxLength: 65536 },
        changes: {
          type: "object", additionalProperties: false,
          properties: {
            active: { type: "array", items: { type: "object" } },
            pending: { type: "array", items: { type: "string" } },
            next: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } }
          }
        },
        dataDirectory: { type: "string" },
        correlationKey: sessionCorrelationKeyInputSchema
      },
      required: ["projectRoot", "statePath", "expectedRevision", "activeSlice", "recoveryPath", "recoveryContent", "changes"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_coordination_state",
    description: "Read the initiative coordination state from state.json. Use this tool instead of reading and parsing the file manually. The statePath must be relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." }
      },
      required: ["projectRoot", "statePath"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "validate_coordination_state",
    description: "Validate an initiative state.json file without changing it. Use this tool before recovery or when a state update reports invalid data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." }
      },
      required: ["projectRoot", "statePath"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_coordination_state",
    description: "Apply a validated atomic update to an initiative state.json file. Read the current state first and pass its revision as expectedRevision. Do not edit state.json directly when this tool is available.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "null" }], description: "The revision returned by get_coordination_state, or null when creating a missing state file." },
        changes: {
          type: "object",
          description: "Managed fields to replace in one atomic update. Settings merge with existing settings, while arrays replace their current values.",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            settings: {
              type: "object",
              additionalProperties: false,
              properties: {
                autonomy: { type: "string", enum: ["conservative", "broad", "full"] },
                agentFlow: { type: "string", enum: ["mono", "multi"] },
                commit: { type: "string", enum: ["on", "off"] },
                push: { type: "string", enum: ["on", "off"] },
                continuation: { type: "string", enum: ["auto", "stepwise"] },
                models: {
                  oneOf: [
                    { type: "string", enum: ["defaults", "host defaults"] },
                    {
                      type: "object",
                      required: ["delivery", "review", "securityReview"],
                      additionalProperties: false,
                      properties: {
                        delivery: { type: "string", minLength: 1 },
                        review: { type: "string", minLength: 1 },
                        securityReview: { type: "string", minLength: 1 }
                      }
                    }
                  ]
                }
              }
            },
            activeOperations: ACTIVE_OPERATIONS_SCHEMA,
            active: {
              type: "array",
              items: {
                type: "object",
                required: ["slice", "activity", "workers", "workspace"],
                additionalProperties: false,
                properties: {
                  slice: { type: "string", minLength: 1 },
                  activity: { type: "string", minLength: 1 },
                  workers: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                  workspace: { type: "string", minLength: 1 },
                  reviewLanes: { type: "array" },
                  findingsPath: { type: "string", minLength: 1 }
                }
              }
            },
            pending: { type: "array", items: { type: "string", minLength: 1 } },
            next: { type: "array", items: { type: "string", minLength: 1 } },
            evidence: { type: "array", items: { type: "string", minLength: 1 } }
          }
        }
      },
      required: ["projectRoot", "statePath", "expectedRevision", "changes"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

const stateTools = new Set(["get_coordination_state", "validate_coordination_state", "update_coordination_state", "checkpoint_pause"]);
const repositoryTools = new Set([...NATIVE_INTELLIGENCE_TOOLS.map(tool => tool.name), "list_repository_intelligence_providers", "plan_repository_context", "resolve_session_capacity", "evaluate_repository_fit", "summarize_session_consumption", "set_workflow_recording", "read_workflow_decisions", "record_workflow_decision"]);

async function callStateTool(name, argumentsValue) {
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const input = { ...argumentsValue, projectRoot };
  let resultValue;
  if (name === "get_coordination_state") {
    resultValue = await readCoordinationState(input);
  } else if (name === "validate_coordination_state") {
    resultValue = await validateCoordinationState(input);
  } else if (name === "update_coordination_state") {
    resultValue = await updateCoordinationState(input);
  } else if (name === "checkpoint_pause") {
    resultValue = await checkpointPause(input);
    const dataDirectory = decisionDataDirectory(argumentsValue);
    if (dataDirectory) {
      const recording = await recordAutomaticDecision({ projectRoot, dataDirectory, correlationKey: argumentsValue.correlationKey,
        decision: { kind: "pause", outcome: "PAUSED", evidencePaths: [resultValue.recoveryPath, resultValue.statePath], stateRevision: resultValue.revision,
          recoveryDigest: resultValue.recoveryDigest, activeSlices: [argumentsValue.activeSlice] } });
      resultValue = { ...resultValue, decisionRecording: recording };
    }
  } else {
    throw new Error(`Unknown state tool: ${name}`);
  }
  return { content: [{ type: "text", text: stateContent(resultValue) }], structuredContent: resultValue };
}

async function callRepositoryTool(name, argumentsValue) {
  if (NATIVE_INTELLIGENCE_TOOLS.some(tool => tool.name === name)) {
    const schema = NATIVE_INTELLIGENCE_TOOLS.find(tool => tool.name === name).inputSchema;
    assertInput(schema, argumentsValue);
    try { assertExactToolArguments(argumentsValue, Object.keys(schema.properties), schema.required, `${name} arguments`); }
    catch (error) { error.code = "validation_failed"; throw error; }
    const projectRoot = await requestedProjectRoot(argumentsValue).catch(error => { error.code = "invalid_path"; throw error; });
    let value = name === "search_repository_concepts" ? await searchRepositoryConcepts({ ...argumentsValue, projectRoot }) : await nativeSemanticRuntime.status(projectRoot, argumentsValue.waitMs);
    if (name !== "search_repository_concepts") {
      const diagnostics = value.diagnostics || [], offset = argumentsValue.offset || 0, limit = argumentsValue.limit || 20;
      value = { ...value, diagnostics: diagnostics.slice(offset, offset + limit), totalDiagnostics: diagnostics.length, nextOffset: offset + limit < diagnostics.length ? offset + limit : null };
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
  if (name === "set_workflow_recording") {
    assertExactToolArguments(argumentsValue, ["projectRoot", "dataDirectory", "enabled"], ["projectRoot", "dataDirectory", "enabled"], "set_workflow_recording arguments");
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const result = await setDecisionRecording({ projectRoot, dataDirectory: decisionDataDirectory(argumentsValue), enabled: argumentsValue.enabled });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  if (name === "read_workflow_decisions") {
    assertExactToolArguments(argumentsValue, ["projectRoot", "dataDirectory", "correlationKey", "statePath", "recoveryPaths"], ["projectRoot", "dataDirectory"], "read_workflow_decisions arguments");
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const result = await readDecisionHistory({ projectRoot, dataDirectory: decisionDataDirectory(argumentsValue), correlationKey: argumentsValue.correlationKey, statePath: argumentsValue.statePath, recoveryPaths: argumentsValue.recoveryPaths });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  if (name === "record_workflow_decision") {
    assertExactToolArguments(argumentsValue, ["projectRoot", "dataDirectory", "correlationKey", "decision"], ["projectRoot", "dataDirectory", "decision"], "record_workflow_decision arguments");
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const result = await appendDecision({ projectRoot, dataDirectory: decisionDataDirectory(argumentsValue), correlationKey: argumentsValue.correlationKey, decision: argumentsValue.decision, source: "agent_checkpoint" });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  if (name === "summarize_session_consumption") {
    assertExactToolArguments(argumentsValue, ["projectRoot", "correlationKey", "dataDirectory"], ["projectRoot", "correlationKey", "dataDirectory"], "summarize_session_consumption arguments");
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const summary = await summarizeSessionConsumption({
      dataDirectory: argumentsValue.dataDirectory || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA,
      correlationKey: argumentsValue.correlationKey,
      projectRoot
    });
    return { content: [{ type: "text", text: sessionConsumptionContent(summary) }], structuredContent: summary };
  }
  if (name === "resolve_session_capacity") {
    assertExactToolArguments(argumentsValue, ["projectRoot", "session"], ["session"], "resolve_session_capacity arguments");
    let capacity;
    if (argumentsValue.session?.mode === "active") {
      const projectRoot = await requestedProjectRoot(argumentsValue);
      capacity = await resolveActiveSessionCapacity(activeCapacityRequest(argumentsValue, projectRoot));
    } else {
      capacity = resolveSessionCapacity(argumentsValue.session);
    }
    return { content: [{ type: "text", text: sessionCapacityContent(capacity) }], structuredContent: capacity };
  }
  if (name === "evaluate_repository_fit") {
    assertExactToolArguments(
      argumentsValue,
      ["projectRoot", "session", "costs", "tokenEstimate"],
      ["session", "costs", "tokenEstimate"],
      "evaluate_repository_fit arguments"
    );
    let fit;
    if (argumentsValue.session?.mode === "active") {
      const projectRoot = await requestedProjectRoot(argumentsValue);
      fit = await evaluateActiveRepositoryFit({
        costs: argumentsValue.costs,
        tokenEstimate: argumentsValue.tokenEstimate
      }, activeCapacityRequest(argumentsValue, projectRoot));
    } else {
      fit = evaluateRepositoryFit({
        session: argumentsValue.session,
        costs: argumentsValue.costs,
        tokenEstimate: argumentsValue.tokenEstimate
      });
    }
    const dataDirectory = argumentsValue.session?.dataDirectory || decisionDataDirectory(argumentsValue);
    if (dataDirectory) {
      const recording = await recordAutomaticDecision({
        projectRoot: await requestedProjectRoot(argumentsValue), dataDirectory,
        correlationKey: argumentsValue.session?.correlationKey,
        decision: { kind: "repository_fit", outcome: fit.fit || "UNSUPPORTED", reasonCodes: fit.reasonCode ? [String(fit.reasonCode).toLowerCase().replace(/[^a-z0-9_-]/g, "_")] : [], estimate: argumentsValue.tokenEstimate }
      });
      if (recording.status === "unavailable") fit = { ...fit, decisionRecording: recording };
    }
    return { content: [{ type: "text", text: repositoryFitContent(fit) }], structuredContent: fit };
  }
  if (name === "list_repository_intelligence_providers") {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const providers = await listRepositoryIntelligenceProviders(projectRoot);
    return { content: [{ type: "text", text: providerListContent(providers) }], structuredContent: { providers, native: await nativeSemanticRuntime.status(projectRoot) } };
  }
  if (name === "plan_repository_context") {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    let native;
    if (["auto", "native"].includes(argumentsValue.provider || "auto")) {
      native = await prepareNativeProvider(projectRoot, { expectedSnapshot: argumentsValue.expectedSnapshot });
      if (native.preparation.status === "preparing") {
        const value = { ...native.preparation, prepared: undefined };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      }
    }
    let plan;
    const exclusions = [];
    try {
      plan = await withRepositoryIntelligence(projectRoot, (provider) => planRepositoryContext({
      task: argumentsValue.task,
      hints: argumentsValue.hints,
      provider,
      limits: {
        budget: argumentsValue.budget,
        searchHits: argumentsValue.searchHits,
        graphNodes: argumentsValue.graphNodes
      }
      }), { selection: argumentsValue.provider || "auto", ...(native ? { openNative: async () => native.provider } : {}), onExclusion: (item) => exclusions.push(item) });
    } catch (error) {
      const dataDirectory = decisionDataDirectory(argumentsValue);
      if (dataDirectory) await recordAutomaticDecision({ projectRoot, dataDirectory, correlationKey: argumentsValue.correlationKey,
        decision: { kind: "context_plan", outcome: "FAILURE", requestedProvider: argumentsValue.provider || "auto", reasonCodes: [String(error.code || "planning_failed").toLowerCase().replace(/[^a-z0-9_-]/g, "_")] } });
      throw error;
    }
    const dataDirectory = decisionDataDirectory(argumentsValue);
    if (dataDirectory) {
      const recording = await recordAutomaticDecision({ projectRoot, dataDirectory, correlationKey: argumentsValue.correlationKey,
        decision: contextDecision(plan, argumentsValue.provider || "auto", exclusions) });
      if (recording.status === "unavailable") plan = { ...plan, decisionRecording: recording };
    }
    return { content: [{ type: "text", text: contextPlanContent(plan) }], structuredContent: plan };
  }
  throw new Error(`Unknown repository-intelligence tool: ${name}`);
}

async function callTool(name, argumentsValue = {}, metadata) {
  if (CONSERVATION_TOOLS.some(tool => tool.name === name)) {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const value = await callConservationTool(name, { ...argumentsValue, projectRoot });
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
  if (["get_concept_delta", "update_concept_delta"].includes(name)) {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const input = { ...argumentsValue, projectRoot };
    const value = name === "get_concept_delta" ? await getConceptDelta(input) : await updateConceptDelta(input);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
  if (stateTools.has(name)) {
    return callStateTool(name, argumentsValue);
  }
  if (repositoryTools.has(name)) {
    return callRepositoryTool(name, argumentsValue);
  }
  const review = await server(argumentsValue, metadata);
  if (name === "get_review_url") {
    const tabs = requestedTabs(argumentsValue);
    if (tabs !== undefined) {
      await review.setOpenTabs(tabs);
    }
    const url = review.reviewUrl(tabs);
    return { content: [{ type: "text", text: reviewContent(url, review) }], structuredContent: { url, ...reviewSessionContent(review), certificatePath: review.certificatePath, trustInstructions: review.trustInstructions } };
  }
  if (name === "present_review") {
    const opened = await review.open(requestedTabs(argumentsValue));
    return { content: [{ type: "text", text: reviewContent(opened.url, review) }], structuredContent: { ...opened, ...reviewSessionContent(review), certificatePath: review.certificatePath, trustInstructions: review.trustInstructions } };
  }
  if (name === "list_reviewable_artifacts") {
    const artifacts = await listArtifacts(review.projectRoot);
    return { content: [{ type: "text", text: artifacts.join("\n") || "No reviewable artifacts found." }], structuredContent: { artifacts } };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      result(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "prism-review", version: pluginManifest.version }
      });
    } else if (request.method === "tools/list") {
      result(request.id, { tools });
    } else if (request.method === "tools/call") {
      result(request.id, await callTool(request.params?.name, request.params?.arguments, request.params?._meta));
    } else if (request.id !== undefined) {
      failure(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (request?.id !== undefined) {
      failure(request.id, -32603, error.message, stateErrorData(error));
    }
  }
});

input.on("close", async () => {
  nativeSemanticRuntime.close();
  await reviewServers.close();
});
