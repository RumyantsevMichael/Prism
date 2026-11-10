import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { jsonLine, readJsonLines } from "../../dist/server/json-lines.mjs";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { defer } from "./fixtures/teardown.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const SEPARATORS = "a\u2028b\u2029c";

function collect(reader) {
  const lines = [];
  return new Promise((resolve) => {
    reader.on("line", (line) => lines.push(line));
    reader.on("close", () => resolve(lines));
  });
}

test("a written message escapes U+2028 and U+2029 and still parses to the same value", () => {
  const line = jsonLine({ text: SEPARATORS });
  assert.equal(line, '{"text":"a\\u2028b\\u2029c"}\n');
  assert.doesNotMatch(line, /[\u2028\u2029]/);
  assert.deepEqual(JSON.parse(line), { text: SEPARATORS });
});

test("the reader splits only at line feeds, across chunks, and drops a trailing carriage return", async () => {
  const stream = new PassThrough();
  const lines = collect(readJsonLines(stream));
  stream.write(`{"text":"${SEPARATORS}"}\r\n{"te`);
  stream.write('xt":"split"}\n\n{"last":true}');
  stream.end();
  assert.deepEqual(await lines, [`{"text":"${SEPARATORS}"}`, '{"text":"split"}', "", '{"last":true}']);
});

test("the MCP server keeps a request with raw U+2028 and U+2029 whole and answers on one line", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-json-lines-"));
  defer(context, () => rm(root, { recursive: true, force: true }));
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) });
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
  defer(context, () => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8");
  const answered = new Promise((resolve) => child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("\n")) resolve(); }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: SEPARATORS, method: `unknown/${SEPARATORS}` })}\n`);
  await answered;
  const [line] = output.split("\n");
  assert.doesNotMatch(line, /[\u2028\u2029]/, "the answer escapes both separators");
  const response = JSON.parse(line);
  assert.equal(response.id, SEPARATORS, "the request reached the server whole");
  assert.equal(response.error.code, -32601);
  child.stdin.end();
});
