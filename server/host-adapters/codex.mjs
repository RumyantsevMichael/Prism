import path from "node:path";
import {
  HOST_FACT_REASON,
  createHostSessionFactRecord,
  unsupportedHostSessionFacts
} from "../host-session-facts.mjs";
import { inspectCodexTranscriptMetadata } from "./codex-transcript.mjs";

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
 * The transcript inspector supplies only correlated session metadata; exact capacity must be attested directly by the hook.
 */
export function createCodexHostAdapter({
  now = () => new Date(),
  inspectTranscriptMetadata = inspectCodexTranscriptMetadata
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("The Codex adapter clock must be a function.");
  }
  if (typeof inspectTranscriptMetadata !== "function") {
    throw new TypeError("The Codex transcript metadata inspector must be a function.");
  }

  return {
    async capture({ hookInput = {} } = {}) {
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
      if (!validContext || !validThreshold || compactionScope !== "total") {
        return resultFromRecord(makeRecord({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE,
          capacityOverrides,
          compactionScope,
          sources
        }));
      }

      return resultFromRecord(makeRecord({
        status: "SUPPORTED",
        capacityOverrides,
        compactionScope,
        sources
      }));
    }
  };
}
