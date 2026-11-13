import { randomBytes } from "node:crypto";
import { jsonLine, readJsonLines } from "./json-lines.mjs";
import { pluginURL } from "./plugin-root.mjs";
import { errorFields, log, startProcessLog } from "./log.mjs";
import { ACTIVE_OPERATIONS_SCHEMA } from "./workflow/active-operations.mjs";
import { assertInput } from "./workflow/artifact-schema.mjs";
import { CONSERVATION_TOOLS, callConservationTool } from "./conservation/conservation-tools.mjs";
import { conservationStore } from "./conservation/conservation-store.mjs";
import { ChangeMapError, GET_CHANGE_MAP_SCHEMA, UPDATE_CHANGE_MAP_SCHEMA, getChangeMap, updateChangeMap } from "./conservation/change-map.mjs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { COMMENTS_PER_ARTIFACT_MAX, finishUnfinishedMoves, nameToolCallRoot, outsideToolCall, recordStoreOf, recordStoreSummary, restoreMigrationReports, takeMigrationReports, toolCallContext, withToolCall } from "./workflow/record-store.mjs";
import { REPOSITORY_REFUSALS } from "./workflow/repository-names.mjs";
import { confirmSavedConflicts, releaseSavedConflicts, takeSavedConflicts } from "./workflow/record-store-sync.mjs";
import { callSessionId, withCallSession } from "./workflow/slice-claims.mjs";
import { REPOSITORY_CONTEXT_INPUT_LIMITS, planRepositoryContext } from "./repository-intelligence/repository-intelligence.mjs";
import {
  listRepositoryIntelligenceProviders,
  RepositoryIntelligenceSelectionError,
  withNativeSemanticCapabilities,
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
import { readInitiativeRecordRunTotals, readReviewRunTotals } from "./session/run-totals.mjs";
import { appendDecision, readDecisionHistory, setDecisionRecording } from "./workflow/decision-history.mjs";
import { listArtifacts } from "./review/review-server.mjs";
import { createReviewServerPool } from "./review/review-server-pool.mjs";
import { opensAtStart } from "./review/open-at-start.mjs";
import { reviewAppDirectory, reviewAppDisabled } from "./review/review-app-discovery.mjs";
import { checkpointPause, readCoordinationState, updateCoordinationState, validateCoordinationState } from "./workflow/state.mjs";
import { historyMarksText, shippedHistory } from "./workflow/shipped-history.mjs";
import { INITIATIVE_TOOLS, InitiativeError, claimedByUpdate, getInitiative, initiativeAcknowledgement, initiativeWork, readInitiative, requireClaimedWork, updateInitiative } from "./workflow/initiative.mjs";
import { ROADMAP_TOOLS, RoadmapError, getRoadmap, updateRoadmap } from "./workflow/roadmap.mjs";
import { ARTIFACT_TOOLS, artifactAtLocation, getArtifact, updateArtifact } from "./workflow/store-artifacts.mjs";
import { savedComment } from "./workflow/artifact-comments.mjs";
import { keptExplanation, shownPath } from "./workflow/artifact-migration.mjs";
import { ARTIFACT_MIGRATIONS, STORE_NAME_BYTES_MAX, STORE_PATH_BYTES_MAX } from "./workflow/artifact-paths.mjs";
import { forgetAskedGates, recordAskedGates } from "./workflow/approval-deliveries.mjs";
import { VERIFY_SLICE_SCHEMA, cancelVerifications, verificationBrief, verifySlice } from "./workflow/verification.mjs";
import { configureRecordSync, handOffRecordSyncs } from "./workflow/record-store-sync.mjs";
import { stopClaimRenewals } from "./workflow/slice-claims.mjs";
import { managedStoresDirectory } from "./workflow/remote-url.mjs";
import { startChangeMapDerivation } from "./conservation/derived-change-map.mjs";
import { UPDATE_DESIGN_VIEW_SCHEMA, updateDesignView } from "./workflow/design-view.mjs";
import { DEFAULT_WAIT_MINUTES, MAX_WAIT_GATES, HOOK_WAIT_MINUTES, MAX_WAIT_MINUTES, answerText, changedText, waitForUserGates } from "./workflow/gate-wait.mjs";
import { endGateWait, keptSettingsText, personChangesText, rememberAskedGates, startGateWait, takePersonChanges } from "./workflow/change-notices.mjs";
import { callAgent, currentCallAgent, withCallAgent } from "./workflow/call-agent.mjs";
import { recordWaitRequest } from "./workflow/gate-wait-requests.mjs";
import { nativeSemanticRuntime } from "./repository-intelligence/native-semantic-runtime.mjs";
import { startBackgroundPreparation } from "./repository-intelligence/background-preparation.mjs";
import { NATIVE_INTELLIGENCE_TOOLS, findSameNameUnits, findSharedDependencies, findSharedLiterals, prepareNativeProvider, reportCohesionClusters, reportComplexUnits, reportModuleInterfaces, searchRepositoryConcepts } from "./repository-intelligence/semantic-native-provider.mjs";

// PRISM_REVIEW_APP=off keeps this session on its own review server, as tests and plugin checkouts under development need.
const reviewServers = createReviewServerPool(reviewAppDisabled() ? {} : { app: { directory: reviewAppDirectory(), evidenceDirectory: conservationStore.directory, intelligenceDirectory: nativeSemanticRuntime.directory, recordStoreDirectory: managedStoresDirectory() } });
const pluginManifest = JSON.parse(await readFile(pluginURL(".codex-plugin/plugin.json"), "utf8"));
// The host reads this process's stdout as the protocol, so the log goes to the shared Prism log file, and warnings also to stderr, which hosts keep.
startProcessLog("mcp", { version: pluginManifest.version, cwd: process.cwd() }, { mirror: true });

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
      throw new Error(`The projectRoot argument does not match the host project root ${resolvedRoot}. Pass that path, which is the directory where the session started.`);
    }
  }
  // The tool call's project root is the checkout whose first store access in this call may move its existing artifacts into the store, since this call's result reports the move.
  nameToolCallRoot(resolvedRoot);
  // A host that names no project at start, such as Codex, lists its project in the review app from its first Prism tool call.
  outsideToolCall(() => reviewServers.register(resolvedRoot));
  // The native index starts building once the project is known, so a later search finds it ready; this never waits for the build, and the build moves no artifact.
  void outsideToolCall(() => startBackgroundPreparation(resolvedRoot));
  return resolvedRoot;
}

async function server(argumentsValue, metadata) {
  const id = taskId(metadata);
  const projectRoot = await requestedProjectRoot(argumentsValue);
  return reviewServers.get(projectRoot, id);
}

// Claude Code gives its agent only the structured content of a result that has one, so the text items after the first, which carry notes such as a move report or a saved conflict,
// also go into the structured content as notes, in their order, after any notes it already holds.
function withNotesInStructure(value) {
  const structured = value?.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured) || !Array.isArray(value.content) || value.content.length < 2) return value;
  const notes = value.content.slice(1).filter((item) => item?.type === "text" && typeof item.text === "string" && item.text).map((item) => item.text);
  if (!notes.length) return value;
  return { ...value, structuredContent: { ...structured, notes: [...(Array.isArray(structured.notes) ? structured.notes : []), ...notes] } };
}

