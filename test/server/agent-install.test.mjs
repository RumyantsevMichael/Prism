import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, actionOf, apply, get, installRecord, listing, setSettings } from "./fixtures/acp-agents.mjs";
import { agentProgram, binaryAgent, packageTools, platformKey, registryFixture } from "./fixtures/acp-registry.mjs";
import { escapingLinkArchive, serveBytes, uvTool } from "./fixtures/agent-install-tools.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/acp-agents.md §5, §6, §7, §8, §10, §11, and §18.
// Contract clauses 47 to 57 of docs/plans/harness-client-protocol/slice.md: an install, update, or removal of a registry agent
// asks a native dialog first, checks what it downloads, runs no script, and changes only the agent's own folders.

const posixOnly = process.platform === "win32" ? "the fake agent and the stub tools are POSIX scripts" : false;
const agentsFolder = (s) => path.join(s.app, "agents");
const act = (s, action, id) => apply(s.base, { action, target: `agent:${id}`, input: {}, revision: null }, s.headers);
const current = (s, id) => JSON.parse(readFileSync(path.join(agentsFolder(s), id, "current.json"), "utf8")).version;
const tree = (folder) => (existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : []);
const hostValues = async (s) => actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "initiative.host").fields[0].options.map((item) => item.value);

// A uvx registry entry of fast-agent at a version.
const fastAgent = (version) => ({ id: "fast-agent", name: "fast-agent", version, authors: ["F"], license: "Apache-2.0", repository: "https://example.invalid/fast", description: "Fast.", distribution: { uvx: { package: `fast-agent-acp==${version}`, args: ["-x"] } } });

async function setup(t, { dialog = { code: 0 } } = {}) {
  const s = await acpFixture(t, { dialog });
  const registry = await registryFixture(t, s);
  return { s, registry };
}

test("clauses 47, 48, 54: an install asks a native dialog naming the agent, then lays out its folder and becomes a host", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const entry = await binaryAgent(s, registry, { id: "opencode", name: "OpenCode", version: "2.3.2", license: "MIT" });
  registry.setAgents([entry]);
  const outside = tree(s.app).filter((name) => !name.startsWith("agents"));
  const installed = await act(s, "agents.install", "opencode");
  assert.equal(installed.status, 200, installed.text);
  assert.equal(s.dialogs().length, 1);
  const { text } = s.dialogs()[0];
  for (const part of ["OpenCode", "Fake Authors", "2.3.2", "MIT", "https://example.invalid/opencode", entry.distribution.binary[platformKey()].archive, "It runs with your permissions on this computer."]) assert.ok(text.includes(part), `the dialog names ${part}`);
  const record = JSON.parse(readFileSync(path.join(agentsFolder(s), "opencode", "2.3.2", "install.json"), "utf8"));
  assert.deepEqual([record.id, record.version, record.command, record.args], ["opencode", "2.3.2", path.join(agentsFolder(s), "opencode", "2.3.2", "agent"), ["opencode"]]);
  assert.ok(!Number.isNaN(Date.parse(record.installedAt)));
  assert.equal(current(s, "opencode"), "2.3.2");
  assert.ok((await hostValues(s)).includes("acp-opencode"));
  assert.deepEqual(tree(s.app).filter((name) => !name.startsWith("agents") && !name.startsWith("launches")), outside.filter((name) => !name.startsWith("launches")), "nothing outside the agents folder changed");
});

test("clauses 48, 52: a declined dialog downloads nothing, installs nothing, and refuses the action", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t, { dialog: { code: 1 } });
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode" })]);
  const refused = await act(s, "agents.install", "opencode");
  assert.equal(refused.json.code, "confirmation_declined");
  assert.deepEqual(registry.requests().filter((url) => url !== "/registry.json"), [], "no archive was fetched");
  assert.deepEqual(tree(agentsFolder(s)), []);
});

