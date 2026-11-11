# Review loop decisions from the findings

> Shipped history: initiative `review-loop-decisions` shipped on 2026-11-11, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

Low findings can be accepted with tracked follow-ups, and Prism asks the review loop decision itself with a summary, applicable options, and a rule-based recommendation.

## Contract

An unresolved finding is an `implementation-review` finding of the slice's review whose status is `OPEN`, `IN PROGRESS`, `FIXED`, or `REOPENED`.
The review waves are the slice's `implementation-review` waves that started at or after its design was accepted, in start order, and a wave with no start time counts as started when the design was accepted.
A finding is raised in the wave of its first history entry, closed in a wave when it has a `VERIFIED` history entry in that wave, and names its affected path in each wave where it has an `OPEN` or `REOPENED` history entry.
A gate is current for the slice when it is a `decision` gate whose `slice` is the slice, pending or closed, asked at or after the start of the latest review wave.
A decision gate chose an option when its browser answer's `choice` is that option's id, or when `resolve` closed it with that option's id as `choice` (clause 1).
The review loop decision options are `continue-review`, `return-to-design`, and `accept-deferred`.
A refusal through MCP is a JSON-RPC error whose message states the refusal and whose `data` holds `code` and the fields a clause names, and a refused update changes no record unless a clause says it records something.

### Choosing in conversation

1. A `gateOperations` `resolve` operation takes an optional `choice`, the id of one of the resolved decision gate's options, which the closed gate keeps as `choice`; a `choice` on a gate of another kind or that names no option of the gate is refused with `invalid_changes`, and an unanswered gate still needs a `reason`.

### Deferring low findings

2. `update_review` `accept_wave` takes an optional `gate`, a gate id, and `deferrals`, 1 to 100 entries of `{ finding, followUp }` where `finding` is a finding id and `followUp` a string; one of `gate` and `deferrals` without the other, or a finding named twice, is refused with `validation_failed`.
3. `accept_wave` with deferrals is refused with `deferral_refused` when the gate is not a current gate that chose `accept-deferred` (`gate_invalid`, listed for every finding the request names), when a named finding is not unresolved (`finding_not_unresolved`), when a named finding's severity is not `low` (`severity_not_low`), or when an unresolved finding is not named or its `followUp` is empty after trimming or longer than 500 characters (`follow_up_missing`).
4. The refusal's message lists `<finding id>: <reason>` for each problem, and its `data.problems` holds one `{ code, finding, message }` per problem, in the order of clause 3 and then finding order.
5. Accepted deferrals set each named finding's status to `DEFERRED`, add `deferral: { gate, followUp, wave, actor, at }` with the trimmed `followUp`, and append the history entry `{ actor, status: "DEFERRED", wave, at, evidence: followUp }`, where `wave` is the current wave and `actor` the coordinator.
6. With deferrals, the wave is accepted under the usual acceptance checks, except that a `DEFERRED` finding counts as resolved and a lane passes with its current submitted `FINDINGS` result when every finding of that lane that is not `VERIFIED` is `DEFERRED`; the lane keeps the result its reviewer submitted, and `accepted` in the result is `true`.
7. After such an acceptance, `check_review_gate` with `completion` reports `ready: true` while the accepted inputs are unchanged, so a passing slice marked for review completes.
8. A `DEFERRED` finding counts as resolved wherever Prism counts unresolved findings, and `set_finding_status` and `revise_finding` on it are refused with `gate_blocked` and a message that names its decision gate.
9. `get_review` returns `deferred` on every page: one `{ id, severity, title, gate, followUp, wave }` per `DEFERRED` finding of the review, in finding order, or an empty list; a findings page shows a deferred finding with `status: "DEFERRED"` and its `deferral`.
10. `get_initiative` returns `derived.deferredFindings`, mapping each slice that has a `DEFERRED` finding to the entries of clause 9, and leaves out slices without one and slices whose review record cannot be read.
11. The generated `review.md` shows a deferred finding's status as `DEFERRED` and adds the line `- Deferred: gate <gate>, follow-up <followUp>`.

### The review loop decision gate

