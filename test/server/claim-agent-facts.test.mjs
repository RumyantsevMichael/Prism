import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { defer } from "./fixtures/teardown.mjs";
import { settled } from "./fixtures/wait.mjs";

// A claim names the harness its agent runs in, as the harness names itself to Prism, and the model of that agent only when Prism can
// tell the call came from the session's main agent, whose model the session-facts hook observed; a sub-agent's call, or a call nobody
// attributed, records no model. Each test drives a real MCP server and the real hooks, and reads the stored claim record.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = path.join(ROOT, "dist/server/mcp.mjs");
const FACTS_HOOK = path.join(ROOT, "dist/hooks/record-session-facts.mjs");
const AGENT_HOOK = path.join(ROOT, "dist/hooks/record-call-agent.mjs");
const CLAUDE_SESSION = "5cca0f5d-7a36-4df7-8a88-0380835affa8";
const CODEX_SESSION = "019a-codex-root";
const CLAUDE_CODE = { name: "claude-code", title: "Claude Code", version: "2.1.327" };
const CODEX = { name: "codex-mcp-client", version: "0.147.0" };

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  defer(context, () => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One project, one private review app folder, and one plugin data folder that the hooks and servers of a test share.
async function workspace(context) {
  const root = await temporary(context, "prism-claim-agent-");
  const app = await temporary(context, "prism-claim-agent-app-");
  const data = await temporary(context, "prism-claim-agent-data-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: npm test\n");
  const env = (extra = {}) => isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: app, PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "", PRISM_NATIVE_ASSET_MANIFEST: path.join(ROOT, "test/server/fixtures/native-manifest-unavailable.json"), ...extra });
  return { root, app, data, env };
}

/** A real Prism MCP server that a client named by clientInfo initialized; `session` is the Claude Code session in its environment. */
async function server(context, space, { clientInfo, session = "", extraEnv = {} } = {}) {
  const env = space.env({ CLAUDE_CODE_SESSION_ID: session, ...extraEnv });
  env.CLAUDE_PROJECT_DIR = space.root;
  const child = spawn(process.execPath, [SERVER], { cwd: space.root, env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  defer(context, () => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); }));
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, ...(clientInfo ? { clientInfo } : {}) });
  const call = async (meta, name, args) => {
    const answer = await send("tools/call", { name, arguments: { projectRoot: space.root, initiative: "reports", ...args }, ...(meta ? { _meta: meta } : {}) });
    return answer;
  };
  const update = async (meta, operations, initiative = "reports") => {
    const revision = (await call(meta, "get_initiative", { initiative })).result.structuredContent.revision;
    const answer = await call(meta, "update_initiative", { initiative, expectedRevision: revision, operations });
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    return answer;
  };
  return { call, update };
}

// Each initiative here has only its root slice, whose slug is the initiative's, so one session can hold claims on several of them.
const claimFile = (root, initiative = "reports") => path.join(root, ".prism", "initiatives", initiative, "claims", `${initiative}.json`);
const storedClaim = async (root, initiative = "reports") => JSON.parse(await readFile(claimFile(root, initiative), "utf8"));
const createInitiative = (tools, meta, initiative = "reports") => tools.call(meta, "update_initiative", { initiative, expectedRevision: null, operations: [{ op: "create", slug: initiative, title: `Signed ${initiative}`, requirements: ["req.md#R1"] }] });

/** Runs a hook script with one JSON input on standard input, as the host runs it, in the test's review app and plugin data folders. */
function hook(space, script, input, extra = {}) {
  const env = space.env(extra);
  execFileSync(process.execPath, [script], { cwd: space.root, env, input: JSON.stringify(input), stdio: ["pipe", "ignore", "ignore"] });
}

