// Generated from src/server/session/launch-hosts.mts by scripts/native-build/compile.mjs.
import { createHash, randomUUID } from "node:crypto";
import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { acpHostDefinition, acpHosts, isAcpHost } from "./acp-agents.mjs";
import { isAgentModel } from "./agent-models.mjs";
import { acpConversation } from "./host-adapters/acp.mjs";
import { shownForm } from "./permission-requests.mjs";
const HOSTS = Object.freeze([
  Object.freeze({
    host: "claude-code",
    label: "Claude Code",
    executable: "claude",
    optionsRead: Object.freeze({
      args: Object.freeze(["-p", "--verbose", "--no-session-persistence", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--input-format", "stream-json", "--output-format", "stream-json"]),
      request: Object.freeze({ type: "control_request", request_id: "prism-options", request: Object.freeze({ subtype: "initialize" }) })
    })
  }),
  Object.freeze({
    host: "codex",
    label: "Codex",
    executable: "codex",
    optionsRead: Object.freeze({
      args: Object.freeze(["app-server"]),
      client: Object.freeze({ clientInfo: Object.freeze({ name: "prism-options", version: "1" }), capabilities: Object.freeze({ experimentalApi: true }) })
    })
  })
]);
const STRIPPED_VARIABLES = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CODEX_THREAD_ID"
]);
const CLAUDE_FLAGS = Object.freeze(["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"]);
const CODEX_POLICY = Object.freeze({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
const CODEX_CLIENT = Object.freeze({ clientInfo: { name: "prism-launch", version: "1" }, capabilities: { experimentalApi: true } });
const HOST_REQUEST_REFUSAL = Object.freeze({ code: -32601, message: "Prism answers no host requests." });
const MAX_LINE_BYTES = 1024 * 1024;
const REFUSAL_REASON_MAX = 500;
const RECORDED_REFUSALS = 20;
const KEPT_TOOL_RESULTS = 100;
const TOOL_NAME_MAX = 100;
const KEPT_EARLY_COMPLETIONS = 8;
const KEPT_FILE_CHANGES = 64;
const TRACKED_TASKS = 1e3;
const HOST_ERROR_FALLBACK = "The turn failed without a message.";
const HOST_SESSION_ID_PATTERN = /^[0-9A-Za-z_][0-9A-Za-z_-]*$/;
const SESSION_ID_PLACEHOLDER = "<host session id>";
function validHostSessionId(value) {
  return typeof value === "string" && HOST_SESSION_ID_PATTERN.test(value);
}
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;
function redactSessionId(text2, hostSessionId) {
  if (typeof text2 !== "string" || typeof hostSessionId !== "string" || !hostSessionId) return text2;
  return text2.replace(new RegExp(hostSessionId.replace(REGEX_SYNTAX, "\\$&"), "gi"), SESSION_ID_PLACEHOLDER);
}
function builtinHost(host) {
  return HOSTS.find((definition) => definition.host === host) ?? null;
}
function hostDefinition(host, env = process.env) {
  return builtinHost(host) ?? (isAcpHost(host) ? acpHostDefinition(host, env) : null);
}
function hostDefinitions(env = process.env) {
  return [...HOSTS, ...acpHosts(env)];
}
async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== "win32") await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function pathEntries(env) {
  const value = env.PATH ?? env.Path ?? "";
  return value.split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
}
async function npmShimScript(file) {
  let text2;
  try {
    text2 = await readFile(file, "utf8");
  } catch {
    return null;
  }
  if (!/node/i.test(text2)) return null;
  const match = /"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/i.exec(text2);
  if (!match) return null;
  const script = path.resolve(path.dirname(file), match[1]);
  return await executableFile(script) ? script : null;
}
async function resolveHost(host, env = process.env) {
  const definition = hostDefinition(host, env);
  return definition ? resolveDefinition(definition, env) : null;
}
async function resolveDefinition(definition, env) {
  if (path.isAbsolute(definition.executable)) {
    if (await executableFile(definition.executable)) return { ...definition, available: true, executable: definition.executable, command: definition.executable, prefix: [], reason: null };
    return { ...definition, available: false, executable: null, command: null, prefix: [], reason: `${definition.label} was not found: no executable file at ${definition.executable}.` };
  }
  const missing = { ...definition, available: false, executable: null, command: null, prefix: [], reason: `${definition.label} was not found: no ${definition.executable} executable on PATH.` };
  const entries = pathEntries(env);
  if (process.platform !== "win32") {
    for (const entry of entries) {
      const file = path.join(entry, definition.executable);
      if (await executableFile(file)) return { ...definition, available: true, executable: file, command: file, prefix: [], reason: null };
    }
    return missing;
  }
  for (const extension of [".exe", ".cmd"]) {
    for (const entry of entries) {
      const file = path.join(entry, `${definition.executable}${extension}`);
      if (!await executableFile(file)) continue;
      if (extension === ".exe") return { ...definition, available: true, executable: file, command: file, prefix: [], reason: null };
      const script = await npmShimScript(file);
      if (!script) return { ...definition, available: false, executable: file, command: null, prefix: [], reason: `Prism cannot run ${file} safely: it is not an npm command shim.` };
      return { ...definition, available: true, executable: file, command: process.execPath, prefix: [script], reason: null };
    }
  }
  return missing;
}
async function hostAvailability({ env = process.env, acp = true } = {}) {
  const definitions = acp ? hostDefinitions(env) : [...HOSTS];
  return Promise.all(definitions.map(async (definition) => {
    const { host } = definition;
    const { label, available, executable, reason } = await resolveDefinition(definition, env);
    return { host, label, available, executable, reason };
  }));
}
const HOST_DEFAULT_COORDINATOR = Object.freeze({ provider: null, model: null, effort: null, typed: false });
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]+-]{0,199}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const CHOICE_PARTS = Object.freeze(["provider", "model", "effort", "typed"]);
function checkedCoordinator(value) {
  if (value === void 0 || value === null) return { ...HOST_DEFAULT_COORDINATOR };
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !CHOICE_PARTS.includes(key))) return null;
  const part = (name, pattern) => {
    const item = value[name] ?? null;
    return item === null ? null : typeof item === "string" && pattern.test(item) ? item : void 0;
  };
  const choice = { provider: part("provider", PROVIDER_PATTERN), model: part("model", MODEL_PATTERN), effort: part("effort", EFFORT_PATTERN), typed: value.typed ?? false };
  if (choice.provider === void 0 || choice.model === void 0 || choice.effort === void 0 || typeof choice.typed !== "boolean") return null;
  return { ...choice, typed: choice.typed && choice.model !== null };
}
function coordinatorOf(coordinator) {
  const checked = checkedCoordinator(coordinator);
  if (!checked) throw new Error("The coordinator's choice is not one Prism can pass to a host.");
  return checked;
}
function hostArguments({ host, hostSessionId, resume, coordinator = null, acp = null }) {
  if (host === "claude-code") {
    if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
    const { model, effort } = coordinatorOf(coordinator);
    return ["-p", "--verbose", resume ? "--resume" : "--session-id", hostSessionId, ...CLAUDE_FLAGS, ...model === null ? [] : ["--model", model], ...effort === null ? [] : ["--effort", effort]];
  }
  if (host === "codex") return ["app-server"];
  if (acp) return [...acp.args];
  throw new Error(`Unknown host ${host}.`);
}
function claudePrompt(initiative) {
  return { type: "user", message: { role: "user", content: `/prism:orchestrate ${initiative}` } };
}
function codexThreadRequest({ checkout, hostSessionId, resume, coordinator = null }) {
  const { model, provider } = coordinatorOf(coordinator);
  const chosen = { ...model === null ? {} : { model }, ...provider === null ? {} : { modelProvider: provider } };
  if (!resume) return { method: "thread/start", params: { cwd: checkout, ...CODEX_POLICY, ...chosen } };
  if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
  return { method: "thread/resume", params: { threadId: hostSessionId, cwd: checkout, ...CODEX_POLICY, ...chosen } };
}
function codexTurnRequest({ threadId, initiative, coordinator = null }) {
  const { effort } = coordinatorOf(coordinator);
  return { method: "turn/start", params: { threadId, input: [{ type: "text", text: `$prism:orchestrate ${initiative}` }], ...effort === null ? {} : { effort } } };
}
const CODEX_APPROVALS = /* @__PURE__ */ new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isSet = (value) => value !== void 0 && value !== null;
const CODEX_UNDESCRIBED_CHANGE = "A file change that Codex did not describe";
const CODEX_UNNAMED_COMMAND = "A command that Codex did not name";
const CLAUDE_UNNAMED_TOOL = "A tool that Claude Code did not name";
const CLAUDE_UNNAMED_TOOL_REASON = "Claude Code did not say which tool this runs, so Prism can only refuse it.";
const codexUnavailable = {
  undescribed: "Codex did not say which files this change writes, so Prism can only refuse it.",
  unnamed: "Codex did not say which command this runs, so Prism can only refuse it.",
  grantRoot: (root) => `Codex asks to allow writes under ${shownForm(root)} for the rest of the session, so Prism can only refuse it.`,
  permissions: "Codex asks for these permissions for the rest of its turn, so Prism can only refuse it."
};
function codexCommandAction(params) {
  const given = Array.isArray(params.command) ? params.command.filter((part) => typeof part === "string").join(" ") : text(params.command);
  const named = given.trim() !== "";
  const command = named ? given : CODEX_UNNAMED_COMMAND;
  const network = isPlainObject(params.networkApprovalContext) ? { host: params.networkApprovalContext.host, protocol: params.networkApprovalContext.protocol } : params.networkApprovalContext;
  const context = {
    ...isSet(params.cwd) ? { cwd: params.cwd } : {},
    ...isSet(params.environmentId) ? { environmentId: params.environmentId } : {},
    ...isSet(params.kind) && params.kind !== "command" ? { kind: params.kind } : {},
    ...isSet(network) ? { networkApprovalContext: network } : {}
  };
  return { named, action: Object.keys(context).length ? `${command} ${JSON.stringify(context)}` : command };
}
function codexApproval(method, params, changes) {
  if (!CODEX_APPROVALS.has(method)) return null;
  const values = isPlainObject(params) ? params : {};
  const reason = text(values.reason);
  const decided = (decision) => ({ decision: decision === "approve" ? "accept" : "decline" });
  if (method === "item/permissions/requestApproval") {
    const asked = isSet(values.permissions) ? JSON.stringify(values.permissions) : "{}";
    return {
      ask: { action: `Permissions ${asked}`, reason, canAllow: false, unavailable: codexUnavailable.permissions },
      answer: (_decision) => ({ permissions: {}, scope: "turn" })
    };
  }
  if (method === "item/fileChange/requestApproval") {
    if (!Array.isArray(changes) || changes.length === 0) return { ask: { action: CODEX_UNDESCRIBED_CHANGE, reason, canAllow: false, unavailable: codexUnavailable.undescribed }, answer: decided };
    const grantRoot = isSet(values.grantRoot) ? values.grantRoot : void 0;
    const action = `File change ${JSON.stringify({ changes, ...grantRoot === void 0 ? {} : { grantRoot } })}`;
    if (grantRoot === void 0) return { ask: { action, reason, canAllow: true }, answer: decided };
    return { ask: { action, reason, canAllow: false, unavailable: codexUnavailable.grantRoot(typeof grantRoot === "string" ? grantRoot : JSON.stringify(grantRoot)) }, answer: decided };
  }
  const command = codexCommandAction(values);
  if (!command.named) return { ask: { action: command.action, reason, canAllow: false, unavailable: codexUnavailable.unnamed }, answer: decided };
  return { ask: { action: command.action, reason, canAllow: true }, answer: decided };
}
function claudeInterrupt(requestId) {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}
function codexInterruptRequest({ threadId, turnId }) {
  return { method: "turn/interrupt", params: { threadId, turnId } };
}
function resumeCommandOf(host, hostSessionId, env = process.env) {
  if (!validHostSessionId(hostSessionId)) return null;
  if (host === "claude-code") return `claude --resume ${hostSessionId}`;
  if (host === "codex") return `codex resume ${hostSessionId}`;
  const template = isAcpHost(host) ? acpHostDefinition(host, env)?.acp.resumeCommand : null;
  return template ? template.replaceAll("{session}", hostSessionId) : null;
}
function strippedEnvironment(env) {
  const result = { ...env };
  for (const name of STRIPPED_VARIABLES) delete result[name];
  return result;
}
function hostEnvironment(env, launchId, acp = null) {
  return { ...strippedEnvironment(env), ...acp ? acp.env : {}, PRISM_LAUNCH: launchId };
}
function lineSplitter(onLine, maxBytes = MAX_LINE_BYTES) {
  let pending = [];
  let pendingBytes = 0;
  let discarding = false;
  const emit = (buffer) => {
    if (!discarding && buffer.length <= maxBytes) onLine(buffer.toString("utf8").replace(/\r$/, ""));
  };
  return {
    push(chunk) {
      let start = 0;
      let index = chunk.indexOf(10);
      while (index !== -1) {
        const piece = chunk.subarray(start, index);
        if (discarding) discarding = false;
        else emit(pending.length ? Buffer.concat([...pending, piece]) : piece);
        pending = [];
        pendingBytes = 0;
        start = index + 1;
        index = chunk.indexOf(10, start);
      }
      if (start < chunk.length && !discarding) {
        const rest = chunk.subarray(start);
        pendingBytes += rest.length;
        if (pendingBytes > maxBytes) {
          pending = [];
          pendingBytes = 0;
          discarding = true;
        } else {
          pending.push(Buffer.from(rest));
        }
      }
    },
    end() {
      if (pending.length && !discarding) emit(Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
      discarding = false;
    }
  };
}
function parseObject(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "").join("");
  return "";
}
const text = (value) => typeof value === "string" ? value : "";
const claudeErrorText = (event) => text(event.result) || (Array.isArray(event.errors) ? event.errors.filter((entry) => typeof entry === "string").join("; ") : "");
const detached = (text2) => Buffer.from(text2, "utf16le").toString("utf16le");
const digestKey = (id) => createHash("sha256").update(Buffer.from(id, "utf16le")).digest("base64");
const REFUSED_ON_ATTENTION = "The person refused this on Attention.";
function hostConversation(host, { initiative, checkout, hostSessionId = null, resume = false, coordinator = null, send, closeInput, onSessionId = () => {
}, onModel = () => {
}, acp = null, permissions = null }) {
  const facts = { hostSessionId: null, agentSessionId: null, settled: false, turnId: null, model: null, refusals: [], refusalCount: 0, hostError: null, failure: null, usage: null };
  let modelSeen = false;
  const named = (value) => {
    if (modelSeen) return;
    modelSeen = true;
    if (!isAgentModel(value)) return;
    facts.model = detached(value);
    onModel(facts.model);
  };
  let inputOpen = true;
  const redact = (value) => redactSessionId(redactSessionId(redactSessionId(value, hostSessionId), facts.hostSessionId), facts.agentSessionId);
  const cut = (value) => detached(redact(value).slice(0, REFUSAL_REASON_MAX));
  const hostError = (value) => cut(value || HOST_ERROR_FALLBACK);
  const toolName = (value, fallback) => typeof value === "string" && value ? detached(redact(value).slice(0, TOOL_NAME_MAX)) : fallback;
  const write = (message) => {
    if (inputOpen) send(message);
  };
  const asks = /* @__PURE__ */ new Set();
  const ask = ({ action, reason, canAllow, unavailable }, answer) => {
    if (!inputOpen) return null;
    let withdraw = () => {
    };
    let done = false;
    const respond = (decision) => {
      if (done) return;
      done = true;
      asks.delete(respond);
      withdraw();
      write(answer(decision === "approve" && canAllow ? "approve" : "refuse"));
    };
    const dismiss = () => {
      if (done) return;
      done = true;
      asks.delete(respond);
      withdraw();
    };
    asks.add(respond);
    if (!permissions) {
      respond("refuse");
      return null;
    }
    withdraw = permissions.ask({ action: detached(redact(action)), reason: detached(redact(reason)), canAllow, ...unavailable ? { unavailable: detached(redact(unavailable)) } : {} }, respond);
    return { respond, dismiss };
  };
  const refuseAsks = () => {
    for (const respond of [...asks]) respond("refuse");
  };
  const close = () => {
    if (!inputOpen) return;
    refuseAsks();
    inputOpen = false;
    closeInput();
  };
  if (host !== "claude-code" && host !== "codex" && !acp) throw new Error(`Unknown host ${host}.`);
  const handle = host === "claude-code" ? claudeHandler() : host === "codex" ? codexHandler() : acpConversation({
    label: acp.label,
    autoMode: acp.autoMode,
    initiative,
    checkout,
    hostSessionId,
    resume,
    coordinator: coordinatorOf(coordinator),
    env: acp.env,
    launch: acp.launch,
    agentPid: acp.agentPid,
    facts,
    write,
    close,
    inputOpen: () => inputOpen,
    cut,
    named,
    onSessionId,
    ask
  });
  function claudeHandler() {
    const toolResults = /* @__PURE__ */ new Map();
    const tasks = /* @__PURE__ */ new Set();
    let untrackedTasks = 0;
    const taskKey = digestKey;
    let interruptId = null;
    const waitingTools = /* @__PURE__ */ new Map();
    return {
      start: () => write(claudePrompt(initiative)),
      interrupt() {
        if (interruptId !== null) return;
        interruptId = randomUUID();
        write(claudeInterrupt(interruptId));
      },
      event(event) {
        if (event.type === "control_request" && event.request?.subtype === "can_use_tool" && typeof event.request_id === "string") {
          const request = event.request;
          const named2 = text(request.tool_name).trim() !== "";
          const tool = named2 ? text(request.tool_name) : CLAUDE_UNNAMED_TOOL;
          const input = request.input !== null && typeof request.input === "object" && !Array.isArray(request.input) ? request.input : null;
          const requestId = event.request_id;
          const waiting = ask({ action: `${tool} ${JSON.stringify(request.input ?? null)}`, reason: text(request.decision_reason), canAllow: named2 && input !== null, ...named2 ? {} : { unavailable: CLAUDE_UNNAMED_TOOL_REASON } }, (decision) => {
            waitingTools.delete(requestId);
            return {
              type: "control_response",
              response: { subtype: "success", request_id: requestId, response: decision === "approve" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: REFUSED_ON_ATTENTION } }
            };
          });
          if (waiting) waitingTools.set(requestId, waiting);
          return;
        }
        if (event.type === "control_cancel_request" && typeof event.request_id === "string") {
          const waiting = waitingTools.get(event.request_id);
          waitingTools.delete(event.request_id);
          waiting?.dismiss();
          return;
        }
        if (event.type === "control_response") {
          if (interruptId !== null && event.response?.request_id === interruptId) close();
          return;
        }
        if (event.type === "system" && event.subtype === "init") {
          named(event.model);
          return;
        }
        if (event.type === "system" && typeof event.task_id === "string") {
          const key = taskKey(event.task_id);
          if (event.subtype === "task_started") {
            if (tasks.has(key)) return;
            if (tasks.size < TRACKED_TASKS) tasks.add(key);
            else untrackedTasks += 1;
          }
          if (event.subtype === "task_notification" && !tasks.delete(key) && untrackedTasks > 0) untrackedTasks -= 1;
          return;
        }
        if (event.type === "user" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type !== "tool_result" || block.is_error !== true || typeof block.tool_use_id !== "string") continue;
            const key = digestKey(block.tool_use_id);
            toolResults.delete(key);
            toolResults.set(key, cut(blockText(block.content).trim()));
            if (toolResults.size > KEPT_TOOL_RESULTS) toolResults.delete(toolResults.keys().next().value);
          }
          return;
        }
        if (event.type !== "result") return;
        const denials = (Array.isArray(event.permission_denials) ? event.permission_denials : []).filter((denial) => denial && typeof denial === "object");
        facts.refusalCount = denials.length;
        facts.refusals = denials.slice(0, RECORDED_REFUSALS).map((denial) => {
          const tool = toolName(denial.tool_name, "a tool");
          const reason = typeof denial.tool_use_id === "string" ? toolResults.get(digestKey(denial.tool_use_id))?.trim() : void 0;
          return { tool, reason: reason || cut(`${tool} was refused.`) };
        });
        facts.hostError = event.is_error === true ? hostError(claudeErrorText(event)) : null;
        if (tasks.size === 0 && untrackedTasks === 0) close();
      }
    };
  }
  function codexHandler() {
    const pending = /* @__PURE__ */ new Map();
    const completed = /* @__PURE__ */ new Map();
    const fileChanges = /* @__PURE__ */ new Map();
    const waitingChanges = /* @__PURE__ */ new Map();
    const waitingApprovals = /* @__PURE__ */ new Map();
    const requestKey = (id) => `${typeof id}:${String(id)}`;
    const described = (itemId, changes) => {
      if (typeof itemId !== "string" || !itemId) return;
      const key = digestKey(itemId);
      fileChanges.delete(key);
      fileChanges.set(key, Array.isArray(changes) ? changes : []);
      if (fileChanges.size > KEPT_FILE_CHANGES) fileChanges.delete(fileChanges.keys().next().value);
    };
    let nextId = 1;
    let threadId = null;
    let turnRequested = false;
    let turnDone = false;
    let stopAsked = false;
    let interruptSent = false;
    const request = (method, params) => {
      const id = nextId++;
      pending.set(id, method);
      write({ jsonrpc: "2.0", id, method, params });
    };
    const turnEnded = (turn) => {
      turnDone = true;
      if (turn?.status === "failed") facts.hostError = hostError(text(turn.error?.message));
      close();
    };
    const sendInterrupt = () => {
      if (interruptSent || turnDone || facts.turnId === null) return;
      interruptSent = true;
      const { method, params } = codexInterruptRequest({ threadId, turnId: facts.turnId });
      request(method, params);
    };
    const answered = (method, result) => {
      if (method === "initialize") {
        write({ jsonrpc: "2.0", method: "initialized", params: {} });
        const { method: open, params } = codexThreadRequest({ checkout, hostSessionId, resume, coordinator });
        request(open, params);
        return;
      }
      if (method === "thread/start" || method === "thread/resume") {
        named(result?.model);
        const thread = result?.thread?.id;
        if (method === "thread/start" && validHostSessionId(thread)) {
          facts.hostSessionId = thread;
          onSessionId(thread);
        }
        threadId = method === "thread/resume" ? hostSessionId : typeof thread === "string" && thread ? thread : null;
        if (!threadId) {
          close();
          return;
        }
        const { method: turn, params } = codexTurnRequest({ threadId, initiative, coordinator });
        turnRequested = true;
        request(turn, params);
        return;
      }
      if (method === "turn/start") {
        const id = result?.turn?.id;
        if (typeof id !== "string" || !id) {
          close();
          return;
        }
        facts.turnId = id;
        if (completed.has(digestKey(id))) turnEnded(completed.get(digestKey(id)));
        else if (stopAsked) sendInterrupt();
      }
    };
    return {
      start: () => request("initialize", CODEX_CLIENT),
      interrupt() {
        stopAsked = true;
        if (!turnRequested) close();
        else sendInterrupt();
      },
      event(message) {
        const hasId = typeof message.id === "string" || typeof message.id === "number";
        if (hasId && typeof message.method === "string") {
          const itemId = message.method === "item/fileChange/requestApproval" && typeof message.params?.itemId === "string" && message.params.itemId ? message.params.itemId : null;
          const approval = codexApproval(message.method, message.params, itemId === null ? void 0 : fileChanges.get(digestKey(itemId)));
          if (approval) {
            const { id } = message;
            let waiting = null;
            let answered2 = false;
            const forget = () => {
              if (waiting === null) return;
              if (itemId !== null && waitingChanges.get(digestKey(itemId)) === waiting) waitingChanges.delete(digestKey(itemId));
              if (waitingApprovals.get(requestKey(id)) === waiting) waitingApprovals.delete(requestKey(id));
            };
            waiting = ask(approval.ask, (decision) => {
              answered2 = true;
              forget();
              return { jsonrpc: "2.0", id, result: approval.answer(decision) };
            });
            if (waiting !== null && !answered2) {
              if (itemId !== null) waitingChanges.set(digestKey(itemId), waiting);
              waitingApprovals.set(requestKey(id), waiting);
              const { dismiss } = waiting;
              waiting.dismiss = () => {
                forget();
                dismiss();
              };
            }
            return;
          }
          write({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
          return;
        }
        if (hasId) {
          const method = pending.get(message.id);
          if (!method) return;
          pending.delete(message.id);
          if (method === "turn/interrupt") {
            close();
            return;
          }
          if (message.error !== void 0 && message.error !== null) {
            facts.hostError = hostError(text(message.error?.message));
            close();
            return;
          }
          answered(method, message.result);
          return;
        }
        const params = message.params ?? {};
        if (message.method === "item/started" && params.item?.type === "fileChange") {
          described(params.item.id, params.item.changes);
          return;
        }
        if (message.method === "item/fileChange/patchUpdated") {
          described(params.itemId, params.changes);
          if (typeof params.itemId === "string" && params.itemId) waitingChanges.get(digestKey(params.itemId))?.respond("refuse");
          return;
        }
        if (message.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
          waitingApprovals.get(requestKey(params.requestId))?.dismiss();
          return;
        }
        if (message.method === "item/completed" && params.item?.status === "declined") {
          const tool = toolName(params.item.type, "an action");
          facts.refusalCount += 1;
          if (facts.refusals.length >= RECORDED_REFUSALS) return;
          const command = typeof params.item.command === "string" && params.item.command ? params.item.command : tool;
          facts.refusals.push({ tool, reason: cut(`Codex declined: ${command}`) });
          return;
        }
        if (message.method === "turn/completed" && typeof params.turn?.id === "string") {
          if (facts.turnId === null) {
            const { status, error } = params.turn;
            const kept = status === "failed" ? { status, error: { message: hostError(text(error?.message)) } } : {};
            const key = digestKey(params.turn.id);
            completed.delete(key);
            completed.set(key, kept);
            if (completed.size > KEPT_EARLY_COMPLETIONS) completed.delete(completed.keys().next().value);
          } else if (params.turn.id === facts.turnId) turnEnded(params.turn);
        }
      }
    };
  }
  const splitter = lineSplitter((line) => {
    const event = parseObject(line);
    if (event) handle.event(event);
  });
  return {
    facts,
    get inputOpen() {
      return inputOpen;
    },
    /** Writes the run's opening message: the prompt, or Codex's initialize request. */
    start: () => handle.start(),
    push: (chunk) => splitter.push(chunk),
    end: () => splitter.end(),
    /** Writes one more message to the host while its input is open, such as a stop's interrupt; answers whether it was written. */
    send: (message) => {
      if (!inputOpen) return false;
      send(message);
      return true;
    },
    closeInput: close,
    /** Sends the host's interrupt for a stop; a run whose input is already closed gets none. */
    interrupt: () => {
      if (!inputOpen) return;
      refuseAsks();
      handle.interrupt();
    }
  };
}
export {
  CLAUDE_UNNAMED_TOOL,
  CLAUDE_UNNAMED_TOOL_REASON,
  CODEX_UNDESCRIBED_CHANGE,
  CODEX_UNNAMED_COMMAND,
  EFFORT_PATTERN,
  HOSTS,
  HOST_DEFAULT_COORDINATOR,
  HOST_ERROR_FALLBACK,
  HOST_REQUEST_REFUSAL,
  HOST_SESSION_ID_PATTERN,
  KEPT_EARLY_COMPLETIONS,
  KEPT_FILE_CHANGES,
  MAX_LINE_BYTES,
  MODEL_PATTERN,
  PROVIDER_PATTERN,
  RECORDED_REFUSALS,
  REFUSED_ON_ATTENTION,
  SESSION_ID_PLACEHOLDER,
  STRIPPED_VARIABLES,
  TOOL_NAME_MAX,
  TRACKED_TASKS,
  builtinHost,
  checkedCoordinator,
  claudeInterrupt,
  claudePrompt,
  codexApproval,
  codexInterruptRequest,
  codexThreadRequest,
  codexTurnRequest,
  codexUnavailable,
  hostArguments,
  hostAvailability,
  hostConversation,
  hostDefinition,
  hostDefinitions,
  hostEnvironment,
  lineSplitter,
  redactSessionId,
  resolveDefinition,
  resolveHost,
  resumeCommandOf,
  strippedEnvironment,
  validHostSessionId
};
