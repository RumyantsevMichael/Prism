---
name: write-feature
description: "Create or update a Gherkin acceptance feature file from approved observable behavior."
---

# Write a Gherkin acceptance feature

Use this skill during design after the slice fit checkpoint passes and the slice architecture is settled, and before implementation.
Feature files are durable acceptance specifications for observable behavior and examples.
They are not prose design summaries or implementation handoffs.
Scenarios may be unbound and failing until implementation binds them.

Read `.prism/workflow.md` first when it exists.
Read the Approved requirements, relevant Proposed or Accepted ADRs, existing feature files, glossary, and selected code and tests.
Treat the requirements as the authority for intended behavior.
Treat ADRs as the authority for architectural constraints.
Treat existing code and tests as evidence of compatibility and current seams, not as authority to invent behavior.
Stop and report a conflict between intent and the selected design or existing behavior.

Write feature files in the configured feature directory, with `docs/Features/` as the default.
Name each file `F-<capability>.feature`.

## Content

Use domain language that a product expert can verify.
Do not use class names, methods, field paths, module paths, or internal identifiers.
Do not add behavior that the requirements and settled design do not support.

Each `Rule` records one invariant.
Link each `Rule` to at least one Approved requirement in a Gherkin comment.
Link a relevant Proposed or Accepted ADR only when its decision constrains the behavior.
Use the smallest example set that covers the intended normal case and meaningful failure or boundary cases.
Do not require two examples when one example fully proves the rule.

Use this shape:

```gherkin
Feature: <observable capability>

  Rule: <one behavioral invariant>
    # Requirement: [requirement title](../requirements/example.md#anchor)

    Example: <observable result>
      Given <world state>
      When <one action or event>
      Then <observable outcome>
```

Use `Background` only when every example needs the same setup.
Use one `When` step for each example.
Split combined outcomes into separate `Then` steps.
Name examples by their result, not by a test number.

## Execution

Do not create step definitions with this skill.
When the project has a BDD harness, implementation binds the feature file through `write-step-definitions` and runs its acceptance command.
When the workflow marks feature files as specification-only, do not add a new BDD dependency.
In both cases, confirm that each example maps to the selected acceptance path.

## Gate

Finish only when each Rule links to intent, each example expresses intended observable behavior, and no implementation detail appears.
Do not wait for completed code or passing acceptance tests.
Keep the file below 150 lines when a capability boundary permits a clean split.
