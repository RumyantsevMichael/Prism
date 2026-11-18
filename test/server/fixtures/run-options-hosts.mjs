// Stub hosts that report run options, for the run configuration tests.
// The stubs replace the launched-session stubs in launchFixture's folder of executables and log in the same form, so the fixture's
// helpers, cleanup, and native confirmation stub keep working: one { kind: "run" } entry per process with its argv, one
// { kind: "input" } entry per message it read, and { kind: "closed" } when its standard input closed.
// A claude stub started with --no-session-persistence is an options read: it answers Claude Code's initialize control request with
// the models of the catalog and never starts a turn; started otherwise it is a launch or a resume, which starts one short turn on its
// first user message and exits when its input closes. A codex stub runs as `codex app-server` and answers initialize, the provider and
// model lists of the catalog, one model per page, thread/start, thread/resume, and turn/start, whose turn completes after 100 ms.
// The catalog file decides what each host reports, and a test can change it between reads.
import { chmodSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchFixture } from "./launched-sessions.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./review-actions.mjs";

export { INITIATIVE } from "./review-actions.mjs";
export { actionOf, apply, get, listing };

const level = (levels) => levels;

// What Claude Code 2.1.327 reported in this container, trimmed: its own default entry first, the aliases, pinned models, one model
// without effort, and the fields of the initialize answer that are no run option of Prism's.
export const CLAUDE_CATALOG = Object.freeze({
  models: [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "xhigh", "max"]) },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "xhigh", "max"]) },
    { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "Most capable for your hardest and longest-running tasks", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "xhigh", "max"]) },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "xhigh", "max"]) },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest for quick answers", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "xhigh", "max"]) },
    { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Earlier version", supportsEffort: true, supportedEffortLevels: level(["low", "medium", "high", "max"]) },
    { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers", supportsThinkingOff: true },
    { value: "--dangerous", displayName: "Not a model name", description: "A value no command line may take." }
  ],
  account: { subscriptionType: "Claude API", apiProvider: "firstParty" },
  current_permission_mode: "auto",
  fast_mode_state: "off",
  available_output_styles: ["default", "Concise"],
  agents: [{ name: "Explore", description: "Fast read-only search agent." }]
});

// What the Codex app server's model/list and modelProvider/list answer, by the schema on openai/codex main: two providers, the
// default one with three models, one of them hidden, and a local provider that lists none.
export const CODEX_CATALOG = Object.freeze({
  providers: { data: [{ id: "openai", name: "OpenAI", canEdit: false, baseUrl: null, settings: {} }, { id: "local", name: "Local server", canEdit: true, baseUrl: null, settings: {} }], defaultProviderId: "openai", canChangeDefault: true },
  models: {
    openai: [
      { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier coding model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast responses" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deeper reasoning" }, { reasoningEffort: "xhigh", description: "Deepest reasoning" }] },
      { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", description: "Newest model", hidden: false, isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Most reasoning" }, { reasoningEffort: "low", description: "Fast responses" }, { reasoningEffort: "minimal", description: "Least reasoning" }, { reasoningEffort: "high", description: "Deeper reasoning" }] },
      { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", description: "Hidden from pickers", hidden: true, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] }
    ],
    local: []
  }
});

export const DEFAULT_CATALOG = Object.freeze({ claude: CLAUDE_CATALOG, codex: CODEX_CATALOG });

