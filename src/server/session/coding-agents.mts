import path from "node:path";
import { acpAgents, type AcpAgent } from "./acp-agents.mjs";
import { resolveDefinition } from "./launch-hosts.mjs";

// The coding agents that GET api/coding-agents lists: every installed and declared ACP agent with its launch availability and the
// reason it is not offered, read again on every request.

/** The registry as this list reports it while Prism reads no registry index. */
const NO_REGISTRY = Object.freeze({ state: "unavailable", reason: "Prism did not read the agent registry.", readAt: null });

async function launchOf(agent: AcpAgent, env: NodeJS.ProcessEnv) {
  if (agent.reason !== null || agent.launch === null || agent.host === null) return { available: false, reason: agent.reason ?? `${agent.label} cannot be launched.` };
  const resolved = await resolveDefinition({ host: agent.host, label: agent.label, executable: agent.launch.command }, env);
  return { available: resolved.available, reason: resolved.reason };
}

function installOf(agent: AcpAgent, file: string) {
  if (agent.origin === "declared") return { available: false, reason: `${agent.label} is declared in ${path.basename(file)}, so Prism does not install it.` };
  return { available: false, reason: agent.install ? `${agent.label} ${agent.install.version} is installed.` : agent.reason };
}

/** { registry: { state, reason, readAt }, agents }, each agent in host list order. */
export async function listCodingAgents({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const { agents, declarations } = acpAgents(env);
  const listed = await Promise.all(agents.map(async (agent) => ({
    id: agent.id,
    host: agent.host,
    name: agent.label,
    version: agent.install?.version ?? null,
    authors: agent.install?.authors ?? [],
    license: agent.install?.license ?? null,
    source: agent.install?.source ?? null,
    description: agent.install?.description ?? null,
    origin: agent.origin,
    installed: agent.install ? { version: agent.install.version } : null,
    update: null,
    launch: await launchOf(agent, env),
    install: installOf(agent, declarations.file)
  })));
  return { registry: { ...NO_REGISTRY }, agents: listed };
}
