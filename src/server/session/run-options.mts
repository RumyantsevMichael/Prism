import { spawn } from "node:child_process";
import { EFFORT_PATTERN, HOST_REQUEST_REFUSAL, builtinHost, HOSTS, lineSplitter, MODEL_PATTERN, PROVIDER_PATTERN, resolveHost, strippedEnvironment } from "./launch-hosts.mjs";

// The run options of a host, read from the host itself and mapped into one ordered shape: provider, model, and effort, each with
// the host default first as a null value. Prism reads a host's report with no model turn and no kept session, keeps a report for
// REPORT_TTL_MS per host, executable, checkout, and provider, and shares a read in flight; a failed read is not kept.
// A read is bounded: a host that sends more than MAX_REPORT_BYTES, or lists more than MAX_REPORT_MODELS models or
// MAX_REPORT_PROVIDERS providers, answers failed, and a kept report holds only the fields the adapters map, with each name and
// description cut to NAME_MAX and DESCRIPTION_MAX characters and at most MAX_MODEL_LEVELS effort levels per model.
// Nothing here passes a value to a host's command line: a read runs only the fixed arguments of the host's optionsRead.

/** The kinds of run choice, in order, with their labels and the purpose whose options they choose from. */
export const RUN_KINDS = Object.freeze([
  Object.freeze({ kind: "coordinator", label: "Coordinator", purpose: "coordinator" }),
  Object.freeze({ kind: "designImplementation", label: "Design and implementation", purpose: "agents" }),
  Object.freeze({ kind: "codeReview", label: "Code review", purpose: "agents" }),
  Object.freeze({ kind: "securityReview", label: "Security review", purpose: "agents" }),
  Object.freeze({ kind: "gateSummary", label: "Design gate summary", purpose: "agents" })
]);
export const PURPOSES = Object.freeze(["coordinator", "agents"]);

// The name rules live beside the host commands, which check a launch's choice against them again.
export { EFFORT_PATTERN, MODEL_PATTERN, PROVIDER_PATTERN };
export const NAME_RULE_MESSAGES = Object.freeze({
  model: "A model name has 1 to 200 letters, digits, and . _ - : / @ [ ] +, and starts with a letter or digit.",
  provider: "A provider name has 1 to 64 letters, digits, and . _ -, and starts with a letter or digit.",
  effort: "An effort level has 1 to 32 lowercase letters, digits, _ and -, and starts with a letter."
});
const PATTERNS: Record<string, RegExp> = { model: MODEL_PATTERN, provider: PROVIDER_PATTERN, effort: EFFORT_PATTERN };

export const validModel = (value: any) => typeof value === "string" && MODEL_PATTERN.test(value);
export const validProvider = (value: any) => typeof value === "string" && PROVIDER_PATTERN.test(value);
export const validEffort = (value: any) => typeof value === "string" && EFFORT_PATTERN.test(value);

/** The first of provider, model, and effort whose non-null value breaks its name rule, or null. */
export function nameRuleBreach({ provider = null, model = null, effort = null }: { provider?: any; model?: any; effort?: any }) {
  for (const [field, value] of [["provider", provider], ["model", model], ["effort", effort]] as [string, any][]) {
    if (value !== null && (typeof value !== "string" || !PATTERNS[field].test(value))) return { field, message: (NAME_RULE_MESSAGES as Record<string, string>)[field] };
  }
  return null;
}

// Effort levels rank lowest first by this list, and any other level follows in the host's order.
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_NAMES: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** A level's name: the known names, and otherwise the level with its first letter in capitals. */
export function effortName(level: any) {
  return EFFORT_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

/** Levels, as strings or { value, description }, without repeats, ranked lowest first; the host's order breaks a tie. */
export function rankEfforts(levels: any) {
  const seen = new Map();
  for (const level of levels) {
    const entry = typeof level === "string" ? { value: level, description: "" } : level;
    if (validEffort(entry?.value) && !seen.has(entry.value)) seen.set(entry.value, { value: entry.value, description: typeof entry.description === "string" ? entry.description : "" });
  }
  const rank = (value: any) => (EFFORT_RANK.includes(value) ? EFFORT_RANK.indexOf(value) : EFFORT_RANK.length);
  return [...seen.values()].map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry.value) - rank(b.entry.value) || a.index - b.index).map(({ entry }) => entry);
}

