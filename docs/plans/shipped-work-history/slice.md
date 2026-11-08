# Shipped work as history

## Outcome

A shipped initiative's state reads and behaves as immutable history, and fixes to done work ship inside an unshipped initiative.

## Contract

An initiative is shipped while its roadmap entry holds a `shipped` decision, and its ship time is that decision's `at`; its ship date is the first ten characters of `at`.
Every clause applies to an initiative that shipped before this change as well, from the first read, with no migration step.
A refusal through MCP is a JSON-RPC error whose message states the refusal and whose `data` holds `code` and the fields a clause names.
The plans folder is the configured plans path, and a slice folder is `<plans>/<initiative>` for the root slice and `<plans>/<initiative>/<slug>` for every other slice.
A slice document is the `slice.md` in a slice folder of the initiative record's slices.

### Ship

1. `update_roadmap` `ship` checks, in this order: an existing decision (`validation_failed`, as today), open work (clause 2), unfinished fixes (clause 27), then the existing leaf, component, and dependents checks.
2. Ship refuses with `open_work` while the initiative's coordination state has a pending user gate, answered or not, a slice has a live claim, or the record has a pending design proposal; `data` holds `gates` (`{ id, slice, question, answered }` in state order), `claims` (`{ slice, label, activity, expiresAt }` in slug order), and `proposals` (scope slugs in slug order), each empty when nothing is open of that kind, and the message names each gate id, claimed slice, and proposal scope.
   An answered gate counts as open because no agent can resolve it once the initiative is history.
3. `get_roadmap` reports `readyToShip: false` for an initiative whose ship would refuse under clause 2 or 27, with a diagnostic whose `code` is that refusal's code and whose fields are that refusal's `data` fields.
4. `update_roadmap` `update_initiative` and `set_requires` naming a shipped initiative refuse with `initiative_shipped` (clause 15) and change no record; `place` keeps its existing refusal.

### Reading shipped history

5. `get_initiative`, `get_coordination_state`, and `get_review` of a shipped initiative, or of a slice of one, return `shippedHistory`: `{ initiative, shippedAt, message, documents, changedAfterShip }`, also when the initiative has no initiative record or coordination state; for an initiative that has not shipped the field is absent.
6. `message` is `Initiative <id> shipped on <ship date> and its state is history: take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite this initiative only as history.`, and `get_coordination_state` adds it as a line of its text content.
7. `documents` lists, in path order, the project-relative paths of the slice documents recorded for the initiative (clauses 10 and 12).
8. `changedAfterShip` lists `{ path, change }` in path order, where `change` is `changed` for a recorded document whose content, ignoring the history mark, differs from the recorded content, `removed` for a recorded document that no longer exists, and `added` for a slice document that exists in a slice folder that had none recorded; it is empty when nothing differs.
9. `get_roadmap` returns each shipped entry's decision with `documents` (`[{ path, sha256 }]`, the SHA-256 of each document's content without the history mark), `documentsRecordedAt`, and `documentsFrom` (`ship` or `first-read`) once they are recorded.

### Marking slice documents

10. Ship writes the history mark into every slice document of the initiative, records each one's content under clause 9 with `documentsFrom` `ship`, and lists the marked paths under `historyMarks` in path order; a document it cannot read or write is recorded when it can be read and listed under `historyMarkProblems` as `{ path, reason }`, and ship still succeeds.
11. The history mark is these two lines, inserted after the first line with one blank line before them when that line is a level-one heading, and otherwise at the top with one blank line after them:
    `` > Shipped history: initiative `<id>` shipped on <ship date>, so this document records finished work. ``
    `` > Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files. ``
    A document's content without the mark is the file with those two lines and the blank line inserted with them removed, and a document that already holds a mark is not marked again.
12. When a read under clause 5, `get_roadmap`, or a review browser page reaches a shipped initiative whose decision has no `documents`, and at least one of its slice documents exists in this checkout, Prism records them under clause 9 with `documentsFrom` `first-read` and writes the history mark into each; that read's `shippedHistory` lists the marked paths under `marked`, and an MCP read adds a text line asking to commit them apart from the task's changes.
    An initiative without an initiative record, or without a slice document in this checkout, records nothing and reports empty `documents` and `changedAfterShip`.
    A read never fails because of this recording: when the roadmap changed meanwhile, it records nothing and a later read records them.

### Refusing changes

