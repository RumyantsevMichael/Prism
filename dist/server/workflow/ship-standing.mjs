// Generated from src/server/workflow/ship-standing.mts by scripts/native-build/compile.mjs.
import { readInitiative } from "./initiative.mjs";
import { latestPassingRun } from "./slice-design.mjs";
import { initiativeArtifactStanding } from "./store-artifacts.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
async function initiativePlan(projectRoot, initiative) {
  const config = await readWorkflowConfig(projectRoot);
  const folder = initiativeDirectory(config, initiative);
  const { resolved, loaded } = await readInitiative(projectRoot, initiative);
  const analysis = loaded.analysis;
  const runs = [];
  const repositoriesOf = /* @__PURE__ */ new Map();
  for (const leaf of analysis?.leaves ?? []) {
    const run = await latestPassingRun(resolved.root, resolved.initiative, leaf);
    const checkout = run?.entry.checkout ?? null;
    runs.push({ slice: leaf, run: run?.id ?? null, checkout });
    const component = loaded.record.slices[leaf]?.component;
    const repository = typeof component === "string" && component.includes("/") ? component.slice(0, component.indexOf("/")) : checkout?.repository ?? null;
    repositoriesOf.set(leaf, typeof repository === "string" ? [repository] : []);
  }
  if (folder === null) return { plan: null, runs };
  if (!analysis) return { plan: { folder, slices: [{ folder, repositories: [] }], repositories: [] }, runs };
  const leavesOf = (slug) => analysis.children[slug].length ? analysis.children[slug].flatMap(leavesOf) : [slug];
  const slices = Object.keys(analysis.slices).sort().map((slug) => ({
    folder: slug === analysis.root ? folder : `${folder}/${slug}`,
    repositories: [...new Set(leavesOf(slug).flatMap((leaf) => repositoriesOf.get(leaf) ?? []))].sort()
  }));
  return { plan: { folder, slices, repositories: [...new Set([...repositoriesOf.values()].flat())].sort() }, runs };
}
async function initiativeStanding(projectRoot, initiative) {
  const { plan, runs } = await initiativePlan(projectRoot, initiative);
  const artifacts = plan === null ? { slices: [], repositories: [], adrs: [] } : await initiativeArtifactStanding(projectRoot, plan);
  return { runs: runs.map(({ slice, run }) => ({ slice, run })), ...artifacts };
}
export {
  initiativePlan,
  initiativeStanding
};
