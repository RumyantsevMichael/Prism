// Generated from src/server/session/host-adapters/acp.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pluginPath } from "../../plugin-root.mjs";
import { EFFORT_PATTERN, HOST_REQUEST_REFUSAL, LAUNCH_NOTE, lineSplitter, MODEL_PATTERN, strippedEnvironment, validHostSessionId } from "../launch-hosts.mjs";
import { acpLaunchArgument, acpTokenArgument, newAcpToken, toolsListed } from "../options-read-marker.mjs";
const ACP_PROTOCOL_VERSION = 1;
const AUTH_REQUIRED_CODE = -32e3;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const STDERR_KEPT = 2e3;
const EXIT_GRACE_MS = 5e3;
const KILL_GRACE_MS = 2e3;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 300;
const MAX_VALUES = 1e3;
const KEPT_TOOL_CALLS = 64;
const HELD_REPLY_CHARS = 64 * 1024;
class AcpError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}
const PRISM_SERVER = "prism";
function prismMcpServer({ env = process.env, token, launch = null, optionsRead = false }) {
  const variables = [
    { name: "NODE_USE_ENV_PROXY", value: "1" },
    ...launch ? [{ name: "PRISM_LAUNCH", value: launch }] : [],
    ...optionsRead ? [{ name: "PRISM_OPTIONS_READ", value: "1" }] : [],
    ...env.PRISM_REVIEW_APP_DIR ? [{ name: "PRISM_REVIEW_APP_DIR", value: env.PRISM_REVIEW_APP_DIR }] : []
  ];
  return { name: PRISM_SERVER, command: process.execPath, args: [pluginPath("dist", "server", "mcp.mjs"), ...launch ? [acpLaunchArgument(launch)] : [], acpTokenArgument(token)], env: variables };
}
function acpClient({ command, args, env, cwd, onRequest = () => void 0, onNotification = () => {
} }) {
  const pending = /* @__PURE__ */ new Map();
  let nextId = 1;
  let inputOpen = true;
  let ended = null;
  let stderr = "";
  let bytes = 0;
  let resolveExited = () => {
  };
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  let hasExited = false;
  const failAll = (error) => {
    ended = ended ?? error;
    for (const { reject } of pending.values()) reject(ended);
    pending.clear();
  };
  let child;
  try {
    child = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    failAll(new AcpError(`it could not be started: ${error.message}`));
    hasExited = true;
    resolveExited();
    return { pid: null, request: (_method, _params) => Promise.reject(ended), closeInput: () => {
    }, end: () => {
    }, exited, stderr: () => "", hasExited: () => true, exitGrace: EXIT_GRACE_MS };
  }
  const write = (message) => {
    if (inputOpen && child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}
`);
  };
  const answerRequest = async (id, method, params) => {
    let result;
    try {
      result = await onRequest(method, params);
    } catch {
      result = void 0;
    }
    write(result === void 0 ? { jsonrpc: "2.0", id, error: { ...HOST_REQUEST_REFUSAL } } : { jsonrpc: "2.0", id, result });
  };
  const splitter = lineSplitter((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (typeof message.method === "string") {
      if (hasId) void answerRequest(message.id, message.method, message.params);
      else onNotification(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error !== void 0 && message.error !== null) {
      const code = Number.isSafeInteger(message.error?.code) ? message.error.code : null;
      waiting.reject(new AcpError(typeof message.error?.message === "string" && message.error.message ? message.error.message : "it gave no reason", code));
    } else waiting.resolve(message.result);
  }, MAX_STDOUT_BYTES);
  child.stdin.on("error", () => {
  });
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_STDOUT_BYTES) {
      failAll(new AcpError(`it sent more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MiB`));
      end();
      return;
    }
    splitter.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_KEPT);
  });
  child.on("error", (error) => failAll(new AcpError(`it could not be started: ${error.message}`)));
  child.on("close", (code, signal) => {
    hasExited = true;
    splitter.end();
    const last = stderr.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
    const how = signal ? `it was ended by ${signal}` : `it ended with exit code ${code}`;
    failAll(new AcpError(`${how} before it answered${last ? `: ${last}` : ""}`));
    resolveExited();
  });
  let ending = false;
  function end() {
    if (hasExited || ending) return;
    ending = true;
    try {
      child.kill();
    } catch {
    }
    setTimeout(() => {
      if (!hasExited) try {
        child.kill("SIGKILL");
      } catch {
      }
    }, KILL_GRACE_MS).unref();
  }
  return {
    pid: child.pid ?? null,
    request(method, params) {
      if (ended) return Promise.reject(ended);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    closeInput() {
      if (!inputOpen) return;
      inputOpen = false;
      try {
        child.stdin.end();
      } catch {
      }
    },
    end,
    exited,
    stderr: () => stderr,
    hasExited: () => hasExited,
    exitGrace: EXIT_GRACE_MS
  };
}
const text = (value) => typeof value === "string" ? value : "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function selectValues(option, pattern) {
  const flat = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    if (isObject(entry) && Array.isArray(entry.options)) flat.push(...entry.options);
    else flat.push(entry);
  }
  const seen = /* @__PURE__ */ new Set();
  const values = [];
  for (const entry of flat) {
    if (!isObject(entry) || typeof entry.value !== "string" || !pattern.test(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    values.push({ value: entry.value, name: text(entry.name).slice(0, NAME_MAX) || entry.value, description: text(entry.description).slice(0, DESCRIPTION_MAX) });
    if (values.length >= MAX_VALUES) break;
  }
  return values;
}
const optionOfCategory = (options, category) => Array.isArray(options) ? options.find((option) => isObject(option) && option.category === category && option.type !== "boolean") ?? null : null;
function acpConfigChoices(options) {
  const choice = (category, pattern) => {
    const option = optionOfCategory(options, category);
    if (!option || typeof option.id !== "string") return null;
    const values = selectValues(option, pattern);
    const current = values.find((entry) => entry.value === option.currentValue)?.name ?? null;
    return { id: option.id, values, current };
  };
  return { model: choice("model", MODEL_PATTERN), effort: choice("thought_level", EFFORT_PATTERN) };
}
const acpReasons = Object.freeze({
  version: (label, version) => `${label} speaks ACP version ${String(version)}, and Prism speaks version ${ACP_PROTOCOL_VERSION}.`,
  // An agent that needs sign-in opens no session, so whether it starts Prism's tools is known only once the person has signed in.
  signIn: (label, methods) => `${label} needs you to sign in before it can run: ${signInMethods(methods)}. Prism checks that it starts Prism's tools once you have signed in.`,
  noTools: (label) => `${label} did not start Prism's tools, so it cannot run Prism's workflow: it ignores the tool servers that Prism names when it opens a session, or starts them later than Prism waits.`,
  childModels: (label) => `${label} chooses the models of its own child agents.`,
  childModel: (label, model) => `${label} chooses the models of its own child agents, so Prism cannot give them ${model}.`,
  childEffort: (label, effort) => `${label} chooses the effort of its own child agents, so Prism cannot give them ${effort}.`
});
function signInMethods(methods) {
  const named = (Array.isArray(methods) ? methods : []).filter((method) => isObject(method) && text(method.name).trim()).map((method) => {
    const name = text(method.name).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    const description = text(method.description).replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX).replace(/\.+$/, "");
    return description && addsToName(name, description) ? `${name} (${description})` : name;
  });
  return named.length ? named.join(", ") : "sign in with the agent's own command";
}
const LINKING_WORDS = /* @__PURE__ */ new Set(["a", "an", "the", "and", "or", "to", "of", "for", "with", "by", "via", "on", "in", "your", "you", "use", "using"]);
const wordsOf = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function addsToName(name, description) {
  const own = new Set(wordsOf(name));
  return new Set(wordsOf(description).filter((word) => !own.has(word) && !LINKING_WORDS.has(word))).size >= 2;
}
async function readAcpOptions(definition, { checkout, env, model = null, timeoutMs }) {
  const { label } = definition;
  const deadline = Date.now() + timeoutMs;
  const token = newAcpToken();
  const client = acpClient({
    command: definition.command,
    args: [...definition.prefix, ...definition.acp.args],
    env: { ...strippedEnvironment(env), ...definition.acp.env },
    cwd: checkout,
    // A read asks for no permission; any request is refused, and a permission request is cancelled.
    onRequest: (method) => method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : void 0
  });
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new AcpError(`it gave no answer within ${Math.round(timeoutMs / 100) / 10} seconds`));
    }, timeoutMs);
  });
  const within = (promise) => Promise.race([promise, timeout]);
  timeout.catch(() => {
  });
  let sessionId = null;
  let canClose = false;
  try {
    const initialized = await within(client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "prism-options", version: "1" } }));
    if (initialized?.protocolVersion !== ACP_PROTOCOL_VERSION) return { state: "failed", reason: acpReasons.version(label, initialized?.protocolVersion) };
    canClose = isObject(initialized?.agentCapabilities?.sessionCapabilities?.close);
    let opened;
    try {
      opened = await within(client.request("session/new", { cwd: checkout, mcpServers: [prismMcpServer({ env, token, optionsRead: true })] }));
    } catch (error) {
      if (error instanceof AcpError && error.code === AUTH_REQUIRED_CODE && !timedOut) return { state: "sign-in", reason: acpReasons.signIn(label, initialized?.authMethods) };
      throw error;
    }
    sessionId = typeof opened?.sessionId === "string" && opened.sessionId ? opened.sessionId : null;
    if (!sessionId) return { state: "failed", message: "it named no session" };
    const listed = await toolsListed({ env, token, deadline, stopped: () => client.hasExited() });
    if (!listed) return { state: "failed", reason: acpReasons.noTools(label) };
    let options = opened.configOptions;
    const before = acpConfigChoices(options);
    if (model !== null && before.model?.values.some((entry) => entry.value === model)) {
      const set = await within(client.request("session/set_config_option", { sessionId, configId: before.model.id, value: model }));
      if (Array.isArray(set?.configOptions)) options = set.configOptions;
    }
    const after = acpConfigChoices(options);
    return { state: "ready", version: initialized?.agentInfo?.version ?? null, model: after.model && { ...after.model, current: before.model?.current ?? null }, effort: after.effort && { ...after.effort, current: before.effort?.current ?? null } };
  } catch (error) {
    return { state: "failed", message: error instanceof AcpError ? error.message : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
    if (sessionId && canClose && !client.hasExited() && !timedOut) {
      const closed = client.request("session/close", { sessionId }).catch(() => null);
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2e3, deadline - Date.now()))).unref())]);
    }
    client.closeInput();
    if (timedOut) client.end();
    else if (!client.hasExited()) setTimeout(() => client.end(), EXIT_GRACE_MS).unref();
  }
}
const TOOLS_WAIT_MS = 6e4;
const TOKEN_KEYS = Object.freeze(["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"]);
const FAILING_STOPS = /* @__PURE__ */ new Set(["refusal", "max_tokens", "max_turn_requests"]);
const BYPASS_VALUES = /* @__PURE__ */ new Set(["bypassPermissions", "agent-full-access"]);
const BYPASS_WORDS = /bypass|full[\s_-]*access|(accept|allow|approve)s?\s+(all|every)\s+(permission|request|tool)/i;
const SKILL_URI = "prism://skills/orchestrate/SKILL.md";
const launchInstruction = (initiative, answeredGate = null) => `Run the Prism skill orchestrate in the attached resource for the initiative ${initiative}. Prism's skills are not installed in this agent: read every other Prism skill or reference file that a skill names with Prism's get_skill tool.${answeredGate === null ? "" : ` Act first on the answer of the gate ${answeredGate}.`}`;
const acpRunReasons = Object.freeze({
  notOffered: (label, value, option) => `${label} does not offer ${value} for ${option}.`,
  noResume: (label) => `${label} cannot resume a session.`,
  stopped: (label, stopReason) => `${label} stopped: ${stopReason}.`
});
const NO_USAGE = Object.freeze({ tokens: null, context: null, cost: null });
const bypasses = (entry) => BYPASS_VALUES.has(entry.value) || BYPASS_WORDS.test(entry.value) || BYPASS_WORDS.test(entry.name) || BYPASS_WORDS.test(entry.description);
const anyValue = /^[^\u0000-\u001f\u007f]{1,200}$/;
function automaticMode(options, autoMode) {
  const option = optionOfCategory(options, "mode");
  const values = option ? selectValues(option, anyValue) : [];
  const allowed = (value) => {
    const entry = values.find((item) => item.value === value);
    return entry ? !bypasses(entry) : !BYPASS_VALUES.has(value) && !BYPASS_WORDS.test(value);
  };
  if (autoMode !== null && allowed(autoMode)) return autoMode;
  return values.some((item) => item.value === "auto") && allowed("auto") ? "auto" : null;
}
const finiteTokens = (usage) => {
  if (!isObject(usage)) return null;
  const counts = Object.fromEntries(TOKEN_KEYS.filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key]]));
  return Object.keys(counts).length ? counts : null;
};
const TOOL_CALL_FIELDS = ["title", "kind", "rawInput"];
const isSet = (value) => value !== void 0 && value !== null;
function acpPermission(label, params, known = {}) {
  const values = isObject(params) ? params : {};
  const sent = isObject(values.toolCall) ? values.toolCall : {};
  const call = {};
  for (const field of TOOL_CALL_FIELDS) call[field] = isSet(sent[field]) ? sent[field] : known[field];
  const offered = (Array.isArray(values.options) ? values.options : []).filter((option) => isObject(option) && typeof option.optionId === "string" && option.optionId);
  const once = (kind2) => offered.find((option) => option.kind === kind2)?.optionId;
  const allow = once("allow_once");
  const reject = once("reject_once");
  const kind = text(call.kind).trim() || "other";
  const titled = text(call.title).trim() !== "";
  const reason = `${label} asks before it runs a tool of kind ${kind}.`;
  const ask = !titled && !isSet(call.rawInput) ? { action: `A tool of kind ${kind} that ${label} did not describe`, reason, canAllow: false, unavailable: `${label} did not say what this tool call does, so Prism can only refuse it.` } : { action: `${titled ? text(call.title) : `a tool of kind ${kind}`}${isSet(call.rawInput) ? ` ${JSON.stringify(call.rawInput)}` : ""}`, reason, canAllow: allow !== void 0 };
  return {
    ask,
    answer: (decision) => {
      const optionId = decision === "approve" ? allow : reject;
      return { outcome: optionId === void 0 ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
    }
  };
}
function prismToolAllow(params, tools, known = {}) {
  const values = isObject(params) ? params : {};
  const sent = isObject(values.toolCall) ? values.toolCall : {};
  const title = typeof sent.title === "string" ? sent.title : typeof known.title === "string" ? known.title : "";
  const rawInput = isSet(sent.rawInput) ? sent.rawInput : known.rawInput;
  if (isSet(rawInput) && !isObject(rawInput)) return null;
  const match = /^(?:mcp__prism__|prism(?:\/|__|\.|:))([A-Za-z0-9_-]+)$/.exec(title.trim());
  if (!match || !tools.has(match[1])) return null;
  const allow = (Array.isArray(values.options) ? values.options : []).find((option) => isObject(option) && option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId);
  return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : null;
}
function acpConversation(options) {
  const { label, initiative, checkout, hostSessionId, resume, coordinator, answeredGate = null, env, launch, facts, write, close, cut } = options;
  const pending = /* @__PURE__ */ new Map();
  const toolCalls = /* @__PURE__ */ new Map();
  let prismTools = /* @__PURE__ */ new Set();
  const waitingPermissions = /* @__PURE__ */ new Map();
  const permissionKey = (id) => `${typeof id}:${String(id)}`;
  let nextId = 1;
  let sessionId = null;
  let configOptions = [];
  let embedded = false;
  let canResume = false;
  let canLoad = false;
  let authMethods = [];
  let queue = [];
  let prompting = false;
  let promptDone = false;
  let stopAsked = false;
  let cancelSent = false;
  const usage = { tokens: null, context: null, cost: null };
  let reply = "";
  let replyId = void 0;
  let replyStarted = false;
  const request = (method, params) => {
    const id = nextId++;
    pending.set(id, method);
    write({ jsonrpc: "2.0", id, method, params });
  };
  const fail = (reason) => {
    facts.settled = true;
    facts.failure = cut(reason);
    close();
  };
  const token = newAcpToken();
  const server = () => prismMcpServer({ env, token, launch });
  const plan = () => {
    const steps2 = [];
    const mode = automaticMode(configOptions, options.autoMode);
    if (mode !== null) steps2.push({ category: "mode", value: mode });
    if (coordinator.model !== null) steps2.push({ category: "model", value: coordinator.model });
    if (coordinator.effort !== null) steps2.push({ category: "thought_level", value: coordinator.effort });
    return steps2;
  };
  const resolveStep = (step) => {
    const option = optionOfCategory(configOptions, step.category);
    const offered = option && typeof option.id === "string" && selectValues(option, anyValue).some((entry) => entry.value === step.value);
    if (!offered) return { reason: acpRunReasons.notOffered(label, step.value, text(option?.name).trim() || (step.category === "thought_level" ? "effort" : step.category)) };
    return { configId: option.id };
  };
  let steps = [];
  const next = () => {
    if (stopAsked) {
      close();
      return;
    }
    const step = steps.shift();
    if (step) {
      const resolved = resolveStep(step);
      if ("reason" in resolved) {
        fail(resolved.reason);
        return;
      }
      request("session/set_config_option", { sessionId, configId: resolved.configId, value: step.value });
      return;
    }
    const model = optionOfCategory(configOptions, "model");
    options.named(model?.currentValue);
    void awaitTools();
  };
  const awaitTools = async () => {
    const listed = await toolsListed({ env, token, deadline: Date.now() + TOOLS_WAIT_MS, stopped: () => stopAsked || !options.inputOpen() });
    if (stopAsked || !options.inputOpen()) {
      close();
      return;
    }
    if (!listed) {
      fail(acpReasons.noTools(label));
      return;
    }
    prismTools = new Set(listed);
    let skill;
    try {
      skill = readFileSync(pluginPath("skills", "orchestrate", "SKILL.md"), "utf8");
    } catch (error) {
      fail(`Prism could not read its orchestrate skill: ${error.message}`);
      return;
    }
    const first = embedded ? { type: "resource", resource: { uri: SKILL_URI, mimeType: "text/markdown", text: skill } } : { type: "text", text: skill };
    prompting = true;
    request("session/prompt", { sessionId, prompt: [first, { type: "text", text: launchInstruction(initiative, answeredGate) }, { type: "text", text: LAUNCH_NOTE }] });
  };
  const opened = (method, result) => {
    const id = method === "session/new" ? result?.sessionId : hostSessionId;
    if (typeof id !== "string" || !id) {
      fail(`${label} named no session.`);
      return;
    }
    sessionId = id;
    facts.agentSessionId = id;
    if (method === "session/new" && validHostSessionId(id)) {
      facts.hostSessionId = id;
      options.onSessionId(id);
    }
    configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    steps = plan();
    next();
  };
  const answered = (method, result) => {
    if (method === "initialize") {
      if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        fail(acpReasons.version(label, result?.protocolVersion));
        return;
      }
      const capabilities = isObject(result?.agentCapabilities) ? result.agentCapabilities : {};
      embedded = capabilities.promptCapabilities?.embeddedContext === true;
      canResume = isObject(capabilities.sessionCapabilities?.resume);
      canLoad = capabilities.loadSession === true;
      authMethods = result?.authMethods;
      if (!resume) {
        request("session/new", { cwd: checkout, mcpServers: [server()] });
        return;
      }
      if (!validHostSessionId(hostSessionId)) {
        fail("The session never reported its host session id, so it cannot be resumed.");
        return;
      }
      if (!canResume && !canLoad) {
        fail(acpRunReasons.noResume(label));
        return;
      }
      request(canResume ? "session/resume" : "session/load", { sessionId: hostSessionId, cwd: checkout, mcpServers: [server()] });
      return;
    }
    if (method === "session/new" || method === "session/resume" || method === "session/load") {
      opened(method, result);
      return;
    }
    if (method === "session/set_config_option") {
      if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
      next();
      return;
    }
    if (method === "session/prompt") {
      promptDone = true;
      facts.settled = true;
      usage.tokens = finiteTokens(result?.usage);
      facts.usage = { ...usage };
      const stopReason = text(result?.stopReason);
      facts.stopReason = stopReason || null;
      facts.lastMessage = options.replyText(reply);
      if (FAILING_STOPS.has(stopReason)) facts.failure = cut(acpRunReasons.stopped(label, stopReason));
      close();
    }
  };
  const sendCancel = () => {
    if (cancelSent || promptDone || !prompting || sessionId === null) return;
    cancelSent = true;
    write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  };
  return {
    start: () => request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "prism-launch", version: "1" } }),
    interrupt() {
      stopAsked = true;
      facts.settled = true;
      if (prompting && !promptDone) sendCancel();
      else close();
    },
    event(message) {
      const hasId = typeof message.id === "string" || typeof message.id === "number";
      if (hasId && typeof message.method === "string") {
        if (message.method === "session/request_permission") {
          const { id } = message;
          const callId = message.params?.toolCall?.toolCallId;
          const own = prismToolAllow(message.params, prismTools, typeof callId === "string" ? toolCalls.get(callId) : void 0);
          if (own) {
            facts.ownToolAllows += 1;
            write({ jsonrpc: "2.0", id, result: own });
            return;
          }
          const permission = acpPermission(label, message.params, typeof callId === "string" ? toolCalls.get(callId) : void 0);
          const key = permissionKey(id);
          let answered2 = false;
          const waiting = options.ask(permission.ask, (decision) => {
            answered2 = true;
            waitingPermissions.delete(key);
            return { jsonrpc: "2.0", id, result: permission.answer(decision) };
          });
          if (waiting && !answered2) waitingPermissions.set(key, waiting);
          return;
        }
        write({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
        return;
      }
      if (hasId) {
        const method = typeof message.id === "number" ? pending.get(message.id) : void 0;
        if (!method) return;
        pending.delete(message.id);
        if (message.error !== void 0 && message.error !== null) {
          if (method === "session/prompt") promptDone = true;
          if (method === "session/new" && message.error?.code === AUTH_REQUIRED_CODE) {
            fail(acpReasons.signIn(label, authMethods));
            return;
          }
          facts.settled = true;
          facts.hostError = cut(text(message.error?.message) || "The agent gave no reason.");
          close();
          return;
        }
        answered(method, message.result);
        return;
      }
      if (message.method === "$/cancel_request") {
        const requestId = message.params?.requestId;
        if (typeof requestId !== "string" && typeof requestId !== "number") return;
        const key = permissionKey(requestId);
        const waiting = waitingPermissions.get(key);
        waitingPermissions.delete(key);
        waiting?.dismiss();
        return;
      }
      if (message.method !== "session/update") return;
      const update = isObject(message.params?.update) ? message.params.update : {};
      if (update.sessionUpdate === "usage_update") {
        if (Number.isFinite(update.used) && Number.isFinite(update.size)) usage.context = { used: update.used, size: update.size };
        if (isObject(update.cost) && Number.isFinite(update.cost.amount) && typeof update.cost.currency === "string" && /^[A-Za-z]{1,8}$/.test(update.cost.currency)) usage.cost = { amount: update.cost.amount, currency: update.cost.currency };
        facts.usage = { ...usage };
      } else if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) configOptions = update.configOptions;
      else if (update.sessionUpdate === "agent_message_chunk") {
        if (!prompting || promptDone || !isObject(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") return;
        if (replyStarted && update.messageId !== replyId) reply = "";
        replyStarted = true;
        replyId = update.messageId;
        if (reply.length < HELD_REPLY_CHARS) reply = `${reply}${update.content.text}`.slice(0, HELD_REPLY_CHARS);
      }
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && prompting && !promptDone) {
        reply = "";
        replyStarted = false;
      }
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && typeof update.toolCallId === "string" && update.toolCallId) {
        const key = update.toolCallId;
        const kept = { ...toolCalls.get(key) };
        for (const field of TOOL_CALL_FIELDS) if (isSet(update[field])) kept[field] = update[field];
        toolCalls.delete(key);
        toolCalls.set(key, kept);
        if (toolCalls.size > KEPT_TOOL_CALLS) toolCalls.delete(toolCalls.keys().next().value);
      }
    }
  };
}
export {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED_CODE,
  AcpError,
  NO_USAGE,
  SKILL_URI,
  TOOLS_WAIT_MS,
  acpClient,
  acpConfigChoices,
  acpConversation,
  acpPermission,
  acpReasons,
  acpRunReasons,
  automaticMode,
  launchInstruction,
  prismMcpServer,
  prismToolAllow,
  readAcpOptions
};