// Write a result to the host: whether the write reached standard output.
function result(id, value) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(jsonLine({ jsonrpc: "2.0", id, result: withNotesInStructure(value) }), (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
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

// An agent may name the tab group its presented tabs join, such as the piece of work they belong to.
function requestedGroup(argumentsValue) {
  return Object.hasOwn(argumentsValue, "group") ? { group: argumentsValue.group } : {};
}

// A session that fell back to its own review server tells the agent, so two review pages for one project reach the user as a known cause.
function reviewContent(url, review) {
  const fallback = review.privateServer?.();
  return fallback
    ? `Human review URL: ${url}\nThis session serves the project from its own review server, because the shared review app could not be reached: ${fallback.reason} Another session may show the same project at a different URL, so tell the user that this link belongs to this session.`
    : `Human review URL: ${url}`;
}

function stateContent(result) {
  const validity = result.valid ? "valid" : "invalid";
  const revision = result.revision ?? "none";
  const opened = `${result.openedGates?.length ? `\nOpened user gates: ${result.openedGates.map((gate) => gate.id).join(", ")}` : ""}${result.supersededGates?.length ? `\nAnswered correctness gates superseded and closed: ${result.supersededGates.join(", ")}` : ""}`;
  const answered = (result.state?.pending ?? []).filter((gate) => gate?.answer);
  const gates = `${opened}${answered.length ? `\nUser gates answered in the review browser: ${answered.map((gate) => gate.id).join(", ")}` : ""}`;
  return `Coordination state ${validity}: ${result.initiative}\nRevision: ${revision}${gates}`;
}

// A read of a shipped initiative that marked its slice documents asks to commit those in the checkout apart from the task's changes, and says that the record store shares its own.
async function historyMarksContent(projectRoot, history) {
  return history?.marked?.length ? [{ type: "text", text: await historyMarksText(projectRoot, history.initiative, history.marked) }] : [];
}

// The coordination state text of a shipped initiative carries the history message as a line of its own.
async function shippedHistoryContent(projectRoot, history) {
  return history ? [{ type: "text", text: history.message }, ...await historyMarksContent(projectRoot, history)] : [];
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
    `Compactions before first edit: ${summary.compaction.countBeforeFirstEdit}.`,
    ...runMeasuresContent(summary.runMeasures)
  ].join("\n");
}

function privateServerContent(review) {
  const fallback = review.privateServer?.();
  return fallback ? { privateServer: fallback } : {};
}

function runMeasureText({ value, coverage }) {
  return value === null ? coverage : `${value} (${coverage})`;
}

function attributedTargetText({ initiative, slice, kind, wave, designRun }) {
  if (kind === "wave") return `${initiative}/${slice} wave ${wave}`;
  if (kind === "design-run") return `${initiative}/${slice} design run ${designRun}`;
  return `${initiative}/${slice}`;
}

function attributedMeasuresText(measures) {
  return `wall ms ${runMeasureText(measures.wallTimeMs)}, active ms ${runMeasureText(measures.activeTimeMs)}, input ${runMeasureText(measures.inputTokens)}, cache-write ${runMeasureText(measures.cacheWriteTokens)}, cache-read ${runMeasureText(measures.cacheReadTokens)}, output ${runMeasureText(measures.outputTokens)}, tool calls ${runMeasureText(measures.toolCalls)}`;
}

function runTotalsText(totals) {
  return `runs ${runMeasureText(totals.runs)}, wall ms ${runMeasureText(totals.wallTimeMs)}, elapsed active ms ${runMeasureText(totals.elapsedActiveTimeMs)}, summed active ms ${runMeasureText(totals.summedActiveTimeMs)}, input ${runMeasureText(totals.inputTokens)}, cache-write ${runMeasureText(totals.cacheWriteTokens)}, cache-read ${runMeasureText(totals.cacheReadTokens)}, output ${runMeasureText(totals.outputTokens)}, tool calls ${runMeasureText(totals.toolCalls)}`;
}

function runMeasuresContent(runMeasures) {
  if (!runMeasures) return [];
  const attribution = runMeasures.attribution;
  return [
    `Run statistics collection: ${runMeasures.collection}.`,
    ...runMeasures.executions.map((row) => `Run measures ${row.execution}${row.host ? ` ${row.host}` : ""}: wall ms ${runMeasureText(row.wallTimeMs)}, active ms ${runMeasureText(row.activeTimeMs)} (idle over ${runMeasures.idleThresholdMs} ms excluded), input ${runMeasureText(row.inputTokens)}, cache-write ${runMeasureText(row.cacheWriteTokens)}, cache-read ${runMeasureText(row.cacheReadTokens)}, output ${runMeasureText(row.outputTokens)}, tool calls ${runMeasureText(row.toolCalls)}${row.ended ? ", ended" : ""}${row.belowSession ? `, below session ${row.belowSession}` : ""}.`),
    ...(attribution
      ? [
          ...attribution.targets.map((entry) => `Attributed to ${attributedTargetText(entry.target)} as ${entry.role} (${entry.attribution}): ${attributedMeasuresText(entry)}.`),
          `Unattributed: ${attributedMeasuresText(attribution.unattributed)}.`
        ]
      : []),
    ...(runMeasures.recorded ? [`Recorded run totals: ${runTotalsText(runMeasures.recorded)}.`] : []),
    ...(runMeasures.inProgress?.targets ?? []).map((entry) => `In progress for ${attributedTargetText(entry.target)} as ${entry.role} (${entry.attribution}), not yet recorded: ${attributedMeasuresText(entry)}.`)
  ];
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
  process.stdout.write(jsonLine(response));
}

function stateErrorData(error) {
  // A refused repository name carries the name the store would accept, so a client can offer the line to commit.
  if (error?.name === "RecordStoreError" && REPOSITORY_REFUSALS.includes(error.code)) {
    return { code: error.code, proposed: error.proposed ?? null };
  }
  // A configured artifact folder that would take the source tree names its key, the folder as resolved, and the component whose folder it is or holds.
  if (error?.code === "artifact_folder_invalid" && ["RecordStoreError", "ArtifactError"].includes(error?.name)) {
    return { code: error.code, key: error.key, folder: error.folder, ...(error.component === undefined ? {} : { component: error.component }) };
  }
  // A refused artifact read or update names the current version, the scopes that hold a path, the scope that already holds it, the edit that did not apply, the name that breaks the artifact name form, or the declared components.
  if (error?.name === "ArtifactError") {
    return { code: error.code, ...Object.fromEntries(["version", "scopes", "scope", "edit", "invalidName", "path", "location", "limit", "component", "components", "proposed"].filter(key => error[key] !== undefined).map(key => [key, error[key]])) };
  }
  if (error instanceof RepositoryIntelligenceSelectionError) {
    return { code: error.code, provider: error.provider, recoverable: error.recoverable };
  }
  if (error instanceof ChangeMapError) {
    return { code: error.code, ...(error.errors ? { errors: error.errors } : {}), ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) };
  }
  // A refused component declaration or design names the entry, components, dependency, cycle, slice, or crossing paths it is about,
  // an unfinished scope names the leaves it waits on, a blocked ship names each scope and its blocked dependents, an unconfirmed ship its gate and what changed after it was asked, a ship that an open approval stops each ADR and its gates,
  // a ship with open work names its gates, claims, and proposals, and a refused change to a shipped initiative names it and its ship time.
  if (error instanceof InitiativeError || error instanceof RoadmapError || ["ShippedHistoryError", "UnreadableRoadmapError", "InitiativeGraphError", "VerificationError", "SliceDesignError", "DesignViewError", "ComponentError"].includes(error?.name)) {
    return { code: error.code, ...Object.fromEntries(["errors", "problems", "currentRevision", "state", "progress", "diagnostics", "claim", "syncState", "entry", "components", "component", "dependency", "cycle", "slice", "paths", "folder", "scope", "waiting", "scopes", "afterGate", "changed", "adrs", "gates", "claims", "proposals", "fixes", "initiative", "shippedAt"].filter(key => error[key] !== undefined).map(key => [key, Array.isArray(error[key]) ? error[key].slice(0, 100) : error[key]])) };
  }
  if (error?.name !== "CoordinationStateError") {
    // A refused deferral keeps every problem, because the caller needs each finding's reason to correct the request.
    if (["validation_failed", "invalid_path", "lock_timeout", "stale_snapshot", "preparation_failed", "unsupported_runtime", "corrupt_asset", "resource_limit", "incomplete_structure", "evidence_missing", "gate_blocked", "revision_conflict", "deferral_refused"].includes(error.code)) return { code: error.code, ...Object.fromEntries(["errors", "problems", "currentRevision", "expectedSnapshot", "currentSnapshot", "evidenceId"].filter(key => error[key] !== undefined).map(key => [key, Array.isArray(error[key]) && !(error.code === "deferral_refused" && key === "problems") ? error[key].slice(0, 100) : error[key]])) };
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

// Hosts show agents the error message but not the error data, so the message also lists the problems that the data holds.
// A problem that the message already states is not listed again.
const LISTED_PROBLEMS = 20;
function errorMessage(error, data) {
  const stated = (item) => error.message.includes(typeof item === "string" ? item : item.message || "\0");
  const items = [...(Array.isArray(data?.problems) ? data.problems : []), ...(Array.isArray(data?.errors) ? data.errors : [])].filter((item) => !stated(item));
  if (!items.length) return error.message;
  const line = (item) => typeof item === "string" ? item : [item.code, item.id || item.file || item.path || item.field, item.message].filter(Boolean).join(": ") || JSON.stringify(item);
  const listed = items.slice(0, LISTED_PROBLEMS).map((item) => `- ${line(item)}`);
  if (items.length > LISTED_PROBLEMS) listed.push(`- ${items.length - LISTED_PROBLEMS} more problems are in the error data.`);
  return `${error.message}\n${listed.join("\n")}`;
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
  ...ROADMAP_TOOLS,
  ...INITIATIVE_TOOLS,
  ...ARTIFACT_TOOLS,
  {
    name: "verify_slice",
    description: "Run the project's test command from .prism/workflow.md for a slice with an accepted design, after checking that its frozen acceptance tests are unchanged, and record the run as the slice's completion evidence. A slice that records a component runs that component's Test command in the component's folder, or the repository's Test command under ## Stack in the project root when the component declares none; the root component and a slice without a component run the repository's command in the project root. Before asking for approval it refuses an invalid ## Components declaration, a recorded component the repository no longer declares with component_unknown, a missing command with test_command_missing, a working folder that does not exist with component_folder_missing, and a component folder that leads outside the project through a symbolic link with component_folder_outside. Before the command runs, a slice with a component compares the project with its content when the slice started, kept under this checkout's local ref refs/prism/<initiative>/<slice>/<checkout>/start, where <checkout> is the first 16 hexadecimal digits of the SHA-256 of the project root's real path: a change outside the component and every shared path, by the declaration recorded when the slice started, fails the run with reason component_boundary, listing the crossing paths, and the command does not run. Another slice's frozen test at its frozen content, and a path that another slice's latest passing run changed after this slice started and that still holds the content it tested, do not count, while this slice's own changes do. A slice without start content runs with boundary unchecked, and a run whose start content Git can no longer read, or was recorded while the ## Components declaration was invalid or lacked the slice's component, fails with reason start_content_missing without running the command: ask the user to fix the ## Components declaration first when the message says so, then set the slice back to not-started and start it again. Results name the command, the folder it runs in with links followed and project-relative, and the slice's component. A passing run completes a slice whose design marks no review and returns the initiative revision that write produced. The result is brief: the verdict, failing test names, the run record, and the path of the full output log. The first run of a command text in a working folder asks the user to allow it in the review browser and returns approval_needed with a gate id: wait for that gate, then call again with approvalGate. In a cloud session, where the user cannot open the review browser, approval_needed says so: ask the user in chat to allow the exact command in the folder it names, then call again with approvalGate and chatApproval quoting their answer word for word; the approval and the gate's history keep the quote, and any other session refuses chatApproval. An answer with a note and no choice returns approval_unclear and runs nothing. A host that cannot keep a long call open gets status running; calling again with the same arguments keeps waiting for the same run. An implementer that finds the contract wrong calls it with contractDefects instead: nothing runs, the defects are kept as a run entry and on the slice, and the slice is blocked until design revises the contract. With dependents true, slice names a finished fit scope (a slice whose design accepted a slice plan, or a leaf that is a scope of its own) and the call runs its dependents' run instead: the test command of every component of this repository that depends, directly or through others, on a component of the scope's leaves, each distinct command and folder once in dependency order, never a component of another repository. It refuses a slice that is not a fit scope, and contractDefects, with validation_failed, and a scope with a leaf that is not done with scope_unfinished, listing waiting; it applies the same refusals as above to each dependent, and returns no_dependents when nothing depends on the scope. One approval gate lists every command and folder not yet allowed, with the components each tests: allowing it allows each listed pair, and declining it marks their components declined while the allowed pairs still run. The run is recorded on the scope, and its result lists each dependent with its status, the blocked dependents, and each command's log; a run whose commands change project files fails with reason tracked_files_changed and blocks every dependent. update_roadmap ship refuses with dependents_blocked while a finished scope's dependents have no passing run of every one of them, or while that run started before a leaf of the scope last passed verification.",
    inputSchema: VERIFY_SLICE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "update_design_view",
    description: "Replace a designed slice's design view, which the review browser shows at the design gate: one example per acceptance test, each a single line under the number of the slice.md Contract clause it checks, restating only what the test asserts. Prism checks that each cited test name occurs in its test file and each clause number exists, lists clauses without examples as gaps, and marks the view stale when the contract or a test file changes. It also parses the PlantUML files beside slice.md and reports any that accept_design would refuse.",
    inputSchema: UPDATE_DESIGN_VIEW_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  ...CONSERVATION_TOOLS,
  ...NATIVE_INTELLIGENCE_TOOLS,
  {
    name: "get_change_map",
    description: "Read a bounded page of a slice change map, addressed by initiative and slice, through MCP. Pin expectedRevision across pages and to the audited design. Reads never create files. A slice with an accepted design has no map until its first passing verify_slice run derives one, and the missing map does not block it.",
    inputSchema: GET_CHANGE_MAP_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_change_map",
    description: "Insert, update, or remove change map entries in one validated atomic batch. Read first and pass its revision. Use null only for creation. Never edit the artifact directly. Missing addition evidence keeps drafts not ready for FIT.",
    inputSchema: UPDATE_CHANGE_MAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_review_url",
    description: "Start or update the local Prism review server and return a human review URL only. Use artifacts to open every listed artifact as a tab marked as presented by the agent, in the tab strip that every window of the review session shares, and to focus the first one; the human's open tabs stay open, and an empty array focuses Attention. This tool does not open a browser or return rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path, opened as one agent tab. Use artifacts to present several artifacts at once." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths, each opened as its own agent tab that stays open until the human closes it. An empty array focuses Attention." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "present_review",
    description: "Open or update one local Prism review page in the system browser for the human. Use artifacts to open every listed artifact as a tab marked as presented by the agent, in the tab strip that every window of the review session shares, and to focus the first one; the human's open tabs stay open. Use group to gather the presented tabs into a named tab group, such as the piece of work they belong to; presenting under the same name again adds to that group. Repeated calls update connected viewer pages without opening another tab. Omit artifact and artifacts to open Attention, which lists recorded user gates, roadmap, and library entry points. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path, opened as one agent tab. Use artifacts to present several artifacts at once." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths, each opened as its own agent tab that stays open until the human closes it. An empty array opens Attention." },
        group: { type: "string", minLength: 1, maxLength: 60, description: "A short name for the tab group the presented tabs join, such as the initiative or task they belong to. A new name makes a new group; a tab already in another group moves into this one. Omit it to leave the tabs ungrouped." }
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
    description: "List registered repository intelligence providers and their current availability for a project. This tool does not create, synchronize, or update provider indexes. In a repository that declares components, native.components lists each component's native index status.",
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
    description: "Plan bounded repository source context. Auto prepares bundled native semantic analysis, downloading pinned assets and writing private caches as needed. Returns preparing after ten seconds or source ranges with token estimates. Explicit external providers remain available. In a repository that declares components, it reads every component that holds a file, returns preparing while none is ready, and while one is not ready, the components_missing diagnostic names it and every token estimate is null. This tool does not decide session fit.",
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
    description: "Resolve exact capacity for an explicit session or for the same active host session identified by the hook-emitted correlation key and plugin data directory. Active resolution fails closed when hook facts are unavailable, stale, mismatched, or do not attest an exact total-session threshold; Claude Code active capacity is a conservative estimate marked capacityBasis ESTIMATED.",
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
    description: "Summarize content-free repository context observations before the first successful edit in the same active host session identified by the hook-emitted correlation key and plugin data directory, and report run measures (wall time, active time, input, cache-write, cache-read, and output tokens, and tool calls) for the root session and each subagent, attributed by review wave, design run, or slice and by role at each Prism call, with the cost no call attributes reported as unattributed. Finished runs are recorded first, the session's recorded runs are totaled from their run records, and the session's runs not yet recorded are reported as in progress. Missing or incomplete instrumentation stays explicit.",
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
        initiative: { type: "string", description: "The initiative whose coordination state and recovery notes to assess." },
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
        initiative: { type: "string" },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "null" }] },
        activeSlice: { type: "string" },
        recoveryContent: { type: "string", maxLength: 65536 },
        changes: {
          type: "object", additionalProperties: false,
          properties: {
            active: { type: "array", items: { type: "object" } },
            pending: { type: "array", items: { oneOf: [{ type: "string" }, { type: "object" }] } },
            next: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } }
          }
        },
        dataDirectory: { type: "string" },
        correlationKey: sessionCorrelationKeyInputSchema
      },
      required: ["projectRoot", "initiative", "expectedRevision", "activeSlice", "recoveryContent", "changes"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_coordination_state",
    description: "Read an initiative's coordination state record with its revision. Reads never create the record. A shipped initiative, also one without a record, adds shippedHistory: { initiative, shippedAt, message, documents, changedAfterShip, laterFixes }, where documents lists the slice documents its ship decision recorded, changedAfterShip each one changed, removed, or added since, ignoring the history mark, and laterFixes each roadmap entry whose corrects names the initiative ({ initiative, title, state, slices }, in roadmap order); the first read of an initiative that shipped before its documents were recorded records them, writes the history mark into each, and lists them under marked; a document in the checkout is to be committed apart from the task's changes, while one in the record store is shared by its sync and needs no commit. The text carries its message as a line.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        initiative: { type: "string", description: "The initiative identifier, which names its plans folder." }
      },
      required: ["projectRoot", "initiative"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "validate_coordination_state",
    description: "Validate an initiative's coordination state without changing it. Use this tool before recovery or when a state update reports invalid data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        initiative: { type: "string", description: "The initiative identifier, which names its plans folder." }
      },
      required: ["projectRoot", "initiative"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "wait_for_user_gate",
    description: "Wait until the user answers recorded user gates in the review browser, then return the answers. Call it once right after asking the user and recording the gates, with every gate id just recorded; after the first answer it waits briefly for answers to the others. The call can last hours; Claude Code moves it to the background after about two minutes, and its result wakes the session when the user answers. On Codex it returns deferred at once, and a Stop hook continues the session with the answer after the turn ends. It returns answered with the recorded answer, changed with the person's new history entries when the person changes the initiative in the review app, whether here or through a store sync, resolved when the gate was removed (answered in the conversation or withdrawn), timeout, unknown_gate, deferred, or unsupported_host when this host can wait neither in the background nor after the turn. For the approval gates that update_artifact ask_approval records on a requirement or ADR, pass artifact, its project-relative path, and scope when two scopes hold it, in place of initiative; an answered approval gate needs no resolve.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        initiative: { type: "string", description: "The initiative whose coordination state holds the gates." },
        artifact: { type: "string", minLength: 1, description: "In place of initiative: the project-relative path of the requirement or ADR whose approval gates to wait on." },
        scope: { type: "string", minLength: 1, description: "With artifact, when two scopes hold its path: workspace, repository, or a scope label such as <repository>/<component>." },
        gateIds: { type: "array", minItems: 1, maxItems: MAX_WAIT_GATES, items: { type: "string", minLength: 1 }, description: "The gate ids that the ask operations returned." },
        gateId: { type: "string", minLength: 1, description: "One gate id; use gateIds for several." },
        maxWaitMinutes: { type: "number", exclusiveMinimum: 0, maximum: MAX_WAIT_MINUTES, description: `How long to wait before returning timeout. Defaults to ${DEFAULT_WAIT_MINUTES}.` }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "update_coordination_state",
    description: "Apply a validated atomic update to an initiative's coordination state, including pending user gates that the review browser lists as waiting on the user. Read the current state first and pass its revision as expectedRevision; an update that only resolves gates by id goes through after other changes, such as the browser answer that prompted it.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        initiative: { type: "string", description: "The initiative identifier, which names its plans folder." },
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
                commit: { type: "string", enum: ["on", "off"] },
                push: { type: "string", enum: ["on", "off"] },
                continuation: { type: "string", enum: ["auto", "stepwise"] },
                review: { type: "string", enum: ["marked", "recommended", "all"] },
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
                        securityReview: { type: "string", minLength: 1 },
                        examples: { type: "string", minLength: 1 }
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
            gateOperations: {
              type: "array",
              description: "Record a user gate with ask before asking the user, and remove it with resolve after acting on the user's answer, giving a reason when the gate has no browser answer and, for a decision gate answered in the conversation, the chosen option's id as choice. The user may answer in the conversation or in the review browser, which records the answer on the gate in state.pending. Asking a correctness gate supersedes each earlier correctness gate of the initiative that the person already answered: it closes with a reason naming the new gate, which the review browser shows with the closed question, while an unanswered one stays pending. The result lists the ids of opened gates, and of superseded gates under supersededGates.",
              items: {
                oneOf: [
                  {
                    type: "object",
                    required: ["op", "kind", "question", "artifacts"],
                    additionalProperties: false,
                    properties: {
                      op: { const: "ask" },
                      kind: { type: "string", enum: ["visual-review", "correctness", "decision", "assistance"] },
                      slice: { type: "string", minLength: 1 },
                      question: { type: "string", minLength: 1, maxLength: 4000, description: "The question itself, one or two plain sentences." },
                      context: { type: "string", minLength: 1, maxLength: 8000, description: "Markdown the person reads before answering: what happened, what was tried, what the choice changes, and a concrete example. Required for decision and assistance gates, so a person who has not followed the run can decide from the gate alone." },
                      artifacts: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
                      options: {
                        type: "array",
                        minItems: 1,
                        maxItems: 8,
                        description: "Choices the user can pick in the review browser; decision gates only, each with the consequence of picking it.",
                        items: { type: "object", required: ["id", "label", "consequence"], additionalProperties: false, properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }, label: { type: "string", minLength: 1, maxLength: 200 }, consequence: { type: "string", minLength: 1, maxLength: 300, description: "One sentence on what happens if the person picks this option." } } }
                      },
                      recommended: {
                        type: "object",
                        required: ["reason"],
                        additionalProperties: false,
                        description: "Required for decision gates: the answer you recommend, as one of the options when the gate has options, and why.",
                        properties: { option: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }, reason: { type: "string", minLength: 1, maxLength: 500 } }
                      }
                    }
                  },
                  {
                    type: "object",
                    required: ["op", "id"],
                    additionalProperties: false,
                    properties: { op: { const: "resolve" }, id: { type: "string", minLength: 1 }, choice: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "For a decision gate the user answered in the conversation: the id of the option they chose, which the closed gate keeps as choice. A gate the user answered in the review browser accepts only the option of that answer." }, reason: { type: "string", minLength: 1, maxLength: 1000, description: "Required for an unanswered gate: the user's answer in the conversation, or why the question no longer applies. The review browser shows it with the closed question." } }
                  }
                ]
              }
            },
            pending: { type: "array", items: { oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] } },
            next: { type: "array", items: { type: "string", minLength: 1 } },
            evidence: { type: "array", items: { type: "string", minLength: 1 } }
          }
        }
      },
      required: ["projectRoot", "initiative", "expectedRevision", "changes"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

const stateTools = new Set(["get_coordination_state", "validate_coordination_state", "update_coordination_state", "checkpoint_pause"]);
// Only Claude Code was shown to move a long call to the background and wake the session with its result; other hosts would block the turn.
const BACKGROUND_WAIT_CLIENTS = /claude/i;
const FIRST_BACKGROUND_VERSION = [2, 1, 212];
const DEFAULT_BACKGROUND_MS = 120000;
const pendingWaits = new Map();
// The gate waits that run, so closing awaits each one letting go of its gates.
const endingWaits = new Set();
// A deferred wait's gates stay held this long for the Stop hook's wait to start and renew them.
const DEFERRED_HOLD_MS = 2 * 60000;
let clientName = null;
let clientVersion = null;

function olderThan(version, minimum) {
  const parts = String(version ?? "").split(/[.-]/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] < minimum[index];
  }
  return false;
}

