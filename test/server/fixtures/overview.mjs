import { readPlanFile, writePlanFile } from "./plan-files.mjs";

// A design that plans more than one slice declares an overview, a component view in its scope folder that names every planned slice.
// The scope's slice.md must hold a Contract, because the overview cites its first clause.

const OVERVIEW_LINE = "- `overview.puml` component (§1): How do the planned slices fit together?";

/** The overview's source: one component per slice slug. */
export const overviewSource = (slugs) => `@startuml\n${slugs.map((slug) => `[${slug}]`).join("\n")}\n@enduml\n`;

/** Write overview.puml into a scope folder and declare it in a Views section at the end of the folder's slice.md, unless it already declares it. */
export async function writeOverview(root, folder, slugs) {
  await writePlanFile(root, `${folder}/overview.puml`, overviewSource(slugs));
  const design = await readPlanFile(root, `${folder}/slice.md`) ?? "";
  if (!design.includes(OVERVIEW_LINE)) await writePlanFile(root, `${folder}/slice.md`, `\n## Views\n${OVERVIEW_LINE}\n`, { append: true });
}
