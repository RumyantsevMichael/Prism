import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

// Every Prism process appends JSON records to one log file, so a stalled or failing server leaves a record of what it was doing.
const { LOG_BYTES, LOG_FILE, log, logDirectory } = await import("../../dist/server/log.mjs");

const records = async (directory) => (await readFile(path.join(directory, LOG_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

async function folder(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the log lives in the Prism app folder unless PRISM_LOG_DIR moves it", () => {
  assert.equal(logDirectory({ PRISM_REVIEW_APP_DIR: "/tmp/prism-app" }), path.resolve("/tmp/prism-app/logs"));
  assert.equal(logDirectory({ PRISM_REVIEW_APP_DIR: "/tmp/prism-app", PRISM_LOG_DIR: "/tmp/elsewhere" }), path.resolve("/tmp/elsewhere"));
});

test("records below the level are left out, and the file keeps one older file past its limit", async (t) => {
  const directory = await folder(t);
  log.configure({ name: "test", directory, level: 20 });
  log.debug("left_out");
  log.info("kept", { value: 1 });
  await log.flush();
  const [record] = await records(directory);
  assert.deepEqual([record.event, record.process, record.pid, record.value, record.level], ["kept", "test", process.pid, 1, "info"]);
  assert.equal((await records(directory)).length, 1);
  await writeFile(path.join(directory, LOG_FILE), "x".repeat(LOG_BYTES));
  log.configure({ name: "test", directory, level: 20 });
  log.info("after_rotation");
  await log.flush();
  assert.equal((await readFile(path.join(directory, `${LOG_FILE}.1`), "utf8")).length, LOG_BYTES);
  assert.deepEqual((await records(directory)).map((item) => item.event), ["after_rotation"]);
  log.configure({ name: "test", directory: null });
});

// A script that starts the process log, names what it does, and holds its event loop for 1.5 seconds.
const BLOCKER = `
import { log, startProcessLog } from ${JSON.stringify(new URL("../../dist/server/log.mjs", import.meta.url).href)};
startProcessLog("blocker", { purpose: "test" });
log.doing("index", "root/app embedding");
setTimeout(async () => {
  const until = Date.now() + 1500;
  while (Date.now() < until);
  setTimeout(async () => { await log.flush(); process.exit(0); }, 400);
}, 100);
`;

test("a process that holds its event loop past the limit logs how long and what it was doing", async (t) => {
  const directory = await folder(t), script = path.join(directory, "blocker.mjs");
  await writeFile(script, BLOCKER);
  const child = spawn(process.execPath, [script], { env: isolatedEnv({ PRISM_LOG_DIR: directory, PRISM_LOG_LEVEL: "info" }), stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const written = await records(directory);
  assert.equal(written[0].event, "process_started");
  assert.equal(written[0].purpose, "test");
  const stall = written.find((record) => record.event === "event_loop_blocked");
  assert.ok(stall, JSON.stringify(written));
  assert.ok(stall.blockedMs >= 1000 && stall.blockedMs < 3000, `blocked ${stall.blockedMs} ms`);
  assert.deepEqual(stall.activity, { index: "root/app embedding" });
});

test("the MCP server logs its start and end", async (t) => {
  const directory = await folder(t);
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_LOG_DIR: directory, PRISM_LOG_LEVEL: "info", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) });
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url))], { cwd: directory, env, stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await exited;
  const events = (await records(directory)).map((record) => [record.process, record.event]);
  assert.deepEqual(events.slice(0, 1), [["mcp", "process_started"]]);
  assert.ok(events.some(([, event]) => event === "process_stopping"), JSON.stringify(events));
});