// One stub serves both hosts; its file name says which host it is. catalog.<host>.fail makes an options read fail: the claude stub
// answers initialize with an error of that text, and the codex stub answers initialize with it. catalog.<host>.hang makes the
// options read never answer. catalog.codex.modelListError answers model/list with that error.
const STUB = String.raw`#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const path = require("node:path");
const host = path.basename(process.argv[1]).startsWith("codex") ? "codex" : "claude";
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.PRISM_STUB_LOG, JSON.stringify({ host, pid: process.pid, ...entry }) + "\n");
let catalog = {};
try { catalog = JSON.parse(readFileSync(process.env.PRISM_STUB_CATALOG, "utf8"))[host] ?? {}; } catch {}
const env = Object.fromEntries(["PRISM_LAUNCH", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PLUGIN_ROOT", "CODEX_THREAD_ID"].map((name) => [name, process.env[name] ?? null]));
log({ kind: "run", argv, cwd: process.cwd(), env, children: [] });
const write = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const valueAfter = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
let results = 0;
let onMessage = () => {};
if (host === "codex" && argv[0] !== "app-server") { process.stderr.write("error: this stub runs only as codex app-server\n"); process.exit(2); }
if (host === "claude") {
  const optionsRead = argv.includes("--no-session-persistence");
  const id = valueAfter("--session-id") ?? valueAfter("--resume");
  let started = false;
  onMessage = (message) => {
    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      if (catalog.hang) return;
      if (catalog.fail) { write({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: catalog.fail } }); return; }
      const { models = [], account = null, ...rest } = catalog;
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models, account, pid: process.pid, claude_code_version: "2.1.327", ...rest } } });
      return;
    }
    if (message.type === "user" && !optionsRead && !started) {
      started = true;
      setTimeout(() => {
        write({ type: "system", subtype: "init", session_id: id, model: valueAfter("--model") ?? "claude-opus-5-5" });
        results += 1;
        write({ type: "result", subtype: "success", is_error: false, result: "done", session_id: id, permission_denials: [] });
      }, 100);
    }
  };
}
if (host === "codex") {
  let threadId = null;
  let turns = 0;
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const refuse = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32600, message } });
  onMessage = (message) => {
    if (message.method === undefined) return;
    if (message.method === "initialize") {
      if (catalog.hang) return;
      if (catalog.fail) { refuse(message.id, catalog.fail); return; }
      respond(message.id, { userAgent: "codex-stub/0" });
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "modelProvider/list") { respond(message.id, catalog.providers ?? { data: [], defaultProviderId: "openai", canChangeDefault: false }); return; }
    if (message.method === "model/list") {
      if (catalog.modelListError) { refuse(message.id, catalog.modelListError); return; }
      const provider = message.params?.modelProvider ?? catalog.providers?.defaultProviderId ?? "openai";
      const all = (catalog.models ?? {})[provider];
      if (!all) { refuse(message.id, "Unknown model provider " + provider + "."); return; }
      const visible = message.params?.includeHidden ? all : all.filter((model) => !model.hidden);
      const start = Number(message.params?.cursor ?? 0);
      const page = visible.slice(start, start + 1);
      respond(message.id, { data: page, nextCursor: start + 1 < visible.length ? String(start + 1) : null });
      return;
    }
    if (message.method === "thread/start") { threadId = "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4"; respond(message.id, { thread: { id: threadId }, model: message.params?.model ?? "gpt-5.5" }); return; }
    if (message.method === "thread/resume") { threadId = message.params?.threadId ?? null; respond(message.id, { thread: { id: threadId }, model: message.params?.model ?? "gpt-5.5" }); return; }
    if (message.method === "turn/start") {
      turns += 1;
      const turnId = "turn-" + turns;
      respond(message.id, { turn: { id: turnId, status: "inProgress", items: [], error: null } });
      setTimeout(() => { results += 1; write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } }); }, 100);
      return;
    }
    if (message.id !== undefined) refuse(message.id, "Unknown method " + message.method + ".");
  };
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    log({ kind: "input", message });
    onMessage(message);
  }
});
process.stdin.on("end", () => {
  log({ kind: "closed", results, interrupted: false });
  setTimeout(() => process.exit(0), 20);
});
process.stdin.on("error", () => {});
`;

/**
 * launchFixture's project, private review app folder, controlled PATH, and native confirmation stub, with stub hosts that report
 * the catalog; hosts lists the stubs on PATH, so a host left out is not found.
 * optionReads(host) lists the runs that read run options, and launchRuns(host) every other run.
 */
export async function runOptionsFixture(context, { hosts = ["claude", "codex"], catalog = DEFAULT_CATALOG, dialog = { code: 0 } } = {}) {
  const fixture = await launchFixture(context, { hosts, dialog });
  for (const name of hosts) {
    const file = path.join(fixture.bin, name);
    await writeFile(file, STUB);
    chmodSync(file, 0o755);
  }
  const catalogFile = path.join(path.dirname(fixture.log), "stub-catalog.json");
  const setCatalog = (value) => writeFile(catalogFile, JSON.stringify(value));
  await setCatalog(catalog);
  fixture.env.PRISM_STUB_CATALOG = catalogFile;
  const isOptionsRead = (run) => run.host === "codex" ? !fixture.inputs(run.pid).some((message) => message.method === "thread/start" || message.method === "thread/resume") : run.argv.includes("--no-session-persistence");
  const optionReads = (host = null) => fixture.runs(host).filter(isOptionsRead);
  const launchRuns = (host = null) => fixture.runs(host).filter((run) => !isOptionsRead(run));
  return { ...fixture, catalogFile, setCatalog, readCatalog: async () => JSON.parse(await readFile(catalogFile, "utf8")), optionReads, launchRuns };
}

/** The fixture as the process environment and a review server of its checkout with a write session: { base, headers, review, opened }. */
export async function runOptionsReview(context, options = {}) {
  const fixture = await runOptionsFixture(context, options);
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(context, fixture.root);
  const headers = await pageSession(review, opened);
  return { ...fixture, review, base, opened, headers };
}

/** GET <base>/api/run-options with the query given as an object; a null value is left out. */
export function runOptions(base, query, headers = {}) {
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]));
  return get(base, `api/run-options?${search}`, headers);
}

/** The option of a report with this id, or undefined. */
export const optionOf = (report, id) => report.options.find((option) => option.id === id);
/** The values of a report's option, as the list of their value fields. */
export const valuesOf = (report, id) => optionOf(report, id)?.values.map((entry) => entry.value);
