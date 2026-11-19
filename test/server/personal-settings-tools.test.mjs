import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

// Requirements: docs/requirements/personal-settings.md §1, §2, §4, §5.
// Contract: docs/plans/personal-settings/slice.md clauses 1 to 12; each test names the clauses it checks at the start of its title.
// The agents' tools read and change the person's own settings, which Prism keeps in its application folder and never in a project.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLAUDE_SERVER = path.join(ROOT, "dist/server/mcp.mjs");
const CODEX_LAUNCHER = path.join(ROOT, "bin/prism-mcp");
const NATIVE_MANIFEST = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));
const FILE = "personal-settings.json";
const NAMES = ["interactionStyle", "reviewBrowser", "reviewBrowserOnStart", "sessionOffer"];
const DEFAULTS = { interactionStyle: "structured", reviewBrowser: "auto", reviewBrowserOnStart: "on", sessionOffer: "ask" };
const ALL_DEFAULT = Object.fromEntries(NAMES.map((name) => [name, "default"]));

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

/** A project whose committed configuration records the given lines under ## Interaction, or none when lines is null. */
async function project(context, lines = null) {
  const root = await temporary(context, "prism-personal-project-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  const interaction = lines === null ? "" : `\n## Interaction\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
  await writeFile(path.join(root, ".prism", "workflow.md"), `# Workflow config\n\n## Paths\n- Plans: docs/plans/\n${interaction}`);
  return root;
}

/** Starts one MCP server and returns call(name, args), which resolves to the JSON-RPC response. */
async function server(context, { cwd, env, command = CLAUDE_SERVER }) {
  const child = spawn(process.execPath, [command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  child.on("exit", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(stderr || "MCP stopped")); }
    pending.clear();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await exited;
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
  });
  return { rpc, call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}

/** A fresh application folder and a server that uses it; the server runs in a folder that is no project. */
async function fixture(context, { appDirectory = null } = {}) {
  const app = appDirectory ?? path.join(await temporary(context, "prism-personal-app-"), "state");
  const data = await temporary(context, "prism-personal-data-");
  const cwd = await temporary(context, "prism-personal-cwd-");
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PLUGIN_DATA: data, PRISM_REVIEW_APP_DIR: app, PRISM_NATIVE_ASSET_MANIFEST: NATIVE_MANIFEST });
  delete env.CLAUDE_PROJECT_DIR;
  const { rpc, call } = await server(context, { cwd, env });
  const file = path.join(app, FILE);
  const stored = async () => JSON.parse(await readFile(file, "utf8"));
  const result = async (name, args) => {
    const response = await call(name, args);
    assert.ok(response.result, `${name} answers a result: ${JSON.stringify(response.error)}`);
    return response.result.structuredContent;
  };
  const refusal = async (name, args) => {
    const response = await call(name, args);
    assert.ok(response.error, `${name} is refused: ${JSON.stringify(response.result)}`);
    return response.error;
  };
  return { app, file, env, cwd, rpc, call, result, refusal, stored };
}

const exists = (file) => stat(file).then(() => true, () => false);

test("clauses 1, 9: without a file or a project, get_personal_settings answers the four defaults and writes nothing", async (context) => {
  const { result, file } = await fixture(context);
  const answer = await result("get_personal_settings", {});
  assert.deepEqual(answer.settings, DEFAULTS);
  assert.deepEqual(answer.sources, ALL_DEFAULT);
  assert.deepEqual(answer.adopted, []);
  assert.equal(answer.problem, null);
  assert.equal(await exists(file), false, "a read with nothing to adopt creates no file");
});

test("clauses 9, 10: both tools are listed, get takes an optional projectRoot, and update takes settings", async (context) => {
  const { rpc } = await fixture(context);
  const tools = (await rpc("tools/list")).result.tools;
  const get = tools.find((tool) => tool.name === "get_personal_settings");
  const update = tools.find((tool) => tool.name === "update_personal_settings");
  assert.ok(get && update, "both tools are listed");
  assert.ok(Object.hasOwn(get.inputSchema.properties, "projectRoot"));
  assert.equal((get.inputSchema.required ?? []).includes("projectRoot"), false, "projectRoot is optional");
  assert.ok((update.inputSchema.required ?? []).includes("settings"));
  assert.equal(update.annotations?.readOnlyHint, false);
});

