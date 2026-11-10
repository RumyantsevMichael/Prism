# Shipped work as immutable history

Status: Accepted
Created: 2026-11-08

## Requirements

- [Shipped history](../../requirements/shipped-history.md)
- [Fixes to done work](../../requirements/done-work-fixes.md)

## Problem

Prism keeps a shipped initiative's records and slice folders, because they are its history, but nothing marks them as history and every tool still changes them.
A later change to that state rewrites what was built and verified while the roadmap still says the initiative shipped.
A defect found in a done slice can only be fixed by setting the slice back, which discards its verification evidence, or by a separate initiative, which lets the broken initiative ship.

## Decision

A shipped initiative's state MUST be history: its initiative record, coordination state, claims, staged tests, verification runs, reviews, design views, and change maps MUST NOT change after the ship decision, and Prism MUST refuse every such change and every removal of those records.
The ship decision MUST be refused while the initiative has an unresolved user gate, a live claim, a pending design proposal, or an unfinished fix, because nothing can close them afterwards.
A shipped roadmap entry MUST keep the title, intent, requirements, and required initiatives it shipped with.
Every read of a shipped initiative MUST say that it is history and when it shipped.
Ship MUST write a history mark into each slice document, so that a reader without Prism sees it, and MUST record each document's content without the mark in the ship decision, so that a later edit is reported to every reader rather than prevented.
An initiative that shipped before this decision MUST be treated as history from its first read, which records its slice documents as they are then.
A done slice MUST stay done.
A defect in done work of an unshipped initiative MUST be recorded on the done slice and fixed by a new fix slice of the same initiative, and the initiative MUST NOT ship until every fix is done.
A defect in shipped work MUST be fixed by a new initiative that names the shipped initiative and the slices it corrects, and a read of the shipped initiative MUST list those later initiatives.
Workflow sessions MUST take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files.

## Rationale

The server enforces immutability in the tools that write records, so no agent instruction can be forgotten and no record drifts from the roadmap's ship decision.
A Git work tree cannot be locked, so a mark and a recorded digest make an edit visible instead of pretending to prevent it.
The digest ignores the mark, so a checkout on a branch from before the ship commit, which lacks the mark, is not reported as changed.
Keeping the baseline in the ship decision gives one owner for everything ship records, and a shared record store makes it the same in every checkout.
A fix slice under the done slice keeps the done slice's verified evidence intact, works for a one-slice initiative whose root is done, and makes the initiative's completion wait for the fix without changing the done slice's status.

## Alternatives

Allowing a done slice to go back to `in-progress` keeps one slice per outcome but discards the evidence of its passing verification.
A fix slice as a sibling of the done slice cannot exist when the done slice is the root of a one-slice initiative.
Taking the baseline from the commit of the ship decision needs the code repository's history at the ship time, which differs per branch and misses an uncommitted mark.
A generated companion view beside each slice document would mark history without touching the document, but a reader who opens the document itself would still miss it.

## Consequences

Shipped work can never be corrected in place; every later correction is a new initiative that references it.
Ship and the first read of an earlier ship write into project files, which the person commits apart from the task's changes.
An answered user gate must be resolved before ship, even when its answer needs no further action.
Removing a shipped initiative's records is no longer possible, so the record store grows with every shipped initiative.

## Mechanism

The roadmap's ship decision holds the time, the actor, and the recorded slice documents with their digests.
Each write tool reads that decision before its own checks and refuses with one refusal that names the initiative and its ship time.
Reads add one shipped-history object built from the decision, the current slice documents, and the roadmap entries that correct the initiative.
The slice graph treats a fix slice as a leaf below the slice it fixes, so completion, progress, design candidates, and dependencies include it while the fixed slice stays done.

## Decision Log

2026-11-10: Accepted after the seven slices of the shipped work history initiative were implemented, verified, and reviewed, including a ship that serializes with every writer of the initiative's state.
