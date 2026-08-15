---
name: write-feature
description: "Record verified observable behavior as Gherkin scenarios and Rule blocks."
---

# Write a feature file

Use this skill after implementation verification passes for the slice.
Feature files preserve behavior for future changes.
They do not specify implementation work.

Read `.prism/workflow.md` first when it exists.
Read the Approved requirements, executable tests, completed code, glossary, and relevant Accepted ADRs.
Treat the verified tests and code as evidence of current behavior.
Treat the requirements as the authority for intended behavior.
Stop and report a conflict between intent and verified behavior.

Write feature files in the configured feature directory, with `docs/Features/` as the default.
Name each file `F-<capability>.feature`.

## Content

Use domain language that a product expert can verify.
Do not use class names, methods, field paths, module paths, or internal identifiers.
Do not add behavior that the tests and requirements do not support.

Each `Rule` records one invariant.
Link each `Rule` to at least one Approved requirement in a Gherkin comment.
Link an Accepted ADR only when its decision constrains the behavior.
Use the smallest example set that covers the verified normal case and meaningful boundary cases.
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

When the project has a BDD harness, bind the feature file through `write-step-definitions` and run its acceptance command.
When the workflow marks feature files as specification-only, do not add a new BDD dependency.
In both cases, confirm that each example matches an executable test.

## Gate

Finish only when each rule links to intent and each example reflects verified behavior.
Keep the file below 150 lines when a capability boundary permits a clean split.
