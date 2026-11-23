import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { settled } from "./fixtures/wait.mjs";
import { hostConversation, redactSessionId } from "../../dist/server/session/launch-hosts.mjs";
import { keptStderr } from "../../dist/server/session/launch-supervisor.mjs";

// How a launched run on an ACP agent ends when its agent exits before its prompt answers, and how its kept standard error and
// its reasons hold no part of the agent's session id, whatever that id's characters and wherever the kept tail is cut.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const KEEP = 64 * 1024;

async function ended(t, plan) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(result.status, 200, result.text);
  const id = result.json.launch.id;
  return settled(async () => (await launches(s)).find((item) => item.id === id), (item) => item && !["running", "waiting"].includes(item.state));
}

// Every substring of at least 8 characters of the id, in any letter case, that the text holds.
const leaks = (text, id) => {
  const found = [];
  const lower = text.toLowerCase();
  for (let start = 0; start + 8 <= id.length; start += 1) {
    const part = id.slice(start, start + 8).toLowerCase();
    if (lower.includes(part)) found.push(part);
  }
  return found;
};

test("an agent that exits 0 before its prompt answers fails the run with its exit status", { skip: posixOnly }, async (t) => {
  const quit = await ended(t, { exitBeforeAnswer: 0 });
  assert.equal(quit.state, "failed");
  assert.match(quit.reason, /^Gemini CLI ended with exit code 0\./);
  const answered = await ended(t, {});
  assert.equal(answered.state, "ended-without-result");
  assert.equal(answered.reason, null);
});

test("an ACP session id of any characters is redacted literally", () => {
  const id = "sess:a/b+c.(1)?*";
  assert.equal(redactSessionId(`one ${id} two ${id.toUpperCase()} three sess:aXb+c`, id), "one <host session id> two <host session id> three sess:aXb+c");
  assert.equal(redactSessionId("nothing named", ""), "nothing named");
});

test("the kept standard error holds no part of an id that crossed the cut of the held tail", () => {
  const id = "sess:0123456789abcdef/ghijklmnop";
  // The held tail starts inside the id, as when the tail kept while the agent ran was cut there, and holds it whole later too.
  const held = Buffer.from(`${id.slice(10)} tail\n${"x".repeat(KEEP)}\nlater ${id} end\n`, "utf8");
  const kept = keptStderr(held, true, [null, id]);
  assert.deepEqual(leaks(kept, id), []);
  assert.ok(Buffer.byteLength(kept, "utf8") <= KEEP);
  assert.match(kept, /later <host session id> end\n$/);
  // An id that the kept size's cut would split is replaced before the cut, so no suffix of it remains at the kept text's start.
  const straddling = Buffer.from(`${"y".repeat(100)}${id}${"z".repeat(KEEP - 10)}`, "utf8");
  assert.deepEqual(leaks(keptStderr(straddling, false, [id]), id), []);
  assert.equal(keptStderr(Buffer.from(`short ${id}\n`), false, [id]), "short <host session id>\n");
});

test("an ACP agent's session id outside the command-line pattern is redacted from a run's reasons and not recorded", () => {
  const id = "sess:a/b c";
  const conversation = hostConversation("acp-gemini", {
    initiative: INITIATIVE,
    checkout: "/work/demo",
    coordinator: { model: "fake-large", effort: null },
    send: () => {},
    closeInput: () => {},
    acp: { label: "Gemini CLI", autoMode: null, env: {}, launch: "launch-1", agentPid: () => null }
  });
  conversation.start();
  const options = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fake-small", options: [{ value: "fake-large", name: "Large" }, { value: "fake-small", name: "Small" }] }];
  for (const line of [
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: {} } },
    { jsonrpc: "2.0", id: 2, result: { sessionId: id, configOptions: options } },
    { jsonrpc: "2.0", id: 3, error: { code: -32603, message: `Session ${id} could not set the model` } }
  ]) conversation.push(Buffer.from(`${JSON.stringify(line)}\n`));
  conversation.end();
  const { facts } = conversation;
  assert.equal(facts.hostSessionId, null);
  assert.equal(facts.agentSessionId, id);
  assert.equal(facts.hostError, "Session <host session id> could not set the model");
  assert.equal(facts.settled, true);
  assert.deepEqual(leaks(keptStderr(Buffer.from(`agent ${id} failed\n`), false, [facts.hostSessionId, facts.agentSessionId]), id), []);
});