// A wait only helps when the host moves it to the background before its own tool timeout cancels it.
function waitUnsupportedReason() {
  if (!BACKGROUND_WAIT_CLIENTS.test(clientName ?? "")) return `The host ${clientName ?? "(unnamed)"} does not move long tool calls to the background.`;
  if (olderThan(clientVersion, FIRST_BACKGROUND_VERSION)) return `Claude Code ${clientVersion} predates background tool calls (2.1.212).`;
  const handoff = Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS ?? DEFAULT_BACKGROUND_MS);
  if (["1", "true"].includes(String(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toLowerCase()) || handoff === 0) return "Background tool calls are disabled in this Claude Code session.";
  const timeout = Number(process.env.MCP_TOOL_TIMEOUT);
  if (Number.isFinite(timeout) && timeout > 0 && timeout <= handoff) return `MCP_TOOL_TIMEOUT (${timeout} ms) ends the call before Claude Code moves it to the background (${handoff} ms).`;
  return null;
}

function progress(progressToken, value, message) {
  process.stdout.write(jsonLine({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: value, message } }));
}

// An approval answer reaches only the checkout whose ask_approval recorded its gate, which this machine remembers; a get_artifact read that returns the answer
// as latestAnswer is one way that checkout receives it. Failing to remember never fails the call, whose store change already happened.
async function noteApprovalDelivery(name, projectRoot, value) {
  try {
    if (name === "update_artifact") await recordAskedGates(projectRoot, (value.artifacts ?? []).map((entry) => entry.gate).filter((gate) => typeof gate === "string"));
    else if (typeof value.latestAnswer?.gate === "string") await forgetAskedGates(projectRoot, [value.latestAnswer.gate]);
  } catch {
  }
}