test("clauses 2, 10: update_personal_settings keeps a chosen value in personal-settings.json in the application folder and in no project", async (context) => {
  const { result, file, stored, app } = await fixture(context);
  const root = await project(context);
  const before = Date.now();
  const answer = await result("update_personal_settings", { settings: { interactionStyle: "plain-text", sessionOffer: "off" } });
  assert.deepEqual(answer.settings, { ...DEFAULTS, interactionStyle: "plain-text", sessionOffer: "off" });
  assert.deepEqual(answer.sources, { ...ALL_DEFAULT, interactionStyle: "chosen", sessionOffer: "chosen" });
  assert.deepEqual(answer.adopted, []);
  assert.equal(answer.problem, null);
  assert.equal(JSON.stringify(answer).includes(app), false, "the answer names no storage path");
  const value = await stored();
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(Object.keys(value.settings).sort(), ["interactionStyle", "sessionOffer"]);
  for (const [name, expected] of [["interactionStyle", "plain-text"], ["sessionOffer", "off"]]) {
    const entry = value.settings[name];
    assert.equal(entry.value, expected);
    assert.equal(entry.source, "chosen");
    assert.equal(Object.hasOwn(entry, "from"), false, "a chosen entry names no checkout");
    assert.ok(Date.parse(entry.at) >= before - 1000 && Date.parse(entry.at) <= Date.now() + 1000, `at is the time of the change: ${entry.at}`);
  }
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "only the person can read the file");
  assert.deepEqual((await result("get_personal_settings", { projectRoot: root })).settings, { ...DEFAULTS, interactionStyle: "plain-text", sessionOffer: "off" });
  assert.equal(await exists(path.join(root, ".prism", FILE)), false, "nothing is written into the project");
  assert.equal(await readFile(path.join(root, ".prism", "workflow.md"), "utf8").then((text) => text.includes("plain-text")), false, "the project's configuration is unchanged");
});

test("clauses 2, 3, 10: a later update replaces only its own settings and keeps every other entry, an unknown key included", async (context) => {
  const { result, file, stored } = await fixture(context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, settings: { reviewBrowser: { value: "internal", source: "chosen", at: "2026-11-01T10:00:00.000Z" }, laterSetting: { value: 7, source: "chosen", at: "2026-11-01T10:00:00.000Z" } } }));
  const answer = await result("update_personal_settings", { settings: { interactionStyle: "plain-text" } });
  assert.deepEqual(answer.settings, { ...DEFAULTS, interactionStyle: "plain-text", reviewBrowser: "internal" });
  const value = await stored();
  assert.deepEqual(value.settings.reviewBrowser, { value: "internal", source: "chosen", at: "2026-11-01T10:00:00.000Z" });
  assert.deepEqual(value.settings.laterSetting, { value: 7, source: "chosen", at: "2026-11-01T10:00:00.000Z" });
  assert.equal(value.settings.interactionStyle.value, "plain-text");
  await result("update_personal_settings", { settings: { reviewBrowser: "external" } });
  assert.equal((await stored()).settings.reviewBrowser.value, "external", "a change replaces the setting's own entry");
});

test("clause 11: an unknown setting, a value it does not offer, or no setting is refused with invalid_setting and changes nothing", async (context) => {
  const { refusal, result, file } = await fixture(context);
  await result("update_personal_settings", { settings: { sessionOffer: "off" } });
  const before = await readFile(file, "utf8");
  for (const [settings, setting] of [
    [{ colour: "blue" }, "colour"],
    [{ interactionStyle: "loud" }, "interactionStyle"],
    [{ reviewBrowserOnStart: true }, "reviewBrowserOnStart"],
    [{ reviewBrowser: "internal", sessionOffer: "never" }, "sessionOffer"],
    [{}, null]
  ]) {
    const error = await refusal("update_personal_settings", { settings });
    assert.equal(error.data?.code, "invalid_setting", JSON.stringify(settings));
    assert.equal(error.data?.setting ?? null, setting, `names the first setting it refuses: ${JSON.stringify(settings)}`);
    assert.ok(error.message.length > 0);
  }
  assert.equal(await readFile(file, "utf8"), before, "no refused change reaches the file");
});

test("clause 3: an entry whose value the setting does not offer counts as no personal value", async (context) => {
  const { result, file } = await fixture(context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, settings: { interactionStyle: { value: "loud", source: "chosen", at: "2026-11-01T10:00:00.000Z" }, sessionOffer: "off" } }));
  const answer = await result("get_personal_settings", {});
  assert.deepEqual(answer.settings, DEFAULTS);
  assert.deepEqual(answer.sources, ALL_DEFAULT);
});

