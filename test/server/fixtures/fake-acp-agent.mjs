// A fake Agent Client Protocol agent for launch tests: it logs every message it reads to FAKE_ACP_LOG, answers initialize,
// session/new, session/resume, session/set_config_option, and session/prompt, asks one permission during a prompt whose text
// names "write", holds a prompt whose text names "hold" until session/cancel, and exits when its input closes.
import fs from "node:fs";

const log = (entry) => fs.appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
log({ kind: "start", argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let options = [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "edit", name: "Edit" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "fake-large", options: [{ value: "fake-large", name: "Large" }, { value: "fake-small", name: "Small" }] }
];
let held = null;
let permissionId = 1000;
const permissions = new Map();
let buffer = "";
const finish = (id, stopReason) => out({ jsonrpc: "2.0", id, result: { stopReason, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ kind: "input", message });
    if (message.id !== undefined && !message.method && permissions.has(message.id)) {
      const promptId = permissions.get(message.id);
      permissions.delete(message.id);
      finish(promptId, "end_turn");
      continue;
    }
    const { id, method, params } = message;
    if (method === "initialize") out({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } }, authMethods: [] } });
    else if (method === "session/new") out({ jsonrpc: "2.0", id, result: { sessionId: "fake-session-1", configOptions: options } });
    else if (method === "session/resume") out({ jsonrpc: "2.0", id, result: { configOptions: options } });
    else if (method === "session/set_config_option") {
      const option = options.find((item) => item.id === params.configId);
      if (!option || !option.options.some((value) => value.value === params.value)) out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
      else {
        options = options.map((item) => (item.id === params.configId ? { ...item, currentValue: params.value } : item));
        out({ jsonrpc: "2.0", id, result: { configOptions: options } });
      }
    } else if (method === "session/prompt") {
      const text = params.prompt.map((block) => block.text).join(" ");
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: 500, size: 1000, cost: { amount: 0.25, currency: "USD" } } } });
      if (/write/.test(text)) {
        const ask = permissionId++;
        permissions.set(ask, id);
        out({ jsonrpc: "2.0", id: ask, method: "session/request_permission", params: { sessionId: params.sessionId, toolCall: { toolCallId: "t1", title: "Write probe.txt", kind: "edit" }, options: [{ optionId: "allow", name: "Yes", kind: "allow_once" }] } });
      } else if (/hold/.test(text)) held = id;
      else finish(id, "end_turn");
    } else if (method === "session/cancel") {
      if (held !== null) finish(held, "cancelled");
      held = null;
    } else if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
process.stdin.on("end", () => {
  log({ kind: "closed" });
  process.exit(0);
});