13. Every request to change a shipped initiative's state refuses with `initiative_shipped` before any check other than argument validation, and changes no record and no project file: `update_initiative` with any operation, `remove_records` included; `update_coordination_state`; `checkpoint_pause`, which writes no recovery note; `update_review`; `verify_slice`, with `contractDefects` or `dependents` too, which runs nothing; `update_design_view`; and `update_change_map`.
14. `remove_records` of a superseded initiative removes its records as it does today.
15. The refusal message is `Initiative <id> shipped at <ship time>, so its state is history and this change was not applied; start new work as a new initiative that references it.`, and `data` holds `initiative` and `shippedAt`.

### The review browser

16. `GET <base>/api/entity?ref=initiative:<id>` and `ref=slice:<id>/<slug>` of a shipped initiative return `shippedHistory` in `data`, with clause 5's fields and `label`, `Shipped history: <id> shipped on <ship date>; this page records finished work.`
17. `GET <base>/api/context?ref=<path>` for a slice document of a shipped initiative returns `shippedHistory` with `label` and `changedAfterShip` `true` when that document is listed under clause 8 and `false` otherwise.
18. The page module `views/shipped-history.js` exports `shippedHistoryHtml(shippedHistory)`, which the initiative, slice, and document pages render above their content: it returns `""` for `null` or `undefined`, and otherwise HTML holding the escaped `label` and, when `changedAfterShip` is `true`, `This document changed after the initiative shipped.`
19. `GET <base>/api/actions?target=` for an initiative, slice, or gate target of a shipped initiative lists every action with `available: false` and `reason` `The initiative shipped on <ship date>, so its state is history.`, and `POST <base>/api/actions/apply` for such a target refuses with `action_unavailable` and that reason and changes nothing; index targets are unaffected.

### Fixes to done work

20. `update_initiative` `report_defect` `{ slug, requirements, summary }` records on a done slice a defect `{ id, requirements, summary, reportedAt }`, where `id` is `d<n>` with `n` one more than the slice's highest defect number, requirements are normalized as in `create`, and the slice's status, design, frozen tests, verification runs, and review stay unchanged; a slice that is not done refuses with `validation_failed`.
21. `claim` on a done slice takes a design claim as on any scope.
22. `propose_design` on a done scope accepts exactly one `add_fix` `{ slug, defects, fix: { slug, title, outcome, requirements } }` naming that scope, `set_dependencies` and `update_slice` on the fix slug, and one `accept_design` of the fix slug, under every check that any proposal passes; it refuses with `validation_failed` any other operation on a done scope, a proposal without the fix's `accept_design`, a defect id the scope does not hold or that another fix slice already names, and a fix slug already used, and `add_fix` outside `propose_design` refuses with `validation_failed`.
23. Accepting a fix proposal adds the fix as a new `not-started` slice whose `parent` is the done slice, with `fixes: { slice, defects }`, its title, outcome, requirements, dependencies, and accepted design, while the done slice's status, design, frozen tests, defects, verification runs, and review stay unchanged.
24. A fix slice's folder is its own `<plans>/<initiative>/<slug>`, whose `slice.md` holds its Contract and Changes.
25. In `get_initiative`'s `derived`, a fix slice is a leaf: it is listed in `leaves`, `counts`, and `designCandidates`, every ancestor of the done slice is complete only when it is done, `children` lists it under the done slice, and `fixes` maps each slice that has fix slices to their slugs in slug order; a fix slice cannot split (`validation_failed`), and a done fix slice can take defects and fixes of its own.
26. A fix slice starts only when the dependencies of the done slice and its ancestors are done, and a slice that depends on a done slice starts only when that slice's fix slices are done.
27. A fix is unfinished while a defect is named by no fix slice or its fix slice is not done; `get_initiative` lists each defect under `derived.unfinishedFixes` as `{ slice, defect, fix, status }`, with `fix` `null` and `status` `not-designed` for a defect without a fix slice, in slice then defect order, and reports `readyToShip: false` while any is listed; ship refuses with `fixes_unfinished`, `data.fixes` holding that list and the message naming each.
28. `set_status` changing a done slice to another status refuses with `slice_done`, message `The slice <slug> is done and stays done; report a defect with report_defect and design a fix as new work.`, and changes nothing.

### Fixes to shipped work

29. `update_roadmap` `add_initiative` and `update_initiative` accept `corrects: { initiative, slices }`, stored on the entry and shown in the roadmap Markdown as `` Corrects `<initiative>`: `<slug>`, `<slug>`. ``; they refuse with `validation_failed` an initiative that is not shipped, whose message says to fix unshipped work inside its initiative with `report_defect`, an unknown initiative, the entry's own id, an empty `slices`, and a slice that the shipped initiative's record does not hold, which includes every slice when that record is missing.
30. `shippedHistory` lists under `laterFixes` each roadmap entry whose `corrects.initiative` names the initiative, as `{ initiative, title, state, slices }` with its derived lifecycle state, in roadmap order, and an empty list when none does.

