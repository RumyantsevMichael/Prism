import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pluginPath } from "../../plugin-root.mjs";
import { EFFORT_PATTERN, HOST_REQUEST_REFUSAL, LAUNCH_NOTE, lineSplitter, MODEL_PATTERN, strippedEnvironment, validHostSessionId } from "../launch-hosts.mjs";
import { acpLaunchArgument, acpTokenArgument, newAcpToken, toolsListed } from "../options-read-marker.mjs";
import type { PermissionAsk, PermissionDecision } from "../permission-requests.mjs";

// The Agent Client Protocol (ACP) version 1 client: JSON-RPC 2.0 over an agent's standard input and output. Prism declares no
// client capability, so an agent asks it for no file or terminal, and every request the agent sends is answered with
// HOST_REQUEST_REFUSAL unless the caller answers it. An agent's command, arguments, and environment come only from its
// declaration or install record.

export const ACP_PROTOCOL_VERSION = 1;
// The error code with which an agent answers session/new while it needs a sign-in.
export const AUTH_REQUIRED_CODE = -32000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const STDERR_KEPT = 2000;
const EXIT_GRACE_MS = 5000;
const KILL_GRACE_MS = 2000;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 300;
const MAX_VALUES = 1000;
// How many tool calls a run keeps the title, kind, and raw input of, for the permission requests that name them.
const KEPT_TOOL_CALLS = 64;
// How much of the reply after the last tool call a run holds before it is redacted and cut to the last message's length.
const HELD_REPLY_CHARS = 64 * 1024;

/** An agent's error answer, or a failure of the connection, with the JSON-RPC code where the agent gave one. */
export class AcpError extends Error {
  declare code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}

/**
 * Prism's MCP server as an ACP session names it: the Node executable that runs this server with the plugin's MCP entry point and the
 * token of the read or run, by which Prism learns that the server listed its tools, with the launch for a launched run, and only
 * NODE_USE_ENV_PROXY, PRISM_LAUNCH for a launched run, PRISM_OPTIONS_READ for a read of run options, and PRISM_REVIEW_APP_DIR when this
 * server has it. The token and the launch go in the arguments too because an agent may start the server with its own environment in
 * place of these variables.
 */
export function prismMcpServer({ env = process.env, token, launch = null, optionsRead = false }: { env?: NodeJS.ProcessEnv; token: string; launch?: string | null; optionsRead?: boolean }) {
  const variables = [
    { name: "NODE_USE_ENV_PROXY", value: "1" },
    ...(launch ? [{ name: "PRISM_LAUNCH", value: launch }] : []),
    ...(optionsRead ? [{ name: "PRISM_OPTIONS_READ", value: "1" }] : []),
    ...(env.PRISM_REVIEW_APP_DIR ? [{ name: "PRISM_REVIEW_APP_DIR", value: env.PRISM_REVIEW_APP_DIR }] : [])
  ];
  return { name: "prism", command: process.execPath, args: [pluginPath("dist", "server", "mcp.mjs"), ...(launch ? [acpLaunchArgument(launch)] : []), acpTokenArgument(token)], env: variables };
}

export interface AcpClientOptions {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Answers a request of the agent: a result, or undefined for HOST_REQUEST_REFUSAL. */
  onRequest?: (method: string, params: any) => unknown;
  onNotification?: (method: string, params: any) => void;
}

/**
 * Starts an agent and speaks ACP with it: request() sends a request and resolves with its result or rejects with an AcpError,
 * closeInput() closes its input, and end() ends it, forcefully after KILL_GRACE_MS. exited resolves once it ended, and stderr()
 * answers the last STDERR_KEPT characters of its standard error. A failed start rejects every request.
 */