async function callGateWait(argumentsValue, metadata, requestId) {
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const gateIds = argumentsValue.gateIds ?? (argumentsValue.gateId === undefined ? undefined : [argumentsValue.gateId]);
  if (!Array.isArray(gateIds) || !gateIds.length) {
    throw new Error("Pass the recorded gate ids in gateIds.");
  }
  // A wait names the initiative whose coordination state holds the gates, or the artifact whose status record holds them.
  const source = typeof argumentsValue.artifact === "string" && argumentsValue.artifact
    ? { artifact: argumentsValue.artifact, ...(argumentsValue.scope === undefined ? {} : { scope: argumentsValue.scope }) }
    : { initiative: argumentsValue.initiative };
  if (source.artifact === undefined && (typeof source.initiative !== "string" || !source.initiative)) {
    throw new Error("Pass initiative, the initiative whose coordination state holds the gates, or artifact, the requirement or ADR whose approval gates to wait on.");
  }
  let value;
  const unsupported = waitUnsupportedReason();
  const hookSession = callSessionId(metadata);
  // Only the initiative's coordinator when the wait starts has it end on the person's changes; one step of the session tells whether it coordinates and which entries it holds at its start.
  // Every wait that names an initiative holds its gates in the session's notice record while it runs, so their answers reach the agent once, in its result, whichever agent waited.
  // An artifact wait holds no gates there, since its gates live in the artifact's status record.
  const initiative = source.initiative;
  const notices = typeof initiative === "string" ? {} : null;
  const start = notices && !(unsupported && !hookSession)
    ? await startGateWait({ projectRoot, initiative, agent: currentCallAgent() }).catch(() => ({ coordinates: false, known: null }))
    : { coordinates: false, known: null };
  const coordinates = start.coordinates;
  const knownEntries = Array.isArray(start.known) ? start.known : undefined;
  if (unsupported && hookSession) {
    // Codex names its session in the call's metadata, and its Stop hook for that session waits once this turn ends.
    // The gates stay held for a short lease, which the polls of the hook's wait, under the same wait id, renew.
    const waitId = randomBytes(16).toString("hex");
    const held = notices && { ...notices, waitId, hold: Date.now() + DEFERRED_HOLD_MS };
    value = await waitForUserGates({ projectRoot, ...source, gateIds, maxWaitMinutes: 0.0001, settleMs: 0, knownEntries, notices: held, watchChanges: coordinates });
    if (value.status === "timeout") {
      const maxWaitMinutes = Math.min(argumentsValue.maxWaitMinutes ?? DEFAULT_WAIT_MINUTES, HOOK_WAIT_MINUTES);
      const { replaced } = await recordWaitRequest({ sessionId: hookSession, projectRoot, ...source, gateIds: value.gateIds, maxWaitMinutes, knownEntries, coordinates, ...(held ? { waitId } : {}) });
      // The request this one replaced never reaches the hook, so its wait lets go of its gates.
      if (replaced) await endGateWait({ ...replaced, cancelled: true }).catch(() => {});
      value = { status: "deferred", gateIds: value.gateIds, client: clientName, maxWaitMinutes };
    }
  } else if (unsupported) {
    value = { status: "unsupported_host", gateIds, client: clientName, reason: unsupported };
  } else {
    const controller = new AbortController();
    if (requestId !== undefined) pendingWaits.set(requestId, controller);
    const progressToken = metadata?.progressToken;
    try {
      const running = waitForUserGates({
        projectRoot,
        ...source,
        gateIds,
        maxWaitMinutes: argumentsValue.maxWaitMinutes ?? DEFAULT_WAIT_MINUTES,
        signal: controller.signal,
        knownEntries,
        notices,
        watchChanges: coordinates,
        heartbeatMs: Number(process.env.PRISM_GATE_WAIT_HEARTBEAT_MS) || 60000,
        settleMs: process.env.PRISM_GATE_WAIT_SETTLE_MS === undefined ? undefined : Number(process.env.PRISM_GATE_WAIT_SETTLE_MS),
        onProgress: progressToken === undefined ? undefined : (seconds) => progress(progressToken, seconds, "Waiting for the user's answer in the review browser")
      });
      endingWaits.add(running);
      try {
        value = await running;
      } finally {
        endingWaits.delete(running);
      }
    } finally {
      pendingWaits.delete(requestId);
    }
  }
  const list = value.gateIds.join(", ");
  const text = {
    changed: () => changedText(value),
    answered: () => [...value.answered.map(answerText), value.waiting.length ? `Still waiting on: ${value.waiting.join(", ")}.` : ""].filter(Boolean).join("\n"),
    resolved: () => source.artifact ? `Approval gates ${list} of ${source.artifact} closed without an answer: a later ask_approval replaced them, or the artifact was removed or left the scopes this checkout sees.` : `User gates ${list} were resolved without a browser answer; they were answered in the conversation or withdrawn.`,
    timeout: () => `No answer arrived for user gates ${list} before the wait ended.`,
    unknown_gate: () => `No pending user gate has any of the ids ${list}.`,
    deferred: () => `This host cannot wait during a tool call, so Prism waits after this turn ends: end your turn now, and the session continues with the answer when the user answers user gates ${list} in the review browser within ${value.maxWaitMinutes} minutes. If it does not continue, the user's next message delivers any browser answer.`,
    unsupported_host: () => `The wait returned at once because it cannot run in the background here: ${value.reason} The user's next message delivers any browser answer.`,
    cancelled: () => `The wait for user gates ${list} was cancelled.`
  }[value.status]();
  return { content: [{ type: "text", text }], structuredContent: value };
}
const repositoryTools = new Set([...NATIVE_INTELLIGENCE_TOOLS.map(tool => tool.name), "list_repository_intelligence_providers", "plan_repository_context", "resolve_session_capacity", "evaluate_repository_fit", "summarize_session_consumption", "set_workflow_recording", "read_workflow_decisions", "record_workflow_decision"]);

// A record tool's result in a project with a record store names the store, so an agent never takes recordPath for a file in the checkout.
async function withRecordStore(projectRoot, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const recordStore = await recordStoreSummary(projectRoot).catch(() => null);
  return recordStore ? { ...value, recordStore } : value;
}