12. When `start_wave` in `implementation-review` mode is refused because the slice had two review waves and `afterGate` is missing or already used by an earlier wave, the refusal is `gate_blocked` with `data.problems` `[{ code: "review_loop_limit", waves, gate }]`, where `gate` is the review loop gate's id, and it records that gate unless one exists (clause 13); the existing check of findings that name contract clauses still comes first.
13. An existing review loop gate is a pending current gate whose options include `continue-review`, that is unanswered or chose `continue-review`, and that no wave names as `afterGate`; when one exists, Prism names it and records none, so repeated refusals leave one pending gate.
14. The refusal message is `The slice had <n> review waves since its design was accepted, so Prism asked the review loop decision gate <gate> for slice <slice>. When the user chose continue-review, start the wave with afterGate <gate>; for return-to-design, call update_review with return_to_design and the gate; for accept-deferred, call accept_wave with the gate and a follow-up for each unresolved finding.`
15. The recorded gate has kind `decision`, the slice, the question `How should the review of slice <slice> continue after <n> review waves?`, no artifacts, and these options in this order, the last only while every unresolved finding is `low`, including when none is unresolved:
    - `continue-review`, `Continue the review`: `Prism allows one more review wave with fresh reviewers after the implementer fixes the open findings.`
    - `return-to-design`, `Return the slice to design`: `The slice is blocked, and design revises its contract with every unresolved finding as a defect.`
    - `accept-deferred`, `Accept with deferred low findings`: `The review wave is accepted, and each low finding stays on record as deferred with a follow-up in the project's tracker.`
16. The gate's context is this Markdown, with blank lines between blocks: the line ``Slice `<slice>` had <n> implementation review waves since its design was accepted, so a further wave needs a decision.``; the line `**Unresolved findings:** <b> blocker, <h> high, <m> medium, <l> low.`; a list of ``- `<id>` <severity>, <status>: <title>`` per unresolved finding by severity from blocker to low and then by id, or the line `No finding is unresolved.`; the line `**Findings by wave:**`; a table with the header `| Wave | Raised | Closed |` and one row ``| `<wave id>` | <raised> | <closed> |`` per review wave; and the line ``**Files named in more than one wave:** `<path>` (`<wave id>`, `<wave id>`), …`` in path order, or `**Files named in more than one wave:** none.`
17. In the context, a title longer than 120 characters is cut to 119 and `…`, the finding list keeps 20 entries and then `- and <k> more`, the file line keeps 20 paths and then `and <k> more`, the table keeps the latest 30 waves under the line `<k> earlier waves are not shown.`, and a context still longer than 8000 characters is cut to 7999 and `…`.
18. The gate recommends `accept-deferred` while it is offered, with the reason `Every unresolved finding is low severity, so the slice can be accepted with each one deferred to a tracked follow-up.`
19. Otherwise, when the latest review wave raised at least as many findings of severity medium, high, or blocker as the wave before it, the gate recommends `return-to-design` with the reason `The latest wave <latest> raised <a> findings above low severity, and the wave before it, <previous>, raised <b>, so fixing forward is not converging.`
20. Otherwise the gate recommends `continue-review` with the reason `The latest wave <latest> raised <a> findings above low severity, fewer than the <b> that the wave before it, <previous>, raised, so the review is converging.`; a reason longer than 500 characters is cut to 499 and `…`.
21. `start_wave` with an `afterGate` that chose `return-to-design` or `accept-deferred` is refused with `gate_blocked` and the message `The decision gate <gate> chose <option>, so it does not allow another review wave.`; any other answered decision gate passes the existing checks as before.

### Returning to design

22. `update_review` takes the operation `{ op: "return_to_design", gate }` from the coordinator as the only operation of its update, and refuses with `gate_blocked` a gate that is not a current gate that chose `return-to-design`, and with `validation_failed` a slice that is not started with an accepted design.
23. It blocks the slice with contract defects exactly as `verify_slice` with `contractDefects` does: one `{ clause, reason }` per unresolved finding by severity from blocker to low and then by id, where `clause` is the finding's `clause` or `Review finding <id>` and `reason` is `<id> (<severity>): <title>` cut to 2000 characters.
24. With no unresolved finding, the one defect is `{ clause: "Review loop decision", reason: "The user returned the slice to design at <gate>." }`, and with more than 50, the first 49 are followed by `{ clause: "Review findings", reason: "<k> more unresolved findings; read them with get_review." }`.
25. The findings keep their status, the review history records `return_to_design`, and the result adds `returnedToDesign: { sliceStatus: "blocked", defects }` with the number of defects.

