import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";

// The hosts that a launched session runs, the commands Prism runs for them, and the readers of their output streams.
// Nothing here takes a value from the review page except the initiative identifier, checked by the caller, and the host.

export const HOSTS = Object.freeze([
  Object.freeze({ host: "claude-code", label: "Claude Code", executable: "claude" }),
  Object.freeze({ host: "codex", label: "Codex", executable: "codex" })
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
const CODEX_CLIENT = Object.freeze({ clientInfo: { name: "prism-launch", version: "1" }, capabilities: { experimentalApi: true } });
// The answer to every request that a Codex app-server sends Prism, such as an approval or a question.
export const HOST_REQUEST_REFUSAL = Object.freeze({ code: -32601, message: "Prism answers no host requests." });
export const MAX_LINE_BYTES = 1024 * 1024;
const REFUSAL_REASON_MAX = 500;
// A host session id that may reach a command line: letters, digits, `_`, and `-`, never first, so no host reads it as an option and no shell splits it.
export const HOST_SESSION_ID_PATTERN = /^[0-9A-Za-z_][0-9A-Za-z_-]*$/;
export const SESSION_ID_PLACEHOLDER = "<host session id>";

export function validHostSessionId(value) {
  return typeof value === "string" && HOST_SESSION_ID_PATTERN.test(value);
}

/** The text with every occurrence of the host session id, in any letter case, replaced by a placeholder; the pattern keeps the id free of regular expression syntax. */
export function redactSessionId(text, hostSessionId) {
  if (typeof text !== "string" || !validHostSessionId(hostSessionId)) return text;
  return text.replace(new RegExp(hostSessionId, "gi"), SESSION_ID_PLACEHOLDER);
}

export function hostDefinition(host) {
  return HOSTS.find((definition) => definition.host === host) ?? null;
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

// npm's command shims run Node with a script beside the shim, named as "%dp0%\<relative script>".
async function npmShimScript(file) {
  let text;
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
export async function resolveHost(host, env = process.env) {
  const definition = hostDefinition(host);
  if (!definition) return null;
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
    const { label, available, executable, reason } = await resolveHost(host, env);
    return { host, label, available, executable, reason };
  }));
}

/** The arguments of a run: Claude Code's launch or resume form with its session id, or Codex's app server. */
export function hostArguments({ host, hostSessionId, resume }) {
  if (host === "claude-code") {
    if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
    return ["-p", "--verbose", resume ? "--resume" : "--session-id", hostSessionId, ...CLAUDE_FLAGS];
  }
  if (host === "codex") return ["app-server"];
  throw new Error(`Unknown host ${host}.`);
}

/** The stream-json user message that gives a Claude Code run its prompt. */
export function claudePrompt(initiative) {
  return { type: "user", message: { role: "user", content: `/prism:orchestrate ${initiative}` } };
}

/** The Codex request that opens the run's thread: thread/start for a launch, thread/resume with the kept thread id for a resume. */
export function codexThreadRequest({ checkout, hostSessionId, resume }) {
  if (!resume) return { method: "thread/start", params: { cwd: checkout, ...CODEX_POLICY } };
  if (!validHostSessionId(hostSessionId)) throw new Error("The host session id is not one Prism can pass to a host.");
  return { method: "thread/resume", params: { threadId: hostSessionId, cwd: checkout, ...CODEX_POLICY } };
}

/** The Codex request that starts the run's one orchestrate turn. */
export function codexTurnRequest({ threadId, initiative }) {
  return { method: "turn/start", params: { threadId, input: [{ type: "text", text: `$prism:orchestrate ${initiative}` }] } };
}

/** The command that continues a host session in a terminal, or null for an id that breaks HOST_SESSION_ID_PATTERN. */
export function resumeCommandOf(host, hostSessionId) {
  if (!validHostSessionId(hostSessionId)) return null;
  return host === "claude-code" ? `claude --resume ${hostSessionId}` : `codex resume ${hostSessionId}`;
}

/** The environment of a run: the starter's own, without the host session variables, and with PRISM_LAUNCH naming the launch. */
export function hostEnvironment(env, launchId) {
  const result = { ...env };
  for (const name of STRIPPED_VARIABLES) delete result[name];
  result.PRISM_LAUNCH = launchId;
  return result;
}

/** Splits a byte stream into lines, dropping every line longer than MAX_LINE_BYTES. */
export function lineSplitter(onLine) {
  let pending = [];
  let pendingBytes = 0;
  let discarding = false;
  const emit = (buffer) => {
    if (!discarding && buffer.length <= MAX_LINE_BYTES) onLine(buffer.toString("utf8").replace(/\r$/, ""));
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
        if (pendingBytes > MAX_LINE_BYTES) {
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
  if (Array.isArray(content)) return content.map((block) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "")).join("");
  return "";
}


const text = (value) => (typeof value === "string" ? value : "");

/**
 * One run's conversation with its host over the host's standard input and output.
 * `send(message)` writes one JSON line to the host's input and `closeInput()` ends that input; the conversation calls neither
 * after it closed the input, and closes it once the host's work is over, so the host exits by itself.
 * `facts` collects { hostSessionId, turnId, refusals, hostError }: host text in them has the host session id, the known one or the
 * one the run names, replaced. onSessionId is called once when a Codex launch names its thread with an id that is safe to keep.
 */
export function hostConversation(host, { initiative, checkout, hostSessionId = null, resume = false, send, closeInput, onSessionId = () => {} }) {
  const facts = { hostSessionId: null, turnId: null, refusals: [], hostError: null };
  let inputOpen = true;
  const redact = (value) => redactSessionId(redactSessionId(value, hostSessionId), facts.hostSessionId);
  const write = (message) => {
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
  function claudeHandler() {
    const toolResults = new Map();
    const tasks = new Set();
    return {
      start: () => write(claudePrompt(initiative)),
      event(event) {
        if (event.type === "system" && typeof event.task_id === "string") {
          if (event.subtype === "task_started") tasks.add(event.task_id);
          if (event.subtype === "task_notification") tasks.delete(event.task_id);
          return;
        }
        if (event.type === "user" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type === "tool_result" && typeof block.tool_use_id === "string") toolResults.set(block.tool_use_id, blockText(block.content));
          }
          return;
        }
        if (event.type !== "result") return;
        // The last result event decides the run's refusals and host error.
        const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
        facts.refusals = denials.filter((denial) => denial && typeof denial === "object").map((denial) => {
          const tool = typeof denial.tool_name === "string" && denial.tool_name ? denial.tool_name : "a tool";
          const reason = toolResults.get(denial.tool_use_id)?.trim();
          return { tool, reason: reason ? redact(reason).slice(0, REFUSAL_REASON_MAX) : `${tool} was refused.` };
        });
        facts.hostError = event.is_error === true ? redact(text(event.result)) : null;
        if (tasks.size === 0) close();
      }
    };
  }

  // Codex: JSON-RPC 2.0 with `codex app-server`, through initialize, the thread start or resume, and one turn; every request
  // that the host sends is answered with HOST_REQUEST_REFUSAL, and the input closes when the run's turn completes or the host
  // answers one of Prism's requests with an error.
  function codexHandler() {
    const pending = new Map();
    const completed = new Map();
    let nextId = 1;
    let threadId = null;
    const request = (method, params) => {
      const id = nextId++;
      pending.set(id, method);
      write({ jsonrpc: "2.0", id, method, params });
    };
    const turnEnded = (turn) => {
      if (turn?.status === "failed") facts.hostError = redact(text(turn.error?.message));
      close();
    };
    const answered = (method, result) => {
      if (method === "initialize") {
        write({ jsonrpc: "2.0", method: "initialized", params: {} });
        const { method: open, params } = codexThreadRequest({ checkout, hostSessionId, resume });
        request(open, params);
        return;
      }
      if (method === "thread/start" || method === "thread/resume") {
        const named = result?.thread?.id;
        if (method === "thread/start" && validHostSessionId(named)) {
          facts.hostSessionId = named;
          onSessionId(named);
        }
        threadId = method === "thread/resume" ? hostSessionId : typeof named === "string" && named ? named : null;
        if (!threadId) {
          close();
          return;
        }
        const { method: turn, params } = codexTurnRequest({ threadId, initiative });
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
        if (completed.has(id)) turnEnded(completed.get(id));
      }
    };
    return {
      start: () => request("initialize", CODEX_CLIENT),
      event(message) {
        const hasId = typeof message.id === "string" || typeof message.id === "number";
        if (hasId && typeof message.method === "string") {
          write({ jsonrpc: "2.0", id: message.id, error: { ...HOST_REQUEST_REFUSAL } });
          return;
        }
        if (hasId) {
          const method = pending.get(message.id);
          if (!method) return;
          pending.delete(message.id);
          if (message.error !== undefined && message.error !== null) {
            facts.hostError = redact(text(message.error?.message));
            close();
            return;
          }
          answered(method, message.result);
          return;
        }
        const params = message.params ?? {};
        if (message.method === "item/completed" && params.item?.status === "declined") {
          const tool = typeof params.item.type === "string" && params.item.type ? params.item.type : "an action";
          const command = typeof params.item.command === "string" && params.item.command ? params.item.command : tool;
          facts.refusals.push({ tool, reason: redact(`Codex declined: ${command}`) });
          return;
        }
        if (message.method === "turn/completed" && typeof params.turn?.id === "string") {
          // A completion that arrives before the turn/start answer is kept until the answer names the run's turn.
          if (facts.turnId === null) completed.set(params.turn.id, params.turn);
          else if (params.turn.id === facts.turnId) turnEnded(params.turn);
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
    get inputOpen() { return inputOpen; },
    /** Writes the run's opening message: the prompt, or Codex's initialize request. */
    start: () => handle.start(),
    push: (chunk) => splitter.push(chunk),
    end: () => splitter.end(),
    /** Writes one more message to the host while its input is open, such as a stop's interrupt; answers whether it was written. */
    send: (message) => { if (!inputOpen) return false; send(message); return true; },
    closeInput: close
  };
}
