# Verify a slice in its component

## Outcome

`verify_slice` runs the slice's component's test command in its folder, asks once per command and folder, and fails a run whose changes leave the component.

## Changes

- change `src/server/workflow/verification.mjs`: `verifySlice` resolves the component, command, and working folder and refuses before approval, `approval` keys a pair by working folder and command and names the folder, `execute` runs in that folder, `verificationRun` checks the boundary before the command and records `folder`, `component`, `boundary`, and `crossing`, and `verificationBrief` keeps them (§16, §17, §18, §19, §21, §22, §23)
- change `src/server/workflow/slice-gate.mjs`: `changedPaths` lists the paths that differ between two content trees, a rename as both paths (§21)
- change `src/server/workflow/initiative.mjs`: `applyOperation` records the start content when `set_status` `in-progress` starts a slice with a component, and drops it when the slice returns to not-started (§20)
- change `src/server/workflow/slice-design.mjs`: `designProblems` accepts the start content on a design (§20)
- change `src/server/mcp.mjs`: `stateErrorData` passes `folder`, and the `verify_slice` description says which command runs where (§17, §18)
- change `dist/server/workflow/verification.mjs`, `dist/server/workflow/slice-gate.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/slice-design.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `skills/implement/SKILL.md`: `Verify` says that a `component_boundary` failure lists the changes to move back inside the component or to report as a contract defect (§22)
- change `skills/workflow/SKILL.md`: `Common terms` say a verification run uses the slice's component's command in its folder and checks the component boundary (§16, §21)
- change `docs/user-guide/workflow.md`: `Verification` explains the command per component, the approval per command and folder, and the boundary failure (§16, §19, §22)