export function acpClient({ command, args, env, cwd, onRequest = () => undefined, onNotification = () => {} }: AcpClientOptions) {
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: AcpError) => void }>();
  let nextId = 1;
  let inputOpen = true;
  let ended: AcpError | null = null;
  let stderr = "";
  let bytes = 0;
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  let hasExited = false;
  const failAll = (error: AcpError) => {
    ended = ended ?? error;
    for (const { reject } of pending.values()) reject(ended);
    pending.clear();
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (error: any) {
    failAll(new AcpError(`it could not be started: ${error.message}`));
    hasExited = true;
    resolveExited();
    return { pid: null, request: (_method: string, _params: unknown): Promise<any> => Promise.reject(ended!), closeInput: () => {}, end: () => {}, exited, stderr: () => "", hasExited: () => true, exitGrace: EXIT_GRACE_MS };
  }
  const write = (message: unknown) => {
    if (inputOpen && child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const answerRequest = async (id: unknown, method: string, params: any) => {
    let result: unknown;
    try { result = await onRequest(method, params); } catch { result = undefined; }
    write(result === undefined ? { jsonrpc: "2.0", id, error: { ...HOST_REQUEST_REFUSAL } } : { jsonrpc: "2.0", id, result });
  };
  const splitter = lineSplitter((line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
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
    if (message.error !== undefined && message.error !== null) {
      const code = Number.isSafeInteger(message.error?.code) ? message.error.code : null;
      waiting.reject(new AcpError(typeof message.error?.message === "string" && message.error.message ? message.error.message : "it gave no reason", code));
    } else waiting.resolve(message.result);
  }, MAX_STDOUT_BYTES);
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_STDOUT_BYTES) {
      failAll(new AcpError(`it sent more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MiB`));
      end();
      return;
    }
    splitter.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_KEPT); });
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
    try { child.kill(); } catch {}
    setTimeout(() => { if (!hasExited) try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS).unref();
  }
  return {
    pid: child.pid ?? null,
    request(method: string, params: unknown): Promise<any> {
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
      try { child.stdin!.end(); } catch {}
    },
    end,
    exited,
    stderr: () => stderr,
    hasExited: () => hasExited,
    exitGrace: EXIT_GRACE_MS
  };
}

// ---- Run options ----

const text = (value: unknown) => (typeof value === "string" ? value : "");
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The values of a select config option in the agent's order, flattening groups, each { value, name, description }. */
function selectValues(option: any, pattern: RegExp) {
  const flat: any[] = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    if (isObject(entry) && Array.isArray(entry.options)) flat.push(...entry.options);
    else flat.push(entry);
  }
  const seen = new Set<string>();
  const values = [];
  for (const entry of flat) {
    if (!isObject(entry) || typeof entry.value !== "string" || !pattern.test(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    values.push({ value: entry.value, name: text(entry.name).slice(0, NAME_MAX) || entry.value, description: text(entry.description).slice(0, DESCRIPTION_MAX) });
    if (values.length >= MAX_VALUES) break;
  }
  return values;
}

const optionOfCategory = (options: unknown, category: string) => (Array.isArray(options) ? options.find((option) => isObject(option) && option.category === category && option.type !== "boolean") ?? null : null);

/**
 * The model and thought_level config options of an agent: { id, values, current } for each, or null for one it does not offer,
 * where current is the name of the value it holds now; every other option, the mode option among them, is left out.
 */
export function acpConfigChoices(options: unknown) {
  const choice = (category: string, pattern: RegExp) => {
    const option = optionOfCategory(options, category);
    if (!option || typeof option.id !== "string") return null;
    const values = selectValues(option, pattern);
    const current = values.find((entry) => entry.value === option.currentValue)?.name ?? null;
    return { id: option.id, values, current };
  };
  return { model: choice("model", MODEL_PATTERN), effort: choice("thought_level", EFFORT_PATTERN) };
}

/** The reasons of an agent's run options report that are its own sentences. */
export const acpReasons = Object.freeze({
  version: (label: string, version: unknown) => `${label} speaks ACP version ${String(version)}, and Prism speaks version ${ACP_PROTOCOL_VERSION}.`,
  signIn: (label: string, methods: unknown) => `${label} needs you to sign in before it can run: ${signInMethods(methods)}.`,
  noTools: (label: string) => `${label} did not start Prism's tools, so it cannot run Prism's workflow.`,
  childModels: (label: string) => `${label} chooses the models of its own child agents.`
});

// The names of the sign-in methods an agent answered, or its own command without any. A method's description follows its name in
// parentheses only when it says more than the name: when it has at least two words that the name lacks, apart from linking words,
// so "Log in with Google (Log in with your Google account)" reads "Log in with Google".
function signInMethods(methods: unknown) {
  const named = (Array.isArray(methods) ? methods : []).filter((method) => isObject(method) && text(method.name).trim()).map((method: any) => {
    const name = text(method.name).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    const description = text(method.description).replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX).replace(/\.+$/, "");
    return description && addsToName(name, description) ? `${name} (${description})` : name;
  });
  return named.length ? named.join(", ") : "sign in with the agent's own command";
}

