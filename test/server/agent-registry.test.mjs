import assert from "node:assert/strict";
import test from "node:test";
import { acpFixture, fakeEntry, get, installRecord } from "./fixtures/acp-agents.mjs";
import { OTHER_PLATFORM, binaryAgent, packageTools, platformKey, registryFixture } from "./fixtures/acp-registry.mjs";

// Requirements: docs/requirements/acp-agents.md §4, §9, §12, §17, and §18.
// Contract clauses 42 to 46, with clauses 6 and 43's marks, of docs/plans/harness-client-protocol/slice.md: which registry agents
// Prism lists for this computer, with what details, which ones it can install, and what stays usable while the registry is down.

const posixOnly = process.platform === "win32" ? "the fake agent and the stub tools are POSIX scripts" : false;
const listed = async (s) => (await get(s.base, "api/coding-agents", s.headers)).json;
const byId = (list) => Object.fromEntries(list.agents.map((agent) => [`${agent.origin}:${agent.id}`, agent]));

async function setup(t) {
  const s = await acpFixture(t);
  const registry = await registryFixture(t, s);
  return { s, registry };
}

test("clauses 42, 43: a registry agent lists its name, authors, version, license, source, and description, and its install is offered", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", name: "OpenCode", version: "2.3.2" })]);
  const list = await listed(s);
  assert.equal(list.registry.state, "ready");
  assert.equal(list.registry.reason, null);
  assert.ok(!Number.isNaN(Date.parse(list.registry.readAt)));
  const agent = byId(list)["registry:opencode"];
  assert.deepEqual({ ...agent, update: agent.update }, {
    id: "opencode", host: "acp-opencode", name: "OpenCode", version: "2.3.2", authors: ["Fake Authors"], license: "MIT", source: "https://example.invalid/opencode",
    description: "OpenCode for tests.", origin: "registry", installed: null, update: null, launch: { available: false, reason: "OpenCode is not installed." }, install: { available: true, reason: null }
  });
});

test("clause 42: the index is read once in 10 minutes", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([]);
  await listed(s);
  await listed(s);
  assert.equal(registry.requests().filter((url) => url === "/registry.json").length, 1);
});

test("clause 44: only agents with a build for this computer, or an npx or uvx package, are listed", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([
    await binaryAgent(s, registry, { id: "here" }),
    await binaryAgent(s, registry, { id: "elsewhere", platform: OTHER_PLATFORM }),
    { id: "gemini", name: "Gemini CLI", version: "0.70.0", authors: ["Google"], license: "Apache-2.0", repository: "https://example.invalid/gemini", description: "Gemini.", distribution: { npx: { package: "@google/gemini-cli@0.70.0", args: ["--acp"] } } },
    { id: "fast-agent", name: "fast-agent", version: "0.10.1", authors: ["F"], license: "Apache-2.0", website: "https://example.invalid/fast", description: "Fast.", distribution: { uvx: { package: "fast-agent-acp==0.10.1", args: ["-x"] } } }
  ]);
  const ids = (await listed(s)).agents.filter((agent) => agent.origin === "registry").map((agent) => agent.id).sort();
  assert.deepEqual(ids, ["fast-agent", "gemini", "here"]);
  assert.equal(byId(await listed(s))["registry:fast-agent"].source, "https://example.invalid/fast", "the website stands in for a missing repository");
});

test("clause 6: the registry's Claude and Codex adapters are never listed", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  registry.setAgents([await binaryAgent(s, registry, { id: "claude-acp" }), await binaryAgent(s, registry, { id: "codex-acp" }), await binaryAgent(s, registry, { id: "goose" })]);
  assert.deepEqual((await listed(s)).agents.filter((agent) => agent.origin === "registry").map((agent) => agent.id), ["goose"]);
});