// A Claude Code session's main transcript, which names its version and the model of the main agent's last message.
async function claudeTranscript(space, model) {
  const file = path.join(space.root, "claude-transcript.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "assistant", sessionId: CLAUDE_SESSION, version: "2.1.327", message: { model, role: "assistant", content: [] } })}\n`);
  return file;
}

/** The Claude Code session-facts hook of the main agent, which observes the main agent's model. */
async function claudeFacts(space, model, { agentId = null } = {}) {
  const transcript = await claudeTranscript(space, model);
  hook(space, FACTS_HOOK, { session_id: CLAUDE_SESSION, hook_event_name: "UserPromptSubmit", transcript_path: transcript, model, ...(agentId ? { agent_id: agentId } : {}) }, { CLAUDE_PROJECT_DIR: space.root });
}

/** Claude Code's PreToolUse hook for one Prism tool use, which names agent_id only for a sub-agent's tool use. */
function claudeToolUse(space, toolUseId, { agentId = null } = {}) {
  hook(space, AGENT_HOOK, { session_id: CLAUDE_SESSION, hook_event_name: "PreToolUse", tool_name: "mcp__plugin_prism_prism-review__update_initiative", tool_use_id: toolUseId, ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}) });
}

// A Codex rollout whose session meta names the root session or a sub-agent thread.
async function codexRollout(space, name, source) {
  const file = path.join(space.root, `${name}.jsonl`);
  await writeFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: name === "root" ? CODEX_SESSION : "019a-codex-child", session_id: CODEX_SESSION, cli_version: "0.147.0", model_provider: "openai", cwd: space.root, source } })}\n`);
  return file;
}

/** The Codex session-facts hook of one thread, with the model that Codex names in the hook input. */
async function codexFacts(space, model, { subagent = false } = {}) {
  const transcript = await codexRollout(space, subagent ? "child" : "root", subagent ? { subagent: { depth: 1 } } : "cli");
  hook(space, FACTS_HOOK, { session_id: CODEX_SESSION, cwd: space.root, transcript_path: transcript, turn_id: "turn-1", hook_event_name: "UserPromptSubmit", model }, { CODEX_VERSION: "0.147.0" });
}

const claudeCall = (toolUseId) => ({ "claudecode/toolUseId": toolUseId, progressToken: 1 });
const codexCall = ({ subagent = false } = {}) => ({
  sessionId: CODEX_SESSION,
  threadId: subagent ? "019a-codex-child" : CODEX_SESSION,
  "x-codex-turn-metadata": { session_id: CODEX_SESSION, thread_id: subagent ? "019a-codex-child" : CODEX_SESSION, ...(subagent ? { parent_thread_id: CODEX_SESSION, thread_source: "subagent" } : { thread_source: "user" }) }
});

test("§1 a claim records the harness by the title its MCP client gives, else by its name, and none without either", async (context) => {
  const cases = [
    [CLAUDE_CODE, "Claude Code"],
    [CODEX, "codex-mcp-client"],
    [{ name: "  Another\t\tHarness  ", title: "   " }, "Another Harness"],
    [{ name: "x", title: `Harness ${"y".repeat(100)}` }, `Harness ${"y".repeat(56)}`],
    [null, undefined]
  ];
  for (const [clientInfo, expected] of cases) {
    const space = await workspace(context);
    const tools = await server(context, space, { clientInfo });
    await createInitiative(tools, null);
    await tools.update(null, [{ op: "claim", slug: "reports" }]);
    const claim = await storedClaim(space.root);
    assert.equal(claim.host, expected, `client ${JSON.stringify(clientInfo)}`);
    assert.equal(Object.hasOwn(claim, "host"), expected !== undefined, "a client that names itself in neither field leaves host out");
  }
});

test("§2 §3 a Claude Code main agent's claim records the model its session-facts hook observed, and §6 every view shows it", async (context) => {
  const space = await workspace(context);
  await claudeFacts(space, "claude-opus-5-5");
  const tools = await server(context, space, { clientInfo: CLAUDE_CODE, session: CLAUDE_SESSION });
  claudeToolUse(space, "toolu_create");
  await createInitiative(tools, claudeCall("toolu_create"));
  claudeToolUse(space, "toolu_read");
  claudeToolUse(space, "toolu_claim");
  const revision = (await tools.call(claudeCall("toolu_read"), "get_initiative", {})).result.structuredContent.revision;
  const claimed = await tools.call(claudeCall("toolu_claim"), "update_initiative", { expectedRevision: revision, operations: [{ op: "claim", slug: "reports" }] });
  assert.equal(claimed.error, undefined, JSON.stringify(claimed.error));
  const claim = await storedClaim(space.root);
  assert.equal(claim.host, "Claude Code");
  assert.equal(claim.model, "claude-opus-5-5");
  const read = (await tools.call(null, "get_initiative", {})).result.structuredContent;
  assert.equal(read.record.slices.reports.claim.host, "Claude Code");
  assert.equal(read.record.slices.reports.claim.model, "claude-opus-5-5");
  assert.equal(read.claims.reports.host, "Claude Code");
  assert.equal(read.claims.reports.model, "claude-opus-5-5");
  const { serveProject } = await import("./fixtures/kit-browser.mjs");
  const { base } = await serveProject(context, space.root);
  const listed = await (await fetch(`${base}/api/claims`)).json();
  const entry = listed.claims.find((item) => item.ref === "slice:reports/reports");
  assert.equal(entry.host, "Claude Code");
  assert.equal(entry.model, "claude-opus-5-5");
});

test("§2 a Claude Code sub-agent's claim, and a call no hook recorded, record no model, and §3 a sub-agent's facts never replace the main agent's", async (context) => {
  const space = await workspace(context);
  await claudeFacts(space, "claude-opus-5-5");
  await claudeFacts(space, "claude-haiku-5", { agentId: "a36908f3a203b2a99" });
  const tools = await server(context, space, { clientInfo: CLAUDE_CODE, session: CLAUDE_SESSION });
  await createInitiative(tools, null);
  claudeToolUse(space, "toolu_sub", { agentId: "a36908f3a203b2a99" });
  await tools.update(claudeCall("toolu_sub"), [{ op: "claim", slug: "reports" }]);
  const bySubagent = await storedClaim(space.root);
  assert.equal(bySubagent.host, "Claude Code", "the harness is the session's, whichever agent calls");
  assert.equal(Object.hasOwn(bySubagent, "model"), false, "a sub-agent's claim records no model");
  await tools.update(null, [{ op: "release_claim", slug: "reports" }]);
  await tools.update(claudeCall("toolu_unrecorded"), [{ op: "claim", slug: "reports" }]);
  assert.equal(Object.hasOwn(await storedClaim(space.root), "model"), false, "a call whose tool use no hook recorded records no model");
  await tools.update(null, [{ op: "release_claim", slug: "reports" }]);
  claudeToolUse(space, "toolu_main");
  await tools.update(claudeCall("toolu_main"), [{ op: "claim", slug: "reports" }]);
  assert.equal((await storedClaim(space.root)).model, "claude-opus-5-5", "the sub-agent's observed model never became the main agent's");
});

test("§2 a main agent's call records no model while the session-facts hook observed none", async (context) => {
  const space = await workspace(context);
  const tools = await server(context, space, { clientInfo: CLAUDE_CODE, session: CLAUDE_SESSION });
  await createInitiative(tools, null);
  claudeToolUse(space, "toolu_main");
  await tools.update(claudeCall("toolu_main"), [{ op: "claim", slug: "reports" }]);
  const claim = await storedClaim(space.root);
  assert.equal(claim.host, "Claude Code");
  assert.equal(Object.hasOwn(claim, "model"), false);
});

test("§2 §3 a Codex root thread's claim records its model, and a sub-agent thread's claim records none", async (context) => {
  const space = await workspace(context);
  await codexFacts(space, "gpt-5.5");
  await codexFacts(space, "gpt-5.5-mini", { subagent: true });
  const tools = await server(context, space, { clientInfo: CODEX });
  await createInitiative(tools, codexCall());
  await tools.update(codexCall(), [{ op: "claim", slug: "reports" }]);
  const byRoot = await storedClaim(space.root);
  assert.equal(byRoot.host, "codex-mcp-client");
  assert.equal(byRoot.model, "gpt-5.5", "the sub-agent thread's hook left the root thread's model in place");
  await tools.update(codexCall(), [{ op: "release_claim", slug: "reports" }]);
  await tools.update(codexCall({ subagent: true }), [{ op: "claim", slug: "reports" }]);
  assert.equal(Object.hasOwn(await storedClaim(space.root), "model"), false);
  await tools.update(codexCall(), [{ op: "release_claim", slug: "reports" }]);
  await tools.update({ sessionId: CODEX_SESSION }, [{ op: "claim", slug: "reports" }]);
  assert.equal(Object.hasOwn(await storedClaim(space.root), "model"), false, "a call whose metadata names no thread records no model");
});

test("§4 §7 a renewal follows the main agent's change of model, and never gives a sub-agent's claim a model", async (context) => {
  const space = await workspace(context);
  await codexFacts(space, "gpt-5.5");
  const tools = await server(context, space, { clientInfo: CODEX, extraEnv: { PRISM_CLAIM_RENEW_MS: "200" } });
  await createInitiative(tools, codexCall(), "download");
  await createInitiative(tools, codexCall(), "audit");
  await tools.update(codexCall(), [{ op: "claim", slug: "download" }], "download");
  await tools.update(codexCall({ subagent: true }), [{ op: "claim", slug: "audit" }], "audit");
  assert.equal((await storedClaim(space.root, "download")).model, "gpt-5.5");
  const before = await storedClaim(space.root, "download");
  await codexFacts(space, "gpt-5.5-codex");
  const renewed = await settled(() => storedClaim(space.root, "download"), (claim) => claim.model === "gpt-5.5-codex");
  assert.equal(renewed.model, "gpt-5.5-codex", "the next renewal writes the session's current model");
  assert.ok(Date.parse(renewed.renewedAt) > Date.parse(before.renewedAt));
  const audit = await settled(() => storedClaim(space.root, "audit"), (claim) => Date.parse(claim.renewedAt) > Date.parse(before.renewedAt));
  assert.ok(Date.parse(audit.renewedAt) > Date.parse(before.renewedAt), "the sub-agent's claim is renewed too");
  assert.equal(Object.hasOwn(audit, "model"), false, "a renewal never gives a sub-agent's claim a model");
  assert.equal(audit.host, "codex-mcp-client");
});

test("§5 a claim record whose model is malformed reads as a claim without a model and is never refused", async (context) => {
  const space = await workspace(context);
  const tools = await server(context, space, { clientInfo: CODEX });
  for (const initiative of ["a", "b", "c", "d"]) await createInitiative(tools, null, initiative);
  const now = Date.now();
  const at = (minutes) => new Date(now + minutes * 60000).toISOString();
  for (const [slug, model] of [["a", 5], ["b", "m".repeat(129)], ["c", "bad\u0007model"], ["d", "gpt-5.5"]]) {
    await mkdir(path.dirname(claimFile(space.root, slug)), { recursive: true });
    await writeFile(claimFile(space.root, slug), `${JSON.stringify({ schemaVersion: 1, slug, holder: `session-${"0".repeat(15)}${slug}`, label: "Dana on studio-mac", host: "Codex", model, activity: "design", claimedAt: at(-5), renewedAt: at(-5), expiresAt: at(25), nonce: "0123456789abcdef01234567" }, null, 2)}\n`);
  }
  for (const slug of ["a", "b", "c"]) {
    const read = (await tools.call(null, "get_initiative", { initiative: slug })).result.structuredContent;
    assert.equal(read.valid, true, JSON.stringify(read.errors));
    const claim = read.record.slices[slug].claim;
    assert.equal(claim?.label, "Dana on studio-mac", `the claim on ${slug} still holds the slice`);
    assert.equal(claim.host, "Codex");
    assert.equal(Object.hasOwn(claim, "model"), false, `the malformed model of ${slug} is left out`);
  }
  const wellFormed = (await tools.call(null, "get_initiative", { initiative: "d" })).result.structuredContent.record.slices.d.claim;
  assert.equal(wellFormed.model, "gpt-5.5", "a well-formed model is read");
  const read = (await tools.call(null, "get_initiative", { initiative: "a" })).result.structuredContent;
  const refused = await tools.call(null, "update_initiative", { initiative: "a", expectedRevision: read.revision, operations: [{ op: "claim", slug: "a" }] });
  assert.equal(refused.error.data.code, "slice_claimed", "the claim with a malformed model still blocks another holder");
});

// A host session that a person can open from a link, such as a Claude Code on the web session, which names itself cse_<id> in the environment of every process it starts.
const CLOUD_SESSION = "cse_018gSB8BexampleLinkId";
const CLOUD_URL = "https://claude.ai/code/session_018gSB8BexampleLinkId";

test("§8 a claim of the server's own host session records the session a person can open, and every view shows its link", async (context) => {
  const space = await workspace(context);
  const tools = await server(context, space, { clientInfo: CLAUDE_CODE, session: CLAUDE_SESSION, extraEnv: { CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION } });
  await createInitiative(tools, null);
  await tools.update(null, [{ op: "claim", slug: "reports" }]);
  const stored = await storedClaim(space.root);
  assert.deepEqual(stored.session, { kind: "claude-code-web", id: CLOUD_SESSION });
  assert.deepEqual(Object.keys(stored), ["schemaVersion", "slug", "holder", "label", "host", "session", "activity", "claimedAt", "renewedAt", "expiresAt", "nonce"], "the session sits in the claim's fixed field order");
  const read = (await tools.call(null, "get_initiative", {})).result.structuredContent;
  assert.deepEqual(read.record.slices.reports.claim.session, { url: CLOUD_URL, label: "Claude Code on the web" }, "a read shows the link, not the raw id");
});

test("§8 a claim records no session for a host with no openable session, a Codex call, a malformed id, or a run Prism launched", async (context) => {
  const cases = [
    ["no cloud session", {}, null],
    ["a malformed id", { CLAUDE_CODE_REMOTE_SESSION_ID: "session_018gSB8B" }, null],
    ["a launched run", { CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION, PRISM_LAUNCH: "launch-1" }, null],
    ["a Codex call", { CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION }, codexCall()]
  ];
  for (const [name, extraEnv, meta] of cases) {
    const space = await workspace(context);
    const tools = await server(context, space, { clientInfo: meta ? CODEX : CLAUDE_CODE, session: meta ? "" : CLAUDE_SESSION, extraEnv });
    await createInitiative(tools, meta);
    await tools.update(meta, [{ op: "claim", slug: "reports" }]);
    assert.equal(Object.hasOwn(await storedClaim(space.root), "session"), false, name);
  }
});

test("§8 a claim record whose session is malformed or of an unknown kind is never refused, and only a known kind shows a link", async (context) => {
  const space = await workspace(context);
  const tools = await server(context, space, { clientInfo: CODEX });
  const sessions = { a: "cse_x", b: { kind: "Claude Code", id: "cse_018gSB8Bexample" }, c: { kind: "claude-code-web", id: "has space" }, d: { kind: "another-host", id: "run-7" }, e: { kind: "claude-code-web", id: CLOUD_SESSION, later: true } };
  for (const initiative of Object.keys(sessions)) await createInitiative(tools, null, initiative);
  const now = Date.now();
  const at = (minutes) => new Date(now + minutes * 60000).toISOString();
  for (const [slug, session] of Object.entries(sessions)) {
    await mkdir(path.dirname(claimFile(space.root, slug)), { recursive: true });
    await writeFile(claimFile(space.root, slug), `${JSON.stringify({ schemaVersion: 1, slug, holder: `session-${"0".repeat(15)}${slug}`, label: "Dana on studio-mac", host: "Claude Code", session, activity: "design", claimedAt: at(-5), renewedAt: at(-5), expiresAt: at(25), nonce: "0123456789abcdef01234567" }, null, 2)}\n`);
  }
  for (const [slug, expected] of [["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined], ["e", { url: CLOUD_URL, label: "Claude Code on the web" }]]) {
    const read = (await tools.call(null, "get_initiative", { initiative: slug })).result.structuredContent;
    assert.equal(read.valid, true, JSON.stringify(read.errors));
    const claim = read.record.slices[slug].claim;
    assert.equal(claim?.label, "Dana on studio-mac", `the claim on ${slug} still holds the slice`);
    assert.deepEqual(claim.session, expected, slug);
  }
  const read = (await tools.call(null, "get_initiative", { initiative: "a" })).result.structuredContent;
  const refused = await tools.call(null, "update_initiative", { initiative: "a", expectedRevision: read.revision, operations: [{ op: "claim", slug: "a" }] });
  assert.equal(refused.error.data.code, "slice_claimed", "the claim with a malformed session still blocks another holder");
});
