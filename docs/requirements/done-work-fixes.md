# Fixes to done work

Status: Approved
Created: 2026-11-08
Approved: 2026-11-08

## Problem

An initiative ships only when every slice is done, and a defect is often found in a slice that is already done while later slices of the same initiative still run.
Prism refuses a new design for a done scope and refuses to split a done slice, and a split parent cannot take another part, so a fix cannot be added inside the initiative.
The only routes today are to set the done slice back to another status, which rewrites its verified history, or to add a separate initiative, which lets the broken initiative ship with its defect.
Triage always adds a new initiative, whether or not the initiative that owns the broken work has shipped.
After an initiative ships, nothing links a fix to the shipped work it corrects.

## Goals

- Let a fix for done work join the initiative that has not shipped yet and ship with it.
- Keep the done slice's verified records unchanged while its fix runs as new work.
- Hold ship until every fix is done.
- After ship, make the fix a new initiative that references the shipped one.

## Non-goals

- Changing how triage decides whether a report is a defect.
- Fixing a defect without an Approved requirement that it breaks.
- Changing a shipped initiative's state to record the fix.

## Design questions

- Where a fix slice sits in the initiative's slice graph when the done slice's parent is already split.
- Whether the reference from a fix to the work it corrects lives in the initiative record, the roadmap entry, or both.
- Whether a fix slice may change frozen test files of the done slice it corrects, and how verification treats them then.

<a id="1"></a>
## 1. Accept a fix design for done work

Pattern: Complex

Disposition: Active

Requirement: While an initiative has not shipped, when design proposes fix work for a defect in a done slice of that initiative, Prism shall accept the proposal under the same checks as any other design proposal.

Rationale: Today Prism refuses a new design for a done scope, so a defect found in done work cannot be fixed inside its initiative (Michael, 8 November 2026).

Related: [done-work-fixes.md§2](#2), [done-work-fixes.md§3](#3)

<a id="2"></a>
## 2. Record the fix as new work that names the done slice

Pattern: Event-driven

Disposition: Active

Requirement: When an orchestrator accepts a design proposal for fix work in done work, Prism shall record the fix as a new slice of the same initiative that names the done slice it corrects.

Rationale: A fix is new work, and readers of either slice need to find the other.

Related: [done-work-fixes.md§1](#1)

<a id="3"></a>
## 3. Keep the done slice's records

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records fix work for a done slice, Prism shall keep that slice's status, accepted design, frozen tests, verification runs, and reviews unchanged.

Rationale: The done slice's records prove what was built and verified at the time, and the fix adds to that record instead of rewriting it.

Related: [done-work-fixes.md§5](#5)

<a id="4"></a>
## 4. Hold ship until every fix is done

Pattern: State-driven

Disposition: Active

Requirement: While fix work in an initiative is not done, Prism shall refuse to ship the initiative, report it as not ready to ship, and name each unfinished fix.

Rationale: A defect found before ship belongs to the initiative that introduced it, so the initiative ships only with its fix.

Related: [shipped-history.md§8](shipped-history.md#8), [components.md§18](components.md#18)

<a id="5"></a>
## 5. Refuse to reopen a done slice

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an agent asks Prism to set a done slice to another status, then Prism shall refuse the change and say that a fix for done work is added as new work.

Rationale: Setting a done slice back discards the evidence of its passing verification, and the fix route keeps that evidence.

Related: [done-work-fixes.md§1](#1), [done-work-fixes.md§3](#3)

<a id="6"></a>
## 6. Route a defect in unshipped work to its initiative

Pattern: Event-driven

Disposition: Active

Requirement: When triage finds that a defect lies in done work of an initiative that has not shipped, Prism shall add the fix to that initiative instead of adding a new initiative to the roadmap.

Rationale: A new initiative for the fix would let the broken initiative ship with its defect, while the fix belongs to the work that introduced it.

Related: [done-work-fixes.md§4](#4)

<a id="7"></a>
## 7. Make a defect in shipped work a new initiative

Pattern: Event-driven

Disposition: Active

Requirement: When triage finds that a defect lies in work of a shipped initiative, Prism shall add the fix as a new initiative that names the shipped initiative and each of its slices whose work the fix corrects.

Rationale: A shipped initiative's state is history that new work may reference but never override.

Related: [shipped-history.md§4](shipped-history.md#4), [done-work-fixes.md§8](#8)

<a id="8"></a>
## 8. Show later fixes of shipped work

Pattern: Event-driven

Disposition: Active

Requirement: When a person or agent reads a shipped initiative, Prism shall list each later initiative that names it as corrected work, with that initiative's lifecycle state.

Rationale: A reader of shipped history needs to know that part of it was corrected later and where, without the shipped records changing.

Related: [done-work-fixes.md§7](#7), [shipped-history.md§1](shipped-history.md#1)