test("clause 53: a download whose checksum differs installs nothing, keeps nothing, and names both checksums", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const entry = await binaryAgent(s, registry, { id: "opencode" });
  const listed = entry.distribution.binary[platformKey()];
  registry.setAgents([{ ...entry, distribution: { binary: { [platformKey()]: { ...listed, sha256: "0".repeat(64) } } } }]);
  const refused = await act(s, "agents.install", "opencode");
  assert.equal(refused.json.code, "install_mismatch");
  assert.ok(refused.json.message.includes("0".repeat(64)) && refused.json.message.includes(listed.sha256));
  assert.deepEqual(tree(agentsFolder(s)).filter((name) => !name.startsWith(".")), []);
  assert.ok(!(await hostValues(s)).includes("acp-opencode"));
});

test("clause 49: an archive entry that would land outside the version folder refuses the install", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const archive = await registry.addArchive("escape.zip", { agent: agentProgram(s), "../escape.txt": { text: "x" } }, { kind: "zip" });
  registry.setAgents([{ id: "escape", name: "Escape", version: "1.0.0", authors: ["A"], license: "MIT", repository: "https://example.invalid/escape", description: "x", distribution: { binary: { [platformKey()]: { archive: archive.url, cmd: "./agent", sha256: archive.sha256 } } } }]);
  const refused = await act(s, "agents.install", "escape");
  assert.ok(refused.status >= 400);
  assert.equal(s.dialogs().length, 1, "the install was confirmed and refused at extraction");
  assert.equal(existsSync(path.join(agentsFolder(s), "escape", "escape.txt")), false);
  assert.equal(existsSync(path.join(agentsFolder(s), "escape.txt")), false);
  assert.equal(existsSync(path.join(agentsFolder(s), "escape", "current.json")), false);
});

test("clause 49: a .zip build installs like a .tar.gz one, and its program is not run by the install", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "zipped", kind: "zip" })]);
  const installed = await act(s, "agents.install", "zipped");
  assert.equal(installed.status, 200, installed.text);
  assert.ok(existsSync(path.join(agentsFolder(s), "zipped", "1.0.0", "agent")));
  assert.deepEqual(s.entries().filter((entry) => entry.kind === "start"), [], "the install ran no code of the download");
});

test("clauses 50, 52: an npx install locks its dependencies before the dialog, installs from the lock without scripts, and checks the version", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const ran = await packageTools(s);
  registry.setAgents([{ id: "gemini", name: "Gemini CLI", version: "0.70.0", authors: ["Google"], license: "Apache-2.0", repository: "https://example.invalid/gemini", description: "Gemini.", distribution: { npx: { package: "@google/gemini-cli@0.70.0", args: ["--acp"] } } }]);
  const installed = await act(s, "agents.install", "gemini");
  assert.equal(installed.status, 200, installed.text);
  const npm = ran().filter((entry) => entry.tool === "npm");
  assert.equal(npm.length, 2);
  assert.ok(npm[0].argv.includes("--package-lock-only") && npm[0].argv.includes("--ignore-scripts"), JSON.stringify(npm[0].argv));
  assert.deepEqual([npm[1].argv[0], npm[1].argv.includes("--ignore-scripts")], ["ci", true]);
  for (const entry of npm) assert.ok(entry.env.npm_config_cache?.startsWith(agentsFolder(s)), "npm's cache stays in Prism's agents folder");
  assert.equal(current(s, "gemini"), "0.70.0");
});

test("clause 53: an npx install whose package version differs from the registry's installs nothing", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await packageTools(s, { npmVersion: "0.71.0" });
  registry.setAgents([{ id: "gemini", name: "Gemini CLI", version: "0.70.0", authors: ["Google"], license: "Apache-2.0", repository: "https://example.invalid/gemini", description: "Gemini.", distribution: { npx: { package: "@google/gemini-cli@0.70.0" } } }]);
  const refused = await act(s, "agents.install", "gemini");
  assert.equal(refused.json.code, "install_mismatch");
  assert.ok(refused.json.message.includes("0.70.0") && refused.json.message.includes("0.71.0"));
  assert.equal(existsSync(path.join(agentsFolder(s), "gemini", "current.json")), false);
});