test("clauses 4, 11: a file that is not JSON gives settings_unreadable, the repository's values or the defaults, and is never written", async (context) => {
  const { result, refusal, file } = await fixture(context);
  const root = await project(context, ["Interaction style: plain-text"]);
  await mkdir(path.dirname(file), { recursive: true });
  for (const broken of ["{ not json", "[]", "\"text\"", JSON.stringify({ settings: {} })]) {
    await writeFile(file, broken);
    const answer = await result("get_personal_settings", { projectRoot: root });
    assert.equal(answer.problem?.code, "settings_unreadable", broken);
    assert.ok(answer.problem.message.length > 0);
    assert.deepEqual(answer.settings, { ...DEFAULTS, interactionStyle: "plain-text" }, broken);
    assert.deepEqual(answer.sources, { ...ALL_DEFAULT, interactionStyle: "repository" }, broken);
    assert.deepEqual(answer.adopted, [], "nothing is adopted into a file Prism cannot read");
    const error = await refusal("update_personal_settings", { settings: { sessionOffer: "off" } });
    assert.equal(error.data?.code, "settings_unreadable");
    assert.equal(await readFile(file, "utf8"), broken, "the person's file is left as it is");
  }
});

test("clauses 4, 11: a file of another schemaVersion gives settings_unsupported and is never written", async (context) => {
  const { result, refusal, file } = await fixture(context);
  const root = await project(context, ["Session offer: off"]);
  const newer = JSON.stringify({ schemaVersion: 2, settings: { sessionOffer: { value: "ask" } } });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, newer);
  const answer = await result("get_personal_settings", { projectRoot: root });
  assert.equal(answer.problem?.code, "settings_unsupported");
  assert.deepEqual(answer.settings, { ...DEFAULTS, sessionOffer: "off" });
  assert.deepEqual(answer.sources, { ...ALL_DEFAULT, sessionOffer: "repository" });
  assert.equal((await refusal("update_personal_settings", { settings: { sessionOffer: "ask" } })).data?.code, "settings_unsupported");
  assert.equal(await readFile(file, "utf8"), newer);
});

test("clauses 6, 7, 9: the first read for a project that records values adopts each one as a personal value, once", async (context) => {
  const { result, stored } = await fixture(context);
  const root = await project(context, ["Interaction style: plain-text", "Review browser: external", "Review browser on start: off", "Session offer: off"]);
  const before = Date.now();
  const first = await result("get_personal_settings", { projectRoot: root });
  assert.deepEqual(first.settings, { interactionStyle: "plain-text", reviewBrowser: "external", reviewBrowserOnStart: "off", sessionOffer: "off" });
  assert.deepEqual(first.sources, Object.fromEntries(NAMES.map((name) => [name, "adopted"])));
  assert.deepEqual(first.adopted, NAMES, "adopted lists the settings in the order of clause 1");
  const value = await stored();
  for (const name of NAMES) {
    assert.equal(value.settings[name].source, "adopted");
    assert.equal(value.settings[name].from, root, "from is the real path of the checkout it came from");
    assert.ok(Date.parse(value.settings[name].at) >= before - 1000);
  }
  const again = await result("get_personal_settings", { projectRoot: root });
  assert.deepEqual(again.adopted, [], "a value is adopted only once");
  assert.deepEqual(again.sources, first.sources);
  const elsewhere = await result("get_personal_settings", { projectRoot: await project(context) });
  assert.deepEqual(elsewhere.settings, first.settings, "an adopted value applies in every project on the machine");
});

test("clause 6: recorded values match ignoring case and spaces, open means on, and a value no setting offers is not adopted", async (context) => {
  const { result, stored } = await fixture(context);
  const root = await project(context, ["Interaction style:   PLAIN-TEXT  ", "Review browser: Chrome", "Review browser on start: Open", "Session offer: maybe"]);
  const answer = await result("get_personal_settings", { projectRoot: root });
  assert.deepEqual(answer.settings, { ...DEFAULTS, interactionStyle: "plain-text", reviewBrowserOnStart: "on" });
  assert.deepEqual(answer.sources, { ...ALL_DEFAULT, interactionStyle: "adopted", reviewBrowserOnStart: "adopted" });
  assert.deepEqual(answer.adopted, ["interactionStyle", "reviewBrowserOnStart"]);
  assert.deepEqual(Object.keys((await stored()).settings).sort(), ["interactionStyle", "reviewBrowserOnStart"]);
});

test("clauses 5, 7: a personal value wins over the value a repository still records, and only settings without one are adopted", async (context) => {
  const { result, stored } = await fixture(context);
  await result("update_personal_settings", { settings: { sessionOffer: "ask", interactionStyle: "structured" } });
  const root = await project(context, ["Interaction style: plain-text", "Session offer: off", "Review browser: internal"]);
  const answer = await result("get_personal_settings", { projectRoot: root });
  assert.deepEqual(answer.settings, { ...DEFAULTS, reviewBrowser: "internal" });
  assert.deepEqual(answer.sources, { interactionStyle: "chosen", reviewBrowser: "adopted", reviewBrowserOnStart: "default", sessionOffer: "chosen" });
  assert.deepEqual(answer.adopted, ["reviewBrowser"]);
  const value = await stored();
  assert.equal(value.settings.sessionOffer.value, "ask");
  assert.equal(value.settings.sessionOffer.source, "chosen");
  assert.equal(value.settings.interactionStyle.value, "structured");
});

