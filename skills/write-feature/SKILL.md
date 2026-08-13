---
name: write-feature
description: "Specify observable behavior as Gherkin scenarios and Rule blocks."
---

# Write Feature File

Approved requirement files are the durable source of product obligations.
Feature files translate observable requirements into executable behavioral invariants and examples.
A domain expert reads and verifies them, and the project's BDD harness executes them as acceptance tests.
A feature file that cannot run is incomplete unless the workflow configuration marks feature files as specification-only.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Before writing, read in order:
1. The glossary (default `docs/Glossary.md`): use domain terms exactly as defined there.
2. The Approved requirements: preserve each linked product obligation exactly.
3. Relevant ADRs: understand which architectural invariants apply to the behavior being specified.
   Rule blocks in feature files MUST NOT contradict ADR invariants.

---

## File location and naming

Feature files live in the feature directory (default `docs/Features/`).
One file per feature.

Naming: `F-<slug>.feature` where the slug describes the capability being specified.
Example: `F-place-order.feature`.

---

## Abstraction level: the most important rule

Feature files describe what the system does in domain language.
They MUST NOT contain:

- Class names (`OrderService`, `NotificationDispatcher`)
- Field paths (`order.fulfillment.next_state`)
- Method names (`applyTransition`, `dispatch`)
- Internal identifiers (`"pending"` as a state-machine string)
- File paths or module names

Violations make the feature file implementation-coupled, which defeats the purpose.
Implementation knowledge belongs in step definitions, not feature files.

**Wrong:**
```gherkin
Then order.fulfillment.next_state is "shipped"
And NotificationDispatcher.dispatch is called with kind "shipment"
```

**Correct:**
```gherkin
Then the order is marked as shipped
And the customer is notified that the order shipped
```

When in doubt, ask: could a non-engineer who understands the product read and verify this step?
If no, rewrite it.

---

## Document structure

```gherkin
Feature: <Short description of the capability>

  <One or two sentences describing the user value.
   Not implementation detail - what the user experiences.>

  Background:              # Optional - shared setup for all scenarios in this file
    Given <precondition>

  Rule: <Invariant stated in plain language>
  # Rules express behavioral invariants - things that MUST always be true.
  # Each Rule MUST have at least two Examples: a happy path and a boundary case.
  # Every Rule links to the Approved requirement that it specifies.
  # A Rule also links to its ADR when an architectural decision constrains it.

    Example: <Behavioral description - what happens, not how>
      Given <world state>
      And <additional precondition>
      When <action or event>
      Then <observable outcome>
      And <additional outcome>

    Example: <Boundary or alternative case>
      Given ...
      When ...
      Then ...
```

---

## Rule blocks

`Rule:` expresses a behavioral invariant: something that must always be true regardless of other conditions.
Rules are the feature file equivalent of RFC 2119 MUST/MUST NOT statements in ADRs, but expressed in domain language and grounded by examples.

Each Rule:
- States one invariant.
  Do not combine two constraints in one Rule.
- Is followed by at least two Examples that together demonstrate the invariant holds in both the typical case and at least one boundary case.
- References each requirement it specifies with a direct Markdown link in a Gherkin comment.
- References an ADR with a direct link when an architectural decision constrains the Rule.

**Good Rule:**
```gherkin
Rule: An order MUST NOT be cancelled once it has shipped.
      Cancellation requests after shipment become return requests.

  # Requirement: [order-cancellation.md§3](../requirements/order-cancellation.md#3)
  # ADR: [Order lifecycle](../ADRs/order-lifecycle/cancellation.md)

  Example: Cancellation request before shipment cancels the order
    Given a paid order that has not shipped
    When the customer requests cancellation
    Then the order is cancelled
    And the payment is refunded

  Example: Cancellation request after shipment becomes a return
    Given an order that has already shipped
    When the customer requests cancellation
    Then the order remains shipped
    And a return request is opened for the customer
```

---

## Example naming

Name Examples by what happens, not by a test case number or slot.

**Wrong:** `Example: Scenario 1` / `Example: Happy path`

**Correct:** `Example: Customer cancels an unpaid order before checkout closes`

---

## Background

Use `Background:` only for setup that is genuinely shared by every Example in the file.
If only some Examples share a precondition, move it into those Examples' Given steps.

---

## Step writing guidelines

**Given**: world state before the action.
Describe the system's state in domain terms.
Avoid implementation bootstrapping language.

**When**: a single action or event.
If you find yourself writing two When steps, consider splitting into two Examples.

**Then**: observable outcome.
What a user or operator would see or experience.
Not what happened inside the system.

Use `And` to continue any of the above without repeating the keyword.

Avoid:
- Conjunctive steps that test two things at once (`Then X and Y are both true`): split into two Then steps
- Negation in Given steps (`Given the customer has not paid`): rephrase positively (`Given payment is pending`)

---

## Connecting to requirements and ADRs

Every Rule must link to at least one Approved requirement:

```gherkin
Rule: The system carries the customer's delivery preference into fulfillment

  # Requirement: [delivery-preference.md§2](../requirements/delivery-preference.md#2)
  # ADR: [Order lifecycle](../ADRs/order-lifecycle/preference-handoff.md)
```

The requirement link traces behavior to product intent.
The optional ADR link traces the design constraint without duplicating its rationale.

---

## Feature file size

If a feature file exceeds roughly 150 lines it becomes hard to read in one sitting.
Split it by capability boundary into separate files named `F-<slug>-<aspect>.feature`.
Do not split artificially.
Only split when the file genuinely covers distinct capabilities that can be understood independently.

---

## Quality checks before finishing

- Every Rule has at least two Examples
- Every Rule links to at least one Approved requirement
- No class names, field paths, method names, or internal IDs appear anywhere
- Every domain term matches its definition in the glossary
- Each Example name describes behavior, not a slot number
- Rules constrained by ADR decisions have a direct comment link
- The file is named `F-<slug>.feature` and lives in the feature directory
- A non-engineer who understands the product could read every step and know whether it passed or failed without seeing the code
