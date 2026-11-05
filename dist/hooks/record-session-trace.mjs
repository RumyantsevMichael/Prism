import { createHash } from "node:crypto";
import { realpath as defaultRealpath, stat as defaultStat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClaudeCodeMessageUsage } from "../server/session/host-adapters/claude-code.mjs";
import { inspectCodexTranscriptMetadata } from "../server/session/host-adapters/codex-transcript.mjs";
import { readPrismCallTarget } from "../server/session/prism-call-target.mjs";
import { approximateTokenCounter } from "../server/repository-intelligence/repository-intelligence.mjs";
import { resolveSessionTraceBehavior } from "../server/session/session-trace-behavior.mjs";
import {
  SESSION_TRACE_COVERAGE,
  SESSION_TRACE_EVENT_TYPES,
  SESSION_TRACE_GAP_REASONS,
  SESSION_TRACE_HOST_EVENTS,
  createSessionTraceEvent,
  createSessionTraceIdentity,
  hashSessionTraceValue
} from "../server/session/session-trace.mjs";
import {
  SESSION_TRACE_REASON,
  appendSessionTraceEvent,
  markRunsPending,
  recordSessionTraceLoss
} from "../server/session/session-trace-store.mjs";
import { recordFinishedRuns } from "../server/session/run-records.mjs";
import { readWorkflowConfig, runStatisticsCollection } from "../server/workflow/workflow-config.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_USAGE_READ_BUDGET_MS = 1500;
// Run finalization starts no trace read and no append after this point of the hook, which the host stops after 5 s.
const FINALIZATION_BUDGET_MS = 2500;
const RUN_ENDING_EVENTS = new Set(["SessionEnd", "SubagentStop"]);
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USAGE_READ_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "PreCompact", "SubagentStop", "SessionEnd"]);
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const TOOL_RESULT_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const MAX_ESTIMATED_RESPONSE_BYTES = 1024 * 1024;
const CUSTOM_EVENT_KEYS = [
  "event_id",
  "event_type",
  "source_path",
  "start_line",
  "end_line",
  "rendered_tokens",
  "result_count",
  "byte_count",
  "duration_ms",
  "exit_code",
  "coverage",
  "gap_reason",
  "model",
  "tool",
  "confirmed_success"
];
const EVENT_TYPES = new Set(SESSION_TRACE_EVENT_TYPES);
const COVERAGE = new Set(SESSION_TRACE_COVERAGE);
const GAP_REASONS = new Set(SESSION_TRACE_GAP_REASONS);
const HOST_EVENTS = new Set(SESSION_TRACE_HOST_EVENTS);
const BUILTIN_TOOL_CATEGORIES = new Map([
  ["read", "read"],
  ["read_file", "read"],
  ["read-source", "read"],
  ["read_source", "read"],
  ["grep", "search"],
  ["glob", "search"],
  ["search", "search"],
  ["code_search", "search"],
  ["edit", "edit"],
  ["write", "edit"],
  ["multiedit", "edit"],
  ["notebookedit", "edit"],
  ["apply_patch", "edit"],
  ["test", "test"],
  ["run_tests", "test"],
  ["bash", "shell"],
  ["shell", "shell"],
  ["exec_command", "shell"]
]);
const PROVIDER_TOOL_CATEGORIES = new Map([
  ["codegraph_context", "search"],
  ["codegraph_explore", "search"],
  ["mcp__codegraph__codegraph_context", "search"],
  ["mcp__codegraph__codegraph_explore", "search"]
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function timestamp(value, now) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const current = now();
  const date = current instanceof Date ? current : new Date(current);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedHostEvent(value) {
  const name = nonemptyString(value);
  return name && HOST_EVENTS.has(name) ? name : "Unknown";
}

function toolCategory(toolName) {
  const exact = nonemptyString(toolName) ?? "";
  const normalized = exact.toLowerCase();
  return BUILTIN_TOOL_CATEGORIES.get(normalized)
    ?? PROVIDER_TOOL_CATEGORIES.get(exact)
    ?? "unknown";
}

function isSameOrDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function rebaseAbsolutePath(value, aliases) {
  const normalized = path.normalize(value);
  for (const alias of aliases) {
    if (!alias?.raw || !alias?.canonical) continue;
    const relative = path.relative(path.normalize(alias.raw), normalized);
    if (relative === "" || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )) {
      return path.join(alias.canonical, relative);
    }
  }
  return normalized;
}

async function canonicalSourcePath(candidate, realpath) {
  let cursor = candidate;
  const suffix = [];
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return path.resolve(canonical, ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function sourceLocation(toolInput, { projectRoot, currentWorkingDirectory, pathAliases, realpath }) {
  if (!isObject(toolInput)) {
    return { location: null, pathProvided: false, insideProject: false };
  }
  const sourcePath = nonemptyString(toolInput.file_path) ?? nonemptyString(toolInput.path);
  if (!sourcePath) {
    return { location: null, pathProvided: false, insideProject: false };
  }
  let absolutePath;
  if (path.isAbsolute(sourcePath)) {
    absolutePath = rebaseAbsolutePath(sourcePath, pathAliases);
  } else if (currentWorkingDirectory) {
    absolutePath = path.resolve(currentWorkingDirectory, sourcePath);
  } else {
    return { location: null, pathProvided: true, insideProject: false };
  }
  const canonicalPath = await canonicalSourcePath(absolutePath, realpath);
  if (!canonicalPath || !isSameOrDescendant(projectRoot, canonicalPath) || canonicalPath === projectRoot) {
    return { location: null, pathProvided: true, insideProject: false };
  }
  const rawStart = safeCount(toolInput.start_line) ?? safeCount(toolInput.offset);
  const startLine = rawStart === undefined ? null : Math.max(1, rawStart);
  const rawEnd = safeCount(toolInput.end_line);
  const limit = safeCount(toolInput.limit);
  let endLine = rawEnd ?? null;
  if (endLine === null && startLine !== null && limit !== undefined && limit > 0) {
    endLine = startLine + limit - 1;
  }
  return {
    location: { path: canonicalPath, startLine, endLine },
    pathProvided: true,
    insideProject: true
  };
}

function observedCounts(input) {
  const counts = {};
  const values = {
    renderedTokens: safeCount(input.rendered_tokens) ?? safeCount(input.rendered_token_count),
    resultCount: safeCount(input.result_count),
    byteCount: safeCount(input.byte_count),
    durationMs: safeCount(input.duration_ms),
    exitCode: safeCount(input.exit_code)
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      counts[key] = value;
    }
  }
  return counts;
}

function estimatedCodexResponseTokens(input, collector, traceBehavior) {
  if (
    collector !== "codex-hook"
    || safeCount(input.rendered_tokens) !== undefined
    || safeCount(input.rendered_token_count) !== undefined
  ) {
    return null;
  }
  if (traceBehavior?.modelFacingResponseShape !== "bounded-string") {
    return { status: "missing" };
  }
  if (
    typeof input.tool_response !== "string"
    || Buffer.byteLength(input.tool_response, "utf8") > MAX_ESTIMATED_RESPONSE_BYTES
  ) {
    return { status: "missing" };
  }
  return {
    status: "estimated",
    count: approximateTokenCounter.count(input.tool_response)
  };
}

async function canonicalDirectory(value, realpath, stat) {
  const normalized = nonemptyString(value);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  try {
    const canonical = await realpath(normalized);
    if (!path.isAbsolute(canonical) || !(await stat(canonical)).isDirectory()) return null;
    return canonical;
  } catch {
    return null;
  }
}

function hasCodexMarker(hookInput, environment) {
  return Boolean(
    nonemptyString(environment.CODEX_VERSION)
    || nonemptyString(hookInput.turn_id)
    || Object.hasOwn(hookInput, "subagent")
  );
}

function exactCustomEvent(value) {
  return isObject(value) && Object.keys(value).every((key) => CUSTOM_EVENT_KEYS.includes(key));
}

function baseEvent({ input, eventType, occurredAt, hostEvent, collector, suffix, source = null }) {
  const sessionId = nonemptyString(input.session_id) ?? nonemptyString(input.sessionId);
  const projectRoot = nonemptyString(input.cwd) ?? nonemptyString(input.project_root);
  const externalId = nonemptyString(input.event_id)
    ?? nonemptyString(input.hook_event_id)
    ?? nonemptyString(input.tool_use_id);
  const stableSuffix = suffix.split(occurredAt).join("event-time");
  const eventId = externalId
    ? `host:${createHash("sha256").update(externalId, "utf8").digest("hex")}:${hostEvent}:${eventType}:${stableSuffix}`
    : `${sessionId ?? "missing"}:${suffix}`;
  return {
    sessionId,
    projectRoot,
    eventId,
    eventType,
    occurredAt,
    sourceLocation: source,
    counts: observedCounts(input),
    hashValues: {},
    coverage: null,
    gapReason: null,
    provenance: { collector, hostEvent }
  };
}

function normalizeCustomEvent({ input, custom, occurredAt, collector }) {
  if (!exactCustomEvent(custom) || !EVENT_TYPES.has(custom.event_type) || ["first_edit", "prism_call"].includes(custom.event_type)) {
    return null;
  }
  const eventType = custom.event_type === "edit" && custom.confirmed_success !== true
    ? "edit_attempt"
    : custom.event_type;
  const event = baseEvent({
    input: { ...input, event_id: custom.event_id },
    eventType,
    occurredAt,
    hostEvent: "Custom",
    collector,
    suffix: `custom:${eventType}:${occurredAt}`,
    source: custom.source_path
      ? {
          path: custom.source_path,
          startLine: custom.start_line ?? null,
          endLine: custom.end_line ?? null
        }
      : null
  });
  event.counts = observedCounts(custom);
  if (nonemptyString(custom.model)) {
    event.hashValues.model = custom.model;
  }
  if (nonemptyString(custom.tool)) {
    event.hashValues.tool = custom.tool;
  }
  if (eventType === "session_start") {
    event.coverage = COVERAGE.has(custom.coverage) ? custom.coverage : "partial";
  }
  if (eventType === "coverage_gap") {
    event.coverage = custom.coverage === "unavailable" ? "unavailable" : "partial";
    event.gapReason = GAP_REASONS.has(custom.gap_reason) ? custom.gap_reason : "malformed-host-event";
  }
  return event;
}

async function readRunStatisticsSwitch(projectRoot) {
  try {
    return runStatisticsCollection(await readWorkflowConfig(projectRoot));
  } catch {
    return "unknown";
  }
}

// A run-statistics trace is keyed by the digest of "<session digest>\0<execution>", so a reader holding only the
// session correlation key finds the root execution's trace, and link events name each subagent trace by that digest.
function executionKeyFor(sessionId, execution) {
  return `${hashSessionTraceValue(sessionId, "sessionId")}\0${execution}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Run-statistics events go to execution traces keyed by executionKey, never to the root session trace.
function runStatisticsEvent({ base, executionKey, executionHash, eventType, eventId, occurredAt, counts = {}, call = null, prismCall = null }) {
  return {
    ...(eventType === "prism_call" ? { prismCall } : {}),
    sessionId: base.sessionId,
    projectRoot: base.projectRoot,
    executionKey,
    eventId: `run-statistics:${eventId}`,
    eventType,
    occurredAt,
    counts,
    hashValues: { execution: executionHash, ...(call ? { call } : {}) },
    coverage: eventType === "session_start" ? "exact" : null,
    gapReason: null,
    provenance: { collector: base.collector, hostEvent: base.hostEvent }
  };
}

function runStatisticsGap(options, gapReason, coverage = "partial") {
  const event = runStatisticsEvent({ ...options, eventType: "coverage_gap" });
  event.coverage = coverage;
  event.gapReason = gapReason;
  return event;
}

function claudeUsageEvents(result, options) {
  if (result.status === "absent" || result.status === "empty") return [];
  const gapId = `usage-unavailable:${options.base.hostEvent}:${options.base.callId ?? ""}:${options.occurredAt}`;
  if (result.status === "cut-short") {
    return [runStatisticsGap({ ...options, eventId: gapId }, "usage-unavailable", "partial")];
  }
  if (result.status !== "counted") {
    return [runStatisticsGap({ ...options, eventId: gapId }, "usage-unavailable", "unavailable")];
  }
  const counts = { ...result.totals, messageCount: result.messageCount };
  const totals = Object.values(result.totals).join(":");
  return [runStatisticsEvent({
    ...options,
    eventType: "usage",
    eventId: `usage:${options.executionKey}:${result.messageCount}:${sha256(result.latestMessageId)}:${totals}`,
    occurredAt: result.latestAt ?? options.occurredAt,
    counts
  })];
}

function codexUsageEvents(metadata, options) {
  const usage = metadata?.totalTokenUsage ?? null;
  if (metadata?.status === "SUPPORTED" && usage === null && metadata.contextWindowTokens === undefined) {
    return [];
  }
  if (usage === null) {
    return [runStatisticsGap({
      ...options,
      eventId: `usage-unavailable:${options.base.hostEvent}:${options.base.callId ?? ""}:${options.occurredAt}`
    }, "usage-unavailable", "unavailable")];
  }
  const counts = {
    inputTokens: usage.inputTokens - usage.cachedInputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens
  };
  return [runStatisticsEvent({
    ...options,
    eventType: "usage",
    eventId: `codex-usage:${options.executionHash}:${usage.inputTokens}:${usage.cachedInputTokens}:${usage.outputTokens}`,
    counts
  })];
}

async function runStatisticsEvents({
  hookInput,
  hostEvent,
  occurredAt,
  collector,
  projectRoot,
  sessionId,
  transcriptMetadata,
  deadline,
  readClaudeUsage,
  readCallTarget
}) {
  if (!sessionId || !["claude-code-hook", "codex-hook"].includes(collector)) return [];
  const rootKey = executionKeyFor(sessionId, "root");
  const callId = nonemptyString(hookInput.tool_use_id);
  const base = { sessionId, projectRoot, collector, hostEvent, callId };
  const rootOptions = { base, executionKey: rootKey, executionHash: rootKey, occurredAt };
  const incomplete = (options = rootOptions) => [runStatisticsGap({
    ...options,
    eventId: `observation-incomplete:${hostEvent}:${callId ?? ""}:${occurredAt}`
  }, "observation-incomplete")];
  const lifecycle = (options) => {
    if (hostEvent === "SessionStart") {
      return [runStatisticsEvent({ ...options, eventType: "session_start", eventId: `session-start:${sha256(options.executionHash)}` })];
    }
    if (hostEvent === "SessionEnd") {
      return [runStatisticsEvent({ ...options, eventType: "session_end", eventId: `session-end:${sha256(options.executionHash)}` })];
    }
    return [];
  };
  const toolSpan = (options) => {
    if (!TOOL_EVENTS.has(hostEvent)) return [];
    if (!callId) return incomplete(options);
    const eventType = hostEvent === "PreToolUse" ? "tool_start" : "tool_end";
    return [runStatisticsEvent({ ...options, eventType, eventId: `${eventType}:${callId}`, call: callId })];
  };
  // A Prism call that names a target adds one prism_call after its tool_end and before the usage read.
  // A target whose project config cannot be read adds a prism_call without target facts, which lowers the following cost.
  const prismCall = async (options) => {
    if (!TOOL_RESULT_EVENTS.has(hostEvent) || !callId) return [];
    let target = null;
    try {
      target = await readCallTarget({
        toolName: nonemptyString(hookInput.tool_name),
        toolInput: hookInput.tool_input,
        projectRoot,
        deadline
      });
    } catch {
      target = null;
    }
    if (!isObject(target)) return [];
    return [runStatisticsEvent({
      ...options,
      eventType: "prism_call",
      eventId: `prism-call:${sha256(options.executionHash)}:${callId}`,
      call: callId,
      prismCall: target.collected === false ? null : target
    })];
  };

  if (collector === "codex-hook") {
    // Codex names a spawned agent by its thread id, so its start link carries the hash its own events use; the
    // subagent's cost before its own first Prism call then belongs to the root segment current at that link.
    if (hostEvent === "SubagentStart") {
      const agentThread = nonemptyString(hookInput.agent_id);
      if (!agentThread) return incomplete();
      return [runStatisticsEvent({ ...rootOptions, executionHash: agentThread, eventType: "subagent_start", eventId: `subagent_start:${agentThread}` })];
    }
    const threadId = nonemptyString(transcriptMetadata?.threadId);
    const usesThread = ["SessionStart", "SessionEnd", "PreCompact", ...TOOL_EVENTS].includes(hostEvent);
    if (!usesThread) return [];
    if (!threadId || !["root", "subagent"].includes(transcriptMetadata?.execution)) return incomplete();
    const options = { ...rootOptions, executionHash: threadId };
    const events = [...lifecycle(options), ...toolSpan(options), ...await prismCall(options)];
    if (USAGE_READ_EVENTS.has(hostEvent)) events.push(...codexUsageEvents(transcriptMetadata, options));
    return events;
  }

  const hasAgent = Object.hasOwn(hookInput, "agent_id");
  const agentId = hasAgent && typeof hookInput.agent_id === "string" && AGENT_ID_PATTERN.test(hookInput.agent_id)
    ? hookInput.agent_id
    : null;
  if (hasAgent && agentId === null) {
    return ["SubagentStart", "SubagentStop", ...TOOL_EVENTS].includes(hostEvent) ? incomplete() : [];
  }
  const executionKey = agentId === null ? rootKey : executionKeyFor(sessionId, `agent:${agentId}`);
  const options = { base, executionKey, executionHash: executionKey, occurredAt };
  const events = [];
  if (agentId === null) {
    events.push(...lifecycle(options));
  } else if (hostEvent === "SubagentStart" || hostEvent === "SubagentStop") {
    const eventType = hostEvent === "SubagentStart" ? "subagent_start" : "subagent_stop";
    const link = { eventType, eventId: `${eventType}:${agentId}` };
    events.push(
      runStatisticsEvent({ ...options, ...link, executionKey: rootKey }),
      runStatisticsEvent({ ...options, ...link })
    );
  }
  events.push(...toolSpan(options));
  events.push(...await prismCall(options));
  if (!USAGE_READ_EVENTS.has(hostEvent) || (agentId === null && hostEvent === "SubagentStop")) return events;

  const rootTranscript = nonemptyString(hookInput.transcript_path);
  let transcriptPath = rootTranscript;
  if (agentId !== null) {
    transcriptPath = nonemptyString(hookInput.agent_transcript_path)
      ?? (rootTranscript && path.isAbsolute(rootTranscript) && AGENT_ID_PATTERN.test(sessionId)
        ? path.join(path.dirname(rootTranscript), sessionId, "subagents", `agent-${agentId}.jsonl`)
        : null);
  }
  let result;
  try {
    result = transcriptPath
      ? await readClaudeUsage({ transcriptPath, sessionId, agentId, deadline })
      : { status: "unreadable" };
  } catch {
    result = { status: "unreadable" };
  }
  events.push(...claudeUsageEvents(result, options));
  return events;
}

export function createSessionTraceNormalizer({
  now = () => new Date(),
  inspectCodexTranscript = inspectCodexTranscriptMetadata,
  realpath = defaultRealpath,
  stat = defaultStat,
  resolveTraceBehavior = resolveSessionTraceBehavior,
  readClaudeUsage = readClaudeCodeMessageUsage,
  readCallTarget = readPrismCallTarget,
  usageReadBudgetMs = DEFAULT_USAGE_READ_BUDGET_MS
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("The session trace clock must be a function.");
  }
  if (typeof inspectCodexTranscript !== "function") {
    throw new TypeError("The Codex transcript inspector must be a function.");
  }
  if (typeof realpath !== "function" || typeof stat !== "function" || typeof resolveTraceBehavior !== "function") {
    throw new TypeError("The session trace path and behavior resolvers must be functions.");
  }
  if (typeof readClaudeUsage !== "function" || !Number.isFinite(usageReadBudgetMs) || usageReadBudgetMs < 0) {
    throw new TypeError("The usage reader must be a function with a nonnegative time budget.");
  }
  if (typeof readCallTarget !== "function") {
    throw new TypeError("The Prism call target reader must be a function.");
  }
  return {
    // `collection` resolves the run-statistics switch for the project root; without it no run-statistics event is produced.
    // `startedAt` is the monotonic time at which the hook invocation began, so each invocation gets its own usage-read budget.
    async normalize({ hookInput = {}, environment = {}, collection = null, startedAt = performance.now() } = {}) {
      if (!isObject(hookInput) || !isObject(environment)) {
        return [];
      }
      const occurredAt = timestamp(hookInput.occurred_at ?? hookInput.timestamp, now);
      if (!occurredAt) {
        return [];
      }
      const hostEvent = normalizedHostEvent(hookInput.hook_event_name ?? hookInput.event_name);
      const model = nonemptyString(hookInput.model);
      const sessionId = nonemptyString(hookInput.session_id) ?? nonemptyString(hookInput.sessionId);
      const rawHookDirectory = nonemptyString(hookInput.cwd) ?? nonemptyString(hookInput.project_root);
      const codexMarker = hasCodexMarker(hookInput, environment);
      let transcriptMetadata = null;
      if (nonemptyString(hookInput.transcript_path)) {
        try {
          transcriptMetadata = await inspectCodexTranscript({
            transcriptPath: hookInput.transcript_path,
            sessionId,
            projectRoot: rawHookDirectory,
            includeUsage: true
          });
        } catch {
          transcriptMetadata = null;
        }
      }

      let collector = "host-hook";
      let projectRoot = null;
      let codexExecutionUncertain = false;
      let codexSubagent = false;
      let traceBehavior = null;
      if (transcriptMetadata?.status === "SUPPORTED") {
        collector = "codex-hook";
        projectRoot = await canonicalDirectory(transcriptMetadata.projectRoot, realpath, stat);
        if (transcriptMetadata.execution === "subagent") {
          codexSubagent = true;
        } else if (transcriptMetadata.execution !== "root") {
          codexExecutionUncertain = true;
        } else if (projectRoot) {
          traceBehavior = resolveTraceBehavior({
            harness: "codex-cli",
            harnessVersion: transcriptMetadata.harnessVersion,
            provider: transcriptMetadata.provider
          });
        }
      } else if (codexMarker) {
        collector = "codex-hook";
        codexExecutionUncertain = true;
        projectRoot = await canonicalDirectory(transcriptMetadata?.projectRoot, realpath, stat);
      } else if (nonemptyString(environment.CLAUDE_PROJECT_DIR)) {
        collector = "claude-code-hook";
        projectRoot = await canonicalDirectory(environment.CLAUDE_PROJECT_DIR, realpath, stat);
      } else {
        projectRoot = await canonicalDirectory(rawHookDirectory, realpath, stat);
      }
      if (!projectRoot) {
        return [];
      }

      // A hook input carrying agent_id is a subagent execution and never reaches the root session trace.
      const rootSessionEvents = async () => {
        if (Object.hasOwn(hookInput, "agent_id")) {
          return [];
        }
        const currentWorkingDirectory = await canonicalDirectory(hookInput.cwd, realpath, stat);
        const normalizedInput = {
          ...hookInput,
          cwd: projectRoot,
          project_root: projectRoot
        };
        const pathAliases = [
          ...(collector === "claude-code-hook"
            ? [{ raw: environment.CLAUDE_PROJECT_DIR, canonical: projectRoot }]
            : []),
          ...(rawHookDirectory === nonemptyString(hookInput.project_root)
            ? [{ raw: hookInput.project_root, canonical: projectRoot }]
            : []),
          { raw: hookInput.cwd, canonical: currentWorkingDirectory }
        ];
        const makeExecutionGap = () => {
          const event = baseEvent({
            input: normalizedInput,
            eventType: "coverage_gap",
            occurredAt,
            hostEvent,
            collector,
            suffix: `coverage-gap:observation-incomplete:${occurredAt}`
          });
          event.counts = {};
          event.coverage = "partial";
          event.gapReason = "observation-incomplete";
          return event;
        };
        if (codexSubagent) {
          return [makeExecutionGap()];
        }
        if (Object.hasOwn(hookInput, "prism_trace_event")) {
          if (codexExecutionUncertain) {
            return [makeExecutionGap()];
          }
          const custom = normalizeCustomEvent({
            input: normalizedInput,
            custom: hookInput.prism_trace_event,
            occurredAt,
            collector
          });
          return custom ? [custom] : [];
        }
        if (hostEvent === "SessionStart") {
          const event = baseEvent({
            input: normalizedInput,
            eventType: "session_start",
            occurredAt,
            hostEvent,
            collector,
            suffix: "session-start"
          });
          event.coverage = !codexExecutionUncertain && COVERAGE.has(hookInput.instrumentation_coverage)
            ? hookInput.instrumentation_coverage
            : "partial";
          if (model) {
            event.hashValues.model = model;
          }
          return [event];
        }
        if (codexExecutionUncertain) {
          return [makeExecutionGap()];
        }
        if (hostEvent === "PostModelSwitch" || hostEvent === "ModelSwitch") {
          const event = baseEvent({
            input: normalizedInput,
            eventType: "model_switch",
            occurredAt,
            hostEvent,
            collector,
            suffix: `model-switch:${model ?? occurredAt}`
          });
          if (model) {
            event.hashValues.model = model;
          }
          return [event];
        }
        if (hostEvent === "PreCompact" || hostEvent === "PostCompact") {
          return [baseEvent({
            input: normalizedInput,
            eventType: "compaction",
            occurredAt,
            hostEvent,
            collector,
            suffix: `compaction:${occurredAt}`
          })];
        }
        if (hostEvent === "SessionEnd") {
          return [baseEvent({
            input: normalizedInput,
            eventType: "session_end",
            occurredAt,
            hostEvent,
            collector,
            suffix: "session-end"
          })];
        }

        if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hostEvent)) {
          return [];
        }
        const toolName = nonemptyString(hookInput.tool_name);
        const category = toolCategory(toolName);
        const locationResult = await sourceLocation(hookInput.tool_input, {
          projectRoot,
          currentWorkingDirectory,
          pathAliases,
          realpath
        });
        const location = locationResult.location;
        const makeToolEvent = (eventType, suffix, source = location) => {
          const event = baseEvent({
            input: normalizedInput,
            eventType,
            occurredAt,
            hostEvent,
            collector,
            suffix,
            source
          });
          if (toolName) {
            event.hashValues.tool = toolName;
          }
          return event;
        };
        const makeGap = (gapReason) => {
          const event = makeToolEvent("coverage_gap", `coverage-gap:${gapReason}:${occurredAt}`, null);
          event.coverage = "partial";
          event.gapReason = gapReason;
          return event;
        };
        const withRenderedTokenObservation = (event) => {
          const estimate = estimatedCodexResponseTokens(hookInput, collector, traceBehavior);
          if (estimate === null) {
            return [event];
          }
          if (estimate.status === "missing") {
            return [makeGap("missing-token-count"), event];
          }
          event.counts.renderedTokens = estimate.count;
          return approximateTokenCounter.exact
            ? [event]
            : [makeGap("estimated-token-count"), event];
        };

        if (hostEvent === "PreToolUse") {
          if (category === "edit") {
            if (locationResult.pathProvided && !locationResult.insideProject) {
              return [makeGap("unsupported-mutation-path")];
            }
            return [makeToolEvent("edit_attempt", `edit-attempt:${occurredAt}`)];
          }
          if (category === "shell") {
            return [makeGap("unsupported-mutation-path")];
          }
          if (category === "unknown") {
            return [makeGap("unsupported-event")];
          }
          return [];
        }
        if (hostEvent === "PostToolUseFailure") {
          if (category === "edit") {
            if (locationResult.pathProvided && !locationResult.insideProject) {
              return [makeGap("unsupported-mutation-path")];
            }
            return [makeToolEvent("edit_attempt", `edit-attempt:${occurredAt}`)];
          }
          if (category === "shell") {
            return [makeGap("unsupported-mutation-path")];
          }
          return [];
        }
        if (category === "read") {
          return location
            ? withRenderedTokenObservation(makeToolEvent("source_read", `source-read:${occurredAt}`))
            : [makeGap("unsupported-read-path")];
        }
        if (category === "search") {
          return withRenderedTokenObservation(makeToolEvent("search", `search:${occurredAt}`, null));
        }
        if (category === "edit") {
          if (locationResult.pathProvided && !locationResult.insideProject) {
            return [makeGap("unsupported-mutation-path")];
          }
          const confirmedCodexMutation = collector === "codex-hook"
            && traceBehavior?.postToolUseSuccessTools.includes(toolName);
          const confirmedClaudeMutation = collector === "claude-code-hook";
          if (!confirmedCodexMutation && !confirmedClaudeMutation) {
            return [
              makeGap("unproved-mutation-success"),
              makeToolEvent("edit_attempt", `edit-attempt:${occurredAt}`)
            ];
          }
          return [makeToolEvent("edit", `edit:${occurredAt}`)];
        }
        if (category === "test") {
          return [makeToolEvent("test", `test:${occurredAt}`)];
        }
        if (category === "shell") {
          return [makeGap("unsupported-mutation-path")];
        }
        return [makeGap("unsupported-event")];
      };
      const rootEvents = await rootSessionEvents();
      let switchState = "off";
      if (typeof collection === "function") {
        try {
          switchState = await collection(projectRoot);
        } catch {
          switchState = "unknown";
        }
      }
      if (switchState !== "on") {
        return rootEvents;
      }
      let runEvents = [];
      try {
        runEvents = await runStatisticsEvents({
          hookInput,
          hostEvent,
          occurredAt,
          collector,
          projectRoot,
          sessionId,
          transcriptMetadata,
          deadline: startedAt + usageReadBudgetMs,
          readClaudeUsage,
          readCallTarget
        });
      } catch {
        runEvents = [];
      }
      return [...rootEvents, ...runEvents];
    }
  };
}

// The trace identity of a run-statistics event that could not be built, so its loss can still be recorded.
function lostEventIdentity(eventInput) {
  return {
    sessionDigest: hashSessionTraceValue(eventInput.executionKey, "executionKey"),
    projectDigest: createSessionTraceIdentity({ sessionId: eventInput.executionKey, projectRoot: eventInput.projectRoot }).projectDigest,
    eventType: eventInput.eventType,
    hashes: {}
  };
}

// Run-statistics events exist only while collection is on, so the hook marks the session pending after its appends and
// records finished runs: its own at an observed end or a newly opened run, and other quiet sessions of the project.
async function finishRuns({ dataDirectory, eventInput, latestStored, ownSession, deadline }) {
  try {
    const sessionDigest = hashSessionTraceValue(eventInput.sessionId, "sessionId");
    const projectRoot = eventInput.projectRoot;
    if (latestStored !== null) {
      await markRunsPending({ dataDirectory, projectRoot, sessionDigest, at: latestStored });
    }
    await recordFinishedRuns({ dataDirectory, projectRoot, sessionDigest, own: ownSession, sweep: true, deadline });
  } catch {
    // A run that cannot be recorded now stays pending for the next Prism hook or session consumption read.
  }
}

async function readHookInput(input = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new Error("The hook input is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function recordSessionTrace({
  input = process.stdin,
  environment = process.env,
  normalizer = createSessionTraceNormalizer(),
  storeEvent = appendSessionTraceEvent,
  recordLoss = recordSessionTraceLoss,
  readCollection = readRunStatisticsSwitch
} = {}) {
  const startedAt = performance.now();
  try {
    const inputText = await readHookInput(input);
    const parsedHookInput = JSON.parse(inputText);
    const hookInput = parsedHookInput;
    const normalize = typeof normalizer === "function"
      ? normalizer
      : normalizer?.normalize?.bind(normalizer);
    if (typeof normalize !== "function" || typeof storeEvent !== "function") {
      return { status: "ignored", reasonCode: SESSION_TRACE_REASON.INVALID_EVENT };
    }
    const normalized = await normalize({ hookInput, environment, collection: readCollection, startedAt });
    const eventInputs = Array.isArray(normalized) ? normalized : normalized ? [normalized] : [];
    if (eventInputs.length === 0) {
      return { status: "ignored", reasonCode: SESSION_TRACE_REASON.INVALID_EVENT };
    }
    const dataDirectory = environment.PLUGIN_DATA ?? environment.CLAUDE_PLUGIN_DATA;
    if (!nonemptyString(dataDirectory)) {
      return { status: "ignored", reasonCode: SESSION_TRACE_REASON.NO_DATA_DIRECTORY };
    }

    const results = [];
    for (const eventInput of eventInputs.filter((candidate) => !candidate?.executionKey)) {
      const event = createSessionTraceEvent(eventInput);
      const result = await storeEvent(event, { dataDirectory });
      results.push(result);
      if (!["appended", "duplicate"].includes(result?.status)) break;
    }
    // Run-statistics events are stored after the root session events, and their failures only lower run-measure coverage.
    // After the first refused append, that event and every later one are recorded as lost instead of being retried
    // under the same contended lock, so the affected executions report below exact rather than an exact undercount.
    let refused = false;
    let latestStored = null;
    let openedRun = false;
    const runInputs = eventInputs.filter((candidate) => candidate?.executionKey);
    for (const eventInput of runInputs) {
      let event = null;
      let result;
      try {
        event = createSessionTraceEvent(eventInput);
        result = refused ? null : await storeEvent(event, { dataDirectory });
      } catch {
        result = { status: "ignored", reasonCode: SESSION_TRACE_REASON.INVALID_EVENT };
      }
      if (result) results.push(result);
      if (result && ["appended", "duplicate"].includes(result.status)) {
        latestStored = Math.max(latestStored ?? 0, Date.parse(event.occurredAt));
        openedRun ||= result.appendedEventTypes?.includes("run_start") ?? false;
        continue;
      }
      refused = true;
      try {
        await recordLoss(event ?? lostEventIdentity(eventInput), { dataDirectory });
      } catch {
        // A loss that cannot be recorded stays undetectable; the host action still proceeds.
      }
    }
    if (runInputs.length > 0) {
      await finishRuns({
        dataDirectory,
        eventInput: runInputs[0],
        latestStored,
        ownSession: openedRun || RUN_ENDING_EVENTS.has(runInputs[0].provenance?.hostEvent),
        deadline: startedAt + FINALIZATION_BUDGET_MS
      });
    }
    return { status: "processed", results };
  } catch {
    return { status: "ignored", reasonCode: SESSION_TRACE_REASON.INVALID_EVENT };
  }
}

async function main() {
  await recordSessionTrace();
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
