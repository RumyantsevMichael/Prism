import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";

// The Agent Client Protocol agents that this computer offers as hosts: the ones installed from the registry, each recorded by its
// install.json under the review app folder's agents/, and the ones the person declares in acp-agents.json.
// Prism only reads both and never writes the declaration file. Every call reads them again, so an agent installed, updated, removed,
// or declared appears or disappears without a restart. An agent's command, arguments, and environment come only from these files.

export const ACP_HOST_PREFIX = "acp-";
export const ACP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ACP_HOST_PATTERN = /^acp-[a-z0-9][a-z0-9-]{0,39}$/;
const BARE_COMMAND = /^[A-Za-z0-9._-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ARGS = 32;
const MAX_ENV = 32;
const MAX_TEXT = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
// Prism runs these two through its own integrations, so neither is ever an ACP host.
export const OWN_INTEGRATION_IDS: ReadonlySet<string> = new Set(["claude-acp", "codex-acp"]);
export const OWN_INTEGRATION_REASON = "Prism runs Claude Code and Codex through its own integrations.";

export const isAcpHost = (host: unknown): host is string => typeof host === "string" && ACP_HOST_PATTERN.test(host);

/** What one agent runs: the command, its arguments and environment, and the optional automatic mode and terminal resume command. */
export interface AcpLaunch { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; autoMode: string | null; resumeCommand: string | null }

/** An install record's registry details. */
export interface AcpInstall { version: string; authors: string[]; license: string | null; source: string | null; description: string | null; distribution: string | null; installedAt: string; folder: string }

/**
 * One agent that a file names: its id and host, or null for an id that breaks the rule, its label, where it comes from, what it runs
 * once its entry keeps every rule, and reason, null for an agent offered as a host and otherwise the rule it breaks.
 */
export interface AcpAgent { id: string | null; host: string | null; label: string; origin: "declared" | "registry"; launch: AcpLaunch | null; install: AcpInstall | null; reason: string | null }

/** The host definition of an offered agent, as launch-hosts lists it beside Claude Code and Codex. */
export interface AcpHostDefinition { host: string; label: string; executable: string; acp: AcpLaunch & { id: string; origin: "declared" | "registry"; install: AcpInstall | null } }

/**
 * The declaration file: the one PRISM_ACP_AGENTS names, and otherwise acp-agents.json in the person's Prism configuration folder.
 * A process under Node's test runner without PRISM_ACP_AGENTS reads a temporary folder of its own instead, as the review app folder does,
 * so no test reads the person's own declarations, and it reads that folder only while it is this user's own and private.
 */
export function declarationFile(env: NodeJS.ProcessEnv = process.env) {
  if (env.PRISM_ACP_AGENTS) return path.resolve(env.PRISM_ACP_AGENTS);
  if (env.NODE_TEST_CONTEXT) return path.join(testConfigFolder(), "acp-agents.json");
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Prism", "acp-agents.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Prism", "acp-agents.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "prism", "acp-agents.json");
}

const testConfigFolder = () => path.join(os.tmpdir(), `prism-test-config-${process.getuid?.() ?? "user"}`);

// The temporary folder that a process under Node's test runner reads in place of the person's own, when no variable names one.
// Its name is predictable and the temporary directory is shared, so another local user could create it first and plant a command.
const sharedTestFolder = (env: NodeJS.ProcessEnv, kind: "declarations" | "installs") => {
  if (!env.NODE_TEST_CONTEXT) return null;
  if (kind === "declarations") return env.PRISM_ACP_AGENTS ? null : testConfigFolder();
  return env.PRISM_REVIEW_APP_DIR ? null : reviewAppDirectory(env);
};

/**
 * Whether a shared test folder can be read: null when there is none to check, `missing` when it does not exist, so nothing under it is
 * read, since another user could create it before the read, and otherwise why it cannot be trusted, or `trusted` for a real folder of
 * this user that no one else can write, which the sticky temporary directory keeps others from replacing.
 * Windows gives each user a temporary directory of their own, so it needs no check there.
 */
function sharedFolderTrust(folder: string | null): null | "missing" | "trusted" | { reason: string } {
  const uid = process.getuid?.();
  if (folder === null || uid === undefined) return null;
  let stats;
  try {
    stats = lstatSync(folder);
  } catch (error: any) {
    return error?.code === "ENOENT" ? "missing" : { reason: `${folder} cannot be checked` };
  }
  if (!stats.isDirectory()) return { reason: `${folder} is not a folder` };
  if (stats.uid !== uid) return { reason: `${folder} belongs to another user` };
  if ((stats.mode & 0o022) !== 0) return { reason: `${folder} can be changed by other users` };
  return "trusted";
}

