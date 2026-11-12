import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { closeWithServers } from "./fixtures/repository-checkouts.mjs";
import { checkout, eventually, git, isolateGit, ok, remoteFile, syncedWorkspace } from "./fixtures/workspace-artifacts.mjs";

// A host can end a session a fraction of a second after the agent's last write, well before the store's debounced sync comes due:
// Claude Code sends SIGINT and SIGTERM about a tenth of a second apart, and Codex closes the server's input.
// The server hands its pending syncs to a detached process, so the write still reaches the store's remote, and a later session neither repeats it nor conflicts with it.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));

// A Prism server that a test ends the way a host does, by a signal or by closing its input, right after its last result.
async function hostedServer(context, machine, root) {
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, PRISM_REVIEW_APP_DIR: machine.app, CLAUDE_PROJECT_DIR: root, PRISM_STORE_HANDOFF: "on" });
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const close = closeWithServers(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timer);
  });
  context.after(close);
  let next = 1;
  const request = (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return eventually(() => messages.find((message) => message.id === id), 20000, `the response to request ${id}`);
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.316" } });
  return {
    call: (name, args = {}) => request("tools/call", { name, arguments: { projectRoot: root, ...args } }),
    // As Claude Code ends a session: SIGINT, SIGTERM a tenth of a second later, and SIGKILL soon after.
    async endLikeClaudeCode() {
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    },
    // As Codex ends a session: it closes the server's input.
    async endLikeCodex() {
      child.stdin.end();
      await exited;
    }
  };
}

const write = (prism, file, content) => prism.call("update_artifact", { operations: [{ op: "write", path: file, content, expectedVersion: null }] });
const commits = (remote) => Number(git(remote, "rev-list", "--count", "main"));
// A sync waits for the store's sync lock, so once it ends, the detached sync has ended its own, and the test may remove the folder.
const handOffEnded = async (store) => assert.equal((await syncRecordStoreNow(store)).state, "ok");
const savedCopies = async (store) => (await readdir(path.join(store, ".prism-sync", "conflicts"), { recursive: true }).catch(() => [])).length;

for (const [host, end] of [["Claude Code", "endLikeClaudeCode"], ["Codex", "endLikeCodex"]]) {
  test(`a write that ${host} ends the session right after still reaches the store's remote`, async (context) => {
    const place = await syncedWorkspace(context);
    const root = await checkout(place.a, "api");
    const prism = await hostedServer(context, place.a, root);
    ok(await write(prism, "docs/plans/foo/slice.md", "# Foo\n\nFirst.\n"));
    await prism[end]();
    await eventually(() => remoteFile(place.remote, "artifacts/plans/foo/slice.md") === "# Foo\n\nFirst.", 30000, "the handed-off sync pushing the write");
    await handOffEnded(place.storeA);
  });
}

test("a session that starts while the ended one's sync still runs adds its own write once, and saves no conflict", async (context) => {
  const place = await syncedWorkspace(context);
  const root = await checkout(place.a, "api");
  const first = await hostedServer(context, place.a, root);
  ok(await write(first, "docs/plans/foo/slice.md", "# Foo\n\nFirst.\n"));
  await first.endLikeClaudeCode();
  const second = await hostedServer(context, place.a, root);
  ok(await write(second, "docs/plans/bar/slice.md", "# Bar\n\nSecond.\n"));
  await second.endLikeCodex();
  await eventually(() => remoteFile(place.remote, "artifacts/plans/foo/slice.md") && remoteFile(place.remote, "artifacts/plans/bar/slice.md"), 30000, "both writes on the remote");
  await handOffEnded(place.storeA);
  assert.equal(await savedCopies(place.storeA), 0, "no version was saved aside");
  assert.equal(git(place.storeA, "status", "--porcelain", "--", "artifacts"), "", "nothing of either write is left uncommitted");
});

test("after a handed-off sync pushed the write, the next sync finds nothing to commit", async (context) => {
  const place = await syncedWorkspace(context);
  const root = await checkout(place.a, "api");
  const prism = await hostedServer(context, place.a, root);
  ok(await write(prism, "docs/plans/foo/slice.md", "# Foo\n\nFirst.\n"));
  await prism.endLikeClaudeCode();
  await eventually(() => remoteFile(place.remote, "artifacts/plans/foo/slice.md"), 30000, "the handed-off sync pushing the write");
  // The detached sync may still be finishing, so this sync waits for its lock.
  const pushed = commits(place.remote);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.equal(commits(place.remote), pushed, "no further commit reached the remote");
});

test("a result that carries a note also carries it in its structured content, which is all that Claude Code shows its agent", async (context) => {
  const place = await syncedWorkspace(context);
  const root = await checkout(place.a, "api", { files: { "docs/plans/old/slice.md": "# Old\n" } });
  const prism = await hostedServer(context, place.a, root);
  const response = await prism.call("get_artifact", {});
  const result = ok(response) && response.result;
  assert.ok(result.content.length > 1, "the move report is a note after the result");
  assert.deepEqual(result.structuredContent.notes, result.content.slice(1).map((item) => item.text));
  assert.match(result.structuredContent.notes.join("\n"), /docs\/plans\/old\/slice\.md/);
  await prism.endLikeCodex();
});
