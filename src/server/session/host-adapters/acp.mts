import { spawn } from "node:child_process";
import { pluginPath } from "../../plugin-root.mjs";
import { EFFORT_PATTERN, HOST_REQUEST_REFUSAL, lineSplitter, MODEL_PATTERN, strippedEnvironment } from "../launch-hosts.mjs";
import { toolsListed } from "../options-read-marker.mjs";

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
 * Prism's MCP server as an ACP session names it: the Node executable that runs this server with the plugin's MCP entry point, and
 * only NODE_USE_ENV_PROXY, PRISM_LAUNCH for a launched run, PRISM_OPTIONS_READ for a read of run options, and PRISM_REVIEW_APP_DIR
 * when this server has it.
 */
export function prismMcpServer({ env = process.env, launch = null, optionsRead = false }: { env?: NodeJS.ProcessEnv; launch?: string | null; optionsRead?: boolean } = {}) {
  const variables = [
    { name: "NODE_USE_ENV_PROXY", value: "1" },
    ...(launch ? [{ name: "PRISM_LAUNCH", value: launch }] : []),
    ...(optionsRead ? [{ name: "PRISM_OPTIONS_READ", value: "1" }] : []),
    ...(env.PRISM_REVIEW_APP_DIR ? [{ name: "PRISM_REVIEW_APP_DIR", value: env.PRISM_REVIEW_APP_DIR }] : [])
  ];
  return { name: "prism", command: process.execPath, args: [pluginPath("dist", "server", "mcp.mjs")], env: variables };
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

// The names, with their descriptions in parentheses, of the sign-in methods an agent answered, or its own command without any.
function signInMethods(methods: unknown) {
  const named = (Array.isArray(methods) ? methods : []).filter((method) => isObject(method) && text(method.name).trim()).map((method: any) => {
    const name = text(method.name).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    const description = text(method.description).replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX).replace(/\.+$/, "");
    return description ? `${name} (${description})` : name;
  });
  return named.length ? named.join(", ") : "sign in with the agent's own command";
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
      opened = await within(client.request("session/new", { cwd: checkout, mcpServers: [prismMcpServer({ env, optionsRead: true })] }));
    } catch (error: any) {
      if (error instanceof AcpError && error.code === AUTH_REQUIRED_CODE && !timedOut) return { state: "sign-in", reason: acpReasons.signIn(label, initialized?.authMethods) };
      throw error;
    }
    sessionId = typeof opened?.sessionId === "string" && opened.sessionId ? opened.sessionId : null;
    if (!sessionId) return { state: "failed", message: "it named no session" };
    const listed = client.pid !== null && await toolsListed({ env, agentPid: client.pid, deadline, stopped: () => client.hasExited() });
    if (!listed) return { state: "failed", reason: acpReasons.noTools(label) };
    let options = opened.configOptions;
    const before = acpConfigChoices(options);
    if (model !== null && before.model?.values.some((entry) => entry.value === model)) {
      const set = await within(client.request("session/set_config_option", { sessionId, configId: before.model.id, value: model }));
      if (Array.isArray(set?.configOptions)) options = set.configOptions;
    }
    const after = acpConfigChoices(options);
    // The host default is what the agent holds before Prism sets anything.
    return { state: "ready", model: after.model && { ...after.model, current: before.model?.current ?? null }, effort: after.effort && { ...after.effort, current: before.effort?.current ?? null } };
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
