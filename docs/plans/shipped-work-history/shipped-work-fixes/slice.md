# Link fixes to the shipped work they correct

> Shipped history: initiative `shipped-work-history` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

A fix to shipped work is a new initiative that names what it corrects, and readers of the shipped initiative see it.

## Changes

- change `src/server/workflow/roadmap.mjs`: `add_initiative` and `update_initiative` take `corrects`, checked against the shipped initiative's decision and record, `validateRoadmap` accepts it, the roadmap Markdown shows it, and the `update_roadmap` description names it (§29)
- change `src/server/workflow/shipped-history.mjs`: `shippedHistory` lists `laterFixes` from the roadmap entries that correct the initiative, with their derived state (§30)
- change `dist/server/workflow/roadmap.mjs`, `dist/server/workflow/shipped-history.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/workflow.md`: the **Defects** section gains a fix to shipped work as a new initiative that names what it corrects, and how readers of the shipped initiative see it (§29, §30)