async function callStateTool(name, argumentsValue) {
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const input = { ...argumentsValue, projectRoot };
  let resultValue;
  if (name === "get_coordination_state") {
    resultValue = await readCoordinationState(input);
    const history = await shippedHistory(projectRoot, argumentsValue.initiative);
    if (history) resultValue = { ...resultValue, shippedHistory: history };
  } else if (name === "validate_coordination_state") {
    resultValue = await validateCoordinationState(input);
  } else if (name === "update_coordination_state") {
    resultValue = await updateCoordinationState(input);
    // The prompt hooks deliver a gate's answer only to the session that asked it; a gate the session cannot remember is still answered through its wait or a read of the state.
    const opened = (resultValue?.openedGates ?? []).map((gate) => gate?.id).filter((id) => typeof id === "string");
    await rememberAskedGates({ projectRoot, initiative: argumentsValue.initiative, gateIds: opened }).catch((error) => log.warn("asked_gates_unrecorded", errorFields(error)));
  } else if (name === "checkpoint_pause") {
    resultValue = await checkpointPause(input);
    const dataDirectory = decisionDataDirectory(argumentsValue);
    if (dataDirectory) {
      const recording = await recordAutomaticDecision({ projectRoot, dataDirectory, correlationKey: argumentsValue.correlationKey,
        decision: { kind: "pause", outcome: "PAUSED", evidencePaths: [resultValue.recoveryPath], stateRevision: resultValue.revision,
          recoveryDigest: resultValue.recoveryDigest, activeSlices: [argumentsValue.activeSlice] } });
      resultValue = { ...resultValue, decisionRecording: recording };
    }
  } else {
    throw new Error(`Unknown state tool: ${name}`);
  }
  if (name === "get_coordination_state" || name === "update_coordination_state") resultValue = await withRecordStore(projectRoot, resultValue);
  // Closed gates are history for the review browser; agents never need them.
  if (resultValue?.state?.closed) {
    const { closed, ...state } = resultValue.state;
    resultValue = { ...resultValue, state };
  }
  const content = [{ type: "text", text: stateContent(resultValue) }, ...await shippedHistoryContent(projectRoot, resultValue?.shippedHistory)];
  if (Array.isArray(resultValue?.keptSettings) && resultValue.keptSettings.length) content.push({ type: "text", text: keptSettingsText(resultValue.keptSettings) });
  return { content, structuredContent: resultValue };
}

async function callRepositoryTool(name, argumentsValue) {
  // Agents often write a directory as "src/", so a trailing slash is dropped before the strict path checks.
  if (Array.isArray(argumentsValue?.filters?.paths)) argumentsValue = { ...argumentsValue, filters: { ...argumentsValue.filters, paths: argumentsValue.filters.paths.map(value => typeof value === "string" && value.length > 1 ? value.replace(/\/+$/, "") : value) } };
  if (NATIVE_INTELLIGENCE_TOOLS.some(tool => tool.name === name)) {
    const schema = NATIVE_INTELLIGENCE_TOOLS.find(tool => tool.name === name).inputSchema;
    assertInput(schema, argumentsValue);
    try { assertExactToolArguments(argumentsValue, Object.keys(schema.properties), schema.required, `${name} arguments`); }
    catch (error) { error.code = "validation_failed"; throw error; }
    const projectRoot = await requestedProjectRoot(argumentsValue).catch(error => { error.code = "invalid_path"; throw error; });
    let value = name === "search_repository_concepts" ? await searchRepositoryConcepts({ ...argumentsValue, projectRoot })
      : name === "find_shared_dependencies" ? await findSharedDependencies({ ...argumentsValue, projectRoot })
      : name === "report_module_interfaces" ? await reportModuleInterfaces({ ...argumentsValue, projectRoot })
      : name === "find_shared_literals" ? await findSharedLiterals({ ...argumentsValue, projectRoot })
      : name === "report_cohesion_clusters" ? await reportCohesionClusters({ ...argumentsValue, projectRoot })
      : name === "find_same_name_units" ? await findSameNameUnits({ ...argumentsValue, projectRoot })
      : name === "report_complex_units" ? await reportComplexUnits({ ...argumentsValue, projectRoot })
      : await nativeSemanticRuntime.status(projectRoot, argumentsValue.waitMs);
    if (!["search_repository_concepts", "find_shared_dependencies", "report_module_interfaces", "find_shared_literals", "report_cohesion_clusters", "find_same_name_units", "report_complex_units"].includes(name)) {
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
    assertExactToolArguments(argumentsValue, ["projectRoot", "dataDirectory", "correlationKey", "initiative", "recoveryPaths"], ["projectRoot", "dataDirectory"], "read_workflow_decisions arguments");
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const result = await readDecisionHistory({ projectRoot, dataDirectory: decisionDataDirectory(argumentsValue), correlationKey: argumentsValue.correlationKey, initiative: argumentsValue.initiative, recoveryPaths: argumentsValue.recoveryPaths });
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
    const native = await nativeSemanticRuntime.status(projectRoot), diagnostics = native.diagnostics || [];
    const providers = withNativeSemanticCapabilities(await listRepositoryIntelligenceProviders(projectRoot), native);
    // get_repository_intelligence_status pages the complete diagnostics.
    return { content: [{ type: "text", text: providerListContent(providers) }],
      structuredContent: { providers, native: { ...native, diagnostics: diagnostics.slice(0, 20), totalDiagnostics: diagnostics.length } } };
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

// Hosts that cannot keep a long call open get an early running answer before their own tool timeout, and call again to keep waiting.
const VERIFY_EARLY_RETURN_MS = 45000;

async function callVerifySlice(argumentsValue, metadata, requestId) {
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const controller = new AbortController();
  if (requestId !== undefined) pendingWaits.set(requestId, controller);
  const progressToken = metadata?.progressToken;
  try {
    const value = await verifySlice({
      ...argumentsValue,
      projectRoot,
      signal: controller.signal,
      maxWaitMs: waitUnsupportedReason() ? Number(process.env.PRISM_VERIFY_EARLY_RETURN_MS) || VERIFY_EARLY_RETURN_MS : Infinity,
      onProgress: progressToken === undefined ? undefined : (seconds) => progress(progressToken, seconds, `Running the test command (${seconds} s)`)
    });
    // A passing run with a source snapshot gets its change map derived in the background, so the review browser can show it.
    if (value.status === "passed" && value.snapshotId) startChangeMapDerivation({ projectRoot, initiative: argumentsValue.initiative, slice: argumentsValue.slice });
    const brief = verificationBrief(value);
    const { outputTail, ...summary } = brief;
    const text = [brief.message ?? `Verification ${brief.status}.`, JSON.stringify(summary), outputTail ? `Output tail:\n${outputTail}` : ""].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }], structuredContent: brief };
  } finally {
    pendingWaits.delete(requestId);
  }
}

// The first write after an upgrade moves files in the user's work tree, so its result says which, to commit on their own.
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

// A saved artifact named as the checkout names it, by its path and scope label, or by its store location when the checkout gives it no path.
async function savedArtifactLine(item, argumentsValue) {
  return `- ${await savedArtifactWhere(item.store, item.location, argumentsValue)} (this machine's version: ${item.savedAs})`;
}

async function savedArtifactWhere(store, location, argumentsValue) {
  const projectRoot = await requestedProjectRoot(argumentsValue ?? {}).catch(() => null);
  const named = projectRoot ? await artifactAtLocation(projectRoot, store, location).catch(() => null) : null;
  return named?.path ? `${named.path} in scope ${named.scope.label}` : `artifacts/${location} in the record store at ${store}${named ? `, scope ${named.scope.label}` : ""}`;
}

// A local move that a store sync sent elsewhere, named by the path and scope label that the store keeps the artifact at and the scope label this machine moved it to.
async function undoneMoveLine(item, argumentsValue) {
  const projectRoot = await requestedProjectRoot(argumentsValue ?? {}).catch(() => null);
  const movedTo = projectRoot ? await artifactAtLocation(projectRoot, item.store, item.movedTo).catch(() => null) : null;
  return `- ${await savedArtifactWhere(item.store, item.undoneMove, argumentsValue)}, which this machine moved to scope ${movedTo?.scope.label ?? `artifacts/${item.movedTo}`}`;
}

// Whether the store at storeBase holds an artifact at a location below artifacts/, told from the file's entry alone, so no byte of a file above its kind's bound is read.
const holdsArtifact = (storeBase, location) => lstat(path.join(storeBase, "artifacts", ...location.split("/"))).then((stats) => stats.isFile(), () => false);

// A saved status record or comment named by the artifact it belongs to, and a comment also by its line and text, quoted only from a comment of the exact form Prism writes,
// since the saved copy may be any file that another machine's store brought, and any other file is named by its path, scope, and saved copy alone.
// where, when given, is the location at which the store keeps the artifact, as for a file whose path there would be too long, while the saved file names the location it was made at, and copy names whose copy it is.
async function savedDerivedLine(item, argumentsValue, where = null, copy = "saved copy") {
  const line = await savedArtifactWhere(item.store, where ?? item.statusOf ?? item.commentOn, argumentsValue);
  if (item.statusOf) return `${line}, its status record (${copy}: ${item.savedAs})`;
  const comment = await savedComment(item.savedAs, item.commentOn).catch(() => null);
  const said = comment ? `, a comment on line ${comment.line}: ${JSON.stringify(comment.text)}` : ", a file in its comment folder that is no comment of the form Prism writes, so its bytes are not shown";
  return `${line}${said} (${copy}: ${item.savedAs})`;
}

// The notes of one tool result that name the files a store sync saved hold at most SAVED_NOTE_MAX bytes, whatever a sync brings:
// each list's first line, which says what was saved and why, always stays, the entries past the bound are left out from the end unread,
// and a last line counts them and names the store's sync folder, which holds every saved copy. Returns the lines.
const SAVED_NOTE_MAX = 32 * 1024;
const SAVED_FOLDER = `${path.sep}.prism-sync${path.sep}conflicts${path.sep}`;
async function savedFilesNote(sections) {
  if (!sections.length) return [];
  const bytes = (line) => Buffer.byteLength(line, "utf8") + 1;
  // A local change that a sync undid has no saved copy, so it names the store's sync folder for its saved copies as it is.
  const folders = [...new Set(sections.flatMap((section) => section.items).map((item) => {
    if (!item.savedAs) return item.folder;
    const at = item.savedAs.lastIndexOf(SAVED_FOLDER);
    return at < 0 ? path.dirname(item.savedAs) : item.savedAs.slice(0, at + SAVED_FOLDER.length - 1);
  }))];
  const where = folders.length === 1 ? `the store's sync folder ${folders[0]} holds` : `the stores' sync folders ${folders.join(", ")} hold`;
  const closing = (count) => `Prism left ${count} more saved ${count === 1 ? "file" : "files"} out of this note to keep it short; ${where} every saved copy.`;
  let budget = SAVED_NOTE_MAX - bytes(closing(Number.MAX_SAFE_INTEGER)) - sections.reduce((sum, section) => sum + bytes(section.header), 0);
  const lines = [];
  let omitted = 0;
  for (const section of sections) {
    lines.push(section.header);
    for (const [index, item] of section.items.entries()) {
      if (omitted) { omitted += section.items.length - index; break; }
      const entry = await section.line(item);
      if (bytes(entry) > budget) { omitted += section.items.length - index; break; }
      lines.push(entry);
      budget -= bytes(entry);
    }
  }
  if (omitted) lines.push(closing(omitted));
  return lines;
}