test("clauses 51, 52: a uvx install compiles its locked requirements before the dialog and syncs them without builds", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const ran = await uvTool(s);
  registry.setAgents([fastAgent("0.10.1")]);
  await s.setDialog({ code: 1 });
  await act(s, "agents.install", "fast-agent");
  const before = ran().filter((entry) => entry.tool === "uv");
  assert.ok(before.length >= 1 && before.every((entry) => entry.argv.includes("compile")), "only the lock is resolved before the dialog");
  await s.setDialog({ code: 0 });
  const installed = await act(s, "agents.install", "fast-agent");
  assert.equal(installed.status, 200, installed.text);
  const sync = ran().filter((entry) => entry.tool === "uv" && entry.argv.includes("sync"));
  assert.equal(sync.length, 1);
  assert.ok(sync[0].argv.includes("--no-build"));
  const record = JSON.parse(readFileSync(path.join(agentsFolder(s), "fast-agent", "0.10.1", "install.json"), "utf8"));
  assert.equal(record.command, path.join(agentsFolder(s), "fast-agent", "0.10.1", "venv", "bin", "fast-agent-acp"), "the agent runs the program that its package laid out in the virtual environment");
  assert.ok(existsSync(record.command));
});


test("clauses 51, 53: a uvx install whose locked requirements do not pin the registry's package and version installs nothing", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await uvTool(s, { lock: "fast-agent-acp==0.9.0" });
  registry.setAgents([fastAgent("0.10.1")]);
  const refused = await act(s, "agents.install", "fast-agent");
  assert.equal(refused.json.code, "install_mismatch", refused.text);
  assert.ok(refused.json.message.includes("0.10.1") && refused.json.message.includes("0.9.0"), refused.json.message);
  assert.equal(existsSync(path.join(agentsFolder(s), "fast-agent", "current.json")), false);
  assert.ok(!(await hostValues(s)).includes("acp-fast-agent"));
});

test("clauses 51, 55: a uvx update whose virtual environment holds no program for its package keeps the earlier version current", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await uvTool(s);
  registry.setAgents([fastAgent("0.10.1")]);
  assert.equal((await act(s, "agents.install", "fast-agent")).status, 200);
  await uvTool(s, { programs: false });
  registry.setAgents([fastAgent("0.10.2")]);
  const refused = await act(s, "agents.update", "fast-agent");
  assert.equal(refused.json.code, "install_failed", refused.text);
  assert.match(refused.json.message, /fast-agent-acp/);
  assert.equal(current(s, "fast-agent"), "0.10.1");
  assert.ok(existsSync(path.join(agentsFolder(s), "fast-agent", "0.10.1", "venv", "bin", "fast-agent-acp")), "the earlier version stays in place");
  assert.ok((await hostValues(s)).includes("acp-fast-agent"), "the agent is still offered as a host");
});

test("clauses 48, 54: every uv run of an install forbids uv to download a Python of its own", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const ran = await uvTool(s);
  registry.setAgents([fastAgent("0.10.1")]);
  assert.equal((await act(s, "agents.install", "fast-agent")).status, 200);
  const runs = ran();
  assert.ok(runs.length >= 3, "compile, venv, and sync ran");
  assert.deepEqual(runs.map((entry) => [entry.argv.slice(0, 2).join(" "), entry.env.UV_PYTHON_DOWNLOADS]), runs.map((entry) => [entry.argv.slice(0, 2).join(" "), "never"]));
});

test("clauses 49, 54: an archive link that leads outside the version folder only when followed refuses the install and writes nothing outside", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const escaped = path.join(path.dirname(s.app), `escaped-${process.pid}.json`);
  const archive = await serveBytes(t, "evil-1.0.0.tar.gz", await escapingLinkArchive(agentProgram(s).text, escaped));
  registry.setAgents([{ id: "evil", name: "Evil", version: "1.0.0", authors: ["E"], license: "MIT", repository: "https://example.invalid/evil", description: "x", distribution: { binary: { [platformKey()]: { archive: archive.url, cmd: "./agent", sha256: archive.sha256 } } } }]);
  const refused = await act(s, "agents.install", "evil");
  assert.ok(refused.status >= 400, refused.text);
  assert.equal(existsSync(escaped), false, "no file is written where the link leads");
  assert.equal(existsSync(path.join(agentsFolder(s), "evil", "current.json")), false);
  assert.equal(existsSync(path.join(agentsFolder(s), "evil", "1.0.0")), false, "nothing of the refused install is kept");
});

