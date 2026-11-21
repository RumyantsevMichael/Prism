// Generated from src/server/session/run-options.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { EFFORT_PATTERN, HOST_REQUEST_REFUSAL, HOSTS, hostDefinition, lineSplitter, MODEL_PATTERN, PROVIDER_PATTERN, resolveHost, strippedEnvironment } from "./launch-hosts.mjs";
const RUN_KINDS = Object.freeze([
  Object.freeze({ kind: "coordinator", label: "Coordinator", purpose: "coordinator" }),
  Object.freeze({ kind: "designImplementation", label: "Design and implementation", purpose: "agents" }),
  Object.freeze({ kind: "codeReview", label: "Code review", purpose: "agents" }),
  Object.freeze({ kind: "securityReview", label: "Security review", purpose: "agents" }),
  Object.freeze({ kind: "gateSummary", label: "Design gate summary", purpose: "agents" })
]);
const PURPOSES = Object.freeze(["coordinator", "agents"]);
const NAME_RULE_MESSAGES = Object.freeze({
  model: "A model name has 1 to 200 letters, digits, and . _ - : / @ [ ] +, and starts with a letter or digit.",
  provider: "A provider name has 1 to 64 letters, digits, and . _ -, and starts with a letter or digit.",
  effort: "An effort level has 1 to 32 lowercase letters, digits, _ and -, and starts with a letter."
});
const PATTERNS = { model: MODEL_PATTERN, provider: PROVIDER_PATTERN, effort: EFFORT_PATTERN };
const validModel = (value) => typeof value === "string" && MODEL_PATTERN.test(value);
const validProvider = (value) => typeof value === "string" && PROVIDER_PATTERN.test(value);
const validEffort = (value) => typeof value === "string" && EFFORT_PATTERN.test(value);
function nameRuleBreach({ provider = null, model = null, effort = null }) {
  for (const [field, value] of [["provider", provider], ["model", model], ["effort", effort]]) {
    if (value !== null && (typeof value !== "string" || !PATTERNS[field].test(value))) return { field, message: NAME_RULE_MESSAGES[field] };
  }
  return null;
}
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_NAMES = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
function effortName(level) {
  return EFFORT_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}
