// Scripted Messages API: PLAN env is a JSON list of blocks to return for main-turn requests in order; then "done".
import http from "node:http";
import { appendFileSync } from "node:fs";
const plan = JSON.parse(process.env.PLAN || "[]");
const log = process.env.LOG;
let step = 0;
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  let json = {}; try { json = JSON.parse(body); } catch {}
  appendFileSync(log, JSON.stringify({ url: req.url, system: JSON.stringify(json.system ?? "").slice(0, 300), tools: (json.tools||[]).map(t=>t.name).slice(0,80), last: String(JSON.stringify(json.messages?.at(-1))).slice(0, 3000), nmsg: json.messages?.length, marker: (body.match(/PROBE-SKILL-BODY-MARKER for [a-z-]*/)||[null])[0], max_tokens: json.max_tokens }) + "\n");
  if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({input_tokens:1})); return; }
  const hasTools = (json.tools || []).length > 0;
  const last = json.messages?.at(-1);
  const isToolResult = Array.isArray(last?.content) && last.content.some(b => b.type === "tool_result");
  let block = { type: "text", text: process.env.SIDE_TEXT || "done" };
  if (hasTools && (step === 0 || isToolResult) && step < plan.length) { block = plan[step]; step++; }
  else if (hasTools) block = { type: "text", text: "done" };
  const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: "msg_"+Math.random().toString(16).slice(2), type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!json.stream) { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop })); return; }
  res.writeHead(200, {"content-type":"text/event-stream"});
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message });
  if (block.type === "text") { ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } }); }
  else { ev("content_block_start", { index: 0, content_block: { ...block, input: {} } }); ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }); }
  ev("content_block_stop", { index: 0 }); ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }); ev("message_stop", {}); res.end();
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening"));
