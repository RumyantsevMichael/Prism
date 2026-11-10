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

const CLAUDE_FLAGS = Object.freeze(["--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--permission-prompts", "none"]);
const CODEX_POLICY = Object.freeze(["-c", "approval_policy=\"on-request\"", "-c", "approvals_reviewer=\"auto_review\"", "-c", "sandbox_mode=\"workspace-write\""]);
export const MAX_LINE_BYTES = 1024 * 1024;
const REFUSAL_REASON_MAX = 500;

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

/** The arguments of a run: the launch form for the first run, and the resume form with the host session id after it. */
export function hostArguments({ host, initiative, hostSessionId, resume }) {
  if (host === "claude-code") return ["-p", `/prism:orchestrate ${initiative}`, resume ? "--resume" : "--session-id", hostSessionId, ...CLAUDE_FLAGS];
  if (host === "codex") {
    return resume
      ? ["exec", "resume", "--json", ...CODEX_POLICY, hostSessionId, `$prism:orchestrate ${initiative}`]
      : ["exec", "--json", ...CODEX_POLICY, `$prism:orchestrate ${initiative}`];
  }
  throw new Error(`Unknown host ${host}.`);
}

/** The command that continues a host session in a terminal. */
export function resumeCommandOf(host, hostSessionId) {
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

/**
 * A reader of one run's standard output that collects { hostSessionId, refusals, hostError }.
 * onSessionId is called once when a Codex run names its thread.
 */
export function streamReader(host, { onSessionId = () => {} } = {}) {
  const facts = { hostSessionId: null, refusals: [], hostError: null };
  const toolResults = new Map();
  const handle = (event) => {
    if (host === "claude-code") {
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") toolResults.set(block.tool_use_id, blockText(block.content));
        }
      }
      if (event.type === "result") {
        const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
        facts.refusals = denials.filter((denial) => denial && typeof denial === "object").map((denial) => {
          const tool = typeof denial.tool_name === "string" && denial.tool_name ? denial.tool_name : "a tool";
          const text = toolResults.get(denial.tool_use_id)?.trim();
          return { tool, reason: text ? text.slice(0, REFUSAL_REASON_MAX) : `${tool} was refused.` };
        });
        facts.hostError = event.is_error === true ? String(typeof event.result === "string" ? event.result : "") : null;
      }
      return;
    }
    if (event.type === "thread.started" && facts.hostSessionId === null && typeof event.thread_id === "string" && event.thread_id) {
      facts.hostSessionId = event.thread_id;
      onSessionId(event.thread_id);
    }
    if (event.type === "item.completed" && event.item?.status === "declined") {
      const tool = typeof event.item.type === "string" && event.item.type ? event.item.type : "an action";
      const command = typeof event.item.command === "string" && event.item.command ? event.item.command : tool;
      facts.refusals.push({ tool, reason: `Codex declined: ${command}` });
    }
    if (event.type === "turn.failed") facts.hostError = String(event.error?.message ?? "");
  };
  const splitter = lineSplitter((line) => {
    const event = parseObject(line);
    if (event) handle(event);
  });
  return { facts, push: (chunk) => splitter.push(chunk), end: () => splitter.end() };
}
