# EARS authoring reference

This reference explains how Prism authors Easy Approach to Requirements Syntax requirements.
It uses original prose and examples created for Prism.
The publications at the end are further reading and are not redistributed or adapted here.

## Purpose

EARS gives a fixed clause order to natural-language requirements.
The structure separates scope, state, trigger, system, and required response.
EARS improves sentence structure, but it does not prove that a requirement is necessary, complete, or correct.

Write requirements at the system boundary.
State what an affected user, operator, platform, or external system can observe.
Keep internal components, data structures, methods, and technology choices out of the requirement.

## Core clause order

Use the applicable clauses in this order:

```text
Where <feature applies>, while <state holds>, when <event occurs>, the <system> shall <response>.
```

Use `if` and `then` instead of `when` for unwanted behavior.
Omit every clause that does not apply.
Name one system and state one primary obligation in each Prism requirement.

## Pattern selection

### Ubiquitous

Use this pattern when the obligation is always active.

```text
The <system> shall <response>.
```

Example:

```text
The validation engine shall identify every diagnostic with a stable code.
```

Question an apparent ubiquitous requirement before you keep this pattern.
A hidden state or trigger often exists.

### State-driven

Use this pattern while a continuous state remains true.

```text
While <state>, the <system> shall <response>.
```

Example:

```text
While validation is in progress, the validation engine shall report the active artifact.
```

Use a state that has a clear start and end.
Do not use `while` for a single event.

### Event-driven

Use this pattern for a required response to a discrete event.

```text
When <event>, the <system> shall <response>.
```

Example:

```text
When the user submits a specification, the validation engine shall check every referenced artifact.
```

Write the event as something that occurs at the system boundary.
Do not hide the actor behind words such as `requested` or `commanded`.

### Optional feature

Use this pattern only when the obligation applies to a product variant or configured feature.

```text
Where <feature applies>, the <system> shall <response>.
```

Example:

```text
Where strict validation is enabled, the validation engine shall treat every warning as an error.
```

Do not use `where` for a temporary runtime state.
Use `while` for a temporary runtime state.

### Unwanted behavior

Use this pattern for a fault, invalid input, unavailable dependency, attack, or other unwanted condition.

```text
If <unwanted condition>, then the <system> shall <response>.
```

Example:

```text
If a referenced artifact is unavailable, then the validation engine shall identify the unavailable artifact.
```

Describe the required mitigation instead of only prohibiting the failure.
Review unwanted behavior after the wanted behavior so optimistic assumptions become visible.

### Complex

Use this pattern when scope, state, and a trigger are all necessary for one obligation.

```text
Where <feature applies>, while <state>, when <event>, the <system> shall <response>.
```

Example:

```text
Where strict validation is enabled, while validation is in progress, when a warning occurs, the validation engine shall report an error.
```

Use the unwanted form when the trigger is an unwanted condition:

```text
While <state>, if <unwanted condition>, then the <system> shall <response>.
```

Split the requirement or use another notation when the sentence needs many conditions.
A truth table, formula, state model, or diagram can express complex logic more clearly.
Write a short EARS requirement that links to that authoritative object.

## Requirement quality

### Name the system

Use the same system name throughout a requirement file.
Define the system boundary before you write the requirements.
Do not alternate between a product name, a component name, and `the system` for the same thing.

### Use one obligation

Prism permits one primary obligation in each numbered requirement.
Split distinct responses that can pass or fail independently.
Keep a compound response only when its parts form one indivisible observable result.

Treat `or` as a warning that the requirement contains alternatives.
Inspect `and` to determine whether it joins required conditions or separate obligations.

### Make the response verifiable

Use a response that a test, measurement, inspection, or review can prove.
Replace words such as `quickly`, `adequately`, `securely`, and `user-friendly` with measurable criteria.
Name units, limits, populations, and operating conditions when they affect the result.

Example:

```text
When validation completes, the validation engine shall return the result within 200 milliseconds for a 500-kilobyte specification.
```

### Check necessary and sufficient conditions

Remove a condition and ask whether the obligation must still apply.
If it must still apply, that condition is unnecessary.
Then ask whether the listed conditions are enough to require the response.
If they are not enough, the requirement is incomplete.

### Keep rationale outside the statement

The EARS statement contains the obligation only.
Put user evidence, policy sources, assumptions, and product rationale in the surrounding requirement section.
Put implementation rationale in an ADR.

### Separate requirements from decisions

An external authority can impose a constraint requirement.
Examples include a law, platform contract, certification rule, hardware boundary, or required interoperability protocol.

An internal choice between databases, queues, libraries, or module boundaries is an architectural decision.
Record that choice in an ADR that links to the requirement it serves.

### Handle quality requirements carefully

Use EARS for a quality requirement only when the property is measurable or objectively reviewable.
Ubiquitous patterns often fit capacity, accuracy, compatibility, and physical limits.
Event-driven patterns often fit response time and recovery time.

Use another notation when a scale, distribution, formula, or statistical model carries the real meaning.
Link that notation from a short numbered requirement.

## Completeness review

Review each capability in two passes.

1. Review normal users, states, events, and expected responses.
2. Review invalid input, missing dependencies, failures, timeouts, interruption, misuse, and recovery.

Check each actor explicitly.
Words such as `requested`, `selected`, or `submitted` can hide who has authority to act.

Check each operating phase and product variant.
A requirement that applies during setup, migration, maintenance, shutdown, or recovery needs the applicable state.

Check boundaries around every measurable value.
Include the exact limit, just below the limit, and just above the limit during later specification work.

## Review checklist

- The statement fits one EARS pattern.
- The clauses appear in the required order.
- The statement contains one system name.
- The statement uses `shall` for the obligation.
- The trigger is an event and the state has a duration.
- Optional scope describes a real product or configuration variant.
- Unwanted behavior states a mitigation.
- The response is observable or measurable.
- The statement contains one primary obligation.
- Every condition is necessary.
- The complete condition set is sufficient.
- No actor or authority is hidden.
- No internal design choice appears without an external mandate.
- Terms match the project glossary.
- Related and superseded requirements use direct Markdown links.

## Further reading

These links provide historical and technical context.
Their content does not carry an open-content license suitable for inclusion in Prism.
Do not copy their prose, examples, diagrams, or tables into Prism artifacts.

- Alistair Mavin, Philip Wilkinson, Adrian Harwood, and Mark Novak, [EARS: Easy Approach to Requirements Syntax](https://doi.org/10.1109/RE.2009.9), 2009.
- Alistair Mavin, Philip Wilkinson, Sarah Gregory, and Eero Uusitalo, [Listens Learned: Eight Lessons Learned Applying EARS](https://doi.org/10.1109/RE.2016.38), 2016.
- Alistair Mavin and Philip Wilkinson, [Ten Years of EARS](https://doi.org/10.1109/MS.2019.2921164), 2019.
- Alistair Mavin, [Official EARS overview](https://alistairmavin.com/ears/).
