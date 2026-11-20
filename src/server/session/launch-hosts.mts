import { createHash, randomUUID } from "node:crypto";
import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isAgentModel } from "./agent-models.mjs";

// The hosts that a launched session runs, the commands Prism runs for them, and the readers of their output streams.
// Nothing here takes a value from the review page except the initiative identifier or the format migration run's id, checked by the caller, the host, and the
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
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CODEX_THREAD_ID"
]);

const CLAUDE_FLAGS = Object.freeze(["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "none"]);
// The permission policy of every Codex thread that Prism starts or resumes: the host's automatic review decides, and Prism grants nothing.
const CODEX_POLICY = Object.freeze({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
// A launch's access: "full" for an initiative's orchestration, and "read-only" for a format migration run, whose session reads artifact text that others wrote,
// works in an empty folder of its own outside the checkout, and reads nothing of the checkout: it gets the run's sources, the project's paths, and the sources'
// Git history through the run's own Prism tools. A read-only Claude Code run has only Read, Grep, and Glob, allows only the run's Prism tools and no shell,
// reads only in its working folder and the added folders without asking, and denies every other call, since nothing asks; a read-only Codex thread runs in the
// read-only sandbox, readable only in those folders and the platform's own, and never asks to run a command outside it.
// Prism's server, which the session starts with PRISM_MIGRATION_RUN naming the run and PRISM_MIGRATION_PROJECT naming the checkout,
// lists and takes only the run's tools for that run's project and artifacts.
export const LAUNCH_ACCESS = Object.freeze(["full", "read-only"]);
/** The variable that scopes the Prism server a migration run's session starts to that run. */
export const MIGRATION_SCOPE_VARIABLE = "PRISM_MIGRATION_RUN";
/** The variable that names that server's project, the checkout's real path, since the session works outside it. */
export const MIGRATION_PROJECT_VARIABLE = "PRISM_MIGRATION_PROJECT";
/** The Prism tools that a format migration run's session calls, and the only ones its Prism server lists and takes. */
export const MIGRATION_RUN_TOOLS = Object.freeze(["get_migration_run", "get_artifact", "propose_migration", "finish_migration_run", "fail_migration_run"]);
const PRISM_TOOL_PREFIX = "mcp__plugin_prism_prism-review__";
const CLAUDE_READ_ONLY_TOOLS = MIGRATION_RUN_TOOLS.map((tool) => `${PRISM_TOOL_PREFIX}${tool}`).join(",");
const claudeReadOnly = (readRoots: string[]) => ["--input-format", "stream-json", "--output-format", "stream-json", "--tools", "Read,Grep,Glob", "--allowedTools", CLAUDE_READ_ONLY_TOOLS,
  ...(readRoots.length ? ["--add-dir", ...readRoots] : []), "--permission-mode", "dontAsk", "--permission-prompts", "none"];
const CODEX_READ_ONLY = Object.freeze({ approvalPolicy: "never", sandbox: "read-only" });
/** The sandbox of a read-only Codex turn: reads only in the run's working folder, the given folders, and the platform's own. */
const codexReadOnlySandbox = (folder: string, readRoots: string[]) => ({ type: "readOnly", access: { type: "restricted", includePlatformDefaults: true, readableRoots: [folder, ...readRoots] } });
const rootsOf = (readRoots: unknown): string[] => (Array.isArray(readRoots) ? readRoots.filter((root) => typeof root === "string" && path.isAbsolute(root)) : []);
const readOnly = (access: unknown) => access === "read-only";
const CODEX_CLIENT = Object.freeze({ clientInfo: { name: "prism-launch", version: "1" }, capabilities: { experimentalApi: true } });
// The answer to every request that a Codex app-server sends Prism, such as an approval or a question.
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
export const TRACKED_TASKS = 1000;
export const HOST_ERROR_FALLBACK = "The turn failed without a message.";
// A host session id that may reach a command line: letters, digits, `_`, and `-`, never first, so no host reads it as an option and no shell splits it.
export const HOST_SESSION_ID_PATTERN = /^[0-9A-Za-z_][0-9A-Za-z_-]*$/;
export const SESSION_ID_PLACEHOLDER = "<host session id>";

export function validHostSessionId(value: unknown): value is string {
  return typeof value === "string" && HOST_SESSION_ID_PATTERN.test(value);
}

/** The text with every occurrence of the host session id, in any letter case, replaced by a placeholder; the pattern keeps the id free of regular expression syntax. */
export function redactSessionId<T>(text: T, hostSessionId: unknown): T {
  if (typeof text !== "string" || !validHostSessionId(hostSessionId)) return text;
  return text.replace(new RegExp(hostSessionId, "gi"), SESSION_ID_PLACEHOLDER) as T;
}

export function hostDefinition(host: string) {
  return HOSTS.find((definition) => definition.host === host) ?? null;
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
  const definition = hostDefinition(host);
  if (!definition) return null;
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

/** One entry per host in order: { host, label, available, executable, reason }. */
export async function hostAvailability({ env = process.env } = {}) {
  return Promise.all(HOSTS.map(async ({ host }) => {
    const { label, available, executable, reason } = (await resolveHost(host, env))!;
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
 * coordinator's choice, each left out for the host default, or Codex's app server, which takes the choice in its requests.
 * A read-only run, a format migration run's, takes only the reading tools and the run's own Prism tools, and reads in readRoots too.
 */
export function hostArguments({ host, hostSessionId, resume, coordinator = null, access = "full", readRoots = [] }: { host: string; hostSessionId: unknown; resume?: boolean; coordinator?: unknown; access?: string; readRoots?: string[] }) {
  if (host === "claude-code") {
    if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
    const { model, effort } = coordinatorOf(coordinator);
    return ["-p", "--verbose", resume ? "--resume" : "--session-id", hostSessionId, ...(readOnly(access) ? claudeReadOnly(rootsOf(readRoots)) : CLAUDE_FLAGS), ...(model === null ? [] : ["--model", model]), ...(effort === null ? [] : ["--effort", effort])];
  }
  if (host === "codex") return ["app-server"];
  throw new Error(`Unknown host ${host}.`);
}

/**
 * The skill invocation that a run's prompt holds, without its host's prefix: `prism:migrate-artifact <run id>` for a format migration run,
 * and `prism:orchestrate <initiative>` otherwise. Nothing else reaches a prompt.
 */
export function runInvocation({ initiative = null, migrationRun = null }: { initiative?: string | null; migrationRun?: string | null }) {
  return typeof migrationRun === "string" && migrationRun ? `prism:migrate-artifact ${migrationRun}` : `prism:orchestrate ${initiative}`;
}

/** The stream-json user message that gives a Claude Code run its prompt, for an initiative or for { initiative, migrationRun } as runInvocation takes it. */
export function claudePrompt(subject: string | { initiative?: string | null; migrationRun?: string | null } | null) {
  const invocation = subject !== null && typeof subject === "object" ? runInvocation(subject) : runInvocation({ initiative: subject });
  return { type: "user", message: { role: "user", content: `/${invocation}` } };
}

/**
 * The Codex request that opens the run's thread: thread/start for a launch, thread/resume with the kept thread id for a resume,
 * each with the model and provider of the coordinator's choice, left out for the host default.
 */
export function codexThreadRequest({ checkout, hostSessionId, resume, coordinator = null, access = "full" }: { checkout: string; hostSessionId: unknown; resume?: boolean; coordinator?: unknown; access?: string }) {
  const { model, provider } = coordinatorOf(coordinator);
  const chosen = { ...(model === null ? {} : { model }), ...(provider === null ? {} : { modelProvider: provider }) };
  const policy = readOnly(access) ? CODEX_READ_ONLY : CODEX_POLICY;
  if (!resume) return { method: "thread/start", params: { cwd: checkout, ...policy, ...chosen } };
  if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
  return { method: "thread/resume", params: { threadId: hostSessionId, cwd: checkout, ...policy, ...chosen } };
}

/**
 * The Codex request that starts the run's one turn: the initiative's orchestrate, or the format migration run's migrate-artifact,
 * whose read-only turn reads only in its working folder, the given folders, and the platform's own, with the effort of the coordinator's
 * choice, left out for the host default.
 */
export function codexTurnRequest({ threadId, initiative = null, migrationRun = null, coordinator = null, access = "full", checkout = null, readRoots = [] }: { threadId: string; initiative?: string | null; migrationRun?: string | null; coordinator?: unknown; access?: string; checkout?: string | null; readRoots?: string[] }) {
  const { effort } = coordinatorOf(coordinator);
  const sandbox = readOnly(access) && typeof checkout === "string" ? { sandboxPolicy: codexReadOnlySandbox(checkout, rootsOf(readRoots)) } : {};
  return { method: "turn/start", params: { threadId, input: [{ type: "text", text: `$${runInvocation({ initiative, migrationRun })}` }], ...(effort === null ? {} : { effort }), ...sandbox } };
}

/** The stream-json line that Claude Code's own Stop button sends: an interrupt control request with a request id that Prism chooses. */
export function claudeInterrupt(requestId: string) {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}

/** The Codex request that interrupts the run's turn, as the app's own Stop button does. */
export function codexInterruptRequest({ threadId, turnId }: { threadId: string | null; turnId: string }) {
  return { method: "turn/interrupt", params: { threadId, turnId } };
}

/** The command that continues a host session in a terminal, or null for an id that breaks HOST_SESSION_ID_PATTERN. */
export function resumeCommandOf(host: string, hostSessionId: unknown) {
  if (!validHostSessionId(hostSessionId)) return null;
  return host === "claude-code" ? `claude --resume ${hostSessionId}` : `codex resume ${hostSessionId}`;
}

/** The starter's environment without the host session variables, as a launched run and a read of run options see it. */
export function strippedEnvironment(env: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of [...STRIPPED_VARIABLES, MIGRATION_SCOPE_VARIABLE, MIGRATION_PROJECT_VARIABLE]) delete result[name];
  return result;
}

/**
 * The environment of a run: the starter's own, without the host session variables, with PRISM_LAUNCH naming the launch,
 * and only for a format migration run's launch with PRISM_MIGRATION_RUN naming the run and PRISM_MIGRATION_PROJECT its checkout.
 */
export function hostEnvironment(env: NodeJS.ProcessEnv, launchId: string, migrationRun: string | null = null, project: string | null = null) {
  const scoped = typeof migrationRun === "string" && migrationRun ? { [MIGRATION_SCOPE_VARIABLE]: migrationRun, ...(typeof project === "string" && project ? { [MIGRATION_PROJECT_VARIABLE]: project } : {}) } : {};
  return { ...strippedEnvironment(env), PRISM_LAUNCH: launchId, ...scoped };
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
export interface HostFacts { hostSessionId: string | null; turnId: string | null; model: string | null; refusals: HostRefusal[]; refusalCount: number; hostError: string | null }
export interface HostConversationOptions {
  initiative?: string | null;
  migrationRun?: string | null;
  access?: string;
  readRoots?: string[];
  checkout: string;
  hostSessionId?: string | null;
  resume?: boolean;
  coordinator?: unknown;
  send: (message: unknown) => void;
  closeInput: () => void;
  onSessionId?: (id: string) => void;
  onModel?: (model: string) => void;
}

export function hostConversation(host: string, { initiative = null, migrationRun = null, access = "full", readRoots = [], checkout, hostSessionId = null, resume = false, coordinator = null, send, closeInput, onSessionId = () => {}, onModel = () => {} }: HostConversationOptions) {
  const facts: HostFacts = { hostSessionId: null, turnId: null, model: null, refusals: [], refusalCount: 0, hostError: null };
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
  const redact = (value: string) => redactSessionId(redactSessionId(value, hostSessionId), facts.hostSessionId);
  // The id is replaced before the text is cut, so no cut leaves part of it behind.
  const cut = (value: string) => detached(redact(value).slice(0, REFUSAL_REASON_MAX));
  const hostError = (value: string) => cut(value || HOST_ERROR_FALLBACK);
  const toolName = (value: unknown, fallback: string) => (typeof value === "string" && value ? detached(redact(value).slice(0, TOOL_NAME_MAX)) : fallback);
  const write = (message: unknown) => {
    if (inputOpen) send(message);
  };
  const close = () => {
    if (!inputOpen) return;
    inputOpen = false;
    closeInput();
  };
  const handle = host === "claude-code" ? claudeHandler() : codexHandler();

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
    return {
      start: () => write(claudePrompt({ initiative, migrationRun })),
      interrupt() {
        if (interruptId !== null) return;
        interruptId = randomUUID();
        write(claudeInterrupt(interruptId));
      },
      event(event: any) {
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
    let nextId = 1;
    let threadId: string | null = null;
    let turnRequested = false;
    let turnDone = false;
    let stopAsked = false;
    let interruptSent = false;
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
        const { method: open, params } = codexThreadRequest({ checkout, hostSessionId, resume, coordinator, access });
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
        const { method: turn, params } = codexTurnRequest({ threadId, initiative, migrationRun, coordinator, access, checkout, readRoots });
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
      event(message: any) {
        const hasId = typeof message.id === "string" || typeof message.id === "number";
        if (hasId && typeof message.method === "string") {
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
    interrupt: () => { if (inputOpen) handle.interrupt(); }
  };
}
