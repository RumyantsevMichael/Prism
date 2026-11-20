// Generated from src/server/review/agents.mts by scripts/native-build/compile.mjs.
import { listLaunches } from "../session/launched-sessions.mjs";
import { loadHeldClaims, loadRoadmapView } from "./workspace-model.mjs";
const GROUPS = ["needs-you", "launched", "other", "expired"];
const time = (value) => Date.parse(value ?? "") || 0;
const launchAction = (state) => state === "waiting" ? "answer" : state === "running" ? "stop" : "open";
const launchGroup = (state) => state === "failed" || state === "waiting" ? "needs-you" : "launched";
function launchEntry(launch, title, claim) {
  return {
    id: `launch:${launch.id}`,
    kind: "launch",
    group: launchGroup(launch.state),
    name: title,
    harness: launch.hostLabel ?? launch.host ?? null,
    model: launch.model ?? null,
    initiative: { id: launch.initiative, title },
    slice: claim ? { ref: claim.ref, title: claim.sliceTitle } : null,
    activity: claim ? claim.activity : null,
    state: launch.state,
    reason: launch.reason ?? null,
    expiresAt: null,
    launch: { id: launch.id, launchedAt: launch.launchedAt, runningMs: launch.runningMs, runs: launch.runs, endedAt: launch.endedAt, exit: launch.exit, resumeCommand: launch.resumeCommand, waitingGate: launch.waitingGate },
    action: launchAction(launch.state)
  };
}
function claimEntry(claim, expired) {
  return {
    id: `claim:${claim.initiative}/${claim.slug}`,
    kind: "claim",
    group: expired ? "expired" : "other",
    name: claim.label,
    harness: claim.host ?? null,
    model: claim.model ?? null,
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
function order(left, right) {
  const group = GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group);
  if (group) return group;
  if (left.group === "needs-you" && left.state !== right.state) return left.state === "failed" ? -1 : right.state === "failed" ? 1 : 0;
  if (left.kind === "launch") return time(right.launch.launchedAt) - time(left.launch.launchedAt) || right.id.localeCompare(left.id);
  if (left.group === "other") return time(left.expiresAt) - time(right.expiresAt) || left.id.localeCompare(right.id);
  return time(right.expiresAt) - time(left.expiresAt) || left.id.localeCompare(right.id);
}
async function listAgents({ projectRoot, env = process.env, now = Date.now() }) {
  const [{ launches }, { claims }, roadmap] = await Promise.all([
    listLaunches({ projectRoot, env, now }),
    loadHeldClaims(projectRoot).catch(() => ({ claims: [] })),
    loadRoadmapView(projectRoot).catch(() => ({ items: [] }))
  ]);
  const titles = new Map((roadmap.items ?? []).map((item) => [item.id, item.title ?? item.id]));
  for (const claim of claims) if (!titles.has(claim.initiative)) titles.set(claim.initiative, claim.initiativeTitle);
  const lapsed = (claim) => claim.expired || time(claim.expiresAt) <= now;
  const holds = (launch, claim) => typeof launch.holder === "string" && claim.holder === launch.holder && claim.initiative === launch.initiative;
  const agents = [];
  for (const launch of launches) {
    const live = claims.find((claim) => holds(launch, claim) && !lapsed(claim)) ?? null;
    agents.push(launchEntry(launch, titles.get(launch.initiative) ?? launch.initiative, live));
  }
  for (const claim of claims) {
    if (launches.some((launch) => holds(launch, claim))) continue;
    agents.push(claimEntry(claim, lapsed(claim)));
  }
  agents.sort(order);
  const count = (accept) => agents.filter(accept).length;
  const counts = {
    all: agents.length,
    needsYou: count((agent) => agent.group === "needs-you"),
    failed: count((agent) => agent.kind === "launch" && agent.state === "failed"),
    waiting: count((agent) => agent.kind === "launch" && agent.state === "waiting"),
    thisComputer: count((agent) => agent.kind === "launch"),
    other: count((agent) => agent.group === "other"),
    expired: count((agent) => agent.group === "expired"),
    working: count((agent) => agent.kind === "launch" ? agent.state === "running" || agent.state === "waiting" : agent.group === "other")
  };
  return { agents, counts };
}
export {
  listAgents
};
