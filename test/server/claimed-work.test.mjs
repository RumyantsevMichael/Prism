import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { callSessionId, sessionHolder } from "../../dist/server/workflow/slice-claims.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));

// One MCP server whose calls name a host session in their metadata, as Codex names it, so a test can act as two agents of one server.
async function server(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claimed-work-")));
  const data = await mkdtemp(path.join(os.tmpdir(), "claimed-work-data-"));
  context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "docs", "plans"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: npm test\n");
  await writeFile(path.join(root, "docs", "acceptance.test.mjs"), "// frozen\n");
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) });
  env.CLAUDE_PROJECT_DIR = root;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  context.after(() => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); }));
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const call = (session, name, args) => send("tools/call", { name, arguments: { projectRoot: root, initiative: "reports", ...args }, _meta: session });
  const revision = async (session) => (await call(session, "get_initiative", {})).result.structuredContent.revision;
  const update = async (session, operations) => call(session, "update_initiative", { expectedRevision: await revision(session), operations });
  return { root, call, update };
}

const agentA = { sessionId: "019a-agent-a" };
const agentB = { sessionId: "019a-agent-b" };
const claimFile = (root, slug) => path.join(root, ".prism", "initiatives", "reports", "claims", `${slug}.json`);

async function startedSlice(context) {
  const tools = await server(context);
  await tools.call(agentA, "update_initiative", { expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Signed reports", requirements: ["req.md#R1"] }] });
  const started = await tools.update(agentA, [{ op: "set_status", slug: "reports", status: "in-progress" }, { op: "accept_design", slug: "reports", frozenTests: ["docs/acceptance.test.mjs"], review: "required" }]);
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  return tools;
}

test("a review of a slice that another agent holds is refused, and its holder's review goes through", async (context) => {
  const { call } = await startedSlice(context);
  const wave = { expectedRevision: null, actor: { id: "coordinator", role: "coordinator" }, delivery: "delivery", operations: [{ op: "start_wave", id: "wave-1", mode: "implementation-review", lanes: [{ id: "lane-1", reviewer: "reviewer-1", coverage: ["docs/acceptance.test.mjs"] }] }] };
  const refused = await call(agentB, "update_review", { slice: "reports", ...wave });
  assert.equal(refused.error.data.code, "slice_claimed");
  assert.match(refused.error.message, /claimed by .* for implementation/);
  const unmarked = await call(agentB, "update_design_view", { slice: "reports", examples: [{ clause: 1, file: "docs/acceptance.test.mjs", test: "frozen", example: "x" }] });
  assert.equal(unmarked.error.data.code, "slice_claimed");
  const held = await call(agentA, "update_review", { slice: "reports", ...wave });
  assert.notEqual(held.error?.data?.code, "slice_claimed");
  assert.notEqual(held.error?.data?.code, "claim_required");
});

test("an agent whose claim expired is refused until it claims the slice again for implementation", async (context) => {
  const { root, call, update } = await startedSlice(context);
  const claim = JSON.parse(await readFile(claimFile(root, "reports"), "utf8"));
  await writeFile(claimFile(root, "reports"), `${JSON.stringify({ ...claim, expiresAt: new Date(Date.now() - 1000).toISOString() }, null, 2)}\n`);
  const refused = await call(agentA, "verify_slice", { slice: "reports" });
  assert.equal(refused.error.data.code, "claim_required");
  assert.match(refused.error.message, /expired at/);
  assert.equal(refused.error.data.claim.slug, "reports");
  const done = await update(agentA, [{ op: "set_status", slug: "reports", status: "done" }]);
  assert.equal(done.error.data.code, "claim_required");
  const claimed = await update(agentA, [{ op: "claim", slug: "reports" }]);
  assert.equal(claimed.error, undefined, JSON.stringify(claimed.error));
  const renewed = JSON.parse(await readFile(claimFile(root, "reports"), "utf8"));
  assert.equal(renewed.activity, "implementation");
  assert.ok(Date.parse(renewed.expiresAt) > Date.now());
  const verified = await call(agentA, "verify_slice", { slice: "reports" });
  assert.notEqual(verified.error?.data?.code, "claim_required");
});

test("design work needs a claim on its scope, which the same update may take first", async (context) => {
  const { call, update } = await server(context);
  await call(agentA, "update_initiative", { expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Signed reports", requirements: ["req.md#R1"] }] });
  const unclaimed = await update(agentA, [{ op: "restore_tests", slug: "reports" }]);
  assert.equal(unclaimed.error.data.code, "claim_required");
  assert.match(unclaimed.error.message, /No live claim of this session covers reports/);
  const together = await update(agentA, [{ op: "claim", slug: "reports" }, { op: "restore_tests", slug: "reports" }]);
  assert.equal(together.error, undefined, JSON.stringify(together.error));
  const proposed = await update(agentB, [{ op: "propose_design", slug: "reports", operations: [{ op: "update_slice", slug: "reports", title: "Signed monthly reports" }] }]);
  assert.equal(proposed.error.data.code, "slice_claimed");
  const edited = await update(agentB, [{ op: "update_slice", slug: "reports", title: "Signed monthly reports" }]);
  assert.equal(edited.error.data.code, "slice_claimed");
  const released = await update(agentA, [{ op: "release_claim", slug: "reports" }]);
  assert.equal(released.error, undefined, JSON.stringify(released.error));
  const free = await update(agentB, [{ op: "update_slice", slug: "reports", title: "Signed monthly reports" }]);
  assert.equal(free.error, undefined, JSON.stringify(free.error));
});

test("an older Codex that names its session only in the turn metadata keeps one holder for its sub-agents", async (context) => {
  const root = { "x-codex-turn-metadata": { session_id: "019a-root", thread_id: "019a-root", thread_source: "user" }, threadId: "019a-root" };
  const child = { "x-codex-turn-metadata": { session_id: "019a-root", thread_id: "019a-child", thread_source: "subagent" }, threadId: "019a-child" };
  assert.equal(callSessionId(root), "019a-root");
  assert.equal(callSessionId(child), "019a-root");
  assert.equal(callSessionId({ sessionId: "019a-new", "x-codex-turn-metadata": { session_id: "019a-old" } }), "019a-new");
  assert.equal(callSessionId({ threadId: "019a-thread" }), null);
  assert.equal(callSessionId(undefined), null);
  const tools = await server(context);
  await tools.call(root, "update_initiative", { expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Signed reports", requirements: ["req.md#R1"] }] });
  const started = await tools.update(root, [{ op: "set_status", slug: "reports", status: "in-progress" }]);
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  const claim = JSON.parse(await readFile(claimFile(tools.root, "reports"), "utf8"));
  assert.equal(claim.holder, sessionHolder({ CLAUDE_CODE_SESSION_ID: "019a-root" }));
  const fromChild = await tools.call(child, "update_design_view", { slice: "reports", examples: [{ clause: 1, file: "docs/acceptance.test.mjs", test: "frozen", example: "x" }] });
  assert.notEqual(fromChild.error?.data?.code, "slice_claimed");
  assert.notEqual(fromChild.error?.data?.code, "claim_required");
});
