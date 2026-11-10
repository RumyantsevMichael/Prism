# Run workflow sessions over shipped history and fixes

## Outcome

Workflow sessions route defects to the right initiative, treat shipped material as history, and run fixes, and the common terms, ADRs, and user guide say so.

## Changes

- change `skills/triage/SKILL.md`: the trigger description and section 3 add a defect in done work of an unshipped initiative to it with `report_defect` and a defect in shipped work as a new initiative with `corrects`, and the `DEFECT` result names the initiative, slice, and defect id (§31, §32)
- change `skills/design/SKILL.md`: a done scope is designed as one fix slice through `add_fix` in its own folder, and a fix that alters a done slice's frozen test names it in **Changes** (§32, §34)
- change `skills/implement/SKILL.md`: another slice's frozen test changes only when the slice fixes that slice and **Changes** names it (§32, §34)
- change `skills/review/SKILL.md`: shipped material is cited only as history (§32)
- change `skills/orchestrate/SKILL.md`: an unfinished fix without a fix slice is designed as a fix scope, `open_work` and `fixes_unfinished` at ship, and committing the documents under `historyMarks`, keeping the core skills under the line budget that the workflow contract test enforces (§33)
- change `skills/workflow/SKILL.md`: **Artifact ownership** names shipped state as history and the sources of current intent, and **Common terms** add `Shipped history` and `Fix slice` and revise `Defect`, `Initiative lifecycle`, and `Roadmap record` (§32, §35)
- change `skills/setup/SKILL.md`: the plans path is no longer called coordination scratch
- change `docs/user-guide/workflow.md`: sessions treat shipped material as history, and the **Defects** section describes how triage routes a defect (§31, §32)
