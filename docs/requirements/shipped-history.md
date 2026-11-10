# Shipped history

Status: Approved
Created: 2026-11-08
Approved: 2026-11-08

## Problem

Prism keeps two kinds of artifacts: intent, which is requirements, ADRs, the glossary, and feature files, and state, which is the work of turning that intent into code: initiative records, slice documents and contracts, frozen test records, verification runs, reviews, and coordination state.
Since 7 November 2026 orchestration keeps an initiative's slice folders and records after it ships, because they are its history.
Nothing marks that state as history once the initiative ships.
An agent that opens an old `slice.md` or contract cannot tell whether it describes current intent or a finished initiative, and `get_initiative` does not say that the initiative shipped.
Every Prism tool still changes a shipped initiative's state: slices can be split, restarted, or redesigned, settings and gates can be changed from the review app, the roadmap entry's requirements can be rewritten, and `remove_records` deletes the coordination records.
A later change to that state would rewrite what was built and verified, while the roadmap still says the initiative shipped.

## Goals

- Make every reader, person or agent, see that a shipped initiative's state is history and when it shipped.
- Keep a shipped initiative's state exactly as it was when it shipped.
- Let new work reference shipped history without changing it.

## Non-goals

- Making intent artifacts immutable; requirements and ADRs keep their own supersession rules.
- Preventing edits to files with Git or an editor; Prism reports such edits instead.
- Taking back a ship decision.
- Changing how run records accumulate.

## Design questions

- How a slice document carries its history mark: a line written into the file at ship, a generated companion view, or another form that a reader without Prism sees.
- Which content Prism compares against to detect a slice document changed after ship, and where it keeps that content.
- Whether the content at first read is the right baseline for an initiative that shipped before this capability, or whether Prism should take it from the commit of the ship decision.
- Whether frozen test files in the code repository stay checked against a shipped slice's frozen test record, given that later initiatives may change those files legitimately.

<a id="1"></a>
## 1. Report the shipped state in every read

Pattern: Complex

Disposition: Active

Requirement: While an initiative is shipped, when a person or agent reads its initiative record, coordination state, or the review of one of its slices, Prism shall state in the result that the initiative is shipped history and give the time it shipped.

Rationale: `get_initiative` reports no ship decision today, so an agent that reads an initiative directly cannot tell finished work from current work (Michael, 8 November 2026).

Related: [shipped-history.md§2](#2), [shipped-history.md§3](#3)

<a id="2"></a>
## 2. Mark slice documents as history at ship

Pattern: Event-driven

Disposition: Active

Requirement: When an initiative ships, Prism shall mark each `slice.md` in the initiative's slice folders, in the file itself, as history of that shipped initiative with the ship date.

Rationale: Agents often open a contract or `slice.md` with a file read instead of a Prism tool, and they must see that it records finished work rather than current intent.

Related: [shipped-history.md§1](#1), [shipped-history.md§9](#9)

<a id="3"></a>
## 3. Label shipped history in the review browser

Pattern: Complex

Disposition: Active

Requirement: While an initiative is shipped, when the review browser shows the initiative, one of its slices, or one of its slice documents, Prism shall label the page as shipped history with the ship date.

Rationale: A person who follows a link to an old slice must not mistake it for work in progress.

Related: [single-review-app.md](single-review-app.md)

<a id="4"></a>
## 4. Refuse a change to a shipped initiative's state

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an agent asks Prism to change the initiative record, coordination state, slice claims, staged tests, verification runs, or reviews of a shipped initiative, then Prism shall refuse the request, change no record, and name the initiative, its ship time, and that new work belongs in a new initiative that references it.

Rationale: Once shipped, an initiative's state records what was built and verified, and Michael decided on 8 November 2026 that new work may reference that history but never override it.

Related: [done-work-fixes.md§6](done-work-fixes.md#6), [shipped-history.md§5](#5)

<a id="5"></a>
## 5. Keep a shipped initiative's records

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an agent asks Prism to remove the records of a shipped initiative, then Prism shall refuse the removal and keep every record.

Rationale: Removing the records erases the history that later work references, and the shared store makes keeping them cheap.

Related: [shipped-history.md§4](#4), [run-statistics.md§16](run-statistics.md#16)

<a id="6"></a>
## 6. Make review app actions unavailable on shipped work

Pattern: State-driven

Disposition: Active

Requirement: While an initiative is shipped, Prism shall show every review app action that targets the initiative, one of its slices, or one of its gates as unavailable with the reason that the initiative is shipped history.

Rationale: The review app offers every initiative setting and gate answer today, and a change applied there would rewrite a shipped initiative's state.

Related: [review-app-actions.md§2](review-app-actions.md#2), [review-app-actions.md§3](review-app-actions.md#3), [initiative-settings.md§1](initiative-settings.md#1)

<a id="7"></a>
## 7. Keep a shipped initiative's roadmap entry

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an agent asks Prism to change the title, intent, requirements, or required initiatives of a shipped initiative's roadmap entry, then Prism shall refuse the change and change no record.

Rationale: The roadmap entry states what the initiative delivered against which requirements, and the roadmap already refuses to move or decide a shipped initiative again.

Related: [shipped-history.md§4](#4)

<a id="8"></a>
## 8. Refuse to ship with open work

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an initiative has an unanswered user gate, a live claim, or a pending design proposal when an agent asks Prism to ship it, then Prism shall refuse to ship the initiative and name each such gate, claim, and proposal.

Rationale: After ship no change to the initiative's state is possible, so anything still open at ship would stay open forever.

Related: [shipped-history.md§4](#4), [done-work-fixes.md§4](done-work-fixes.md#4)

<a id="9"></a>
## 9. Report a slice document changed after ship

Pattern: Complex

Disposition: Active

Requirement: While an initiative is shipped, if one of its slice documents differs from its content when the initiative shipped, then Prism shall name that document as changed after ship in each read of the initiative and on the document's review browser page.

Rationale: Prism cannot stop a file edit in a Git repository, so it shows the change to every reader instead of letting history drift silently.

Related: [shipped-history.md§2](#2), [workspace-artifacts.md§10](workspace-artifacts.md#10)

<a id="10"></a>
## 10. Treat shipped state as history in workflow sessions

Pattern: Event-driven

Disposition: Active

Requirement: When a triage, design, implementation, or review session reads a contract, `slice.md`, frozen test record, or review of a shipped initiative, Prism shall have that session take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite the shipped material only as history.

Rationale: Intent and state are different kinds of artifact, and an old contract may fix behavior that later requirements changed.

Related: [shipped-history.md§1](#1), [shipped-history.md§2](#2)

<a id="11"></a>
## 11. Apply shipped history to initiatives that shipped earlier

Pattern: Event-driven

Disposition: Active

Requirement: When Prism first reads an initiative that shipped before Prism kept shipped history, Prism shall treat that initiative as shipped history from then on, without a manual migration.

Rationale: Several initiatives already shipped with their records kept, and Michael's standing rule is that format changes are non-breaking or ship a migration.

Related: [shipped-history.md§9](#9)
