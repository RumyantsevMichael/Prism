# Declare components and record one per slice

## Outcome

A repository declares components, and each planned leaf slice records one that holds its planned changes and frozen tests when its design is accepted.

## Changes

- add `src/server/workflow/components.mjs`: `readComponents`, `componentOf`, `underSharedPath`, and `ComponentError`, the reader of `## Components` with its own nesting and the refusals in their fixed order (§1, §2, §3, §4, §5, §6, §7, §8, §9, §10)
- change `src/server/workflow/workflow-config.mjs`: `parseWorkflowConfig` keeps the raw lines of `## Components` with their indentation for the reader, while the flattened section map stays as it is (§1)
- change `src/server/workflow/initiative.mjs`: `UPDATE_INITIATIVE_SCHEMA` takes `component` on `accept_design`, `applyOperation` records it and refuses `component_unknown` and `component_boundary` in proposal, acceptance, and direct acceptance, and `canonicalRecord` and `validateRecord` keep and check a slice's `component` (§11, §12, §13, §14, §15)
- change `src/server/mcp.mjs`: `stateErrorData` passes `entry`, `components`, `component`, `dependency`, `cycle`, `slice`, and `paths`, and the `update_initiative` description names `component` (§9, §13, §14)
- add `dist/server/workflow/components.mjs`: the generated runtime of the new reader
- change `dist/server/workflow/workflow-config.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `skills/design/SKILL.md`: `Slices` names each planned slice's component, Changes and frozen tests stay inside it or under shared paths, and each `accept_design` carries `component` (§11, §13, §14)
- change `skills/workflow/SKILL.md`: `Common terms` add Component, Root component, Shared path, and Component boundary, and Slice plan and Accepted design name the component (§1, §5, §11, §14)
- change `skills/workflow-init/SKILL.md`: `Write the configuration` shows an optional `## Components` section for a repository with packages (§1)
- change `docs/user-guide/workflow.md`: `Components` explains the declaration, the root component, shared paths, and the refusals (§1, §4, §5, §9, §14)