const LINKING_WORDS = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "with", "by", "via", "on", "in", "your", "you", "use", "using"]);
const wordsOf = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function addsToName(name: string, description: string) {
  const own = new Set(wordsOf(name));
  return new Set(wordsOf(description).filter((word) => !own.has(word) && !LINKING_WORDS.has(word))).size >= 2;
}

export interface AcpOptionsDefinition { label: string; command: string; prefix: readonly string[]; acp: { args: readonly string[]; env: Readonly<Record<string, string>> } }

/**
 * Reads an agent's run options without a turn: it starts the agent in the checkout, sends initialize and then session/new with
 * Prism's server, waits until that server listed its tools, sets the selected model with session/set_config_option, sends
 * session/close when the agent can close a session, and closes the agent's input, ending the agent if it still runs EXIT_GRACE_MS
 * later. It never sends session/prompt or authenticate. It answers { state: "ready", model, effort } with acpConfigChoices,
 * { state: "sign-in" | "failed", reason } with a reason of acpReasons, or { state: "failed", message } for any other failure.
 */
export async function readAcpOptions(definition: AcpOptionsDefinition, { checkout, env, model = null, timeoutMs }: { checkout: string; env: NodeJS.ProcessEnv; model?: string | null; timeoutMs: number }): Promise<any> {
  const { label } = definition;
  const deadline = Date.now() + timeoutMs;
  const token = newAcpToken();
  const client = acpClient({
    command: definition.command,
    args: [...definition.prefix, ...definition.acp.args],
    env: { ...strippedEnvironment(env), ...definition.acp.env },
    cwd: checkout,
    // A read asks for no permission; any request is refused, and a permission request is cancelled.
    onRequest: (method) => (method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : undefined)
  });
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new AcpError(`it gave no answer within ${Math.round(timeoutMs / 100) / 10} seconds`));
    }, timeoutMs);
  });
  const within = <T,>(promise: Promise<T>) => Promise.race([promise, timeout]);
  timeout.catch(() => {});
  let sessionId: string | null = null;
  let canClose = false;
  try {
    const initialized = await within(client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "prism-options", version: "1" } }));
    if (initialized?.protocolVersion !== ACP_PROTOCOL_VERSION) return { state: "failed", reason: acpReasons.version(label, initialized?.protocolVersion) };
    canClose = isObject(initialized?.agentCapabilities?.sessionCapabilities?.close);
    let opened: any;
    try {
      opened = await within(client.request("session/new", { cwd: checkout, mcpServers: [prismMcpServer({ env, token, optionsRead: true })] }));
    } catch (error: any) {
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
    // The host default is what the agent holds before Prism sets anything.
    // The agent names its version in initialize's agentInfo, which run options show as the source of the list; run options check its form.
    return { state: "ready", version: initialized?.agentInfo?.version ?? null, model: after.model && { ...after.model, current: before.model?.current ?? null }, effort: after.effort && { ...after.effort, current: before.effort?.current ?? null } };
  } catch (error: any) {
    return { state: "failed", message: error instanceof AcpError ? error.message : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer!);
    if (sessionId && canClose && !client.hasExited() && !timedOut) {
      const closed = client.request("session/close", { sessionId }).catch(() => null);
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2000, deadline - Date.now()))).unref())]);
    }
    client.closeInput();
    if (timedOut) client.end();
    else if (!client.hasExited()) setTimeout(() => client.end(), EXIT_GRACE_MS).unref();
  }
}

// ---- Launched runs ----

// How long a launched run waits for Prism's server in the agent's session to list its tools before it gives up.
export const TOOLS_WAIT_MS = 60000;
const TOKEN_KEYS = Object.freeze(["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"]);
const FAILING_STOPS: ReadonlySet<string> = new Set(["refusal", "max_tokens", "max_turn_requests"]);
// Mode values that Prism never sets, whatever a declaration names, and the words by which any other value says it bypasses or accepts all permissions.
const BYPASS_VALUES: ReadonlySet<string> = new Set(["bypassPermissions", "agent-full-access"]);
const BYPASS_WORDS = /bypass|full[\s_-]*access|(accept|allow|approve)s?\s+(all|every)\s+(permission|request|tool)/i;
export const SKILL_URI = "prism://skills/orchestrate/SKILL.md";