// The move of a checkout's existing artifacts into its repository's scope says which files left the checkout, which stayed and why, and which tracked files still name them.
// Its text holds at most ARTIFACT_MOVE_NOTE_MAX bytes: every section's header, which gives its count, always stays, list entries past that are left out from the end, and its last line counts them and names the ledger, which lists every move and kept file.
// Every path it prints goes through shownPath, so no file name begins or ends a line of Prism's text.
const ARTIFACT_MOVE_NOTE_MAX = 32 * 1024;
function artifactMoveNote(move) {
  const store = shownPath(move.store);
  if (move.unlisted) return `Git could not list this checkout's files, so Prism moved none of the files under its artifact paths into the record store at ${store}; they stay in the checkout until a later first access in a checkout that Git lists.`;
  if (move.operation) {
    const named = `${/^[aeiou]/.test(move.operation) ? "an" : "a"} ${shownPath(move.operation)}`;
    if (move.finishing) return `Git has ${named} in progress in this checkout, so the checkout's descriptive files that Prism already copied into the record store at ${store} wait until it is finished or aborted: the operation's next commit would take every staged change, so Prism removed none of them from the checkout, and the first later tool call of this checkout that finds no operation in progress removes them and reports the whole move.`;
    return `Git has ${named} in progress in this checkout, so the checkout's descriptive files wait until it is finished or aborted before they move into the record store at ${store}: the work tree holds bytes that no commit holds yet and the operation's next commit would take every staged change, so Prism moved, removed, and recorded nothing, the files stay in the checkout, and each later tool call of this checkout looks again.`;
  }
  if (move.deferred) return `This checkout's descriptive files wait for a pull from the record store's remote before they move into the record store at ${store}: the store's sync could not complete the pull (sync state ${move.deferred.state}), so Prism moved, removed, and recorded nothing, the files stay in the checkout, and a later tool call of this checkout tries again.`;
  const them = (count) => count === 1 ? "it" : "them";
  const sections = [];
  // Kept and untracked files come first, since each waits for a person, and a long move's list of moves is what the closing line leaves to the ledger.
  if (move.kept.length) sections.push({ header: `Prism kept ${plural(move.kept.length, "tracked file")} under the artifact paths in the checkout, where ${move.kept.length === 1 ? "it stays" : "they stay"} until a person settles ${move.kept.length === 1 ? "it" : "each"}:`, entries: move.kept.map((item) => `- ${shownPath(item.path)} (${item.reason}): ${keptExplanation(item)}.`) });
  const passed = move.passed ?? [];
  if (passed.length) sections.push({ header: `Git's index does not let Prism take ${plural(passed.length, "tracked file")} under the artifact paths, so ${passed.length === 1 ? "it stays" : "they stay"} in the checkout; a later session's move decides each once Git sees its changes again:`, entries: passed.map((item) => `- ${shownPath(item.path)} (${item.reason}): ${keptExplanation(item)}.`) });
  if (move.untracked.length) sections.push({ header: `${plural(move.untracked.length, "file")} under the artifact paths ${move.untracked.length === 1 ? "is" : "are"} not tracked by Git, so ${move.untracked.length === 1 ? "it stays" : "they stay"} in the checkout and no ledger names ${them(move.untracked.length)}; a person commits such a file for a later first access to move it, or writes it into the store with update_artifact:`, entries: move.untracked.map((file) => `- ${shownPath(file)} (untracked)`) });
  if (move.moved.length) sections.push({ header: `Prism moved ${plural(move.moved.length, "descriptive file")} of this checkout into the record store at ${store}, scope ${shownPath(move.repository)}, and removed ${them(move.moved.length)} from the checkout; read and change ${them(move.moved.length)} with get_artifact and update_artifact by the same paths, and commit the removal on its own, apart from the task's changes.`, entries: move.moved.map((item) => `- ${shownPath(item.from)} -> ${shownPath(`artifacts/${item.to}`)}`) });
  const earlier = move.earlier ?? [];
  if (earlier.length) sections.push({ header: `Prism moved ${plural(earlier.length, "descriptive file")} of this checkout into the record store at ${store}, scope ${shownPath(move.repository)}, earlier and removed ${them(earlier.length)} from the checkout, and Git's index still lists ${them(earlier.length)}; read and change ${them(earlier.length)} with get_artifact and update_artifact by the same paths, and commit the removal on its own, apart from the task's changes, since each later session reports ${them(earlier.length)} again until a person stages or commits the removal.`, entries: earlier.map((item) => `- ${shownPath(item.from)} -> ${shownPath(`artifacts/${item.to}`)}`) });
  const fixed = move.ignored ? [`${plural(move.ignored, "ignored file")} under the artifact paths ${move.ignored === 1 ? "stays" : "stay"} in the checkout: Git ignores ${them(move.ignored)}, so Prism neither moves nor names ${them(move.ignored)}.`] : [];
  if (move.references.length) {
    const total = move.references.length + move.moreReferences;
    const entries = move.references.map((item) => `- ${shownPath(item.file)}:${item.lines.join(",")}${item.more ? ` and ${item.more} more ${item.more === 1 ? "line" : "lines"}` : ""}`);
    if (move.moreReferences) entries.push(`- and ${plural(move.moreReferences, "more file")}`);
    sections.push({ header: `${plural(total, "tracked file")} in the checkout still ${total === 1 ? "names" : "name"} the former path of a file moved now or earlier, or a configured folder that lost files, by line; the configured paths stay the artifacts' addresses, so update only text that tells readers to open these files in the checkout:`, entries });
  }
  if (!sections.length && !fixed.length) return null;
  // A long move writes its ledger as several files, and the closing line names each, which together list every move and kept file.
  const ledgers = (Array.isArray(move.ledger) ? move.ledger : move.ledger ? [move.ledger] : []).map((name) => shownPath(`${ARTIFACT_MIGRATIONS}/${name}`));
  const ledger = ledgers.length === 1 ? ` and the ledger ${ledgers[0]} in the record store at ${store} lists every move and kept file`
    : ledgers.length ? ` and the ledger files ${ledgers.slice(0, -1).join(", ")} and ${ledgers.at(-1)} in the record store at ${store} together list every move and kept file` : "";
  const closing = (count) => `Prism left ${count} more ${count === 1 ? "entry" : "entries"} out of this report to keep it short${ledger}.`;
  const bytes = (line) => Buffer.byteLength(line, "utf8") + 1;
  // Room for the closing line, which names the ledger and counts what was left out, and for every header and fixed line, which say what moved and what stayed and how many.
  let budget = ARTIFACT_MOVE_NOTE_MAX - bytes(closing(Number.MAX_SAFE_INTEGER)) - [...fixed, ...sections.map((section) => section.header)].reduce((sum, line) => sum + bytes(line), 0);
  const lines = [...fixed];
  let omitted = 0;
  for (const section of sections) {
    lines.push(section.header);
    for (const [index, entry] of section.entries.entries()) {
      if (omitted || bytes(entry) > budget) { omitted += section.entries.length - index; break; }
      lines.push(entry);
      budget -= bytes(entry);
    }
  }
  if (omitted) lines.push(closing(omitted));
  return lines.join("\n");
}

