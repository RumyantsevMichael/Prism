// Generated from src/server/review/agents.mts by scripts/native-build/compile.mjs.
import { archivedLaunches, listLaunches } from "../session/launched-sessions.mjs";
import { readRun } from "../workflow/migration-runs.mjs";
import { loadHeldClaims, loadRoadmapView, migrationRunTitle } from "./workspace-model.mjs";
const GROUPS = ["needs-you", "launched", "other", "expired", "archived"];
const EXPIRED_COUNTED_MS = 24 * 60 * 60 * 1e3;
const time = (value) => Date.parse(value ?? "") || 0;
const NO_RESULT = "ended-without-result";
const NEEDS_YOU = ["failed", NO_RESULT, "waiting"];
const launchAction = (launch) => launch.state === "waiting" || launch.state === NO_RESULT && typeof launch.questionGate === "string" ? "answer" : launch.state === "running" ? "stop" : "open";
const launchGroup = (state, archived) => archived ? "archived" : NEEDS_YOU.includes(state) ? "needs-you" : "launched";
function launchEntry(launch, title, claim, archived) {
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
    // A format migration run's session names its run, whose page its name opens in place of an initiative's.
    launch: { id: launch.id, launchedAt: launch.launchedAt, runningMs: launch.runningMs, runs: launch.runs, endedAt: launch.endedAt, exit: launch.exit, resumeCommand: launch.resumeCommand, waitingGate: launch.waitingGate, ...launch.migrationRun ? { migrationRun: launch.migrationRun } : {}, ...typeof launch.questionGate === "string" ? { questionGate: launch.questionGate } : {}, ...launch.usage ? { usage: launch.usage } : {} },
    action: launchAction(launch)
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
const rank = (state) => NEEDS_YOU.includes(state) ? NEEDS_YOU.indexOf(state) : NEEDS_YOU.length;
function order(left, right) {
  const group = GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group);
  if (group) return group;
  if (left.group === "needs-you" && left.state !== right.state) return rank(left.state) - rank(right.state);
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
  const archived = await archivedLaunches({ launches, env });
  const agents = [];
  for (const launch of launches) {
    const live = claims.find((claim) => holds(launch, claim) && !lapsed(claim)) ?? null;
    const run = launch.migrationRun ? await readRun(projectRoot, launch.migrationRun).catch(() => null) : null;
    const title = launch.migrationRun ? run ? migrationRunTitle(run) : "Format migration" : titles.get(launch.initiative) ?? launch.initiative;
    agents.push(launchEntry(launch, title, live, archived.has(launch.id)));
  }
  for (const claim of claims) {
    if (launches.some((launch) => holds(launch, claim))) continue;
    agents.push(claimEntry(claim, lapsed(claim)));
  }
  agents.sort(order);
  const counted = agents.filter((agent) => agent.group !== "archived" && !(agent.group === "expired" && now - time(agent.expiresAt) >= EXPIRED_COUNTED_MS));
  const count = (accept) => counted.filter(accept).length;
  const counts = {
    all: counted.length,
    needsYou: count((agent) => agent.group === "needs-you"),
    failed: count((agent) => agent.kind === "launch" && agent.state === "failed"),
    waiting: count((agent) => agent.kind === "launch" && agent.state === "waiting"),
    endedWithoutResult: count((agent) => agent.kind === "launch" && agent.state === NO_RESULT),
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
