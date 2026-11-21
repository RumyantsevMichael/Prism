import { createHash, randomUUID } from "node:crypto";
import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { acpHostDefinition, acpHosts, isAcpHost } from "./acp-agents.mjs";
import { isAgentModel } from "./agent-models.mjs";
import { acpConversation } from "./host-adapters/acp.mjs";
import { lastMessageOf } from "./run-result.mjs";
import { shownForm, type PermissionAsk, type PermissionDecision } from "./permission-requests.mjs";

// The hosts that a launched session runs, the commands Prism runs for them, and the readers of their output streams.
// Nothing here takes a value from the review page except the initiative identifier, checked by the caller, the host, and the
// coordinator's choice, which reaches a host only as the values of --model and --effort or of Codex's model, modelProvider, and
// effort, and only once it keeps the name rules.

// HOSTS is also the order of every list of hosts. Each host's optionsRead is how Prism reads its run options without a turn or a
// kept session: Claude Code answers one initialize control request in a print-mode session that keeps no session and runs no
// hooks or servers, and Codex's app server lists its providers and models for a client that opens no thread.
export const HOSTS = Object.freeze([
  Object.freeze({
    host: "claude-code",
    label: "Claude Code",
    executable: "claude",
    optionsRead: Object.freeze({
      args: Object.freeze(["-p", "--verbose", "--no-session-persistence", "--settings", "{\"disableAllHooks\":true}", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--input-format", "stream-json", "--output-format", "stream-json"]),
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

// The host session variables that a review app started by an agent session inherits; a launched host sees none of them.
export const STRIPPED_VARIABLES = Object.freeze([
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

// Claude Code decides what it can in its auto mode and sends Prism each permission prompt that it still asks, as a can_use_tool
// control request on its standard output.
const CLAUDE_FLAGS = Object.freeze(["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"]);
// The permission policy of every Codex thread that Prism starts or resumes: the host's automatic review decides what it can, and asks
// Prism only the rest.
const CODEX_POLICY = Object.freeze({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
// The fixed start note of every launched run, its launch and each resume: Claude Code reads it through --append-system-prompt,
// Codex as the developerInstructions of its thread, and an ACP agent as the last text block of its prompt.
export const LAUNCH_NOTE = "Prism launched this run headless, so no person reads your messages or replies. When you need the person, ask only through a Prism gate: record it with update_coordination_state and wait for the answer with wait_for_user_gate. Where your autonomy lets you, decide by yourself and continue the work. Never end a turn with a question in your reply, because nobody sees it.";
const CODEX_CLIENT = Object.freeze({ clientInfo: { name: "prism-launch", version: "1" }, capabilities: { experimentalApi: true } });
// The answer to every request that a host sends Prism other than a permission request, such as a question.
export const HOST_REQUEST_REFUSAL = Object.freeze({ code: -32601, message: "Prism answers no host requests." });
export const MAX_LINE_BYTES = 1024 * 1024;
// What a run keeps of host text: each refusal reason and host error is cut to REFUSAL_REASON_MAX characters, a run records its
// first RECORDED_REFUSALS refusals with the number of all of them, and a Claude Code run holds the cut text of only its
// KEPT_TOOL_RESULTS most recent error tool results, so a long run's memory and record stay bounded.
// A refusal's tool name is cut to TOOL_NAME_MAX characters, so `<tool> was refused.` and the blocked reason stay short; a Codex
// run keeps only the KEPT_EARLY_COMPLETIONS most recent turn completions that arrive before the turn/start answer, with their cut
// error text; and a Claude Code run tracks at most TRACKED_TASKS running background tasks by a fixed-size digest of their ids.
const REFUSAL_REASON_MAX = 500;
export const RECORDED_REFUSALS = 20;
const KEPT_TOOL_RESULTS = 100;
export const TOOL_NAME_MAX = 100;
export const KEPT_EARLY_COMPLETIONS = 8;
// How many file change items' changes a Codex run keeps for the approval requests that name them, the oldest going first.
export const KEPT_FILE_CHANGES = 64;
export const TRACKED_TASKS = 1000;
export const HOST_ERROR_FALLBACK = "The turn failed without a message.";
// A host session id that may reach a command line: letters, digits, `_`, and `-`, never first, so no host reads it as an option and no shell splits it.
export const HOST_SESSION_ID_PATTERN = /^[0-9A-Za-z_][0-9A-Za-z_-]*$/;
export const SESSION_ID_PLACEHOLDER = "<host session id>";

export function validHostSessionId(value: unknown): value is string {
  return typeof value === "string" && HOST_SESSION_ID_PATTERN.test(value);
}

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/**
 * The text with every occurrence of the host session id, in any letter case, replaced by a placeholder; any non-empty id counts, also
 * one that HOST_SESSION_ID_PATTERN refuses, such as an ACP agent's opaque session id, and its characters are matched literally.
 */
export function redactSessionId<T>(text: T, hostSessionId: unknown): T {
  if (typeof text !== "string" || typeof hostSessionId !== "string" || !hostSessionId) return text;
  return text.replace(new RegExp(hostSessionId.replace(REGEX_SYNTAX, "\\$&"), "gi"), SESSION_ID_PLACEHOLDER) as T;
}

/** Claude Code's or Codex's definition, or null for any other host. */
export function builtinHost(host: unknown) {
  return HOSTS.find((definition) => definition.host === host) ?? null;
}

/** A host's definition: Claude Code, Codex, or an ACP agent offered now, whose declaration or install record is read again on every call. */
export function hostDefinition(host: string, env: NodeJS.ProcessEnv = process.env): { host: string; label: string; executable: string; acp?: unknown } | null {
  return builtinHost(host) ?? (isAcpHost(host) ? acpHostDefinition(host, env) : null);
}

/** Every host in list order: Claude Code, Codex, then the ACP agents offered now in install and then declaration order. */
export function hostDefinitions(env: NodeJS.ProcessEnv = process.env) {
  return [...HOSTS, ...acpHosts(env)];
}

async function executableFile(file: string) {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== "win32") await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env: NodeJS.ProcessEnv) {
  const value = env.PATH ?? env.Path ?? "";
  return value.split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
}

// npm's command shims run Node with a script beside the shim, named as "%dp0%\<relative script>".
async function npmShimScript(file: string) {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return null; }
  if (!/node/i.test(text)) return null;
  const match = /"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/i.exec(text);
  if (!match) return null;
  const script = path.resolve(path.dirname(file), match[1]);
  return (await executableFile(script)) ? script : null;
}

/**
 * How a host is run on this machine: { ...definition, available, executable, command, prefix, reason },
 * where command and prefix are what the supervisor spawns before the host arguments.
 */
export interface ResolvedHost { host: string; label: string; executable: string | null; available: boolean; command: string | null; prefix: string[]; reason: string | null }

export async function resolveHost(host: string, env = process.env): Promise<ResolvedHost | null> {
  const definition = hostDefinition(host, env);
  return definition ? resolveDefinition(definition, env) : null;
}

/** How one host definition is run on this machine, as resolveHost answers it. */
export async function resolveDefinition(definition: { host: string; label: string; executable: string }, env: NodeJS.ProcessEnv): Promise<ResolvedHost> {
  // An ACP agent's command may be an absolute path, which is run as it is.
  if (path.isAbsolute(definition.executable)) {
    if (await executableFile(definition.executable)) return { ...definition, available: true, executable: definition.executable, command: definition.executable, prefix: [], reason: null };
    return { ...definition, available: false, executable: null, command: null, prefix: [], reason: `${definition.label} was not found: no executable file at ${definition.executable}.` };
  }
  const missing: ResolvedHost = { ...definition, available: false, executable: null, command: null, prefix: [], reason: `${definition.label} was not found: no ${definition.executable} executable on PATH.` };
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
      if (!(await executableFile(file))) continue;
      if (extension === ".exe") return { ...definition, available: true, executable: file, command: file, prefix: [], reason: null };
      const script = await npmShimScript(file);
      if (!script) return { ...definition, available: false, executable: file, command: null, prefix: [], reason: `Prism cannot run ${file} safely: it is not an npm command shim.` };
      return { ...definition, available: true, executable: file, command: process.execPath, prefix: [script], reason: null };
    }
  }
  return missing;
}

/**
 * One entry per host in order: { host, label, available, executable, reason }; acp false lists only Claude Code and Codex.
 * The ACP agents are read again on every call.
 */
export async function hostAvailability({ env = process.env, acp = true }: { env?: NodeJS.ProcessEnv; acp?: boolean } = {}) {
  const definitions = acp ? hostDefinitions(env) : [...HOSTS];
  return Promise.all(definitions.map(async (definition) => {
    const { host } = definition;
    const { label, available, executable, reason } = await resolveDefinition(definition, env);
    return { host, label, available, executable, reason };
  }));
}

// The coordinator's choice of a launch: { provider, model, effort, typed }, each part null for the host default.
export const HOST_DEFAULT_COORDINATOR = Object.freeze({ provider: null, model: null, effort: null, typed: false });
// The name rules: a value that breaks one never reaches a host, and none admits a leading dash or white space.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]+-]{0,199}$/;
export const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const CHOICE_PARTS: readonly string[] = Object.freeze(["provider", "model", "effort", "typed"]);

/**
 * The coordinator's choice in full, or null when it breaks the name rules: an object of at most provider, model, effort, and typed,
 * each name null or matching its rule, which admits no leading dash or white space, so no host reads one as an option.
 * A missing choice is the host default.
 */
export interface CoordinatorChoice { provider: string | null; model: string | null; effort: string | null; typed: boolean }

export function checkedCoordinator(value: any): CoordinatorChoice | null {
  if (value === undefined || value === null) return { ...HOST_DEFAULT_COORDINATOR };
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !CHOICE_PARTS.includes(key))) return null;
  const part = (name: string, pattern: RegExp) => {
    const item = value[name] ?? null;
    return item === null ? null : typeof item === "string" && pattern.test(item) ? item : undefined;
  };
  const choice = { provider: part("provider", PROVIDER_PATTERN), model: part("model", MODEL_PATTERN), effort: part("effort", EFFORT_PATTERN), typed: value.typed ?? false };
  if (choice.provider === undefined || choice.model === undefined || choice.effort === undefined || typeof choice.typed !== "boolean") return null;
  return { ...choice, typed: choice.typed && choice.model !== null } as CoordinatorChoice;
}

function coordinatorOf(coordinator: unknown): CoordinatorChoice {
  const checked = checkedCoordinator(coordinator);
  if (!checked) throw new Error("The coordinator's choice is not one Prism can pass to a host.");
  return checked;
}

/**
 * The arguments of a run: Claude Code's launch or resume form with its session id, followed by --model and --effort of the
 * coordinator's choice, each left out for the host default, Codex's app server, which takes the choice in its requests, or an ACP
 * agent's arguments from its declaration or install record, which takes the choice in its requests too.
 */
export function hostArguments({ host, hostSessionId, resume, coordinator = null, acp = null }: { host: string; hostSessionId: unknown; resume?: boolean; coordinator?: unknown; acp?: { args: readonly string[] } | null }) {
  if (host === "claude-code") {
    if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
    const { model, effort } = coordinatorOf(coordinator);
    return ["-p", "--verbose", resume ? "--resume" : "--session-id", hostSessionId, ...CLAUDE_FLAGS, "--append-system-prompt", LAUNCH_NOTE, ...(model === null ? [] : ["--model", model]), ...(effort === null ? [] : ["--effort", effort])];
  }
  if (host === "codex") return ["app-server"];
  if (acp) return [...acp.args];
  throw new Error(`Unknown host ${host}.`);
}

/** The stream-json user message that gives a Claude Code run its prompt. */
export function claudePrompt(initiative: string) {
  return { type: "user", message: { role: "user", content: `/prism:orchestrate ${initiative}` } };
}

/**
 * The Codex request that opens the run's thread: thread/start for a launch, thread/resume with the kept thread id for a resume,
 * each with the model and provider of the coordinator's choice, left out for the host default.
 */
export function codexThreadRequest({ checkout, hostSessionId, resume, coordinator = null }: { checkout: string; hostSessionId: unknown; resume?: boolean; coordinator?: unknown }) {
  const { model, provider } = coordinatorOf(coordinator);
  const chosen = { ...(model === null ? {} : { model }), ...(provider === null ? {} : { modelProvider: provider }) };
  if (!resume) return { method: "thread/start", params: { cwd: checkout, ...CODEX_POLICY, ...chosen, developerInstructions: LAUNCH_NOTE } };
  if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
  return { method: "thread/resume", params: { threadId: hostSessionId, cwd: checkout, ...CODEX_POLICY, ...chosen, developerInstructions: LAUNCH_NOTE } };
}

/** The Codex request that starts the run's one orchestrate turn, with the effort of the coordinator's choice, left out for the host default. */
export function codexTurnRequest({ threadId, initiative, coordinator = null }: { threadId: string; initiative: string; coordinator?: unknown }) {
  const { effort } = coordinatorOf(coordinator);
  return { method: "turn/start", params: { threadId, input: [{ type: "text", text: `$prism:orchestrate ${initiative}` }], ...(effort === null ? {} : { effort }) } };
}

const CODEX_APPROVALS: ReadonlySet<string> = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);
const isPlainObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

const isSet = (value: unknown) => value !== undefined && value !== null;
export const CODEX_UNDESCRIBED_CHANGE = "A file change that Codex did not describe";
export const CODEX_UNNAMED_COMMAND = "A command that Codex did not name";
export const CLAUDE_UNNAMED_TOOL = "A tool that Claude Code did not name";
export const CLAUDE_UNNAMED_TOOL_REASON = "Claude Code did not say which tool this runs, so Prism can only refuse it.";
export const codexUnavailable = {
  undescribed: "Codex did not say which files this change writes, so Prism can only refuse it.",
  unnamed: "Codex did not say which command this runs, so Prism can only refuse it.",
  grantRoot: (root: string) => `Codex asks to allow writes under ${shownForm(root)} for the rest of the session, so Prism can only refuse it.`,
  permissions: "Codex asks for these permissions for the rest of its turn, so Prism can only refuse it."
};

// The action of a Codex command request: the command, then the folder, environment, kind, and network host that its accept covers;
// named is false when the request has no command that holds more than spaces.
function codexCommandAction(params: Record<string, any>) {
  const given = Array.isArray(params.command) ? params.command.filter((part: unknown) => typeof part === "string").join(" ") : text(params.command);
  const named = given.trim() !== "";
  const command = named ? given : CODEX_UNNAMED_COMMAND;
  const network = isPlainObject(params.networkApprovalContext) ? { host: params.networkApprovalContext.host, protocol: params.networkApprovalContext.protocol } : params.networkApprovalContext;
  const context = {
    ...(isSet(params.cwd) ? { cwd: params.cwd } : {}),
    ...(isSet(params.environmentId) ? { environmentId: params.environmentId } : {}),
    ...(isSet(params.kind) && params.kind !== "command" ? { kind: params.kind } : {}),
    ...(isSet(network) ? { networkApprovalContext: network } : {})
  };
  return { named, action: Object.keys(context).length ? `${command} ${JSON.stringify(context)}` : command };
}

/**
 * A Codex approval request as Prism asks the person: { ask, answer }, or null for any other request. `changes` is the changes list of
 * the latest item/started or item/fileChange/patchUpdated notification that named a file change request's item, or undefined when
 * none did. An approval answers accept for a named command or a described file change without grantRoot; a command without a
 * command, a file change with grantRoot or no seen change, and a permissions request, can only be refused. A refusal answers decline, or for a permissions request no permission.
 */
export function codexApproval(method: string, params: unknown, changes?: unknown) {
  if (!CODEX_APPROVALS.has(method)) return null;
  const values = isPlainObject(params) ? params : {};
  const reason = text(values.reason);
  const decided = (decision: PermissionDecision) => ({ decision: decision === "approve" ? "accept" : "decline" });
  if (method === "item/permissions/requestApproval") {
    const asked = isSet(values.permissions) ? JSON.stringify(values.permissions) : "{}";
    return {
      ask: { action: `Permissions ${asked}`, reason, canAllow: false, unavailable: codexUnavailable.permissions },
      answer: (_decision: PermissionDecision) => ({ permissions: {}, scope: "turn" })
    };
  }
  if (method === "item/fileChange/requestApproval") {
    if (!Array.isArray(changes) || changes.length === 0) return { ask: { action: CODEX_UNDESCRIBED_CHANGE, reason, canAllow: false, unavailable: codexUnavailable.undescribed }, answer: decided };
    const grantRoot = isSet(values.grantRoot) ? values.grantRoot : undefined;
    const action = `File change ${JSON.stringify({ changes, ...(grantRoot === undefined ? {} : { grantRoot }) })}`;
    if (grantRoot === undefined) return { ask: { action, reason, canAllow: true }, answer: decided };
    return { ask: { action, reason, canAllow: false, unavailable: codexUnavailable.grantRoot(typeof grantRoot === "string" ? grantRoot : JSON.stringify(grantRoot)) }, answer: decided };
  }
  const command = codexCommandAction(values);
  if (!command.named) return { ask: { action: command.action, reason, canAllow: false, unavailable: codexUnavailable.unnamed }, answer: decided };
  return { ask: { action: command.action, reason, canAllow: true }, answer: decided };
}

/** The stream-json line that Claude Code's own Stop button sends: an interrupt control request with a request id that Prism chooses. */
export function claudeInterrupt(requestId: string) {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}

/** The Codex request that interrupts the run's turn, as the app's own Stop button does. */
export function codexInterruptRequest({ threadId, turnId }: { threadId: string | null; turnId: string }) {
  return { method: "turn/interrupt", params: { threadId, turnId } };
}

/**
 * The command that continues a host session in a terminal, or null for an id that breaks HOST_SESSION_ID_PATTERN; an ACP agent's is
 * its declared resumeCommand with {session} replaced, and null without one or once the agent is no longer offered.
 */
export function resumeCommandOf(host: string, hostSessionId: unknown, env: NodeJS.ProcessEnv = process.env) {
  if (!validHostSessionId(hostSessionId)) return null;
  if (host === "claude-code") return `claude --resume ${hostSessionId}`;
  if (host === "codex") return `codex resume ${hostSessionId}`;
  const template = isAcpHost(host) ? acpHostDefinition(host, env)?.acp.resumeCommand : null;
  return template ? template.replaceAll("{session}", hostSessionId) : null;
}

/** The starter's environment without the host session variables, as a launched run and a read of run options see it. */
export function strippedEnvironment(env: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of STRIPPED_VARIABLES) delete result[name];
  return result;
}

/**
 * The environment of a run: the starter's own, without the host session variables, and with PRISM_LAUNCH naming the launch; an ACP
 * agent's run adds the environment of its declaration or install record.
 */
export function hostEnvironment(env: NodeJS.ProcessEnv, launchId: string, acp: { env: Readonly<Record<string, string>> } | null = null) {
  return { ...strippedEnvironment(env), ...(acp ? acp.env : {}), PRISM_LAUNCH: launchId };
}

/** Splits a byte stream into lines, dropping every line longer than maxBytes, MAX_LINE_BYTES unless given. */
export function lineSplitter(onLine: (line: string) => void, maxBytes = MAX_LINE_BYTES) {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  const emit = (buffer: Buffer) => {
    if (!discarding && buffer.length <= maxBytes) onLine(buffer.toString("utf8").replace(/\r$/, ""));
  };
  return {
    push(chunk: Buffer) {
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

function parseObject(line: string) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function blockText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block: any) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "")).join("");
  return "";
}


const text = (value: unknown) => (typeof value === "string" ? value : "");
// A Claude Code error result's text: its `result` when that is a non-empty string, and otherwise its `errors` strings joined.
const claudeErrorText = (event: any) => (text(event.result) || (Array.isArray(event.errors) ? event.errors.filter((entry: unknown) => typeof entry === "string").join("; ") : ""));

// A slice of a long string can keep the whole string alive, so kept host text is copied into a string of its own; the UTF-16
// round trip keeps every code unit, a lone surrogate at the cut included.
const detached = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");
// Host ids are kept by a fixed-size digest of every UTF-16 code unit, so a long id costs no more than a short one and ids that
// differ only in a lone surrogate stay apart.
const digestKey = (id: string) => createHash("sha256").update(Buffer.from(id, "utf16le")).digest("base64");

/**
 * One run's conversation with its host over the host's standard input and output.
 * `send(message)` writes one JSON line to the host's input and `closeInput()` ends that input; the conversation calls neither
 * after it closed the input, and closes it once the host's work is over, so the host exits by itself.
 * `facts` collects { hostSessionId, turnId, model, refusals, refusalCount, hostError }: model is the one that Claude Code's first
 * `system` `init` event or Codex's thread/start or thread/resume result names, or null when that is no model a claim may record;
 * refusals holds the first RECORDED_REFUSALS of the refusalCount refusals, and host text in them has the host session id, the
 * known one or the one the run names, replaced before it is cut. onModel is called once with the model as soon as the host names
 * one, and onSessionId is called once when a Codex launch names its thread with an id that is safe to keep.
 * `interrupt()` stops the run the way the host's own Stop button does: it sends the host's interrupt while the input is open and
 * closes the input once the host has answered it, or at once for a Codex run that has not sent turn/start yet.
 */
export interface HostRefusal { tool: string; reason: string }
// agentSessionId is the session id an ACP agent named, whatever its characters, kept only to redact it; settled is false while an ACP
// run has no outcome of its own, so an agent that exits 0 before its prompt answers fails the run.
// lastMessage is the text of the host's last reply in the run, with the session ids replaced and cut, or null; stopReason is the stop
// reason with which an ACP agent's prompt answered, or null.
export interface HostFacts { hostSessionId: string | null; agentSessionId: string | null; settled: boolean; turnId: string | null; model: string | null; refusals: HostRefusal[]; refusalCount: number; hostError: string | null; failure: string | null; usage: any; lastMessage: string | null; stopReason: string | null }
export interface HostConversationOptions {
  initiative: string;
  checkout: string;
  hostSessionId?: string | null;
  resume?: boolean;
  coordinator?: unknown;
  send: (message: unknown) => void;
  closeInput: () => void;
  onSessionId?: (id: string) => void;
  onModel?: (model: string) => void;
  /** An ACP agent's run: its label and automatic mode, the starter's environment, the launch id, and the agent's process id. */
  acp?: { label: string; autoMode: string | null; env: NodeJS.ProcessEnv; launch: string; agentPid: () => number | null } | null;
  /**
   * Where the host's permission requests wait for the person: ask() keeps one waiting, calls respond once it is answered, and returns
   * the function that withdraws it. Without it every permission request is refused at once.
   */
  permissions?: PermissionBroker | null;
}

export interface PermissionBroker { ask(ask: PermissionAsk, respond: (decision: PermissionDecision) => void): () => void }

/**
 * A request that waits for the person: respond answers the host once, and dismiss removes the request without answering it, for a
 * request that the host reports settled by itself.
 */
export interface WaitingAsk { respond: (decision: PermissionDecision) => void; dismiss: () => void }

/** The message with which the host's permission request is answered for a decision; approve answers only a single-use allow. */
export type PermissionAnswer = (decision: PermissionDecision) => unknown;
export const REFUSED_ON_ATTENTION = "The person refused this on Attention.";

export function hostConversation(host: string, { initiative, checkout, hostSessionId = null, resume = false, coordinator = null, send, closeInput, onSessionId = () => {}, onModel = () => {}, acp = null, permissions = null }: HostConversationOptions) {
  const facts: HostFacts = { hostSessionId: null, agentSessionId: null, settled: false, turnId: null, model: null, refusals: [], refusalCount: 0, hostError: null, failure: null, usage: null, lastMessage: null, stopReason: null };
  let modelSeen = false;
  // Only the first place that can name the run's model counts; a value that is no model a claim may record keeps none.
  const named = (value: unknown) => {
    if (modelSeen) return;
    modelSeen = true;
    if (!isAgentModel(value)) return;
    facts.model = detached(value);
    onModel(facts.model);
  };
  let inputOpen = true;
  const redact = (value: string) => redactSessionId(redactSessionId(redactSessionId(value, hostSessionId), facts.hostSessionId), facts.agentSessionId);
  // The id is replaced before the text is cut, so no cut leaves part of it behind.
  const cut = (value: string) => detached(redact(value).slice(0, REFUSAL_REASON_MAX));
  const hostError = (value: string) => cut(value || HOST_ERROR_FALLBACK);
  // A reply's text as the run's last message, kept in a string of its own.
  const replyText = (value: unknown) => {
    const kept = lastMessageOf(value, redact);
    return kept === null ? null : detached(kept);
  };
  const toolName = (value: unknown, fallback: string) => (typeof value === "string" && value ? detached(redact(value).slice(0, TOOL_NAME_MAX)) : fallback);
  const write = (message: unknown) => {
    if (inputOpen) send(message);
  };
  // Each permission request waits until the person answers it, and one that still waits when the run's input closes, or when the
  // person stops the run, is refused first. A request is answered once; an approval of one that offers no single-use allow is refused.
  const asks = new Set<(decision: PermissionDecision) => void>();
  const ask = ({ action, reason, canAllow, unavailable }: PermissionAsk, answer: PermissionAnswer): WaitingAsk | null => {
    if (!inputOpen) return null;
    let withdraw = () => {};
    let done = false;
    const respond = (decision: PermissionDecision) => {
      if (done) return;
      done = true;
      asks.delete(respond);
      withdraw();
      write(answer(decision === "approve" && canAllow ? "approve" : "refuse"));
    };
    // The host settled the request itself, so it is removed and answered nothing, and a dialog that confirms later allows nothing.
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
    // The whole text goes to the broker, which keeps its shown form and marks one too long to confirm in full.
    withdraw = permissions.ask({ action: detached(redact(action)), reason: detached(redact(reason)), canAllow, ...(unavailable ? { unavailable: detached(redact(unavailable)) } : {}) }, respond);
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
    label: acp!.label,
    autoMode: acp!.autoMode,
    initiative,
    checkout,
    hostSessionId,
    resume,
    coordinator: coordinatorOf(coordinator),
    env: acp!.env,
    launch: acp!.launch,
    agentPid: acp!.agentPid,
    facts,
    write,
    close,
    inputOpen: () => inputOpen,
    cut,
    replyText,
    named,
    onSessionId,
    ask
  });

  // Claude Code: the prompt is one stream-json user message, and the input closes at a result event once every background task
  // that the host reported as started has been reported as ended.
  // Running tasks are held by digest, at most TRACKED_TASKS of them; a start past that is only counted, and a notification of a
  // task that is not held ends one counted task, so the input never closes while the host still reports more starts than ends.
  function claudeHandler() {
    const toolResults = new Map<string, string>();
    const tasks = new Set<string>();
    let untrackedTasks = 0;
    const taskKey = digestKey;
    let interruptId: string | null = null;
    // Each can_use_tool request that waits, by its request id, so that a control_cancel_request withdraws it.
    const waitingTools = new Map<string, WaitingAsk>();
    return {
      start: () => write(claudePrompt(initiative)),
      interrupt() {
        if (interruptId !== null) return;
        interruptId = randomUUID();
        write(claudeInterrupt(interruptId));
      },
      event(event: any) {
        if (event.type === "control_request" && event.request?.subtype === "can_use_tool" && typeof event.request_id === "string") {
          const request = event.request;
          const named = text(request.tool_name).trim() !== "";
          const tool = named ? text(request.tool_name) : CLAUDE_UNNAMED_TOOL;
          const input = request.input !== null && typeof request.input === "object" && !Array.isArray(request.input) ? request.input : null;
          const requestId = event.request_id;
          // The action is the tool and the input that an approval allows, as compact JSON; a request that names no tool can only be refused.
          const waiting = ask({ action: `${tool} ${JSON.stringify(request.input ?? null)}`, reason: text(request.decision_reason), canAllow: named && input !== null, ...(named ? {} : { unavailable: CLAUDE_UNNAMED_TOOL_REASON }) }, (decision) => {
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
          // Claude Code settled the request itself, so it is withdrawn and answered nothing.
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
          // Only error tool results can be refusal reasons; the oldest kept one goes once more than KEPT_TOOL_RESULTS are held.
          for (const block of event.message.content) {
            if (block?.type !== "tool_result" || block.is_error !== true || typeof block.tool_use_id !== "string") continue;
            const key = digestKey(block.tool_use_id);
            toolResults.delete(key);
            toolResults.set(key, cut(blockText(block.content).trim()));
            if (toolResults.size > KEPT_TOOL_RESULTS) toolResults.delete(toolResults.keys().next().value!);
          }
          return;
        }
        if (event.type !== "result") return;
        // The last result event decides the run's refusals and host error.
        const denials = (Array.isArray(event.permission_denials) ? event.permission_denials : []).filter((denial: any) => denial && typeof denial === "object");
        facts.refusalCount = denials.length;
        facts.refusals = denials.slice(0, RECORDED_REFUSALS).map((denial: any) => {
          const tool = toolName(denial.tool_name, "a tool");
          const reason = typeof denial.tool_use_id === "string" ? toolResults.get(digestKey(denial.tool_use_id))?.trim() : undefined;
          return { tool, reason: reason || cut(`${tool} was refused.`) };
        });
        facts.hostError = event.is_error === true ? hostError(claudeErrorText(event)) : null;
        // The last result that is no error holds the run's last reply.
        if (event.is_error !== true) facts.lastMessage = replyText(event.result);
        if (tasks.size === 0 && untrackedTasks === 0) close();
      }
    };
  }

  // Codex: JSON-RPC 2.0 with `codex app-server`, through initialize, the thread start or resume, and one turn; every request
  // that the host sends is answered with HOST_REQUEST_REFUSAL, and the input closes when the run's turn completes or the host
  // answers one of Prism's requests with an error.
  function codexHandler() {
    const pending = new Map<number | string, string>();
    const completed = new Map<string, any>();
    // The changes list of each file change item that Codex described, by item digest, at most KEPT_FILE_CHANGES of them, and the
    // refusal of each file change request that waits, by its item's digest.
    const fileChanges = new Map<string, unknown[]>();
    const waitingChanges = new Map<string, WaitingAsk>();
    // Each approval request that waits, by its JSON-RPC id, so that serverRequest/resolved withdraws it.
    const waitingApprovals = new Map<string, WaitingAsk>();
    const requestKey = (id: unknown) => `${typeof id}:${String(id)}`;
    // A notification that lists no change list describes no change, so a request for its item can only be refused.
    const described = (itemId: unknown, changes: unknown) => {
      if (typeof itemId !== "string" || !itemId) return;
      const key = digestKey(itemId);
      fileChanges.delete(key);
      fileChanges.set(key, Array.isArray(changes) ? changes : []);
      if (fileChanges.size > KEPT_FILE_CHANGES) fileChanges.delete(fileChanges.keys().next().value!);
    };
    let nextId = 1;
    let threadId: string | null = null;
    let turnRequested = false;
    let turnDone = false;
    let stopAsked = false;
    let interruptSent = false;
    // The last reply of each turn whose agent messages arrived before the turn/start answer named the run's turn, by turn digest,
    // at most KEPT_EARLY_COMPLETIONS of them.
    const earlyReplies = new Map<string, string | null>();
    const request = (method: string, params: unknown) => {
      const id = nextId++;
      pending.set(id, method);
      write({ jsonrpc: "2.0", id, method, params });
    };
    const turnEnded = (turn: any) => {
      turnDone = true;
      if (turn?.status === "failed") facts.hostError = hostError(text(turn.error?.message));
      close();
    };
    // The interrupt goes out once turn/start has named the run's turn and only while that turn has not completed.
    const sendInterrupt = () => {
      if (interruptSent || turnDone || facts.turnId === null) return;
      interruptSent = true;
      const { method, params } = codexInterruptRequest({ threadId, turnId: facts.turnId });
      request(method, params);
    };
    const answered = (method: string, result: any) => {
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
        if (earlyReplies.has(digestKey(id))) facts.lastMessage = earlyReplies.get(digestKey(id)) ?? null;
        earlyReplies.clear();
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
      event(message: any) {
        const hasId = typeof message.id === "string" || typeof message.id === "number";
        if (hasId && typeof message.method === "string") {
          const itemId = message.method === "item/fileChange/requestApproval" && typeof message.params?.itemId === "string" && message.params.itemId ? message.params.itemId : null;
          const approval = codexApproval(message.method, message.params, itemId === null ? undefined : fileChanges.get(digestKey(itemId)));
          if (approval) {
            const { id } = message;
            let waiting: WaitingAsk | null = null;
            let answered = false;
            const forget = () => {
              if (waiting === null) return;
              if (itemId !== null && waitingChanges.get(digestKey(itemId)) === waiting) waitingChanges.delete(digestKey(itemId));
              if (waitingApprovals.get(requestKey(id)) === waiting) waitingApprovals.delete(requestKey(id));
            };
            waiting = ask(approval.ask, (decision) => {
              answered = true;
              forget();
              return { jsonrpc: "2.0", id, result: approval.answer(decision) };
            });
            if (waiting !== null && !answered) {
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
          // The host answered the interrupt, with a result or an error, so the input closes and the app-server exits by itself.
          if (method === "turn/interrupt") {
            close();
            return;
          }
          if (message.error !== undefined && message.error !== null) {
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
          // A changed patch changes what an allow of its waiting request would cover, so that request is declined and withdrawn.
          if (typeof params.itemId === "string" && params.itemId) waitingChanges.get(digestKey(params.itemId))?.respond("refuse");
          return;
        }
        if (message.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
          // Codex settled the request itself, so it is withdrawn and answered nothing.
          waitingApprovals.get(requestKey(params.requestId))?.dismiss();
          return;
        }
        if (message.method === "item/completed" && params.item?.type === "agentMessage" && typeof params.turnId === "string" && !turnDone) {
          // Only a reply of the run's turn counts; one that arrives before the turn/start answer waits for it.
          if (facts.turnId === null) {
            const key = digestKey(params.turnId);
            earlyReplies.delete(key);
            earlyReplies.set(key, typeof params.item.text === "string" ? replyText(params.item.text) : null);
            if (earlyReplies.size > KEPT_EARLY_COMPLETIONS) earlyReplies.delete(earlyReplies.keys().next().value!);
          } else if (params.turnId === facts.turnId && typeof params.item.text === "string") facts.lastMessage = replyText(params.item.text);
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
          // A completion that arrives before the turn/start answer is kept, as its status and cut error text, until the answer
          // names the run's turn; only the KEPT_EARLY_COMPLETIONS most recent ones are kept, the oldest going first.
          if (facts.turnId === null) {
            const { status, error } = params.turn;
            const kept = status === "failed" ? { status, error: { message: hostError(text(error?.message)) } } : {};
            const key = digestKey(params.turn.id);
            completed.delete(key);
            completed.set(key, kept);
            if (completed.size > KEPT_EARLY_COMPLETIONS) completed.delete(completed.keys().next().value!);
          }
          else if (params.turn.id === facts.turnId) turnEnded(params.turn);
        }
      }
    };
  }

  const splitter = lineSplitter((line: string) => {
    const event = parseObject(line);
    if (event) handle.event(event);
  });
  return {
    facts,
    get inputOpen() { return inputOpen; },
    /** Writes the run's opening message: the prompt, or Codex's initialize request. */
    start: () => handle.start(),
    push: (chunk: Buffer) => splitter.push(chunk),
    end: () => splitter.end(),
    /** Writes one more message to the host while its input is open, such as a stop's interrupt; answers whether it was written. */
    send: (message: unknown) => { if (!inputOpen) return false; send(message); return true; },
    closeInput: close,
    /** Sends the host's interrupt for a stop; a run whose input is already closed gets none. */
    interrupt: () => {
      if (!inputOpen) return;
      refuseAsks();
      handle.interrupt();
    }
  };
}