/** The folder that holds every registry install. */
export const agentsFolder = (env: NodeJS.ProcessEnv = process.env) => path.join(reviewAppDirectory(env), "agents");

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL.test(value);
const optionalText = (value: unknown, max: number) => (shortText(value, max) ? value : null);

const RULES = Object.freeze({
  id: "id must be 1 to 40 lowercase letters, digits, and -, starting with a letter or digit.",
  label: "label must be 1 to 60 characters without control characters.",
  command: "command must be an absolute path, or a bare name of 1 to 100 letters, digits, ., _, and - that PATH resolves.",
  args: `args must be at most ${MAX_ARGS} strings of at most ${MAX_TEXT} characters.`,
  env: `env must map at most ${MAX_ENV} names of letters, digits, and _, not starting with a digit, to strings of at most ${MAX_TEXT} characters.`,
  autoMode: "autoMode must be a mode value of at most 100 characters.",
  resumeCommand: "resumeCommand must be at most 500 characters holding {session}."
});

// The rule an entry's launch fields break, or its launch: command, args, env, autoMode, and resumeCommand, as clause 3 states them.
function checkedLaunch(entry: Record<string, any>): { launch: AcpLaunch | null; rule: string | null } {
  const { command, args = [], env = {}, autoMode = null, resumeCommand = null } = entry;
  if (typeof command !== "string" || !(path.isAbsolute(command) || BARE_COMMAND.test(command))) return { launch: null, rule: RULES.command };
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === "string" && arg.length <= MAX_TEXT)) return { launch: null, rule: RULES.args };
  const pairs = isRecord(env) ? Object.entries(env) : null;
  if (!pairs || pairs.length > MAX_ENV || !pairs.every(([name, value]) => ENV_NAME.test(name) && typeof value === "string" && value.length <= MAX_TEXT)) return { launch: null, rule: RULES.env };
  if (autoMode !== null && !shortText(autoMode, 100)) return { launch: null, rule: RULES.autoMode };
  if (resumeCommand !== null && !(typeof resumeCommand === "string" && resumeCommand.length <= 500 && resumeCommand.includes("{session}"))) return { launch: null, rule: RULES.resumeCommand };
  return { launch: Object.freeze({ command, args: Object.freeze([...args]), env: Object.freeze(Object.fromEntries(pairs)), autoMode, resumeCommand }), rule: null };
}

/** The rule of clause 3 that an install's command, args, and env break, or null when they keep every rule. */
export const launchRule = (launch: { command: unknown; args: unknown; env: unknown }) => checkedLaunch(launch).rule;

const listedId = (value: unknown) => (typeof value === "string" ? value.slice(0, 100) : null);

function declaredAgent(entry: unknown, position: number): AcpAgent {
  const raw = isRecord(entry) ? entry : {};
  const id = listedId(raw.id);
  const valid = id !== null && ACP_ID_PATTERN.test(id);
  const label = shortText(raw.label, 60) ? raw.label : id ?? `Entry ${position}`;
  const agent = (reason: string | null, launch: AcpLaunch | null = null): AcpAgent => ({ id, host: valid ? `${ACP_HOST_PREFIX}${id}` : null, label, origin: "declared", launch, install: null, reason });
  if (!isRecord(entry)) return agent(`Entry ${position} is not an object of id, label, and command.`);
  if (!valid) return agent(RULES.id);
  if (OWN_INTEGRATION_IDS.has(id)) return agent(OWN_INTEGRATION_REASON);
  if (!shortText(raw.label, 60)) return agent(RULES.label);
  const { launch, rule } = checkedLaunch(raw);
  return agent(rule, launch);
}