### Workflow sessions

31. `triage` adds a defect in done work of an unshipped initiative to that initiative with `report_defect` on the done slice and returns the initiative, slice, and defect id; for a defect in a shipped initiative's work, it adds a new initiative with `corrects` naming that initiative and each corrected slice.
32. `triage`, `design`, `implement`, and `review` take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite a shipped initiative's contracts, slice documents, frozen tests, and reviews only as history.
33. `orchestrate` designs a done slice with an unfinished fix without a fix slice as a fix scope, handles `open_work` and `fixes_unfinished` at ship, and commits the slice documents that ship lists under `historyMarks` when commit is on.
34. `design` designs a done scope as one fix slice through `add_fix`, and a fix whose change must alter a done slice's frozen test names that file in **Changes**; `implement` changes another slice's frozen test only when its own slice fixes that slice and **Changes** names the file.
35. The workflow's **Common terms** define `Shipped history`, `Fix slice`, and `Defect` as a defect reported on a done slice or corrected by a later initiative, and `Initiative lifecycle` names shipped state as history.

## Assumptions

- Probed: initiatives that shipped before this change keep their records and slice documents, may have no initiative record at all, and their decisions carry `kind`, `at`, and `actor` only (`node docs/plans/shipped-work-history/probes/shipped-records.mjs /home/user/Prism`, observed `initiative-settings-actions` and `components` with records, 6 and 14 slice documents, no pending gates, claims, or proposals, and `repository-names` with no record), so clause 12 must handle both and clause 9's fields are new.
- Probed: every slice document in this repository starts with a level-one heading (`for f in $(find docs/plans -name slice.md); do head -1 "$f" | grep -q '^# ' || echo "$f"; done`, observed no file listed among 24), so clause 11 places the mark under the title in practice.
- Unprobed: another checkout of the workspace may hold a slice document without the mark, on a branch that predates the ship commit; clause 8 ignores the mark, so such a document is reported only when its other content differs.
- Unprobed: two machines may record clause 12's first read at once; the roadmap revision check lets one write win locally, and a store sync merge that sees two different recordings of one entry keeps the upstream one and saves the other, as for any record, which the sync notice reports.
- Unprobed: a slice document may be unreadable or unwritable at ship; clause 10 lists it under `historyMarkProblems` instead of failing ship or skipping it silently.

## Slices

| Slug | Outcome | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- |
| `ship-gate` | Ship refuses open work, a ready-to-ship report says why not, and a shipped roadmap entry keeps its content. | `shipped-history.md§7`, `§8` | | `test/server/fixtures/shipped-work.mjs`, `test/server/ship-gate.test.mjs` | none |
| `history-reads` | Ship marks slice documents as history, and every read of a shipped initiative, also one shipped earlier, says it is history, when it shipped, and which slice documents changed after ship. | `shipped-history.md§1`, `§2`, `§9`, `§11` | `ship-gate` | `test/server/shipped-history-reads.test.mjs` | required: writes into project files during ship and reads |
| `history-refusals` | Every Prism tool refuses to change a shipped initiative's state and keeps its records. | `shipped-history.md§4`, `§5` | `history-reads` | `test/server/shipped-history-refusals.test.mjs` | required: the one guarantee that keeps verified history from being lost |
| `history-browser` | The review browser labels a shipped initiative, its slices, and its slice documents as history, names a document changed after ship, and shows every action on them as unavailable. | `shipped-history.md§3`, `§6`, `§9` | `history-reads` | `test/server/shipped-history-browser.test.mjs` | none |
| `done-work-fixes` | A defect in done work joins its unshipped initiative as a fix slice that leaves the done slice's records untouched and holds ship until it is done. | `done-work-fixes.md§1`-`§5` | `history-refusals` | `test/server/done-work-fixes.test.mjs` | required: changes the slice graph and the ship gate |
| `shipped-work-fixes` | A fix to shipped work is a new initiative that names what it corrects, and readers of the shipped initiative see it. | `done-work-fixes.md§7`, `§8` | `history-reads` | `test/server/shipped-work-fixes.test.mjs` | none |
| `history-sessions` | Workflow sessions route defects to the right initiative, treat shipped material as history, and run fixes, and the common terms, ADRs, and user guide say so. | `shipped-history.md§10`; `done-work-fixes.md§6`, `§7` | `done-work-fixes`, `shipped-work-fixes`, `history-browser` | `test/server/shipped-history-skills.test.mjs` | none |

The overview is [overview.puml](overview.puml).