test("clauses 3, 55: an update whose registry environment breaks a declaration rule is refused and keeps the earlier version current and offered", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" })]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  const next = await binaryAgent(s, registry, { id: "opencode", version: "1.1.0" });
  const build = next.distribution.binary[platformKey()];
  registry.setAgents([{ ...next, distribution: { binary: { [platformKey()]: { ...build, env: { "BAD-NAME": "x" } } } } }]);
  const refused = await act(s, "agents.update", "opencode");
  assert.ok(refused.status >= 400, refused.text);
  assert.equal(current(s, "opencode"), "1.0.0");
  assert.ok(existsSync(path.join(agentsFolder(s), "opencode", "1.0.0", "agent")), "the earlier version stays in place");
  const option = actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "initiative.host").fields[0].options.find((item) => item.value === "acp-opencode");
  assert.deepEqual([option?.value, option?.reason ?? null], ["acp-opencode", null], "the agent is still offered as a usable host");
});

test("clauses 47, 55: an update installs the newer version before it becomes current, and a failed update keeps the earlier one", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" })]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  const broken = await binaryAgent(s, registry, { id: "opencode", version: "1.1.0" });
  registry.setAgents([{ ...broken, distribution: { binary: { [platformKey()]: { ...broken.distribution.binary[platformKey()], sha256: "1".repeat(64) } } } }]);
  assert.equal((await act(s, "agents.update", "opencode")).json.code, "install_mismatch");
  assert.equal(current(s, "opencode"), "1.0.0");
  assert.ok(existsSync(path.join(agentsFolder(s), "opencode", "1.0.0", "agent")));
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.2.0" })]);
  const updated = await act(s, "agents.update", "opencode");
  assert.equal(updated.status, 200, updated.text);
  assert.equal(current(s, "opencode"), "1.2.0");
  await settled(() => existsSync(path.join(agentsFolder(s), "opencode", "1.0.0")), false);
  assert.equal(existsSync(path.join(agentsFolder(s), "opencode", "1.0.0")), false, "the earlier version is removed once nothing runs on it");
});

test("clause 56: a removal deletes every folder of the agent, which is then no host, and is refused while a session runs on it", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.2" });
  await s.setPlan({ opencode: { hold: true } });
  await setSettings(s.root, INITIATIVE, { host: "acp-opencode" });
  const launched = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(launched.status, 200, launched.text);
  await settled(() => s.requests("session/prompt").length, 1);
  assert.equal((await act(s, "agents.remove", "opencode")).json.code, "agent_running");
  await apply(s.base, { action: "launch.stop", target: `launch:${launched.json.launch.id}`, input: {}, revision: null }, s.headers);
  await settled(async () => (await get(s.base, "api/launches")).json.launches.find((item) => item.id === launched.json.launch.id)?.state, "stopped");
  const removed = await act(s, "agents.remove", "opencode");
  assert.equal(removed.status, 200, removed.text);
  assert.equal(existsSync(path.join(agentsFolder(s), "opencode")), false);
  assert.ok(!(await hostValues(s)).includes("acp-opencode"));
  assert.equal(registry.requests().length, 0, "a removal reads nothing from the registry");
});

test("clause 57: a second install while one runs is refused", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t, { dialog: { code: 0 } });
  registry.setAgents([await binaryAgent(s, registry, { id: "one" }), await binaryAgent(s, registry, { id: "two" })]);
  registry.hold();
  const first = act(s, "agents.install", "one");
  await settled(() => registry.requests().some((url) => url.startsWith("/one-")), true);
  const second = await act(s, "agents.install", "two");
  assert.equal(second.json.code, "install_running");
  registry.release();
  assert.equal((await first).status, 200);
  assert.equal(existsSync(path.join(agentsFolder(s), "two")), false);
});

test("clause 47: an install reads the registry again and installs the version it lists now", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" })]);
  await get(s.base, "api/coding-agents", s.headers);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.0.1" })]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  assert.equal(current(s, "opencode"), "1.0.1");
});
