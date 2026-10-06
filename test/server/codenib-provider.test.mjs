import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CODENIB_SUPPORTED_VERSION, CodeNibRepositoryIntelligence, CodeNibRuntimeError, McpStdioClient } from "../../dist/server/codenib-provider.mjs";

function childProcessStub() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

test("terminates CodeNib when one stdio response exceeds the byte limit", async () => {
  const child = childProcessStub();
  const client = new McpStdioClient(child, { timeoutMs: 1000, maxResponseBytes: 64 });
  const response = client.request("tools/call", { name: "get_manifest", arguments: {} });

  child.stdout.write(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(128)}`);

  await assert.rejects(response, (error) => error instanceof CodeNibRuntimeError && error.code === "response-too-large" && error.provider === "codenib");
  assert.equal(child.killed, true);
});

async function initializeWith(child, serverInfo) {
  child.stdin.once("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {}, ...(serverInfo === undefined ? {} : { serverInfo }) } })}\n`);
  });
  const client = new McpStdioClient(child, { timeoutMs: 1000 });
  await client.initialize();
  return client;
}

test("captures the exact supported CodeNib MCP server identity", async () => {
  const child = childProcessStub();
  const client = await initializeWith(child, { name: "codenib", version: CODENIB_SUPPORTED_VERSION });

  assert.deepEqual(client.serverInfo, { name: "codenib", version: "0.2.3" });
});

test("rejects missing, mismatched, and unsupported CodeNib MCP server identity", async () => {
  for (const serverInfo of [undefined, { name: "another-server", version: "0.2.3" }, { name: "codenib", version: "0.2.4" }]) {
    const child = childProcessStub();
    await assert.rejects(
      initializeWith(child, serverInfo),
      (error) => error instanceof CodeNibRuntimeError && ["invalid-server-identity", "incompatible-version"].includes(error.code)
    );
  }
});

test("reports executable version separately from the manifest schema version", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    serverInfo: { name: "codenib", version: "0.2.3" },
    async callTool(name) {
      assert.equal(name, "get_manifest");
      return {
        payload: {
          version: "7",
          repo: { commit: "abc", source_fingerprint: "fingerprint" },
          runtime: { loaded_views: [], source_read: { verified: true } }
        }
      };
    }
  });

  const description = await provider.describe();

  assert.equal(description.version, "0.2.3");
  assert.equal(provider.manifestSchemaVersion, "7");
});
