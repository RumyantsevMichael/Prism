import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, actionOf, apply, fakeEntry, get, installRecord, listing } from "./fixtures/acp-agents.mjs";

// Requirements: docs/requirements/acp-agents.md §12, §13, §14, and docs/requirements/launch-run-configuration.md §2.
// Contract clauses 1 to 9 of docs/plans/harness-client-protocol/slice.md: which ACP agents Prism finds, where their commands
// come from, and that every host list follows the declaration file and the install records without a restart.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const hostOptions = async (s) => actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "initiative.host").fields[0].options;
const codingAgents = async (s) => (await get(s.base, "api/coding-agents", s.headers)).json;

test("clauses 1, 2, 3, 8: declared agents follow Claude Code and Codex as acp-<id> hosts, in declaration order, with their labels", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t, { hosts: ["claude"] });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" }), fakeEntry(s, "goose", { label: "Goose", env: { FAKE_DECLARED: "yes" }, autoMode: "auto", resumeCommand: "goose session resume {session}" }), { id: "missing", label: "Missing agent", command: "no-such-agent" }]);
  const options = await hostOptions(s);
  assert.deepEqual(options.map((item) => [item.value, item.label]), [["claude-code", "Claude Code"], ["codex", "Codex"], ["acp-gemini", "Gemini CLI"], ["acp-goose", "Goose"], ["acp-missing", "Missing agent"]]);
  assert.equal(options[2].reason, null);
  assert.equal(options[1].reason, "Codex was not found: no codex executable on PATH.");
  assert.equal(options[4].reason, "Missing agent was not found: no no-such-agent executable on PATH.");
});

test("clause 2: without PRISM_ACP_AGENTS and without a declaration file, no ACP agent is a host", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await rm(s.declarations, { force: true });
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex"]);
  const listed = await codingAgents(s);
  assert.deepEqual(listed.agents.filter((agent) => agent.origin === "declared"), []);
});

test("clauses 3, 5: an entry that breaks a rule is no host, and the coding agents list names the rule it breaks", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([
    fakeEntry(s, "good"),
    fakeEntry(s, "good", { label: "Second good" }),
    { id: "relative", label: "Relative", command: "./agent" },
    fakeEntry(s, "badenv", { env: { "BAD-NAME": "x" } }),
    fakeEntry(s, "manyargs", { args: Array.from({ length: 33 }, () => "x") }),
    fakeEntry(s, "noresume", { resumeCommand: "agent resume" }),
    { id: "Bad Id", label: "Bad", command: "x" }
  ]);
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex", "acp-good"]);
  const declared = (await codingAgents(s)).agents.filter((agent) => agent.origin === "declared");
  const reasons = Object.fromEntries(declared.map((agent) => [agent.id, agent.launch]));
  assert.deepEqual(reasons.good, { available: true, reason: null });
  for (const id of ["relative", "badenv", "manyargs", "noresume"]) {
    assert.equal(reasons[id].available, false, id);
    assert.match(reasons[id].reason, /command|env|args|resumeCommand/, `${id} names the rule it breaks`);
  }
  assert.equal(declared.filter((agent) => agent.id === "good").length, 1, "a repeated id lists once");
});

test("clause 5: an unparsable declaration file declares no agent and is listed once with its reason", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(s.declarations, "{not json");
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex"]);
  const declared = (await codingAgents(s)).agents.filter((agent) => agent.origin === "declared");
  assert.equal(declared.length, 1);
  assert.equal(declared[0].launch.available, false);
  assert.match(declared[0].launch.reason, /acp-agents\.json/);
});

test("clause 6: a declared claude-acp or codex-acp is no host and says that Prism runs them through its own integrations", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "claude-acp"), fakeEntry(s, "codex-acp")]);
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex"]);
  const declared = (await codingAgents(s)).agents.filter((agent) => agent.origin === "declared");
  assert.deepEqual(declared.map((agent) => agent.launch.reason), ["Prism runs Claude Code and Codex through its own integrations.", "Prism runs Claude Code and Codex through its own integrations."]);
});

test("clause 4: a page request that names a command, arguments, environment, prompt, or folder for an agent is refused and starts nothing", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini")]);
  for (const extra of [{ command: "/bin/sh" }, { args: ["-c", "id"] }, { env: { X: "1" } }, { prompt: "rm -rf ." }, { cwd: "/" }]) {
    const refused = await apply(s.base, { action: "initiative.host", target: TARGET(INITIATIVE), input: { value: "acp-gemini", ...extra }, revision: null }, s.headers);
    assert.equal(refused.status, 400, JSON.stringify(extra));
    assert.equal(refused.json.code, "invalid_input");
    const launch = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: extra, revision: null }, s.headers);
    assert.equal(launch.status, 400, JSON.stringify(extra));
    assert.equal(launch.json.code, "invalid_input");
  }
  assert.deepEqual(s.entries().filter((entry) => entry.kind === "start"), [], "no agent started");
  const chosen = await apply(s.base, { action: "initiative.host", target: TARGET(INITIATIVE), input: { value: "acp-gemini" }, revision: null }, s.headers);
  assert.equal(chosen.status, 200, "the declared agent itself can be chosen without any of those fields");
});

test("clauses 7, 54: an agent declared, installed, or removed while the review server runs appears and disappears without a restart", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex"]);
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex", "acp-gemini"]);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.2" });
  const options = await hostOptions(s);
  assert.deepEqual(options.map((item) => [item.value, item.label]), [["claude-code", "Claude Code"], ["codex", "Codex"], ["acp-opencode", "OpenCode"], ["acp-gemini", "Gemini CLI"]], "installed agents come before declared ones");
  const installed = (await codingAgents(s)).agents.find((agent) => agent.id === "opencode");
  assert.deepEqual([installed.origin, installed.installed, installed.name, installed.license, installed.authors], ["registry", { version: "2.3.2" }, "OpenCode", "MIT", ["Fake Authors"]]);
  await s.declare([]);
  await rm(path.join(s.app, "agents", "opencode"), { recursive: true, force: true });
  assert.deepEqual((await hostOptions(s)).map((item) => item.value), ["claude-code", "codex"]);
});

test("clause 5: a declaration that takes the id of an installed registry agent is no host", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.2" });
  await s.declare([fakeEntry(s, "opencode", { label: "My OpenCode" })]);
  const options = await hostOptions(s);
  assert.deepEqual(options.filter((item) => item.value === "acp-opencode").map((item) => item.label), ["OpenCode"]);
  const declared = (await codingAgents(s)).agents.find((agent) => agent.origin === "declared" && agent.id === "opencode");
  assert.equal(declared.launch.available, false);
  assert.match(declared.launch.reason, /installed/);
});

test("clause 9: the choice of Prism's own runs lists each ACP agent as unavailable with its reason", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  const action = actionOf(await listing(s.base, "machine:prism-runs", s.headers), "machine.prismRuns");
  const gemini = action.fields[0].options.find((item) => item.value === "acp-gemini");
  assert.deepEqual([gemini.label, gemini.reason], ["Gemini CLI", "Prism's own runs do not run on ACP agents."]);
});
