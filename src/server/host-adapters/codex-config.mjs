import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";

const CONFIG_KEYS = [
  "model",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope"
];
const CAPACITY_KEYS = CONFIG_KEYS.slice(1);
const CONFIG_TIMEOUT_MS = 1200;
const MAX_APP_SERVER_OUTPUT_BYTES = 1024 * 1024;

export const CODEX_CONFIG_REASON = Object.freeze({
  NO_CWD: "NO_CWD",
  INVALID_CWD: "INVALID_CWD",
  APP_SERVER_UNAVAILABLE: "APP_SERVER_UNAVAILABLE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  CONFLICTING_VALUES: "CONFLICTING_VALUES",
  UNSUPPORTED_SCOPE: "UNSUPPORTED_SCOPE"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function unsupported(reasonCode) {
  return { status: "UNSUPPORTED", reasonCode };
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function configuredCommand(environment) {
  const command = nonemptyString(environment.CODEX_CLI_PATH);
  return command || "codex";
}

function configuredArguments(environment) {
  const socket = nonemptyString(
    environment.CODEX_APP_SERVER_SOCKET || environment.CODEX_APP_SERVER_CONTROL_SOCKET
  );
  return socket
    ? ["app-server", "proxy", "--sock", socket]
    : ["app-server", "--stdio"];
}

function writeRequest(child, request) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}

function requestWithAppServer({ cwd, environment, spawnProcess = defaultSpawn, timeoutMs = CONFIG_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let outputBytes = 0;
    let configRequestSent = false;
    let serverInfo = null;
    const child = spawnProcess(configuredCommand(environment), configuredArguments(environment), {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"]
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill?.();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("The Codex app-server config request timed out.")), timeoutMs);
    child.once?.("error", (error) => finish(error));
    child.stdin?.once?.("error", (error) => finish(error));
    child.stdout?.once?.("error", (error) => finish(error));
    child.once?.("close", (code) => {
      if (!settled) finish(new Error(`The Codex app-server closed before config/read completed: ${code}.`));
    });
    child.stdout?.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > MAX_APP_SERVER_OUTPUT_BYTES) {
        finish(new Error("The Codex app-server response exceeded its read limit."));
        return;
      }
      buffer += value.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error("The Codex app-server initialize request failed."));
            return;
          }
          if (!configRequestSent) {
            configRequestSent = true;
            serverInfo = isObject(message.result?.serverInfo)
              ? message.result.serverInfo
              : { version: nonemptyString(message.result?.userAgent) };
            writeRequest(child, {
              jsonrpc: "2.0",
              method: "initialized",
              params: {}
            });
            writeRequest(child, {
              jsonrpc: "2.0",
              id: 2,
              method: "config/read",
              params: { cwd, includeLayers: true }
            });
          }
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error("The Codex app-server config/read request failed."));
          } else {
            finish(null, { ...message.result, serverInfo });
          }
          return;
        }
      }
    });
    writeRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "prism-capacity", version: "1" },
        capabilities: { experimentalApi: true }
      }
    });
  });
}

function validateOriginShape(origins) {
  return isObject(origins) && CAPACITY_KEYS.every((key) => (
    !Object.hasOwn(origins, key) || isObject(origins[key])
  ));
}

function normalizeConfigResponse(response, { now }) {
  if (
    !isObject(response)
    || !isObject(response.config)
    || !validateOriginShape(response.origins)
    || !Array.isArray(response.layers)
    || response.layers.some((layer) => !isObject(layer) || !isObject(layer.config))
  ) {
    return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  }
  const config = response.config;
  const layers = response.layers;
  const model = config.model === null || config.model === undefined ? null : nonemptyString(config.model);
  const contextWindow = config.model_context_window;
  const threshold = config.model_auto_compact_token_limit;
  const scope = config.model_auto_compact_token_limit_scope;
  if (config.model !== null && config.model !== undefined && !model) {
    return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  }
  if (contextWindow !== null && contextWindow !== undefined && !positiveSafeInteger(contextWindow)) {
    return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  }
  if (threshold !== null && threshold !== undefined && !positiveSafeInteger(threshold)) {
    return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  }
  if (scope !== null && scope !== undefined && scope !== "total" && scope !== "body_after_prefix") {
    return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  }
  if (scope === "body_after_prefix") {
    return unsupported(CODEX_CONFIG_REASON.UNSUPPORTED_SCOPE);
  }
  for (const key of CAPACITY_KEYS) {
    const effectivePresent = config[key] !== null && config[key] !== undefined;
    const originPresent = Object.hasOwn(response.origins, key);
    const layerPresent = layers.some((layer) => (
      Object.hasOwn(layer.config, key)
      && layer.config[key] !== null
      && layer.config[key] !== undefined
    ));
    if (effectivePresent !== originPresent || effectivePresent !== layerPresent) {
      return unsupported(CODEX_CONFIG_REASON.CONFLICTING_VALUES);
    }
  }
  const verifiedAt = isoNow(now);
  if (!verifiedAt) return unsupported(CODEX_CONFIG_REASON.INVALID_RESPONSE);
  const sourceVersion = nonemptyString(response.serverInfo?.version)
    || nonemptyString(response.version)
    || "codex-app-server";
  return {
    status: "SUPPORTED",
    config: {
      model,
      model_context_window: contextWindow ?? null,
      model_auto_compact_token_limit: threshold ?? null,
      model_auto_compact_token_limit_scope: scope ?? null
    },
    provenance: {
      source: "codex-app-server-config-read",
      sourceVersion,
      verifiedAt,
      fields: {
        model: model === null ? null : "config.model",
        model_context_window: contextWindow === null || contextWindow === undefined
          ? null
          : "config.model_context_window",
        model_auto_compact_token_limit: threshold === null || threshold === undefined
          ? null
          : "config.model_auto_compact_token_limit",
        model_auto_compact_token_limit_scope: scope === null || scope === undefined
          ? null
          : "config.model_auto_compact_token_limit_scope"
      },
      absent: Object.fromEntries(CAPACITY_KEYS.map((key) => [
        key,
        config[key] === null || config[key] === undefined
      ])),
      layerKeys: CAPACITY_KEYS
    }
  };
}

export async function inspectCodexEffectiveConfig({
  cwd,
  environment = process.env,
  request = requestWithAppServer,
  now = () => new Date(),
  timeoutMs = CONFIG_TIMEOUT_MS
} = {}) {
  const normalizedCwd = nonemptyString(cwd);
  if (!normalizedCwd) return unsupported(CODEX_CONFIG_REASON.NO_CWD);
  if (!path.isAbsolute(normalizedCwd)) return unsupported(CODEX_CONFIG_REASON.INVALID_CWD);
  if (typeof request !== "function") return unsupported(CODEX_CONFIG_REASON.APP_SERVER_UNAVAILABLE);
  try {
    const response = await request({
      cwd: normalizedCwd,
      environment,
      timeoutMs
    });
    return normalizeConfigResponse(response, { now });
  } catch {
    return unsupported(CODEX_CONFIG_REASON.APP_SERVER_UNAVAILABLE);
  }
}

export { normalizeConfigResponse };
