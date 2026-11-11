# Follow the review loop decision in sessions

> Shipped history: initiative `review-loop-decisions` shipped on 2026-11-11, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

Orchestration follows Prism's review loop decision, files the follow-ups, and the common terms and user guide say so.

## Changes

- change `skills/orchestrate/SKILL.md`: section 5 waits for the gate that `start_wave` names under `review_loop_limit`, acts on `continue-review`, `return-to-design`, and `accept-deferred`, files one follow-up per deferred finding in the configured tracker or as a roadmap open question, and drops narrowing; section 6 resolves a gate answered in conversation with its `choice` (§30)
- change `skills/workflow/SKILL.md`: the common terms Review loop decision and Deferred finding, and the updated Review wave, Contract defect, and User gate record (§31)
- change `skills/review/SKILL.md`: a reviewer leaves a `DEFERRED` finding unchanged (§31)
- change `docs/user-guide/workflow.md`: the review loop decision, its options, its recommendation rule, and deferred findings with their follow-ups (§32)
- change `docs/user-guide/review-browser.md`: the findings board's deferred column and the slice page's deferred findings (§32)
