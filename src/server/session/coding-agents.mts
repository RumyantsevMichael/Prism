import path from "node:path";
import { ACP_HOST_PREFIX, acpAgents, type AcpAgent } from "./acp-agents.mjs";
import { readRegistry, type RegistryState } from "./acp-registry.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";

// The coding agents that GET api/coding-agents lists: every installed and declared ACP agent with its launch availability and the
// reason it is not offered, read again on every request, and the registry's agents for this computer with their install availability,
// from the registry read that acp-registry keeps for 10 minutes.

async function launchOf(agent: AcpAgent, env: NodeJS.ProcessEnv) {
  if (agent.reason !== null || agent.launch === null || agent.host === null) return { available: false, reason: agent.reason ?? `${agent.label} cannot be launched.` };
  const resolved = await resolveDefinition({ host: agent.host, label: agent.label, executable: agent.launch.command }, env);
  return { available: resolved.available, reason: resolved.reason };
}

function installOf(agent: AcpAgent, file: string, registry: RegistryState) {
  if (agent.origin === "declared") return { available: false, reason: `${agent.label} is declared in ${path.basename(file)}, so Prism does not install it.` };
  if (registry.state !== "ready") return { available: false, reason: registry.reason };
  return { available: false, reason: agent.install ? `${agent.label} ${agent.install.version} is installed.` : agent.reason };
}

/** { registry: { state, reason, readAt }, agents }: installed agents in install time order, then the registry's others, then declared ones. */
export async function listCodingAgents({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const [{ agents, declarations }, read] = [acpAgents(env), await readRegistry({ env })];
  const registry: RegistryState = { state: read.state, reason: read.reason, readAt: read.readAt };
  const offered = new Map(read.agents.map((agent) => [agent.id, agent]));
  const local = await Promise.all(agents.map(async (agent) => {
    // An installed agent that the registry still lists takes the registry's details, and its kept details stand in otherwise.
    const listed = agent.origin === "registry" && agent.id !== null ? offered.get(agent.id) : undefined;
    const installedVersion = agent.install?.version ?? null;
    return {
      id: agent.id,
      host: agent.host,
      name: listed?.name ?? agent.label,
      version: listed?.version ?? installedVersion,
      authors: listed?.authors ?? agent.install?.authors ?? [],
      license: listed?.license ?? agent.install?.license ?? null,
      source: listed?.source ?? agent.install?.source ?? null,
      description: listed?.description ?? agent.install?.description ?? null,
      origin: agent.origin,
      installed: agent.install ? { version: agent.install.version } : null,
      update: listed && installedVersion !== null && listed.version !== installedVersion ? { version: listed.version } : null,
      launch: await launchOf(agent, env),
      install: installOf(agent, declarations.file, registry)
    };
  }));
  const installedIds = new Set(agents.filter((agent) => agent.origin === "registry").map((agent) => agent.id));
  const available = read.agents.filter((agent) => !installedIds.has(agent.id)).map((agent) => ({
    id: agent.id,
    host: `${ACP_HOST_PREFIX}${agent.id}`,
    name: agent.name,
    version: agent.version,
    authors: agent.authors,
    license: agent.license,
    source: agent.source,
    description: agent.description,
    origin: "registry" as const,
    installed: null,
    update: null,
    launch: { available: false, reason: `${agent.name} is not installed.` },
    install: agent.install
  }));
  const installed = local.filter((agent) => agent.origin === "registry");
  const declared = local.filter((agent) => agent.origin === "declared");
  return { registry, agents: [...installed, ...available, ...declared] };
}