/** The declaration file as read now: state missing, read, or unreadable with its reason, and every entry in file order with its rule check. */
export function readDeclarations(env: NodeJS.ProcessEnv = process.env): { file: string; state: "missing" | "read" | "unreadable"; reason: string | null; agents: AcpAgent[] } {
  const file = declarationFile(env);
  const unreadable = (why: string) => ({ file, state: "unreadable" as const, reason: `Prism cannot read ${file}: ${why}.`, agents: [] });
  const trust = sharedFolderTrust(sharedTestFolder(env, "declarations"));
  if (trust === "missing") return { file, state: "missing", reason: null, agents: [] };
  if (typeof trust === "object" && trust !== null) return unreadable(trust.reason);
  let text: string;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return unreadable(`it is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    text = readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { file, state: "missing", reason: null, agents: [] };
    return unreadable(error?.code === "EISDIR" ? "it is a folder" : String(error?.code ?? error?.message ?? "it cannot be opened"));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable("it is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.agents)) return unreadable("it does not hold { \"agents\": [ … ] }");
  return { file, state: "read", reason: null, agents: value.agents.map((entry: unknown, index: number) => declaredAgent(entry, index + 1)) };
}

function readJson(file: string): any {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// One registry install: agents/<id>/current.json names the version that new runs use, whose folder holds install.json.
function installedAgent(folder: string, id: string): AcpAgent | null {
  const current = readJson(path.join(folder, "current.json"));
  if (current === undefined) return null;
  const host = `${ACP_HOST_PREFIX}${id}`;
  const broken = (why: string, label = id): AcpAgent => ({ id, host, label, origin: "registry", launch: null, install: null, reason: `The install of ${label} cannot be used: ${why}.` });
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
  const installedAt = typeof record.installedAt === "string" && !Number.isNaN(Date.parse(record.installedAt)) ? record.installedAt : new Date(0).toISOString();
  // The registry entry that the record keeps stands in for each detail the record does not state itself, so the details stay
  // listed while the registry cannot be read.
  const entry = isRecord(record.entry) ? record.entry : {};
  const authors = Array.isArray(record.authors) ? record.authors : Array.isArray(entry.authors) ? entry.authors : [];
  const install: AcpInstall = {
    version,
    authors: authors.filter((item: unknown) => shortText(item, 200)),
    license: optionalText(record.license, 200) ?? optionalText(entry.license, 200),
    source: optionalText(record.source, MAX_TEXT) ?? optionalText(entry.repository, MAX_TEXT) ?? optionalText(entry.website, MAX_TEXT),
    description: optionalText(record.description, MAX_TEXT) ?? optionalText(entry.description, MAX_TEXT),
    distribution: optionalText(record.distribution, 20),
    installedAt,
    folder: versionFolder
  };
  return { id, host, label, origin: "registry", launch, install, reason: rule ? `The install record of ${label} breaks a rule: ${rule}` : null };
}

/** Every registry install as read now, in the order of its install time. */
export function readInstalls(env: NodeJS.ProcessEnv = process.env): AcpAgent[] {
  const base = agentsFolder(env);
  const trust = sharedFolderTrust(sharedTestFolder(env, "installs"));
  if (trust !== null && trust !== "trusted") return [];
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && ACP_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
  const installs = names.map((id) => installedAgent(path.join(base, id), id)).filter((agent): agent is AcpAgent => agent !== null);
  const time = (agent: AcpAgent) => Date.parse(agent.install?.installedAt ?? "") || 0;
  return installs.sort((left, right) => time(left) - time(right) || left.id!.localeCompare(right.id!));
}

/**
 * Every agent that the install records and the declaration file name, installs first in install time order and then declarations in
 * file order, each with reason null when it is offered as a host; a later declaration of an id already listed is left out, a declaration
 * of an installed agent's id is listed with its reason, and an unreadable declaration file is one entry with its reason.
 */
export function acpAgents(env: NodeJS.ProcessEnv = process.env): { agents: AcpAgent[]; declarations: ReturnType<typeof readDeclarations> } {
  const installs = readInstalls(env);
  const declarations = readDeclarations(env);
  const installed = new Map(installs.map((agent) => [agent.id, agent]));
  const declared: AcpAgent[] = [];
  const seen = new Set<string>();
  for (const agent of declarations.agents) {
    if (agent.id !== null) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
    }
    const owner = agent.id !== null && agent.reason === null ? installed.get(agent.id) : undefined;
    declared.push(owner ? { ...agent, reason: `${agent.id} is the id of the installed registry agent ${owner.label}, so this declaration is not used.` } : agent);
  }
  if (declarations.state === "unreadable") {
    declared.push({ id: null, host: null, label: path.basename(declarations.file), origin: "declared", launch: null, install: null, reason: declarations.reason });
  }
  return { agents: [...installs, ...declared], declarations };
}

/** The agents offered as hosts now, in host list order. */
export function acpHosts(env: NodeJS.ProcessEnv = process.env): AcpHostDefinition[] {
  return acpAgents(env).agents.filter((agent) => agent.reason === null && agent.host !== null && agent.launch !== null).map((agent) => Object.freeze({
    host: agent.host!,
    label: agent.label,
    executable: agent.launch!.command,
    acp: Object.freeze({ ...agent.launch!, id: agent.id!, origin: agent.origin, install: agent.install })
  }));
}

/** The host definition of one offered ACP agent, or null. */
export function acpHostDefinition(host: unknown, env: NodeJS.ProcessEnv = process.env) {
  if (!isAcpHost(host)) return null;
  return acpHosts(env).find((definition) => definition.host === host) ?? null;
}
