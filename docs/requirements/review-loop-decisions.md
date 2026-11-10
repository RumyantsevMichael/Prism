# Review loop decisions

Status: Approved
Created: 2026-11-10
Approved: 2026-11-10

## Problem

After two implementation review waves for one accepted design, Prism refuses a further wave until the user answers a decision gate for the slice.
The refusal names three fixed options, continue the review, return the slice to design, or narrow it, so every gate offers the same choices whatever the findings are.
Only continuing has a defined path: returning to design is defined only for findings that name a contract clause, which go to design before the gate is asked, and narrowing a slice under review has no defined step at all.
The gate carries no summary of the findings, so the user decides without their severity, their trend across waves, or where they recur.
The agent that asks the gate chooses the recommendation without a rule, and in practice it always recommends another wave.
The user sometimes accepts a slice whose remaining findings are all low severity, but a wave is accepted only when every lane is clean, so that choice leaves no record of what was accepted and nothing tracks the remaining findings.

## Goals

- Let the user accept a slice whose unresolved implementation review findings are all low severity, keeping each such finding on record with a follow-up in the project's tracker.
- Give the review loop decision a summary of the findings and only options that Prism can carry out.
- Make the recommendation follow a stated rule over the findings rather than the asking agent's choice.
- Let the user return a slice to design from the review loop decision without a finding that names a contract clause.

## Non-goals

- Accepting findings of medium, high, or blocker severity without fixing them.
- A project or initiative setting for the severity that may be accepted.
- Narrowing or splitting a slice from the review loop decision.
- Changing the number of review waves that run without a decision.
- Changing how reviewers raise findings or assign severity.

## Design questions

- What follow-up reference a deferred finding carries when the project names no tracker.
- How a return to design without a named clause reaches design, and what design receives as its defects.
- Whether the review loop decision gate replaces the existing requirement for one answered gate per further wave or is that gate.

<a id="1"></a>
## 1. Accept a wave with deferred low findings

Pattern: Complex

Disposition: Active

Requirement: When the coordinator accepts a review wave whose unresolved implementation review findings are all of low severity, citing the slice's answered decision gate that chose to accept them and giving a follow-up reference for each such finding, Prism shall accept the wave and record each such finding as deferred with that gate and its follow-up reference.

Rationale: The user sometimes accepts low findings, and the acceptance must be recorded with its decision and its follow-up instead of the findings disappearing.

Related: [review-loop-decisions.md§2](#2), [review-loop-decisions.md§3](#3)

<a id="2"></a>
## 2. Refuse deferring other findings

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a request to defer findings names a finding whose severity is not low, cites no answered decision gate of that slice that chose to accept findings, or leaves a deferred finding without a follow-up reference, then Prism shall refuse the request, name the findings and the reason, and change no record.

Rationale: Only low findings may be accepted unfixed, and only by the user's recorded decision.

Related: [review-loop-decisions.md§1](#1)

<a id="3"></a>
## 3. Show deferred findings

Pattern: Event-driven

Disposition: Active

Requirement: When a caller reads a review or a slice through Prism or the review browser, Prism shall show each deferred finding with its severity, its decision gate, and its follow-up reference, apart from fixed and verified findings.

Rationale: A reader of done work must see what was accepted unfixed and where it is tracked.

Related: [review-loop-decisions.md§1](#1), [review-finding-provenance.md§2](review-finding-provenance.md#2)

<a id="4"></a>
## 4. Ask the review loop decision with a summary

Pattern: Event-driven

Disposition: Active

Requirement: When Prism refuses a further implementation review wave because the slice reached the review wave limit, Prism shall record a pending decision gate for the slice whose context summarizes the unresolved findings by severity, the findings each wave raised and closed, and the files that findings named in more than one wave.

Rationale: The user needs the findings' severity, trend, and recurrence to choose between continuing, accepting, and redesigning.

Related: [review-loop-decisions.md§5](#5), [review-loop-decisions.md§6](#6)

<a id="5"></a>
## 5. Offer only options that apply

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records the review loop decision gate, Prism shall offer continuing the review and returning the slice to design, and shall offer accepting with deferred findings only while every unresolved implementation review finding of the slice is of low severity.

Rationale: Each offered option must have a path that Prism carries out, and accepting is allowed only for low findings.

Related: [review-loop-decisions.md§1](#1), [review-loop-decisions.md§7](#7)

<a id="6"></a>
## 6. Recommend by a stated rule

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records the review loop decision gate, Prism shall recommend accepting with deferred findings while that option is offered, otherwise returning the slice to design when the latest wave raised at least as many findings above low severity as the wave before it, and otherwise continuing the review, and shall state the rule's reason in the gate.

Rationale: The recommendation must follow from the findings, so that it does not default to another wave.

Related: [review-loop-decisions.md§4](#4), [review-loop-decisions.md§5](#5)

<a id="7"></a>
## 7. Return to design from the review loop decision

Pattern: Event-driven

Disposition: Active

Requirement: When the coordinator returns a slice to design citing the slice's answered review loop decision gate that chose returning to design, Prism shall block the slice for a design revision with that slice's unresolved findings as its defects, whether or not a finding names a contract clause.

Rationale: Findings that keep recurring point at the contract or the slice even when no reviewer names a clause, and the option must have a path.

Related: [review-loop-decisions.md§5](#5)
