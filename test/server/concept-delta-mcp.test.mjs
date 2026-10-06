import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const examples = JSON.parse(await readFile(new URL("./fixtures/concept-delta.json", import.meta.url), "utf8"));
async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "prism-concept-mcp-"));
  const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-concept-mcp-data-")));
  const env = { ...process.env, PLUGIN_DATA: privateData, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) };
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [SERVER], { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  child.on("exit", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(stderr || "MCP stopped")); }
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const timer = setTimeout(() => child.kill(), 5000);
      timer.unref();
      child.stdin.end();
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(privateData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`MCP timeout: ${stderr}`)); }, 10000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
  });
  const input = { projectRoot, deltaPath: "docs/plans/demo/retry/concept-delta.json" };
  return { input, rpc, call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}

test("discovers typed MCP tools and performs managed code and non-code edits", async (t) => {
  const { input, rpc, call } = await fixture(t);
  const discovery = await rpc("tools/list");
  const get = discovery.result.tools.find((tool) => tool.name === "get_concept_delta");
  const update = discovery.result.tools.find((tool) => tool.name === "update_concept_delta");
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(update.annotations.readOnlyHint, false);
  assert.equal(get.inputSchema.properties.limit.maximum, 100);
  assert.equal(update.inputSchema.properties.operations.maxItems, 100);
  assert.equal(update.inputSchema.properties.operations.items.oneOf.length, 3);
  assert.equal(update.inputSchema.additionalProperties, false);
  const absent = await call("get_concept_delta", input);
  assert.equal(absent.result.structuredContent.exists, false);
  const response = await call("update_concept_delta", { ...input, expectedRevision: null, scope: examples.scope, operations: examples.concepts.map((entry) => ({ op: "insert", entry })) });
  assert.ok(response.result, JSON.stringify(response.error));
  const created = response.result.structuredContent;
  assert.equal(created.ready, false);
  assert.ok(created.diagnostics.some(item => item.code === "baseline_missing"));
  assert.match(created.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(response.result.content[0].text), created);
  const page = await call("get_concept_delta", { ...input, expectedRevision: created.revision, limit: 2 });
  assert.equal(page.result.structuredContent.concepts.length, 2);
  assert.equal(page.result.structuredContent.nextOffset, 2);
  const changed = await call("update_concept_delta", { ...input, expectedRevision: created.revision, operations: [
    { op: "update", id: "retry-policy", set: { reason: "A revised reason." } },
    { op: "remove", id: "legacy-retry" }
  ] });
  assert.deepEqual(changed.result.structuredContent.changedIds, ["legacy-retry", "retry-policy"]);
  const stale = await call("get_concept_delta", { ...input, expectedRevision: created.revision, offset: 2 });
  assert.equal(stale.error.data.code, "revision_conflict");
  assert.equal(stale.error.data.currentRevision, changed.result.structuredContent.revision);
});
test("MCP failures expose stable codes and preserve rejected batch bytes", async (t) => {
  const { input, call } = await fixture(t);
  const created = (await call("update_concept_delta", { ...input, expectedRevision: null, scope: examples.scope, operations: [] })).result.structuredContent;
  const bytes = await readFile(path.join(input.projectRoot, input.deltaPath), "utf8");
  const invalid = await call("update_concept_delta", { ...input, expectedRevision: created.revision, operations: [
    { op: "insert", entry: examples.concepts[0] }, { op: "update", id: "missing", set: { reason: "Bad" } }
  ] });
  assert.equal(invalid.error.data.code, "validation_failed");
  assert.match(invalid.error.data.errors[0], /operations\[1\]\.id/);
  assert.equal(await readFile(path.join(input.projectRoot, input.deltaPath), "utf8"), bytes);
  const unknown = await call("get_concept_delta", { ...input, extra: true });
  assert.equal(unknown.error.data.code, "validation_failed");
  const escape = await call("get_concept_delta", { ...input, deltaPath: "../concept-delta.json" });
  assert.equal(escape.error.data.code, "invalid_path");
  const oversized = await call("get_concept_delta", { ...input, limit: 101 });
  assert.equal(oversized.error.data.code, "validation_failed");
});

