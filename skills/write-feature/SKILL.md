---
name: write-feature
description: "Create or update a Gherkin acceptance feature file from approved observable behavior."
sdm: "0.3"
---

# Write a Gherkin acceptance feature

A [feature file](../workflow/SKILL.md#common-terms) is a durable acceptance specification for observable behavior and examples.
A feature file must not be a prose design summary or implementation handoff.
Scenarios can remain unbound and failing until implementation binds them.
The [fit checkpoint](../workflow/SKILL.md#common-terms) must pass before this skill creates or updates a feature file.
The slice architecture must be settled before this skill creates or updates a feature file.
Implementation must not have started before this skill creates or updates a feature file.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the Approved requirements.
3. Read the relevant Proposed or Accepted ADRs.
4. Read existing feature files and the glossary.
5. Read the selected code and tests.
6. If intent conflicts with the selected design or existing behavior, stop and report the conflict.

Requirements are the authority for intended behavior.
ADRs are the authority for architectural constraints.
Existing code and tests provide evidence of compatibility and current seams.
Existing code and tests must not provide authority to invent behavior.

## 2. Location

The feature file must use the configured feature directory.
When no feature directory is configured, the default is `docs/Features/`.
The file name must use `F-<capability>.feature`.

## 3. Content

The feature file must use domain language that a product expert can verify.
The feature file must not use class names, methods, field paths, module paths, or internal identifiers.
The feature file must not add behavior unsupported by the requirements and settled design.
Each `Rule` must record one invariant.
Each `Rule` must link to at least one Approved requirement in a Gherkin comment.
The examples must cover the intended normal case and meaningful failure or boundary cases.
The example set must be the smallest set that provides this coverage.
One example is sufficient when it fully proves the rule.

- When a relevant Proposed or Accepted ADR constrains the behavior, link the ADR from the `Rule`.
- Use this shape.

```gherkin
Feature: <observable capability>

  Rule: <one behavioral invariant>
    # Requirement: [requirement title](../requirements/example.md#anchor)

    Example: <observable result>
      Given <world state>
      When <one action or event>
      Then <observable outcome>
```

- Use `Background` only when every example needs the same setup.
- Use one `When` step for each example.
- Split combined outcomes into separate `Then` steps.
- Name examples by their result.

- Don't
  - Name examples by a test number.

## 4. Execution

- When the project has a BDD harness, map each example to the selected acceptance path.
- When the project has a BDD harness, require implementation to bind the feature through `write-step-definitions`.
- When the project has a BDD harness, require implementation to run the acceptance command.
- When the workflow marks feature files as specification-only, map each example to the selected acceptance path.

- Don't
  - Create step definitions with this skill.
  - When the workflow marks feature files as specification-only, add a BDD dependency.

## 5. Gate

The skill can finish only when each `Rule` links to intent.
The skill can finish only when each example states intended observable behavior.
The skill can finish only when no implementation detail appears.
The skill must not wait for completed code or passing acceptance tests.
When a capability boundary permits a clean split, the file must remain below 150 lines.
