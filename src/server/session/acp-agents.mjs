import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Agent Client Protocol agents that this computer's person declared for launched sessions, read from one JSON file.
// Prism ships no agent: each entry names a program the person installed, which Prism starts with the entry's arguments and talks
// ACP to over its standard input and output.
// The file is { "agents": [ { id, label, command, args?, prompt?, options?, resumeCommand? } ] }:
// - id: 1 to 40 lowercase letters, digits, and `-`, starting with a letter or digit; the host is `acp-<id>`.
// - label: what the Launch menu calls the agent, 1 to 60 characters.
// - command: an absolute path, or a bare executable name that PATH resolves.
// - args: at most 32 strings.
// - prompt: the run's prompt, with `{initiative}` replaced by the initiative id; the default asks for the orchestrate skill in words,
//   since each agent invokes a skill its own way (Claude Code `/prism:orchestrate`, Codex `$prism:orchestrate`).
// - options: { configId: value } set with session/set_config_option after every session/new and session/resume, in order; a run
//   fails before its prompt when the agent does not advertise one of them, so a declared autonomy mode is never silently dropped.
// - resumeCommand: the terminal command that continues the session, with `{session}` replaced by the session id.
// An entry that breaks any rule is left out, and the file's other entries still count.

export const ACP_HOST_PREFIX = "acp-";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BARE_COMMAND = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_ARGS = 32;
const MAX_TEXT = 2000;
export const DEFAULT_ACP_PROMPT = "Run the Prism orchestrate skill for the initiative {initiative}.";

/** The file that declares the agents: PRISM_ACP_AGENTS, or acp-agents.json in the person's Prism configuration folder. */
export function acpAgentsFile(env = process.env) {
  if (typeof env.PRISM_ACP_AGENTS === "string" && path.isAbsolute(env.PRISM_ACP_AGENTS)) return env.PRISM_ACP_AGENTS;
  const base = process.platform === "win32" && env.APPDATA ? env.APPDATA : path.join(os.homedir(), ".config");
  return path.join(base, "prism", "acp-agents.json");
}

const shortText = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function parseEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { id, label, command, args = [], prompt = DEFAULT_ACP_PROMPT, options = {}, resumeCommand = null } = entry;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || !shortText(label, 60)) return null;
  if (typeof command !== "string" || !(path.isAbsolute(command) || BARE_COMMAND.test(command))) return null;
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === "string" && arg.length <= MAX_TEXT)) return null;
  if (!shortText(prompt, MAX_TEXT) || !prompt.includes("{initiative}")) return null;
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const pairs = Object.entries(options);
  if (pairs.length > 16 || !pairs.every(([key, value]) => shortText(key, 100) && (typeof value === "boolean" || shortText(value, 200)))) return null;
  if (resumeCommand !== null && !(shortText(resumeCommand, 500) && resumeCommand.includes("{session}"))) return null;
  return Object.freeze({
    host: `${ACP_HOST_PREFIX}${id}`,
    label,
    executable: command,
    acp: Object.freeze({ args: Object.freeze([...args]), prompt, options: Object.freeze(pairs.map(([configId, value]) => Object.freeze({ configId, value }))), resumeCommand })
  });
}

/** The declared agents, as host definitions in file order with duplicate ids dropped; a missing or unreadable file declares none. */
export function acpAgentHosts(env = process.env) {
  let value;
  try {
    value = JSON.parse(readFileSync(acpAgentsFile(env), "utf8"));
  } catch {
    return [];
  }
  const entries = Array.isArray(value?.agents) ? value.agents : [];
  const seen = new Set();
  const hosts = [];
  for (const entry of entries.slice(0, 32)) {
    const definition = parseEntry(entry);
    if (!definition || seen.has(definition.host)) continue;
    seen.add(definition.host);
    hosts.push(definition);
  }
  return hosts;
}