test("clause 45: an agent Prism cannot install safely is listed with the reason it cannot be installed", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  const npx = (id, pkg) => ({ id, name: id, version: "1.0.0", authors: ["A"], license: "MIT", repository: "https://example.invalid/x", description: "x", distribution: { npx: { package: pkg } } });
  const uvx = (id, pkg) => ({ id, name: id, version: "1.0.0", authors: ["A"], license: "MIT", repository: "https://example.invalid/x", description: "x", distribution: { uvx: { package: pkg } } });
  registry.setAgents([
    await binaryAgent(s, registry, { id: "nosum", sha: false }),
    { ...(await binaryAgent(s, registry, { id: "sevenzip" })), distribution: { binary: { [platformKey()]: { archive: `${registry.base}/agent.7z`, cmd: "./agent", sha256: "0".repeat(64) } } } },
    npx("floating", "fake-agent@^1.0.0"),
    npx("pinned", "fake-agent@1.0.0"),
    uvx("unpinned", "fake-agent-acp"),
    uvx("uvpinned", "fake-agent-acp==1.0.0")
  ]);
  const agents = byId(await listed(s));
  const reason = (id) => agents[`registry:${id}`].install;
  assert.equal(reason("nosum").available, false);
  assert.match(reason("nosum").reason, /SHA-256|sha256|checksum/i);
  assert.match(reason("sevenzip").reason, /\.tar\.gz|\.zip|archive/);
  assert.match(reason("floating").reason, /exact version/);
  assert.match(reason("pinned").reason, /npm/, "npm is not on PATH");
  assert.match(reason("unpinned").reason, /==/);
  assert.match(reason("uvpinned").reason, /uv/, "uv is not on PATH");
});

test("clause 45: a pinned npx or uvx agent is installable once npm or uv is on PATH", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await packageTools(s);
  registry.setAgents([
    { id: "pinned", name: "pinned", version: "1.0.0", authors: ["A"], license: "MIT", repository: "https://example.invalid/x", description: "x", distribution: { npx: { package: "fake-agent@1.0.0" } } },
    { id: "uvpinned", name: "uvpinned", version: "1.0.0", authors: ["A"], license: "MIT", repository: "https://example.invalid/x", description: "x", distribution: { uvx: { package: "fake-agent-acp==1.0.0" } } }
  ]);
  const agents = byId(await listed(s));
  assert.deepEqual([agents["registry:pinned"].install, agents["registry:uvpinned"].install], [{ available: true, reason: null }, { available: true, reason: null }]);
});

test("clauses 9, 43: an installed agent is marked installed, and a newer registry version shows as its update", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.1" });
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", name: "OpenCode", version: "2.3.2" })]);
  const agent = byId(await listed(s))["registry:opencode"];
  assert.deepEqual([agent.installed, agent.update, agent.launch.available], [{ version: "2.3.1" }, { version: "2.3.2" }, true]);
});

test("clause 46: while the registry cannot be read, installed and declared agents stay listed and launchable, and installs are unavailable", { skip: posixOnly }, async (t) => {
  const { s, registry } = await setup(t);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.2" });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  registry.down(503);
  const list = await listed(s);
  assert.equal(list.registry.state, "unavailable");
  assert.match(list.registry.reason, /503/);
  const agents = byId(list);
  assert.deepEqual([agents["registry:opencode"].launch.available, agents["registry:opencode"].installed], [true, { version: "2.3.2" }]);
  assert.equal(agents["registry:opencode"].name, "OpenCode", "the kept details of the install stand in");
  assert.equal(agents["registry:opencode"].update, null);
  assert.deepEqual([agents["registry:opencode"].install.available, agents["registry:opencode"].install.reason], [false, list.registry.reason]);
  assert.equal(agents["declared:gemini"].launch.available, true);
});

test("clause 42: an index URL that is neither https nor loopback http is not read", { skip: posixOnly }, async (t) => {
  const { s } = await setup(t);
  process.env.PRISM_ACP_REGISTRY_URL = "http://registry.example.invalid/registry.json";
  const list = await listed(s);
  assert.equal(list.registry.state, "unavailable");
  assert.match(list.registry.reason, /https/);
});
