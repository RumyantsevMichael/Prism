import path from "node:path";
import {
  HOST_FACT_REASON,
  createHostSessionFactRecord,
  unsupportedHostSessionFacts
} from "../host-session-facts.mjs";
import { inspectCodexTranscriptMetadata } from "./codex-transcript.mjs";
import {
  CODEX_CONFIG_REASON,
  inspectCodexEffectiveConfig
} from "./codex-config.mjs";
import { resolveRegisteredCapacityPolicy } from "../session-capacity.mjs";

const HOST_VALUE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:/@\[\]-]{0,255}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeHostValue(value) {
  const normalized = nonemptyString(value);
  return normalized && HOST_VALUE_PATTERN.test(normalized) ? normalized : null;
}

function validTokenCount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function observedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function resultFromRecord(record) {
  if (record.status === "SUPPORTED") {
    return { status: "SUPPORTED", record };
  }
  return unsupportedHostSessionFacts(record.reasonCode, { record });
}

function unsupportedWithoutRecord(reasonCode) {
  return unsupportedHostSessionFacts(reasonCode, { record: null });
}

/**
 * The adapter combines correlated transcript evidence with bounded effective configuration evidence.
 */
export function createCodexHostAdapter({
  now = () => new Date(),
  inspectTranscriptMetadata = inspectCodexTranscriptMetadata,
  readEffectiveConfig = inspectCodexEffectiveConfig
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("The Codex adapter clock must be a function.");
  }
  if (typeof inspectTranscriptMetadata !== "function") {
    throw new TypeError("The Codex transcript metadata inspector must be a function.");
  }
  if (typeof readEffectiveConfig !== "function") {
    throw new TypeError("The Codex effective config reader must be a function.");
  }

  return {
    async capture({ hookInput = {}, environment = process.env } = {}) {
      const input = isObject(hookInput) ? hookInput : {};
      const sessionId = nonemptyString(input.session_id);
      if (!sessionId) {
        return unsupportedWithoutRecord(HOST_FACT_REASON.NO_SESSION_ID);
      }
      const projectRoot = nonemptyString(input.cwd);
      if (!projectRoot) {
        return unsupportedWithoutRecord(HOST_FACT_REASON.NO_PROJECT_ROOT);
      }
      if (!path.isAbsolute(projectRoot)) {
        return unsupportedWithoutRecord(HOST_FACT_REASON.INVALID_PROJECT_ROOT);
      }

      const timestamp = observedAt(now);
      if (!timestamp) {
        return unsupportedWithoutRecord(HOST_FACT_REASON.INVALID_SESSION_FACTS);
      }
      const rawModel = nonemptyString(input.model);
      const model = normalizeHostValue(rawModel);
      const baseSources = {
        harness: "codex-adapter",
        harnessVersion: null,
        provider: null,
        model: model ? "hook.model" : null,
        contextWindowTokens: null,
        compactionThresholdTokens: null,
        compactionScope: null
      };

      let metadata;
      try {
        metadata = await inspectTranscriptMetadata({
          transcriptPath: input.transcript_path,
          sessionId,
          projectRoot
        });
      } catch {
        metadata = { status: "UNSUPPORTED" };
      }
      const correlatedMetadata = metadata?.status === "SUPPORTED" ? metadata : null;
      const correlatedProjectRoot = nonemptyString(correlatedMetadata?.projectRoot);
      if (!correlatedMetadata || !correlatedProjectRoot || !path.isAbsolute(correlatedProjectRoot)) {
        return unsupportedWithoutRecord(HOST_FACT_REASON.HOST_METADATA_UNAVAILABLE);
      }
      if (correlatedMetadata.execution !== "root") {
        return unsupportedWithoutRecord(HOST_FACT_REASON.UNSUPPORTED_EXECUTION);
      }
      const harnessVersion = correlatedMetadata?.harnessVersion ?? null;
      const provider = correlatedMetadata?.provider ?? null;
      const identitySources = {
        ...baseSources,
        harnessVersion: harnessVersion ? "transcript.session_meta.cli_version" : null,
        provider: provider ? "transcript.session_meta.model_provider" : null
      };
      const makeRecord = ({
        status,
        reasonCode = null,
        capacityOverrides = {},
        compactionScope = null,
        sources = identitySources
      }) => createHostSessionFactRecord({
        sessionId,
        projectRoot: correlatedProjectRoot,
        observedAt: timestamp,
        status,
        reasonCode,
        host: {
          harness: "codex-cli",
          harnessVersion,
          provider,
          model
        },
        capacityOverrides,
        compactionScope,
        sources
      });

      if (!rawModel) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.MISSING_MODEL
        }));
      }
      if (!model) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_MODEL
        }));
      }

      const contextWindowTokens = input.model_context_window;
      const compactionThresholdTokens = input.model_auto_compact_token_limit;
      const compactionScope = input.model_auto_compact_token_limit_scope ?? null;
      const sources = {
        ...identitySources,
        contextWindowTokens: contextWindowTokens !== undefined ? "hook.model_context_window" : null,
        compactionThresholdTokens: compactionThresholdTokens !== undefined ? "hook.model_auto_compact_token_limit" : null,
        compactionScope: compactionScope !== null ? "hook.model_auto_compact_token_limit_scope" : null
      };
      const validContext = validTokenCount(contextWindowTokens);
      const validThreshold = validTokenCount(compactionThresholdTokens);
      const validScope = compactionScope === null || compactionScope === "total" || compactionScope === "body_after_prefix";
      const validOrder = !validContext || !validThreshold || compactionThresholdTokens <= contextWindowTokens;
      const capacityOverrides = {};
      if (validContext) capacityOverrides.contextWindowTokens = contextWindowTokens;
      if (validThreshold) capacityOverrides.compactionThresholdTokens = compactionThresholdTokens;
      if (!validScope || !validOrder || (contextWindowTokens !== undefined && !validContext) || (compactionThresholdTokens !== undefined && !validThreshold)) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE,
          capacityOverrides,
          compactionScope: validScope ? compactionScope : null,
          sources: {
            ...sources,
            contextWindowTokens: validContext ? sources.contextWindowTokens : null,
            compactionThresholdTokens: validThreshold ? sources.compactionThresholdTokens : null,
            compactionScope: validScope ? sources.compactionScope : null
          }
        }));
      }

      if (compactionScope === "body_after_prefix") {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.UNSUPPORTED_COMPACTION_SCOPE,
          capacityOverrides,
          compactionScope,
          sources
        }));
      }
      const directCapacityComplete = validContext && validThreshold && compactionScope === "total";
      if (directCapacityComplete && input.hook_event_name !== "PreToolUse") {
        return resultFromRecord(makeRecord({
          status: "SUPPORTED",
          capacityOverrides,
          compactionScope,
          sources
        }));
      }

      if (input.hook_event_name !== "PreToolUse") {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE,
          capacityOverrides,
          compactionScope,
          sources
        }));
      }

      const transcriptContext = correlatedMetadata.contextWindowTokens;
      if (!validTokenCount(transcriptContext) || (validContext && contextWindowTokens !== transcriptContext)) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
          capacityOverrides,
          compactionScope,
          sources
        }));
      }

      const observedRuntimeOverrides = {
        contextWindowTokens: transcriptContext,
        ...(validThreshold ? { compactionThresholdTokens } : {})
      };
      let effectiveConfig;
      try {
        effectiveConfig = await readEffectiveConfig({ cwd: projectRoot, environment });
      } catch {
        effectiveConfig = { status: "UNSUPPORTED" };
      }
      if (effectiveConfig?.status !== "SUPPORTED") {
        const invalid = [
          CODEX_CONFIG_REASON.CONFLICTING_VALUES,
          CODEX_CONFIG_REASON.INVALID_RESPONSE,
          CODEX_CONFIG_REASON.UNSUPPORTED_SCOPE
        ].includes(effectiveConfig?.reasonCode);
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: invalid
            ? HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS
            : HOST_FACT_REASON.EFFECTIVE_SETTINGS_UNAVAILABLE,
          capacityOverrides: observedRuntimeOverrides,
          compactionScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource
          }
        }));
      }

      const config = effectiveConfig.config;
      if (config.model !== null && config.model !== model) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
          capacityOverrides: observedRuntimeOverrides,
          compactionScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource
          }
        }));
      }
      const configThreshold = config.model_auto_compact_token_limit;
      const configContext = config.model_context_window;
      const configScope = config.model_auto_compact_token_limit_scope;
      if (
        (validThreshold && configThreshold !== null && compactionThresholdTokens !== configThreshold)
        || (compactionScope !== null && configScope !== null && compactionScope !== configScope)
      ) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
          capacityOverrides: { contextWindowTokens: transcriptContext, ...capacityOverrides },
          compactionScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource
          }
        }));
      }

      let resolvedThreshold = validThreshold ? compactionThresholdTokens : configThreshold;
      let thresholdSource = validThreshold
        ? sources.compactionThresholdTokens
        : (configThreshold === null ? null : "config.model_auto_compact_token_limit");
      if (resolvedThreshold === null && configContext !== null) {
        const policy = resolveRegisteredCapacityPolicy({
          harness: "codex-cli",
          harnessVersion,
          provider,
          model
        });
        if (!policy) {
          return resultFromRecord(makeRecord({
            status: "UNSUPPORTED",
            reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
            capacityOverrides: { contextWindowTokens: transcriptContext },
            compactionScope,
            sources: {
              ...sources,
              contextWindowTokens: correlatedMetadata.contextWindowSource
            }
          }));
        }
        const expectedEffectiveContext = Number(
          BigInt(configContext) * BigInt(policy.effectiveContextWindowPercent) / 100n
        );
        if (expectedEffectiveContext !== transcriptContext) {
          return resultFromRecord(makeRecord({
            status: "UNSUPPORTED",
            reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
            capacityOverrides: { contextWindowTokens: transcriptContext },
            compactionScope,
            sources: {
              ...sources,
              contextWindowTokens: correlatedMetadata.contextWindowSource
            }
          }));
        }
        resolvedThreshold = Number(
          BigInt(configContext) * BigInt(policy.autoCompactionPercent) / 100n
        );
        thresholdSource = "registry.derived.model_auto_compact_token_limit";
      }
      if (compactionScope === null && configScope === null && !resolveRegisteredCapacityPolicy({
        harness: "codex-cli",
        harnessVersion,
        provider,
        model
      })) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
          capacityOverrides: observedRuntimeOverrides,
          compactionScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource
          }
        }));
      }
      const resolvedScope = compactionScope ?? configScope ?? "total";
      if (resolvedScope === "body_after_prefix") {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.UNSUPPORTED_COMPACTION_SCOPE,
          capacityOverrides: {
            contextWindowTokens: transcriptContext,
            ...(resolvedThreshold === null ? {} : { compactionThresholdTokens: resolvedThreshold })
          },
          compactionScope: resolvedScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource,
            compactionThresholdTokens: resolvedThreshold === null
              ? "config.absent.model_auto_compact_token_limit"
              : thresholdSource,
            compactionScope: compactionScope !== null
              ? sources.compactionScope
              : (configScope === null
                  ? "config.default.model_auto_compact_token_limit_scope"
                  : "config.model_auto_compact_token_limit_scope")
          }
        }));
      }
      const resolvedOverrides = {
        contextWindowTokens: transcriptContext,
        ...(resolvedThreshold === null ? {} : { compactionThresholdTokens: resolvedThreshold })
      };
      if (
        Object.hasOwn(resolvedOverrides, "compactionThresholdTokens")
        && resolvedOverrides.compactionThresholdTokens > transcriptContext
      ) {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.INVALID_EFFECTIVE_SETTINGS,
          capacityOverrides: resolvedOverrides,
          compactionScope: resolvedScope,
          sources: {
            ...sources,
            contextWindowTokens: correlatedMetadata.contextWindowSource,
            compactionThresholdTokens: thresholdSource,
            compactionScope: compactionScope !== null
              ? sources.compactionScope
              : (configScope === null
                  ? "config.default.model_auto_compact_token_limit_scope"
                  : "config.model_auto_compact_token_limit_scope")
          }
        }));
      }
      return resultFromRecord(makeRecord({
        status: "SUPPORTED",
        capacityOverrides: resolvedOverrides,
        compactionScope: resolvedScope,
        sources: {
          ...sources,
          contextWindowTokens: correlatedMetadata.contextWindowSource,
          compactionThresholdTokens: resolvedThreshold === null
            ? "config.absent.model_auto_compact_token_limit"
            : thresholdSource,
          compactionScope: compactionScope !== null
            ? sources.compactionScope
            : (configScope === null
                ? "config.default.model_auto_compact_token_limit_scope"
                : "config.model_auto_compact_token_limit_scope")
        }
      }));
    }
  };
}
