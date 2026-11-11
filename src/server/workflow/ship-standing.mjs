import { readInitiative } from "./initiative.mjs";
import { latestPassingRun } from "./slice-design.mjs";
import { initiativeArtifactStanding } from "./store-artifacts.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";

// A ship accepts the ADRs that an initiative's contracts cite on a person's confirmation, so a correctness gate records what the initiative stood at when it was asked,
// and the ship compares that with the initiative as it stands: run ids, repository names, and file versions, which every machine that shares the store reads alike, so no two machines' clocks need agree.

/**
 * The plan of an initiative and its leaves' latest passing verification runs: { plan, runs }.
 * plan is { folder, slices: [{ folder, repositories }], repositories }, each slice's plan folder with the repositories of its leaves, which a leaf's recorded component names,
 * or else the checkout of its latest passing run, or null when the configured paths give the initiative no plan folder.
 * runs lists { slice, run, checkout } for each leaf in slug order, run the id of its latest passing run and checkout where it ran, both null without one.
 */
export async function initiativePlan(projectRoot, initiative) {
  const config = await readWorkflowConfig(projectRoot);
  const folder = initiativeDirectory(config, initiative);
  const { resolved, loaded } = await readInitiative(projectRoot, initiative);
  const analysis = loaded.analysis;
  const runs = [];
  const repositoriesOf = new Map();
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

/**
 * What an initiative stands at, as a correctness gate records it: { runs: [{ slice, run }], slices, repositories, adrs }, the leaves' latest passing runs,
 * the versions of its slice.md files, the repositories that each slice's links resolve in, and the versions of the ADRs that its ship would accept, as initiativeArtifactStanding gives them.
 */
export async function initiativeStanding(projectRoot, initiative) {
  const { plan, runs } = await initiativePlan(projectRoot, initiative);
  const artifacts = plan === null ? { slices: [], repositories: [], adrs: [] } : await initiativeArtifactStanding(projectRoot, plan);
  return { runs: runs.map(({ slice, run }) => ({ slice, run })), ...artifacts };
}
