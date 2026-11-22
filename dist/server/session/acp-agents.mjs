// Generated from src/server/session/acp-agents.mts by scripts/native-build/compile.mjs.
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
const ACP_HOST_PREFIX = "acp-";
const ACP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ACP_HOST_PATTERN = /^acp-[a-z0-9][a-z0-9-]{0,39}$/;
const BARE_COMMAND = /^[A-Za-z0-9._-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ARGS = 32;
const MAX_ENV = 32;
const MAX_TEXT = 2e3;
const MAX_FILE_BYTES = 1024 * 1024;
const OWN_INTEGRATION_IDS = /* @__PURE__ */ new Set(["claude-acp", "codex-acp"]);
const OWN_INTEGRATION_REASON = "Prism runs Claude Code and Codex through its own integrations.";
const isAcpHost = (host) => typeof host === "string" && ACP_HOST_PATTERN.test(host);
function declarationFile(env = process.env) {
  if (env.PRISM_ACP_AGENTS) return path.resolve(env.PRISM_ACP_AGENTS);
  if (env.NODE_TEST_CONTEXT) return path.join(testConfigFolder(), "acp-agents.json");
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Prism", "acp-agents.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Prism", "acp-agents.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "prism", "acp-agents.json");
}
const testConfigFolder = () => path.join(os.tmpdir(), `prism-test-config-${process.getuid?.() ?? "user"}`);
const sharedTestFolder = (env, kind) => {
  if (!env.NODE_TEST_CONTEXT) return null;
  if (kind === "declarations") return env.PRISM_ACP_AGENTS ? null : testConfigFolder();
  return env.PRISM_REVIEW_APP_DIR ? null : reviewAppDirectory(env);
};
function sharedFolderTrust(folder) {
  const uid = process.getuid?.();
  if (folder === null || uid === void 0) return null;
  let stats;
  try {
    stats = lstatSync(folder);
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : { reason: `${folder} cannot be checked` };
  }
  if (!stats.isDirectory()) return { reason: `${folder} is not a folder` };
  if (stats.uid !== uid) return { reason: `${folder} belongs to another user` };
  if ((stats.mode & 18) !== 0) return { reason: `${folder} can be changed by other users` };
  return "trusted";
}
const agentsFolder = (env = process.env) => path.join(reviewAppDirectory(env), "agents");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL.test(value);
const optionalText = (value, max) => shortText(value, max) ? value : null;
const RULES = Object.freeze({
  id: "id must be 1 to 40 lowercase letters, digits, and -, starting with a letter or digit.",
  label: "label must be 1 to 60 characters without control characters.",
  command: "command must be an absolute path, or a bare name of 1 to 100 letters, digits, ., _, and - that PATH resolves.",
  args: `args must be at most ${MAX_ARGS} strings of at most ${MAX_TEXT} characters.`,
  env: `env must map at most ${MAX_ENV} names of letters, digits, and _, not starting with a digit, to strings of at most ${MAX_TEXT} characters.`,
  autoMode: "autoMode must be a mode value of at most 100 characters.",
  resumeCommand: "resumeCommand must be at most 500 characters holding {session}."
});
function checkedLaunch(entry) {
  const { command, args = [], env = {}, autoMode = null, resumeCommand = null } = entry;
  if (typeof command !== "string" || !(path.isAbsolute(command) || BARE_COMMAND.test(command))) return { launch: null, rule: RULES.command };
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === "string" && arg.length <= MAX_TEXT)) return { launch: null, rule: RULES.args };
  const pairs = isRecord(env) ? Object.entries(env) : null;
  if (!pairs || pairs.length > MAX_ENV || !pairs.every(([name, value]) => ENV_NAME.test(name) && typeof value === "string" && value.length <= MAX_TEXT)) return { launch: null, rule: RULES.env };
  if (autoMode !== null && !shortText(autoMode, 100)) return { launch: null, rule: RULES.autoMode };
  if (resumeCommand !== null && !(typeof resumeCommand === "string" && resumeCommand.length <= 500 && resumeCommand.includes("{session}"))) return { launch: null, rule: RULES.resumeCommand };
  return { launch: Object.freeze({ command, args: Object.freeze([...args]), env: Object.freeze(Object.fromEntries(pairs)), autoMode, resumeCommand }), rule: null };
}
const launchRule = (launch) => checkedLaunch(launch).rule;
const listedId = (value) => typeof value === "string" ? value.slice(0, 100) : null;
function declaredAgent(entry, position) {
  const raw = isRecord(entry) ? entry : {};
  const id = listedId(raw.id);
  const valid = id !== null && ACP_ID_PATTERN.test(id);
  const label = shortText(raw.label, 60) ? raw.label : id ?? `Entry ${position}`;
  const agent = (reason, launch2 = null) => ({ id, host: valid ? `${ACP_HOST_PREFIX}${id}` : null, label, origin: "declared", launch: launch2, install: null, reason });
  if (!isRecord(entry)) return agent(`Entry ${position} is not an object of id, label, and command.`);
  if (!valid) return agent(RULES.id);
  if (OWN_INTEGRATION_IDS.has(id)) return agent(OWN_INTEGRATION_REASON);
  if (!shortText(raw.label, 60)) return agent(RULES.label);
  const { launch, rule } = checkedLaunch(raw);
  return agent(rule, launch);
}
function readDeclarations(env = process.env) {
  const file = declarationFile(env);
  const unreadable = (why) => ({ file, state: "unreadable", reason: `Prism cannot read ${file}: ${why}.`, agents: [] });
  const trust = sharedFolderTrust(sharedTestFolder(env, "declarations"));
  if (trust === "missing") return { file, state: "missing", reason: null, agents: [] };
  if (typeof trust === "object" && trust !== null) return unreadable(trust.reason);
  let text;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return unreadable(`it is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { file, state: "missing", reason: null, agents: [] };
    return unreadable(error?.code === "EISDIR" ? "it is a folder" : String(error?.code ?? error?.message ?? "it cannot be opened"));
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable("it is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.agents)) return unreadable('it does not hold { "agents": [ \u2026 ] }');
  return { file, state: "read", reason: null, agents: value.agents.map((entry, index) => declaredAgent(entry, index + 1)) };
}
function readJson(file) {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return void 0;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function installedAgent(folder, id) {
  const current = readJson(path.join(folder, "current.json"));
  if (current === void 0) return null;
  const host = `${ACP_HOST_PREFIX}${id}`;
  const broken = (why, label2 = id) => ({ id, host, label: label2, origin: "registry", launch: null, install: null, reason: `The install of ${label2} cannot be used: ${why}.` });
  const version = isRecord(current) ? current.version : null;
  if (typeof version !== "string" || !VERSION_FOLDER.test(version)) return broken("current.json names no installed version");
  const versionFolder = path.join(folder, version);
  const record = readJson(path.join(versionFolder, "install.json"));
  if (!isRecord(record)) return broken(`${version} has no readable install.json`);
  if (record.id !== id) return broken(`its install.json names another agent`);
  if (!shortText(record.name, 60)) return broken("its install.json names no label of 1 to 60 characters");
  const label = record.name;
  if (OWN_INTEGRATION_IDS.has(id)) return { ...broken("", label), reason: OWN_INTEGRATION_REASON };
  const { launch, rule } = checkedLaunch({ ...record, autoMode: record.autoMode ?? null, resumeCommand: record.resumeCommand ?? null });
  const installedAt = typeof record.installedAt === "string" && !Number.isNaN(Date.parse(record.installedAt)) ? record.installedAt : (/* @__PURE__ */ new Date(0)).toISOString();
  const entry = isRecord(record.entry) ? record.entry : {};
  const authors = Array.isArray(record.authors) ? record.authors : Array.isArray(entry.authors) ? entry.authors : [];
  const install = {
    version,
    authors: authors.filter((item) => shortText(item, 200)),
    license: optionalText(record.license, 200) ?? optionalText(entry.license, 200),
    source: optionalText(record.source, MAX_TEXT) ?? optionalText(entry.repository, MAX_TEXT) ?? optionalText(entry.website, MAX_TEXT),
    description: optionalText(record.description, MAX_TEXT) ?? optionalText(entry.description, MAX_TEXT),
    distribution: optionalText(record.distribution, 20),
    installedAt,
    folder: versionFolder
  };
  return { id, host, label, origin: "registry", launch, install, reason: rule ? `The install record of ${label} breaks a rule: ${rule}` : null };
}
function readInstalls(env = process.env) {
  const base = agentsFolder(env);
  const trust = sharedFolderTrust(sharedTestFolder(env, "installs"));
  if (trust !== null && trust !== "trusted") return [];
  let names;
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && ACP_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
  const installs = names.map((id) => installedAgent(path.join(base, id), id)).filter((agent) => agent !== null);
  const time = (agent) => Date.parse(agent.install?.installedAt ?? "") || 0;
  return installs.sort((left, right) => time(left) - time(right) || left.id.localeCompare(right.id));
}
function acpAgents(env = process.env) {
  const installs = readInstalls(env);
  const declarations = readDeclarations(env);
  const installed = new Map(installs.map((agent) => [agent.id, agent]));
  const declared = [];
  const seen = /* @__PURE__ */ new Set();
  for (const agent of declarations.agents) {
    if (agent.id !== null) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
    }
    const owner = agent.id !== null && agent.reason === null ? installed.get(agent.id) : void 0;
    declared.push(owner ? { ...agent, reason: `${agent.id} is the id of the installed registry agent ${owner.label}, so this declaration is not used.` } : agent);
  }
  if (declarations.state === "unreadable") {
    declared.push({ id: null, host: null, label: path.basename(declarations.file), origin: "declared", launch: null, install: null, reason: declarations.reason });
  }
  return { agents: [...installs, ...declared], declarations };
}
function acpHosts(env = process.env) {
  return acpAgents(env).agents.filter((agent) => agent.reason === null && agent.host !== null && agent.launch !== null).map((agent) => Object.freeze({
    host: agent.host,
    label: agent.label,
    executable: agent.launch.command,
    acp: Object.freeze({ ...agent.launch, id: agent.id, origin: agent.origin, install: agent.install })
  }));
}
function acpHostDefinition(host, env = process.env) {
  if (!isAcpHost(host)) return null;
  return acpHosts(env).find((definition) => definition.host === host) ?? null;
}
export {
  ACP_HOST_PATTERN,
  ACP_HOST_PREFIX,
  ACP_ID_PATTERN,
  OWN_INTEGRATION_IDS,
  OWN_INTEGRATION_REASON,
  acpAgents,
  acpHostDefinition,
  acpHosts,
  agentsFolder,
  declarationFile,
  isAcpHost,
  launchRule,
  readDeclarations,
  readInstalls
};