/** The instruction that follows the orchestrate skill's text in a launched run's prompt. */
export const launchInstruction = (initiative: string, answeredGate: string | null = null) => `Run the Prism skill orchestrate in the attached resource for the initiative ${initiative}. Prism's skills are not installed in this agent: read every other Prism skill or reference file that a skill names with Prism's get_skill tool.${answeredGate === null ? "" : ` Act first on the answer of the gate ${answeredGate}.`}`;

/** The run reasons of a launched ACP run that are its own sentences. */
export const acpRunReasons = Object.freeze({
  notOffered: (label: string, value: string, option: string) => `${label} does not offer ${value} for ${option}.`,
  noResume: (label: string) => `${label} cannot resume a session.`,
  stopped: (label: string, stopReason: string) => `${label} stopped: ${stopReason}.`
});

/** The usage a run records: tokens of the prompt's answer, context and cost of the last usage_update, each null when not reported. */
export interface AcpUsage { tokens: Record<string, number> | null; context: { used: number; size: number } | null; cost: { amount: number; currency: string } | null }
export const NO_USAGE: AcpUsage = Object.freeze({ tokens: null, context: null, cost: null });

const bypasses = (entry: { value: string; name: string; description: string }) => BYPASS_VALUES.has(entry.value) || BYPASS_WORDS.test(entry.value) || BYPASS_WORDS.test(entry.name) || BYPASS_WORDS.test(entry.description);
const anyValue = /^[^\u0000-\u001f\u007f]{1,200}$/;

/**
 * The mode value a run sets: the declared autoMode, and otherwise the agent's `auto` mode value, or null when it has neither or the one
 * it has bypasses permissions, so the agent keeps its own mode. A declared value that the agent does not offer is still answered, so the
 * run fails naming it.
 */
export function automaticMode(options: unknown, autoMode: string | null) {
  const option = optionOfCategory(options, "mode");
  const values = option ? selectValues(option, anyValue) : [];
  const allowed = (value: string) => {
    const entry = values.find((item) => item.value === value);
    return entry ? !bypasses(entry) : !BYPASS_VALUES.has(value) && !BYPASS_WORDS.test(value);
  };
  if (autoMode !== null && allowed(autoMode)) return autoMode;
  return values.some((item) => item.value === "auto") && allowed("auto") ? "auto" : null;
}

const finiteTokens = (usage: unknown) => {
  if (!isObject(usage)) return null;
  const counts = Object.fromEntries(TOKEN_KEYS.filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key] as number]));
  return Object.keys(counts).length ? counts : null;
};

export interface AcpRunFacts { hostSessionId: string | null; agentSessionId: string | null; settled: boolean; model: string | null; hostError: string | null; failure: string | null; usage: AcpUsage | null; refusals: { tool: string; reason: string }[]; refusalCount: number; lastMessage: string | null; stopReason: string | null }

export interface AcpConversationOptions {
  label: string;
  autoMode: string | null;
  initiative: string;
  checkout: string;
  hostSessionId: string | null;
  resume: boolean;
  coordinator: { model: string | null; effort: string | null };
  /** The answered gate that the prompt names, for a launch that continues it, or null. */
  answeredGate?: string | null;
  env: NodeJS.ProcessEnv;
  launch: string | null;
  facts: AcpRunFacts;
  write: (message: unknown) => void;
  close: () => void;
  inputOpen: () => boolean;
  /** Host text with the session id redacted and cut, for a reason or an error. */
  cut: (value: string) => string;
  /** A reply's text as the run's last message, with the session ids redacted and cut, or null for blank text. */
  replyText: (value: unknown) => string | null;
  named: (model: unknown) => void;
  onSessionId: (id: string) => void;
  /** Keeps a permission request waiting for the person and answers it once with the message for the decision. */
  ask: (ask: PermissionAsk, answer: (decision: PermissionDecision) => unknown) => { dismiss: () => void } | null;
}

/** What the earlier tool_call and tool_call_update session updates said of one tool call: the latest title, kind, and rawInput each set. */
export interface KnownToolCall { title?: unknown; kind?: unknown; rawInput?: unknown }
const TOOL_CALL_FIELDS = ["title", "kind", "rawInput"] as const;
const isSet = (value: unknown) => value !== undefined && value !== null;