// A sync that found the same record, or the same lines of an artifact, changed upstream kept the upstream version, so the agent whose change lost hears it on its next tool result.
// A saved version stays pending until a tool result carries it, so a server that stopped before naming it leaves it to the next one.
// Returns the result with the notes, and what to do once it was written or was not: a written result confirms the saved versions it names, and one never written leaves them for the next result.
// proceed() says whether the result is still to be written, such as while the host has not cancelled the call.
async function withRecordNotes(value, argumentsValue, call, proceed = () => true) {
  const none = { value, written: async () => {}, unwritten: () => {} };
  if (!Array.isArray(value?.content)) return none;
  // The other notes are taken first, so the move's removals come as close as they can before the result is written.
  const taken = await takeSavedConflicts().catch(() => []);
  // A file that this machine's sync held back because it was above its kind's bound, and that another machine then changed or removed, is named for that cause alone, from its path, never its bytes.
  const overBound = taken.filter((item) => item.overBound);
  const saved = taken.filter((item) => item.record && !item.overBound);
  const removals = taken.filter((item) => item.undoneRemoval);
  const fileRemovals = taken.filter((item) => item.undoneFile);
  const moves = taken.filter((item) => item.undoneMove);
  // A file of either machine's that a sync took out because its path at its artifact's new location would be too long is named with that location, for that cause alone.
  const tooLong = taken.filter((item) => item.tooLongAt && !item.overBound);
  // Another machine's change that a sync took out where this machine's removal stood is named apart, since it is no change of this machine's.
  const theirs = taken.filter((item) => item.theirs && !item.tooLongAt);
  const artifacts = taken.filter((item) => item.location && !item.theirs && !item.tooLongAt && !item.overBound);
  // A file at the store's root, such as its README, is saved when both machines changed it, and a store file is also saved when the other machine changed the version that this machine's sync withheld.
  const files = taken.filter((item) => item.file && !item.bothChanged && !item.overBound);
  const bothChanged = taken.filter((item) => item.file && item.bothChanged);
  // A comment of this machine's that its folder's bound left out belongs to an artifact that the store still holds, with the comments that reached the store first.
  const surplus = taken.filter((item) => item.commentOn && item.surplus && !item.theirs && !item.tooLongAt);
  // A status record that changed on both sides keeps the upstream one while its artifact stays; one, or a comment, whose artifact the store no longer holds left the store.
  const derived = [];
  for (const item of taken.filter((item) => (item.statusOf || item.commentOn) && !item.theirs && !item.surplus && !item.tooLongAt && !item.overBound)) derived.push({ item, kept: Boolean(item.statusOf) && await holdsArtifact(item.store, item.statusOf) });
  const sections = [];
  // The local removals and moves that a sync undid come first, since each is a deliberate change of this machine that the store no longer shows.
  if (removals.length) {
    sections.push({ header: `Store sync undid this machine's removal of ${plural(removals.length, "artifact")}, because another machine edited ${removals.length === 1 ? "its" : "their"} text, as approving a file does, before this machine's removal reached the store; the store holds ${removals.length === 1 ? "it" : "them"} again with the other machine's changes. Read each one again with get_artifact and remove it again with update_artifact if the removal still matters.`, items: removals, line: async (item) => `- ${await savedArtifactWhere(item.store, item.undoneRemoval, argumentsValue)}` });
  }
  if (fileRemovals.length) {
    const them = fileRemovals.length === 1 ? "it" : "them";
    sections.push({ header: `Store sync undid this machine's removal of ${plural(fileRemovals.length, "store file")} at the store's root, such as its README, because another machine changed ${them} before this machine's removal reached the store; the store holds ${them} again with the other machine's version. Remove ${them} from the store again if the removal still matters.`, items: fileRemovals, line: async (item) => `- ${item.undoneFile} in the record store at ${item.store}` });
  }
  if (moves.length) {
    sections.push({ header: `Store sync undid this machine's move of ${plural(moves.length, "artifact")} to another scope, because another machine moved ${moves.length === 1 ? "it" : "them"} elsewhere, or kept its own file at the path this machine moved ${moves.length === 1 ? "it" : "them"} to, before this machine's move reached the store; the store keeps each in the first scope named below, with this machine's other changes to it. Read each one again with get_artifact and move it again with move_scope if the move still matters.`, items: moves, line: (item) => undoneMoveLine(item, argumentsValue) });
  }
  if (theirs.length) {
    sections.push({ header: `Store sync saved ${plural(theirs.length, "change")} that another machine made to an artifact that this machine had removed, which left the file's text as it was, such as a comment or an approval asked; this machine's removal stands, so the store holds no such artifact, or holds the file that this machine wrote or moved to its path, and saved ${theirs.length === 1 ? "that change" : "those changes"} beside the store. Tell the person, and redo what still matters on an artifact the store holds.`, items: theirs, line: async (item) => `- ${item.location ? await savedArtifactWhere(item.store, item.location, argumentsValue) + ` (the other machine's version: ${item.savedAs})` : await savedDerivedLine(item, argumentsValue)}` });
  }
  if (tooLong.length) {
    const one = tooLong.length === 1;
    const line = async (item) => {
      const whose = item.theirs ? "the other machine's version" : "this machine's version";
      if (item.location) return `- ${await savedArtifactWhere(item.store, item.tooLongAt, argumentsValue)} (${whose}: ${item.savedAs})`;
      return `- ${await savedDerivedLine(item, argumentsValue, item.tooLongAt, whose)}`;
    };
    sections.push({ header: `Store sync saved ${plural(tooLong.length, "file")}, such as a comment or a status record, that one machine changed on an artifact while the other machine moved the artifact, because ${one ? "its path" : "their paths"} at the artifact's new location would hold a name of more than ${STORE_NAME_BYTES_MAX} bytes or more than ${STORE_PATH_BYTES_MAX} bytes in all, too long for a store to share; the store keeps the artifact at the new location named below without ${one ? "that file" : "those files"}, and saved ${one ? "it" : "them"} beside the store. Tell the person, and redo what still matters on the artifact there, after moving it to a shorter location if the change needs a file of its own.`, items: tooLong, line });
  }
  if (saved.length) {
    sections.push({ header: `Store sync found ${plural(saved.length, "record")} that someone else changed before this machine's change was pushed; the store kept their version and saved this machine's version. Read each record again and redo the change through Prism's tools if it still matters.`, items: saved, line: async (item) => `- ${item.record} (this machine's version: ${item.savedAs})` });
  }
  if (artifacts.length) {
    sections.push({ header: `Store sync found ${plural(artifacts.length, "artifact")} that this machine changed while another machine changed the same lines, or removed the file and wrote or moved another one to its path; the store kept the other machine's version and saved this machine's version. Read each artifact again with get_artifact and redo the change with update_artifact if it still matters.`, items: artifacts, line: (item) => savedArtifactLine(item, argumentsValue) });
  }
  if (overBound.length) {
    const one = overBound.length === 1;
    const line = async (item) => {
      const copy = `this machine's copy: ${item.savedAs}`;
      if (item.location) return `- ${await savedArtifactWhere(item.store, item.location, argumentsValue)} (${copy})`;
      if (item.statusOf) return `- ${await savedArtifactWhere(item.store, item.statusOf, argumentsValue)}, its status record (${copy})`;
      if (item.commentOn) return `- ${await savedArtifactWhere(item.store, item.commentOn, argumentsValue)}, a file in its comment folder (${copy})`;
      return item.record ? `- ${item.record} (${copy})` : `- ${item.file} in the record store at ${item.store} (${copy})`;
    };
    sections.push({ header: `Store sync saved ${plural(overBound.length, "file")} of this machine's that ${one ? "was" : "were"} above the bound that a store file of ${one ? "its" : "their"} kind may hold, so this machine's sync held ${one ? "it" : "them"} back from the store, and that another machine then changed or removed; the store keeps the other machine's version, and this machine's copy is saved at the path named below. Tell the person, and redo what still matters in fewer bytes than that bound.`, items: overBound, line });
  }
  const records = derived.filter((entry) => entry.kept).map((entry) => entry.item);
  if (records.length) {
    sections.push({ header: `Store sync found ${plural(records.length, "status record")} of an artifact that this machine changed while another machine changed the same record, or removed the artifact and wrote or moved another one to its path; the store kept the other machine's record and saved this machine's. Read each artifact again with get_artifact, and ask its approval again with ask_approval if this machine's answer still matters for the file the store now holds.`, items: records, line: async (item) => `- ${await savedDerivedLine(item, argumentsValue)}` });
  }
  if (surplus.length) {
    sections.push({ header: `Store sync saved ${plural(surplus.length, "comment")} that this machine made on a file that already holds the ${COMMENTS_PER_ARTIFACT_MAX} comments that a file may hold, because other machines' comments on it reached the store first; the store keeps the file and those comments, and saved ${surplus.length === 1 ? "this comment" : "these comments"} beside the store, where no page shows ${surplus.length === 1 ? "it" : "them"}. Tell the person what ${surplus.length === 1 ? "it says" : "they say"}, since the file takes no further comment.`, items: surplus, line: async (item) => `- ${await savedDerivedLine(item, argumentsValue)}` });
  }
  const stranded = derived.filter((entry) => !entry.kept).map((entry) => entry.item);
  if (stranded.length) {
    const counted = [[stranded.filter((item) => item.statusOf).length, "status record"], [stranded.filter((item) => item.commentOn).length, "comment"]].filter(([count]) => count).map(([count, noun]) => plural(count, noun)).join(" and ");
    sections.push({ header: `Store sync took ${counted} out of the store because the store no longer holds the artifact ${stranded.length === 1 ? "it was" : "they were"} made on, as when one machine changed an artifact while another removed it, also when that machine then wrote another file at its path, and saved ${stranded.length === 1 ? "it" : "them"} beside the store. Tell the person, and redo what still matters on an artifact the store holds.`, items: stranded, line: async (item) => `- ${await savedDerivedLine(item, argumentsValue)}` });
  }
  if (bothChanged.length) {
    const them = bothChanged.length === 1 ? "that file" : "those files";
    sections.push({ header: `Store sync found ${plural(bothChanged.length, "store file")} at the store's root, such as its README, that this machine changed while another machine also changed ${them}; the store keeps the other machine's version, and this machine's copy is saved at the path named below. Fix the file from the saved copy if the change still matters.`, items: bothChanged, line: async (item) => `- ${item.file} in the record store at ${item.store} (this machine's copy: ${item.savedAs})` });
  }
  if (files.length) {
    sections.push({ header: `Store sync took the upstream's version of ${plural(files.length, "store file")} whose local version this machine's sync had withheld, because another machine could not take it; the store kept the upstream's version and saved this machine's version. Fix the file from the saved copy if the change still matters.`, items: files, line: async (item) => `- ${item.file} in the record store at ${item.store} (this machine's version: ${item.savedAs})` });
  }
  const conflictLines = await savedFilesNote(sections);
  // A decided move, the call's own or one that a refused, cancelled, or background call left, removes the checkout's files only here, right before a result of a tool call of the checkout is written,
  // so the result that follows names every file it removed; a refused or cancelled call never gets here and removes nothing.
  await finishUnfinishedMoves(call.roots, { proceed, writes: call.writes }).catch(() => {});
  const reports = takeMigrationReports(call.roots);
  if (!reports.length && !taken.length) return none;
  const lines = [];
  // Each move of a checkout's artifacts is a text item of its own, after the other notes, so its bound and its closing line are its own.
  const moveNotes = [];
  for (const report of reports) {
    if (report.artifacts) { const note = artifactMoveNote(report.artifacts); if (note) moveNotes.push(note); continue; }
    const into = report.store ? `the record store at ${report.store}` : ".prism";
    const kept = report.store ? "the record store" : ".prism";
    if (report.moved.length) {
      const removal = report.store ? "commit their removal from the project" : "commit these moves";
      lines.push(`Prism moved ${plural(report.moved.length, "record file")} into ${into}; ${removal} on its own, apart from the task's changes.`, ...report.moved.map((move) => move.from === move.to ? `- ${move.from}` : `- ${move.from} -> ${move.to}`));
    }
    if (report.conflicts.length) lines.push(`${report.conflicts.length} old files were kept because ${kept} already holds a different record: ${report.conflicts.map((move) => move.from).join(", ")}.`);
  }
  lines.push(...conflictLines);
  return {
    value: { ...value, content: [...value.content, ...(lines.length ? [{ type: "text", text: lines.join("\n") }] : []), ...moveNotes.map((text) => ({ type: "text", text }))] },
    written: () => confirmSavedConflicts(taken).catch(() => {}),
    unwritten: () => { restoreMigrationReports(reports); releaseSavedConflicts(taken); }
  };
}

// A successful claim, or start of a slice, makes its agent the initiative's coordinator in the session.
const coordinatingCall = (name, argumentsValue) => name === "update_initiative" && Array.isArray(argumentsValue?.operations)
  && argumentsValue.operations.some((operation) => operation?.op === "claim" || (operation?.op === "set_status" && operation.status === "in-progress"));

// A successful call that names an initiative tells the initiative's coordinator in the session, once, of the person's changes in the review app that the session has not been shown.
async function withPersonChanges(name, argumentsValue, value) {
  if (typeof argumentsValue?.initiative !== "string" || !Array.isArray(value?.content) || value.structuredContent?.status === "cancelled") return value;
  let changes;
  try {
    changes = await takePersonChanges({ projectRoot: await requestedProjectRoot(argumentsValue), initiative: argumentsValue.initiative, agent: currentCallAgent(), coordinates: coordinatingCall(name, argumentsValue) });
  } catch {
    return value;
  }
  if (!changes.length) return value;
  return { ...value, content: [...value.content, { type: "text", text: personChangesText(changes) }], structuredContent: { ...value.structuredContent, personChanges: changes } };
}

// The tools that work on one slice: each needs its caller's live claim on the slice or an ancestor.
// A dependents' run checks a finished scope whose leaves are all done, so it works on no slice in progress and needs no claim.
const SLICE_WORK_TOOLS = new Set(["verify_slice", "update_review", "update_change_map", "update_design_view"]);

// An agent's tool call that works on slices is refused before it changes anything unless the caller holds the claim; the person's actions in the review app never come through here.
async function requireCallClaims(name, argumentsValue) {
  if (typeof argumentsValue?.initiative !== "string") return;
  if (name === "update_initiative") {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const record = await readInitiative(projectRoot, argumentsValue.initiative).then(({ loaded }) => loaded?.record, () => null);
    const work = initiativeWork(argumentsValue.operations, record);
    await requireClaimedWork({ projectRoot, initiative: argumentsValue.initiative, tool: name, work, claimedHere: claimedByUpdate(argumentsValue.operations) });
    return;
  }
  if (!SLICE_WORK_TOOLS.has(name) || typeof argumentsValue.slice !== "string") return;
  if (name === "verify_slice" && argumentsValue.dependents === true) return;
  const projectRoot = await requestedProjectRoot(argumentsValue);
  await requireClaimedWork({ projectRoot, initiative: argumentsValue.initiative, tool: name, work: [{ slug: argumentsValue.slice, own: true }] });
}

async function callTool(name, argumentsValue = {}, metadata, requestId) {
  await requireCallClaims(name, argumentsValue);
  if (name === "wait_for_user_gate") {
    return callGateWait(argumentsValue, metadata, requestId);
  }
  if (name === "verify_slice") {
    return callVerifySlice(argumentsValue, metadata, requestId);
  }
  if (CONSERVATION_TOOLS.some(tool => tool.name === name)) {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    let value = await callConservationTool(name, { ...argumentsValue, projectRoot });
    if (name === "get_review") value = { ...value, runTotals: await readReviewRunTotals(projectRoot, argumentsValue) };
    const history = name === "get_review" && typeof argumentsValue.initiative === "string" ? await shippedHistory(projectRoot, argumentsValue.initiative) : null;
    if (history) value = { ...value, shippedHistory: history };
    return { content: [{ type: "text", text: JSON.stringify(value) }, ...await historyMarksContent(projectRoot, history)], structuredContent: value };
  }
  if (name === "update_design_view") {
    const value = await updateDesignView({ ...argumentsValue, projectRoot: await requestedProjectRoot(argumentsValue) });
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
  if (["get_change_map", "update_change_map"].includes(name)) {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const input = { ...argumentsValue, projectRoot };
    const value = name === "get_change_map" ? await getChangeMap(input) : await updateChangeMap(input);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
  if (stateTools.has(name)) {
    return callStateTool(name, argumentsValue);
  }
  if (["get_roadmap", "update_roadmap", "get_initiative", "update_initiative"].includes(name)) {
    const projectRoot = await requestedProjectRoot(argumentsValue);
    const input = { ...argumentsValue, projectRoot };
    let value = name === "get_roadmap" ? await getRoadmap(input)
      : name === "update_roadmap" ? await updateRoadmap(input)
      : name === "get_initiative" ? await getInitiative(input)
      : initiativeAcknowledgement(await updateInitiative(input), input.operations);
    if (name === "get_initiative") value = { ...value, runTotals: await readInitiativeRecordRunTotals(projectRoot, value.initiative, value) };
    value = await withRecordStore(projectRoot, value);
    const marks = name === "get_initiative" ? await historyMarksContent(projectRoot, value.shippedHistory)
      : name === "get_roadmap" ? await Promise.all((value.markedHistory ?? []).map(async (item) => ({ type: "text", text: await historyMarksText(projectRoot, item.initiative, item.marked) })))
      : [];
    return { content: [{ type: "text", text: JSON.stringify(value) }, ...marks], structuredContent: value };
  }
  if (name === "get_artifact" || name === "update_artifact") {
    const input = { ...argumentsValue, projectRoot: await requestedProjectRoot(argumentsValue) };
    const value = name === "get_artifact" ? await getArtifact(input) : await updateArtifact(input);
    await noteApprovalDelivery(name, input.projectRoot, value);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
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
    const url = await review.reviewUrl(tabs);
    return { content: [{ type: "text", text: reviewContent(url, review) }], structuredContent: { url, ...await reviewSessionContent(review), ...privateServerContent(review) } };
  }
  if (name === "present_review") {
    const opened = await review.open(requestedTabs(argumentsValue), requestedGroup(argumentsValue));
    return { content: [{ type: "text", text: reviewContent(opened.url, review) }], structuredContent: { ...opened, ...await reviewSessionContent(review), ...privateServerContent(review) } };
  }
  if (name === "list_reviewable_artifacts") {
    const artifacts = await listArtifacts(review.projectRoot);
    return { content: [{ type: "text", text: artifacts.join("\n") || "No reviewable artifacts found." }], structuredContent: { artifacts } };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// A host that names the project at start gets it listed in the review app and its native index preparing before any tool call, without
// delaying initialize, and opens the review browser when nobody watches one; a host that names no project still gets a running app.
// Its repository name is checked in the background too, so an accepted checkout is recorded in this machine's checkout list before any tool call.
if (process.env.CLAUDE_PROJECT_DIR) {
  void realpath(process.env.CLAUDE_PROJECT_DIR).then(async (root) => {
    void startBackgroundPreparation(root);
    void recordStoreOf(root).catch(() => {});
    reviewServers.register(root, { open: await opensAtStart(root) });
  }, () => {});
} else {
  reviewServers.startApp();
}

// The ids of the tool calls in progress, and of those the host cancelled: MCP asks a receiver not to respond to a cancelled request, and the host ignores a response that arrives after its cancel,
// so a call cancelled before its result is written gets no response, and the saved versions its notes would name stay pending for the next result the host reads.
const callsInProgress = new Set();
const cancelledCalls = new Set();
const callNames = new Map();

const input = readJsonLines(process.stdin);
input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      clientName = typeof request.params?.clientInfo?.name === "string" ? request.params.clientInfo.name : null;
      clientVersion = typeof request.params?.clientInfo?.version === "string" ? request.params.clientInfo.version : null;
      result(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "prism-review", version: pluginManifest.version }
      });
    } else if (request.method === "tools/list") {
      result(request.id, { tools });
    } else if (request.method === "tools/call") {
      callsInProgress.add(request.id);
      const meta = request.params?._meta;
      const { name, arguments: argumentsValue } = request.params ?? {};
      callNames.set(request.id, name);
      const started = performance.now(), done = log.doing(`call:${request.id}`, String(name));
      const call = toolCallContext();
      const value = await withToolCall(call, () => withCallSession(meta, async () => {
        const agent = await callAgent(meta).catch(() => undefined);
        return withCallAgent(agent, async () => withPersonChanges(name, argumentsValue, await callTool(name, argumentsValue, meta, request.id)));
      })).finally(done);
      log.debug("tool_call", { tool: name, ms: Math.round(performance.now() - started), ...(value?.isError ? { isError: true } : {}) });
      // A cancelled request gets no response, so it carries no notes either; nor does a result made once the host closed input, which ends the session.
      if (value.structuredContent?.status === "cancelled" || cancelledCalls.has(request.id)) return;
      if (closing) { await result(request.id, value); return; }
      const noted = await withRecordNotes(value, argumentsValue, call, () => !closing && !cancelledCalls.has(request.id));
      // A cancel that arrived while the notes were taken still stops the result, and nothing runs between this check and the write.
      if (cancelledCalls.has(request.id)) { noted.unwritten(); return; }
      if (await result(request.id, noted.value) && !closing) await noted.written();
      else noted.unwritten();
    } else if (request.method === "notifications/cancelled") {
      const id = request.params?.requestId;
      if (callsInProgress.has(id)) cancelledCalls.add(id);
      pendingWaits.get(id)?.abort();
    } else if (request.id !== undefined) {
      failure(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    log.warn("request_failed", { method: request?.method, ...(callNames.has(request?.id) ? { tool: callNames.get(request.id) } : {}), ...errorFields(error) });
    if (request?.id !== undefined && !cancelledCalls.has(request.id)) {
      const data = stateErrorData(error);
      failure(request.id, -32603, errorMessage(error, data), data);
    }
  } finally {
    if (request?.method === "tools/call") {
      callsInProgress.delete(request.id);
      cancelledCalls.delete(request.id);
      callNames.delete(request.id);
    }
  }
});

// The host ends the session by closing input or by a signal, so the server exits once its cleanup ends, or after a short grace period,
// even when index preparation, a store sync, or a child process started meanwhile would keep it alive.
// Claude Code sends SIGINT and then SIGTERM about a tenth of a second apart, and ends the process soon after, so the stores' pending syncs go to a detached process first.
// On Windows a signal ends the process without running any of its code, so a detached watcher holds the pending syncs while any are pending and finishes them however the server ends.
configureRecordSync({ watchPending: true });
const CLOSE_GRACE_MS = 5000;
let closing = false;
async function stop(reason) {
  if (closing) return;
  closing = true;
  handOffRecordSyncs();
  log.info("process_stopping", { reason });
  const deadline = setTimeout(() => process.exit(0), CLOSE_GRACE_MS);
  deadline.unref();
  try {
    for (const controller of pendingWaits.values()) controller.abort();
    cancelVerifications();
    stopClaimRenewals();
    await Promise.all([nativeSemanticRuntime.close(), reviewServers.close(), Promise.allSettled([...endingWaits])]);
    // A write that the cleanup finished has its sync handed off too.
    handOffRecordSyncs();
  } finally {
    await log.flush();
    process.exit(0);
  }
}
input.on("close", () => void stop("input closed"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void stop(signal));