function rankEfforts(levels) {
  const seen = /* @__PURE__ */ new Map();
  for (const level of levels) {
    const entry = typeof level === "string" ? { value: level, description: "" } : level;
    if (validEffort(entry?.value) && !seen.has(entry.value)) seen.set(entry.value, { value: entry.value, description: typeof entry.description === "string" ? entry.description : "" });
  }
  const rank = (value) => EFFORT_RANK.includes(value) ? EFFORT_RANK.indexOf(value) : EFFORT_RANK.length;
  return [...seen.values()].map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry.value) - rank(b.entry.value) || a.index - b.index).map(({ entry }) => entry);
}
const choiceReasons = Object.freeze({
  model: (hostLabel, model) => `${hostLabel} on this computer does not offer the model ${model}.`,
  effort: (modelName, effort) => `${modelName} does not take the effort ${effort}.`,
  provider: (hostLabel, provider) => `${hostLabel} on this computer has no provider ${provider}.`,
  typed: (hostLabel) => `Prism cannot check a model you typed; ${hostLabel} receives it as written.`
});
class RunOptionsError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.name = "RunOptionsError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const supportedHosts = () => {
  const names = HOSTS.map(({ host }) => host);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
};
function checkedSelection({ host, purpose, provider = null, model = null, effort = null, typed = false }) {
  const definition = hostDefinition(host);
  if (!definition) throw new RunOptionsError(400, "unknown_host", `Prism supports no host ${host}; it supports ${supportedHosts()}.`);
  if (!PURPOSES.includes(purpose)) throw new RunOptionsError(400, "invalid_request", "for must be coordinator or agents.");
  const breach = nameRuleBreach({ provider, model, effort });
  if (breach) throw new RunOptionsError(400, "invalid_input", breach.message, breach.field);
  return { definition, purpose, provider, model, effort, typed: typed === true && model !== null };
}
function runOptionsQuery(searchParams) {
  const value = (name) => searchParams.has(name) ? searchParams.get(name) : null;
  const selection = { host: value("host") ?? "", purpose: value("for"), provider: value("provider"), model: value("model"), effort: value("effort"), typed: value("typed") === "1" };
  checkedSelection(selection);
  return selection;
}
const REPORT_TTL_MS = 10 * 60 * 1e3;
const KEPT_REPORTS = 16;
const EXIT_GRACE_MS = 5e3;
const KILL_GRACE_MS = 2e3;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_PAGES = 100;
const MAX_REPORT_MODELS = 1e3;
const MAX_REPORT_PROVIDERS = 100;
const MAX_MODEL_LEVELS = 16;
const HOST_TEXT_MAX = 300;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 300;
function readTimeoutMs(env = process.env) {
  const value = Number(env.PRISM_RUN_OPTIONS_TIMEOUT_MS);
  if (!env.PRISM_RUN_OPTIONS_TIMEOUT_MS || !Number.isFinite(value)) return 2e4;
  return Math.min(6e4, Math.max(200, Math.round(value)));
}
const seconds = (ms) => String(Math.round(ms / 100) / 10);
const text = (value) => typeof value === "string" ? value : "";
const hostText = (value) => text(value).replace(/\s+/g, " ").trim().slice(0, HOST_TEXT_MAX).replace(/\.+$/, "");
const failed = (message) => ({ state: "failed", message: hostText(message) || "it gave no reason" });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const cutName = (value) => text(value).slice(0, NAME_MAX);
const cutDescription = (value) => text(value).slice(0, DESCRIPTION_MAX);
const tooMany = (count, max, what) => count > max ? `it listed more than ${max} ${what}` : null;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,39}$/;
const versionOf = (value) => typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
const codexVersion = (userAgent) => versionOf(/^[^\s/]+\/([^\s/]+)/.exec(text(userAgent))?.[1] ?? null);
const reports = /* @__PURE__ */ new Map();
function forgetRunOptions() {
  reports.clear();
}
function keptReport(resolved, { checkout, env, provider }) {
  const key = JSON.stringify([resolved.host, resolved.executable, checkout, provider]);
  const kept = reports.get(key);
  if (kept && (kept.expires === null || Date.now() < kept.expires)) return kept.promise;
  const entry = { expires: null, promise: null };
  entry.promise = readHost(resolved, { checkout, env, provider }).then((raw) => {
    if (reports.get(key) === entry) {
      if (raw.state === "ready" && !raw.modelsError) entry.expires = Date.now() + REPORT_TTL_MS;
      else reports.delete(key);
    }
    return raw;
  });
  reports.delete(key);
  reports.set(key, entry);
  while (reports.size > KEPT_REPORTS) reports.delete(reports.keys().next().value);
  return entry.promise;
}
function readHost(resolved, { checkout, env, provider }) {
  const timeoutMs = readTimeoutMs(env);
  const { optionsRead } = resolved;
  const conversation = resolved.host === "claude-code" ? claudeConversation(optionsRead) : codexConversation(optionsRead, provider);
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let inputOpen = true;
    let exited = false;
    let ending = false;
    let stderr = "";
    let timer = null;
    const closeInput = () => {
      if (!inputOpen) return;
      inputOpen = false;
      try {
        child.stdin.end();
      } catch {
      }
    };
    const end = () => {
      if (exited || ending) return;
      ending = true;
      try {
        child.kill();
      } catch {
      }
      setTimeout(() => {
        if (!exited) try {
          child.kill("SIGKILL");
        } catch {
        }
      }, KILL_GRACE_MS).unref();
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeInput();
      if (!exited) setTimeout(end, EXIT_GRACE_MS).unref();
      resolve(outcome);
    };
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...optionsRead.args], { cwd: checkout, env: strippedEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve(failed(`it could not be started: ${error.message}`));
      return;
    }
    timer = setTimeout(() => {
      finish(failed(`it gave no answer within ${seconds(timeoutMs)} seconds`));
      end();
    }, timeoutMs);
    const send = (message) => {
      if (inputOpen && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}
`);
    };
    const splitter = lineSplitter((line) => {
      if (settled) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (isObject(event)) conversation.event(event, { send, done: finish, fail: (message) => finish(failed(message)) });
    }, MAX_REPORT_BYTES);
    child.stdin.on("error", () => {
    });
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REPORT_BYTES) {
        finish(failed(`it sent more than ${MAX_REPORT_BYTES / (1024 * 1024)} MiB`));
        end();
        return;
      }
      splitter.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2e3);
    });
    child.on("error", (error) => {
      exited = exited || child.exitCode !== null || child.signalCode !== null;
      finish(failed(`it could not be started: ${error.message}`));
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code, signal) => {
      exited = true;
      splitter.end();
      const last = stderr.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      const how = signal ? `it was ended by ${signal}` : `it ended with exit code ${code}`;
      finish(failed(`${how} before it answered${last ? `: ${last}` : ""}`));
    });
    conversation.start({ send });
  });
}
function claudeConversation(optionsRead) {
  const { request } = optionsRead;
  return {
    start: ({ send }) => send(request),
    event(event, { done, fail }) {
      if (event.type !== "control_response" || event.response?.request_id !== request.request_id) return;
      if (event.response.subtype !== "success") {
        fail(text(event.response.error) || "it refused the initialize request");
        return;
      }
      const models = event.response.response?.models;
      if (!Array.isArray(models)) {
        fail("its answer holds no model list");
        return;
      }
      const listed = models.filter(isObject);
      const excess = tooMany(listed.length, MAX_REPORT_MODELS, "models");
      if (excess) fail(excess);
      else done({ state: "ready", version: versionOf(event.response.response?.claude_code_version), models: listed.map(keptClaudeModel) });
    }
  };
}
function codexConversation(optionsRead, provider) {
  const pending = /* @__PURE__ */ new Map();
  const seenCursors = /* @__PURE__ */ new Set();
  const report = { state: "ready", version: null, providers: [], defaultProviderId: null, models: [], modelsError: null };
  let nextId = 1;
  let pages = 0;
  let send = () => {
  };
  const request = (method, params) => {
    const id = nextId++;
    pending.set(id, method);
    send({ jsonrpc: "2.0", id, method, params });
  };
  const listModels = (cursor) => {
    pages += 1;
    request("model/list", { includeHidden: false, ...cursor ? { cursor } : {}, ...provider ? { modelProvider: provider } : {} });
  };
  return {
    start(io) {
      send = io.send;
      request("initialize", optionsRead.client);
    },
    event(message, { done, fail }) {
      const hasId = typeof message.id === "string" || typeof message.id === "number";
      if (hasId && typeof message.method === "string") {
        send({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
        return;
      }
      if (!hasId || !pending.has(message.id)) return;
      const method = pending.get(message.id);
      pending.delete(message.id);
      const refused = message.error !== void 0 && message.error !== null;
      if (method === "model/list" && refused) {
        done({ ...report, models: [], modelsError: hostText(message.error?.message) || "it gave no reason" });
        return;
      }
      if (refused) {
        fail(text(message.error?.message) || `it refused ${method}`);
        return;
      }
      const result = message.result;
      if (method === "initialize") {
        report.version = codexVersion(result?.userAgent);
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        request("modelProvider/list", {});
        return;
      }
      if (method === "modelProvider/list") {
        if (!Array.isArray(result?.data)) {
          fail("its provider list has an unexpected shape");
          return;
        }
        const listed = result.data.filter(isObject);
        const excess = tooMany(listed.length, MAX_REPORT_PROVIDERS, "providers");
        if (excess) {
          fail(excess);
          return;
        }
        report.providers = listed.map((entry) => ({ id: validProvider(entry.id) ? entry.id : null, name: cutName(entry.name) }));
        report.defaultProviderId = validProvider(result.defaultProviderId) ? result.defaultProviderId : null;
        listModels(null);
        return;
      }
      if (method === "model/list") {
        if (!Array.isArray(result?.data)) {
          fail("its model list has an unexpected shape");
          return;
        }
        const listed = result.data.filter(isObject);
        const excess = tooMany(report.models.length + listed.length, MAX_REPORT_MODELS, "models");
        if (excess) {
          fail(excess);
          return;
        }
        report.models.push(...listed.map(keptCodexModel));
        const cursor = result.nextCursor;
        if (typeof cursor === "string" && cursor && !seenCursors.has(cursor) && pages < MAX_MODEL_PAGES) {
          seenCursors.add(cursor);
          listModels(cursor);
          return;
        }
        done(report);
      }
    }
  };
}
function keptClaudeModel(entry) {
  return {
    value: validModel(entry.value) ? entry.value : null,
    displayName: cutName(entry.displayName),
    description: cutDescription(entry.description),
    supportsEffort: entry.supportsEffort !== false,
    supportedEffortLevels: Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter(validEffort).slice(0, MAX_MODEL_LEVELS) : []
  };
}
function keptCodexModel(entry) {
  const value = typeof entry.model === "string" ? entry.model : entry.id;
  const levels = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.filter((level) => isObject(level) && validEffort(level.reasoningEffort)) : [];
  return {
    model: validModel(value) ? value : null,
    displayName: cutName(entry.displayName),
    description: cutDescription(entry.description),
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    defaultReasoningEffort: validEffort(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: levels.slice(0, MAX_MODEL_LEVELS).map((level) => ({ reasoningEffort: level.reasoningEffort, description: cutDescription(level.description) }))
  };
}
const CLAUDE_AGENT_FAMILIES = ["sonnet", "opus", "haiku", "fable"];
const ADAPTERS = {
  "claude-code": {
    modelDefault: (raw, purpose) => purpose === "agents" ? "The coordinator's model, unless the host's settings name a model for agents." : text(raw?.models?.find((entry) => entry.value === "default")?.description),
    effortDefault: () => "The effort Claude Code uses when none is chosen.",
    map(raw, purpose) {
      const levelsOf = (entry) => entry.supportsEffort !== false && Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter((level) => typeof level === "string") : [];
      const models = raw.models.filter((entry) => entry.value !== "default" && validModel(entry.value)).filter((entry) => purpose !== "agents" || CLAUDE_AGENT_FAMILIES.includes(entry.value)).map((entry) => ({ value: entry.value, name: text(entry.displayName) || entry.value, description: text(entry.description), levels: levelsOf(entry), defaultEffort: null }));
      const allLevels = raw.models.flatMap(levelsOf);
      return { providers: null, models, allLevels, defaultModel: null };
    }
  },
  codex: {
    modelDefault: (raw, purpose) => purpose === "agents" ? "The coordinator's model." : text(raw?.models?.find((entry) => entry.isDefault === true && entry.hidden !== true)?.displayName),
    effortDefault: (model) => validEffort(model?.defaultEffort) ? `${effortName(model.defaultEffort)}, the model's default.` : "The model's default.",
    map(raw, purpose) {
      let providers = null;
      if (purpose === "coordinator") {
        const named = raw.providers.filter((entry) => validProvider(entry.id));
        const fallback = named.find((entry) => entry.id === raw.defaultProviderId);
        providers = {
          defaultDescription: text(fallback?.name) || (raw.defaultProviderId ?? ""),
          values: named.map((entry) => ({ value: entry.id, name: text(entry.name) || entry.id, description: "" }))
        };
      }
      const models = raw.models.filter((entry) => entry.hidden !== true && validModel(entry.model)).map((entry) => ({
        value: entry.model,
        name: text(entry.displayName) || entry.model,
        description: text(entry.description),
        levels: (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []).filter(isObject).map((level) => ({ value: level.reasoningEffort, description: text(level.description) })),
        defaultEffort: typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null,
        isDefault: entry.isDefault === true
      }));
      const allLevels = models.flatMap((entry) => entry.levels);
      const defaultModel = purpose === "coordinator" ? models.find((entry) => entry.isDefault) ?? null : null;
      return { providers, models, allLevels, defaultModel };
    }
  }
};
const hostDefault = (description) => ({ value: null, name: "Host default", description });
const offered = (value) => ({ value, state: "offered", reason: null });
const notOffered = (value, reason) => ({ value, state: "not-offered", reason });
const unchecked = (value, reason) => ({ value, state: "unchecked", reason });
function buildReport(definition, { purpose, provider, model, effort, typed }, raw, executable) {
  const { host, label } = definition;
  const adapter = ADAPTERS[host];
  const ready = raw.state === "ready";
  const reason = !ready ? `${label} did not report its run options: ${raw.message}.` : raw.modelsError ? `${label} could not list its models: ${raw.modelsError}` : null;
  const modelsChecked = reason === null;
  const mapped = ready ? adapter.map(raw, purpose) : { providers: host === "codex" && purpose === "coordinator" ? { defaultDescription: "", values: [] } : null, models: [], allLevels: [], defaultModel: null };
  const options = [];
  if (mapped.providers) {
    const values = mapped.providers.values;
    const chosen = provider === null || values.some((entry) => entry.value === provider) ? offered(provider) : ready ? notOffered(provider, choiceReasons.provider(label, provider)) : unchecked(provider, reason);
    options.push({ id: "provider", name: "Provider", kind: "provider", values: [hostDefault(mapped.providers.defaultDescription), ...values], chosen });
  }
  const listed = model === null ? null : mapped.models.find((entry) => entry.value === model) ?? null;
  let modelChoice;
  if (model === null || listed) modelChoice = offered(model);
  else if (typed) modelChoice = { value: model, state: "typed", reason: choiceReasons.typed(label) };
  else if (!modelsChecked) modelChoice = unchecked(model, reason);
  else modelChoice = notOffered(model, choiceReasons.model(label, model));
  options.push({
    id: "model",
    name: "Model",
    kind: "model",
    values: [hostDefault(adapter.modelDefault(ready ? raw : null, purpose)), ...mapped.models.map(({ value, name, description }) => ({ value, name, description }))],
    chosen: modelChoice,
    reportedNone: ready && mapped.models.length === 0
  });
  const effortModel = model === null ? mapped.defaultModel : listed;
  const levels = !ready ? [] : effortModel ? effortModel.levels : mapped.allLevels;
  const efforts = rankEfforts(levels).slice(0, MAX_MODEL_LEVELS).map(({ value, description }) => ({ value, name: effortName(value), description }));
  const modelName = listed?.name ?? model ?? mapped.defaultModel?.name ?? "The host's default model";
  const effortChoice = effort === null || efforts.some((entry) => entry.value === effort) ? offered(effort) : !modelsChecked ? unchecked(effort, reason) : notOffered(effort, choiceReasons.effort(modelName, effort));
  options.push({ id: "effort", name: "Effort", kind: "effort", values: [hostDefault(adapter.effortDefault(effortModel)), ...efforts], chosen: effortChoice });
  const source = { program: label, executable, version: ready ? raw.version ?? null : null };
  return { host, label, state: ready ? "ready" : "failed", reason, source, options };
}
async function readRunOptions({ host, purpose, provider = null, model = null, effort = null, typed = false, checkout, env = process.env }) {
  const selection = checkedSelection({ host, purpose, provider, model, effort, typed });
  const { definition } = selection;
  const resolved = await resolveHost(definition.host, env);
  if (!resolved.available) return { host: definition.host, label: definition.label, state: "unavailable", reason: resolved.reason, source: null, options: [] };
  const raw = await keptReport(resolved, { checkout, env, provider: definition.host === "codex" ? selection.provider : null });
  return buildReport(definition, selection, raw, resolved.executable);
}
export {
  EFFORT_PATTERN,
  MODEL_PATTERN,
  NAME_RULE_MESSAGES,
  PROVIDER_PATTERN,
  PURPOSES,
  REPORT_TTL_MS,
  RUN_KINDS,
  RunOptionsError,
  choiceReasons,
  effortName,
  forgetRunOptions,
  nameRuleBreach,
  rankEfforts,
  readRunOptions,
  readTimeoutMs,
  runOptionsQuery,
  validEffort,
  validModel,
  validProvider
};