/**
 * An ACP permission request as Prism asks the person: the tool call's title and its raw input as compact JSON as the action, each of
 * title, kind, and rawInput that the request leaves out taken from `known`, and an answer that selects the request's allow_once option
 * for an approval, and its reject_once option, else cancelled, for a refusal; no other option is ever selected.
 */
export function acpPermission(label: string, params: unknown, known: KnownToolCall = {}) {
  const values = isObject(params) ? params : {};
  const sent = isObject(values.toolCall) ? values.toolCall : {};
  const call: Record<string, any> = {};
  for (const field of TOOL_CALL_FIELDS) call[field] = isSet(sent[field]) ? sent[field] : known[field];
  const offered = (Array.isArray(values.options) ? values.options : []).filter((option: unknown) => isObject(option) && typeof option.optionId === "string" && option.optionId);
  const once = (kind: string) => offered.find((option: any) => option.kind === kind)?.optionId as string | undefined;
  const allow = once("allow_once");
  const reject = once("reject_once");
  const kind = text(call.kind).trim() || "other";
  const titled = text(call.title).trim() !== "";
  const reason = `${label} asks before it runs a tool of kind ${kind}.`;
  // A tool call with neither title nor raw input names nothing that an allow would cover, so it can only be refused.
  const ask: PermissionAsk = !titled && !isSet(call.rawInput)
    ? { action: `A tool of kind ${kind} that ${label} did not describe`, reason, canAllow: false, unavailable: `${label} did not say what this tool call does, so Prism can only refuse it.` }
    : { action: `${titled ? text(call.title) : `a tool of kind ${kind}`}${isSet(call.rawInput) ? ` ${JSON.stringify(call.rawInput)}` : ""}`, reason, canAllow: allow !== undefined };
  return {
    ask,
    answer: (decision: PermissionDecision) => {
      const optionId = decision === "approve" ? allow : reject;
      return { outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
    }
  };
}

/**
 * One launched run's conversation with an ACP agent: initialize, session/new with Prism's server or a resume of the recorded session
 * with session/resume or session/load, the automatic mode and the coordinator's model and effort with session/set_config_option, a wait
 * until Prism's server listed its tools, and one session/prompt with the orchestrate skill and the instruction. Every request of the
 * agent other than session/request_permission is answered with HOST_REQUEST_REFUSAL, and a permission request waits for the person. A stop sends session/cancel once while the prompt
 * runs and closes the input when it answers, or closes the input at once before the prompt. It answers { start, interrupt, event }.
 */
export function acpConversation(options: AcpConversationOptions) {
  const { label, initiative, checkout, hostSessionId, resume, coordinator, answeredGate = null, env, launch, facts, write, close, cut } = options;
  const pending = new Map<number, string>();
  const toolCalls = new Map<string, KnownToolCall>();
  // Each permission request that waits, by its JSON-RPC id, so that $/cancel_request withdraws it.
  const waitingPermissions = new Map<string, { dismiss: () => void }>();
  const permissionKey = (id: unknown) => `${typeof id}:${String(id)}`;
  let nextId = 1;
  let sessionId: string | null = null;
  let configOptions: unknown[] = [];
  let embedded = false;
  let canResume = false;
  let canLoad = false;
  let authMethods: unknown = [];
  let queue: { configId: string; value: string }[] = [];
  let prompting = false;
  let promptDone = false;
  let stopAsked = false;
  let cancelSent = false;
  const usage = { tokens: null, context: null, cost: null } as AcpUsage;
  // The reply text that the agent sent during the prompt after its last tool call, and the message id of its last chunk.
  let reply = "";
  let replyId: unknown = undefined;
  let replyStarted = false;
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    pending.set(id, method);
    write({ jsonrpc: "2.0", id, method, params });
  };
  const fail = (reason: string) => {
    facts.settled = true;
    facts.failure = cut(reason);
    close();
  };
  // One token for the run, whether it opens a new session or resumes one.
  const token = newAcpToken();
  const server = () => prismMcpServer({ env, token, launch });

  // The options a run sets, in order, each checked against what the agent offers now; a value it does not offer fails the run.
  const plan = () => {
    const steps: { category: string; value: string }[] = [];
    const mode = automaticMode(configOptions, options.autoMode);
    if (mode !== null) steps.push({ category: "mode", value: mode });
    if (coordinator.model !== null) steps.push({ category: "model", value: coordinator.model });
    if (coordinator.effort !== null) steps.push({ category: "thought_level", value: coordinator.effort });
    return steps;
  };
  const resolveStep = (step: { category: string; value: string }) => {
    const option = optionOfCategory(configOptions, step.category);
    const offered = option && typeof option.id === "string" && selectValues(option, anyValue).some((entry) => entry.value === step.value);
    if (!offered) return { reason: acpRunReasons.notOffered(label, step.value, text(option?.name).trim() || (step.category === "thought_level" ? "effort" : step.category)) };
    return { configId: option.id as string };
  };
  let steps: { category: string; value: string }[] = [];
  const next = () => {
    if (stopAsked) {
      close();
      return;
    }
    const step = steps.shift();
    if (step) {
      const resolved = resolveStep(step);
      if ("reason" in resolved) {
        fail(resolved.reason!);
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
    let skill: string;
    try {
      skill = readFileSync(pluginPath("skills", "orchestrate", "SKILL.md"), "utf8");
    } catch (error: any) {
      fail(`Prism could not read its orchestrate skill: ${error.message}`);
      return;
    }
    const first = embedded ? { type: "resource", resource: { uri: SKILL_URI, mimeType: "text/markdown", text: skill } } : { type: "text", text: skill };
    prompting = true;
    request("session/prompt", { sessionId, prompt: [first, { type: "text", text: launchInstruction(initiative, answeredGate) }, { type: "text", text: LAUNCH_NOTE }] });
  };
  const opened = (method: string, result: any) => {
    const id = method === "session/new" ? result?.sessionId : hostSessionId;
    if (typeof id !== "string" || !id) {
      fail(`${label} named no session.`);
      return;
    }
    sessionId = id;
    // Whatever its characters, the id is redacted from every reason and the kept standard error; only a valid one is recorded.
    facts.agentSessionId = id;
    if (method === "session/new" && validHostSessionId(id)) {
      facts.hostSessionId = id;
      options.onSessionId(id);
    }
    configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    // An agent may forget options on a resume, so every run sets them again.
    steps = plan();
    next();
  };
  const answered = (method: string, result: any) => {
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
    event(message: any) {
      const hasId = typeof message.id === "string" || typeof message.id === "number";
      if (hasId && typeof message.method === "string") {
        if (message.method === "session/request_permission") {
          // The request waits for the person on Attention; the run keeps waiting until it is answered.
          const { id } = message;
          const callId = message.params?.toolCall?.toolCallId;
          const permission = acpPermission(label, message.params, typeof callId === "string" ? toolCalls.get(callId) : undefined);
          const key = permissionKey(id);
          let answered = false;
          const waiting = options.ask(permission.ask, (decision) => {
            answered = true;
            waitingPermissions.delete(key);
            return { jsonrpc: "2.0", id, result: permission.answer(decision) };
          });
          if (waiting && !answered) waitingPermissions.set(key, waiting);
          return;
        }
        write({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
        return;
      }
      if (hasId) {
        const method = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!method) return;
        pending.delete(message.id);
        if (message.error !== undefined && message.error !== null) {
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
        // The agent settled its permission request itself, so it is withdrawn and answered nothing.
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
        // Only text that the agent sent during the run's prompt counts; a chunk with another message id than the last one starts the reply anew.
        if (!prompting || promptDone || !isObject(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") return;
        if (replyStarted && update.messageId !== replyId) reply = "";
        replyStarted = true;
        replyId = update.messageId;
        if (reply.length < HELD_REPLY_CHARS) reply = `${reply}${update.content.text}`.slice(0, HELD_REPLY_CHARS);
      }
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && prompting && !promptDone) {
        // A tool call ends the reply before it, so the last message is only the text after the last tool call.
        reply = "";
        replyStarted = false;
      }
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && typeof update.toolCallId === "string" && update.toolCallId) {
        // Each field that an update sets replaces the one kept; only the KEPT_TOOL_CALLS most recently updated calls are kept.
        const key = update.toolCallId;
        const kept: KnownToolCall = { ...toolCalls.get(key) };
        for (const field of TOOL_CALL_FIELDS) if (isSet(update[field])) kept[field] = update[field];
        toolCalls.delete(key);
        toolCalls.set(key, kept);
        if (toolCalls.size > KEPT_TOOL_CALLS) toolCalls.delete(toolCalls.keys().next().value!);
      }
    }
  };
}
