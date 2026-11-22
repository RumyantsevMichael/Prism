// The agents list: every launched session of this computer and every claim of the workspace that no launched session holds, one entry each,
// grouped by what needs the person, with the counts the top bar and the Agents page show. No entry names a claim holder or a launched session's host session id; a claim's entry carries the link to its session when the claim records one.
import { archivedLaunches, listLaunches } from "../session/launched-sessions.mjs";
import { loadHeldClaims, loadRoadmapView } from "./workspace-model.mjs";

const GROUPS = ["needs-you", "launched", "other", "expired", "archived"];
// A claim that expired this long ago or more leaves the counts, while the list keeps every expired claim.
const EXPIRED_COUNTED_MS = 24 * 60 * 60 * 1000;
const time = (value: any) => Date.parse(value ?? "") || 0;

const NO_RESULT = "ended-without-result";
const NEEDS_YOU = ["failed", NO_RESULT, "waiting"];
const launchAction = (launch: any) => (launch.state === "waiting" || (launch.state === NO_RESULT && typeof launch.questionGate === "string") ? "answer" : launch.state === "running" ? "stop" : "open");
const launchGroup = (state: any, archived: boolean) => (archived ? "archived" : NEEDS_YOU.includes(state) ? "needs-you" : "launched");

// A launch entry carries questionGate, the no-result gate it was asked, only while that gate is open, as it carries usage only for an ACP agent.
function launchEntry(launch: any, title: string, claim: any, archived: boolean) {
  return {
    id: `launch:${launch.id}`,
    kind: "launch",
    group: launchGroup(launch.state, archived),
    name: title,
    harness: launch.hostLabel ?? launch.host ?? null,
    model: launch.model ?? null,
    session: null,
    initiative: { id: launch.initiative, title },
    slice: claim ? { ref: claim.ref, title: claim.sliceTitle } : null,
    activity: claim ? claim.activity : null,
    state: launch.state,
    reason: launch.reason ?? null,
    expiresAt: null,
    launch: { id: launch.id, launchedAt: launch.launchedAt, runningMs: launch.runningMs, runs: launch.runs, endedAt: launch.endedAt, exit: launch.exit, resumeCommand: launch.resumeCommand, waitingGate: launch.waitingGate, ...(typeof launch.questionGate === "string" ? { questionGate: launch.questionGate } : {}), ...(launch.usage ? { usage: launch.usage } : {}) },
    action: launchAction(launch)
  };
}

function claimEntry(claim: any, expired: any) {
  return {
    id: `claim:${claim.initiative}/${claim.slug}`,
    kind: "claim",
    group: expired ? "expired" : "other",
    name: claim.label,
    harness: claim.host ?? null,
    model: claim.model ?? null,
    session: claim.session ?? null,
    initiative: { id: claim.initiative, title: claim.initiativeTitle },
    slice: { ref: claim.ref, title: claim.sliceTitle },
    activity: claim.activity,
    state: expired ? "expired" : "working",
    reason: null,
    expiresAt: claim.expiresAt,
    launch: null,
    action: null
  };
}

// Within needs-you, failed ones first, then those that ended without a result, then waiting ones; launches the latest launched first; live claims the one that lapses first first; expired ones the latest to lapse first.
const rank = (state: any) => (NEEDS_YOU.includes(state) ? NEEDS_YOU.indexOf(state) : NEEDS_YOU.length);
function order(left: any, right: any) {
  const group = GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group);
  if (group) return group;
  if (left.group === "needs-you" && left.state !== right.state) return rank(left.state) - rank(right.state);
  if (left.kind === "launch") return time(right.launch.launchedAt) - time(left.launch.launchedAt) || right.id.localeCompare(left.id);
  if (left.group === "other") return time(left.expiresAt) - time(right.expiresAt) || left.id.localeCompare(right.id);
  return time(right.expiresAt) - time(left.expiresAt) || left.id.localeCompare(right.id);
}

/** `{ agents, counts }` for the checkout: a launch holds every claim of its initiative whose holder is the launch's holder. */
export async function listAgents({ projectRoot, env = process.env, now = Date.now() }: { projectRoot: string; env?: NodeJS.ProcessEnv; now?: number }) {
  const [{ launches }, { claims }, roadmap] = await Promise.all([
    listLaunches({ projectRoot, env, now }),
    loadHeldClaims(projectRoot).catch(() => ({ claims: [] })),
    loadRoadmapView(projectRoot).catch(() => ({ items: [] }))
  ]);
  const titles = new Map((roadmap.items ?? []).map((item: any) => [item.id, item.title ?? item.id]));
  for (const claim of claims) if (!titles.has(claim.initiative)) titles.set(claim.initiative, claim.initiativeTitle);
  const lapsed = (claim: any) => claim.expired || time(claim.expiresAt) <= now;
  const holds = (launch: any, claim: any) => typeof launch.holder === "string" && claim.holder === launch.holder && claim.initiative === launch.initiative;
  const archived = await archivedLaunches({ launches, env });
  const agents: any[] = [];
  for (const launch of launches) {
    const live = claims.find((claim: any) => holds(launch, claim) && !lapsed(claim)) ?? null;
    agents.push(launchEntry(launch, titles.get(launch.initiative) ?? launch.initiative, live, archived.has(launch.id)));
  }
  for (const claim of claims) {
    if (launches.some((launch) => holds(launch, claim))) continue;
    agents.push(claimEntry(claim, lapsed(claim)));
  }
  agents.sort(order);
  // The counts leave archived sessions and claims that expired a day ago or more out.
  const counted = agents.filter((agent: any) => agent.group !== "archived" && !(agent.group === "expired" && now - time(agent.expiresAt) >= EXPIRED_COUNTED_MS));
  const count = (accept: any) => counted.filter(accept).length;
  const counts = {
    all: counted.length,
    needsYou: count((agent: any) => agent.group === "needs-you"),
    failed: count((agent: any) => agent.kind === "launch" && agent.state === "failed"),
    waiting: count((agent: any) => agent.kind === "launch" && agent.state === "waiting"),
    endedWithoutResult: count((agent: any) => agent.kind === "launch" && agent.state === NO_RESULT),
    thisComputer: count((agent: any) => agent.kind === "launch"),
    other: count((agent: any) => agent.group === "other"),
    expired: count((agent: any) => agent.group === "expired"),
    working: count((agent: any) => (agent.kind === "launch" ? agent.state === "running" || agent.state === "waiting" : agent.group === "other"))
  };
  return { agents, counts };
}
