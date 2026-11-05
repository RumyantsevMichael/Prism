# Initiative settings

Status: Approved
Created: 2026-11-05
Approved: 2026-11-05

## Problem

An initiative's orchestration settings, `autonomy`, `agentFlow`, `commit`, `push`, `continuation`, `review`, and `models`, are written by the orchestrator and can be changed only by asking an agent.
The person who watches a run in the review app cannot turn push off, lower autonomy, or switch to stepwise continuation where they see the work, and does not know when a change would take effect.

## Goals

- Let the person change each initiative setting from the initiative page and from each slice page of the review app.
- Make clear when each change takes effect, and keep a change from undoing work already done or a gate already asked.
- Keep the orchestrator acting on the person's settings from its next step.

## Non-goals

- Settings for a single slice; a slice page changes its initiative's settings.
- Changing one slice's review mark.
- Requests to agents, such as pausing after a slice, revising a design, retrying, or reviewing a slice.

## Design questions

- n/a.

<a id="1"></a>
## 1. Offer every initiative setting

Pattern: Event-driven

Disposition: Active

Requirement: When the review app shows an initiative or one of its slices, Prism shall offer an action for each of the initiative's `autonomy`, `agentFlow`, `commit`, `push`, `continuation`, `review`, and `models` settings, labeled as a setting of the initiative.

Rationale: The person changes a run where they watch it, and a slice page does not suggest that the setting applies to that slice alone.

Related: [review-app-actions.md§1](review-app-actions.md#1)

<a id="2"></a>
## 2. Keep agent flow fixed once work starts

Pattern: State-driven

Disposition: Active

Requirement: While work on the initiative has started, Prism shall show the `agentFlow` action as unavailable with the reason that agent flow is fixed once work starts.

Rationale: Switching between child agents and inline work in the middle of a run would mix contexts that the flow keeps apart.

Related: [review-app-actions.md§2](review-app-actions.md#2), [review-app-actions.md§3](review-app-actions.md#3)

<a id="3"></a>
## 3. Apply autonomy from the next gate

Pattern: Event-driven

Disposition: Active

Requirement: When the person changes `autonomy`, Prism shall decide by the new value which later gates wait for the person, and keep every gate already open waiting for the person.

Rationale: Higher autonomy means fewer gates are asked, but a question already in front of the person stays theirs to answer.

Related: [§9](#9)

<a id="4"></a>
## 4. Apply the review policy to designs not yet accepted

Pattern: Event-driven

Disposition: Active

Requirement: When the person changes `review`, Prism shall set review marks by the new value for slices whose design is not yet accepted, and leave the review mark of every accepted design unchanged.

Rationale: An accepted design's review mark is part of what the person approved at its gate.

Related: [§1](#1)

<a id="5"></a>
## 5. Apply continuation after the current slice

Pattern: Event-driven

Disposition: Active

Requirement: When the person changes `continuation`, Prism shall apply the new value when the slice in progress finishes.

Rationale: Stopping or starting the next slice is a decision between slices, never in the middle of one.

Related: [§1](#1)

<a id="6"></a>
## 6. Apply commit, push, and models to the next child session

Pattern: Event-driven

Disposition: Active

Requirement: When the person changes `commit`, `push`, or `models`, Prism shall apply the new value to each child session started after the change and leave every running child session on its earlier value.

Rationale: A running child cannot change its model, and changing its commit or push rule halfway would leave its work half under each rule.

Related: [§9](#9)

<a id="7"></a>
## 7. Keep the person's value over defaults

Pattern: Event-driven

Disposition: Active

Requirement: When the orchestrator records an initiative's settings after the person changed one of them, Prism shall keep the person's value of each setting the person changed.

Rationale: A person may set push off or stepwise continuation before the run starts, and the orchestrator's defaults must not undo it.

Related: [§1](#1)

<a id="8"></a>
## 8. Act on the person's changes before the next step

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism tool result tells the orchestrator that the person changed a setting of its initiative, Prism shall apply the change before the orchestrator's next step.

Rationale: The person's change is meant to steer the run that is going on now.

Related: [review-app-actions.md§13](review-app-actions.md#13), [review-app-actions.md§14](review-app-actions.md#14)

<a id="9"></a>
## 9. Confirm settings that widen what agents may do

Pattern: Event-driven

Disposition: Active

Requirement: When the person turns `commit` on, turns `push` on, or raises `autonomy` to `full`, Prism shall ask for confirmation in the page before applying the change.

Rationale: These changes let agents write history, publish work, or accept designs without the person.

Related: [review-app-actions.md§5](review-app-actions.md#5)