### Review browser

26. The review record page's findings board has a `DEFERRED` column after `VERIFIED`, a deferred finding's details show its decision gate and follow-up reference, and the summary's unresolved count leaves deferred findings out and a deferred count appears while one exists.
27. The slice page's review card counts deferred findings apart from unresolved ones and lists each deferred finding with its severity, title, decision gate, and follow-up reference.
28. The Attention page shows the review loop gate's context as rendered Markdown, with the findings by wave as a table.
29. Every element these pages add is a review app kit element styled from the kit's tokens, and the kit guard reports no finding.

### Sessions

30. Orchestration asks no review loop question of its own: it waits for the gate Prism records, acts on the chosen option through clauses 2, 12, 21, and 22, files one follow-up per deferred finding in the tracker that `.prism/workflow.md` names, or records it as a roadmap open question when none is named and passes `roadmap: <question>`, and never offers to narrow the slice.
31. The workflow's common terms define the review loop decision and a deferred finding, and update review wave and contract defect, and the review skill leaves a `DEFERRED` finding unchanged.
32. The user guide describes the review loop decision, its options and recommendation rule, and deferred findings in Prism and the review browser.

## Assumptions

- Probed: the review browser renders a Markdown table and list in a gate context (`node -e` importing `src/server/review/public/views/markdown.js` and calling `renderText("document.md", …)` with clause 16's table, observed a `<table>` inside `div.table-wrap` and a `<ul>` list).
- Probed: Prism can record a gate in coordination state while it holds a slice's review record lock, also when no coordination state exists yet (a scratch script took `withArtifactLock` and `withFileLock` on the review record path and called `updateCoordinationState` with an `ask`, observed `openedGates` with the new id and `previousRevision: null`).
- Probed: the initiative record accepts `report_contract_defects` with a non-clause `clause` text while the review record lock is held (a scratch script with a started slice, observed status `blocked` and the defect `{ clause: "Review finding implementation-review/c/F", … }`).
- Probed: the existing review loop test passes on the current tree (`node --test --test-name-pattern="review stops for the user" test/server/verification.test.mjs`, observed 1 pass), and clauses 14 and 21 keep its expectations: the refusal still says `2 review waves since its design was accepted`, and its gates choose `continue`.
- Unprobed: a lane result's digest covers its findings, so deferring a finding changes it; clause 6 judges the lane by the result as submitted before the deferral, and an implementation that cannot do so must refuse the acceptance rather than accept a stale lane.
- Unprobed: a deferred finding's follow-up reference is not checked against the tracker; Prism records the text as given, and clause 3 refuses only an empty or overlong one.

## Slices

| Slug | Outcome | Component | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- | --- |
| `defer-low-findings` | The coordinator accepts a wave with low findings deferred by the user's gate, each with a follow-up, and Prism reads them back apart. | `prism` | `review-loop-decisions.md§1`, `§2`, `§3` | | `test/server/review-deferred-findings.test.mjs`, `docs/Features/F-review-loop-decisions.feature` | required: lets findings close without a fix on a recorded decision |
| `review-loop-gate` | Prism asks the review loop decision with a summary, applicable options, and a rule-based recommendation, and carries out a return to design. | `prism` | `review-loop-decisions.md§4`, `§5`, `§6`, `§7` | `defer-low-findings` | `test/server/review-loop-gate.test.mjs` | required: writes the coordination state and the initiative record from a review refusal |
| `review-app-deferred` | The review browser shows deferred findings apart and the review loop gate's summary. | `prism` | `review-loop-decisions.md§3`, `§4` | `review-loop-gate` | `test/server/review-deferred-browser.test.mjs` | none |
| `review-loop-sessions` | Orchestration follows Prism's review loop decision, files the follow-ups, and the common terms and user guide say so. | `prism` | `review-loop-decisions.md§1`, `§5`, `§7` | `review-loop-gate` | `test/server/review-loop-skills.test.mjs` | none |

The overview is [overview.puml](overview.puml).
