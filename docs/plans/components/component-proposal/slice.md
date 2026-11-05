# Propose components from workspace manifests

## Outcome

`get_roadmap` shows the declared components and proposes a `## Components` block from workspace manifests, which the skills offer to the person.

## Changes

- add `src/server/workflow/workspace-manifests.mjs`: `proposeComponents` reads the root's workspace patterns, matches member folders, and builds the names, test commands, dependencies, shared paths, skipped manifests, and `markdown` of a proposal without writing any file (§41, §42)
- change `src/server/workflow/components.mjs`: `listComponents` gives the repository, the declared components by identity, and the declaration's problem without refusing (§40)
- change `src/server/workflow/roadmap.mjs`: `getRoadmap` returns `components` with the declared list, its problem, and the proposal when nothing is declared, checks the proposal with the declaration reader to report its problem, and `ROADMAP_TOOLS` describes `components` and its proposal in `get_roadmap` (§40, §41, §42)
- add `dist/server/workflow/workspace-manifests.mjs`: the generated runtime of the new reader
- change `dist/server/workflow/components.mjs`, `dist/server/workflow/roadmap.mjs`: the generated runtime of the changed sources
- change `skills/workflow-init/SKILL.md`: `Write the configuration` reads `get_roadmap` `components.proposal`, shows its block and skipped manifests to the person, and adds the block only when the person approves it (§41)
- change `skills/design/SKILL.md`: `Slices` reports a proposal in a repository without components as an open question and never adds it itself (§41)
- change `skills/workflow/SKILL.md`: `Common terms` add Component proposal (§41)
- change `docs/user-guide/workflow.md`: `Components` explains the proposal, the manifests it reads, and that Prism never writes it (§40, §41, §42)