test('public conservation MCP captures, compares, accepts review and enforces mutation gates',async t=>{
 const {input,rpc,call}=await fixture(t);
 const discovery=await rpc('tools/list');
 for(const name of ['capture_repository_snapshot','get_conservation_evidence','compare_concept_delta','get_review','update_review','check_review_gate']) {
  const tool=discovery.result.tools.find(item=>item.name===name);assert.ok(tool,name);assert.equal(tool.inputSchema.additionalProperties,false);
 }
 const b=(await call('capture_repository_snapshot',input)).result.structuredContent;
 const d=(await call('update_concept_delta',{...input,expectedRevision:null,baselineId:b.snapshotId,scope:['src'],operations:[]})).result.structuredContent;
 assert.equal(d.ready,true);
 const c=(await call('compare_concept_delta',{...input,expectedRevision:d.revision,baselineId:b.snapshotId,resultSnapshotId:b.snapshotId})).result.structuredContent;
 assert.equal(c.status,'ready');
 const observations=(await call('get_conservation_evidence',{projectRoot:input.projectRoot,evidenceId:c.comparisonId,section:'observations',limit:1})).result.structuredContent;assert.equal(observations.totalCount,0);
 const reviewPath='docs/plans/demo/retry/review.json';
 let revision=null;
 const mutate=async(actor,operations)=>{const response=await call('update_review',{projectRoot:input.projectRoot,reviewPath,deltaPath:input.deltaPath,delivery:'delivery',expectedRevision:revision,actor,operations});if(response.result)revision=response.result.structuredContent.revision;return response;};
 const coordinator={id:'coordinator',role:'coordinator'},reviewer={id:'independent',role:'reviewer'};
 const blocked=await call('check_review_gate',{projectRoot:input.projectRoot,reviewPath,gate:'implementation'});assert.equal(blocked.result.structuredContent.ready,false);
 await mutate(coordinator,[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:d.revision,snapshotId:b.snapshotId,comparisonId:c.comparisonId,lanes:[{id:'main',reviewer:'independent',coverage:['src']}]}]);
 const noLane=await mutate(coordinator,[{op:'accept_wave'}]);assert.equal(noLane.error.data.code,'gate_blocked');assert.ok(noLane.error.data.problems.some(x=>x.code==='lane_result_stale'));
 await mutate(reviewer,[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await mutate(coordinator,[{op:'accept_wave'}]);
 const gate=(await call('check_review_gate',{projectRoot:input.projectRoot,reviewPath,gate:'implementation'})).result.structuredContent;assert.equal(gate.ready,true);
 const statePath='docs/plans/demo/state.json';
 const started=await call('update_coordination_state',{projectRoot:input.projectRoot,statePath,expectedRevision:null,changes:{activeOperations:[{op:'start',entry:{slice:'retry',activity:'implementation',workers:['delivery'],workspace:input.projectRoot,reviewPath}}]}});assert.ok(started.result,JSON.stringify(started));
 const revisionState=started.result.structuredContent.revision;
 const bypass=await call('update_coordination_state',{projectRoot:input.projectRoot,statePath,expectedRevision:revisionState,changes:{active:[]}});assert.equal(bypass.error.data.code,'gate_blocked');
 const finish=await call('update_coordination_state',{projectRoot:input.projectRoot,statePath,expectedRevision:revisionState,changes:{activeOperations:[{op:'finish',slice:'retry'}]}});assert.equal(finish.error.data.code,'gate_blocked');
 const invalid=await call('update_review',{projectRoot:input.projectRoot,reviewPath,expectedRevision:revision,actor:coordinator,operations:[{op:'accept_wave',gatePassed:true}]});assert.equal(invalid.error.data.code,'validation_failed');
 const search=(await call('search_repository_concepts',{projectRoot:input.projectRoot,snapshotId:b.snapshotId,query:'reuse',limit:1})).result.structuredContent;
 assert.equal(search.status,'degraded');assert.ok(search.receiptId);const receipt=(await call('get_conservation_evidence',{projectRoot:input.projectRoot,evidenceId:search.receiptId})).result.structuredContent;assert.equal(receipt.capabilities.semanticSearch,false);
});
