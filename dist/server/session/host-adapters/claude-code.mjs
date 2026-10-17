import { constants as fileConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOST_FACT_MAX_AGE_MS,
  HOST_FACT_REASON,
  createHostSessionFactRecord,
  createSessionCorrelationKey,
  readHostSessionFacts,
  unsupportedHostSessionFacts
} from "../host-session-facts.mjs";

const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const HOST_VALUE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:/@\[\]-]{0,255}$/;

// Conservative Claude Code capacity policy. Claude Code resolves its compaction trigger from settings,
// environment, server-side client data, and experiments that hooks cannot observe, so Prism estimates low.
export const CLAUDE_CODE_ESTIMATE_POLICY = Object.freeze({
  standardContextWindowTokens: 200000,
  extendedContextWindowTokens: 1000000,
  defaultAutoCompactWindowTokens: 200000,
  outputReserveTokens: 20000,
  thresholdPercent: 80,
  implementationReserveTokens: 60000
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value) {
  const text = nonemptyString(value);
  if (!text || !/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function enabledFlag(value) {
  const text = nonemptyString(value)?.toLowerCase();
  return Boolean(text) && !["0", "false", "no", "off"].includes(text);
}

function observedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function baseModel(model) {
  return model.replace(/\[[^\]]*\]$/, "");
}

async function canonicalDirectory(value, fileSystem) {
  const normalized = nonemptyString(value);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  try {
    const canonical = await fileSystem.realpath(normalized);
    const metadata = await fileSystem.stat(canonical);
    return metadata.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

async function readBoundedTail(filePath, maxBytes, fileSystem) {
  const handle = await fileSystem.open(filePath, fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const length = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, metadata.size - length);
    const text = buffer.toString("utf8");
    return metadata.size > maxBytes ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * Reads the latest Claude Code version and main-thread model for one session from a bounded transcript tail.
 */
export async function inspectClaudeCodeTranscript({ transcriptPath, sessionId, fileSystem = defaultFileSystem } = {}) {
  const normalizedPath = nonemptyString(transcriptPath);
  if (!normalizedPath || !path.isAbsolute(normalizedPath)) return null;
  let text;
  try {
    text = await readBoundedTail(normalizedPath, MAX_TRANSCRIPT_TAIL_BYTES, fileSystem);
  } catch {
    return null;
  }
  if (text === null) return null;
  let harnessVersion = null;
  let model = null;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0 && (!harnessVersion || !model); index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.sessionId !== sessionId || entry.isSidechain === true) continue;
    const version = nonemptyString(entry.version);
    if (!harnessVersion && version && VERSION_PATTERN.test(version)) harnessVersion = version;
    const entryModel = entry.type === "assistant" ? nonemptyString(entry.message?.model) : null;
    if (!model && entryModel && HOST_VALUE_PATTERN.test(entryModel)) model = entryModel;
  }
  return harnessVersion ? { harnessVersion, model } : null;
}

function settingsWindows(settings) {
  const windows = [];
  const collect = (value) => {
    if (Number.isSafeInteger(value) && value > 0) windows.push(value);
  };
  if (!isObject(settings)) return windows;
  collect(settings.autoCompactWindow);
  if (isObject(settings.modelSettings)) {
    for (const modelSettings of Object.values(settings.modelSettings)) {
      if (isObject(modelSettings)) collect(modelSettings.autoCompactWindow);
    }
  }
  return windows;
}

function settingsPaths({ projectRoot, environment }) {
  const configDirectory = nonemptyString(environment.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude");
  return [
    path.join(configDirectory, "settings.json"),
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json"),
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json"
  ];
}

/**
 * Returns the smallest numeric `autoCompactWindow` from any Claude Code settings layer, reading only that key.
 */
export async function readClaudeCodeAutoCompactWindow({ projectRoot, environment = process.env, fileSystem = defaultFileSystem } = {}) {
  let smallest = null;
  for (const settingsPath of settingsPaths({ projectRoot, environment })) {
    let settings;
    try {
      const text = await readBoundedTail(settingsPath, MAX_SETTINGS_BYTES + 1, fileSystem);
      if (text === null || Buffer.byteLength(text) > MAX_SETTINGS_BYTES) continue;
      settings = JSON.parse(text);
    } catch {
      continue;
    }
    for (const window of settingsWindows(settings)) {
      smallest = smallest === null ? window : Math.min(smallest, window);
    }
  }
  return smallest;
}

function providerFor(environment) {
  if (enabledFlag(environment.CLAUDE_CODE_USE_BEDROCK)) return "aws-bedrock";
  if (enabledFlag(environment.CLAUDE_CODE_USE_VERTEX)) return "google-vertex";
  if (enabledFlag(environment.CLAUDE_CODE_USE_FOUNDRY)) return "azure-foundry";
  return "anthropic";
}

/**
 * Derives a deliberately low Claude Code capacity estimate from the model and the observable window controls.
 */
export function estimateClaudeCodeCapacity({ model, environment = {}, settingsAutoCompactWindow = null, policy = CLAUDE_CODE_ESTIMATE_POLICY }) {
  const extended = /\[1m\]$/i.test(model) && !enabledFlag(environment.CLAUDE_CODE_DISABLE_1M_CONTEXT);
  let contextWindowTokens = extended ? policy.extendedContextWindowTokens : policy.standardContextWindowTokens;
  const maxContext = positiveInteger(environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  if (maxContext !== null) contextWindowTokens = Math.min(contextWindowTokens, maxContext);
  const windows = [
    positiveInteger(environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
    settingsAutoCompactWindow
  ].filter((value) => value !== null);
  const autoCompactWindowTokens = Math.min(
    contextWindowTokens,
    windows.length ? Math.min(...windows) : policy.defaultAutoCompactWindowTokens
  );
  const usableTokens = autoCompactWindowTokens - policy.outputReserveTokens;
  if (usableTokens <= 0) return null;
  let percent = policy.thresholdPercent;
  const percentOverride = Number.parseFloat(nonemptyString(environment.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) ?? "");
  if (Number.isFinite(percentOverride) && percentOverride > 0 && percentOverride < percent) percent = percentOverride;
  const compactionThresholdTokens = Math.floor(usableTokens * percent / 100);
  if (compactionThresholdTokens < 1) return null;
  return { contextWindowTokens, compactionThresholdTokens };
}

const ESTIMATE_SOURCES = Object.freeze({
  harness: "claude-code-adapter",
  harnessVersion: "transcript.version",
  provider: "environment.claude_code_provider",
  contextWindowTokens: "estimate.claude_code.context_window",
  compactionThresholdTokens: "estimate.claude_code.auto_compact_threshold",
  compactionScope: "claude_code.total_input_tokens"
});

/**
 * The adapter records a conservative capacity estimate for a root Claude Code session.
 */
export function createClaudeCodeHostAdapter({
  now = () => new Date(),
  fileSystem = defaultFileSystem,
  inspectTranscript = inspectClaudeCodeTranscript,
  readAutoCompactWindow = readClaudeCodeAutoCompactWindow,
  readPreviousFacts = readHostSessionFacts
} = {}) {
  return {
    async capture({ hookInput = {}, environment = process.env } = {}) {
      const input = isObject(hookInput) ? hookInput : {};
      const sessionId = nonemptyString(input.session_id);
      if (!sessionId) return unsupportedHostSessionFacts(HOST_FACT_REASON.NO_SESSION_ID, { record: null });
      if (nonemptyString(input.agent_id)) {
        return unsupportedHostSessionFacts(HOST_FACT_REASON.UNSUPPORTED_EXECUTION, { record: null });
      }
      const projectRoot = await canonicalDirectory(environment.CLAUDE_PROJECT_DIR, fileSystem);
      if (!projectRoot) return unsupportedHostSessionFacts(HOST_FACT_REASON.NO_PROJECT_ROOT, { record: null });
      const timestamp = observedAt(now);
      if (!timestamp) return unsupportedHostSessionFacts(HOST_FACT_REASON.INVALID_SESSION_FACTS, { record: null });

      let transcript = null;
      try {
        transcript = await inspectTranscript({ transcriptPath: input.transcript_path, sessionId, fileSystem });
      } catch {
        transcript = null;
      }
      if (!transcript?.harnessVersion) {
        return unsupportedHostSessionFacts(HOST_FACT_REASON.HOST_METADATA_UNAVAILABLE, { record: null });
      }

      let model = nonemptyString(input.model);
      let modelSource = "hook.model";
      if (!model) {
        const dataDirectory = nonemptyString(environment.PLUGIN_DATA || environment.CLAUDE_PLUGIN_DATA);
        let previous = null;
        try {
          previous = dataDirectory
            ? await readPreviousFacts({
              dataDirectory,
              correlationKey: createSessionCorrelationKey(sessionId),
              projectRoot,
              now,
              maxAgeMs: HOST_FACT_MAX_AGE_MS
            })
            : null;
        } catch {
          previous = null;
        }
        const previousModel = previous?.session?.harness === "claude-code" ? previous.session.model : null;
        if (previousModel && (!transcript.model || baseModel(previousModel) === transcript.model)) {
          model = previousModel;
          modelSource = previous.provenance.fields.model;
        } else {
          model = transcript.model;
          modelSource = "transcript.message.model";
        }
      }
      const host = {
        harness: "claude-code",
        harnessVersion: transcript.harnessVersion,
        provider: providerFor(environment),
        model: model && HOST_VALUE_PATTERN.test(model) ? model : null
      };
      const identitySources = {
        ...ESTIMATE_SOURCES,
        model: host.model ? modelSource : null,
        contextWindowTokens: null,
        compactionThresholdTokens: null,
        compactionScope: null
      };
      const record = (fields) => createHostSessionFactRecord({
        sessionId,
        projectRoot,
        observedAt: timestamp,
        host,
        ...fields
      });
      if (!host.model) {
        const reasonCode = model ? HOST_FACT_REASON.INVALID_MODEL : HOST_FACT_REASON.MISSING_MODEL;
        const unsupported = record({ status: "UNSUPPORTED", reasonCode, sources: identitySources });
        return unsupportedHostSessionFacts(reasonCode, { record: unsupported });
      }

      let settingsAutoCompactWindow = null;
      try {
        settingsAutoCompactWindow = await readAutoCompactWindow({ projectRoot, environment, fileSystem });
      } catch {
        settingsAutoCompactWindow = null;
      }
      const estimate = estimateClaudeCodeCapacity({ model: host.model, environment, settingsAutoCompactWindow });
      if (!estimate) {
        const unsupported = record({
          status: "UNSUPPORTED",
          reasonCode: HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE,
          sources: identitySources
        });
        return unsupportedHostSessionFacts(HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE, { record: unsupported });
      }
      const supported = record({
        status: "SUPPORTED",
        capacityOverrides: estimate,
        compactionScope: "total",
        sources: { ...identitySources, ...ESTIMATE_SOURCES, model: identitySources.model }
      });
      return { status: "SUPPORTED", record: supported };
    }
  };
}
