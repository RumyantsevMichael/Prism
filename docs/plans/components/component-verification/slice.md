# Verify a slice in its component

## Outcome

`verify_slice` runs the slice's component's test command in its folder, asks once per command and folder, and fails a run whose changes leave the component.

## Changes

- change `src/server/workflow/verification.mjs`: `verifySlice` resolves the component, command, and working folder with its links followed, and refuses before approval, including `component_folder_outside`, `approval` keys a pair by working folder and command and names the followed folder project-relative in the gate question and the chat approval message, `execute` runs in that folder, `verificationRun` checks the boundary against the recorded declaration before the command, leaving out other slices' frozen tests at their frozen content and other slices' verified changes, fails with `start_content_missing` when the start content cannot be read, keeps a passing run's content under its `passed` ref, and records `folder`, the component's identity, `boundary`, and `crossing`, and `verificationBrief` keeps them (§16, §17, §18, §19, §21, §22, §23, §36)
- change `src/server/workflow/slice-gate.mjs`: `changedPaths` lists the project-relative paths that differ between two content trees, a rename as both paths, also in a project below its Git top folder, and a helper sets and deletes the local refs under `refs/prism/<initiative>/<slice>/` (§20, §21)
- change `src/server/workflow/initiative.mjs`: `applyOperation` records the start content, its time, and the declaration in force when `set_status` `in-progress` starts a slice with a component and no start content, keeps it under the `start` ref, and drops it with the slice's refs when the slice returns to not-started (§20)
- change `src/server/workflow/slice-design.mjs`: `designProblems` accepts the start content, its time, and the recorded declaration on a started slice's design (§20)
- change `src/server/mcp.mjs`: `stateErrorData` passes `folder`, and the `verify_slice` description says which command runs where, which changes the boundary counts, and what `start_content_missing` asks of the user (§17, §18, §21, §23)
- change `dist/server/workflow/verification.mjs`, `dist/server/workflow/slice-gate.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/slice-design.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `skills/implement/SKILL.md`: `Verify` says that a `component_boundary` failure lists this slice's changes to move back inside the component or to report as a contract defect, that a crossing path holding work this slice did not make is reported rather than moved, and that `start_content_missing` goes to the user (§22, §23)
- change `skills/workflow/SKILL.md`: `Common terms` say a verification run uses the slice's component's command in its folder and checks the component boundary against the start content (§16, §20, §21)
- change `docs/user-guide/workflow.md`: `Verification` explains the command per component, the approval per command and folder, the boundary failure, the local `refs/prism/` refs, and how to restart a slice whose start content is gone (§16, §19, §20, §22, §23)
