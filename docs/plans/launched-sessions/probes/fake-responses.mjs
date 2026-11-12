import http from "node:http";
import { appendFileSync } from "node:fs";
const plan = JSON.parse(process.env.PLAN || "[]");
let step = 0;
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  let json = {}; try { json = JSON.parse(body); } catch {}
  const outputs = (json.input ?? []).filter((i) => /_output$/.test(i.type ?? ""));
  appendFileSync(process.env.LOG, JSON.stringify({ url: req.url, method: req.method, model: json.model, tools: (json.tools ?? []).map((t) => t.name ?? t.type), instr: String(json.instructions ?? "").slice(0, 200), ninput: json.input?.length, lastInput: String(JSON.stringify(json.input?.at(-1))).slice(0, 1500) }) + "\n");
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const reviewer = /approv|review/i.test(String(json.instructions ?? "")) && !(json.tools ?? []).length;
  let item = { type: "message", id: "msg_x", role: "assistant", content: [{ type: "output_text", text: process.env.REVIEW_TEXT && reviewer ? process.env.REVIEW_TEXT : "done" }] };
  if (!reviewer && step < plan.length && (step === 0 || outputs.length > step - 1)) { item = plan[step]; step++; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("response.created", { response: { id: "resp_" + step } });
  ev("response.output_item.done", { output_index: 0, item });
  ev("response.completed", { response: { id: "resp_" + step, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 } } });
  res.end();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