test("clause 7: reads and changes from two servers at once adopt each value once and lose no change", async (context) => {
  const first = await fixture(context);
  const second = await fixture(context, { appDirectory: first.app });
  for (let round = 0; round < 5; round += 1) {
    await rm(first.file, { force: true });
    const root = await project(context, ["Review browser: external", "Session offer: off"]);
    const [read, changed, again] = await Promise.all([
      first.result("get_personal_settings", { projectRoot: root }),
      second.result("update_personal_settings", { settings: { interactionStyle: "plain-text" } }),
      second.result("get_personal_settings", { projectRoot: root })
    ]);
    assert.equal(read.problem, null);
    assert.equal(changed.problem, null);
    const adopted = [...read.adopted, ...again.adopted].sort();
    assert.deepEqual(adopted, ["reviewBrowser", "sessionOffer"], `round ${round}: each value is adopted by exactly one read`);
    const value = await first.stored();
    assert.equal(value.settings.interactionStyle?.value, "plain-text", `round ${round}: the change survives`);
    assert.equal(value.settings.reviewBrowser?.value, "external", `round ${round}`);
    assert.equal(value.settings.sessionOffer?.value, "off", `round ${round}`);
  }
});

test("clause 8: a read without projectRoot adopts nothing, even from the folder the server runs in", async (context) => {
  const app = path.join(await temporary(context, "prism-personal-app-"), "state");
  const root = await project(context, ["Interaction style: plain-text"]);
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PLUGIN_DATA: await temporary(context, "prism-personal-data-"), PRISM_REVIEW_APP_DIR: app, PRISM_NATIVE_ASSET_MANIFEST: NATIVE_MANIFEST, CLAUDE_PROJECT_DIR: root });
  const { call } = await server(context, { cwd: root, env });
  const answer = (await call("get_personal_settings", {})).result.structuredContent;
  assert.deepEqual(answer.settings, DEFAULTS);
  assert.deepEqual(answer.adopted, []);
  assert.equal(await exists(path.join(app, FILE)), false);
});

test("clause 12: a server started from the Claude Code definition and one started by the Codex launcher with only its forwarded variables share one file", async (context) => {
  const home = await temporary(context, "prism-personal-home-");
  const state = path.join(home, "state");
  const local = path.join(home, "local");
  const shared = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, LOCALAPPDATA: local };
  const claudeEnv = isolatedEnv({ PRISM_REVIEW_APP: "off", PLUGIN_DATA: await temporary(context, "prism-personal-data-"), PRISM_NATIVE_ASSET_MANIFEST: NATIVE_MANIFEST, ...shared });
  delete claudeEnv.NODE_TEST_CONTEXT;
  delete claudeEnv.CLAUDE_PROJECT_DIR;
  // Codex gives a plugin's server a few basic variables and the ones .codex-mcp.json forwards.
  const codexEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...shared, CODEX_VERSION: "0.147.0", PRISM_REVIEW_APP: "off", PRISM_REVIEW_BROWSER_ON_START: "off", PRISM_LOG_LEVEL: "off", PRISM_STORE_HANDOFF: "off", PRISM_NATIVE_ASSET_MANIFEST: NATIVE_MANIFEST };
  const cwd = await temporary(context, "prism-personal-cwd-");
  const claude = await server(context, { cwd, env: claudeEnv });
  const codex = await server(context, { cwd: ROOT, env: codexEnv, command: CODEX_LAUNCHER });
  const chosen = await claude.call("update_personal_settings", { settings: { interactionStyle: "plain-text", reviewBrowser: "external" } });
  assert.ok(chosen.result, JSON.stringify(chosen.error));
  const read = await codex.call("get_personal_settings", {});
  assert.ok(read.result, JSON.stringify(read.error));
  assert.deepEqual(read.result.structuredContent.settings, { ...DEFAULTS, interactionStyle: "plain-text", reviewBrowser: "external" });
  await codex.call("update_personal_settings", { settings: { sessionOffer: "off" } });
  assert.equal((await claude.call("get_personal_settings", {})).result.structuredContent.settings.sessionOffer, "off");
  const folder = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Prism") : process.platform === "win32" ? path.join(local, "Prism") : path.join(state, "prism");
  assert.equal(await exists(path.join(folder, FILE)), true, `the file is in Prism's application folder ${folder}`);
});