/** The choice reasons, used wherever a value is not offered, and the note of a typed model. */
export const choiceReasons = Object.freeze({
  model: (hostLabel: any, model: any) => `${hostLabel} on this computer does not offer the model ${model}.`,
  effort: (modelName: any, effort: any) => `${modelName} does not take the effort ${effort}.`,
  provider: (hostLabel: any, provider: any) => `${hostLabel} on this computer has no provider ${provider}.`,
  typed: (hostLabel: any) => `Prism cannot check a model you typed; ${hostLabel} receives it as written.`
});

/** A refused query or call: status is the HTTP status the review server answers with, and field names an invalid_input. */
export class RunOptionsError extends Error {
  declare code: any;
  declare field: any;
  declare status: any;
  constructor(status: any, code: any, message: any, field: any = null) {
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

function checkedSelection({ host, purpose, provider = null, model = null, effort = null, typed = false }: any) {
  const definition = builtinHost(host);
  if (!definition) throw new RunOptionsError(400, "unknown_host", `Prism supports no host ${host}; it supports ${supportedHosts()}.`);
  if (!PURPOSES.includes(purpose)) throw new RunOptionsError(400, "invalid_request", "for must be coordinator or agents.");
  const breach = nameRuleBreach({ provider, model, effort });
  if (breach) throw new RunOptionsError(400, "invalid_input", breach.message, breach.field);
  return { definition, purpose, provider, model, effort, typed: typed === true && model !== null };
}

const LAUNCH_FIELDS = ["command", "args", "env", "prompt", "cwd"];

/** The selection of a GET api/run-options query; a refused query throws a RunOptionsError. */
export function runOptionsQuery(searchParams: any) {
  // A host's command, arguments, environment, prompt, and folder come only from Prism's own host definitions and the agents'
  // declarations and install records, so a query that names one is refused before anything starts.
  const launchField = LAUNCH_FIELDS.find((name) => searchParams.has(name));
  if (launchField) throw new RunOptionsError(400, "invalid_input", `${launchField} cannot be set from the review page: a host's command, arguments, environment, prompt, and folder come only from Prism and the agent's declaration or install record.`, launchField);
  const value = (name: any) => (searchParams.has(name) ? searchParams.get(name) : null);
  const selection = { host: value("host") ?? "", purpose: value("for"), provider: value("provider"), model: value("model"), effort: value("effort"), typed: value("typed") === "1" };
  checkedSelection(selection);
  return selection;
}

export const REPORT_TTL_MS = 10 * 60 * 1000;
const KEPT_REPORTS = 16;
// A host still running this long after its input closed is ended.
const EXIT_GRACE_MS = 5000;
const KILL_GRACE_MS = 2000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_PAGES = 100;
const MAX_REPORT_MODELS = 1000;
const MAX_REPORT_PROVIDERS = 100;
const MAX_MODEL_LEVELS = 16;
const HOST_TEXT_MAX = 300;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 300;

/** The read time from PRISM_RUN_OPTIONS_TIMEOUT_MS: 200 to 60000 milliseconds, 20000 by default. */
export function readTimeoutMs(env = process.env) {
  const value = Number(env.PRISM_RUN_OPTIONS_TIMEOUT_MS);
  if (!env.PRISM_RUN_OPTIONS_TIMEOUT_MS || !Number.isFinite(value)) return 20000;
  return Math.min(60000, Math.max(200, Math.round(value)));
}

const seconds = (ms: any) => String(Math.round(ms / 100) / 10);
const text = (value: any) => (typeof value === "string" ? value : "");
// Host text in a reason: one line, cut, without its own closing period, since the reason adds one.
const hostText = (value: any) => text(value).replace(/\s+/g, " ").trim().slice(0, HOST_TEXT_MAX).replace(/\.+$/, "");
const failed = (message: any) => ({ state: "failed", message: hostText(message) || "it gave no reason" });
const isObject = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const cutName = (value: any) => text(value).slice(0, NAME_MAX);
const cutDescription = (value: any) => text(value).slice(0, DESCRIPTION_MAX);
const tooMany = (count: any, max: any, what: any) => (count > max ? `it listed more than ${max} ${what}` : null);

const reports = new Map();

/** Forgets every kept report, so the next query reads its host again. */
export function forgetRunOptions() {
  reports.clear();
}

function keptReport(resolved: any, { checkout, env, provider }: any) {
  const key = JSON.stringify([resolved.host, resolved.executable, checkout, provider]);
  const kept = reports.get(key);
  if (kept && (kept.expires === null || Date.now() < kept.expires)) return kept.promise;
  const entry: { expires: number | null; promise: Promise<any> | null } = { expires: null, promise: null };
  entry.promise = readHost(resolved, { checkout, env, provider }).then((raw: any) => {
    if (reports.get(key) === entry) {
      if (raw.state === "ready" && !raw.modelsError) entry.expires = Date.now() + REPORT_TTL_MS;
      else reports.delete(key);
    }
    return raw;
  });
  reports.delete(key);
  reports.set(key, entry);
  while (reports.size > KEPT_REPORTS) reports.delete(reports.keys().next().value!);
  return entry.promise;
}

// One read: the host runs with its fixed options-read arguments in the checkout, with the stripped environment, and its
// conversation answers the raw report; the input closes once the conversation has its answer, a host still running
// EXIT_GRACE_MS later is ended, and a host that gives no answer within the read time is ended at once.
function readHost(resolved: any, { checkout, env, provider }: any) {
  const timeoutMs = readTimeoutMs(env);
  const { optionsRead } = resolved;
  const conversation = resolved.host === "claude-code" ? claudeConversation(optionsRead) : codexConversation(optionsRead, provider);
  return new Promise((resolve) => {
    let child: any;
    let settled = false;
    let inputOpen = true;
    let exited = false;
    let ending = false;
    let stderr = "";
    let timer: any = null;
    const closeInput = () => {
      if (!inputOpen) return;
      inputOpen = false;
      try { child.stdin.end(); } catch {}
    };
    const end = () => {
      if (exited || ending) return;
      ending = true;
      try { child.kill(); } catch {}
      setTimeout(() => { if (!exited) try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS).unref();
    };
    const finish = (outcome: any) => {
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
    const send = (message: any) => {
      if (inputOpen && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const splitter = lineSplitter((line) => {
      if (settled) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (isObject(event)) conversation.event(event, { send, done: finish, fail: (message: any) => finish(failed(message)) });
    }, MAX_REPORT_BYTES);
    child.stdin.on("error", () => {});
    let bytes = 0;
    child.stdout.on("data", (chunk: any) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REPORT_BYTES) {
        finish(failed(`it sent more than ${MAX_REPORT_BYTES / (1024 * 1024)} MiB`));
        end();
        return;
      }
      splitter.push(chunk);
    });
    child.stderr.on("data", (chunk: any) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
    child.on("error", (error: any) => {
      exited = exited || child.exitCode !== null || child.signalCode !== null;
      finish(failed(`it could not be started: ${error.message}`));
    });
    child.on("exit", () => { exited = true; });
    child.on("close", (code: any, signal: any) => {
      exited = true;
      splitter.end();
      const last = stderr.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      const how = signal ? `it was ended by ${signal}` : `it ended with exit code ${code}`;
      finish(failed(`${how} before it answered${last ? `: ${last}` : ""}`));
    });
    conversation.start({ send });
  });
}

// Claude Code: one initialize control request, whose answer lists the models with their effort levels.
function claudeConversation(optionsRead: any) {
  const { request } = optionsRead;
  return {
    start: ({ send }: any) => send(request),
    event(event: any, { done, fail }: any) {
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
      else done({ state: "ready", models: listed.map(keptClaudeModel) });
    }
  };
}

// Codex: initialize, initialized, modelProvider/list, and then model/list page by page for the provider, with no thread.
function codexConversation(optionsRead: any, provider: any) {
  const pending = new Map();
  const seenCursors = new Set();
  const report: { state: string; providers: any[]; defaultProviderId: any; models: any[]; modelsError: any } = { state: "ready", providers: [], defaultProviderId: null, models: [], modelsError: null };
  let nextId = 1;
  let pages = 0;
  let send: (message: unknown) => void = () => {};
  const request = (method: any, params: any) => {
    const id = nextId++;
    pending.set(id, method);
    send({ jsonrpc: "2.0", id, method, params });
  };
  const listModels = (cursor: any) => {
    pages += 1;
    request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}), ...(provider ? { modelProvider: provider } : {}) });
  };
  return {
    start(io: any) {
      send = io.send;
      request("initialize", optionsRead.client);
    },
    event(message: any, { done, fail }: any) {
      const hasId = typeof message.id === "string" || typeof message.id === "number";
      if (hasId && typeof message.method === "string") {
        send({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
        return;
      }
      if (!hasId || !pending.has(message.id)) return;
      const method = pending.get(message.id);
      pending.delete(message.id);
      const refused = message.error !== undefined && message.error !== null;
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
        report.providers = listed.map((entry: any) => ({ id: validProvider(entry.id) ? entry.id : null, name: cutName(entry.name) }));
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

// The fields of a listed model that the adapters map, with each name and description cut and its effort levels bounded; a model
// value that breaks the model rule is kept as null, so the adapters leave it out.
function keptClaudeModel(entry: any) {
  return {
    value: validModel(entry.value) ? entry.value : null,
    displayName: cutName(entry.displayName),
    description: cutDescription(entry.description),
    supportsEffort: entry.supportsEffort !== false,
    supportedEffortLevels: Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter(validEffort).slice(0, MAX_MODEL_LEVELS) : []
  };
}

function keptCodexModel(entry: any) {
  const value = typeof entry.model === "string" ? entry.model : entry.id;
  const levels = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.filter((level: any) => isObject(level) && validEffort(level.reasoningEffort)) : [];
  return {
    model: validModel(value) ? value : null,
    displayName: cutName(entry.displayName),
    description: cutDescription(entry.description),
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    defaultReasoningEffort: validEffort(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: levels.slice(0, MAX_MODEL_LEVELS).map((level: any) => ({ reasoningEffort: level.reasoningEffort, description: cutDescription(level.description) }))
  };
}

// Each adapter maps a raw report into { providers, models, allLevels, defaultModel } for a purpose, where models are
// { value, name, description, levels, defaultEffort } and providers is null for a host or purpose without a provider option.
const CLAUDE_AGENT_FAMILIES = ["sonnet", "opus", "haiku", "fable"];
const ADAPTERS: Record<string, any> = {
  "claude-code": {
    modelDefault: (raw: any, purpose: any) => purpose === "agents"
      ? "The coordinator's model, unless the host's settings name a model for agents."
      : text(raw?.models?.find((entry: any) => entry.value === "default")?.description),
    effortDefault: () => "The effort Claude Code uses when none is chosen.",
    map(raw: any, purpose: any) {
      const levelsOf = (entry: any) => (entry.supportsEffort !== false && Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter((level: any) => typeof level === "string") : []);
      const models = raw.models
        .filter((entry: any) => entry.value !== "default" && validModel(entry.value))
        .filter((entry: any) => purpose !== "agents" || CLAUDE_AGENT_FAMILIES.includes(entry.value))
        .map((entry: any) => ({ value: entry.value, name: text(entry.displayName) || entry.value, description: text(entry.description), levels: levelsOf(entry), defaultEffort: null }));
      // A typed or host default model offers every level the host lists.
      const allLevels = raw.models.flatMap(levelsOf);
      return { providers: null, models, allLevels, defaultModel: null };
    }
  },
  codex: {
    modelDefault: (raw: any, purpose: any) => purpose === "agents" ? "The coordinator's model." : text(raw?.models?.find((entry: any) => entry.isDefault === true && entry.hidden !== true)?.displayName),
    effortDefault: (model: any) => (validEffort(model?.defaultEffort) ? `${effortName(model.defaultEffort)}, the model's default.` : "The model's default."),
    map(raw: any, purpose: any) {
      let providers = null;
      if (purpose === "coordinator") {
        const named = raw.providers.filter((entry: any) => validProvider(entry.id));
        const fallback = named.find((entry: any) => entry.id === raw.defaultProviderId);
        providers = {
          defaultDescription: text(fallback?.name) || (raw.defaultProviderId ?? ""),
          values: named.map((entry: any) => ({ value: entry.id, name: text(entry.name) || entry.id, description: "" }))
        };
      }
      const models = raw.models
        .filter((entry: any) => entry.hidden !== true && validModel(entry.model))
        .map((entry: any) => ({
          value: entry.model,
          name: text(entry.displayName) || entry.model,
          description: text(entry.description),
          levels: (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []).filter(isObject).map((level: any) => ({ value: level.reasoningEffort, description: text(level.description) })),
          defaultEffort: typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null,
          isDefault: entry.isDefault === true
        }));
      const allLevels = models.flatMap((entry: any) => entry.levels);
      // The coordinator's host default is the provider's default model; an agent's is the coordinator's, which may be any.
      const defaultModel = purpose === "coordinator" ? models.find((entry: any) => entry.isDefault) ?? null : null;
      return { providers, models, allLevels, defaultModel };
    }
  }
};

const hostDefault = (description: any) => ({ value: null, name: "Host default", description });
const offered = (value: any) => ({ value, state: "offered", reason: null });
const notOffered = (value: any, reason: any) => ({ value, state: "not-offered", reason });

function buildReport(definition: any, { purpose, provider, model, effort, typed }: any, raw: any) {
  const { host, label } = definition;
  const adapter = ADAPTERS[host];
  const ready = raw.state === "ready";
  const mapped = ready ? adapter.map(raw, purpose) : { providers: host === "codex" && purpose === "coordinator" ? { defaultDescription: "", values: [] } : null, models: [], allLevels: [], defaultModel: null };
  const options = [];
  if (mapped.providers) {
    const values = mapped.providers.values;
    const chosen = provider === null || values.some((entry: any) => entry.value === provider) ? offered(provider) : notOffered(provider, choiceReasons.provider(label, provider));
    options.push({ id: "provider", name: "Provider", kind: "provider", values: [hostDefault(mapped.providers.defaultDescription), ...values], chosen });
  }
  const listed = model === null ? null : mapped.models.find((entry: any) => entry.value === model) ?? null;
  let modelChoice;
  if (model === null || listed) modelChoice = offered(model);
  else if (typed) modelChoice = { value: model, state: "typed", reason: choiceReasons.typed(label) };
  else modelChoice = notOffered(model, choiceReasons.model(label, model));
  options.push({
    id: "model",
    name: "Model",
    kind: "model",
    values: [hostDefault(adapter.modelDefault(ready ? raw : null, purpose)), ...mapped.models.map(({ value, name, description }: any) => ({ value, name, description }))],
    chosen: modelChoice,
    reportedNone: ready && mapped.models.length === 0
  });
  // The levels follow the chosen model: a listed model's own, the default model's for the host default when the host names one,
  // and every level the host lists for a typed, unlisted, or host default model.
  const effortModel = model === null ? mapped.defaultModel : listed;
  const levels = !ready ? [] : effortModel ? effortModel.levels : mapped.allLevels;
  // A typed or host default model may gather the levels of every listed model, so the answer keeps the lowest MAX_MODEL_LEVELS.
  const efforts = rankEfforts(levels).slice(0, MAX_MODEL_LEVELS).map(({ value, description }) => ({ value, name: effortName(value), description }));
  const modelName = listed?.name ?? model ?? mapped.defaultModel?.name ?? "The host's default model";
  const effortChoice = effort === null || efforts.some((entry) => entry.value === effort) ? offered(effort) : notOffered(effort, choiceReasons.effort(modelName, effort));
  options.push({ id: "effort", name: "Effort", kind: "effort", values: [hostDefault(adapter.effortDefault(effortModel)), ...efforts], chosen: effortChoice });
  const reason = !ready ? `${label} did not report its run options: ${raw.message}.` : raw.modelsError ? `${label} could not list its models: ${raw.modelsError}` : null;
  return { host, label, state: ready ? "ready" : "failed", reason, options };
}

/**
 * The run options of a host for a purpose, `coordinator` or `agents`, with the selection marked: { host, label, state, reason,
 * options }, state being `ready`, `failed`, or `unavailable` for a host not found on this computer, which starts nothing.
 * A host, purpose, or name that breaks its rule throws a RunOptionsError and starts nothing.
 */
export async function readRunOptions({ host, purpose, provider = null, model = null, effort = null, typed = false, checkout, env = process.env }: any) {
  const selection = checkedSelection({ host, purpose, provider, model, effort, typed });
  const { definition } = selection;
  const resolved = (await resolveHost(definition.host, env))!;
  if (!resolved.available) return { host: definition.host, label: definition.label, state: "unavailable", reason: resolved.reason, options: [] };
  // Only Codex has providers, so a Claude Code report is one per executable and checkout.
  const raw = await keptReport(resolved, { checkout, env, provider: definition.host === "codex" ? selection.provider : null });
  return buildReport(definition, selection, raw);
}
